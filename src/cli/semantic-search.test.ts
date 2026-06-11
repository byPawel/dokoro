import { afterEach, describe, expect, it, jest } from '@jest/globals';

describe('semanticSearchItems', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../services/vector-service.js');
    jest.dontMock('../db/index.js');
  });

  it('maps results to BrowseItems by filepath and skips entries without one', async () => {
    jest.doMock('../services/vector-service.js', () => ({
      createVectorServices: () => ({
        searchService: {
          search: async () => [
            { docId: 'd1', filepath: 'dokoro/daily/2026-06-10-x.md', title: 'X', score: 0.42, source: 'hybrid' },
            { docId: 'd2', filepath: '', title: 'no-path', score: 0.1, source: 'keyword' },
          ],
        },
      }),
    }));
    jest.doMock('../db/index.js', () => ({ getSqliteDb: () => ({}) }));
    const { semanticSearchItems, resetSemanticCooldown } = await import('./semantic-search.js');
    resetSemanticCooldown();

    const out = await semanticSearchItems('/proj', 'query');
    expect(out.ok).toBe(true);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      kind: 'file',
      label: 'X',
      path: '/proj/dokoro/daily/2026-06-10-x.md',
    });
    expect(out.items[0].sublabel).toContain('hybrid');
  });

  it('failure trips the cooldown breaker; next call degrades instantly', async () => {
    jest.doMock('../services/vector-service.js', () => ({
      createVectorServices: () => ({
        searchService: { search: async () => { throw new Error('ollama down'); } },
      }),
    }));
    jest.doMock('../db/index.js', () => ({ getSqliteDb: () => ({}) }));
    const { semanticSearchItems, resetSemanticCooldown } = await import('./semantic-search.js');
    resetSemanticCooldown();

    const first = await semanticSearchItems('/proj', 'q');
    expect(first.ok).toBe(false);
    expect(first.note).toContain('ollama down');

    const second = await semanticSearchItems('/proj', 'q');
    expect(second.ok).toBe(false);
    expect(second.note).toContain('cooling down');
  });
});
