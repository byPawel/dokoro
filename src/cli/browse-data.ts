/**
 * Pure data layer for the `dokoro browse` TUI — NO ink imports here.
 *
 * Lists workspace categories/items and reads item content from a dokoro
 * folder: `current.md`, `daily/`, `retrospective/weekly/`, the archives
 * (`archive/daily/<week>/`, `.mcp/plans/archive/<YYYY-MM>/`), live plans
 * (`.mcp/plans/*.json` + `index.json`), the SQLite coordination tables
 * (`file_claims`, `agent_presence`) and `.mcp/archive-status.json`.
 *
 * Every exported function is designed for direct UI consumption and NEVER
 * throws: missing dirs/files yield empty lists, unreadable content yields a
 * `(unable to read …)` string, and an unavailable database yields a single
 * `(database unavailable)` placeholder item instead of crashing.
 *
 * DB access mirrors the tool layer (src/tools/file-claim-tools.ts): a
 * test-injected `globalThis.__TEST_DB__` handle wins, otherwise the project
 * database is opened via getSqliteDb with projectPath = dirname(dokoroPath).
 */

import { promises as fs } from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { getSqliteDb } from '../db/index.js';
import type { PlansIndex, PlanIndexEntry } from '../utils/archive.js';

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type BrowseCategoryId =
  | 'current'
  | 'daily'
  | 'weekly'
  | 'archive'
  | 'plans'
  | 'claims'
  | 'agents'
  | 'sweep';

export interface BrowseCategory {
  id: BrowseCategoryId;
  label: string;
  count: number;
}

export interface BrowseItem {
  id: string;
  label: string;
  sublabel?: string;
  kind: 'file' | 'plan' | 'claim' | 'agent';
  /** Absolute path for file/plan items. */
  path?: string;
  archived?: boolean;
  /** Pre-rendered detail card for DB-backed items (claims / agents). */
  detail?: string;
}

/** Minimal plan JSON shape (mirrors src/tools/plan-tools.ts, kept loose). */
interface PlanItemJson {
  text?: string;
  completed?: boolean;
  notes?: string;
  blockers?: string[];
}

interface PlanJson {
  title?: string;
  description?: string;
  status?: string;
  completion_percentage?: number;
  created_at?: string;
  updated_at?: string;
  validation_notes?: string;
  items?: PlanItemJson[];
}

interface ClaimRow {
  claim_key: string;
  file_path: string;
  agent_id: string;
  session_id: string | null;
  intent: string | null;
  claimed_at: number;
  expires_at: number;
  heartbeat_seq: number;
  released_at: number | null;
}

interface PresenceRow {
  agent_id: string;
  session_id: string | null;
  status: string;
  current_focus: string | null;
  last_heartbeat: number;
  heartbeat_seq: number;
}

interface ArchiveStatusJson {
  last_run?: string;
  moved_daily?: number;
  archived_plans?: number;
  last_error?: string | null;
}

const CATEGORY_LABELS: Record<BrowseCategoryId, string> = {
  current: 'Current workspace',
  daily: 'Daily sessions',
  weekly: 'Weekly retrospectives',
  archive: 'Archive',
  plans: 'Plans',
  claims: 'File claims',
  agents: 'Agent presence',
  sweep: 'Archive sweep status',
};

/** Presence liveness window — matches dokoro_presence_list / claim tools. */
const PRESENCE_TTL_SECONDS = 900;

// ───────────────────────────────────────────────────────────────────────────
// Small helpers (all non-throwing)
// ───────────────────────────────────────────────────────────────────────────

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Markdown filenames in `dir`, sorted newest first (date-prefixed slugs). */
async function listMarkdownDesc(dir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(dir);
    return names.filter((n) => n.endsWith('.md')).sort().reverse();
  } catch {
    return [];
  }
}

async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/** Best-effort title for an index entry (live entries are bare strings). */
function entryTitle(entry: PlanIndexEntry | undefined, planId: string): string {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry.title === 'string') return entry.title;
  return planId;
}

function isoFromEpoch(seconds: number): string {
  try {
    return new Date(seconds * 1000).toISOString();
  } catch {
    return String(seconds);
  }
}

/** Compact human duration for non-negative second counts: 42s, 5m, 2h 10m. */
function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** DB handle: test-injected handle wins, else the project database. */
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

