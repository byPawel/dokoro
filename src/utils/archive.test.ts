/**
 * archive.ts: crash-safe plan archiving + conservative workspace sweep.
 *
 * DOKORO_PATH is captured at module import time, so each test points
 * process.env.DOKORO_PATH at a temp dir and loads a fresh module instance
 * via jest.isolateModules() (same pattern as compression-tool.findfiles.test.ts).
 * file_claims access goes through globalThis.__TEST_DB__ (same pattern as
 * file-claim-tools.test.ts) — getSqliteDb is mocked to throw if reached.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { jest } from '@jest/globals';
import { isoWeekDir, monthDir } from './timestamp.js';
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

function utcDateStamp(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const plansDir = (): string => path.join(tmpDir, '.mcp', 'plans');
const indexPath = (): string => path.join(plansDir(), 'index.json');
const dailyDir = (): string => path.join(tmpDir, 'daily');
const lockPath = (): string => path.join(tmpDir, '.mcp', 'archive.lock');
const statusPath = (): string => path.join(tmpDir, '.mcp', 'archive-status.json');

async function writeIndex(index: Record<string, unknown>): Promise<void> {
  await fs.writeFile(indexPath(), JSON.stringify(index, null, 2));
}

async function readIndex(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(indexPath(), 'utf-8')) as Record<string, unknown>;
}

async function writePlan(
  id: string,
  status: string,
  updatedAt: Date,
  title = `Title of ${id}`,
): Promise<void> {
  const plan = {
    id,
    title,
    items: [],
    created_at: updatedAt.toISOString(),
    updated_at: updatedAt.toISOString(),
    status,
    completion_percentage: 100,
  };
  await fs.writeFile(path.join(plansDir(), `${id}.json`), JSON.stringify(plan, null, 2));
  const index = await fs.readFile(indexPath(), 'utf-8').then(
    (c) => JSON.parse(c) as Record<string, unknown>,
    () => ({}) as Record<string, unknown>,
  );
  index[id] = title;
  await writeIndex(index);
}

/** Daily file named with the real slug shape: YYYY-MM-DD-HHhMM-day-… */
async function writeDaily(date: Date, suffix = 'session'): Promise<string> {
  const name = `${utcDateStamp(date)}-10h00-someday-${suffix}.md`;
  await fs.writeFile(path.join(dailyDir(), name), '# stub\n');
  return name;
}

function insertLiveClaim(claimKey: string): void {
  db.prepare(`
    INSERT INTO file_claims (claim_key, file_path, agent_id, claimed_at, expires_at, heartbeat_seq, released_at)
    VALUES (?, ?, 'alice', strftime('%s','now'), strftime('%s','now') + 600, 0, NULL)
  `).run(claimKey, claimKey);
}

function releaseClaim(claimKey: string): void {
  db.prepare(`UPDATE file_claims SET released_at = strftime('%s','now') WHERE claim_key = ?`)
    .run(claimKey);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dokoro-archive-test-'));
  process.env['DOKORO_PATH'] = tmpDir;
  await fs.mkdir(dailyDir(), { recursive: true });
  await fs.mkdir(plansDir(), { recursive: true });

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

describe('archivePlan', () => {
  it('moves the plan file to archive/YYYY-MM/ and atomically marks the index entry', async () => {
    await writePlan('plan-a', 'completed', daysAgo(1), 'Plan A');

    const res = await mod.archivePlan('plan-a');

    const expectedRel = `archive/${monthDir(new Date())}/plan-a.json`;
    expect(res).toMatchObject({ ok: true, planId: 'plan-a', archivePath: expectedRel });
    // File moved out of the live dir into the month partition.
    await expect(fs.access(path.join(plansDir(), 'plan-a.json'))).rejects.toBeDefined();
    await expect(fs.access(path.join(plansDir(), expectedRel))).resolves.toBeUndefined();
    // Index entry KEPT and upgraded to archived metadata.
    const index = await readIndex();
    expect(index['plan-a']).toEqual({ title: 'Plan A', archived: true, archive_path: expectedRel });
    // Atomic write left no temp file behind.
    await expect(fs.access(`${indexPath()}.tmp`)).rejects.toBeDefined();
  });

  it('is idempotent: a second call is a success no-op', async () => {
    await writePlan('plan-a', 'completed', daysAgo(1));
    const first = await mod.archivePlan('plan-a');
    expect(first.ok).toBe(true);

    const second = await mod.archivePlan('plan-a');
    expect(second).toMatchObject({
      ok: true,
      alreadyArchived: true,
      archivePath: first.archivePath,
    });
    await expect(fs.access(path.join(plansDir(), first.archivePath!))).resolves.toBeUndefined();
  });

  it('repairs the index when the file was moved but the index write was lost (crash window)', async () => {
    await writePlan('plan-a', 'completed', daysAgo(1), 'Plan A');
    await mod.archivePlan('plan-a');
    // Simulate the crash: index still has the pre-archive (string) entry.
    await writeIndex({ 'plan-a': 'Plan A' });

    const res = await mod.archivePlan('plan-a');
    expect(res).toMatchObject({ ok: true, alreadyArchived: true });
    const index = await readIndex();
    expect(index['plan-a']).toMatchObject({ archived: true, archive_path: res.archivePath });
  });

  it('returns ok:false (not throw) for a plan that exists nowhere', async () => {
    const res = await mod.archivePlan('plan-missing');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/);
  });
});

