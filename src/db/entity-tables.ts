import type Database from 'better-sqlite3';

/**
 * Ensure entity graph tables exist (idempotent migration).
 *
 * Includes bi-temporal columns on entity_relations (valid_from / valid_to)
 * so contradictions can be invalidated by setting valid_to rather than deleted.
 * Pattern borrowed from Zep/Graphiti: a relation has valid_from (when the fact
 * became true) and valid_to (when it stopped being true, NULL = still true).
 */
export function ensureEntityTables(sqlite: Database.Database): void {
  // canonical_name is NOT NULL (BUG-25 dedup fix): SQLite treats each NULL as
  // distinct, so a nullable canonical_name allows unlimited duplicate entities
  // to bypass the UNIQUE(type, canonical_name) constraint.  The extractor always
  // supplies canonical_name.  Fresh databases created by this function enforce
  // NOT NULL directly; existing databases with the old nullable column have
  // their NULLs backfilled to lower(name) via migration v6.
  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      canonical_name TEXT NOT NULL,
      description TEXT,
      metadata_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(type, canonical_name)
    )
  `).run();

  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS doc_entities (
      doc_id TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      relation_type TEXT NOT NULL,
      context TEXT,
      confidence REAL DEFAULT 1.0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (doc_id, entity_id, relation_type)
    )
  `).run();

  // Surrogate `id` PK + a partial unique index on open facts (see below) so the
  // same (source,target,relation_type) tuple can hold many bi-temporal slices —
  // historical closed rows plus exactly one currently-open row. ISO-8601 'Z'
  // datetime defaults so lexicographic valid_from/valid_to comparisons line up
  // with the ISO timestamps the write/read paths use (BUG-1, BUG-6).
  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS entity_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      relation_type TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      metadata_json TEXT,
      valid_from TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      valid_to TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    )
  `).run();

  // Idempotent ALTER TABLE for existing databases that pre-date bi-temporal columns.
  // (Fresh DBs already have the columns from the CREATE above; the structural PK
  // redesign for legacy DBs is handled by migration v2 in migrations.ts.)
  const cols = sqlite.prepare(`PRAGMA table_info(entity_relations)`).all() as Array<{ name: string }>;
  const hasValidFrom = cols.some((c) => c.name === 'valid_from');
  const hasValidTo = cols.some((c) => c.name === 'valid_to');
  if (!hasValidFrom) {
    // SQLite forbids ADD COLUMN with NOT NULL and a NON-CONSTANT default
    // (CURRENT_TIMESTAMP / strftime both throw "Cannot add a NOT NULL column with
    // default value non-constant"). Add with a constant default, then backfill.
    sqlite.prepare(`ALTER TABLE entity_relations ADD COLUMN valid_from TEXT NOT NULL DEFAULT ''`).run();
    // Backfill: set valid_from = created_at (when the relation was actually recorded)
    // so point-in-time queries for older dates still see facts that have always
    // existed; fall back to now for rows with no created_at. On legacy DBs migration
    // v2 immediately rebuilds this table with the proper strftime() column default,
    // so the placeholder '' default never reaches a future insert.
    sqlite.prepare(`UPDATE entity_relations SET valid_from = COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`).run();
  }
  if (!hasValidTo) {
    sqlite.prepare(`ALTER TABLE entity_relations ADD COLUMN valid_to TEXT`).run();
  }

  sqlite.prepare('CREATE INDEX IF NOT EXISTS idx_entity_type ON entities(type)').run();
  sqlite.prepare('CREATE INDEX IF NOT EXISTS idx_entity_canonical ON entities(canonical_name)').run();
  sqlite.prepare('CREATE INDEX IF NOT EXISTS idx_doc_entity_doc ON doc_entities(doc_id)').run();
  sqlite.prepare('CREATE INDEX IF NOT EXISTS idx_doc_entity_entity ON doc_entities(entity_id)').run();
  sqlite.prepare('CREATE INDEX IF NOT EXISTS idx_entity_rel_source ON entity_relations(source_id)').run();
  sqlite.prepare('CREATE INDEX IF NOT EXISTS idx_entity_rel_target ON entity_relations(target_id)').run();
  sqlite.prepare('CREATE INDEX IF NOT EXISTS idx_entity_rel_valid_to ON entity_relations(valid_to)').run();

  // Only one OPEN (valid_to IS NULL) row per tuple; closed slices may accumulate.
  sqlite.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_rel_open
    ON entity_relations(source_id, target_id, relation_type) WHERE valid_to IS NULL`).run();
  // Hot path: temporal traversal per node (BUG-15).
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_entity_rel_temporal
    ON entity_relations(source_id, valid_from, valid_to)`).run();
}