/** Holder liveness from agent_presence; any failure degrades to 'unknown'. */
function presenceLabel(sqlite: Database.Database, agentId: string, now: number): 'live' | 'stale' | 'unknown' {
  try {
    const row = sqlite.prepare('SELECT last_heartbeat FROM agent_presence WHERE agent_id = ?')
      .get(agentId) as { last_heartbeat: number } | undefined;
    if (!row) return 'unknown';
    return now - row.last_heartbeat <= PRESENCE_TTL_SECONDS ? 'live' : 'stale';
  } catch {
    return 'unknown';
  }
}

function dbUnavailableItem(kind: 'claim' | 'agent'): BrowseItem {
  return { id: `${kind}s-db-unavailable`, label: '(database unavailable)', kind };
}

// ───────────────────────────────────────────────────────────────────────────
// Categories
// ───────────────────────────────────────────────────────────────────────────

/** All browse categories with their item counts. Missing dirs count 0. */
export async function listCategories(dokoroPath: string): Promise<BrowseCategory[]> {
  const ids = Object.keys(CATEGORY_LABELS) as BrowseCategoryId[];
  return Promise.all(ids.map(async (id): Promise<BrowseCategory> => {
    const items = await listItems(dokoroPath, id);
    return { id, label: CATEGORY_LABELS[id], count: items.length };
  }));
}

// ───────────────────────────────────────────────────────────────────────────
// Items
// ───────────────────────────────────────────────────────────────────────────

/** Items for one category. Never throws — failures yield an empty list. */
export async function listItems(dokoroPath: string, category: BrowseCategoryId): Promise<BrowseItem[]> {
  try {
    switch (category) {
      case 'current': return await currentItems(dokoroPath);
      case 'daily': return await markdownItems(path.join(dokoroPath, 'daily'), 'daily');
      case 'weekly': return await markdownItems(path.join(dokoroPath, 'retrospective', 'weekly'), 'weekly');
      case 'archive': return await archiveItems(dokoroPath);
      case 'plans': return await planItems(dokoroPath);
      case 'claims': return claimItems(dokoroPath);
      case 'agents': return agentItems(dokoroPath);
      case 'sweep': return await sweepItems(dokoroPath);
    }
  } catch {
    return [];
  }
}

async function currentItems(dokoroPath: string): Promise<BrowseItem[]> {
  const filePath = path.join(dokoroPath, 'current.md');
  try {
    const st = await fs.stat(filePath);
    return [{
      id: 'current.md',
      label: 'current.md',
      sublabel: `updated ${st.mtime.toISOString()}`,
      kind: 'file',
      path: filePath,
    }];
  } catch {
    return [];
  }
}

async function markdownItems(dir: string, idPrefix: string): Promise<BrowseItem[]> {
  const names = await listMarkdownDesc(dir);
  return names.map((name) => ({
    id: `${idPrefix}/${name}`,
    label: name,
    kind: 'file' as const,
    path: path.join(dir, name),
  }));
}

async function archiveItems(dokoroPath: string): Promise<BrowseItem[]> {
  const items: BrowseItem[] = [];

  const dailyArchive = path.join(dokoroPath, 'archive', 'daily');
  for (const week of await listSubdirs(dailyArchive)) {
    for (const name of await listMarkdownDesc(path.join(dailyArchive, week))) {
      items.push({
        id: `archive/daily/${week}/${name}`,
        label: name,
        sublabel: `daily · ${week}`,
        kind: 'file',
        path: path.join(dailyArchive, week, name),
        archived: true,
      });
    }
  }

  const planArchive = path.join(dokoroPath, '.mcp', 'plans', 'archive');
  for (const month of await listSubdirs(planArchive)) {
    let names: string[] = [];
    try {
      names = (await fs.readdir(path.join(planArchive, month))).filter((n) => n.endsWith('.json')).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      items.push({
        id: `plans/archive/${month}/${name}`,
        label: name,
        sublabel: `plan · ${month}`,
        kind: 'plan',
        path: path.join(planArchive, month, name),
        archived: true,
      });
    }
  }

  // Filenames are date-prefixed (daily slugs / plan ids) — newest first.
  items.sort((a, b) => b.label.localeCompare(a.label));
  return items;
}

