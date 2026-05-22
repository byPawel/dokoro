import Database from 'better-sqlite3';
import { jest } from '@jest/globals';

jest.mock('../db/index.js', () => ({
  getSqliteDb: () => {
    const test = (globalThis as { __TEST_DB__?: Database.Database }).__TEST_DB__;
    if (test) return test;
    throw new Error('test DB not set');
  },
  ensureVectorTables: () => {},
}));

// Mock ESM-only modules that chalk/ink bring in and break ts-jest CJS transform
jest.mock('../utils/render-output.js', () => ({
  renderOutput: (data: unknown) => JSON.stringify(data),
}));
jest.mock('../utils/color-setup.js', () => ({}));

// Import after mock is registered (require style matches feedback-tools.test.ts)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { workspaceTools } = require('./workspace-tools.js') as typeof import('./workspace-tools.js');

describe('devlog_session_recall', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    (globalThis as { __TEST_DB__?: Database.Database }).__TEST_DB__ = db;

    db.prepare(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL
      )
    `).run();
    db.prepare(`
      CREATE TABLE conversation_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        ai_model TEXT NOT NULL,
        summary TEXT NOT NULL,
        key_decisions_json TEXT,
        key_topics_json TEXT,
        linked_docs_json TEXT,
        message_count INTEGER,
        token_count INTEGER,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    db.prepare(`INSERT INTO sessions (id, started_at, status) VALUES ('s1', datetime('now','-2 days'), 'completed')`).run();
    db.prepare(`
      INSERT INTO conversation_summaries
        (session_id, ai_model, summary, message_count, token_count, started_at)
      VALUES ('s1', 'claude-opus-4-7', 'decided to use bi-temporal facts', 42, 3000, datetime('now','-2 days'))
    `).run();
  });

  afterEach(() => {
    db.close();
    delete (globalThis as { __TEST_DB__?: Database.Database }).__TEST_DB__;
  });

  it('returns recent session summaries', async () => {
    const tool = workspaceTools.find((t: { name: string }) => t.name === 'devlog_session_recall');
    expect(tool).toBeDefined();
    const res = await tool!.handler({ limit: 5 });
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toMatch(/bi-temporal facts/);
    expect(text).toMatch(/claude-opus-4-7/);
  });

  it('filters by query substring', async () => {
    const tool = workspaceTools.find((t: { name: string }) => t.name === 'devlog_session_recall');
    expect(tool).toBeDefined();
    const res = await tool!.handler({ query: 'nonexistent-token' });
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toMatch(/no past sessions/i);
  });
});
