/**
 * browse-actions.ts: pure gated-mutation layer behind `dokoro browse`.
 *
 * releaseClaim goes through globalThis.__TEST_DB__ (same pattern as
 * browse-data.test.ts / file-claim-tools.test.ts) — getSqliteDb is mocked to
 * throw if reached, which doubles as the "database unavailable" scenario once
 * __TEST_DB__ is removed. planTransition/readPlanStatus are filesystem-only and
 * run against a fresh mkdtemp fixture per test.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { jest } from '@jest/globals';

jest.mock('../db/index.js', () => ({
  getSqliteDb: () => { throw new Error('getSqliteDb should not be called in tests (use __TEST_DB__)'); },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const actions = require('./browse-actions.js') as typeof import('./browse-actions.js');

interface ClaimRow {
  claim_key: string; file_path: string; agent_id: string;
  claimed_at: number; expires_at: number; heartbeat_seq: number; released_at: number | null;
}

describe('releaseClaim', () => {
  let db: Database.Database;
  const DOKORO = '/repo/dokoro'; // arbitrary — DB access is via __TEST_DB__

  const now = (): number => Number((db.prepare(`SELECT strftime('%s','now') AS n`).get() as { n: string }).n);
  const getRow = (claimKey: string): ClaimRow | undefined =>
    db.prepare('SELECT * FROM file_claims WHERE claim_key = ?').get(claimKey) as ClaimRow | undefined;

  function insertClaim(
    claimKey: string,
    opts: { agent?: string; expiresInSec?: number; released?: boolean } = {},
  ): void {
    const { agent = 'alice', expiresInSec = 600, released = false } = opts;
    const t = now();
    db.prepare(`
      INSERT INTO file_claims (claim_key, file_path, agent_id, intent, claimed_at, expires_at, heartbeat_seq, released_at)
      VALUES (?, ?, ?, 'edit', ?, ?, 0, ?)
    `).run(claimKey, claimKey, agent, t, t + expiresInSec, released ? t : null);
  }
  function setPresence(agent: string, secondsAgo: number): void {
    const t = now();
    db.prepare(`
      INSERT INTO agent_presence (agent_id, status, last_heartbeat, heartbeat_seq) VALUES (?, 'active', ?, 1)
      ON CONFLICT(agent_id) DO UPDATE SET last_heartbeat = excluded.last_heartbeat
    `).run(agent, t - secondsAgo);
  }

  beforeEach(() => {
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
      CREATE TABLE agent_presence (
        agent_id TEXT PRIMARY KEY,
        session_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        current_focus TEXT,
        last_heartbeat INTEGER NOT NULL,
        heartbeat_seq INTEGER NOT NULL DEFAULT 0
      );
    `);
    (globalThis as Record<string, unknown>).__TEST_DB__ = db;
  });
  afterEach(() => { db.close(); delete (globalThis as Record<string, unknown>).__TEST_DB__; });

  it('releases an unexpired claim whose holder heartbeat is stale', () => {
    insertClaim('src/a.ts');
    setPresence('alice', 2000); // > PRESENCE_TTL (900) — stale
    const res = actions.releaseClaim(DOKORO, 'src/a.ts');
    expect(res).toEqual({ outcome: 'released' });
    expect(getRow('src/a.ts')!.released_at).not.toBeNull();
  });

  it('releases an unexpired claim whose holder never pinged (no presence row)', () => {
    insertClaim('src/a.ts');
    const res = actions.releaseClaim(DOKORO, 'src/a.ts');
    expect(res.outcome).toBe('released');
    expect(getRow('src/a.ts')!.released_at).not.toBeNull();
  });

  it('releases an expired claim even when the holder is live (gate needs BOTH)', () => {
    insertClaim('src/a.ts', { expiresInSec: -10 }); // already expired
    setPresence('alice', 0); // fresh heartbeat — live
    const res = actions.releaseClaim(DOKORO, 'src/a.ts');
    expect(res.outcome).toBe('released');
  });

  it('REFUSES to release an unexpired claim whose holder is live (holderLive gate)', () => {
    insertClaim('src/a.ts');
    setPresence('alice', 0); // fresh heartbeat — live
    const res = actions.releaseClaim(DOKORO, 'src/a.ts');
    expect(res).toEqual({ outcome: 'holderLive', holder: 'alice' });
    // No force option — the row stays open.
    expect(getRow('src/a.ts')!.released_at).toBeNull();
  });

  it('reports alreadyReleased for a claim that is already released', () => {
    insertClaim('src/a.ts', { released: true });
    const res = actions.releaseClaim(DOKORO, 'src/a.ts');
    expect(res.outcome).toBe('alreadyReleased');
  });

  it('reports missing for an unknown claim key', () => {
    const res = actions.releaseClaim(DOKORO, 'src/nope.ts');
    expect(res.outcome).toBe('missing');
  });

  it('reports dbUnavailable when no database is reachable', () => {
    delete (globalThis as Record<string, unknown>).__TEST_DB__;
    const res = actions.releaseClaim(DOKORO, 'src/a.ts');
    expect(res.outcome).toBe('dbUnavailable');
  });
});

describe('planTransition / readPlanStatus / nextPlanStatus', () => {
  let tmpDir: string;

  const plansDir = (): string => path.join(tmpDir, '.mcp', 'plans');
  const planPath = (id: string): string => path.join(plansDir(), `${id}.json`);
  const indexPath = (): string => path.join(plansDir(), 'index.json');

  async function writePlan(
    id: string,
    status: string,
    opts: { title?: string; updatedAt?: string } = {},
  ): Promise<void> {
    const { title = `Title of ${id}`, updatedAt = '2020-01-01T00:00:00.000Z' } = opts;
    await fs.mkdir(plansDir(), { recursive: true });
    await fs.writeFile(planPath(id), JSON.stringify({
      id,
      title,
      description: 'keep me',
      items: [{ id: 'item-0', text: 'do it', completed: false }],
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: updatedAt,
      status,
      completion_percentage: 0,
    }, null, 2));
  }
  async function writeIndex(index: Record<string, unknown>): Promise<void> {
    await fs.mkdir(plansDir(), { recursive: true });
    await fs.writeFile(indexPath(), JSON.stringify(index, null, 2));
  }
  async function readPlan(id: string): Promise<Record<string, unknown>> {
    return JSON.parse(await fs.readFile(planPath(id), 'utf-8')) as Record<string, unknown>;
  }
  async function readIndex(): Promise<Record<string, unknown>> {
    return JSON.parse(await fs.readFile(indexPath(), 'utf-8')) as Record<string, unknown>;
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dokoro-browse-actions-'));
  });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it('transitions draft → active, bumping updated_at and preserving other fields', async () => {
    await writePlan('p1', 'draft');
    await writeIndex({ p1: 'Title of p1' });
    const res = await actions.planTransition(tmpDir, 'p1');
    expect(res).toEqual({ outcome: 'transitioned', from: 'draft', to: 'active' });
    const plan = await readPlan('p1');
    expect(plan.status).toBe('active');
    expect(plan.description).toBe('keep me'); // untouched fields survive
    expect(plan.updated_at).not.toBe('2020-01-01T00:00:00.000Z'); // bumped
  });

  it('transitions active → completed', async () => {
    await writePlan('p2', 'active');
    await writeIndex({ p2: 'Title of p2' });
    const res = await actions.planTransition(tmpDir, 'p2');
    expect(res).toEqual({ outcome: 'transitioned', from: 'active', to: 'completed' });
    expect((await readPlan('p2')).status).toBe('completed');
  });

  it('returns noTransition for a completed plan and leaves it untouched', async () => {
    await writePlan('p3', 'completed');
    const res = await actions.planTransition(tmpDir, 'p3');
    expect(res.outcome).toBe('noTransition');
    expect((await readPlan('p3')).status).toBe('completed');
    expect((await readPlan('p3')).updated_at).toBe('2020-01-01T00:00:00.000Z');
  });

  it('returns missing when the plan file does not exist', async () => {
    const res = await actions.planTransition(tmpDir, 'nope');
    expect(res.outcome).toBe('missing');
  });

  it('heals a missing index entry with the plan title on transition', async () => {
    await writePlan('p5', 'active', { title: 'Ship it' });
    await writeIndex({}); // index has no entry for p5
    const res = await actions.planTransition(tmpDir, 'p5');
    expect(res.outcome).toBe('transitioned');
    expect((await readIndex()).p5).toBe('Ship it');
  });

  it('aborts with changed when the on-disk status drifted from expectedStatus', async () => {
    await writePlan('p6', 'active'); // UI armed against a stale "draft"
    const res = await actions.planTransition(tmpDir, 'p6', 'draft');
    expect(res).toEqual({ outcome: 'changed', actual: 'active' });
    expect((await readPlan('p6')).status).toBe('active'); // not transitioned
  });

  it('honors a matching expectedStatus and transitions', async () => {
    await writePlan('p7', 'active');
    await writeIndex({ p7: 'Title of p7' });
    const res = await actions.planTransition(tmpDir, 'p7', 'active');
    expect(res).toEqual({ outcome: 'transitioned', from: 'active', to: 'completed' });
  });

  it('readPlanStatus returns the on-disk status, or null when missing', async () => {
    await writePlan('p8', 'draft');
    expect(await actions.readPlanStatus(tmpDir, 'p8')).toBe('draft');
    expect(await actions.readPlanStatus(tmpDir, 'gone')).toBeNull();
  });

  it('nextPlanStatus maps only the two legal forward steps', () => {
    expect(actions.nextPlanStatus('draft')).toBe('active');
    expect(actions.nextPlanStatus('active')).toBe('completed');
    expect(actions.nextPlanStatus('completed')).toBeNull();
    expect(actions.nextPlanStatus('validated')).toBeNull();
    expect(actions.nextPlanStatus(null)).toBeNull();
  });
});
