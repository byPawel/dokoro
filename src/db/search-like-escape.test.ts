/**
 * BUG-25: LIKE wildcard escaping in searchDocs
 *
 * Verifies that '%' and '_' characters in the search query are treated as
 * literals, not as LIKE wildcards.  We cannot import src/db/index.ts directly
 * (import.meta.url fails under ts-jest's CJS transform), so we test the
 * escaping helper + LIKE behaviour directly using better-sqlite3.
 *
 * The logic under test mirrors the escape applied in searchDocs:
 *   query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
 * followed by LIKE <pattern> ESCAPE '\'
 */

import Database from 'better-sqlite3';

/** Mirrors the escaping applied in src/db/index.ts searchDocs() (BUG-25). */
function escapeForLike(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function makeLikePattern(raw: string): string {
  return `%${escapeForLike(raw)}%`;
}

describe('searchDocs LIKE wildcard escaping (BUG-25)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE docs (id INTEGER PRIMARY KEY, title TEXT NOT NULL, content TEXT);
      INSERT INTO docs (title, content) VALUES
        ('100% reliable',    'all good'),
        ('axxb matching',    'wildcard test'),
        ('price_tag report', 'underscore test'),
        ('plain title',      'nothing special');
    `);
  });

  afterEach(() => db.close());

  it('a query containing "%" matches only the literal "%" row, not all rows', () => {
    const pattern = makeLikePattern('%');
    const rows = db.prepare(`SELECT title FROM docs WHERE title LIKE ? ESCAPE '\\'`).all(pattern) as { title: string }[];
    const titles = rows.map((r) => r.title);
    expect(titles).toContain('100% reliable');
    expect(titles).not.toContain('plain title');
    expect(titles).not.toContain('axxb matching');
  });

  it('a query "a%b" does NOT match "axxb" (wildcard is neutralised)', () => {
    const pattern = makeLikePattern('a%b');
    const rows = db.prepare(`SELECT title FROM docs WHERE title LIKE ? ESCAPE '\\'`).all(pattern) as { title: string }[];
    const titles = rows.map((r) => r.title);
    expect(titles).not.toContain('axxb matching');
  });

  it('a query containing "_" matches only the literal "_" row', () => {
    const pattern = makeLikePattern('_');
    const rows = db.prepare(`SELECT title FROM docs WHERE title LIKE ? ESCAPE '\\'`).all(pattern) as { title: string }[];
    const titles = rows.map((r) => r.title);
    expect(titles).toContain('price_tag report');
    expect(titles).not.toContain('plain title');
  });

  it('normal query without special chars still matches normally', () => {
    const pattern = makeLikePattern('plain');
    const rows = db.prepare(`SELECT title FROM docs WHERE title LIKE ? ESCAPE '\\'`).all(pattern) as { title: string }[];
    const titles = rows.map((r) => r.title);
    expect(titles).toContain('plain title');
    expect(titles).not.toContain('100% reliable');
  });
});
