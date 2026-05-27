import Database from 'better-sqlite3';
import { CompactionService } from './compaction-service.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, summary TEXT, metadata_json TEXT);
    CREATE TABLE conversation_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ai_model TEXT,
      summary TEXT, token_count INTEGER, started_at TEXT
    );
  `);
  return db;
}

it('recoverAll re-compacts every session left mid-compaction', async () => {
  const db = makeDb();
  db.prepare('INSERT INTO sessions (id, metadata_json) VALUES (?, ?)').run(
    's1',
    JSON.stringify({ compactionPending: true }),
  );
  db.prepare(
    'INSERT INTO conversation_summaries (session_id, ai_model, summary, token_count, started_at) VALUES (?,?,?,?,?)',
  ).run('s1', 'opus', 'orphaned chunk', 100, '2026-05-27T00:00:00Z');

  const svc = new CompactionService(db);
  const recovered = await svc.recoverAll();

  expect(recovered).toEqual(['s1']);
  const session = db
    .prepare('SELECT summary, metadata_json FROM sessions WHERE id = ?')
    .get('s1') as { summary: string; metadata_json: string };
  expect(session.summary).toContain('orphaned chunk');
  expect(JSON.parse(session.metadata_json).compactionPending).toBeUndefined();
});

it('does not overwrite an existing summary when no source rows remain', async () => {
  const db = makeDb();
  // Stale pending flag, prior compacted summary present, but the source rows
  // were already removed — compaction must NOT clobber the summary with ''.
  db.prepare('INSERT INTO sessions (id, summary, metadata_json) VALUES (?, ?, ?)').run(
    's1',
    'previously compacted history',
    JSON.stringify({ compactionPending: true }),
  );

  const recovered = await new CompactionService(db).recoverAll();

  expect(recovered).toEqual(['s1']);
  const session = db
    .prepare('SELECT summary, metadata_json FROM sessions WHERE id = ?')
    .get('s1') as { summary: string; metadata_json: string };
  expect(session.summary).toBe('previously compacted history'); // untouched
  expect(JSON.parse(session.metadata_json).compactionPending).toBeUndefined();
});
