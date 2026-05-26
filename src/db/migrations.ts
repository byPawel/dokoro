import type Database from 'better-sqlite3';
import { ensureEntityTables } from './entity-tables.js';
import { ensureAgentFeedbackTable } from './agent-feedback.js';

export interface Migration { version: number; description: string; up: (db: Database.Database) => void; }

// Ordered. Never renumber or delete an applied migration; only append.
export const MIGRATIONS: Migration[] = [
  { version: 1, description: 'entity+feedback tables', up: (db) => { ensureEntityTables(db); ensureAgentFeedbackTable(db); } },
  // Rebuild entity_relations from the legacy composite-PK shape to a surrogate
  // `id` PK so the same (source,target,relation_type) tuple can hold multiple
  // bi-temporal slices. A partial unique index keeps exactly one OPEN row per
  // tuple while letting closed history accumulate (BUG-1, BUG-15). Statements run
  // individually (NOT db.exec) so each is a discrete prepared step.
  { version: 2, description: 'entity_relations surrogate PK + partial-unique open index', up: (db) => {
    const ddl = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='entity_relations'`).get() as { sql?: string } | undefined;
    if (!ddl?.sql || ddl.sql.includes('id INTEGER PRIMARY KEY AUTOINCREMENT')) return; // already new shape
    const statements = [
      `ALTER TABLE entity_relations RENAME TO entity_relations_old`,
      `CREATE TABLE entity_relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL, target_id INTEGER NOT NULL,
        relation_type TEXT NOT NULL, weight REAL DEFAULT 1.0, metadata_json TEXT,
        valid_from TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        valid_to TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))`,
      `INSERT INTO entity_relations (source_id,target_id,relation_type,weight,metadata_json,valid_from,valid_to,created_at)
        SELECT source_id,target_id,relation_type,weight,metadata_json,valid_from,valid_to,created_at FROM entity_relations_old`,
      `DROP TABLE entity_relations_old`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_rel_open ON entity_relations(source_id,target_id,relation_type) WHERE valid_to IS NULL`,
      `CREATE INDEX IF NOT EXISTS idx_entity_rel_temporal ON entity_relations(source_id,valid_from,valid_to)`,
      `CREATE INDEX IF NOT EXISTS idx_entity_rel_source ON entity_relations(source_id)`,
      `CREATE INDEX IF NOT EXISTS idx_entity_rel_target ON entity_relations(target_id)`,
      `CREATE INDEX IF NOT EXISTS idx_entity_rel_valid_to ON entity_relations(valid_to)`,
    ];
    for (const s of statements) db.prepare(s).run();
  } },
  // Add composite routing index on agent_feedback for the devlog_feedback_route read path.
  // Without this index, the Wilson-bound + decay query performs a full scan per tool
  // group (BUG-12). Statements run individually — NOT db.exec — consistent with v2.
  { version: 3, description: 'agent_feedback composite routing index (BUG-12)', up: (db) => {
    const statements = [
      `CREATE INDEX IF NOT EXISTS idx_feedback_agent_tool_time ON agent_feedback(agent_id, tool_name, recorded_at)`,
    ];
    for (const s of statements) db.prepare(s).run();
  } },
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
