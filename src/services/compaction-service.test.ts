import { CompactionService } from './compaction-service.js';
import Database from 'better-sqlite3';

describe('CompactionService', () => {
  let db: Database.Database;
  let service: CompactionService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        status TEXT DEFAULT 'active',
        started_at TEXT DEFAULT CURRENT_TIMESTAMP,
        ended_at TEXT,
        summary TEXT,
        metadata_json TEXT
      );
      CREATE TABLE conversation_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        ai_model TEXT NOT NULL,
        summary TEXT NOT NULL,
        token_count INTEGER,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
    service = new CompactionService(db);
  });

  afterEach(() => db.close());

  test('needsCompaction returns false when under threshold', () => {
    expect(service.needsCompaction('session1')).toBe(false);
  });

  test('needsCompaction returns true when over threshold', () => {
    db.prepare('INSERT INTO sessions (id, status) VALUES (?, ?)').run('s1', 'active');
    db.prepare(`
      INSERT INTO conversation_summaries (session_id, ai_model, summary, token_count, started_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('s1', 'claude', 'test', 50000, new Date().toISOString());
    expect(service.needsCompaction('s1')).toBe(true);
  });

  test('needsCompaction ignores already-compacted rows (no self-retrigger)', () => {
    db.prepare('INSERT INTO sessions (id, status) VALUES (?, ?)').run('s1', 'active');
    // A single compacted row larger than the threshold must NOT trigger.
    db.prepare(`
      INSERT INTO conversation_summaries (session_id, ai_model, summary, token_count, started_at, compacted)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run('s1', 'compaction', 'merged history', 99999, new Date().toISOString());
    expect(service.needsCompaction('s1')).toBe(false);
  });

  test('preFlush writes pending state before compaction', () => {
    db.prepare('INSERT INTO sessions (id, status) VALUES (?, ?)').run('s1', 'active');
    service.preFlush('s1');
    const session = db.prepare('SELECT metadata_json FROM sessions WHERE id = ?').get('s1') as { metadata_json: string };
    const meta = JSON.parse(session.metadata_json);
    expect(meta.preFlushAt).toBeTruthy();
    expect(meta.compactionPending).toBe(true);
  });

  test('compact creates summary and clears pending state', async () => {
    db.prepare('INSERT INTO sessions (id, status) VALUES (?, ?)').run('s1', 'active');
    db.prepare(`
      INSERT INTO conversation_summaries (session_id, ai_model, summary, token_count, started_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('s1', 'claude', 'Discussed auth system design', 30000, new Date().toISOString());
    db.prepare(`
      INSERT INTO conversation_summaries (session_id, ai_model, summary, token_count, started_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('s1', 'claude', 'Reviewed database schema', 25000, new Date().toISOString());

    const result = await service.compact('s1');
    expect(result.compactedSummaries).toBe(2);
    expect(result.compactedTokens).toBe(55000);

    const session = db.prepare('SELECT summary, metadata_json FROM sessions WHERE id = ?').get('s1') as { summary: string; metadata_json: string };
    expect(session.summary).toBeTruthy();
    const meta = JSON.parse(session.metadata_json);
    expect(meta.compactionPending).toBeFalsy();
  });

  test('compact deletes merged source summaries to bound growth (BUG-22)', async () => {
    db.prepare('INSERT INTO sessions (id, status) VALUES (?, ?)').run('s-del', 'active');
    const insert = db.prepare(`
      INSERT INTO conversation_summaries (session_id, ai_model, summary, token_count, started_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    insert.run('s-del', 'claude', 'Summary A', 10000, new Date(Date.now() - 3000).toISOString());
    insert.run('s-del', 'claude', 'Summary B', 10000, new Date(Date.now() - 2000).toISOString());
    insert.run('s-del', 'claude', 'Summary C', 10000, new Date(Date.now() - 1000).toISOString());

    const countBefore = (db.prepare(
      'SELECT COUNT(*) c FROM conversation_summaries WHERE session_id = ?'
    ).get('s-del') as { c: number }).c;
    expect(countBefore).toBe(3);

    await service.compact('s-del');

    // The 3 source rows are merged into exactly ONE retained compacted row
    // (growth bounded), which stays in the recall corpus.
    const rows = db.prepare(
      'SELECT summary, compacted FROM conversation_summaries WHERE session_id = ?'
    ).all('s-del') as Array<{ summary: string; compacted: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].compacted).toBe(1);
    expect(rows[0].summary).toMatch(/Summary A/);
    expect(rows[0].summary).toMatch(/Summary B/);
    expect(rows[0].summary).toMatch(/Summary C/);

    // The merged text must also be stored on the session row.
    const session = db.prepare('SELECT summary FROM sessions WHERE id = ?')
      .get('s-del') as { summary: string };
    expect(session.summary).toMatch(/Summary A/);
    expect(session.summary).toMatch(/Summary C/);

    // And the retained compacted row must NOT re-trigger compaction.
    expect(service.needsCompaction('s-del')).toBe(false);
  });

  test('re-compaction folds the prior merged row into a new single row', async () => {
    db.prepare('INSERT INTO sessions (id, status) VALUES (?, ?)').run('s-fold', 'active');
    const insert = db.prepare(`
      INSERT INTO conversation_summaries (session_id, ai_model, summary, token_count, started_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    insert.run('s-fold', 'claude', 'first batch', 45000, '2026-01-01T00:00:00Z');
    await service.compact('s-fold'); // -> 1 compacted row

    // New summaries pile on top and exceed the threshold again.
    insert.run('s-fold', 'claude', 'second batch', 45000, '2026-02-01T00:00:00Z');
    expect(service.needsCompaction('s-fold')).toBe(true);
    await service.compact('s-fold');

    const rows = db.prepare(
      'SELECT summary, compacted FROM conversation_summaries WHERE session_id = ?'
    ).all('s-fold') as Array<{ summary: string; compacted: number }>;
    expect(rows).toHaveLength(1); // prior merged row folded in
    expect(rows[0].summary).toMatch(/first batch/);
    expect(rows[0].summary).toMatch(/second batch/);
    expect(service.needsCompaction('s-fold')).toBe(false);
  });

  test('compact with no summaries is a no-op (empty session)', async () => {
    db.prepare('INSERT INTO sessions (id, status) VALUES (?, ?)').run('s-empty', 'active');

    // Should not throw.
    await expect(service.compact('s-empty')).resolves.toMatchObject({
      compactedSummaries: 0,
      compactedTokens: 0,
    });

    const count = (db.prepare(
      'SELECT COUNT(*) c FROM conversation_summaries WHERE session_id = ?'
    ).get('s-empty') as { c: number }).c;
    expect(count).toBe(0);
  });

  test('recoverPending returns sessions with pending compaction', () => {
    db.prepare('INSERT INTO sessions (id, status, metadata_json) VALUES (?, ?, ?)').run(
      's1', 'active', JSON.stringify({ compactionPending: true })
    );
    db.prepare('INSERT INTO sessions (id, status, metadata_json) VALUES (?, ?, ?)').run(
      's2', 'active', JSON.stringify({ compactionPending: false })
    );
    db.prepare('INSERT INTO sessions (id, status) VALUES (?, ?)').run('s3', 'active');

    const pending = service.recoverPending();
    expect(pending).toEqual(['s1']);
  });
});
