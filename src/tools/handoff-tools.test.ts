import Database from 'better-sqlite3';
import { jest } from '@jest/globals';

jest.mock('../db/index.js', () => ({
  getSqliteDb: () => { throw new Error('getSqliteDb should not be called in tests (use __TEST_DB__)'); },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handoffTools } = require('./handoff-tools.js') as typeof import('./handoff-tools.js');

function findTool(name: string) {
  const t = handoffTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}
function textOf(res: { content?: Array<{ type: string; text?: string }> }): string {
  return res.content?.[0]?.type === 'text' ? (res.content[0].text ?? '') : '';
}

describe('handoff-tools', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE handoffs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_agent TEXT NOT NULL,
        to_agent TEXT,
        session_id TEXT,
        summary TEXT NOT NULL,
        open_items_json TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        claimed_by TEXT,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        claimed_at TEXT
      );
    `);
    (globalThis as Record<string, unknown>).__TEST_DB__ = db;
  });
  afterEach(() => { db.close(); delete (globalThis as Record<string, unknown>).__TEST_DB__; });

  it('handoff_write inserts an open handoff with summary + open_items', async () => {
    const res = await findTool('dokoro_handoff_write').handler({
      from_agent: 'claude-a', summary: 'auth refactor half done', open_items: ['write regression test', 'update docs'],
    });
    expect(res.isError).toBeFalsy();
    const row = db.prepare('SELECT from_agent, summary, open_items_json, status FROM handoffs').get() as
      { from_agent: string; summary: string; open_items_json: string; status: string };
    expect(row).toMatchObject({ from_agent: 'claude-a', summary: 'auth refactor half done', status: 'open' });
    expect(JSON.parse(row.open_items_json)).toEqual(['write regression test', 'update docs']);
  });

  it('handoff_inbox lists open handoffs (untargeted + targeted to the agent)', async () => {
    const w = findTool('dokoro_handoff_write');
    await w.handler({ from_agent: 'a', summary: 'open to anyone' });
    await w.handler({ from_agent: 'a', summary: 'for b only', to_agent: 'b' });
    await w.handler({ from_agent: 'a', summary: 'for c only', to_agent: 'c' });
    const res = await findTool('dokoro_handoff_inbox').handler({ agent_id: 'b' });
    const t = textOf(res);
    expect(t).toMatch(/open to anyone/); // untargeted
    expect(t).toMatch(/for b only/);     // targeted to b
    expect(t).not.toMatch(/for c only/); // targeted to c, hidden from b
  });

  it('handoff_claim atomically claims an open handoff once; a second claim fails', async () => {
    await findTool('dokoro_handoff_write').handler({ from_agent: 'a', summary: 's' });
    const id = (db.prepare('SELECT id FROM handoffs').get() as { id: number }).id;
    const first = await findTool('dokoro_handoff_claim').handler({ handoff_id: id, agent_id: 'b' });
    expect(first.isError).toBeFalsy();
    const second = await findTool('dokoro_handoff_claim').handler({ handoff_id: id, agent_id: 'c' });
    expect(second.isError).toBe(true);
    expect(textOf(second)).toMatch(/already claimed|not open/i);
    const row = db.prepare('SELECT status, claimed_by FROM handoffs WHERE id=?').get(id) as { status: string; claimed_by: string };
    expect(row).toMatchObject({ status: 'claimed', claimed_by: 'b' });
  });
});
