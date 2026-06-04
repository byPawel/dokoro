import { jest } from '@jest/globals';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

const TMP_PROJECT = path.join(os.tmpdir(), 'dokoro-lazy-test');
afterAll(() => {
  fs.rmSync(TMP_PROJECT, { recursive: true, force: true });
});

/**
 * Guards the "slim install" contract:
 *   1. The embedding/chunking surface (embedding-service.ts) must NOT require
 *      @lancedb/lancedb at module load — it lives in optionalDependencies.
 *   2. VectorStoreService must lazy-load @lancedb/lancedb only when used, and
 *      surface a clear install hint when the optional dep is missing.
 */

// Mock @lancedb/lancedb as if it were not installed. embedding-service.ts must
// never touch this module; vector-service.ts only touches it via dynamic import
// inside VectorStoreService.init().
jest.mock(
  '@lancedb/lancedb',
  () => {
    const err = new Error("Cannot find module '@lancedb/lancedb'") as Error & { code?: string };
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  },
  { virtual: true },
);

describe('embedding-service does not require @lancedb/lancedb', () => {
  it('instantiates EmbeddingService and ChunkingService without loading lancedb', async () => {
    const mod = await import('./embedding-service.js');
    const embed = new mod.EmbeddingService();
    const chunker = new mod.ChunkingService();
    expect(embed).toBeInstanceOf(mod.EmbeddingService);
    expect(chunker).toBeInstanceOf(mod.ChunkingService);
    // ChunkingService works fully without the native module.
    const chunks = chunker.chunk('# Title\n\nbody', 'doc1');
    expect(chunks).toHaveLength(1);
  });
});

describe('VectorStoreService lazy-loads lancedb', () => {
  it('constructs without lancedb present', async () => {
    const mod = await import('./vector-service.js');
    // Constructor must not load the native module.
    expect(() => new mod.VectorStoreService(TMP_PROJECT)).not.toThrow();
  });

  it('init() throws a descriptive install-instructions error when lancedb is missing', async () => {
    const mod = await import('./vector-service.js');
    const store = new mod.VectorStoreService(TMP_PROJECT);
    await expect(store.init()).rejects.toThrow(
      /npm install @lancedb\/lancedb apache-arrow/,
    );
  });
});
