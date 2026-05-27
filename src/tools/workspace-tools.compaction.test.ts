import Database from 'better-sqlite3';
import { workspaceTools } from './workspace-tools.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, summary TEXT, metadata_json TEXT);
    CREATE TABLE conversation_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT, ai_model TEXT, summary TEXT,
      key_decisions_json TEXT, key_topics_json TEXT,
      message_count INTEGER, token_count INTEGER,
      started_at TEXT, ended_at TEXT
    );
  `);
  db.prepare('INSERT INTO sessions (id) VALUES (?)').run('s1');
  return db;
}

const summaryAdd = workspaceTools.find((t) => t.name === 'devlog_session_summary_add')!;

describe('session_summary_add auto-compaction', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__TEST_DB__;
  });

  it('compacts the session once cumulative tokens exceed the threshold', async () => {
    const db = makeDb();
    (globalThis as Record<string, unknown>).__TEST_DB__ = db;

    // Two summaries of 25k tokens each => 50k > 40k threshold.
    for (const i of [1, 2]) {
      await summaryAdd.handler({
        session_id: 's1',
        ai_model: 'opus',
        summary: `chunk ${i}`,
        token_count: 25000,
      });
    }

    const remaining = db
      .prepare('SELECT COUNT(*) AS n FROM conversation_summaries WHERE session_id = ?')
      .get('s1') as { n: number };
    const session = db
      .prepare('SELECT summary FROM sessions WHERE id = ?')
      .get('s1') as { summary: string | null };

    expect(remaining.n).toBe(0); // source rows merged away
    expect(session.summary).toContain('chunk 1'); // collapsed into sessions.summary
    expect(session.summary).toContain('chunk 2');
  });

  it('does NOT compact below the threshold', async () => {
    const db = makeDb();
    (globalThis as Record<string, unknown>).__TEST_DB__ = db;
    await summaryAdd.handler({
      session_id: 's1',
      ai_model: 'opus',
      summary: 'small',
      token_count: 100,
    });
    const remaining = db
      .prepare('SELECT COUNT(*) AS n FROM conversation_summaries')
      .get() as { n: number };
    expect(remaining.n).toBe(1);
  });
});
