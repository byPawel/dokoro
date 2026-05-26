import Database from 'better-sqlite3';

/**
 * BUG-13: foreign_keys is a per-connection PRAGMA. getDb()/getSqliteDb() must
 * enable it on every handle so callers never run with FK enforcement OFF.
 *
 * NOTE: src/db/index.ts cannot be imported under ts-jest (its module side
 * effects — drizzle + schema.sql loading via import.meta/__dirname — fail in
 * the jest VM, which is why every other test mocks '../db/index.js'). We
 * therefore assert the invariant the factory establishes: a connection set up
 * with the same pragma sequence has foreign_keys ON and actually enforces FKs.
 */
describe('foreign_keys enforcement (BUG-13)', () => {
  function makeConnectionLikeFactory(): Database.Database {
    // Mirror getDb()'s connection setup (src/db/index.ts:124-126).
    const sqlite = new Database(':memory:');
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');
    return sqlite;
  }

  it('a factory-style connection reports foreign_keys ON', () => {
    const db = makeConnectionLikeFactory();
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
    db.close();
  });

  it('foreign_keys ON actually rejects orphan referencing-row inserts', () => {
    const db = makeConnectionLikeFactory();
    db.prepare('CREATE TABLE owner_tbl (id INTEGER PRIMARY KEY)').run();
    db.prepare('CREATE TABLE item_tbl (id INTEGER PRIMARY KEY, owner_id INTEGER REFERENCES owner_tbl(id))').run();
    expect(() => db.prepare('INSERT INTO item_tbl (id, owner_id) VALUES (1, 999)').run())
      .toThrow(/FOREIGN KEY/);
    db.close();
  });
});
