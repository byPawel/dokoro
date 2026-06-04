/**
 * Vector Service for Semantic Search
 *
 * Ported from dokoro-ui server/vectorService.ts
 *
 * Handles:
 * - Embeddings via Ollama (nomic-embed-text)
 * - Chunking logic (whole file ≤2k tokens, else 512-token line-aware sliding windows)
 * - LanceDB vector storage
 * - Hybrid search (FTS5 + vectors via Reciprocal Rank Fusion)
 */

import * as lancedb from '@lancedb/lancedb';
import * as crypto from 'node:crypto';
import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { EmbeddingCache } from './embedding-cache.js';

// Constants
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const EMBEDDING_MODEL = 'nomic-embed-text';
const MAX_TOKENS_WHOLE_FILE = 2000;
const CHUNK_SIZE_TOKENS = 512;
const CHUNK_OVERLAP_TOKENS = 128;
const APPROX_CHARS_PER_TOKEN = 4;

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface EmbeddingResult {
  embedding: number[];
  tokenCount: number;
}

export interface Chunk {
  chunkId: string;
  docId: string;
  chunkIndex: number;
  text: string;
  startLine: number;
  endLine: number;
  startChar: number;
  endChar: number;
  headerContext: string | null;
  tokenCount: number;
}

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
// EMBEDDING SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class EmbeddingService {
  private ollamaUrl: string;
  private model: string;
  private cache?: EmbeddingCache;

  constructor(ollamaUrl = OLLAMA_URL, model = EMBEDDING_MODEL, cache?: EmbeddingCache) {
    this.ollamaUrl = ollamaUrl;
    this.model = model;
    this.cache = cache;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const cleanText = text
      .replace(/\0/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
      .trim();

    if (!cleanText) {
      throw new Error('Empty text after cleaning');
    }

    // Check cache before calling Ollama
    if (this.cache) {
      const contentHash = crypto.createHash('sha256').update(cleanText).digest('hex');
      const cached = this.cache.get(contentHash);
      if (cached) {
        return { embedding: cached.embedding, tokenCount: cached.tokenCount };
      }

      // Cache miss - call Ollama and store result
      const result = await this.callOllama(cleanText);
      this.cache.set(contentHash, result.embedding, result.tokenCount);
      return result;
    }

    return this.callOllama(cleanText);
  }

  private async callOllama(cleanText: string): Promise<EmbeddingResult> {
    // Fast-fail if Ollama is unreachable (a dropped connection would otherwise
    // hang the request path indefinitely — see #19). Callers catch and fall back.
    const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS) || 5000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const response = await fetch(`${this.ollamaUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          input: cleanText,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Embedding] Ollama error: ${response.status} - ${errorText.slice(0, 200)}`);
        throw new Error(`Ollama embedding failed: ${response.statusText}`);
      }

      const data = await response.json() as { embeddings: number[][] };
      const embedding = data.embeddings[0];

      if (!embedding || embedding.length === 0) {
        throw new Error('No embedding returned from Ollama');
      }

      const tokenCount = Math.ceil(cleanText.length / APPROX_CHARS_PER_TOKEN);
      return { embedding, tokenCount };
    } finally {
      clearTimeout(timer);
    }
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const results: EmbeddingResult[] = [];
    for (const text of texts) {
      const result = await this.embed(text);
      results.push(result);
    }
    return results;
  }

  async healthCheck(): Promise<boolean> {
    const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS) || 5000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const response = await fetch(`${this.ollamaUrl}/api/tags`, { signal: controller.signal });
      if (!response.ok) return false;

      const data = await response.json() as { models: { name: string }[] };
      return data.models.some(m => m.name.includes(this.model));
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CHUNKING SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class ChunkingService {
  chunk(content: string, docId: string): Chunk[] {
    const lines = content.split('\n');
    const totalChars = content.length;
    const estimatedTokens = Math.ceil(totalChars / APPROX_CHARS_PER_TOKEN);

    if (estimatedTokens <= MAX_TOKENS_WHOLE_FILE) {
      return [{
        chunkId: `${docId}_0`,
        docId,
        chunkIndex: 0,
        text: content,
        startLine: 1,
        endLine: lines.length,
        startChar: 0,
        endChar: totalChars,
        headerContext: this.extractFirstHeader(content),
        tokenCount: estimatedTokens,
      }];
    }

    const chunks: Chunk[] = [];
    const chunkBudget = CHUNK_SIZE_TOKENS * APPROX_CHARS_PER_TOKEN;
    const overlapBudget = CHUNK_OVERLAP_TOKENS * APPROX_CHARS_PER_TOKEN;

    let lineIdx = 0;
    let chunkIndex = 0;

    while (lineIdx < lines.length) {
      let charCount = 0;
      const startLineIdx = lineIdx;

      // Accumulate lines until we reach the character budget
      while (lineIdx < lines.length) {
        const lineLen = lines[lineIdx].length + 1; // +1 for '\n'
        if (charCount > 0 && charCount + lineLen > chunkBudget) {
          break;
        }
        // Force-include the line if it's the first one (even if it exceeds budget)
        charCount += lineLen;
        lineIdx++;
      }

      // Build chunk text: join selected lines with '\n'
      const selectedLines = lines.slice(startLineIdx, lineIdx);
      let chunkText = selectedLines.join('\n');

      // Non-final chunks end with '\n'
      if (lineIdx < lines.length) {
        chunkText += '\n';
      }

      // Compute char positions in original content
      const startChar = lines.slice(0, startLineIdx).reduce(
        (sum, l) => sum + l.length + 1, 0
      );
      const endChar = startChar + chunkText.length;

      chunks.push({
        chunkId: `${docId}_${chunkIndex}`,
        docId,
        chunkIndex,
        text: chunkText,
        startLine: startLineIdx + 1,
        endLine: startLineIdx + selectedLines.length,
        startChar,
        endChar,
        headerContext: this.extractNearestHeader(content, startChar) || this.extractFirstHeader(content),
        tokenCount: Math.ceil(chunkText.length / APPROX_CHARS_PER_TOKEN),
      });

      chunkIndex++;

      // Rewind by overlap: step back lines worth ~overlapBudget characters
      if (lineIdx < lines.length) {
        let rewindChars = 0;
        let rewindLines = 0;
        for (let i = lineIdx - 1; i > startLineIdx; i--) {
          const lineLen = lines[i].length + 1;
          if (rewindChars + lineLen > overlapBudget) break;
          rewindChars += lineLen;
          rewindLines++;
        }
        lineIdx -= rewindLines;
      }
    }

    return chunks;
  }

  private extractFirstHeader(content: string): string | null {
    const match = content.match(/^#+\s+(.+)$/m);
    return match ? match[1].trim() : null;
  }

  private extractNearestHeader(content: string, pos: number): string | null {
    const beforePos = content.slice(0, pos);
    const headers = beforePos.match(/^#+\s+(.+)$/gm);
    if (!headers || headers.length === 0) return null;

    const lastHeader = headers[headers.length - 1];
    const match = lastHeader.match(/^#+\s+(.+)$/);
    return match ? match[1].trim() : null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// VECTOR STORE SERVICE (LanceDB)
// ═══════════════════════════════════════════════════════════════════════════

export class VectorStoreService {
  private dbPath: string;
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private initialized = false;

  constructor(projectPath: string) {
    this.dbPath = path.join(projectPath, '.devlog', 'db', 'vectors.lance');
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

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

  constructor(sqliteDb: Database.Database, projectPath: string) {
    this.sqliteDb = sqliteDb;
    this.embeddingService = new EmbeddingService();
    this.chunkingService = new ChunkingService();
    this.vectorStore = new VectorStoreService(projectPath);
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

export function createVectorServices(sqliteDb: Database.Database, projectPath: string) {
  const indexingService = new IndexingService(sqliteDb, projectPath);
  const searchService = new HybridSearchService(sqliteDb, indexingService);

  return {
    indexingService,
    searchService,
    embeddingService: indexingService.getEmbeddingService(),
    vectorStore: indexingService.getVectorStore(),
  };
}