async function planItems(dokoroPath: string): Promise<BrowseItem[]> {
  const plansDir = path.join(dokoroPath, '.mcp', 'plans');
  const index = (await readJsonFile<PlansIndex>(path.join(plansDir, 'index.json'))) ?? {};

  const live: Array<{ item: BrowseItem; updatedMs: number }> = [];
  const archived: BrowseItem[] = [];

  for (const [planId, entry] of Object.entries(index)) {
    if (typeof entry === 'object' && entry !== null && entry.archived === true) {
      archived.push({
        id: planId,
        label: entryTitle(entry, planId),
        sublabel: '[archived]',
        kind: 'plan',
        path: typeof entry.archive_path === 'string' ? path.join(plansDir, entry.archive_path) : undefined,
        archived: true,
      });
      continue;
    }

    const planPath = path.join(plansDir, `${planId}.json`);
    const plan = await readJsonFile<PlanJson>(planPath);
    if (plan === null) {
      live.push({
        item: { id: planId, label: entryTitle(entry, planId), sublabel: '[missing plan file]', kind: 'plan', path: planPath },
        updatedMs: 0,
      });
      continue;
    }

    const total = plan.items?.length ?? 0;
    const done = plan.items?.filter((i) => i.completed === true).length ?? 0;
    const updatedMs = Date.parse(plan.updated_at ?? plan.created_at ?? '');
    live.push({
      item: {
        id: planId,
        label: plan.title ?? entryTitle(entry, planId),
        sublabel: `[${plan.status ?? 'unknown'}] ${done}/${total} items`,
        kind: 'plan',
        path: planPath,
      },
      updatedMs: Number.isNaN(updatedMs) ? 0 : updatedMs,
    });
  }

  live.sort((a, b) => b.updatedMs - a.updatedMs);
  // Newest first by label, matching the archive category's sort direction.
  archived.sort((a, b) => b.label.localeCompare(a.label));
  return [...live.map((l) => l.item), ...archived];
}

function claimItems(dokoroPath: string): BrowseItem[] {
  const sqlite = tryDb(dokoroPath);
  if (sqlite === null) return [dbUnavailableItem('claim')];
  try {
    const now = nowSeconds(sqlite);
    const rows = sqlite.prepare(
      `SELECT claim_key, file_path, agent_id, session_id, intent,
              claimed_at, expires_at, heartbeat_seq, released_at
       FROM file_claims
       WHERE released_at IS NULL AND expires_at > strftime('%s','now')
       ORDER BY expires_at ASC`,
    ).all() as ClaimRow[];

    return rows.map((row) => {
      const liveness = presenceLabel(sqlite, row.agent_id, now);
      const expiresIn = formatDuration(row.expires_at - now);
      const detail = [
        'File claim',
        '──────────',
        `File:      ${row.file_path}`,
        `Claim key: ${row.claim_key}`,
        `Owner:     ${row.agent_id} (holder ${liveness})`,
        `Session:   ${row.session_id ?? '-'}`,
        `Intent:    ${row.intent ?? '-'}`,
        `Claimed:   ${isoFromEpoch(row.claimed_at)}`,
        `Expires:   in ${expiresIn} (${isoFromEpoch(row.expires_at)})`,
        `Renewals:  ${row.heartbeat_seq}`,
      ].join('\n');
      return {
        id: row.claim_key,
        label: row.file_path,
        sublabel: `owner ${row.agent_id} · expires in ${expiresIn} · holder ${liveness}`,
        kind: 'claim' as const,
        detail,
      };
    });
  } catch {
    return [dbUnavailableItem('claim')];
  }
}

