import Database from 'better-sqlite3';
import { ensureEpisodicEmbeddingColumn, ensureCompactedColumn } from './episodic-tables.js';

it('adds summary_embedding column idempotently', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE conversation_summaries (id INTEGER PRIMARY KEY, summary TEXT);`);

  ensureEpisodicEmbeddingColumn(db);
  ensureEpisodicEmbeddingColumn(db); // second call must not throw

  const cols = db
    .prepare(`PRAGMA table_info(conversation_summaries)`)
    .all() as Array<{ name: string }>;
  expect(cols.some((c) => c.name === 'summary_embedding')).toBe(true);
});

it('adds compacted column idempotently', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE conversation_summaries (id INTEGER PRIMARY KEY, summary TEXT);`);

  ensureCompactedColumn(db);
  ensureCompactedColumn(db); // idempotent

  const cols = db
    .prepare(`PRAGMA table_info(conversation_summaries)`)
    .all() as Array<{ name: string }>;
  expect(cols.some((c) => c.name === 'compacted')).toBe(true);
});
