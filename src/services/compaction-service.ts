/**
 * Session Compaction Service
 *
 * Auto-summarizes conversation history when token thresholds are reached.
 * Uses pre-flush durability writes to prevent data loss on crash.
 */
import Database from 'better-sqlite3';

const DEFAULT_TOKEN_THRESHOLD = 40000;

interface CompactionResult {
  compactedSummaries: number;
  compactedTokens: number;
  newSummary: string;
}

export class CompactionService {
  private db: Database.Database;
  private tokenThreshold: number;

  constructor(db: Database.Database, tokenThreshold = DEFAULT_TOKEN_THRESHOLD) {
    this.db = db;
    this.tokenThreshold = tokenThreshold;
  }

  /**
   * Check if a session's conversation summaries exceed the token threshold.
   */
  needsCompaction(sessionId: string): boolean {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(token_count), 0) as total_tokens
      FROM conversation_summaries WHERE session_id = ?
    `).get(sessionId) as { total_tokens: number };
    return row.total_tokens > this.tokenThreshold;
  }

  /**
   * Write a pre-flush marker to indicate compaction is in progress.
   * This enables crash recovery -- if the process dies mid-compaction,
   * the pending flag will still be set on restart.
   */
  preFlush(sessionId: string): void {
    const existing = this.db.prepare(
      'SELECT metadata_json FROM sessions WHERE id = ?'
    ).get(sessionId) as { metadata_json: string | null } | undefined;

    const meta = existing?.metadata_json ? JSON.parse(existing.metadata_json) : {};
    meta.preFlushAt = new Date().toISOString();
    meta.compactionPending = true;

    this.db.prepare(
      'UPDATE sessions SET metadata_json = ? WHERE id = ?'
    ).run(JSON.stringify(meta), sessionId);
  }

  /**
   * Compact all conversation summaries for a session into a single
   * summary stored on the session record. Uses a transaction to ensure
   * atomicity of the summary write and pending-state clear.
   */
  async compact(sessionId: string): Promise<CompactionResult> {
    this.preFlush(sessionId);

    const summaries = this.db.prepare(`
      SELECT id, summary, token_count, ai_model, started_at
      FROM conversation_summaries WHERE session_id = ?
      ORDER BY started_at ASC
    `).all(sessionId) as {
      id: number;
      summary: string;
      token_count: number;
      ai_model: string;
      started_at: string;
    }[];

    const totalTokens = summaries.reduce((sum, s) => sum + (s.token_count || 0), 0);

    const compacted = summaries.map((s, i) =>
      `[${i + 1}/${summaries.length}] (${s.ai_model}, ~${s.token_count} tokens): ${s.summary}`
    ).join('\n\n');

    // Collect the exact ids of the source rows to delete after merge.
    const sourceIds = summaries.map((s) => s.id);

    const txn = this.db.transaction(() => {
      this.db.prepare(
        'UPDATE sessions SET summary = ? WHERE id = ?'
      ).run(compacted, sessionId);

      const existing = this.db.prepare(
        'SELECT metadata_json FROM sessions WHERE id = ?'
      ).get(sessionId) as { metadata_json: string | null } | undefined;

      const meta = existing?.metadata_json ? JSON.parse(existing.metadata_json) : {};
      delete meta.compactionPending;
      meta.lastCompactedAt = new Date().toISOString();
      meta.compactedTokens = totalTokens;
      meta.compactedCount = summaries.length;

      this.db.prepare(
        'UPDATE sessions SET metadata_json = ? WHERE id = ?'
      ).run(JSON.stringify(meta), sessionId);

      // DELETE the exact source rows that were merged so they don't accumulate.
      // Uses parameterised placeholders (one ? per id) to stay in the
      // db.prepare().run() pattern (no db.exec).
      if (sourceIds.length > 0) {
        const placeholders = sourceIds.map(() => '?').join(',');
        this.db.prepare(
          `DELETE FROM conversation_summaries WHERE id IN (${placeholders})`
        ).run(...sourceIds);
      }
    });

    txn();

    return {
      compactedSummaries: summaries.length,
      compactedTokens: totalTokens,
      newSummary: compacted,
    };
  }

  /**
   * Find sessions that were mid-compaction when the process last exited.
   * These sessions have compactionPending=true in their metadata and
   * should be re-compacted on startup.
   */
  recoverPending(): string[] {
    const pending = this.db.prepare(`
      SELECT id FROM sessions
      WHERE json_extract(metadata_json, '$.compactionPending') = 1
    `).all() as { id: string }[];
    return pending.map(p => p.id);
  }
}
