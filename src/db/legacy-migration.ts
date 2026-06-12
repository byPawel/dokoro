/**
 * One-way startup migration for the split-brain data dir bug.
 *
 * Historically two `.dokoro` locations could exist for one workspace:
 * - canonical: `<dokoroPath>/.dokoro` (inside the dokoro workspace folder)
 * - legacy:    `<projectPath>/.dokoro` (no folder segment — produced when
 *   DOKORO_PATH resolved to the cwd itself, e.g. a repo named 'dokoro'
 *   before a nested dokoro/ folder appeared)
 *
 * Before the FIRST database connection is opened for a workspace, this module
 * moves the legacy `.dokoro` directory (SQLite db + WAL/SHM sidecars +
 * vectors.lance + anything else) to the canonical location, but only when the
 * canonical database is missing or trivially empty. If both contain data it
 * keeps canonical and warns — SQLite files are never merged silently.
 *
 * Pure fs/path/better-sqlite3 (+ the dokoroDataDir path helper) — intentionally
 * NO imports from ./index.js so it stays importable under ts-jest (db/index.ts
 * cannot be, see index.fk.test.ts).
 * Never throws: any failure is logged and the caller proceeds untouched.
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dokoroDataDir } from '../shared/dokoro-utils.js';

/** Tables whose rows mean "this database has real data". */
const DATA_TABLES = [
  'docs',
  'agent_presence',
  'file_claims',
  'sessions',
  'entities',
  'shared_notes',
  'shared_blocks',
  'handoffs',
  'agent_feedback',
  'conversation_summaries',
];

/** Resolve symlinks when possible; fall back to lexical normalization. */
function normalizedPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * A database file is trivially empty when it is absent or every known data
 * table is empty. Unreadable/corrupt files count as NON-trivial so we never
 * overwrite something we cannot inspect.
 */
export function isTriviallyEmptyDb(dbFile: string): boolean {
  if (!fs.existsSync(dbFile)) return true;
  let probe: Database.Database | null = null;
  try {
    probe = new Database(dbFile, { readonly: true, fileMustExist: true });
    const placeholders = DATA_TABLES.map(() => '?').join(',');
    const tables = probe
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`)
      .all(...DATA_TABLES) as Array<{ name: string }>;
    for (const { name } of tables) {
      const row = probe.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number };
      if (row.n > 0) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    probe?.close();
  }
}

/**
 * Remove a trivially-empty canonical db and its WAL/SHM sidecars. Safe because
 * the caller has already verified the db holds no data (so any pending WAL
 * frames are worthless too) and no connection to it is open in this process.
 */
function removeDbFiles(dbFile: string): void {
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
    fs.rmSync(f, { force: true });
  }
}

/**
 * Move everything under srcDir into destDir, merging directories and leaving
 * conflicting files behind in srcDir. Removes srcDir afterwards if emptied.
 */
function moveDirContents(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, entry);
    const dest = path.join(destDir, entry);
    if (!fs.existsSync(dest)) {
      fs.renameSync(src, dest);
    } else if (fs.statSync(src).isDirectory() && fs.statSync(dest).isDirectory()) {
      moveDirContents(src, dest);
    }
    // Conflicting file: leave it in the legacy dir rather than overwrite.
  }
  try {
    fs.rmdirSync(srcDir);
  } catch {
    // Not empty (conflicting files were kept) — leave it for manual cleanup.
  }
}

/**
 * One-way migration of a legacy `<projectPath>/.dokoro` data dir to the
 * canonical `<dokoroPath>/.dokoro` location. Must be called BEFORE the first
 * connection to the canonical database is opened in this process. No-ops when
 * there is nothing to migrate, when legacy and canonical are the same path
 * (realpath comparison), or when the canonical db already holds data.
 */
export function migrateLegacyDataDir(projectPath: string, dokoroPath: string, dbName = 'dokoro.sqlite'): void {
  try {
    const canonicalDir = dokoroDataDir(dokoroPath);
    // The legacy variant dropped the dokoro folder segment entirely.
    const legacyDir = dokoroDataDir(projectPath);
    if (normalizedPath(canonicalDir) === normalizedPath(legacyDir)) return;

    const legacyDb = path.join(legacyDir, 'db', dbName);
    if (!fs.existsSync(legacyDb)) return;

    const canonicalDb = path.join(canonicalDir, 'db', dbName);
    if (!isTriviallyEmptyDb(canonicalDb)) {
      console.error(
        `[dokoro] Found data in both ${canonicalDb} and legacy ${legacyDb}. ` +
        `Keeping the canonical database; merge or remove the legacy .dokoro directory manually.`
      );
      return;
    }

    if (!fs.existsSync(canonicalDir)) {
      fs.mkdirSync(path.dirname(canonicalDir), { recursive: true });
      fs.renameSync(legacyDir, canonicalDir);
    } else {
      removeDbFiles(canonicalDb);
      moveDirContents(legacyDir, canonicalDir);
    }
    console.error(`[dokoro] Migrated legacy data dir ${legacyDir} -> ${canonicalDir}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[dokoro] Legacy data dir migration failed (continuing without it): ${msg}`);
  }
}
