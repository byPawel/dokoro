import Database from 'better-sqlite3';
import { ensureEntityTables } from '../db/entity-tables.js';
import {
  EntityExtractor,
  RelationDetector,
  EntityPersistence,
  FUNCTIONAL_RELATION_TYPES,
} from './entity-extractor.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  ensureEntityTables(db);
  const ins = db.prepare('INSERT INTO entities (type, name, canonical_name) VALUES (?,?,?)');
  ins.run('component', 'A', 'a'); // id 1
  ins.run('component', 'B', 'b'); // id 2
  ins.run('component', 'C', 'c'); // id 3
  return db;
}

it('registers superseded_by as a functional relation', () => {
  expect(FUNCTIONAL_RELATION_TYPES.has('superseded_by')).toBe(true);
});

it('extracts "X replaced by Y" as X superseded_by Y (not inverted)', () => {
  const extractor = new EntityExtractor();
  const detector = new RelationDetector();
  const text = 'AuthService replaced by AuthV2';
  const entities = extractor.extractEntities(text);
  const sup = detector.detectRelations(text, entities).filter((r) => r.relationType === 'superseded_by');
  expect(sup.length).toBeGreaterThanOrEqual(1);
  // The superseded entity (AuthService) must be the SOURCE, successor the TARGET.
  expect(sup[0].sourceCanonical).toBe('authservice');
  expect(sup[0].targetCanonical).toBe('authv2');
});

it('closes the prior superseded_by window when the successor changes', () => {
  const db = makeDb();
  const p = new EntityPersistence(db);
  p.upsertRelation(1, 2, 'superseded_by', 1.0, '2026-01-01T00:00:00Z');
  p.upsertRelation(1, 3, 'superseded_by', 1.0, '2026-02-01T00:00:00Z');

  const open = db
    .prepare(
      "SELECT target_id FROM entity_relations WHERE source_id=1 AND relation_type='superseded_by' AND valid_to IS NULL",
    )
    .all() as Array<{ target_id: number }>;
  const closed = db
    .prepare(
      "SELECT target_id, valid_to FROM entity_relations WHERE source_id=1 AND relation_type='superseded_by' AND valid_to IS NOT NULL",
    )
    .all() as Array<{ target_id: number; valid_to: string }>;

  expect(open).toEqual([{ target_id: 3 }]); // only C is current
  expect(closed).toEqual([{ target_id: 2, valid_to: '2026-02-01T00:00:00Z' }]); // B closed at t2
});

it('keeps depends_on many-valued (no false invalidation)', () => {
  const db = makeDb();
  const p = new EntityPersistence(db);
  p.upsertRelation(1, 2, 'depends_on', 1.0, '2026-01-01T00:00:00Z');
  p.upsertRelation(1, 3, 'depends_on', 1.0, '2026-02-01T00:00:00Z');
  const open = db
    .prepare(
      "SELECT target_id FROM entity_relations WHERE source_id=1 AND relation_type='depends_on' AND valid_to IS NULL",
    )
    .all() as Array<{ target_id: number }>;
  expect(open.map((o) => o.target_id).sort()).toEqual([2, 3]);
});
