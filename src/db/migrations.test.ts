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
});
