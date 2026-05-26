import Database from 'better-sqlite3';
import { ensureEntityTables } from './entity-tables.js';

describe('entity_relations schema (bi-temporal)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    ensureEntityTables(db);
    db.prepare(`INSERT INTO entities (id,type,name) VALUES (1,'file','a'),(2,'file','b')`).run();
  });
  afterEach(() => db.close());

  it('allows multiple time-slices for the same tuple (one closed, one open)', () => {
    db.prepare(`INSERT INTO entity_relations (source_id,target_id,relation_type,valid_from,valid_to)
      VALUES (1,2,'uses','2026-01-01T00:00:00Z','2026-05-01T00:00:00Z')`).run();
    db.prepare(`INSERT INTO entity_relations (source_id,target_id,relation_type,valid_from,valid_to)
      VALUES (1,2,'uses','2026-05-01T00:00:00Z',NULL)`).run();
    const n = (db.prepare(`SELECT COUNT(*) c FROM entity_relations WHERE source_id=1 AND target_id=2 AND relation_type='uses'`).get() as { c: number }).c;
    expect(n).toBe(2);
  });

  it('forbids two OPEN rows for the same tuple (partial unique index)', () => {
    db.prepare(`INSERT INTO entity_relations (source_id,target_id,relation_type,valid_to) VALUES (1,2,'uses',NULL)`).run();
    expect(() => db.prepare(`INSERT INTO entity_relations (source_id,target_id,relation_type,valid_to) VALUES (1,2,'uses',NULL)`).run())
      .toThrow(/UNIQUE/);
  });
});
