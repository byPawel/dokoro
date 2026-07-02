/**
 * Pure action layer for the `dokoro browse` TUI's gated mutations — NO ink
 * imports here, and every export NEVER throws (mirrors src/cli/browse-data.ts).
 * Two council-approved, safety-gated operations on the items level:
 *
 *  - releaseClaim: release a STALE advisory file claim. Fresh-read-before-write,
 *    then REFUSES ('holderLive') when the holder's presence heartbeat is within
 *    the liveness TTL AND the claim is still unexpired — no force option, the
 *    council explicitly rejected claim stealing. The release UPDATE's
 *    `released_at IS NULL` WHERE clause is the race guard.
 *  - planTransition: one legal plan status transition (draft→active,
 *    active→completed). Reads the plan JSON fresh; an optional `expectedStatus`
 *    aborts ('changed') when the on-disk status drifted since the confirm was
 *    armed, so a transition never fires from a state the user didn't see.
 *
 * All filesystem/DB paths resolve from the passed `dokoroPath` (NOT the
 * module-level DOKORO_PATH), so these run correctly under a `--path` override
 * with no extra guard needed. DB access mirrors browse-data.ts's tryDb: a
 * test-injected `globalThis.__TEST_DB__` handle wins, otherwise the project
 * database via getSqliteDb({ projectPath: dirname(dokoroPath), ... }).
 */

import { promises as fs } from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { getSqliteDb } from '../db/index.js';
import { writeFileAtomic } from '../utils/archive.js';

/** Presence liveness window — matches file-claim-tools / browse-data. */
const PRESENCE_TTL_SECONDS = 900;

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** DB handle: test-injected handle wins, else the project database. Mirrors browse-data.ts's tryDb. */
function tryDb(dokoroPath: string): Database.Database | null {
  const injected = (globalThis as Record<string, unknown>).__TEST_DB__ as Database.Database | undefined;
  if (injected) return injected;
  try {
    return getSqliteDb({
      projectPath: path.dirname(dokoroPath),
      dokoroFolder: path.basename(dokoroPath),
    });
  } catch {
    return null;
  }
}

/** Server clock in SQLite unixepoch seconds (single clock domain). */
function nowSeconds(sqlite: Database.Database): number {
  const row = sqlite.prepare(`SELECT strftime('%s','now') AS n`).get() as { n: string | number };
  return Number(row.n);
}

// ───────────────────────────────────────────────────────────────────────────
// Release a stale file claim
// ───────────────────────────────────────────────────────────────────────────

interface ClaimRow {
  claim_key: string;
  agent_id: string;
  expires_at: number;
  released_at: number | null;
}

export type ReleaseClaimOutcome =
  | 'released'
  | 'alreadyReleased'
  | 'holderLive'
  | 'missing'
  | 'dbUnavailable'
  | 'failed';

export interface ReleaseClaimResult {
  outcome: ReleaseClaimOutcome;
  /** The live holder's agent id — only set on 'holderLive'. */
  holder?: string;
  error?: string;
}

/**
 * Release a stale advisory file claim by its claim_key, behind a live-holder gate.
 *
 * Fresh-read-before-write: re-queries the row, then REFUSES ('holderLive') when
 * the holder's presence heartbeat is within PRESENCE_TTL_SECONDS AND the claim
 * is still unexpired — the council's no-claim-stealing rule, with no force
 * override. A stale/absent heartbeat, or an already-expired claim, is
 * releasable. The release UPDATE is guarded by `released_at IS NULL`, so a
 * concurrent release loses the race cleanly (reported 'alreadyReleased').
 */
