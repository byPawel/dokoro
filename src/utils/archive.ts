/**
 * Crash-safe archive utilities: plan archiving + conservative workspace sweep.
 *
 * `archivePlan` moves a finished plan JSON out of `.mcp/plans/` into a
 * month-partitioned archive (`.mcp/plans/archive/YYYY-MM/`) and marks the
 * plans index entry as archived (entry is KEPT for discoverability). The
 * index write is temp-file + atomic rename, and the move happens BEFORE the
 * index update so a crash in between is healed by re-running (the plan is
 * found in the archive and the index is repaired).
 *
 * `sweepWorkspace` is a singleton background sweep (O_EXCL `.mcp/archive.lock`,
 * 5-minute TTL) that:
 *  - moves stale `daily/*.md` files into `archive/daily/<ISO week>/`, but
 *    NEVER touches the current ISO week (those are `dokoro_compress_week`
 *    inputs) and NEVER touches files with a live advisory file_claim;
 *  - archives `completed`/`validated` plans older than a threshold.
 *
 * NOTE on week naming: sweep directories use `isoWeekDir()` (ISO week-YEAR,
 * e.g. Dec 29 can land in next year's W01) because sweep output dirs are new.
 * `dokoro_compress_week` keeps its legacy CALENDAR-year `weekDirName()` for
 * existing archive stability — the two can differ around year boundaries.
 *
 * Index-entry shape: the live index maps planId -> title (string). Archived
 * entries are upgraded to `{ title, archived: true, archive_path }`. Plan
 * tools only enumerate `Object.keys(index)` and load plan files for display,
 * so object values are safe. Index entries carry NO timestamp — plan age is
 * read from the plan file's `updated_at` (then `created_at`, then file mtime).
 *
 * All functions are designed to be called from tool handlers and hooks: they
 * NEVER throw — failures come back as `{ ok: false, error }`.
 */

import { promises as fs } from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { DOKORO_PATH } from '../shared/dokoro-utils.js';
import { getSqliteDb } from '../db/index.js';
import { normalizeClaimPath } from './claim-path.js';
import { isoWeekDir, monthDir } from './timestamp.js';

const PLANS_DIR = path.join(DOKORO_PATH, '.mcp', 'plans');
const PLANS_INDEX = path.join(PLANS_DIR, 'index.json');
const PLANS_ARCHIVE_DIR = path.join(PLANS_DIR, 'archive');
const DAILY_DIR = path.join(DOKORO_PATH, 'daily');
const DAILY_ARCHIVE_DIR = path.join(DOKORO_PATH, 'archive', 'daily');
const SWEEP_LOCK = path.join(DOKORO_PATH, '.mcp', 'archive.lock');
const STATUS_FILE = path.join(DOKORO_PATH, '.mcp', 'archive-status.json');

/** Sweep lock TTL: a lock older than this is considered crashed and broken. */
const SWEEP_LOCK_TTL_MS = 5 * 60 * 1000;
const MS_PER_DAY = 86_400_000;

/** Live index entry is a bare title; archived entries carry metadata. */
export type PlanIndexEntry =
  | string
  | { title?: string; archived?: boolean; archive_path?: string };
export type PlansIndex = Record<string, PlanIndexEntry>;

/** Result of archiving a single plan. Never thrown — always returned. */
export interface ArchiveResult {
  ok: boolean;
  planId: string;
  /** Path relative to `.mcp/plans/`, e.g. `archive/2026-06/plan-x.json`. */
  archivePath?: string;
  /** True when the plan was already archived (no-op success). */
  alreadyArchived?: boolean;
  error?: string;
}

export interface SweepMove {
  from: string;
  to: string;
}

export interface SweepFileError {
  path: string;
  error: string;
}

/** Result of a workspace sweep. Per-file errors do NOT fail the sweep. */
export interface SweepResult {
  ok: boolean;
  /** Set when another sweep holds the lock — not an error. */
  skipped?: 'locked';
  dryRun: boolean;
  /** Daily files moved (or that WOULD move in dryRun). Absolute paths. */
  movedDaily: SweepMove[];
  /** Plan ids archived (or that WOULD be archived in dryRun). */
  archivedPlans: string[];
  /** Per-file failures; the sweep continued past each. */
  errors: SweepFileError[];
  /** Top-level failure (lock machinery, unexpected I/O), if any. */
  error?: string;
}

export interface SweepOptions {
  /** Daily files older than this many days are eligible. Default 7. */
  olderThanDays?: number;
  /** Completed/validated plans older than this many days are archived. Default 30. */
  planOlderThanDays?: number;
  /** Report what would move without changing anything. Default false. */
  dryRun?: boolean;
  /**
   * Workspace root that file_claims keys are relative to. Defaults to the
   * server process cwd (same default as the claim tools) — override when the
   * MCP server's cwd differs from the worktree.
   */
  claimRoot?: string;
}

