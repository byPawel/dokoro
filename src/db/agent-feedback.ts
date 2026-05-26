import type Database from 'better-sqlite3';

/**
 * Ensure agent_feedback table exists (idempotent migration - affective memory layer).
 *
 * Captures per-action outcomes so future routing decisions can use historical
 * success/failure rather than treating each tool call as untrustworthy.
 */
export function ensureAgentFeedbackTable(sqlite: Database.Database): void {
  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS agent_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      outcome TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      latency_ms INTEGER,
      error_message TEXT,
      doc_id TEXT REFERENCES docs(id) ON DELETE SET NULL,
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      metadata_json TEXT,
      recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_feedback_tool ON agent_feedback(tool_name)`).run();
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_feedback_agent ON agent_feedback(agent_id)`).run();
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_feedback_outcome ON agent_feedback(outcome)`).run();
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_feedback_session ON agent_feedback(session_id)`).run();
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_feedback_recorded ON agent_feedback(recorded_at)`).run();
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_feedback_agent_tool_time ON agent_feedback(agent_id, tool_name, recorded_at)`).run();
}
