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
      sweep: 0,
    });
  });

  it('handles a completely empty/missing workspace without crashing', async () => {
    const categories = await mod.listCategories(path.join(tmpDir, 'does-not-exist'));
    expect(categories).toHaveLength(8);
    for (const cat of categories.filter((c) => c.id !== 'claims' && c.id !== 'agents')) {
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
