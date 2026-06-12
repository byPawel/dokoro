import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { migrateLegacyDataDir, isTriviallyEmptyDb } from './legacy-migration.js';

/**
 * Migration of a legacy `<projectPath>/.dokoro` data dir to the canonical
 * `<dokoroPath>/.dokoro` location. Tested via the migration module directly:
 * src/db/index.ts (which calls migrateLegacyDataDir on first connection)
 * cannot be imported under ts-jest — see index.fk.test.ts for why.
 */
describe('migrateLegacyDataDir', () => {
  let projectPath: string;
  let dokoroPath: string;
  let errSpy: jest.SpiedFunction<typeof console.error>;

  const legacyDir = (): string => path.join(projectPath, '.dokoro');
  const canonicalDir = (): string => path.join(dokoroPath, '.dokoro');
  const legacyDb = (): string => path.join(legacyDir(), 'db', 'dokoro.sqlite');
  const canonicalDb = (): string => path.join(canonicalDir(), 'db', 'dokoro.sqlite');

  beforeEach(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dokoro-mig-'));
    dokoroPath = path.join(projectPath, 'dokoro');
    fs.mkdirSync(dokoroPath, { recursive: true });
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errSpy.mockRestore();
    fs.rmSync(projectPath, { recursive: true, force: true });
  });

  /** Create a SQLite db at `file` with a marker table holding one row. */
  function makeMarkerDb(file: string, marker: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.prepare('CREATE TABLE marker (value TEXT)').run();
    db.prepare('INSERT INTO marker (value) VALUES (?)').run(marker);
    db.close();
  }

  /** Create a db that isTriviallyEmptyDb treats as having real data. */
  function makeDataDb(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.prepare('CREATE TABLE docs (id TEXT PRIMARY KEY)').run();
    db.prepare("INSERT INTO docs (id) VALUES ('doc-1')").run();
    db.close();
  }

  function readMarker(file: string): string {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      return (db.prepare('SELECT value FROM marker').get() as { value: string }).value;
    } finally {
      db.close();
    }
  }

  it('moves a legacy .dokoro dir (db, sidecars, vectors) to the canonical location', () => {
    makeMarkerDb(legacyDb(), 'real-data');
    // WAL/SHM sidecars (empty is valid for SQLite) and a vectors.lance dir.
    fs.writeFileSync(`${legacyDb()}-wal`, '');
    fs.writeFileSync(`${legacyDb()}-shm`, '');
    fs.mkdirSync(path.join(legacyDir(), 'db', 'vectors.lance'));
    fs.writeFileSync(path.join(legacyDir(), 'db', 'vectors.lance', 'data.bin'), 'v');

    migrateLegacyDataDir(projectPath, dokoroPath);

    expect(fs.existsSync(legacyDir())).toBe(false);
    expect(readMarker(canonicalDb())).toBe('real-data');
    expect(fs.existsSync(`${canonicalDb()}-wal`)).toBe(true);
    expect(fs.existsSync(`${canonicalDb()}-shm`)).toBe(true);
    expect(fs.existsSync(path.join(canonicalDir(), 'db', 'vectors.lance', 'data.bin'))).toBe(true);
    expect(errSpy.mock.calls.flat().join('\n')).toContain('Migrated legacy data dir');
  });

  it('replaces a trivially-empty canonical db with the legacy one', () => {
    makeMarkerDb(legacyDb(), 'survivor');
    // Canonical exists, has schema-ish tables but zero rows → trivially empty.
    fs.mkdirSync(path.join(canonicalDir(), 'db'), { recursive: true });
    const empty = new Database(canonicalDb());
    empty.prepare('CREATE TABLE docs (id TEXT PRIMARY KEY)').run();
    empty.prepare('CREATE TABLE agent_presence (agent_id TEXT PRIMARY KEY)').run();
    empty.close();

    migrateLegacyDataDir(projectPath, dokoroPath);

    expect(readMarker(canonicalDb())).toBe('survivor');
    expect(fs.existsSync(legacyDb())).toBe(false);
  });

  it('prefers canonical and leaves legacy untouched when BOTH hold data', () => {
    makeDataDb(canonicalDb());
    makeMarkerDb(legacyDb(), 'legacy-data');

    migrateLegacyDataDir(projectPath, dokoroPath);

    // Canonical kept its data, legacy was not moved or deleted.
    const db = new Database(canonicalDb(), { readonly: true });
    expect((db.prepare('SELECT COUNT(*) AS n FROM docs').get() as { n: number }).n).toBe(1);
    db.close();
    expect(readMarker(legacyDb())).toBe('legacy-data');
    expect(errSpy.mock.calls.flat().join('\n')).toContain('manually');
  });

  it('no-ops when legacy and canonical resolve to the same path', () => {
    // DOKORO_PATH = cwd named "dokoro" with no nested folder: dokoroPath === projectPath.
    makeMarkerDb(legacyDb(), 'same-place');

    migrateLegacyDataDir(projectPath, projectPath);

    expect(readMarker(legacyDb())).toBe('same-place');
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('no-ops when there is no legacy database', () => {
    migrateLegacyDataDir(projectPath, dokoroPath);
    expect(fs.existsSync(canonicalDir())).toBe(false);
    expect(errSpy).not.toHaveBeenCalled();
  });
});

describe('isTriviallyEmptyDb', () => {
  it('missing file is trivial; data tables with rows are not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dokoro-trivial-'));
    try {
      const file = path.join(dir, 'x.sqlite');
      expect(isTriviallyEmptyDb(file)).toBe(true);

      const db = new Database(file);
      db.prepare('CREATE TABLE file_claims (claim_key TEXT PRIMARY KEY)').run();
      db.close();
      expect(isTriviallyEmptyDb(file)).toBe(true);

      const db2 = new Database(file);
      db2.prepare("INSERT INTO file_claims (claim_key) VALUES ('k')").run();
      db2.close();
      expect(isTriviallyEmptyDb(file)).toBe(false);

      // Unreadable garbage counts as NON-trivial (never overwrite it).
      const garbage = path.join(dir, 'garbage.sqlite');
      fs.writeFileSync(garbage, 'not a sqlite file at all');
      expect(isTriviallyEmptyDb(garbage)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
