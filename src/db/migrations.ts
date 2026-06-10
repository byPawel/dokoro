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
    db.prepare(`ALTER TABLE entity_relations RENAME TO entity_relations_old`).run();
    // DBs created before the bi-temporal columns were added lack valid_from/valid_to
    // on the legacy table. Copying them directly threw "no such column: valid_from"
    // and aborted DB init (BUG-31). Default the missing temporal columns from the
    // surrounding data: valid_from <- created_at (when recorded), valid_to <- open.
    const oldCols = new Set(
      (db.prepare(`PRAGMA table_info(entity_relations_old)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    const createdAtExpr = oldCols.has('created_at') ? 'created_at' : `strftime('%Y-%m-%dT%H:%M:%SZ','now')`;
    const validFromExpr = oldCols.has('valid_from') ? 'valid_from' : `COALESCE(${createdAtExpr}, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`;
    const validToExpr = oldCols.has('valid_to') ? 'valid_to' : 'NULL';
    const statements = [
      `CREATE TABLE entity_relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL, target_id INTEGER NOT NULL,
        relation_type TEXT NOT NULL, weight REAL DEFAULT 1.0, metadata_json TEXT,
        valid_from TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        valid_to TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))`,
      `INSERT INTO entity_relations (source_id,target_id,relation_type,weight,metadata_json,valid_from,valid_to,created_at)
        SELECT source_id,target_id,relation_type,weight,metadata_json,${validFromExpr},${validToExpr},${createdAtExpr} FROM entity_relations_old`,
      `DROP TABLE entity_relations_old`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_rel_open ON entity_relations(source_id,target_id,relation_type) WHERE valid_to IS NULL`,
      `CREATE INDEX IF NOT EXISTS idx_entity_rel_temporal ON entity_relations(source_id,valid_from,valid_to)`,
      `CREATE INDEX IF NOT EXISTS idx_entity_rel_source ON entity_relations(source_id)`,
      `CREATE INDEX IF NOT EXISTS idx_entity_rel_target ON entity_relations(target_id)`,
      `CREATE INDEX IF NOT EXISTS idx_entity_rel_valid_to ON entity_relations(valid_to)`,
    ];
    for (const s of statements) db.prepare(s).run();
  } },
  // Add composite routing index on agent_feedback for the dokoro_feedback_route read path.
  // Without this index, the Wilson-bound + decay query performs a full scan per tool
  // group (BUG-12). Statements run individually — NOT db.exec — consistent with v2.
  { version: 3, description: 'agent_feedback composite routing index (BUG-12)', up: (db) => {
    const statements = [
      `CREATE INDEX IF NOT EXISTS idx_feedback_agent_tool_time ON agent_feedback(agent_id, tool_name, recorded_at)`,
    ];
    for (const s of statements) db.prepare(s).run();
  } },
  // Add ON DELETE CASCADE FK to entity_content_hashes so stale hashes are pruned
  // when their parent doc is deleted (BUG-23).  For existing DBs the table is
  // rebuilt (rename → create-with-FK → copy → drop).  Guard: skip if the FK is
  // already present (i.e. table was created by the updated ensureEntityHashTable).
  { version: 4, description: 'entity_content_hashes ON DELETE CASCADE FK (BUG-23)', up: (db) => {
    // Check whether entity_content_hashes even exists yet.  If not, the updated
    // ensureEntityHashTable() will create it correctly on first run, so nothing
    // to do here.
    const tableRow = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='entity_content_hashes'`
    ).get() as { name: string } | undefined;
    if (!tableRow) return;

    // Check if a FK already references docs(id).
    const fkRows = db.prepare(`PRAGMA foreign_key_list(entity_content_hashes)`).all() as Array<{ table: string }>;
    const hasFk = fkRows.some((r) => r.table === 'docs');
    if (hasFk) return; // already correct shape

    const statements = [
      `ALTER TABLE entity_content_hashes RENAME TO entity_content_hashes_old`,
      `CREATE TABLE entity_content_hashes (
        doc_id TEXT PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
        content_hash TEXT NOT NULL,
        last_extracted TEXT DEFAULT CURRENT_TIMESTAMP
      )`,
      `INSERT INTO entity_content_hashes (doc_id, content_hash, last_extracted)
        SELECT doc_id, content_hash, last_extracted FROM entity_content_hashes_old`,
      `DROP TABLE entity_content_hashes_old`,
    ];
    for (const s of statements) db.prepare(s).run();
  } },
  // Drop the unused context_relevance table that was defined in schema.sql but
  // never read or written by any production code (BUG-24).
  { version: 5, description: 'drop unused context_relevance table (BUG-24)', up: (db) => {
    db.prepare(`DROP TABLE IF EXISTS context_relevance`).run();
  } },
  // Backfill entities.canonical_name NULLs → lower(name) so that the
  // UNIQUE(type, canonical_name) dedup constraint is effective on all rows
  // (BUG-25).  SQLite treats each NULL as a distinct value, which allows
  // unlimited duplicates to bypass the constraint.
  //
  // A full table-rebuild to enforce NOT NULL on the column itself is heavy
  // and risky on existing production DBs.  The minimal safe approach is:
  //   1. Backfill any NULL canonical_name to lower(name) — idempotent.
  //   2. The updated CREATE TABLE (ensureEntityTables) uses NOT NULL DEFAULT
  //      (lower(name)) for all new databases going forward.
  // Existing databases with the old nullable column definition continue to
  // work; the app always sets canonical_name explicitly, so NULLs can only
  // accumulate from very old inserts.  The backfill closes that hole.
  { version: 6, description: 'backfill entities.canonical_name NULLs to lower(name) (BUG-25)', up: (db) => {
    // Only backfill if the table exists
    const tableRow = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='entities'`
    ).get() as { name: string } | undefined;
    if (!tableRow) return;
    for (const s of [
      `UPDATE entities SET canonical_name = lower(name) WHERE canonical_name IS NULL`,
    ]) db.prepare(s).run();
  } },
  // Create conversation_summaries (episodic memory) on pre-existing DBs (BUG-31).
  // The table lives in schema.sql, but initializeSchema only runs schema.sql when
  // schema_version is ABSENT. DBs created before this table was added to schema.sql
  // already have schema_version, so they never got it — and no migration created it,
  // so dokoro_session_summary_add/recall failed. CREATE IF NOT EXISTS is a no-op on
  // fresh DBs (schema.sql already made it). The summary_embedding/compacted columns
  // are added idempotently at runtime by ensureEpisodicEmbeddingColumn/ensureCompactedColumn.
  { version: 7, description: 'create conversation_summaries on legacy DBs (episodic memory, BUG-31)', up: (db) => {
    const statements = [
      `CREATE TABLE IF NOT EXISTS conversation_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        ai_model TEXT NOT NULL,
        summary TEXT NOT NULL,
        key_decisions_json TEXT,
        key_topics_json TEXT,
        linked_docs_json TEXT,
        message_count INTEGER,
        token_count INTEGER,
        started_at DATETIME NOT NULL,
        ended_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE INDEX IF NOT EXISTS idx_conv_session ON conversation_summaries(session_id)`,
      `CREATE INDEX IF NOT EXISTS idx_conv_model ON conversation_summaries(ai_model)`,
      `CREATE INDEX IF NOT EXISTS idx_conv_dates ON conversation_summaries(started_at, ended_at)`,
    ];
    for (const s of statements) db.prepare(s).run();
  } },
  // Shared working memory (Letta-style shared blocks), per-project only.
  // An append-only, agent_id-tagged notes table that multiple agents in the
  // SAME project can write/read concurrently. Lives entirely in the per-project
  // SQLite DB (WAL + busy_timeout already configured in getSqliteDb), so it
  // bypasses the single-claimant current.md workspace lock — shared notes are
  // additive, not exclusive, and SQLite serialises concurrent INSERTs under the
  // write lock (last-writer-safe, no lost rows). No global/cross-project store
  // is introduced; isolation is structural (one DB file per project).
  // Statements run individually — NOT db.exec — consistent with v2/v7.
  // No down() path (consistent with v1–v7): drop shared_notes manually to revert.
  { version: 8, description: 'shared_notes table for concurrent multi-agent working memory', up: (db) => {
    const statements = [
      `CREATE TABLE IF NOT EXISTS shared_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        content TEXT NOT NULL,
        note_type TEXT DEFAULT 'scratch',
        metadata_json TEXT,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_shared_notes_created_at ON shared_notes(created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_shared_notes_agent_id ON shared_notes(agent_id)`,
    ];
    for (const s of statements) db.prepare(s).run();
  } },
  // v9: shared, EDITABLE blocks (upgrade from append-only shared_notes). Each block
  // is one row keyed by block_key; concurrent edits are made safe with optimistic
  // concurrency on `version` (atomic UPDATE ... WHERE block_key=? AND version=?).
  // Per-project only (one DB file per project); no global/cross-project store.
  { version: 9, description: 'shared_blocks table for editable multi-agent working memory', up: (db) => {
    const statements = [
      `CREATE TABLE IF NOT EXISTS shared_blocks (
        block_key TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT NOT NULL,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_shared_blocks_updated_at ON shared_blocks(updated_at)`,
    ];
    for (const s of statements) db.prepare(s).run();
  } },
  // v10: cross-session handoffs. An agent records a handoff for the next agent/session;
  // a claim step (status open->claimed) stops two agents from both picking it up.
  // Per-project only.
  { version: 10, description: 'handoffs table for cross-session multi-agent handoff', up: (db) => {
    const statements = [
      `CREATE TABLE IF NOT EXISTS handoffs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_agent TEXT NOT NULL,
        to_agent TEXT,
        session_id TEXT,
        summary TEXT NOT NULL,
        open_items_json TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        claimed_by TEXT,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        claimed_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_handoffs_status ON handoffs(status, created_at)`,
    ];
    for (const s of statements) db.prepare(s).run();
  } },
  // v11: agent_presence — daemonless heartbeat presence. One row per agent (upsert).
  // last_heartbeat is server-assigned unixepoch seconds (single clock domain);
  // liveness is computed at READ time (now - last_heartbeat <= TTL). No sweeper.
  // heartbeat_seq is a monotonic per-agent beat counter (diagnostic). Per-project only.
  { version: 11, description: 'agent_presence table for heartbeat-based multi-agent presence', up: (db) => {
    const statements = [
      `CREATE TABLE IF NOT EXISTS agent_presence (
        agent_id TEXT PRIMARY KEY,
        session_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        current_focus TEXT,
        last_heartbeat INTEGER NOT NULL,
        heartbeat_seq INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX IF NOT EXISTS idx_agent_presence_heartbeat ON agent_presence(last_heartbeat)`,
    ];
    for (const s of statements) db.prepare(s).run();
  } },
  // v12: file_claims — ADVISORY per-file claims so multiple agents can cooperate in
  // one worktree. Conflicts WARN, they never block: enforcement lives in the tools
  // layer, not here. Identity is claim_key — the casefolded normalized root-relative
  // path (src/utils/claim-path.ts) — so one file maps to exactly one row regardless
  // of case or separator differences; file_path keeps the display form. Lease
  // semantics: claimed_at/expires_at/released_at are server-assigned unixepoch
  // seconds (single clock domain, same convention as agent_presence v11); T5 tools
  // must use strftime('%s','now') for writes and comparisons, never Date.now().
  // heartbeat_seq is a monotonic renewal counter (DynamoDB lock-client style
  // version counter); released_at IS NULL means the claim is open. Rows are
  // ephemeral coordination state, distinct from durable memory — safe to prune.
  // Per-project only.
  { version: 12, description: 'file_claims table for advisory per-file multi-agent claims', up: (db) => {
    const statements = [
      `CREATE TABLE IF NOT EXISTS file_claims (
        claim_key TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT,
        intent TEXT,
        claimed_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        heartbeat_seq INTEGER NOT NULL DEFAULT 0,
        released_at INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_file_claims_agent ON file_claims(agent_id)`,
      `CREATE INDEX IF NOT EXISTS idx_file_claims_live ON file_claims(expires_at) WHERE released_at IS NULL`,
    ];
    for (const s of statements) db.prepare(s).run();
  } },
];

export function runMigrations(db: Database.Database): void {
  db.prepare(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY, description TEXT, applied_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`).run();
  // Base-table invariant (BUG-31): the legacy schema.sql seeds schema_version=1,
  // which collides with MIGRATIONS v1 and makes the version loop skip it — so on
  // those DBs the entity/feedback tables (and valid_from columns) v1 creates were
  // never applied, yet v2/v3 assume they exist. Run the idempotent ensurers
  // unconditionally so the base tables exist regardless of the recorded version.
  // No-ops on healthy DBs (CREATE IF NOT EXISTS + guarded ALTERs).
  ensureEntityTables(db);
  ensureAgentFeedbackTable(db);
  const row = db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number | null };
  const current = row.v ?? 0;
  // INSERT OR IGNORE: the legacy initializeSchema() init path may also write the
  // version row (e.g. v1 from schema.sql), so ignore conflicts on the PK.
  const record = db.prepare('INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)');
  const apply = db.transaction((m: Migration) => { m.up(db); record.run(m.version, m.description); });
  for (const m of MIGRATIONS) if (m.version > current) apply(m);
}
