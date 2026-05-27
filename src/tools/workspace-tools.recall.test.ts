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

// Deterministic, offline embedder: query always embeds to [1,0,0]. Avoids
// loading LanceDB and hitting Ollama in tests.
jest.mock('../services/vector-service.js', () => ({
  EmbeddingService: class {
    async embed(): Promise<{ embedding: number[]; tokenCount: number }> {
      return { embedding: [1, 0, 0], tokenCount: 1 };
    }
  },
}));

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
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        summary_embedding BLOB
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

  it('ranks semantically when a query embeds; closest summary comes first', async () => {
    // Float64-packed [0,1,0] and [1,0,0]; mocked query embeds to [1,0,0].
    const blob = (v: number[]) => Buffer.from(new Float64Array(v).buffer);
    // "databases" is MORE RECENT, so plain recency order would rank it first.
    db.prepare(
      `INSERT INTO conversation_summaries (session_id, ai_model, summary, started_at, summary_embedding) VALUES (?,?,?,?,?)`,
    ).run('d1', 'claude-opus-4-7', 'about databases', '2026-01-02T00:00:00Z', blob([0, 1, 0]));
    db.prepare(
      `INSERT INTO conversation_summaries (session_id, ai_model, summary, started_at, summary_embedding) VALUES (?,?,?,?,?)`,
    ).run('d2', 'claude-opus-4-7', 'about caching', '2026-01-01T00:00:00Z', blob([1, 0, 0]));

    const tool = workspaceTools.find((t: { name: string }) => t.name === 'devlog_session_recall');
    // Substring filter must match both candidates so semantic rank decides order.
    const res = await tool!.handler({ query: 'about' });
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
    expect(text.indexOf('about caching')).toBeLessThan(text.indexOf('about databases'));
  });

  it('surfaces an older semantically-relevant summary outside the recency window', async () => {
    const blob = (v: number[]) => Buffer.from(new Float64Array(v).buffer);
    const ins = db.prepare(
      `INSERT INTO conversation_summaries (session_id, ai_model, summary, started_at, summary_embedding) VALUES (?,?,?,?,?)`,
    );
    // 11 RECENT but semantically-irrelevant rows ([0,1,0], orthogonal to query [1,0,0]).
    for (let i = 0; i < 11; i++) {
      ins.run(`noise${i}`, 'opus', `about noise ${i}`, `2026-03-${10 + i}T00:00:00Z`, blob([0, 1, 0]));
    }
    // 1 OLD but highly-relevant row ([1,0,0] == query). With limit=5 and recency-first
    // truncation this would be dropped before ranking; correct semantic recall keeps it.
    ins.run('gold', 'opus', 'about caching internals', '2026-01-01T00:00:00Z', blob([1, 0, 0]));

    const tool = workspaceTools.find((t: { name: string }) => t.name === 'devlog_session_recall');
    const res = await tool!.handler({ query: 'about', limit: 5 });
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('about caching internals'); // not lost to the recency window
    expect(text.indexOf('about caching internals')).toBe(text.indexOf('about')); // ranked first
  });
});
