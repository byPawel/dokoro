import type Database from 'better-sqlite3';

/**
 * Idempotently add a summary_embedding BLOB column to conversation_summaries.
 * Stores the Float64-packed embedding of each summary for semantic recall.
 */
export function ensureEpisodicEmbeddingColumn(sqlite: Database.Database): void {
  const cols = sqlite
    .prepare(`PRAGMA table_info(conversation_summaries)`)
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'summary_embedding')) {
    sqlite.prepare(`ALTER TABLE conversation_summaries ADD COLUMN summary_embedding BLOB`).run();
  }
}

/**
 * Idempotently add a `compacted` flag (0/1) to conversation_summaries.
 * Rows written by compaction are marked 1 so they remain recallable but do
 * NOT count toward the compaction trigger (preventing a re-compaction loop).
 */
export function ensureCompactedColumn(sqlite: Database.Database): void {
  const cols = sqlite
    .prepare(`PRAGMA table_info(conversation_summaries)`)
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'compacted')) {
    sqlite.prepare(`ALTER TABLE conversation_summaries ADD COLUMN compacted INTEGER DEFAULT 0`).run();
  }
}