describe('sweepWorkspace — daily files', () => {
  it('moves an old daily file into archive/daily/<ISO week of the FILE date>/', async () => {
    const fileDate = daysAgo(20);
    const name = await writeDaily(fileDate);

    const res = await mod.sweepWorkspace({ claimRoot: tmpDir });

    expect(res.ok).toBe(true);
    expect(res.movedDaily).toHaveLength(1);
    const dest = path.join(tmpDir, 'archive', 'daily', isoWeekDir(fileDate), name);
    expect(res.movedDaily[0]).toEqual({ from: path.join(dailyDir(), name), to: dest });
    await expect(fs.access(dest)).resolves.toBeUndefined();
    await expect(fs.access(path.join(dailyDir(), name))).rejects.toBeDefined();
  });

  it('protects the current ISO week even when age-eligible (olderThanDays: 0)', async () => {
    // A file dated TODAY is age-eligible with olderThanDays=0 (its UTC
    // midnight is in the past) but sits in the current ISO week.
    const name = await writeDaily(new Date());

    const res = await mod.sweepWorkspace({ olderThanDays: 0, claimRoot: tmpDir });

    expect(res.ok).toBe(true);
    expect(res.movedDaily).toHaveLength(0);
    await expect(fs.access(path.join(dailyDir(), name))).resolves.toBeUndefined();
  });

  it('skips files without a date prefix', async () => {
    await fs.writeFile(path.join(dailyDir(), 'notes-without-date.md'), '# stub\n');

    const res = await mod.sweepWorkspace({ olderThanDays: 0, claimRoot: tmpDir });

    expect(res.movedDaily).toHaveLength(0);
    await expect(fs.access(path.join(dailyDir(), 'notes-without-date.md'))).resolves.toBeUndefined();
  });

  it('skips a file with a live claim, then moves it once the claim is released', async () => {
    const name = await writeDaily(daysAgo(20));
    // Derive the claim key exactly as production does — the test must not
    // silently diverge from the sweep's key derivation.
    const normalized = normalizeClaimPath(path.join(dailyDir(), name), tmpDir);
    if (!normalized.ok) throw new Error(`claim path normalization failed: ${normalized.error}`);
    const claimKey = normalized.claimKey;
    insertLiveClaim(claimKey);

    const blocked = await mod.sweepWorkspace({ claimRoot: tmpDir });
    expect(blocked.ok).toBe(true);
    expect(blocked.movedDaily).toHaveLength(0);
    await expect(fs.access(path.join(dailyDir(), name))).resolves.toBeUndefined();

    releaseClaim(claimKey);
    const unblocked = await mod.sweepWorkspace({ claimRoot: tmpDir });
    expect(unblocked.movedDaily).toHaveLength(1);
    await expect(fs.access(path.join(dailyDir(), name))).rejects.toBeDefined();
  });
});

