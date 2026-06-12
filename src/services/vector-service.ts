/**
 * Vector Service for Semantic Search
 *
 * Ported from dokoro-ui server/vectorService.ts
 *
 * Handles:
 * - LanceDB vector storage (lazy-loaded — see optionalDependencies)
 * - Hybrid search (FTS5 + vectors via Reciprocal Rank Fusion)
 *
 * NOTE: EmbeddingService, ChunkingService, and the embedding/chunk types live in
 * ./embedding-service.ts so the core server can use them without ever loading the
 * heavy, optional @lancedb/lancedb native module. They are re-exported below for
 * backward compatibility. @lancedb/lancedb is referenced type-only here and is
 * lazy-loaded at runtime inside VectorStoreService.
 */

import type * as LanceDB from '@lancedb/lancedb';
import * as crypto from 'node:crypto';
import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { EmbeddingService, ChunkingService } from './embedding-service.js';
import type { EmbeddingResult, Chunk } from './embedding-service.js';
import { dokoroDataDir } from '../shared/dokoro-utils.js';

// Re-export the LanceDB-free embedding/chunking surface so existing importers of
// './vector-service.js' keep working.
export { EmbeddingService, ChunkingService };
export type { EmbeddingResult, Chunk };

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface VectorRecord {
  id: string;
  doc_id: string;
  chunk_index: number;
  text_preview: string;
  header_context: string;
  start_line: number;
  end_line: number;
  vector: number[];
}

export interface SearchResult {
  docId: string;
  chunkId: string | null;
  title: string;
  score: number;
  source: 'semantic' | 'keyword' | 'hybrid';
  scores: { fts: number; vector: number };
  highlight: {
    startLine: number;
    endLine: number;
    excerpt: string;
  };
  // Extended doc fields
  id?: string;
  filepath?: string;
  docType?: string;
  status?: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  summaryAi?: string;
  matchedSnippet?: string;
  matchedLines?: number[];
}

// ═══════════════════════════════════════════════════════════════════════════
// VECTOR STORE SERVICE (LanceDB)
// ═══════════════════════════════════════════════════════════════════════════

export class VectorStoreService {
  private dbPath: string;
  private db: LanceDB.Connection | null = null;
  private table: LanceDB.Table | null = null;
  private initialized = false;

  constructor(dokoroPath: string) {
    this.dbPath = path.join(dokoroDataDir(dokoroPath), 'db', 'vectors.lance');
  }

  /**
   * Lazy-load the optional @lancedb/lancedb native module. It is declared in
   * optionalDependencies, so a core install that never touches the vector store
   * can omit it entirely. Surface a clear, actionable error if it's missing.
   */
  private async _loadLancedb(): Promise<typeof LanceDB> {
    try {
      return await import('@lancedb/lancedb');
    } catch (err) {
      const detail = err instanceof Error ? ` (${err.message})` : '';
      throw new Error(
        `LanceDB is not installed. Run: npm install @lancedb/lancedb apache-arrow${detail}`,
      );
    }
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const lancedb = await this._loadLancedb();
    this.db = await lancedb.connect(this.dbPath);

    try {
      this.table = await this.db.openTable('vectors');
    } catch {
      this.table = null;
    }

    this.initialized = true;
    console.error('[VectorStore] Initialized at', this.dbPath);
  }

  async addVectors(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.init();

    const data = records as unknown as Record<string, unknown>[];
    if (!this.table) {
      this.table = await this.db!.createTable('vectors', data);
    } else {
      await this.table.add(data);
    }
  }

  async deleteByDocId(docId: string): Promise<void> {
    await this.init();
    if (!this.table) return;

    try {
      await this.table.delete(`doc_id = '${docId}'`);
    } catch {
      // Table may be empty or doc may not exist
    }
  }

  async search(queryVector: number[], limit = 10): Promise<Record<string, unknown>[]> {
    await this.init();
    if (!this.table) return [];

    const results = await this.table
      .search(queryVector)
      .limit(limit)
      .toArray();

    return results;
  }

