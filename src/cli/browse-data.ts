/**
 * Pure data layer for the `dokoro browse` TUI — NO ink imports here.
 *
 * Lists workspace categories/items and reads item content from a dokoro
 * folder: `current.md`, `daily/`, `retrospective/weekly/`, the archives
 * (`archive/daily/<week>/`, `.mcp/plans/archive/<YYYY-MM>/`), live plans
 * (`.mcp/plans/*.json` + `index.json`), the SQLite coordination tables
 * (`file_claims`, `agent_presence`), the Working-memory question queue
 * (`.mcp/questions.json`), the Affective feedback table (`agent_feedback`)
 * and `.mcp/archive-status.json`.
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
  | 'questions'
  | 'feedback'
  | 'entities'
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
  kind: 'file' | 'plan' | 'claim' | 'agent' | 'question' | 'feedback' | 'entity';
  /** Absolute path for file/plan items. */
  path?: string;
  archived?: boolean;
  /** Pre-rendered detail card for non-file items (claims/agents/questions/feedback). */
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

/** One entry in `.mcp/questions.json` (mirrors src/tools/question-tools.ts). */
interface QuestionJson {
  id: string;
  question: string;
  context?: string;
  created_at: string;
  answered_at?: string;
  answer?: string;
  status: 'open' | 'answered';
  priority: 'low' | 'medium' | 'high' | 'blocker';
}

interface FeedbackRow {
  id: number;
  agent_id: string;
  tool_name: string;
  outcome: string;
  confidence: number | null;
  latency_ms: number | null;
  error_message: string | null;
  doc_id: string | null;
  session_id: string | null;
  metadata_json: string | null;
  recorded_at: string;
  age_seconds: number;
}

const CATEGORY_LABELS: Record<BrowseCategoryId, string> = {
  current: 'Current workspace',
  daily: 'Daily sessions',
  weekly: 'Weekly retrospectives',
  archive: 'Archive',
  plans: 'Plans',
  claims: 'File claims',
  agents: 'Agent presence',
  questions: 'Questions',
  feedback: 'Feedback',
  entities: 'Entities',
  sweep: 'Archive sweep status',
};

/** Validate a raw CLI/user category string against the known ids. */
export function resolveCategoryId(input: string): BrowseCategoryId | null {
  const key = input.trim().toLowerCase();
  const ids = Object.keys(CATEGORY_LABELS) as BrowseCategoryId[];
  return ids.includes(key as BrowseCategoryId) ? (key as BrowseCategoryId) : null;
}

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

/** Age of an ISO/parseable timestamp as a compact duration; 'unknown' if unparseable. */
function ageLabel(when: string): string {
  const ms = Date.now() - Date.parse(when);
  return Number.isNaN(ms) ? 'unknown' : formatDuration(ms / 1000);
}

/** Single-line, whitespace-collapsed preview of `text`, ellipsised at `max`. */
function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
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

/** SQLite per-connection change counter — bumps when ANOTHER connection commits
 * a write. Lets the poll skip re-querying claims/agents when nothing changed. */
export function dbDataVersion(db: Database.Database): number {
  const row = db.prepare('PRAGMA data_version').get() as { data_version: number };
  return row.data_version;
}

interface DbListCache {
  version: number;
  items: BrowseItem[];
}
const claimsCache: { value: DbListCache | null } = { value: null };
const agentsCache: { value: DbListCache | null } = { value: null };

/**
 * Bust the claims/agents poll caches. PRAGMA data_version never changes for a
 * connection's own writes, and in production browse-data/browse-actions share
 * ONE process-cached connection (getSqliteDb keys by dbPath) — so a mutation
 * made through browse-actions (e.g. releaseClaim) would otherwise leave the
 * poll showing stale items until an unrelated connection wrote to the DB.
 * Callers that mutate file_claims/agent_presence on the shared connection
 * must call this after a successful write.
 */
