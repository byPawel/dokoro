/**
 * TDD tests for devlog_feedback_route
 *
 * Spec assertions:
 * (a) a tool with 1 success does NOT outrank a tool with 95/100 successes (Wilson + min_samples)
 * (b) recent successes outrank old failures (decay)
 * (c) outcome breakdown present in output
 * (d) agent_id filter isolates an agent
 */
import Database from 'better-sqlite3';
import { jest } from '@jest/globals';
import { ensureAgentFeedbackTable } from '../db/agent-feedback.js';

// Mock db/index.js so the module loads via __TEST_DB__
jest.mock('../db/index.js', () => ({
  getSqliteDb: () => { throw new Error('getSqliteDb should not be called in tests (use __TEST_DB__)'); },
}));

// Import after mock is registered
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { feedbackTools } = require('./feedback-tools.js') as typeof import('./feedback-tools.js');

function findTool(name: string) {
  const t = feedbackTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      id TEXT PRIMARY KEY,
      filepath TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      status TEXT NOT NULL DEFAULT 'active'
    );
  `);
  ensureAgentFeedbackTable(db);
  return db;
}

function insertRow(
  db: Database.Database,
  agent_id: string,
  tool_name: string,
  outcome: string,
  recorded_at_expr: string,
  confidence: number | null = null,
) {
  // Use SQLite datetime expressions by running them via prepare
  db.prepare(`
    INSERT INTO agent_feedback (agent_id, tool_name, outcome, confidence, recorded_at)
    VALUES (?, ?, ?, ?, ${recorded_at_expr})
  `).run(agent_id, tool_name, outcome, confidence);
}

describe('devlog_feedback_route', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
    (globalThis as Record<string, unknown>).__TEST_DB__ = db;
  });

  afterEach(() => {
    db.close();
    delete (globalThis as Record<string, unknown>).__TEST_DB__;
  });

  it('(a) a tool with 1 success does NOT outrank a tool with 95/100 successes', async () => {
    const route = findTool('devlog_feedback_route');

    // tool_a: 1 success out of 1 (raw rate=1.0 but low confidence, n=1)
    insertRow(db, 'agent1', 'tool_a', 'success', "datetime('now','-1 day')");

    // tool_b: 95 successes, 5 failures (raw rate=0.95, n=100)
    for (let i = 0; i < 95; i++) {
      insertRow(db, 'agent1', 'tool_b', 'success', "datetime('now','-1 day')");
    }
    for (let i = 0; i < 5; i++) {
      insertRow(db, 'agent1', 'tool_b', 'failure', "datetime('now','-1 day')");
    }

    const res = await route.handler({ min_samples: 5 });
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';

    // tool_b should appear first (higher Wilson lower bound despite lower raw rate)
    const idxA = text.indexOf('tool_a');
    const idxB = text.indexOf('tool_b');
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeLessThan(idxA);
  });

  it('(b) recent successes outrank old failures (recency decay)', async () => {
    const route = findTool('devlog_feedback_route');

    // tool_recent: 8 successes in last 1 day + 2 failures
    for (let i = 0; i < 8; i++) {
      insertRow(db, 'agent1', 'tool_recent', 'success', "datetime('now','-1 day')");
    }
    insertRow(db, 'agent1', 'tool_recent', 'failure', "datetime('now','-1 day')");
    insertRow(db, 'agent1', 'tool_recent', 'failure', "datetime('now','-1 day')");

    // tool_old: 8 successes 90 days ago (heavily decayed) + 2 recent failures
    for (let i = 0; i < 8; i++) {
      insertRow(db, 'agent1', 'tool_old', 'success', "datetime('now','-90 days')");
    }
    insertRow(db, 'agent1', 'tool_old', 'failure', "datetime('now','-1 day')");
    insertRow(db, 'agent1', 'tool_old', 'failure', "datetime('now','-1 day')");

    const res = await route.handler({ min_samples: 5, half_life_days: 14 });
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';

    const idxRecent = text.indexOf('tool_recent');
    const idxOld = text.indexOf('tool_old');
    expect(idxRecent).toBeGreaterThanOrEqual(0);
    expect(idxOld).toBeGreaterThanOrEqual(0);
    expect(idxRecent).toBeLessThan(idxOld);
  });

  it('(c) outcome breakdown (partial/rejected/timeout) is present in output', async () => {
    const route = findTool('devlog_feedback_route');

    insertRow(db, 'agent1', 'tool_x', 'success', "datetime('now','-1 day')");
    insertRow(db, 'agent1', 'tool_x', 'failure', "datetime('now','-1 day')");
    insertRow(db, 'agent1', 'tool_x', 'partial', "datetime('now','-1 day')");
    insertRow(db, 'agent1', 'tool_x', 'rejected', "datetime('now','-1 day')");
    insertRow(db, 'agent1', 'tool_x', 'timeout', "datetime('now','-1 day')");

    const res = await route.handler({ tool_name: 'tool_x', min_samples: 1 });
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';

    expect(text).toMatch(/partial/i);
    expect(text).toMatch(/rejected/i);
    expect(text).toMatch(/timeout/i);
    expect(text).toMatch(/success/i);
    expect(text).toMatch(/failure/i);
  });

  it('(d) agent_id filter isolates per-agent stats', async () => {
    const route = findTool('devlog_feedback_route');

    // agent_a: 10 successes for tool_shared
    for (let i = 0; i < 10; i++) {
      insertRow(db, 'agent_a', 'tool_shared', 'success', "datetime('now','-1 day')");
    }
    // agent_b: 10 failures for tool_shared
    for (let i = 0; i < 10; i++) {
      insertRow(db, 'agent_b', 'tool_shared', 'failure', "datetime('now','-1 day')");
    }

    const resA = await route.handler({ agent_id: 'agent_a', tool_name: 'tool_shared', min_samples: 1 });
    const textA = resA.content?.[0]?.type === 'text' ? resA.content[0].text : '';
    // agent_a should show n=10 and success=10
    expect(textA).toMatch(/n=10/i);
    expect(textA).toMatch(/success=10/i);
    // agent_a filtered view should not show failure count of 10
    expect(textA).not.toMatch(/failure=10/i);

    const resB = await route.handler({ agent_id: 'agent_b', tool_name: 'tool_shared', min_samples: 1 });
    const textB = resB.content?.[0]?.type === 'text' ? resB.content[0].text : '';
    expect(textB).toMatch(/n=10/i);
    expect(textB).toMatch(/failure=10/i);
  });

  it('returns (no feedback recorded) when table is empty', async () => {
    const route = findTool('devlog_feedback_route');
    const res = await route.handler({});
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toMatch(/no feedback/i);
  });

  it('confident=false when n < min_samples', async () => {
    const route = findTool('devlog_feedback_route');

    insertRow(db, 'agent1', 'rare_tool', 'success', "datetime('now','-1 day')");

    const res = await route.handler({ tool_name: 'rare_tool', min_samples: 5 });
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toMatch(/confident=false/i);
  });
});
