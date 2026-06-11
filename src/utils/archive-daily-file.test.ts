/**
 * archiveDailyFile: manual, user-initiated archiving of a single daily file.
 *
 * DOKORO_PATH is captured at module import time, so each test points
 * process.env.DOKORO_PATH at a temp dir and loads a fresh module instance
 * via jest.isolateModules() (same pattern as src/utils/archive.test.ts).
 * file_claims access goes through globalThis.__TEST_DB__ — getSqliteDb is
 * mocked to throw if reached.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { jest } from '@jest/globals';
import { isoWeekDir } from './timestamp.js';
import { normalizeClaimPath } from './claim-path.js';

jest.mock('../db/index.js', () => ({
  getSqliteDb: () => { throw new Error('getSqliteDb should not be called in tests (use __TEST_DB__)'); },
}));

type ArchiveModule = typeof import('./archive.js');

const MS_PER_DAY = 86_400_000;

let tmpDir: string;
let mod: ArchiveModule;
let db: Database.Database;

function freshModule(): Promise<ArchiveModule> {
  return new Promise<ArchiveModule>((resolve) => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      resolve(require('./archive.js') as ArchiveModule);
    });
  });
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * MS_PER_DAY);
}

const dailyDir = (): string => path.join(tmpDir, 'daily');
const dailyArchiveDir = (): string => path.join(tmpDir, 'archive', 'daily');

/** ISO week dir exactly as production derives it: from the FILENAME date (UTC). */
function weekDirOf(name: string): string {
  return isoWeekDir(new Date(`${name.slice(0, 10)}T00:00:00Z`));
}

/** Daily file named with the real slug shape: YYYY-MM-DD-HHhMM-day-… */
async function writeDaily(date: Date, content = '# stub\n', suffix = 'session'): Promise<string> {
  const name = `${date.toISOString().slice(0, 10)}-10h00-someday-${suffix}.md`;
  await fs.writeFile(path.join(dailyDir(), name), content);
  return name;
}

function insertLiveClaim(claimKey: string): void {
  db.prepare(`
    INSERT INTO file_claims (claim_key, file_path, agent_id, claimed_at, expires_at, heartbeat_seq, released_at)
    VALUES (?, ?, 'alice', strftime('%s','now'), strftime('%s','now') + 600, 0, NULL)
  `).run(claimKey, claimKey);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dokoro-archive-daily-test-'));
  process.env['DOKORO_PATH'] = tmpDir;
  await fs.mkdir(dailyDir(), { recursive: true });

  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE file_claims (
      claim_key TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_id TEXT,
      intent TEXT,
      claimed_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      heartbeat_seq INTEGER NOT NULL DEFAULT 0,
      released_at INTEGER
    );
  `);
  (globalThis as Record<string, unknown>).__TEST_DB__ = db;

  mod = await freshModule();
});

afterEach(async () => {
  delete process.env['DOKORO_PATH'];
  delete (globalThis as Record<string, unknown>).__TEST_DB__;
  db.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('archiveDailyFile', () => {
  it('moves an old daily file into its ISO-week archive dir, preserving content', async () => {
    const name = await writeDaily(daysAgo(20), '# important notes\nline two\n');

    const res = await mod.archiveDailyFile(name);

    const dest = path.join(dailyArchiveDir(), weekDirOf(name), name);
    expect(res).toEqual({ outcome: 'moved', from: path.join(dailyDir(), name), to: dest });
    await expect(fs.access(path.join(dailyDir(), name))).rejects.toBeDefined();
    expect(await fs.readFile(dest, 'utf-8')).toBe('# important notes\nline two\n');
  });

  it("refuses current-ISO-week files without force ('currentWeek'), moves them with force", async () => {
    const name = await writeDaily(new Date());

    const refused = await mod.archiveDailyFile(name);
    expect(refused.outcome).toBe('currentWeek');
    await expect(fs.access(path.join(dailyDir(), name))).resolves.toBeUndefined();

    const forced = await mod.archiveDailyFile(name, { force: true });
    expect(forced.outcome).toBe('moved');
    await expect(fs.access(path.join(dailyDir(), name))).rejects.toBeDefined();
    await expect(
      fs.access(path.join(dailyArchiveDir(), weekDirOf(name), name)),
    ).resolves.toBeUndefined();
  });

  it("returns 'claimed' for a file with a live advisory claim; force bypasses", async () => {
    const name = await writeDaily(daysAgo(20));
    // Derive the claim key exactly as production does — the test must not
    // silently diverge from the helper's key derivation.
    const normalized = normalizeClaimPath(path.join(dailyDir(), name), tmpDir);
    if (!normalized.ok) throw new Error(`claim path normalization failed: ${normalized.error}`);
    insertLiveClaim(normalized.claimKey);

    const blocked = await mod.archiveDailyFile(name, { claimRoot: tmpDir });
    expect(blocked.outcome).toBe('claimed');
    await expect(fs.access(path.join(dailyDir(), name))).resolves.toBeUndefined();

    const forced = await mod.archiveDailyFile(name, { force: true, claimRoot: tmpDir });
    expect(forced.outcome).toBe('moved');
    await expect(fs.access(path.join(dailyDir(), name))).rejects.toBeDefined();
  });

  it("returns 'alreadyArchived' when the source is gone but the destination exists (sweep race)", async () => {
    const name = `${daysAgo(20).toISOString().slice(0, 10)}-10h00-someday-session.md`;
    const dest = path.join(dailyArchiveDir(), weekDirOf(name), name);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, '# already swept\n');

    const res = await mod.archiveDailyFile(name);
    expect(res).toEqual({ outcome: 'alreadyArchived', from: path.join(dailyDir(), name), to: dest });
  });

  it("returns 'missing' when the file exists nowhere", async () => {
    const name = `${daysAgo(20).toISOString().slice(0, 10)}-10h00-someday-session.md`;

    const res = await mod.archiveDailyFile(name);
    expect(res).toEqual({ outcome: 'missing', from: path.join(dailyDir(), name) });
  });

  it("returns 'failed' for names without a YYYY-MM-DD prefix", async () => {
    await fs.writeFile(path.join(dailyDir(), 'notes-without-date.md'), '# stub\n');

    const res = await mod.archiveDailyFile('notes-without-date.md');
    expect(res.outcome).toBe('failed');
    expect(res.error).toMatch(/YYYY-MM-DD/);
    await expect(fs.access(path.join(dailyDir(), 'notes-without-date.md'))).resolves.toBeUndefined();
  });
});
