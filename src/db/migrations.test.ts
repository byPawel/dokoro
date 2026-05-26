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
