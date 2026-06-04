import { EmbeddingService, ChunkingService } from './embedding-service.js';

describe('embedding-service module', () => {
  it('exports a constructable EmbeddingService', () => {
    const svc = new EmbeddingService();
    expect(svc).toBeInstanceOf(EmbeddingService);
    expect(typeof svc.embed).toBe('function');
  });

  it('exports a constructable ChunkingService', () => {
    const chunker = new ChunkingService();
    expect(chunker).toBeInstanceOf(ChunkingService);
    expect(typeof chunker.chunk).toBe('function');
  });
});
