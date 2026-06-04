/**
 * LanceDB Semantic Search Tools
 *
 * Pure TypeScript LanceDB implementation — the committed vector backend.
 * Uses Ollama nomic-embed-text for embeddings and hybrid FTS5+vector search.
 */

import { z } from 'zod';
import { ToolDefinition } from './registry.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { icon } from '../utils/icons.js';
import { DOKORO_PATH } from '../shared/dokoro-utils.js';
import { getSqliteDb, ensureVectorTables } from '../db/index.js';
import { createVectorServices, type SearchResult } from '../services/vector-service.js';
import * as path from 'node:path';

// Lazy-init singleton for vector services
let vectorServicesInstance: ReturnType<typeof createVectorServices> | null = null;

function getVectorServices() {
  if (!vectorServicesInstance) {
    const projectPath = path.dirname(DOKORO_PATH);
    const sqlite = getSqliteDb({ projectPath, devlogFolder: path.basename(DOKORO_PATH) });
    ensureVectorTables(sqlite);
    vectorServicesInstance = createVectorServices(sqlite, path.join(projectPath, path.basename(DOKORO_PATH)));
  }
  return vectorServicesInstance;
}

function getSqlite() {
  const projectPath = path.dirname(DOKORO_PATH);
  return getSqliteDb({ projectPath, devlogFolder: path.basename(DOKORO_PATH) });
}

function formatSearchResult(r: SearchResult, i: number): string {
  const sourceIcon = r.source === 'hybrid' ? icon('sparkle') :
    r.source === 'semantic' ? icon('database') : icon('tag');

  const lines = [
    `${icon('file')} **${i + 1}. ${r.title || r.docId}**`,
    `   ${sourceIcon} Source: ${r.source} | Score: ${r.score.toFixed(4)}`,
    `   ${icon('chart')} FTS: ${r.scores.fts.toFixed(3)} | Vector: ${r.scores.vector.toFixed(3)}`,
  ];

  if (r.filepath) {
    lines.push(`   ${icon('folder')} ${r.filepath}`);
  }

  if (r.tags && r.tags.length > 0) {
    lines.push(`   ${icon('tag')} ${r.tags.join(', ')}`);
  }

  if (r.highlight.excerpt) {
    const excerpt = r.highlight.excerpt.slice(0, 200);
    lines.push(`   ${icon('chevronRight')} ${excerpt}`);
  }

  return lines.join('\n');
}

