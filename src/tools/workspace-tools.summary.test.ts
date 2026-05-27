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

// Deterministic, offline embedder — session_summary_add / session_recall call
// EmbeddingService; without this mock the test makes a real network call to
// Ollama, which hangs on hosts that drop (rather than refuse) the connection.
jest.mock('../services/vector-service.js', () => ({
  EmbeddingService: class {
    async embed(): Promise<{ embedding: number[]; tokenCount: number }> {
      return { embedding: [1, 0, 0], tokenCount: 1 };
    }
  },
}));

// Import after mock is registered (require style matches recall.test.ts)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { workspaceTools } = require('./workspace-tools.js') as typeof import('./workspace-tools.js');

describe('devlog_session_summary_add', () => {
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
  });

  afterEach(() => {
    db.close();
    delete (globalThis as { __TEST_DB__?: Database.Database }).__TEST_DB__;
  });

  it('session_summary_add inserts a row that session_recall returns', async () => {
    const add = workspaceTools.find(t => t.name === 'devlog_session_summary_add')!;
    expect(add).toBeDefined();
    await add.handler({ session_id: 's1', ai_model: 'claude-opus-4-7', summary: 'fixed login race', message_count: 10 });
    const recall = workspaceTools.find(t => t.name === 'devlog_session_recall')!;
    const res = await recall.handler({ query: 'login' });
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toMatch(/fixed login race/);
  });
});