interface SweepLockPayload {
  pid: number;
  started_at: string;
}

interface ArchiveStatus {
  last_run: string;
  moved_daily: number;
  archived_plans: number;
  errors: SweepFileError[];
  last_error: string | null;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Write `content` to `filePath` via temp file + atomic rename. */
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, content, 'utf-8');
  await fs.rename(tmpPath, filePath);
}

/**
 * Move a file, creating the destination directory. Uses fs.rename with a
 * copy+unlink fallback for cross-device (EXDEV) moves.
 */
async function moveFile(src: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.rename(src, dest);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await fs.copyFile(src, dest);
    await fs.unlink(src);
  }
}

async function loadIndex(): Promise<PlansIndex> {
  try {
    const content = await fs.readFile(PLANS_INDEX, 'utf-8');
    return JSON.parse(content) as PlansIndex;
  } catch {
    return {};
  }
}

async function saveIndexAtomic(index: PlansIndex): Promise<void> {
  await fs.mkdir(PLANS_DIR, { recursive: true });
  await writeFileAtomic(PLANS_INDEX, JSON.stringify(index, null, 2));
}

/** Best-effort title for an index entry (live entries are bare title strings). */
function entryTitle(entry: PlanIndexEntry | undefined, planId: string): string {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry.title === 'string') return entry.title;
  return planId;
}

/**
 * Locate an already-archived plan file by scanning the month partitions.
 * Heals the crash window where the file moved but the index write was lost.
 */
async function findInArchive(planId: string): Promise<string | null> {
  let entries: Array<{ name: string; isDirectory(): boolean }> = [];
  try {
    entries = await fs.readdir(PLANS_ARCHIVE_DIR, { withFileTypes: true });
  } catch {
    return null; // no archive directory yet
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await fileExists(path.join(PLANS_ARCHIVE_DIR, entry.name, `${planId}.json`))) {
      return path.posix.join('archive', entry.name, `${planId}.json`);
    }
  }
  return null;
}

/**
 * Move a plan's JSON file into `.mcp/plans/archive/<YYYY-MM>/` and mark its
 * index entry archived (entry kept for discoverability; write is atomic).
 *
 * Idempotent: an already-archived plan is a success no-op; a plan whose file
 * was moved by a crashed run gets its index repaired. A plan that exists
 * nowhere returns `{ ok: false, error }` — never throws.
 */
export async function archivePlan(planId: string): Promise<ArchiveResult> {
  try {
    const livePath = path.join(PLANS_DIR, `${planId}.json`);
    const index = await loadIndex();
    const entry = index[planId];

    // Already archived per the index, and the file is really there: no-op.
    if (
      entry !== undefined &&
      typeof entry === 'object' &&
      entry.archived === true &&
      typeof entry.archive_path === 'string' &&
      (await fileExists(path.join(PLANS_DIR, entry.archive_path)))
    ) {
      return { ok: true, planId, archivePath: entry.archive_path, alreadyArchived: true };
    }

    if (await fileExists(livePath)) {
      const relArchivePath = path.posix.join('archive', monthDir(new Date()), `${planId}.json`);
      // Move FIRST, index second: a crash in between leaves the file safely
      // in the archive, and the next call repairs the index (branch below).
      await moveFile(livePath, path.join(PLANS_DIR, relArchivePath));
      index[planId] = { title: entryTitle(entry, planId), archived: true, archive_path: relArchivePath };
      await saveIndexAtomic(index);
      return { ok: true, planId, archivePath: relArchivePath };
    }

    // Live file missing — maybe a previous run moved it and crashed before
    // the index write. Scan the archive partitions and repair the index.
    const foundPath = await findInArchive(planId);
    if (foundPath !== null) {
      index[planId] = { title: entryTitle(entry, planId), archived: true, archive_path: foundPath };
      await saveIndexAtomic(index);
      return { ok: true, planId, archivePath: foundPath, alreadyArchived: true };
    }

    return {
      ok: false,
      planId,
      error: `plan file not found: ${planId}.json (neither live in .mcp/plans/ nor in .mcp/plans/archive/)`,
    };
  } catch (error: unknown) {
    return { ok: false, planId, error: `archivePlan failed: ${errMsg(error)}` };
  }
}