export function invalidateDbCaches(): void {
  claimsCache.value = null;
  agentsCache.value = null;
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

function dbUnavailableItem(kind: 'claim' | 'agent' | 'feedback' | 'entity'): BrowseItem {
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
    // Questions list both open and answered items, but the badge counts only
    // the actionable (open) ones — answered rows carry `archived: true`.
    const count = id === 'questions'
      ? items.filter((i) => i.archived !== true).length
      : items.length;
    return { id, label: CATEGORY_LABELS[id], count };
  }));
}

/**
 * Machine-readable snapshot of browse data for `dokoro browse --json`.
 * No category: `{ dokoroPath, categories: [{id,label,count}] }`.
 * With category: `{ dokoroPath, category, items: [{id,label,sublabel,kind,archived}] }`.
 * Detail/content is intentionally omitted — ids let scripts fetch the files.
 */
export async function browseJsonDump(dokoroPath: string, categoryId?: BrowseCategoryId): Promise<string> {
  if (categoryId === undefined) {
    const categories = (await listCategories(dokoroPath)).map((c) => ({ id: c.id, label: c.label, count: c.count }));
    return JSON.stringify({ dokoroPath, categories }, null, 2);
  }
  const items = (await listItems(dokoroPath, categoryId)).map((i) => ({
    id: i.id,
    label: i.label,
    sublabel: i.sublabel,
    kind: i.kind,
    archived: i.archived,
  }));
  return JSON.stringify({ dokoroPath, category: categoryId, items }, null, 2);
}

/**
 * Directories whose changes can invalidate a category's items — the watch
 * targets for live refresh. Null for DB-backed categories (claims/agents/
 * feedback), which are polled instead. Top-level dirs only: archive
 * week/month subdirs rely on the watcher's reconcile tick.
 */
export function dirsForCategory(dokoroPath: string, category: BrowseCategoryId): string[] | null {
  switch (category) {
    case 'current': return [dokoroPath];
    case 'daily': return [path.join(dokoroPath, 'daily')];
    case 'weekly': return [path.join(dokoroPath, 'retrospective', 'weekly')];
    case 'plans': return [path.join(dokoroPath, '.mcp', 'plans')];
    case 'archive': return [
      path.join(dokoroPath, 'archive', 'daily'),
      path.join(dokoroPath, '.mcp', 'plans', 'archive'),
    ];
    // Questions are file-backed (`.mcp/questions.json`) — watch `.mcp`.
    case 'questions':
    case 'sweep': return [path.join(dokoroPath, '.mcp')];
    case 'claims':
    case 'agents':
    case 'feedback':
    case 'entities':
      return null;
  }
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
      case 'questions': return await questionItems(dokoroPath);
      case 'feedback': return feedbackItems(dokoroPath);
      case 'entities': return entityItems(dokoroPath);
      case 'sweep': return await sweepItems(dokoroPath);
    }
  } catch {
    return [];
  }
}

/** Reorder items for the UI sort toggle. `default` keeps the source order
 * (already newest-first for date categories); never mutates the input. */
export function sortItems(items: BrowseItem[], order: 'default' | 'reverse' | 'label'): BrowseItem[] {
  if (order === 'reverse') return [...items].reverse();
  if (order === 'label') return [...items].sort((a, b) => a.label.localeCompare(b.label));
  return items;
}

/** Workspace claims lock for ~30min; untouched for longer than this means the
 * owning session is gone and "Current" would be misleading without a flag. */
const CURRENT_STALE_MS = 60 * 60 * 1000;

