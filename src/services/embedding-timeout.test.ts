import { EmbeddingService } from './embedding-service.js';

describe('EmbeddingService timeout', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.OLLAMA_TIMEOUT_MS;
  });

  it('rejects quickly when the endpoint hangs (no indefinite wait)', async () => {
    process.env.OLLAMA_TIMEOUT_MS = '50';
    // A fetch that never resolves on its own — only an abort signal ends it.
    globalThis.fetch = ((_url: string, opts: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      })) as unknown as typeof fetch;

    const svc = new EmbeddingService('http://10.255.255.1:11434'); // unroutable
    const started = Date.now();
    await expect(svc.embed('hello world')).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1000); // failed fast, not hung
  });
});
