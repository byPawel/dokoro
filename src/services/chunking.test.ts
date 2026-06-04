import { ChunkingService } from './embedding-service.js';

// Helper: generate lines that exceed the 2000-token (8000 char) whole-file threshold
// Each line ~115 chars, so 80 lines ~= 9200 chars ~= 2300 tokens (above 2000 threshold)
const makeLargeLines = (count: number, pad: string = 'x'): string[] =>
  Array.from({ length: count }, (_, i) => `Line ${i}: ${pad.repeat(100)}`);

describe('ChunkingService - Line-Aware Sliding Windows', () => {
  let chunker: ChunkingService;

  beforeEach(() => {
    chunker = new ChunkingService();
  });

  test('small doc returns single chunk', () => {
    const content = '# Title\n\nShort content here.';
    const chunks = chunker.chunk(content, 'doc1');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(content);
  });

  test('chunks split at line boundaries, not mid-line', () => {
    const lines = makeLargeLines(80);
    const content = lines.join('\n');
    const chunks = chunker.chunk(content, 'doc2');

    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.text.endsWith('\n')).toBe(true);
    }
  });

  test('chunks have overlap', () => {
    const lines = makeLargeLines(80);
    const content = lines.join('\n');
    const chunks = chunker.chunk(content, 'doc3');

    if (chunks.length >= 2) {
      const chunk0Lines = chunks[0].text.split('\n').filter(Boolean);
      const chunk1Lines = chunks[1].text.split('\n').filter(Boolean);
      const overlap = chunk0Lines.filter(l => chunk1Lines.includes(l));
      expect(overlap.length).toBeGreaterThan(0);
    }
  });

  test('preserves markdown header context per chunk', () => {
    const content = [
      '# Main Title',
      '',
      'Intro text.',
      '',
      '## Section A',
      '',
      ...Array.from({ length: 80 }, (_, i) => `A content ${i}: ${'y'.repeat(100)}`),
      '',
      '## Section B',
      '',
      ...Array.from({ length: 80 }, (_, i) => `B content ${i}: ${'z'.repeat(100)}`),
    ].join('\n');

    const chunks = chunker.chunk(content, 'doc4');
    expect(chunks.length).toBeGreaterThan(1);

    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.headerContext).toBeTruthy();
  });

  test('chunk token counts are within expected range', () => {
    const lines = makeLargeLines(200);
    const content = lines.join('\n');
    const chunks = chunker.chunk(content, 'doc5');

    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(700);
      expect(chunk.tokenCount).toBeGreaterThan(200);
    }
  });
});
