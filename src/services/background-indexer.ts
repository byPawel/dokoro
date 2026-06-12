/**
 * Background Indexer
 *
 * Runs after server start, health-checks Ollama, and indexes
 * unindexed or changed documents sequentially.
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createVectorServices } from './vector-service.js';
import { EntityExtractor, RelationDetector, EntityPersistence } from './entity-extractor.js';

const STARTUP_DELAY_MS = 5000;

interface DocRow {
  id: string;
  title: string;
  content: string | null;
}

/**
 * Ensure the entity_content_hashes tracking table exists.
 * Uses sqliteDb.prepare().run() to avoid triggering exec() security hooks.
 */
function ensureEntityHashTable(sqliteDb: Database.Database): void {
  sqliteDb.prepare(`
    CREATE TABLE IF NOT EXISTS entity_content_hashes (
      doc_id TEXT PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,
      last_extracted TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

/**
 * Run entity extraction on docs whose content has changed since last extraction.
 * Uses SHA-256 content hash to skip unchanged docs.
 * Synchronous (no Ollama needed) — safe to run even when Ollama is offline.
 */
function runEntityExtraction(sqliteDb: Database.Database): void {
  const extractor = new EntityExtractor();
  const relationDetector = new RelationDetector();
  const persistence = new EntityPersistence(sqliteDb);

  ensureEntityHashTable(sqliteDb);

  const stmtGetHash = sqliteDb.prepare(
    'SELECT content_hash FROM entity_content_hashes WHERE doc_id = ?'
  );
  const stmtSetHash = sqliteDb.prepare(
    'INSERT OR REPLACE INTO entity_content_hashes (doc_id, content_hash, last_extracted) VALUES (?, ?, CURRENT_TIMESTAMP)'
  );

  const docs = sqliteDb.prepare(
    'SELECT id, title, content FROM docs WHERE content IS NOT NULL AND content != \'\''
  ).all() as DocRow[];

  let extracted = 0;
  let skipped = 0;
  let totalEntities = 0;

  for (const doc of docs) {
    try {
      const contentHash = createHash('sha256').update(doc.content!).digest('hex');
      const stored = stmtGetHash.get(doc.id) as { content_hash: string } | undefined;

      if (stored && stored.content_hash === contentHash) {
        skipped++;
        continue;
      }

      const entities = extractor.extractEntities(doc.content!);
      const relations = relationDetector.detectRelations(doc.content!, entities);
      persistence.persistForDocument(doc.id, entities, relations);
      stmtSetHash.run(doc.id, contentHash);
      totalEntities += entities.length;
      extracted++;
    } catch (err) {
      console.error(`[EntityExtraction] Failed for doc ${doc.id}:`, err);
    }
  }

  console.error(`[EntityExtraction] Done: ${extracted} extracted, ${skipped} unchanged, ${totalEntities} entities`);
}

export function startBackgroundIndexer(sqliteDb: Database.Database, dokoroPath: string): void {
  setTimeout(async () => {
    try {
      // Entity extraction runs first — no Ollama dependency
      runEntityExtraction(sqliteDb);

      const { indexingService, embeddingService } = createVectorServices(sqliteDb, dokoroPath);

      // Health check Ollama
      const healthy = await embeddingService.healthCheck();
      if (!healthy) {
        console.error('[BackgroundIndexer] Ollama not available, skipping indexing');
        return;
      }

      console.error('[BackgroundIndexer] Ollama available, starting indexing...');

      // Find all docs with content
      const docs = sqliteDb.prepare(
        'SELECT id, title, content FROM docs WHERE content IS NOT NULL AND content != \'\''
      ).all() as DocRow[];

      let indexed = 0;
      let skippedVec = 0;

      for (const doc of docs) {
        if (!doc.content) continue;

        if (indexingService.needsReindex(doc.id, doc.content)) {
          try {
            await indexingService.indexDocument(doc.id, doc.content, doc.title);
            indexed++;
          } catch (err) {
            console.error(`[BackgroundIndexer] Failed to index ${doc.id}:`, err);
          }
        } else {
          skippedVec++;
        }
      }

      const stats = indexingService.getStats();
      console.error(
        `[BackgroundIndexer] Done: ${indexed} indexed, ${skippedVec} skipped. ` +
        `Total: ${stats.indexed} docs, ${stats.totalChunks} chunks, ${stats.totalTokens} tokens`
      );
    } catch (err) {
      console.error('[BackgroundIndexer] Error:', err);
    }
  }, STARTUP_DELAY_MS);
}