async function currentItems(dokoroPath: string): Promise<BrowseItem[]> {
  const filePath = path.join(dokoroPath, 'current.md');
  try {
    const st = await fs.stat(filePath);
    const stale = Date.now() - st.mtime.getTime() > CURRENT_STALE_MS;
    return [{
      id: 'current.md',
      label: 'current.md',
      sublabel: `updated ${st.mtime.toISOString()}${stale ? ' · stale (session ended?)' : ''}`,
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
    const version = dbDataVersion(sqlite);
    if (claimsCache.value !== null && claimsCache.value.version === version) return claimsCache.value.items;
    const now = nowSeconds(sqlite);
    const rows = sqlite.prepare(
      `SELECT claim_key, file_path, agent_id, session_id, intent,
              claimed_at, expires_at, heartbeat_seq, released_at
       FROM file_claims
       WHERE released_at IS NULL AND expires_at > strftime('%s','now')
       ORDER BY expires_at ASC`,
    ).all() as ClaimRow[];

    const items = rows.map((row) => {
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
    claimsCache.value = { version, items };
    return items;
  } catch {
    return [dbUnavailableItem('claim')];
  }
}

function agentItems(dokoroPath: string): BrowseItem[] {
  const sqlite = tryDb(dokoroPath);
  if (sqlite === null) return [dbUnavailableItem('agent')];
  try {
    const version = dbDataVersion(sqlite);
    if (agentsCache.value !== null && agentsCache.value.version === version) return agentsCache.value.items;
    const now = nowSeconds(sqlite);
    const rows = sqlite.prepare(
      `SELECT agent_id, session_id, status, current_focus, last_heartbeat, heartbeat_seq
       FROM agent_presence
       ORDER BY last_heartbeat DESC`,
    ).all() as PresenceRow[];

    const items = rows.map((row) => {
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
    agentsCache.value = { version, items };
    return items;
  } catch {
    return [dbUnavailableItem('agent')];
  }
}

/** A single question row → a BrowseItem with a pre-rendered detail card. */
function questionItem(q: QuestionJson): BrowseItem {
  const answered = q.status === 'answered';
  const age = ageLabel(q.created_at);
  const lines = [
    'Question',
    '────────',
    q.question,
    '',
    `Status:    ${q.status}`,
    `Priority:  ${q.priority}`,
    `Asked:     ${q.created_at} (${age} ago)`,
  ];
  if (q.context !== undefined && q.context !== '') lines.push(`Context:   ${q.context}`);
  if (answered) {
    const answeredAge = q.answered_at !== undefined ? ` (${ageLabel(q.answered_at)} ago)` : '';
    lines.push(`Answered:  ${q.answered_at ?? '-'}${answeredAge}`, `Answer:    ${q.answer ?? '-'}`);
  }
  return {
    id: q.id,
    label: truncate(q.question, 64),
    sublabel: `${q.status} · ${q.priority} · asked ${age} ago`,
    kind: 'question',
    detail: lines.join('\n'),
    // Answered questions are the resolved set: dim them and drop them from the
    // open badge count (see listCategories).
    archived: answered ? true : undefined,
  };
}

/** Working-memory question queue from `.mcp/questions.json`: open first, then
 * answered, each newest-first. Missing/unreadable file yields an empty list. */
async function questionItems(dokoroPath: string): Promise<BrowseItem[]> {
  const filePath = path.join(dokoroPath, '.mcp', 'questions.json');
  const questions = await readJsonFile<QuestionJson[]>(filePath);
  if (!Array.isArray(questions)) return [];

  const open: Array<{ item: BrowseItem; createdMs: number }> = [];
  const answered: Array<{ item: BrowseItem; createdMs: number }> = [];
  for (const q of questions) {
    // One malformed entry (hand-edited / version-skewed file) must not unwind
    // into listItems' catch-all and hide every valid question — skip it.
    if (typeof q?.id !== 'string' || typeof q?.question !== 'string') continue;
    const createdMs = Date.parse(q.created_at);
    const entry = { item: questionItem(q), createdMs: Number.isNaN(createdMs) ? 0 : createdMs };
    (q.status === 'answered' ? answered : open).push(entry);
  }
  open.sort((a, b) => b.createdMs - a.createdMs);
  answered.sort((a, b) => b.createdMs - a.createdMs);
  return [...open.map((o) => o.item), ...answered.map((a) => a.item)];
}

/** Affective feedback rows from `agent_feedback`, newest first. Unavailable DB
 * yields a single `(database unavailable)` placeholder. */
function feedbackItems(dokoroPath: string): BrowseItem[] {
  const sqlite = tryDb(dokoroPath);
  if (sqlite === null) return [dbUnavailableItem('feedback')];
  try {
    const rows = sqlite.prepare(
      `SELECT id, agent_id, tool_name, outcome, confidence, latency_ms,
              error_message, doc_id, session_id, metadata_json, recorded_at,
              CAST((julianday('now') - julianday(recorded_at)) * 86400 AS INTEGER) AS age_seconds
       FROM agent_feedback
       ORDER BY recorded_at DESC, id DESC`,
    ).all() as FeedbackRow[];

    return rows.map((row) => {
      const age = formatDuration(row.age_seconds);
      const lines = [
        'Feedback',
        '────────',
        `Outcome:    ${row.outcome}`,
        `Tool:       ${row.tool_name}`,
        `Agent:      ${row.agent_id}`,
        `Confidence: ${row.confidence ?? '-'}`,
        `Latency:    ${row.latency_ms === null ? '-' : `${row.latency_ms}ms`}`,
        `Recorded:   ${row.recorded_at} (${age} ago)`,
        `Session:    ${row.session_id ?? '-'}`,
        `Doc:        ${row.doc_id ?? '-'}`,
      ];
      if (row.error_message !== null) lines.push(`Error:      ${row.error_message}`);
      if (row.metadata_json !== null) lines.push(`Metadata:   ${row.metadata_json}`);
      return {
        id: `feedback-${row.id}`,
        label: `${row.outcome} · ${row.tool_name}`,
        sublabel: `${row.agent_id} · ${age} ago`,
        kind: 'feedback' as const,
        detail: lines.join('\n'),
      };
    });
  } catch {
    return [dbUnavailableItem('feedback')];
  }
}

interface EntityRow {
  id: number;
  type: string;
  name: string;
  description: string | null;
  relation_count: number;
}

interface EntityRelationRow {
  relation_type: string;
  source_name: string;
  target_name: string;
}

/** Read-only entity-graph view. Newest first (updated_at). Currently-valid
 * relations only (valid_to IS NULL). Unavailable DB → one placeholder item. */
function entityItems(dokoroPath: string): BrowseItem[] {
  const sqlite = tryDb(dokoroPath);
  if (sqlite === null) return [dbUnavailableItem('entity')];
  try {
    const rows = sqlite.prepare(
      `SELECT e.id, e.type, e.name, e.description,
              (SELECT COUNT(*) FROM entity_relations er
               WHERE (er.source_id = e.id OR er.target_id = e.id) AND er.valid_to IS NULL) AS relation_count
       FROM entities e
       ORDER BY e.updated_at DESC, e.id DESC`,
    ).all() as EntityRow[];

    return rows.map((row) => {
      const relations = sqlite.prepare(
        `SELECT er.relation_type, es.name AS source_name, et.name AS target_name
         FROM entity_relations er
         JOIN entities es ON er.source_id = es.id
         JOIN entities et ON er.target_id = et.id
         WHERE (er.source_id = ? OR er.target_id = ?) AND er.valid_to IS NULL
         ORDER BY er.valid_from DESC`,
      ).all(row.id, row.id) as EntityRelationRow[];

      const lines = [
        'Entity',
        '──────',
        `Name:      ${row.name}`,
        `Type:      ${row.type}`,
      ];
      if (row.description !== null && row.description !== '') lines.push(`Desc:      ${row.description}`);
      lines.push('', `Relations (${relations.length}):`);
      for (const r of relations) lines.push(`  ${r.source_name} --[${r.relation_type}]--> ${r.target_name}`);

      return {
        id: `entity-${row.id}`,
        label: row.name,
        sublabel: `${row.type} · ${row.relation_count} relation${row.relation_count === 1 ? '' : 's'}`,
        kind: 'entity' as const,
        detail: lines.join('\n'),
      };
    });
  } catch {
    return [dbUnavailableItem('entity')];
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