function agentItems(dokoroPath: string): BrowseItem[] {
  const sqlite = tryDb(dokoroPath);
  if (sqlite === null) return [dbUnavailableItem('agent')];
  try {
    const now = nowSeconds(sqlite);
    const rows = sqlite.prepare(
      `SELECT agent_id, session_id, status, current_focus, last_heartbeat, heartbeat_seq
       FROM agent_presence
       ORDER BY last_heartbeat DESC`,
    ).all() as PresenceRow[];

    return rows.map((row) => {
      const age = formatDuration(now - row.last_heartbeat);
      const liveness = now - row.last_heartbeat <= PRESENCE_TTL_SECONDS ? 'live' : 'stale';
      const detail = [
        'Agent presence',
        '──────────────',
        `Agent:     ${row.agent_id}`,
        `Status:    ${row.status} (${liveness})`,
        `Focus:     ${row.current_focus ?? '-'}`,
        `Session:   ${row.session_id ?? '-'}`,
        `Last seen: ${age} ago (${isoFromEpoch(row.last_heartbeat)})`,
        `Beats:     ${row.heartbeat_seq}`,
      ].join('\n');
      return {
        id: row.agent_id,
        label: row.agent_id,
        sublabel: `${row.status} · ${row.current_focus ?? 'no focus'} · seen ${age} ago`,
        kind: 'agent' as const,
        detail,
      };
    });
  } catch {
    return [dbUnavailableItem('agent')];
  }
}

async function sweepItems(dokoroPath: string): Promise<BrowseItem[]> {
  const filePath = path.join(dokoroPath, '.mcp', 'archive-status.json');
  const status = await readJsonFile<ArchiveStatusJson>(filePath);
  if (status === null) return [];
  const errorBadge = status.last_error ? ' · last error!' : '';
  return [{
    id: 'archive-status.json',
    label: 'archive-status.json',
    sublabel: `last run ${status.last_run ?? 'unknown'} · moved ${status.moved_daily ?? 0} · archived ${status.archived_plans ?? 0}${errorBadge}`,
    kind: 'file',
    path: filePath,
  }];
}

// ───────────────────────────────────────────────────────────────────────────
// Content
// ───────────────────────────────────────────────────────────────────────────

/**
 * Content for one item: markdown/raw file text, a rendered plan card with a
 * ☐/☑ checklist for plans, or the pre-built detail card for claims/agents.
 * Never throws — unreadable content comes back as a `(unable to read …)` line.
 */
export async function readItemContent(item: BrowseItem): Promise<string> {
  // Defensive: the UI guards against opening on an empty list, but a missing
  // item must still degrade to a string, never a rejection.
  if (item === undefined || item === null) return '(nothing selected)';
  try {
    if (item.detail !== undefined) return item.detail;
    if (item.path === undefined) {
      return item.sublabel !== undefined ? `${item.label}\n${item.sublabel}` : item.label;
    }
    const raw = await fs.readFile(item.path, 'utf-8');
    if (item.kind === 'plan') return renderPlanContent(raw);
    return raw;
  } catch (error: unknown) {
    return `(unable to read ${item.path ?? item.id}: ${errMsg(error)})`;
  }
}

/** Pretty card for a plan JSON; falls back to the raw text if it won't parse. */
function renderPlanContent(raw: string): string {
  let plan: PlanJson;
  try {
    plan = JSON.parse(raw) as PlanJson;
  } catch {
    return raw;
  }

  const title = plan.title ?? '(untitled plan)';
  const lines: string[] = [title, '═'.repeat(Math.min(60, Math.max(8, title.length)))];
  lines.push(`Status:     ${plan.status ?? 'unknown'}`);
  if (typeof plan.completion_percentage === 'number') {
    lines.push(`Completion: ${plan.completion_percentage}%`);
  }
  if (plan.created_at !== undefined) lines.push(`Created:    ${plan.created_at}`);
  if (plan.updated_at !== undefined) lines.push(`Updated:    ${plan.updated_at}`);
  if (plan.description !== undefined && plan.description !== '') {
    lines.push('', plan.description);
  }

  const items = plan.items ?? [];
  const done = items.filter((i) => i.completed === true).length;
  lines.push('', `Checklist (${done}/${items.length}):`);
  for (const it of items) {
    lines.push(`  ${it.completed === true ? '☑' : '☐'} ${it.text ?? ''}`);
    if (it.notes !== undefined && it.notes !== '') lines.push(`      notes: ${it.notes}`);
    if (it.blockers !== undefined && it.blockers.length > 0) {
      lines.push(`      blockers: ${it.blockers.join(', ')}`);
    }
  }
  if (plan.validation_notes !== undefined && plan.validation_notes !== '') {
    lines.push('', `Validation: ${plan.validation_notes}`);
  }
  return lines.join('\n');
}
