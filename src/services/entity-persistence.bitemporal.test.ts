import Database from 'better-sqlite3';
import { ensureEntityTables } from '../db/entity-tables.js';
import { EntityPersistence, FUNCTIONAL_RELATION_TYPES } from './entity-extractor.js';

function seed(db: Database.Database) {
  ensureEntityTables(db);
  db.prepare(`INSERT INTO entities (id,type,name,canonical_name) VALUES
    (1,'file','auth','auth'),(2,'concept','jwt','jwt'),(3,'concept','oauth','oauth')`).run();
}

describe('EntityPersistence bi-temporal writes', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); seed(db); });
  afterEach(() => db.close());

  it('many-valued relations keep multiple open targets', () => {
    const p = new EntityPersistence(db);
    p.upsertRelation(1, 2, 'depends_on', 1.0, '2026-01-01T00:00:00Z');
    p.upsertRelation(1, 3, 'depends_on', 1.0, '2026-05-01T00:00:00Z');
    const open = (db.prepare(
      `SELECT COUNT(*) c FROM entity_relations WHERE source_id=1 AND relation_type='depends_on' AND valid_to IS NULL`
    ).get() as { c: number }).c;
    expect(open).toBe(2);
  });

  it('idempotent re-assert keeps a single open row', () => {
    const p = new EntityPersistence(db);
    p.upsertRelation(1, 2, 'depends_on', 1.0, '2026-01-01T00:00:00Z');
    p.upsertRelation(1, 2, 'depends_on', 1.0, '2026-02-01T00:00:00Z');
    const n = (db.prepare(
      `SELECT COUNT(*) c FROM entity_relations WHERE source_id=1 AND target_id=2 AND valid_to IS NULL`
    ).get() as { c: number }).c;
    expect(n).toBe(1);
  });

  it('a functional relation closes the prior window', () => {
    const p = new EntityPersistence(db);
    FUNCTIONAL_RELATION_TYPES.add('current_status');
    try {
      const t1 = '2026-01-01T00:00:00Z';
      const t2 = '2026-05-01T00:00:00Z';
      p.upsertRelation(1, 2, 'current_status', 1.0, t1);
      p.upsertRelation(1, 3, 'current_status', 1.0, t2);
      const target2 = db.prepare(
        `SELECT valid_to FROM entity_relations WHERE source_id=1 AND target_id=2 AND relation_type='current_status'`
      ).get() as { valid_to: string | null };
      const target3 = db.prepare(
        `SELECT valid_to FROM entity_relations WHERE source_id=1 AND target_id=3 AND relation_type='current_status'`
      ).get() as { valid_to: string | null };
      expect(target2.valid_to).toBe(t2);
      expect(target3.valid_to).toBeNull();
    } finally {
      FUNCTIONAL_RELATION_TYPES.delete('current_status');
    }
  });
});