describe('sweepWorkspace — plans', () => {
  it('archives old completed/validated plans, leaves active and recent plans alone', async () => {
    await writePlan('plan-old-done', 'completed', daysAgo(40));
    await writePlan('plan-old-valid', 'validated', daysAgo(40));
    await writePlan('plan-old-active', 'active', daysAgo(40));
    await writePlan('plan-new-done', 'completed', daysAgo(2));

    const res = await mod.sweepWorkspace({ claimRoot: tmpDir });

    expect(res.ok).toBe(true);
    expect(res.archivedPlans.sort()).toEqual(['plan-old-done', 'plan-old-valid']);
    await expect(fs.access(path.join(plansDir(), 'plan-old-done.json'))).rejects.toBeDefined();
    await expect(fs.access(path.join(plansDir(), 'plan-old-active.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(plansDir(), 'plan-new-done.json'))).resolves.toBeUndefined();
    const index = await readIndex();
    expect(index['plan-old-done']).toMatchObject({ archived: true });
    expect(index['plan-old-active']).toBe('Title of plan-old-active');
  });
});

describe('sweepWorkspace — dryRun', () => {
  it('reports would-moves without changing anything and without writing status', async () => {
    const name = await writeDaily(daysAgo(20));
    await writePlan('plan-old-done', 'completed', daysAgo(40));

    const res = await mod.sweepWorkspace({ dryRun: true, claimRoot: tmpDir });

    expect(res.ok).toBe(true);
    expect(res.dryRun).toBe(true);
    expect(res.movedDaily).toHaveLength(1);
    expect(res.archivedPlans).toEqual(['plan-old-done']);
    // Nothing actually moved.
    await expect(fs.access(path.join(dailyDir(), name))).resolves.toBeUndefined();
    await expect(fs.access(path.join(plansDir(), 'plan-old-done.json'))).resolves.toBeUndefined();
    expect((await readIndex())['plan-old-done']).toBe('Title of plan-old-done');
    // No status written for dry runs.
    await expect(fs.access(statusPath())).rejects.toBeDefined();
  });
});

describe('sweepWorkspace — lock', () => {
  it('returns skipped:"locked" while a fresh lock is held, and leaves the lock alone', async () => {
    await fs.mkdir(path.dirname(lockPath()), { recursive: true });
    await fs.writeFile(
      lockPath(),
      JSON.stringify({ pid: 99999, started_at: new Date().toISOString() }),
    );

    const res = await mod.sweepWorkspace({ claimRoot: tmpDir });

    expect(res).toMatchObject({ ok: false, skipped: 'locked' });
    await expect(fs.access(lockPath())).resolves.toBeUndefined();
  });

  it('breaks a stale lock (started_at past the 5-minute TTL) and sweeps', async () => {
    const name = await writeDaily(daysAgo(20));
    await fs.mkdir(path.dirname(lockPath()), { recursive: true });
    await fs.writeFile(
      lockPath(),
      JSON.stringify({ pid: 99999, started_at: new Date(Date.now() - 10 * 60_000).toISOString() }),
    );

    const res = await mod.sweepWorkspace({ claimRoot: tmpDir });

    expect(res.ok).toBe(true);
    expect(res.movedDaily).toHaveLength(1);
    await expect(fs.access(path.join(dailyDir(), name))).rejects.toBeDefined();
    // Lock released in finally.
    await expect(fs.access(lockPath())).rejects.toBeDefined();
  });

  it('releases the lock even when the sweep hits per-file errors', async () => {
    await writeDaily(daysAgo(20));
    // Make archive/ a FILE so mkdir of archive/daily/<week>/ fails (ENOTDIR).
    await fs.writeFile(path.join(tmpDir, 'archive'), 'not a directory');

    const res = await mod.sweepWorkspace({ claimRoot: tmpDir });

    expect(res.errors).toHaveLength(1);
    await expect(fs.access(lockPath())).rejects.toBeDefined();
  });
});

describe('sweepWorkspace — archive-status.json', () => {
  it('records counts after a successful run', async () => {
    await writeDaily(daysAgo(20));
    await writePlan('plan-old-done', 'completed', daysAgo(40));

    await mod.sweepWorkspace({ claimRoot: tmpDir });

    const status = JSON.parse(await fs.readFile(statusPath(), 'utf-8')) as Record<string, unknown>;
    expect(status).toMatchObject({
      moved_daily: 1,
      archived_plans: 1,
      errors: [],
      last_error: null,
    });
    expect(typeof status['last_run']).toBe('string');
  });

  it('records per-file errors and last_error while the sweep continues', async () => {
    await writeDaily(daysAgo(20));
    await writePlan('plan-old-done', 'completed', daysAgo(40));
    // archive/ as a file breaks the daily move; the plan sweep still runs
    // (plans archive under .mcp/plans/archive/, a different tree).
    await fs.writeFile(path.join(tmpDir, 'archive'), 'not a directory');

    const res = await mod.sweepWorkspace({ claimRoot: tmpDir });

    expect(res.ok).toBe(true); // per-file errors do not fail the sweep
    expect(res.errors).toHaveLength(1);
    expect(res.archivedPlans).toEqual(['plan-old-done']);

    const status = JSON.parse(await fs.readFile(statusPath(), 'utf-8')) as {
      moved_daily: number; archived_plans: number;
      errors: Array<{ path: string; error: string }>; last_error: string | null;
    };
    expect(status.moved_daily).toBe(0);
    expect(status.archived_plans).toBe(1);
    expect(status.errors).toHaveLength(1);
    expect(status.errors[0].path).toContain('daily');
    expect(status.last_error).toBe(status.errors[0].error);
  });
});