/** O_EXCL exclusive create (same pattern as lock-manager). False on EEXIST. */
async function tryExclusiveCreate(payload: string): Promise<boolean> {
  try {
    const fh = await fs.open(SWEEP_LOCK, 'wx'); // O_WRONLY | O_CREAT | O_EXCL
    try {
      await fh.writeFile(payload, 'utf-8');
    } finally {
      await fh.close();
    }
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Acquire the singleton sweep lock. A held lock older than the 5-minute TTL
 * (or unreadable/corrupt) is treated as a crashed sweep: it is removed and
 * the exclusive create retried ONCE. Returns false when the lock is held and
 * fresh — the caller reports `skipped: 'locked'`.
 */
async function acquireSweepLock(): Promise<boolean> {
  await fs.mkdir(path.dirname(SWEEP_LOCK), { recursive: true });
  const payload = JSON.stringify(
    { pid: process.pid, started_at: new Date().toISOString() } satisfies SweepLockPayload,
    null,
    2,
  );

  if (await tryExclusiveCreate(payload)) return true;

  // Lock exists. Stale (crashed sweep) or fresh (running sweep)?
  let stale: boolean;
  try {
    const lock = JSON.parse(await fs.readFile(SWEEP_LOCK, 'utf-8')) as SweepLockPayload;
    const startedAt = new Date(lock.started_at).getTime();
    // NaN startedAt (malformed timestamp) is treated as stale.
    stale = !(Date.now() - startedAt <= SWEEP_LOCK_TTL_MS);
  } catch {
    // Unreadable/corrupt lock — or it was released between our create attempt
    // and the read. Either way: try to break it once.
    stale = true;
  }
  if (!stale) return false;

  await fs.unlink(SWEEP_LOCK).catch(() => {
    // Another sweep may have beaten us to the unlink; the retry decides.
  });
  return tryExclusiveCreate(payload);
}

async function releaseSweepLock(): Promise<void> {
  await fs.unlink(SWEEP_LOCK).catch(() => {
    // Already gone (or never ours) — nothing to do.
  });
}

/** file_claims DB handle: test-injected handle wins, else the project DB. */
function claimDb(): Database.Database {
  const injected = (globalThis as Record<string, unknown>).__TEST_DB__ as Database.Database | undefined;
  if (injected) return injected;
  return getSqliteDb({ projectPath: path.dirname(DOKORO_PATH), dokoroFolder: path.basename(DOKORO_PATH) });
}

/** True when an open, unexpired advisory claim exists for the claim key. */
function hasLiveClaim(sqlite: Database.Database, claimKey: string): boolean {
  const row = sqlite
    .prepare(
      `SELECT 1 AS x FROM file_claims
       WHERE claim_key = ? AND released_at IS NULL AND expires_at > strftime('%s','now')`,
    )
    .get(claimKey);
  return row !== undefined;
}

/** Best-effort atomic status write — never throws (observability only). */
async function writeStatusSafe(status: ArchiveStatus): Promise<void> {
  try {
    await fs.mkdir(path.dirname(STATUS_FILE), { recursive: true });
    await writeFileAtomic(STATUS_FILE, JSON.stringify(status, null, 2));
  } catch {
    // Status is observability, not correctness — swallow.
  }
}

/**
 * Conservative workspace sweep (singleton via `.mcp/archive.lock`):
 *
 *  - Daily: `daily/*.md` with a valid `YYYY-MM-DD` filename prefix (UTC),
 *    older than `olderThanDays`, NOT in the current ISO week, and with NO
 *    live file_claim, move to `archive/daily/<isoWeekDir(fileDate)>/`.
 *  - Plans: index entries not yet archived whose plan file has status
 *    `completed`/`validated` and is older than `planOlderThanDays`
 *    (plan `updated_at`, falling back to `created_at`, then file mtime).
 *
 * Crash-tolerant: files are processed one by one; a failure is recorded in
 * `errors` and the sweep continues (re-runs resume naturally — moved files
 * are simply gone). Writes `.mcp/archive-status.json` after every non-dry
 * run. Never throws.
 */
export async function sweepWorkspace(opts: SweepOptions = {}): Promise<SweepResult> {
  const olderThanDays = opts.olderThanDays ?? 7;
  const planOlderThanDays = opts.planOlderThanDays ?? 30;
  const dryRun = opts.dryRun ?? false;
  const claimRoot = opts.claimRoot ?? process.cwd();

  const result: SweepResult = { ok: true, dryRun, movedDaily: [], archivedPlans: [], errors: [] };
  const now = new Date();

  let locked = false;
  try {
    locked = await acquireSweepLock();
  } catch (error: unknown) {
    result.ok = false;
    result.error = `failed to acquire sweep lock: ${errMsg(error)}`;
    if (!dryRun) {
      await writeStatusSafe({
        last_run: now.toISOString(),
        moved_daily: 0,
        archived_plans: 0,
        errors: [],
        last_error: result.error,
      });
    }
    return result;
  }
  if (!locked) {
    return { ...result, ok: false, skipped: 'locked' };
  }

  try {
    await sweepDailyFiles(result, now, olderThanDays, claimRoot, dryRun);
    await sweepPlans(result, now, planOlderThanDays, dryRun);
  } catch (error: unknown) {
    // Defensive: per-file errors are caught below; this is unexpected I/O.
    result.ok = false;
    result.error = `sweep failed: ${errMsg(error)}`;
  } finally {
    await releaseSweepLock();
  }

  if (!dryRun) {
    await writeStatusSafe({
      last_run: now.toISOString(),
      moved_daily: result.movedDaily.length,
      archived_plans: result.archivedPlans.length,
      errors: result.errors,
      last_error:
        result.error ??
        (result.errors.length > 0 ? result.errors[result.errors.length - 1].error : null),
    });
  }
  return result;
}

/** Daily-file half of the sweep. Mutates `result`; records per-file errors. */
async function sweepDailyFiles(
  result: SweepResult,
  now: Date,
  olderThanDays: number,
  claimRoot: string,
  dryRun: boolean,
): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(DAILY_DIR);
  } catch {
    return; // no daily/ directory — nothing to sweep
  }

  const currentWeek = isoWeekDir(now);
  const cutoffMs = now.getTime() - olderThanDays * MS_PER_DAY;
  let sqlite: Database.Database | null = null;
  let dbError: string | null = null;

  for (const name of names.filter((n) => n.endsWith('.md')).sort()) {
    const match = name.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!match) continue; // no date prefix — never touched

    // Parse the prefix as a UTC calendar date; roll-over dates (e.g. month 13)
    // fail strict ISO parsing and the file is skipped.
    const fileDate = new Date(`${match[1]}T00:00:00Z`);
    if (Number.isNaN(fileDate.getTime())) continue;
    if (fileDate.getTime() >= cutoffMs) continue; // not old enough
    // NEVER sweep the current ISO week — those are compress_week's inputs.
    if (isoWeekDir(fileDate) === currentWeek) continue;

    const absPath = path.join(DAILY_DIR, name);

    // Skip files with a live advisory claim. Claim keys are workspace-relative
    // (root = server cwd by default); a file outside the root has no possible
    // claim key and is treated as unclaimed.
    const normalized = normalizeClaimPath(absPath, claimRoot);
    if (normalized.ok) {
      try {
        sqlite ??= claimDb();
        if (hasLiveClaim(sqlite, normalized.claimKey)) continue;
      } catch (error: unknown) {
        // Can't verify claims — be conservative: leave the file, surface why.
        dbError ??= errMsg(error);
        result.errors.push({ path: absPath, error: `claim check unavailable: ${dbError}` });
        continue;
      }
    }

    const destPath = path.join(DAILY_ARCHIVE_DIR, isoWeekDir(fileDate), name);
    if (dryRun) {
      result.movedDaily.push({ from: absPath, to: destPath });
      continue;
    }
    try {
      await moveFile(absPath, destPath);
      result.movedDaily.push({ from: absPath, to: destPath });
    } catch (error: unknown) {
      result.errors.push({ path: absPath, error: errMsg(error) });
    }
  }
}