export const lancedbTools: ToolDefinition[] = [
  {
    name: 'search_universal',
    title: 'Universal Semantic Search',
    description: 'Hybrid semantic + keyword search across all indexed devlog content using LanceDB vectors and FTS5. Returns results ranked by Reciprocal Rank Fusion.',
    inputSchema: {
      query: z.string().describe('Search query (natural language or keywords)'),
      limit: z.number().default(10).describe('Number of results to return'),
    },
    handler: async (args: { query: string; limit?: number }): Promise<CallToolResult> => {
      const { query, limit = 10 } = args;
      try {
        const { searchService } = getVectorServices();
        const results = await searchService.search(query, limit);

        if (results.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `${icon('search')} No results found for "${query}". Try reindexing with search_reindex.`,
            }],
          };
        }

        const formatted = results.map((r, i) => formatSearchResult(r, i)).join('\n\n');

        return {
          content: [{
            type: 'text',
            text: `${icon('search')} **Found ${results.length} results** for "${query}":\n\n${formatted}`,
          }],
        };
      } catch (error: unknown) {
        return {
          content: [{
            type: 'text',
            text: `${icon('error')} **Search error:** ${(error as Error).message}`,
          }],
          isError: true,
        };
      }
    },
  },

  {
    name: 'search_reindex',
    title: 'Reindex Documents',
    description: 'Incrementally reindex all devlog documents for semantic search. Only reindexes changed/new documents unless full=true.',
    inputSchema: {
      full: z.boolean().default(false).describe('Full reindex (delete all vectors first)'),
    },
    handler: async (args: { full?: boolean }): Promise<CallToolResult> => {
      const { full = false } = args;
      try {
        const { indexingService, embeddingService } = getVectorServices();

        // Health check
        const healthy = await embeddingService.healthCheck();
        if (!healthy) {
          return {
            content: [{
              type: 'text',
              text: `${icon('error')} **Ollama not available.** Ensure Ollama is running with nomic-embed-text model.\n\nRun: \`ollama pull nomic-embed-text\``,
            }],
            isError: true,
          };
        }

        const sqlite = getSqlite();

        // If full reindex, clear existing vectors
        if (full) {
          sqlite.prepare('DELETE FROM doc_vectors').run();
          sqlite.prepare('DELETE FROM chunks').run();
          console.error('[Reindex] Full reindex: cleared all vectors');
        }

        // Get all docs with content
        const docs = sqlite.prepare(
          'SELECT id, title, content FROM docs WHERE content IS NOT NULL AND content != \'\''
        ).all() as { id: string; title: string; content: string }[];

        let indexed = 0;
        let skipped = 0;
        let totalChunks = 0;
        let totalTokens = 0;

        for (const doc of docs) {
          if (!full && !indexingService.needsReindex(doc.id, doc.content)) {
            skipped++;
            continue;
          }

          try {
            const result = await indexingService.indexDocument(doc.id, doc.content, doc.title);
            indexed++;
            totalChunks += result.chunks;
            totalTokens += result.tokens;
          } catch (err) {
            console.error(`[Reindex] Failed: ${doc.id}:`, err);
          }
        }

        const stats = indexingService.getStats();

        return {
          content: [{
            type: 'text',
            text: [
              `${icon('success')} **Reindexing complete${full ? ' (full)' : ''}:**`,
              `${icon('file')} Documents: ${docs.length} total, ${indexed} indexed, ${skipped} unchanged`,
              `${icon('database')} This run: ${totalChunks} chunks, ${totalTokens} tokens`,
              `${icon('chart')} Index totals: ${stats.indexed} docs, ${stats.totalChunks} chunks, ${stats.totalTokens} tokens`,
            ].join('\n'),
          }],
        };
      } catch (error: unknown) {
        return {
          content: [{
            type: 'text',
            text: `${icon('error')} **Reindex error:** ${(error as Error).message}`,
          }],
          isError: true,
        };
      }
    },
  },

  {
    name: 'search_index_content',
    title: 'Index Specific Content',
    description: 'Index a specific document by ID for semantic search.',
    inputSchema: {
      doc_id: z.string().describe('Document ID to index'),
      content: z.string().describe('Content to index'),
      title: z.string().default('Untitled').describe('Document title'),
    },
    handler: async (args: { doc_id: string; content: string; title?: string }): Promise<CallToolResult> => {
      const { doc_id, content, title = 'Untitled' } = args;
      try {
        const { indexingService, embeddingService } = getVectorServices();

        const healthy = await embeddingService.healthCheck();
        if (!healthy) {
          return {
            content: [{
              type: 'text',
              text: `${icon('error')} **Ollama not available.** Cannot index without embedding service.`,
            }],
            isError: true,
          };
        }

        const result = await indexingService.indexDocument(doc_id, content, title);

        return {
          content: [{
            type: 'text',
            text: `${icon('success')} **Indexed "${title}"** (${doc_id}): ${result.chunks} chunks, ${result.tokens} tokens`,
          }],
        };
      } catch (error: unknown) {
        return {
          content: [{
            type: 'text',
            text: `${icon('error')} **Indexing error:** ${(error as Error).message}`,
          }],
          isError: true,
        };
      }
    },
  },

  {
    name: 'search_status',
    title: 'Search Index Status',
    description: 'Show the status of the semantic search index: Ollama health, document count, chunk/token stats.',
    inputSchema: {},
    handler: async (): Promise<CallToolResult> => {
      try {
        const { indexingService, embeddingService, vectorStore } = getVectorServices();

        const healthy = await embeddingService.healthCheck();
        const stats = indexingService.getStats();

        let vectorCount = 0;
        try {
          vectorCount = await vectorStore.count();
        } catch {
          // Vector store may not be initialized yet
        }

        const sqlite = getSqlite();
        const totalDocs = (sqlite.prepare('SELECT COUNT(*) as count FROM docs').get() as { count: number }).count;

        const lines = [
          `${icon('database')} **Search Index Status**`,
          '',
          `${healthy ? icon('success') : icon('error')} Ollama: ${healthy ? 'Available (nomic-embed-text)' : 'Unavailable'}`,
          `${icon('file')} Total documents: ${totalDocs}`,
          `${icon('chart')} Indexed documents: ${stats.indexed}`,
          `${icon('database')} Total chunks: ${stats.totalChunks}`,
          `${icon('info')} Total tokens: ${stats.totalTokens}`,
          `${icon('sparkle')} LanceDB vectors: ${vectorCount}`,
          '',
          stats.indexed < totalDocs
            ? `${icon('warning')} ${totalDocs - stats.indexed} documents need indexing. Run search_reindex.`
            : `${icon('success')} All documents are indexed.`,
        ];

        return {
          content: [{
            type: 'text',
            text: lines.join('\n'),
          }],
        };
      } catch (error: unknown) {
        return {
          content: [{
            type: 'text',
            text: `${icon('error')} **Status error:** ${(error as Error).message}`,
          }],
          isError: true,
        };
      }
    },
  },
];
