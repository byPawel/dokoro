/**
 * browse-data.ts: pure data layer behind `dokoro browse`.
 *
 * Functions take dokoroPath explicitly, so each test points them at a fresh
 * mkdtemp fixture. DB access goes through globalThis.__TEST_DB__ (same
 * pattern as file-claim-tools.test.ts / archive.test.ts) — getSqliteDb is
 * mocked to throw if reached, which doubles as the "database unavailable"
 * scenario once __TEST_DB__ is removed. The module is loaded fresh via
 * jest.isolateModules to keep the mock pattern consistent with archive.test.ts.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { jest } from '@jest/globals';

jest.mock('../db/index.js', () => ({
  getSqliteDb: () => { throw new Error('getSqliteDb should not be called in tests (use __TEST_DB__)'); },
}));

type BrowseDataModule = typeof import('./browse-data.js');

let tmpDir: string;
let mod: BrowseDataModule;
let db: Database.Database;

function freshModule(): Promise<BrowseDataModule> {
  return new Promise<BrowseDataModule>((resolve) => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      resolve(require('./browse-data.js') as BrowseDataModule);
    });
  });
}

const plansDir = (): string => path.join(tmpDir, '.mcp', 'plans');
const dailyDir = (): string => path.join(tmpDir, 'daily');

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

async function writePlan(
  id: string,
  status: string,
  items: Array<{ text: string; completed: boolean }> = [],
  updatedAt = new Date(),
): Promise<void> {
  await writeJson(path.join(plansDir(), `${id}.json`), {
    id,
    title: `Title of ${id}`,
    items: items.map((it, idx) => ({ id: `item-${idx}`, ...it, created_at: updatedAt.toISOString() })),
    created_at: updatedAt.toISOString(),
    updated_at: updatedAt.toISOString(),
    status,
    completion_percentage: items.length === 0 ? 0 : Math.round((items.filter((i) => i.completed).length / items.length) * 100),
  });
}

function insertLiveClaim(claimKey: string, agentId = 'alice', ttlSeconds = 600): void {
  db.prepare(`
    INSERT INTO file_claims (claim_key, file_path, agent_id, intent, claimed_at, expires_at, heartbeat_seq, released_at)
    VALUES (?, ?, ?, 'edit', strftime('%s','now'), strftime('%s','now') + ${ttlSeconds}, 0, NULL)
  `).run(claimKey, claimKey, agentId);
}

interface QuestionFixture {
  id: string;
  question: string;
  status: 'open' | 'answered';
  priority?: 'low' | 'medium' | 'high' | 'blocker';
  context?: string;
  answer?: string;
  created_at?: string;
  answered_at?: string;
}

async function writeQuestions(questions: QuestionFixture[]): Promise<void> {
  await writeJson(
    path.join(tmpDir, '.mcp', 'questions.json'),
    questions.map((q) => ({ priority: 'medium', created_at: new Date().toISOString(), ...q })),
  );
}

function insertFeedback(
  toolName: string,
  outcome: string,
  opts: { agentId?: string; recordedAt?: string; confidence?: number; latencyMs?: number; error?: string } = {},
): void {
  db.prepare(`
    INSERT INTO agent_feedback (agent_id, tool_name, outcome, confidence, latency_ms, error_message, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.agentId ?? 'alice',
    toolName,
    outcome,
    opts.confidence ?? null,
    opts.latencyMs ?? null,
    opts.error ?? null,
    opts.recordedAt ?? new Date().toISOString().slice(0, 19).replace('T', ' '),
  );
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dokoro-browse-test-'));

  // In-memory DB with the v11 (agent_presence) + v12 (file_claims) schemas.
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_presence (
      agent_id TEXT PRIMARY KEY,
      session_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      current_focus TEXT,
      last_heartbeat INTEGER NOT NULL,
      heartbeat_seq INTEGER NOT NULL DEFAULT 0
    );
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
    CREATE TABLE agent_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      outcome TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      latency_ms INTEGER,
      error_message TEXT,
      doc_id TEXT,
      session_id TEXT,
      metadata_json TEXT,
      recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  (globalThis as Record<string, unknown>).__TEST_DB__ = db;

  mod = await freshModule();
});

afterEach(async () => {
  delete (globalThis as Record<string, unknown>).__TEST_DB__;
  db.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('listCategories', () => {
  it('returns all categories with item counts', async () => {
    await fs.writeFile(path.join(tmpDir, 'current.md'), '---\nfocus: x\n---\n# Now\n');
    await fs.mkdir(dailyDir(), { recursive: true });
    await fs.writeFile(path.join(dailyDir(), '2026-06-09-10h00-tuesday-a.md'), '# a\n');
    await fs.writeFile(path.join(dailyDir(), '2026-06-10-10h00-wednesday-b.md'), '# b\n');
    const weeklyDir = path.join(tmpDir, 'retrospective', 'weekly');
    await fs.mkdir(weeklyDir, { recursive: true });
    await fs.writeFile(path.join(weeklyDir, '2026-W23.md'), '# week\n');
    await writePlan('plan-live', 'active', [{ text: 'one', completed: false }]);
    await writeJson(path.join(plansDir(), 'index.json'), { 'plan-live': 'Title of plan-live' });
    insertLiveClaim('src/a.ts');
    db.prepare(`
      INSERT INTO agent_presence (agent_id, status, current_focus, last_heartbeat)
      VALUES ('alice', 'active', 'T10', strftime('%s','now'))
    `).run();
    // Two open + one answered question: the badge counts open only.
    await writeQuestions([
      { id: 'q-1', question: 'open one', status: 'open' },
      { id: 'q-2', question: 'open two', status: 'open', priority: 'blocker' },
      { id: 'q-3', question: 'done one', status: 'answered', answer: 'yes' },
    ]);
    insertFeedback('dokoro_workspace_claim', 'success');
    insertFeedback('dokoro_plan_create', 'failure');

    const categories = await mod.listCategories(tmpDir);
    const byId = Object.fromEntries(categories.map((c) => [c.id, c.count]));
    expect(byId).toEqual({
      current: 1,
      daily: 2,
      weekly: 1,
      archive: 0,
      plans: 1,
      claims: 1,
      agents: 1,
      questions: 2,
      feedback: 2,
      sweep: 0,
    });
  });

  it('handles a completely empty/missing workspace without crashing', async () => {
    const categories = await mod.listCategories(path.join(tmpDir, 'does-not-exist'));
    expect(categories).toHaveLength(10);
    // claims/agents/feedback read the (empty) injected DB → 0; everything else
    // has no backing dir/file → 0. All categories are 0 in an empty workspace.
    for (const cat of categories) {
      expect(cat.count).toBe(0);
    }
  });
});

describe('listItems: files', () => {
  it('sorts daily sessions newest first by filename', async () => {
    await fs.mkdir(dailyDir(), { recursive: true });
    const names = [
      '2026-06-01-09h00-monday-old.md',
      '2026-06-10-22h23-wednesday-new.md',
      '2026-06-05-12h30-friday-mid.md',
    ];
    for (const name of names) await fs.writeFile(path.join(dailyDir(), name), '# x\n');

    const items = await mod.listItems(tmpDir, 'daily');
    expect(items.map((i) => i.label)).toEqual([
      '2026-06-10-22h23-wednesday-new.md',
      '2026-06-05-12h30-friday-mid.md',
      '2026-06-01-09h00-monday-old.md',
    ]);
    expect(items[0].kind).toBe('file');
    expect(items[0].path).toBe(path.join(dailyDir(), '2026-06-10-22h23-wednesday-new.md'));
  });

  it('returns empty lists for missing directories (no crash)', async () => {
    expect(await mod.listItems(tmpDir, 'daily')).toEqual([]);
    expect(await mod.listItems(tmpDir, 'weekly')).toEqual([]);
    expect(await mod.listItems(tmpDir, 'archive')).toEqual([]);
    expect(await mod.listItems(tmpDir, 'plans')).toEqual([]);
    expect(await mod.listItems(tmpDir, 'current')).toEqual([]);
    expect(await mod.listItems(tmpDir, 'sweep')).toEqual([]);
  });

  it('lists archived daily files and archived plan JSONs with archived flag', async () => {
    const weekDir = path.join(tmpDir, 'archive', 'daily', '2026-W20');
    await fs.mkdir(weekDir, { recursive: true });
    await fs.writeFile(path.join(weekDir, '2026-05-12-09h00-tuesday-x.md'), '# x\n');
    const monthDir = path.join(tmpDir, '.mcp', 'plans', 'archive', '2026-05');
    await fs.mkdir(monthDir, { recursive: true });
    await writeJson(path.join(monthDir, 'plan-old.json'), { title: 'Old', status: 'completed', items: [] });

    const items = await mod.listItems(tmpDir, 'archive');
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.archived === true)).toBe(true);
    expect(items.map((i) => i.kind).sort()).toEqual(['file', 'plan']);
  });
});

describe('listItems: plans', () => {
  it('shows live plans first with status badges, then archived with [archived] badge', async () => {
    await writePlan('plan-live', 'active', [
      { text: 'done thing', completed: true },
      { text: 'open thing', completed: false },
    ]);
    await writeJson(path.join(plansDir(), 'index.json'), {
      'plan-live': 'Title of plan-live',
      'plan-done': { title: '2026-05 done plan', archived: true, archive_path: 'archive/2026-05/plan-done.json' },
      'plan-newer': { title: '2026-06 done plan', archived: true, archive_path: 'archive/2026-06/plan-newer.json' },
    });

    const items = await mod.listItems(tmpDir, 'plans');
    expect(items).toHaveLength(3);

    const [live, archivedNewer, archivedOlder] = items;
    expect(live.id).toBe('plan-live');
    expect(live.label).toBe('Title of plan-live');
    expect(live.sublabel).toContain('[active]');
    expect(live.sublabel).toContain('1/2');
    expect(live.archived).toBeUndefined();

    // Archived plans sort newest-first by label (same direction as 'archive').
    expect(archivedNewer.id).toBe('plan-newer');
    expect(archivedNewer.label).toBe('2026-06 done plan');
    expect(archivedOlder.id).toBe('plan-done');
    expect(archivedOlder.label).toBe('2026-05 done plan');
    expect(archivedOlder.sublabel).toBe('[archived]');
    expect(archivedOlder.archived).toBe(true);
    expect(archivedOlder.path).toBe(path.join(plansDir(), 'archive/2026-05/plan-done.json'));
  });
});

describe('listItems: claims and presence', () => {
  it('lists only live claims, with owner, expiry and holder liveness', async () => {
    insertLiveClaim('src/live.ts', 'alice', 600);
    // Expired claim: must not appear.
    db.prepare(`
      INSERT INTO file_claims (claim_key, file_path, agent_id, claimed_at, expires_at, released_at)
      VALUES ('src/expired.ts', 'src/expired.ts', 'bob', strftime('%s','now') - 700, strftime('%s','now') - 100, NULL)
    `).run();
    // Released claim: must not appear.
    db.prepare(`
      INSERT INTO file_claims (claim_key, file_path, agent_id, claimed_at, expires_at, released_at)
      VALUES ('src/released.ts', 'src/released.ts', 'carol', strftime('%s','now'), strftime('%s','now') + 600, strftime('%s','now'))
    `).run();
    // Alice has a fresh heartbeat -> holder live.
    db.prepare(`
      INSERT INTO agent_presence (agent_id, status, last_heartbeat)
      VALUES ('alice', 'active', strftime('%s','now'))
    `).run();

    const items = await mod.listItems(tmpDir, 'claims');
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('claim');
    expect(items[0].label).toBe('src/live.ts');
    expect(items[0].sublabel).toContain('owner alice');
    expect(items[0].sublabel).toContain('expires in');
    expect(items[0].sublabel).toContain('holder live');

    const detail = await mod.readItemContent(items[0]);
    expect(detail).toContain('File claim');
    expect(detail).toContain('alice');
  });

  it('lists agent presence rows with status, focus and age', async () => {
    db.prepare(`
      INSERT INTO agent_presence (agent_id, session_id, status, current_focus, last_heartbeat, heartbeat_seq)
      VALUES ('agent-1', 'sess-1', 'active', 'T10 browse TUI', strftime('%s','now') - 60, 7)
    `).run();
    db.prepare(`
      INSERT INTO agent_presence (agent_id, status, last_heartbeat)
      VALUES ('agent-2', 'idle', strftime('%s','now') - 3600)
    `).run();

    const items = await mod.listItems(tmpDir, 'agents');
    expect(items.map((i) => i.label)).toEqual(['agent-1', 'agent-2']); // newest heartbeat first
    expect(items[0].kind).toBe('agent');
    expect(items[0].sublabel).toContain('active');
    expect(items[0].sublabel).toContain('T10 browse TUI');
    expect(items[0].sublabel).toMatch(/seen .+ ago/);

    const detail = await mod.readItemContent(items[1]);
    expect(detail).toContain('Agent presence');
    expect(detail).toContain('agent-2');
  });

  it('falls back to a "(database unavailable)" item when the DB cannot be opened', async () => {
    delete (globalThis as Record<string, unknown>).__TEST_DB__; // mocked getSqliteDb throws

    const claims = await mod.listItems(tmpDir, 'claims');
    expect(claims).toHaveLength(1);
    expect(claims[0].label).toBe('(database unavailable)');
    expect(claims[0].kind).toBe('claim');

    const agents = await mod.listItems(tmpDir, 'agents');
    expect(agents).toHaveLength(1);
    expect(agents[0].label).toBe('(database unavailable)');
    expect(agents[0].kind).toBe('agent');
  });
});

describe('listItems: questions', () => {
  it('lists open questions first then answered, each newest first', async () => {
    await writeQuestions([
      { id: 'q-open-old', question: 'older open question', status: 'open', priority: 'high', created_at: '2026-06-01T09:00:00.000Z' },
      { id: 'q-open-new', question: 'newer open question', status: 'open', priority: 'blocker', created_at: '2026-06-10T09:00:00.000Z' },
      { id: 'q-done', question: 'a resolved question', status: 'answered', answer: '42', created_at: '2026-06-05T09:00:00.000Z' },
    ]);

    const items = await mod.listItems(tmpDir, 'questions');
    expect(items.map((i) => i.id)).toEqual(['q-open-new', 'q-open-old', 'q-done']);
    expect(items.every((i) => i.kind === 'question')).toBe(true);

    const [newest] = items;
    expect(newest.label).toBe('newer open question');
    expect(newest.sublabel).toMatch(/^open · blocker · asked .+ ago$/);
    expect(newest.archived).toBeUndefined();

    // Answered rows are flagged archived so the badge counts open only + the UI dims them.
    const answered = items.find((i) => i.id === 'q-done');
    expect(answered?.archived).toBe(true);
    expect(answered?.sublabel).toContain('answered');
  });

  it('truncates a long question label but keeps the full text in the detail card', async () => {
    const long = 'why '.repeat(40).trim();
    await writeQuestions([
      { id: 'q-long', question: long, status: 'answered', context: 'perf', answer: 'because', priority: 'low' },
    ]);

    const [item] = await mod.listItems(tmpDir, 'questions');
    expect(item.label.length).toBeLessThanOrEqual(64);
    expect(item.label.endsWith('…')).toBe(true);

    const detail = await mod.readItemContent(item);
    expect(detail).toContain('Question');
    expect(detail).toContain(long);
    expect(detail).toContain('Context:   perf');
    expect(detail).toContain('Answer:    because');
  });

  it('returns an empty list when questions.json is missing or malformed', async () => {
    expect(await mod.listItems(tmpDir, 'questions')).toEqual([]);
    await fs.mkdir(path.join(tmpDir, '.mcp'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.mcp', 'questions.json'), 'not json');
    expect(await mod.listItems(tmpDir, 'questions')).toEqual([]);
  });

  it('skips a field-missing entry instead of hiding the whole list', async () => {
    await fs.mkdir(path.join(tmpDir, '.mcp'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.mcp', 'questions.json'), JSON.stringify([
      { id: 'q-bad', status: 'open', priority: 'low', created_at: '2026-01-01T00:00:00Z' },
      'not an object',
      { id: 'q-ok', question: 'still here?', status: 'open', priority: 'high', created_at: '2026-06-01T00:00:00Z' },
    ]));

    const items = await mod.listItems(tmpDir, 'questions');
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('q-ok');

    const cats = await mod.listCategories(tmpDir);
    expect(cats.find((c) => c.id === 'questions')?.count).toBe(1);
  });
});

describe('listItems: feedback', () => {
  it('lists feedback newest first with an outcome/tool summary label', async () => {
    insertFeedback('dokoro_plan_create', 'failure', { agentId: 'bob', recordedAt: '2026-06-01 09:00:00', error: 'boom' });
    insertFeedback('dokoro_workspace_claim', 'success', { agentId: 'alice', recordedAt: '2026-06-10 09:00:00', confidence: 0.9, latencyMs: 123 });

    const items = await mod.listItems(tmpDir, 'feedback');
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.kind === 'feedback')).toBe(true);

    const [newest] = items;
    expect(newest.label).toBe('success · dokoro_workspace_claim');
    expect(newest.sublabel).toContain('alice');
    expect(newest.sublabel).toMatch(/ago$/);

    const detail = await mod.readItemContent(newest);
    expect(detail).toContain('Feedback');
    expect(detail).toContain('Outcome:    success');
    expect(detail).toContain('Confidence: 0.9');
    expect(detail).toContain('Latency:    123ms');

    const failure = items.find((i) => i.label.startsWith('failure'));
    expect(await mod.readItemContent(failure!)).toContain('Error:      boom');
  });

  it('returns an empty list when there is no feedback', async () => {
    expect(await mod.listItems(tmpDir, 'feedback')).toEqual([]);
  });

  it('falls back to a "(database unavailable)" item when the DB cannot be opened', async () => {
    delete (globalThis as Record<string, unknown>).__TEST_DB__; // mocked getSqliteDb throws

    const items = await mod.listItems(tmpDir, 'feedback');
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('(database unavailable)');
    expect(items[0].kind).toBe('feedback');
  });
});

describe('dirsForCategory', () => {
  const root = '/tmp/dk';
  it('maps file-backed categories to their watchable directories', () => {
    expect(mod.dirsForCategory(root, 'current')).toEqual(['/tmp/dk']);
    expect(mod.dirsForCategory(root, 'daily')).toEqual(['/tmp/dk/daily']);
    expect(mod.dirsForCategory(root, 'weekly')).toEqual(['/tmp/dk/retrospective/weekly']);
    expect(mod.dirsForCategory(root, 'plans')).toEqual(['/tmp/dk/.mcp/plans']);
    expect(mod.dirsForCategory(root, 'archive')).toEqual([
      '/tmp/dk/archive/daily',
      '/tmp/dk/.mcp/plans/archive',
    ]);
    expect(mod.dirsForCategory(root, 'sweep')).toEqual(['/tmp/dk/.mcp']);
    // Questions live in `.mcp/questions.json`, so the `.mcp` dir is watched.
    expect(mod.dirsForCategory(root, 'questions')).toEqual(['/tmp/dk/.mcp']);
  });
  it('returns null for DB-backed categories (claims/agents/feedback poll instead)', () => {
    expect(mod.dirsForCategory(root, 'claims')).toBeNull();
    expect(mod.dirsForCategory(root, 'agents')).toBeNull();
    expect(mod.dirsForCategory(root, 'feedback')).toBeNull();
  });
});

describe('readItemContent', () => {
  it('renders a plan as a card with a checklist', async () => {
    await writePlan('plan-x', 'active', [
      { text: 'finished step', completed: true },
      { text: 'pending step', completed: false },
    ]);
    await writeJson(path.join(plansDir(), 'index.json'), { 'plan-x': 'Title of plan-x' });

    const [item] = await mod.listItems(tmpDir, 'plans');
    const content = await mod.readItemContent(item);

    expect(content).toContain('Title of plan-x');
    expect(content).toContain('Status:     active');
    expect(content).toContain('☑ finished step');
    expect(content).toContain('☐ pending step');
    expect(content).toContain('Checklist (1/2)');
  });

  it('flags a long-untouched current.md as stale, fresh ones not', async () => {
    const file = path.join(tmpDir, 'current.md');
    await fs.writeFile(file, '# Now\n');
    const [fresh] = await mod.listItems(tmpDir, 'current');
    expect(fresh.sublabel).not.toContain('stale');

    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(file, old, old);
    const [stale] = await mod.listItems(tmpDir, 'current');
    expect(stale.sublabel).toContain('stale (session ended?)');
  });

  it('returns raw markdown for file items and never throws on missing files', async () => {
    await fs.writeFile(path.join(tmpDir, 'current.md'), '# Current focus\n\n- thing\n');
    const [item] = await mod.listItems(tmpDir, 'current');
    expect(await mod.readItemContent(item)).toContain('# Current focus');

    const ghost = await mod.readItemContent({
      id: 'ghost',
      label: 'ghost.md',
      kind: 'file',
      path: path.join(tmpDir, 'nope', 'ghost.md'),
    });
    expect(ghost).toContain('(unable to read');
  });

  it('degrades to a string (no rejection) for an undefined item', async () => {
    // The UI guards enter on an empty filtered list; this is the defensive
    // backstop should that guard ever be bypassed.
    const content = await mod.readItemContent(undefined as unknown as Parameters<typeof mod.readItemContent>[0]);
    expect(typeof content).toBe('string');
    expect(content).toBe('(nothing selected)');
  });
});