export function releaseClaim(dokoroPath: string, claimKey: string): ReleaseClaimResult {
  const sqlite = tryDb(dokoroPath);
  if (sqlite === null) return { outcome: 'dbUnavailable' };
  try {
    const now = nowSeconds(sqlite);
    const row = sqlite.prepare(
      'SELECT claim_key, agent_id, expires_at, released_at FROM file_claims WHERE claim_key = ?',
    ).get(claimKey) as ClaimRow | undefined;
    if (row === undefined) return { outcome: 'missing' };
    if (row.released_at !== null) return { outcome: 'alreadyReleased' };

    // THE GATE: a demonstrably-live holder (heartbeat within TTL) of an
    // unexpired claim is protected. A missing presence row, a stale heartbeat,
    // or an expired claim means the holder is gone — the claim is releasable.
    const presence = sqlite.prepare('SELECT last_heartbeat FROM agent_presence WHERE agent_id = ?')
      .get(row.agent_id) as { last_heartbeat: number } | undefined;
    const holderLive = presence !== undefined
      && now - presence.last_heartbeat <= PRESENCE_TTL_SECONDS
      && row.expires_at > now;
    if (holderLive) return { outcome: 'holderLive', holder: row.agent_id };

    const info = sqlite.prepare(
      `UPDATE file_claims SET released_at = strftime('%s','now') WHERE claim_key = ? AND released_at IS NULL`,
    ).run(claimKey);
    // changes === 0: a concurrent writer released (or pruned) it between our
    // read and write — the file is no longer held either way.
    return info.changes === 1 ? { outcome: 'released' } : { outcome: 'alreadyReleased' };
  } catch (error: unknown) {
    return { outcome: 'failed', error: errMsg(error) };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Advance a plan one legal status step
// ───────────────────────────────────────────────────────────────────────────

/** Minimal plan JSON shape (mirrors src/tools/plan-tools.ts, kept loose). */
interface PlanJson {
  title?: string;
  status?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export type PlanTransitionOutcome =
  | 'transitioned'
  | 'noTransition'
  | 'changed'
  | 'missing'
  | 'failed';

export interface PlanTransitionResult {
  outcome: PlanTransitionOutcome;
  /** The applied transition — only set on 'transitioned'. */
  from?: string;
  to?: string;
  /** The status found on disk — only set on 'changed' (differs from expected). */
  actual?: string;
  error?: string;
}

/**
 * The single legal forward transition for a live plan status, or null when the
 * status has no manual next step (completed/validated/failed, or unknown).
 * Exported so the UI can compute the prompt at confirm-arm time from the same
 * rule the apply path uses.
 */
export function nextPlanStatus(status: string | null | undefined): string | null {
  if (status === 'draft') return 'active';
  if (status === 'active') return 'completed';
  return null;
}

/** Fresh status of a live plan JSON (for the confirm prompt), or null if unreadable. */
export async function readPlanStatus(dokoroPath: string, planId: string): Promise<string | null> {
  try {
    const planPath = path.join(dokoroPath, '.mcp', 'plans', `${planId}.json`);
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as PlanJson;
    return typeof plan.status === 'string' ? plan.status : null;
  } catch {
    return null;
  }
}

/**
 * Advance a live plan one legal status step (draft→active, active→completed),
 * writing the plan JSON atomically and mirroring plan-tools' index handling.
 *
 * Fresh-read-before-write: the plan JSON is re-read here. When `expectedStatus`
 * is passed (the status the UI displayed at confirm-arm time) and the on-disk
 * status no longer matches, the transition is ABORTED with 'changed' rather
 * than firing from a state the user didn't confirm. A missing plan file yields
 * 'missing'; a status with no legal next step yields 'noTransition'.
 */
export async function planTransition(
  dokoroPath: string,
  planId: string,
  expectedStatus?: string,
): Promise<PlanTransitionResult> {
  try {
    const plansDir = path.join(dokoroPath, '.mcp', 'plans');
    const planPath = path.join(plansDir, `${planId}.json`);

    let raw: string;
    try {
      raw = await fs.readFile(planPath, 'utf-8');
    } catch {
      return { outcome: 'missing' };
    }
    let plan: PlanJson;
    try {
      plan = JSON.parse(raw) as PlanJson;
    } catch (error: unknown) {
      return { outcome: 'failed', error: `plan JSON parse failed: ${errMsg(error)}` };
    }

    const current = typeof plan.status === 'string' ? plan.status : undefined;

    // Changed-underneath guard: the confirm was armed against expectedStatus;
    // if the on-disk status drifted, abort instead of transitioning blindly.
    if (expectedStatus !== undefined && current !== expectedStatus) {
      return { outcome: 'changed', actual: current ?? 'unknown' };
    }

    const to = nextPlanStatus(current);
    if (to === null) return { outcome: 'noTransition' };
    const from = current as string;

    plan.status = to;
    plan.updated_at = new Date().toISOString();
    await writeFileAtomic(planPath, JSON.stringify(plan, null, 2));

    // Mirror plan-tools' savePlan index handling: the live index maps
    // planId -> title (bare string). A transition doesn't change the title,
    // but rewriting the entry mirrors the tool and heals a missing entry.
    const indexPath = path.join(plansDir, 'index.json');
    let index: Record<string, unknown>;
    try {
      index = JSON.parse(await fs.readFile(indexPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      index = {};
    }
    index[planId] = plan.title ?? planId;
    await writeFileAtomic(indexPath, JSON.stringify(index, null, 2));

    return { outcome: 'transitioned', from, to };
  } catch (error: unknown) {
    return { outcome: 'failed', error: errMsg(error) };
  }
}
