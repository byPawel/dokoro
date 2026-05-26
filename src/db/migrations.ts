import type Database from 'better-sqlite3';
import { ensureEntityTables } from './entity-tables.js';
import { ensureAgentFeedbackTable } from './agent-feedback.js';

export interface Migration { version: number; description: string; up: (db: Database.Database) => void; }

// Ordered. Never renumber or delete an applied migration; only append.
export const MIGRATIONS: Migration[] = [
  { version: 1, description: 'entity+feedback tables', up: (db) => { ensureEntityTables(db); ensureAgentFeedbackTable(db); } },
];

export function runMigrations(db: Database.Database): void {
  db.prepare(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY, description TEXT, applied_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`).run();
  const row = db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number | null };
  const current = row.v ?? 0;
  // INSERT OR IGNORE: the legacy initializeSchema() init path may also write the
  // version row (e.g. v1 from schema.sql), so ignore conflicts on the PK.
  const record = db.prepare('INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)');
  const apply = db.transaction((m: Migration) => { m.up(db); record.run(m.version, m.description); });
  for (const m of MIGRATIONS) if (m.version > current) apply(m);
}
