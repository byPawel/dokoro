import Database from 'better-sqlite3';
import { runMigrations, MIGRATIONS } from './migrations.js';

describe('runMigrations', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => db.close());

  it('applies all migrations on a fresh db and records versions', () => {
    runMigrations(db);
    const max = (db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v;
    expect(max).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
  });

  it('is idempotent: a second run applies nothing new', () => {
    runMigrations(db);
    const before = (db.prepare('SELECT COUNT(*) c FROM schema_version').get() as { c: number }).c;
    runMigrations(db);
    const after = (db.prepare('SELECT COUNT(*) c FROM schema_version').get() as { c: number }).c;
    expect(after).toBe(before);
  });

  it('migration v2 preserves legacy entity_relations data and adds surrogate id + open-unique index', () => {
    // Build a LEGACY entity_relations table: composite PK, NO surrogate `id` column.
    db.prepare(`
      CREATE TABLE entity_relations (
        source_id INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        relation_type TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        metadata_json TEXT,
        valid_from TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        valid_to TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (source_id, target_id, relation_type)
      )
    `).run();
    db.prepare(`INSERT INTO entity_relations (source_id,target_id,relation_type,weight,metadata_json,valid_from,valid_to,created_at)
      VALUES (1,2,'uses',0.7,'{"a":1}','2026-01-01T00:00:00Z',NULL,'2026-01-01T00:00:00Z')`).run();
    db.prepare(`INSERT INTO entity_relations (source_id,target_id,relation_type,weight,metadata_json,valid_from,valid_to,created_at)
      VALUES (3,4,'implements',1.0,NULL,'2026-02-01T00:00:00Z','2026-03-01T00:00:00Z','2026-02-01T00:00:00Z')`).run();

    runMigrations(db);

    // Both rows survive with their data intact.
    const rows = db.prepare(`SELECT source_id,target_id,relation_type,weight,metadata_json,valid_from,valid_to,created_at
      FROM entity_relations ORDER BY source_id`).all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      source_id: 1, target_id: 2, relation_type: 'uses', weight: 0.7,
      metadata_json: '{"a":1}', valid_from: '2026-01-01T00:00:00Z', valid_to: null,
    });
    expect(rows[1]).toMatchObject({
      source_id: 3, target_id: 4, relation_type: 'implements', weight: 1.0,
      metadata_json: null, valid_from: '2026-02-01T00:00:00Z', valid_to: '2026-03-01T00:00:00Z',
    });

    // New table has the surrogate `id` column.
    const cols = db.prepare(`PRAGMA table_info(entity_relations)`).all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'id')).toBe(true);

    // The partial-unique open index exists.
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='uq_entity_rel_open'`).get();
    expect(idx).toBeDefined();

    // Functional check: the open row's id is populated (AUTOINCREMENT working).
    const open = db.prepare(`SELECT id FROM entity_relations WHERE source_id=1 AND valid_to IS NULL`).get() as { id: number };
    expect(typeof open.id).toBe('number');
  });

  it('migration v2 survives a legacy entity_relations that LACKS valid_from/valid_to (BUG-31)', () => {
    // Replicate the exact production state: schema.sql seeded schema_version=1
    // ("Initial schema"), which collides with MIGRATIONS v1 and makes it skip —
    // so entity_relations never got valid_from/valid_to and agent_feedback was
    // never created. v2's copy-SELECT then threw "no such column: valid_from",
    // aborting DB init for every dokoro tool on that DB.
    db.prepare(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, description TEXT, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)`).run();
    db.prepare(`INSERT INTO schema_version (version, description) VALUES (1, 'Initial schema')`).run();
    db.prepare(`
      CREATE TABLE entity_relations (
        source_id INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        relation_type TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        metadata_json TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (source_id, target_id, relation_type)
      )
    `).run();
    db.prepare(`INSERT INTO entity_relations (source_id,target_id,relation_type,weight,metadata_json,created_at)
      VALUES (1,2,'uses',0.7,'{"a":1}','2026-01-01T00:00:00Z')`).run();

    expect(() => runMigrations(db)).not.toThrow();

    // Row survives; valid_from is backfilled from created_at, valid_to stays open.
    const row = db.prepare(`SELECT source_id,target_id,relation_type,weight,metadata_json,valid_from,valid_to,created_at
      FROM entity_relations`).get() as Record<string, unknown>;
    expect(row).toMatchObject({
      source_id: 1, target_id: 2, relation_type: 'uses', weight: 0.7,
      metadata_json: '{"a":1}', valid_from: '2026-01-01T00:00:00Z', valid_to: null,
    });

    // New surrogate-id shape + open-unique index present.
    const cols = db.prepare(`PRAGMA table_info(entity_relations)`).all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'id')).toBe(true);
    expect(cols.some((c) => c.name === 'valid_from')).toBe(true);
  });

  it('migration v7 creates conversation_summaries on a legacy DB that lacks it (BUG-31)', () => {
    // Simulate a pre-existing DB: schema_version already present (so the gated
    // initializeSchema never re-runs schema.sql) but no conversation_summaries.
    db.prepare(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, description TEXT, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)`).run();
    db.prepare(`INSERT INTO schema_version (version, description) VALUES (1, 'Initial schema')`).run();

    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_summaries'`).get()
    ).toBeUndefined();

    expect(() => runMigrations(db)).not.toThrow();

    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_summaries'`).get()
    ).toBeDefined();

    // The columns the summary-insert path writes must exist.
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(conversation_summaries)`).all() as Array<{ name: string }>).map((c) => c.name)
    );
    for (const c of ['session_id', 'ai_model', 'summary', 'key_decisions_json', 'key_topics_json', 'message_count', 'token_count', 'started_at']) {
      expect(cols.has(c)).toBe(true);
    }
  });

  it('migration v4 rebuilds entity_content_hashes with FK and cascades on doc delete (BUG-23)', () => {
    // Bootstrap minimal tables the migration needs.
    db.prepare(`
      CREATE TABLE docs (
        id TEXT PRIMARY KEY,
        filepath TEXT UNIQUE NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT ''
      )
    `).run();

    // Create legacy entity_content_hashes WITHOUT a FK (old shape).
    db.prepare(`
      CREATE TABLE entity_content_hashes (
        doc_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        last_extracted TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // Insert a doc + a hash row before migration.
    db.prepare(`INSERT INTO docs (id) VALUES ('doc-1')`).run();
    db.prepare(`INSERT INTO entity_content_hashes (doc_id, content_hash) VALUES ('doc-1', 'abc123')`).run();

    // Run migrations (v4 should rebuild the table with FK).
    runMigrations(db);

    // Enable FK enforcement so CASCADE fires.
    db.prepare('PRAGMA foreign_keys = ON').run();

    // Existing hash row must still be present after migration.
    const hashBefore = db.prepare(
      'SELECT content_hash FROM entity_content_hashes WHERE doc_id = ?'
    ).get('doc-1') as { content_hash: string } | undefined;
    expect(hashBefore).toBeDefined();
    expect(hashBefore!.content_hash).toBe('abc123');

    // Delete the doc — ON DELETE CASCADE should remove the hash row.
    db.prepare(`DELETE FROM docs WHERE id = 'doc-1'`).run();

    const hashAfter = db.prepare(
      'SELECT content_hash FROM entity_content_hashes WHERE doc_id = ?'
    ).get('doc-1');
    expect(hashAfter).toBeUndefined();
  });

  it('migration v4 is a no-op when entity_content_hashes already has the FK', () => {
    db.prepare(`
      CREATE TABLE docs (
        id TEXT PRIMARY KEY,
        filepath TEXT UNIQUE NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT ''
      )
    `).run();
    // Create table with FK already in place (new shape).
    db.prepare(`
      CREATE TABLE entity_content_hashes (
        doc_id TEXT PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
        content_hash TEXT NOT NULL,
        last_extracted TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    db.prepare(`INSERT INTO docs (id) VALUES ('doc-x')`).run();
    db.prepare(`INSERT INTO entity_content_hashes (doc_id, content_hash) VALUES ('doc-x', 'xyz')`).run();

    // Should not throw and should not lose data.
    expect(() => runMigrations(db)).not.toThrow();

    const row = db.prepare(
      'SELECT content_hash FROM entity_content_hashes WHERE doc_id = ?'
    ).get('doc-x') as { content_hash: string } | undefined;
    expect(row?.content_hash).toBe('xyz');
  });

  it('migration v6 backfills NULL canonical_name to lower(name) on existing rows', () => {
    // Simulate an old DB: entities table with nullable canonical_name
    db.prepare(`
      CREATE TABLE entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        canonical_name TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(type, canonical_name)
      )
    `).run();
    // Insert rows: one with NULL canonical_name, one already set
    db.prepare(`INSERT INTO entities (type, name, canonical_name) VALUES ('file', 'Auth.ts', NULL)`).run();
    db.prepare(`INSERT INTO entities (type, name, canonical_name) VALUES ('concept', 'JWT', 'jwt')`).run();

    runMigrations(db);

    const rows = db.prepare(
      `SELECT name, canonical_name FROM entities ORDER BY name`
    ).all() as Array<{ name: string; canonical_name: string | null }>;

    // NULL row should be backfilled to lower(name)
    const authRow = rows.find((r) => r.name === 'Auth.ts');
    expect(authRow?.canonical_name).toBe('auth.ts');

    // Already-set row must be unchanged
    const jwtRow = rows.find((r) => r.name === 'JWT');
    expect(jwtRow?.canonical_name).toBe('jwt');
  });

  it('migration v6 is a no-op when entities table does not exist', () => {
    // Remove entities table if it was created (shouldn't be on a bare db)
    // Just verify that running migrations on a DB without entities doesn't throw.
    // We set schema_version manually to skip migrations 1-5 which create entities.
    db.prepare(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, description TEXT, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)`).run();
    db.prepare(`INSERT INTO schema_version (version, description) VALUES (5, 'simulated-past')`).run();
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('migration v8 creates shared_notes table with the expected columns and indexes', () => {
    runMigrations(db);

    // Table exists.
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='shared_notes'`).get()
    ).toBeDefined();

    // Columns match the design.
    const cols = new Map(
      (db.prepare(`PRAGMA table_info(shared_notes)`).all() as Array<{ name: string; type: string }>)
        .map((c) => [c.name, c.type])
    );
    for (const c of ['id', 'agent_id', 'content', 'note_type', 'metadata_json', 'created_at']) {
      expect(cols.has(c)).toBe(true);
    }

    // Indexes exist.
    for (const idx of ['idx_shared_notes_created_at', 'idx_shared_notes_agent_id']) {
      expect(
        db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(idx)
      ).toBeDefined();
    }

    // Functional: AUTOINCREMENT id + defaults populate without explicit values.
    db.prepare(`INSERT INTO shared_notes (agent_id, content) VALUES ('a','hello')`).run();
    const row = db.prepare(`SELECT id, note_type, created_at FROM shared_notes`).get() as {
      id: number; note_type: string; created_at: string;
    };
    expect(typeof row.id).toBe('number');
    expect(row.note_type).toBe('scratch');
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('migration v8 creates shared_notes on a legacy DB seeded up to v7 (idempotent)', () => {
    // Seed schema_version through v7 so only v8 runs.
    db.prepare(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, description TEXT, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)`).run();
    for (let v = 1; v <= 7; v++) {
      db.prepare(`INSERT INTO schema_version (version, description) VALUES (?, ?)`).run(v, `seeded v${v}`);
    }

    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='shared_notes'`).get()
    ).toBeUndefined();

    expect(() => runMigrations(db)).not.toThrow();

    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='shared_notes'`).get()
    ).toBeDefined();
    for (const idx of ['idx_shared_notes_created_at', 'idx_shared_notes_agent_id']) {
      expect(
        db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(idx)
      ).toBeDefined();
    }

    // Insert a row, then run migrations again — idempotent, no data loss, no extra version rows.
    db.prepare(`INSERT INTO shared_notes (agent_id, content) VALUES ('a','keep me')`).run();
    const before = (db.prepare(`SELECT COUNT(*) c FROM shared_notes`).get() as { c: number }).c;
    const versionsBefore = (db.prepare(`SELECT COUNT(*) c FROM schema_version`).get() as { c: number }).c;

    expect(() => runMigrations(db)).not.toThrow();

    const after = (db.prepare(`SELECT COUNT(*) c FROM shared_notes`).get() as { c: number }).c;
    const versionsAfter = (db.prepare(`SELECT COUNT(*) c FROM schema_version`).get() as { c: number }).c;
    expect(after).toBe(before);
    expect(versionsAfter).toBe(versionsBefore);
  });

  it('migration v9 creates shared_blocks with the optimistic-concurrency columns', () => {
    db.prepare(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, description TEXT, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)`).run();
    expect(() => runMigrations(db)).not.toThrow();
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(shared_blocks)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const c of ['block_key', 'content', 'version', 'updated_by', 'created_at', 'updated_at']) {
      expect(cols.has(c)).toBe(true);
    }
    // block_key is the primary key (one row per key).
    const pk = (db.prepare(`PRAGMA table_info(shared_blocks)`).all() as Array<{ name: string; pk: number }>)
      .find((c) => c.name === 'block_key');
    expect(pk?.pk).toBe(1);
  });

  it('migration v10 creates handoffs with claim columns', () => {
    db.prepare(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, description TEXT, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)`).run();
    expect(() => runMigrations(db)).not.toThrow();
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(handoffs)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const c of ['id', 'from_agent', 'to_agent', 'session_id', 'summary', 'open_items_json', 'status', 'claimed_by', 'created_at', 'claimed_at']) {
      expect(cols.has(c)).toBe(true);
    }
  });

  it('migration v11 creates agent_presence keyed by agent_id', () => {
    db.prepare(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, description TEXT, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)`).run();
    expect(() => runMigrations(db)).not.toThrow();
    const cols = db.prepare(`PRAGMA table_info(agent_presence)`).all() as Array<{ name: string; pk: number }>;
    const names = new Set(cols.map((c) => c.name));
    for (const c of ['agent_id', 'session_id', 'status', 'current_focus', 'last_heartbeat', 'heartbeat_seq']) {
      expect(names.has(c)).toBe(true);
    }
    expect(cols.find((c) => c.name === 'agent_id')?.pk).toBe(1);
  });

  it('migration v12 creates file_claims keyed by claim_key with lease columns and indexes', () => {
    runMigrations(db);

    // Fresh DB lands on (at least) v12.
    const max = (db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v;
    expect(max).toBeGreaterThanOrEqual(12);

    // Table exists with the expected columns.
    const cols = db.prepare(`PRAGMA table_info(file_claims)`).all() as Array<{ name: string; pk: number }>;
    const names = new Set(cols.map((c) => c.name));
    for (const c of ['claim_key', 'file_path', 'agent_id', 'session_id', 'intent', 'claimed_at', 'expires_at', 'heartbeat_seq', 'released_at']) {
      expect(names.has(c)).toBe(true);
    }
    // claim_key is the primary key (one file = one row).
    expect(cols.find((c) => c.name === 'claim_key')?.pk).toBe(1);

    // Indexes exist (idx_file_claims_live is partial: WHERE released_at IS NULL).
    for (const idx of ['idx_file_claims_agent', 'idx_file_claims_live']) {
      expect(
        db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(idx)
      ).toBeDefined();
    }

    // Functional: defaults populate — heartbeat_seq starts at 0, released_at NULL (open).
    // Timestamps are unixepoch SECONDS (same clock domain as agent_presence v11).
    db.prepare(`INSERT INTO file_claims (claim_key, file_path, agent_id, claimed_at, expires_at)
      VALUES ('src/auth.ts', 'src/Auth.ts', 'agent-a',
        CAST(strftime('%s','now') AS INTEGER),
        CAST(strftime('%s','now') AS INTEGER) + 300)`).run();
    const row = db.prepare(`SELECT heartbeat_seq, released_at FROM file_claims`).get() as {
      heartbeat_seq: number; released_at: number | null;
    };
    expect(row.heartbeat_seq).toBe(0);
    expect(row.released_at).toBeNull();
  });

  it('migration v12 file_claims: live-claim UPDATE guard touches only open, unexpired rows', () => {
    runMigrations(db);
    const now = (db.prepare(`SELECT CAST(strftime('%s','now') AS INTEGER) t`).get() as { t: number }).t;

    // Three claims: open + unexpired (live), released, and open but expired.
    db.prepare(`INSERT INTO file_claims (claim_key, file_path, agent_id, claimed_at, expires_at)
      VALUES ('src/live.ts', 'src/live.ts', 'agent-a', ?, ?)`).run(now, now + 300);
    db.prepare(`INSERT INTO file_claims (claim_key, file_path, agent_id, claimed_at, expires_at, released_at)
      VALUES ('src/released.ts', 'src/released.ts', 'agent-a', ?, ?, ?)`).run(now - 600, now + 300, now - 60);
    db.prepare(`INSERT INTO file_claims (claim_key, file_path, agent_id, claimed_at, expires_at)
      VALUES ('src/expired.ts', 'src/expired.ts', 'agent-a', ?, ?)`).run(now - 600, now - 1);

    const guard = db.prepare(
      `UPDATE file_claims SET agent_id='thief' WHERE claim_key=? AND released_at IS NULL AND expires_at > ?`
    );

    // Live unexpired claim: exactly 1 row updated.
    expect(guard.run('src/live.ts', now).changes).toBe(1);
    // Released claim: untouched.
    expect(guard.run('src/released.ts', now).changes).toBe(0);
    // Expired claim: untouched.
    expect(guard.run('src/expired.ts', now).changes).toBe(0);

    const agents = db.prepare(`SELECT claim_key, agent_id FROM file_claims ORDER BY claim_key`).all() as
      Array<{ claim_key: string; agent_id: string }>;
    expect(agents).toEqual([
      { claim_key: 'src/expired.ts', agent_id: 'agent-a' },
      { claim_key: 'src/live.ts', agent_id: 'thief' },
      { claim_key: 'src/released.ts', agent_id: 'agent-a' },
    ]);
  });

  it('migration v12 upgrades a DB seeded at v11 and re-running is a no-op (idempotent)', () => {
    // Seed schema_version through v11 so only v12 runs.
    db.prepare(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, description TEXT, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)`).run();
    for (let v = 1; v <= 11; v++) {
      db.prepare(`INSERT INTO schema_version (version, description) VALUES (?, ?)`).run(v, `seeded v${v}`);
    }

    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='file_claims'`).get()
    ).toBeUndefined();

    expect(() => runMigrations(db)).not.toThrow();

    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='file_claims'`).get()
    ).toBeDefined();
    for (const idx of ['idx_file_claims_agent', 'idx_file_claims_live']) {
      expect(
        db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(idx)
      ).toBeDefined();
    }

    // Insert a claim, then run migrations again — idempotent, no data loss, no extra version rows.
    db.prepare(`INSERT INTO file_claims (claim_key, file_path, agent_id, claimed_at, expires_at)
      VALUES ('src/db/migrations.ts', 'src/db/migrations.ts', 'agent-b', 1, 2)`).run();
    const before = (db.prepare(`SELECT COUNT(*) c FROM file_claims`).get() as { c: number }).c;
    const versionsBefore = (db.prepare(`SELECT COUNT(*) c FROM schema_version`).get() as { c: number }).c;

    expect(() => runMigrations(db)).not.toThrow();

    const after = (db.prepare(`SELECT COUNT(*) c FROM file_claims`).get() as { c: number }).c;
    const versionsAfter = (db.prepare(`SELECT COUNT(*) c FROM schema_version`).get() as { c: number }).c;
    expect(after).toBe(before);
    expect(versionsAfter).toBe(versionsBefore);
  });

  it('rolls back a failing migration: no version row is recorded', () => {
    runMigrations(db); // apply existing migrations first
    const failingVersion = MIGRATIONS[MIGRATIONS.length - 1].version + 1;
    MIGRATIONS.push({
      version: failingVersion,
      description: 'intentionally failing migration',
      up: () => { throw new Error('boom'); },
    });
    try {
      expect(() => runMigrations(db)).toThrow('boom');
      const row = db
        .prepare('SELECT COUNT(*) c FROM schema_version WHERE version = ?')
        .get(failingVersion) as { c: number };
      expect(row.c).toBe(0);
    } finally {
      MIGRATIONS.pop();
    }
  });
});