/** Plan half of the sweep. Mutates `result`; records per-plan errors. */
async function sweepPlans(
  result: SweepResult,
  now: Date,
  planOlderThanDays: number,
  dryRun: boolean,
): Promise<void> {
  const index = await loadIndex();
  const cutoffMs = now.getTime() - planOlderThanDays * MS_PER_DAY;

  for (const [planId, entry] of Object.entries(index)) {
    if (typeof entry === 'object' && entry !== null && entry.archived === true) continue;

    const planPath = path.join(PLANS_DIR, `${planId}.json`);
    let plan: { status?: string; updated_at?: string; created_at?: string };
    try {
      plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as typeof plan;
    } catch {
      continue; // live file missing or unreadable — nothing to sweep
    }
    if (plan.status !== 'completed' && plan.status !== 'validated') continue;

    // Index entries carry no timestamp (planId -> title), so age comes from
    // the plan file: updated_at, then created_at, then file mtime.
    let timestampMs = Date.parse(plan.updated_at ?? '');
    if (Number.isNaN(timestampMs)) timestampMs = Date.parse(plan.created_at ?? '');
    if (Number.isNaN(timestampMs)) {
      try {
        timestampMs = (await fs.stat(planPath)).mtimeMs;
      } catch {
        continue;
      }
    }
    if (timestampMs >= cutoffMs) continue; // too recent

    if (dryRun) {
      result.archivedPlans.push(planId);
      continue;
    }
    const archived = await archivePlan(planId);
    if (archived.ok) {
      result.archivedPlans.push(planId);
    } else {
      result.errors.push({ path: planPath, error: archived.error ?? 'archivePlan failed' });
    }
  }
}