  async count(): Promise<number> {
    await this.init();
    if (!this.table) return 0;

    return await this.table.countRows();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// INDEXING SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class IndexingService {
  private embeddingService: EmbeddingService;
  private chunkingService: ChunkingService;
  private vectorStore: VectorStoreService;
  private sqliteDb: Database.Database;

  constructor(sqliteDb: Database.Database, dokoroPath: string) {
    this.sqliteDb = sqliteDb;
    this.embeddingService = new EmbeddingService();
    this.chunkingService = new ChunkingService();
    this.vectorStore = new VectorStoreService(dokoroPath);
  }

  private hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  needsReindex(docId: string, content: string): boolean {
    const currentHash = this.hashContent(content);

    const stored = this.sqliteDb.prepare(
      'SELECT content_hash FROM doc_vectors WHERE doc_id = ?'
    ).get(docId) as { content_hash: string } | undefined;

    if (!stored) return true;
    return stored.content_hash !== currentHash;
  }

  async indexDocument(docId: string, content: string, title: string): Promise<{ chunks: number; tokens: number }> {
    const contentHash = this.hashContent(content);

    if (!this.needsReindex(docId, content)) {
      console.error(`[Indexer] Skipping ${docId} (unchanged)`);
      return { chunks: 0, tokens: 0 };
    }

    console.error(`[Indexer] Indexing ${docId}...`);

    // Delete old vectors and chunks
    await this.vectorStore.deleteByDocId(docId);
    this.sqliteDb.prepare('DELETE FROM chunks WHERE doc_id = ?').run(docId);

    // Chunk the document
    const chunks = this.chunkingService.chunk(content, docId);

    // Generate embeddings and create vector records
    const vectorRecords: VectorRecord[] = [];

    for (const chunk of chunks) {
      try {
        const { embedding, tokenCount } = await this.embeddingService.embed(chunk.text);
        chunk.tokenCount = tokenCount;

        vectorRecords.push({
          id: chunk.chunkId,
          doc_id: docId,
          chunk_index: chunk.chunkIndex,
          text_preview: chunk.text.slice(0, 200),
          header_context: chunk.headerContext || title,
          start_line: chunk.startLine,
          end_line: chunk.endLine,
          vector: embedding,
        });

        // Store chunk metadata in SQLite
        this.sqliteDb.prepare(`
          INSERT OR REPLACE INTO chunks
          (chunk_id, doc_id, chunk_index, start_line, end_line, start_char, end_char, header_context, token_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          chunk.chunkId,
          chunk.docId,
          chunk.chunkIndex,
          chunk.startLine,
          chunk.endLine,
          chunk.startChar,
          chunk.endChar,
          chunk.headerContext,
          chunk.tokenCount
        );
      } catch (err) {
        console.error(`[Indexer] Failed to embed chunk ${chunk.chunkId}:`, err);
      }
    }

    // Add vectors to LanceDB
    if (vectorRecords.length > 0) {
      await this.vectorStore.addVectors(vectorRecords);
    }

    // Update doc_vectors metadata
    const totalTokens = chunks.reduce((sum, c) => sum + c.tokenCount, 0);
    this.sqliteDb.prepare(`
      INSERT OR REPLACE INTO doc_vectors
      (doc_id, content_hash, token_count, chunk_count, last_indexed)
      VALUES (?, ?, ?, ?, ?)
    `).run(docId, contentHash, totalTokens, chunks.length, new Date().toISOString());

    console.error(`[Indexer] Indexed ${docId}: ${chunks.length} chunks, ${totalTokens} tokens`);
    return { chunks: chunks.length, tokens: totalTokens };
  }

  async removeDocument(docId: string): Promise<void> {
    await this.vectorStore.deleteByDocId(docId);
    this.sqliteDb.prepare('DELETE FROM chunks WHERE doc_id = ?').run(docId);
    this.sqliteDb.prepare('DELETE FROM doc_vectors WHERE doc_id = ?').run(docId);
    console.error(`[Indexer] Removed ${docId} from index`);
  }

  getStats(): { indexed: number; totalChunks: number; totalTokens: number } {
    const stats = this.sqliteDb.prepare(`
      SELECT
        COUNT(*) as indexed,
        COALESCE(SUM(chunk_count), 0) as totalChunks,
        COALESCE(SUM(token_count), 0) as totalTokens
      FROM doc_vectors
    `).get() as { indexed: number; totalChunks: number; totalTokens: number };

    return {
      indexed: stats.indexed,
      totalChunks: stats.totalChunks,
      totalTokens: stats.totalTokens,
    };
  }

  getEmbeddingService(): EmbeddingService {
    return this.embeddingService;
  }

  getVectorStore(): VectorStoreService {
    return this.vectorStore;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HYBRID SEARCH SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class HybridSearchService {
  private sqliteDb: Database.Database;
  private indexingService: IndexingService;
  private k = 60; // RRF constant

  constructor(sqliteDb: Database.Database, indexingService: IndexingService) {
    this.sqliteDb = sqliteDb;
    this.indexingService = indexingService;
  }

  async search(query: string, limit = 10): Promise<SearchResult[]> {
    const ftsResults = this.ftsSearch(query, limit * 2);
    const vectorResults = await this.vectorSearch(query, limit * 2);

    const combined = this.reciprocalRankFusion(ftsResults, vectorResults);
    const topResults = combined.slice(0, limit);

    return this.enrichResults(topResults);
  }

  private ftsSearch(query: string, limit: number): { docId: string; score: number }[] {
    try {
      // Check if docs_fts table exists
      const ftsExists = this.sqliteDb.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='docs_fts'`
      ).get();

      if (!ftsExists) return [];

      const results = this.sqliteDb.prepare(`
        SELECT d.id as docId, bm25(docs_fts) as score
        FROM docs_fts
        JOIN docs d ON docs_fts.rowid = d.rowid
        WHERE docs_fts MATCH ?
        ORDER BY score
        LIMIT ?
      `).all(query, limit) as { docId: string; score: number }[];

      const maxScore = Math.max(...results.map(r => Math.abs(r.score)), 1);
      return results.map(r => ({
        docId: r.docId,
        score: 1 - (Math.abs(r.score) / maxScore),
      }));
    } catch {
      return [];
    }
  }

  private async vectorSearch(query: string, limit: number): Promise<{ docId: string; chunkId: string; score: number; startLine: number; endLine: number }[]> {
    const embeddingService = this.indexingService.getEmbeddingService();
    const vectorStore = this.indexingService.getVectorStore();

    try {
      const { embedding } = await embeddingService.embed(query);
      const results = await vectorStore.search(embedding, limit);

      return results.map((r: Record<string, unknown>) => ({
        docId: r.doc_id as string,
        chunkId: r.id as string,
        score: 1 - ((r._distance as number) || 0),
        startLine: r.start_line as number,
        endLine: r.end_line as number,
      }));
    } catch (err) {
      console.error('[HybridSearch] Vector search failed:', err);
      return [];
    }
  }

  private reciprocalRankFusion(
    ftsResults: { docId: string; score: number }[],
    vectorResults: { docId: string; chunkId: string; score: number; startLine: number; endLine: number }[]
  ): { docId: string; chunkId: string | null; ftsScore: number; vectorScore: number; rrfScore: number; startLine: number; endLine: number; source: 'semantic' | 'keyword' | 'hybrid' }[] {
    const scores: Map<string, {
      docId: string;
      chunkId: string | null;
      ftsRank: number | null;
      vectorRank: number | null;
      ftsScore: number;
      vectorScore: number;
      startLine: number;
      endLine: number;
    }> = new Map();

    ftsResults.forEach((r, rank) => {
      scores.set(r.docId, {
        docId: r.docId,
        chunkId: null,
        ftsRank: rank,
        vectorRank: null,
        ftsScore: r.score,
        vectorScore: 0,
        startLine: 1,
        endLine: 1,
      });
    });

    vectorResults.forEach((r, rank) => {
      const existing = scores.get(r.docId);
      if (existing) {
        existing.vectorRank = rank;
        existing.vectorScore = r.score;
        existing.chunkId = r.chunkId;
        existing.startLine = r.startLine;
        existing.endLine = r.endLine;
      } else {
        scores.set(r.docId, {
          docId: r.docId,
          chunkId: r.chunkId,
          ftsRank: null,
          vectorRank: rank,
          ftsScore: 0,
          vectorScore: r.score,
          startLine: r.startLine,
          endLine: r.endLine,
        });
      }
    });

    const results = Array.from(scores.values()).map(s => {
      const ftsRrf = s.ftsRank !== null ? 1 / (this.k + s.ftsRank) : 0;
      const vectorRrf = s.vectorRank !== null ? 1 / (this.k + s.vectorRank) : 0;

      let source: 'semantic' | 'keyword' | 'hybrid';
      if (s.ftsRank !== null && s.vectorRank !== null) {
        source = 'hybrid';
      } else if (s.vectorRank !== null) {
        source = 'semantic';
      } else {
        source = 'keyword';
      }

      return {
        docId: s.docId,
        chunkId: s.chunkId,
        ftsScore: s.ftsScore,
        vectorScore: s.vectorScore,
        rrfScore: ftsRrf + vectorRrf,
        startLine: s.startLine,
        endLine: s.endLine,
        source,
      };
    });

    return results.sort((a, b) => b.rrfScore - a.rrfScore);
  }

  private enrichResults(results: { docId: string; chunkId: string | null; ftsScore: number; vectorScore: number; rrfScore: number; startLine: number; endLine: number; source: 'semantic' | 'keyword' | 'hybrid' }[]): SearchResult[] {
    return results.map(r => {
      const doc = this.sqliteDb.prepare(
        `SELECT * FROM docs WHERE id = ?`
      ).get(r.docId) as Record<string, unknown> | undefined;

      if (!doc) return null;

      const tags = this.sqliteDb.prepare(`
        SELECT t.name FROM tags t
        JOIN doc_tags dt ON t.id = dt.tag_id
        WHERE dt.doc_id = ?
      `).all(r.docId) as { name: string }[];

      const content = (doc.content as string) || '';
      const lines = content.split('\n');
      const excerptLines = lines.slice(r.startLine - 1, r.endLine).join('\n');
      const excerpt = excerptLines.length > 200
        ? excerptLines.slice(0, 200) + '...'
        : excerptLines;

      const cleanExcerpt = excerpt.replace(/^---[\s\S]*?---\n?/, '').trim();

      return {
        id: doc.id as string,
        docId: doc.id as string,
        chunkId: r.chunkId,
        filepath: doc.filepath as string,
        title: (doc.title as string) || '',
        docType: doc.doc_type as string,
        status: doc.status as string,
        tags: tags.map(t => t.name),
        createdAt: doc.created_at as string,
        updatedAt: doc.updated_at as string,
        summaryAi: doc.summary_ai as string | undefined,
        score: r.rrfScore,
        source: r.source,
        scores: {
          fts: r.ftsScore,
          vector: r.vectorScore,
        },
        highlight: {
          startLine: r.startLine,
          endLine: r.endLine,
          excerpt: cleanExcerpt,
        },
        matchedSnippet: cleanExcerpt,
        matchedLines: [r.startLine, r.endLine],
      };
    }).filter(Boolean) as SearchResult[];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════════════════════════

/** `dokoroPath` is the workspace folder; vectors live at `<dokoroPath>/.dokoro/db/vectors.lance`. */
export function createVectorServices(sqliteDb: Database.Database, dokoroPath: string) {
  const indexingService = new IndexingService(sqliteDb, dokoroPath);
  const searchService = new HybridSearchService(sqliteDb, indexingService);

  return {
    indexingService,
    searchService,
    embeddingService: indexingService.getEmbeddingService(),
    vectorStore: indexingService.getVectorStore(),
  };
}
