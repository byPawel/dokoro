import Database from 'better-sqlite3';
import { jest } from '@jest/globals';

jest.mock('../db/index.js', () => ({
  getSqliteDb: () => { throw new Error('getSqliteDb should not be called in tests (use __TEST_DB__)'); },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { fileClaimTools } = require('./file-claim-tools.js') as typeof import('./file-claim-tools.js');

const ROOT = '/repo';

function findTool(name: string) {
  const t = fileClaimTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}
function textOf(res: { content?: Array<{ type: string; text?: string }> }): string {
  return res.content?.[0]?.type === 'text' ? (res.content[0].text ?? '') : '';
}
function jsonOf(res: { content?: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const block = res.content?.[1];
  if (!block || block.type !== 'text' || !block.text) throw new Error('no JSON content block');
  return JSON.parse(block.text) as Record<string, unknown>;
}

interface ClaimRow {
  claim_key: string; file_path: string; agent_id: string; session_id: string | null;
  intent: string | null; claimed_at: number; expires_at: number; heartbeat_seq: number; released_at: number | null;
}

describe('file-claim-tools', () => {
  let db: Database.Database;

  const now = (): number => Number((db.prepare(`SELECT strftime('%s','now') AS n`).get() as { n: string }).n);
  const getRow = (claimKey: string): ClaimRow | undefined =>
    db.prepare('SELECT * FROM file_claims WHERE claim_key = ?').get(claimKey) as ClaimRow | undefined;
  const setPresence = (agentId: string, lastHeartbeat: number): void => {
    db.prepare(`
      INSERT INTO agent_presence (agent_id, status, last_heartbeat, heartbeat_seq) VALUES (?, 'active', ?, 1)
      ON CONFLICT(agent_id) DO UPDATE SET last_heartbeat = excluded.last_heartbeat
    `).run(agentId, lastHeartbeat);
  };
  const claim = (args: Record<string, unknown>) =>
    findTool('dokoro_file_claim').handler({ root: ROOT, ...args });
  const release = (args: Record<string, unknown>) =>
    findTool('dokoro_file_release').handler({ root: ROOT, ...args });
  const list = (args: Record<string, unknown> = {}) =>
    findTool('dokoro_claim_list').handler({ root: ROOT, ...args });

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
      CREATE INDEX idx_file_claims_live ON file_claims(expires_at) WHERE released_at IS NULL;
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

  it('fresh claim inserts rows with lease expiry and heartbeat_seq 0', async () => {
    const res = await claim({ paths: ['src/a.ts', 'src/B.TS'], agent_id: 'alice', intent: 'refactor' });
    expect(res.isError).toBeFalsy();
    const t = now();
    const a = getRow('src/a.ts')!;
    expect(a).toMatchObject({ file_path: 'src/a.ts', agent_id: 'alice', intent: 'refactor', heartbeat_seq: 0, released_at: null });
    expect(a.expires_at).toBeGreaterThanOrEqual(t + 295);
    expect(a.expires_at).toBeLessThanOrEqual(t + 305);
    // casefolded identity, display case preserved
    const b = getRow('src/b.ts')!;
    expect(b.file_path).toBe('src/B.TS');
    const json = jsonOf(res) as { claimed: boolean; report: Array<{ path: string; status: string }> };
    expect(json.claimed).toBe(true);
    expect(json.report).toEqual([
      { path: 'src/a.ts', status: 'claimed' },
      { path: 'src/B.TS', status: 'claimed' },
    ]);
  });

  it('renewal by the same agent bumps heartbeat_seq and extends expiry', async () => {
    await claim({ paths: ['src/a.ts'], agent_id: 'alice' });
    // Shrink the lease so the extension is observable.
    db.prepare('UPDATE file_claims SET expires_at = ? WHERE claim_key = ?').run(now() + 5, 'src/a.ts');
    const res = await claim({ paths: ['src/a.ts'], agent_id: 'alice', intent: 'still on it', ttl_seconds: 600 });
    expect(res.isError).toBeFalsy();
    const row = getRow('src/a.ts')!;
    expect(row.heartbeat_seq).toBe(1);
    expect(row.intent).toBe('still on it');
    expect(row.expires_at).toBeGreaterThanOrEqual(now() + 590);
    const json = jsonOf(res) as { report: Array<{ path: string; status: string }> };
    expect(json.report[0].status).toBe('renewed');
  });

  it('conflict with a live holder is all-or-nothing: NOTHING is claimed, not an error', async () => {
    await claim({ paths: ['src/a.ts'], agent_id: 'alice', intent: 'editing auth' });
    setPresence('alice', now()); // fresh heartbeat -> live
    const res = await claim({ paths: ['src/a.ts', 'src/free.ts'], agent_id: 'bob' });
    expect(res.isError).toBeFalsy(); // advisory!
    expect(textOf(res)).toMatch(/NOTHING was claimed/i);
    // all-or-nothing rollback: conflicting row unchanged, free path NOT inserted
    expect(getRow('src/a.ts')!.agent_id).toBe('alice');
    expect(getRow('src/free.ts')).toBeUndefined();
    const json = jsonOf(res) as { claimed: boolean; report: Array<{ path: string; status: string; holder?: { agent_id: string; presence: string; expires_in_seconds: number } }> };
    expect(json.claimed).toBe(false);
    const conflict = json.report.find((r) => r.path === 'src/a.ts')!;
    expect(conflict.status).toBe('conflict');
    expect(conflict.holder).toMatchObject({ agent_id: 'alice', presence: 'live' });
    expect(conflict.holder!.expires_in_seconds).toBeGreaterThan(0);
    expect(json.report.find((r) => r.path === 'src/free.ts')!.status).toBe('would_acquire');
  });

  it('treats a holder with NO presence row as live while the claim is unexpired', async () => {
    await claim({ paths: ['src/a.ts'], agent_id: 'alice' }); // alice never pings
    const res = await claim({ paths: ['src/a.ts'], agent_id: 'bob' });
    expect(res.isError).toBeFalsy();
    const json = jsonOf(res) as { claimed: boolean; report: Array<{ status: string; holder?: { presence: string } }> };
    expect(json.claimed).toBe(false);
    expect(json.report[0].status).toBe('conflict');
    expect(json.report[0].holder!.presence).toBe('unknown');
    expect(getRow('src/a.ts')!.agent_id).toBe('alice');
  });

  it('takes over an EXPIRED claim and surfaces the takeover', async () => {
    await claim({ paths: ['src/a.ts'], agent_id: 'alice' });
    db.prepare('UPDATE file_claims SET expires_at = ? WHERE claim_key = ?').run(now() - 10, 'src/a.ts');
    const res = await claim({ paths: ['src/a.ts'], agent_id: 'bob' });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/taken_over/);
    expect(textOf(res)).toMatch(/alice/); // visibility, never silent
    const row = getRow('src/a.ts')!;
    expect(row).toMatchObject({ agent_id: 'bob', heartbeat_seq: 0, released_at: null });
    const json = jsonOf(res) as { report: Array<{ status: string }> };
    expect(json.report[0].status).toBe('taken_over');
  });

  it('takes over an unexpired claim whose holder presence is stale', async () => {
    await claim({ paths: ['src/a.ts'], agent_id: 'alice' });
    setPresence('alice', now() - 2000); // heartbeat older than 900s -> stale
    const res = await claim({ paths: ['src/a.ts'], agent_id: 'bob' });
    expect(res.isError).toBeFalsy();
    expect(getRow('src/a.ts')!.agent_id).toBe('bob');
    const json = jsonOf(res) as { report: Array<{ status: string }> };
    expect(json.report[0].status).toBe('taken_over');
  });

  it('force:true overrides a LIVE holder and marks the takeover as forced', async () => {
    await claim({ paths: ['src/a.ts'], agent_id: 'alice' });
    setPresence('alice', now());
    const res = await claim({ paths: ['src/a.ts'], agent_id: 'bob', force: true });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/taken_over_forced/);
    expect(getRow('src/a.ts')!.agent_id).toBe('bob');
    const json = jsonOf(res) as { report: Array<{ status: string }> };
    expect(json.report[0].status).toBe('taken_over_forced');
  });

  it('reuses a released row as a fresh claim (status claimed)', async () => {
    await claim({ paths: ['src/a.ts'], agent_id: 'alice' });
    await release({ paths: ['src/a.ts'], agent_id: 'alice' });
    const res = await claim({ paths: ['src/a.ts'], agent_id: 'bob' });
    expect(res.isError).toBeFalsy();
    const row = getRow('src/a.ts')!;
    expect(row).toMatchObject({ agent_id: 'bob', released_at: null, heartbeat_seq: 0 });
    const json = jsonOf(res) as { report: Array<{ status: string }> };
    expect(json.report[0].status).toBe('claimed');
  });

  it('release is owner-aware: another agent gets not_held_by_you and the row is unchanged', async () => {
    await claim({ paths: ['src/a.ts'], agent_id: 'alice' });
    const res = await release({ paths: ['src/a.ts'], agent_id: 'bob' });
    expect(res.isError).toBeFalsy();
    const json = jsonOf(res) as { report: Array<{ path: string; status: string }> };
    expect(json.report[0]).toEqual({ path: 'src/a.ts', status: 'not_held_by_you' });
    expect(getRow('src/a.ts')!).toMatchObject({ agent_id: 'alice', released_at: null });
    // owner can release
    const res2 = await release({ paths: ['src/a.ts'], agent_id: 'alice' });
    const json2 = jsonOf(res2) as { report: Array<{ status: string }> };
    expect(json2.report[0].status).toBe('released');
    expect(getRow('src/a.ts')!.released_at).not.toBeNull();
  });

  it('release of an unknown path is idempotent not_found, never an error', async () => {
    const res = await release({ paths: ['src/never-claimed.ts'], agent_id: 'alice' });
    expect(res.isError).toBeFalsy();
    const json = jsonOf(res) as { report: Array<{ status: string }> };
    expect(json.report[0].status).toBe('not_found');
  });

  it('release all releases only the caller\'s open claims', async () => {
    await claim({ paths: ['src/a.ts', 'src/b.ts'], agent_id: 'alice' });
    await claim({ paths: ['src/c.ts'], agent_id: 'bob' });
    const res = await release({ all: true, agent_id: 'alice' });
    expect(res.isError).toBeFalsy();
    const json = jsonOf(res) as { report: Array<{ path: string; status: string }> };
    expect(json.report.map((r) => r.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(getRow('src/a.ts')!.released_at).not.toBeNull();
    expect(getRow('src/b.ts')!.released_at).not.toBeNull();
    expect(getRow('src/c.ts')!.released_at).toBeNull(); // bob untouched
  });

  it('release rejects ambiguous input (paths and all together, or neither)', async () => {
    const neither = await release({ agent_id: 'alice' });
    expect(neither.isError).toBe(true);
    const both = await release({ agent_id: 'alice', all: true, paths: ['src/a.ts'] });
    expect(both.isError).toBe(true);
  });

  it('claim_list shows liveness labels, filters by agent, and hides expired unless asked', async () => {
    await claim({ paths: ['src/live.ts'], agent_id: 'alice' });
    await claim({ paths: ['src/stale.ts'], agent_id: 'bob' });
    await claim({ paths: ['src/unknown.ts'], agent_id: 'carol' });
    await claim({ paths: ['src/expired.ts'], agent_id: 'dave' });
    setPresence('alice', now());
    setPresence('bob', now() - 2000);
    db.prepare('UPDATE file_claims SET expires_at = ? WHERE claim_key = ?').run(now() - 5, 'src/expired.ts');

    const res = await list();
    const claims = (jsonOf(res) as { claims: Array<{ path: string; presence: string }> }).claims;
    expect(claims.map((c) => c.path).sort()).toEqual(['src/live.ts', 'src/stale.ts', 'src/unknown.ts']); // expired hidden
    expect(claims.find((c) => c.path === 'src/live.ts')!.presence).toBe('live');
    expect(claims.find((c) => c.path === 'src/stale.ts')!.presence).toBe('stale');
    expect(claims.find((c) => c.path === 'src/unknown.ts')!.presence).toBe('unknown');
    expect(textOf(res)).toMatch(/\| path \| agent \|/); // markdown table

    const withExpired = await list({ include_expired: true });
    const all = (jsonOf(withExpired) as { claims: Array<{ path: string }> }).claims;
    expect(all.map((c) => c.path)).toContain('src/expired.ts');

    const onlyBob = await list({ agent_id: 'bob' });
    const bobs = (jsonOf(onlyBob) as { claims: Array<{ path: string; agent_id: string }> }).claims;
    expect(bobs).toHaveLength(1);
    expect(bobs[0]).toMatchObject({ path: 'src/stale.ts', agent_id: 'bob' });
  });

  it('claim_list shows released claims never', async () => {
    await claim({ paths: ['src/a.ts'], agent_id: 'alice' });
    await release({ all: true, agent_id: 'alice' });
    const res = await list({ include_expired: true });
    expect(textOf(res)).toBe('(no open claims)');
  });

  it('normalization failure rejects the WHOLE claim call with isError and writes nothing', async () => {
    const res = await claim({ paths: ['src/ok.ts', '../escape.ts'], agent_id: 'alice' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/escape/);
    expect(db.prepare('SELECT COUNT(*) c FROM file_claims').get()).toEqual({ c: 0 });
  });

  it('pruning removes day-old released and long-expired open rows but keeps fresh ones', async () => {
    const t = now();
    const ins = db.prepare(`
      INSERT INTO file_claims (claim_key, file_path, agent_id, claimed_at, expires_at, heartbeat_seq, released_at)
      VALUES (?, ?, 'old', ?, ?, 0, ?)
    `);
    ins.run('src/old-released.ts', 'src/old-released.ts', t - 90000, t - 89000, t - 88000); // released > 1d ago -> prune
    ins.run('src/fresh-released.ts', 'src/fresh-released.ts', t - 100, t + 200, t - 10);    // freshly released -> keep
    ins.run('src/old-open.ts', 'src/old-open.ts', t - 90000, t - 87000, null);              // open, expired > 1d -> prune
    ins.run('src/fresh-open.ts', 'src/fresh-open.ts', t - 10, t + 200, null);               // open, live -> keep

    await claim({ paths: ['src/trigger.ts'], agent_id: 'alice' }); // pruning runs at claim start
    const keys = (db.prepare('SELECT claim_key FROM file_claims ORDER BY claim_key').all() as Array<{ claim_key: string }>)
      .map((r) => r.claim_key);
    expect(keys).toEqual(['src/fresh-open.ts', 'src/fresh-released.ts', 'src/trigger.ts']);
  });
});
