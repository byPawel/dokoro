/**
 * TDD tests for Task 7: auto-record tool outcomes into agent_feedback
 * via withToolTracking in src/utils/tool-tracker.ts
 *
 * Spec:
 * - wrap a resolving handler → agent_feedback row with outcome='success' and numeric latency_ms
 * - wrap a throwing handler → agent_feedback row with outcome='failure' AND error still propagates
 * - DEVLOG_AUTO_FEEDBACK=false skips recording
 */
import Database from 'better-sqlite3';
import { jest } from '@jest/globals';
import { ensureAgentFeedbackTable } from '../db/agent-feedback.js';

// Mock db/index.js so getSqliteDb returns our test db
jest.mock('../db/index.js', () => ({
  getSqliteDb: () => {
    const testDb = (globalThis as Record<string, unknown>).__TEST_DB__ as Database.Database | undefined;
    if (!testDb) throw new Error('No __TEST_DB__ set');
    return testDb;
  },
}));

// Import withToolTracking AFTER mock is registered
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { withToolTracking } = require('../utils/tool-tracker.js') as typeof import('../utils/tool-tracker.js');

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

describe('withToolTracking auto-feedback', () => {
  let db: Database.Database;
  const origEnv = process.env.DEVLOG_AUTO_FEEDBACK;

  beforeEach(() => {
    db = setupDb();
    (globalThis as Record<string, unknown>).__TEST_DB__ = db;
    // Ensure auto-feedback is enabled by default
    delete process.env.DEVLOG_AUTO_FEEDBACK;
  });

  afterEach(() => {
    db.close();
    delete (globalThis as Record<string, unknown>).__TEST_DB__;
    if (origEnv !== undefined) {
      process.env.DEVLOG_AUTO_FEEDBACK = origEnv;
    } else {
      delete process.env.DEVLOG_AUTO_FEEDBACK;
    }
  });

  it('records outcome=success with numeric latency_ms when handler resolves', async () => {
    const handler = async (..._args: unknown[]) => ({ content: [{ type: 'text' as const, text: 'ok' }] });
    const tracked = withToolTracking('test_tool', handler);

    await tracked({});

    const row = db.prepare(`SELECT outcome, latency_ms FROM agent_feedback WHERE tool_name = ?`)
      .get('test_tool') as { outcome: string; latency_ms: number } | undefined;

    expect(row).toBeDefined();
    expect(row!.outcome).toBe('success');
    expect(typeof row!.latency_ms).toBe('number');
    expect(row!.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('records outcome=failure when handler throws, AND the error still propagates', async () => {
    const boom = new Error('handler exploded');
    const handler = async (..._args: unknown[]) => { throw boom; };
    const tracked = withToolTracking('failing_tool', handler);

    await expect(tracked({})).rejects.toThrow('handler exploded');

    const row = db.prepare(`SELECT outcome, latency_ms FROM agent_feedback WHERE tool_name = ?`)
      .get('failing_tool') as { outcome: string; latency_ms: number } | undefined;

    expect(row).toBeDefined();
    expect(row!.outcome).toBe('failure');
    expect(typeof row!.latency_ms).toBe('number');
  });

  it('records outcome=failure when handler RETURNS { isError: true }, and result is still returned (not thrown)', async () => {
    const errResult = { isError: true, content: [{ type: 'text' as const, text: 'boom' }] };
    const handler = async (..._args: unknown[]) => errResult;
    const tracked = withToolTracking('soft_fail_tool', handler);

    // Must resolve (not reject) and return the result unchanged
    const returned = await tracked({});
    expect(returned).toBe(errResult);

    const row = db.prepare(`SELECT outcome, latency_ms FROM agent_feedback WHERE tool_name = ?`)
      .get('soft_fail_tool') as { outcome: string; latency_ms: number } | undefined;

    expect(row).toBeDefined();
    expect(row!.outcome).toBe('failure');
    expect(typeof row!.latency_ms).toBe('number');
  });

  it('skips recording when DEVLOG_AUTO_FEEDBACK=false', async () => {
    process.env.DEVLOG_AUTO_FEEDBACK = 'false';

    const handler = async (..._args: unknown[]) => ({ content: [{ type: 'text' as const, text: 'ok' }] });
    const tracked = withToolTracking('opt_out_tool', handler);

    await tracked({});

    const n = db.prepare(`SELECT COUNT(*) AS n FROM agent_feedback WHERE tool_name = ?`)
      .get('opt_out_tool') as { n: number };
    expect(n.n).toBe(0);
  });
});
