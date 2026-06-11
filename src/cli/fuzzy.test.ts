import { describe, expect, it } from '@jest/globals';
import { fuzzyScore, fuzzyFilter } from './fuzzy.js';

describe('fuzzyScore', () => {
  it('returns null when characters are missing', () => {
    expect(fuzzyScore('xyz', 'abc')).toBeNull();
  });

  it('ranks exact substring above any subsequence match', () => {
    const exact = fuzzyScore('plan', 'my-plan-file');
    const subseq = fuzzyScore('plan', 'p-l-a-n-scattered');
    expect(exact).not.toBeNull();
    expect(subseq).not.toBeNull();
    expect(exact as number).toBeGreaterThan(subseq as number);
  });

  it('prefers word-boundary substring starts', () => {
    const boundary = fuzzyScore('plan', 'daily plan');
    const embedded = fuzzyScore('plan', 'aeroplane');
    expect(boundary as number).toBeGreaterThan(embedded as number);
  });

  it('is case-insensitive', () => {
    expect(fuzzyScore('PLAN', 'my-plan')).toEqual(fuzzyScore('plan', 'MY-PLAN'));
  });

  it('returns 0 for an empty query', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('matches non-BMP characters (emoji) as whole codepoints', () => {
    expect(fuzzyScore('🎉x', 'a🎉x')).not.toBeNull();
    // Forces the subsequence path: '🎉x' is not a contiguous substring here.
    expect(fuzzyScore('🎉x', '🎉zzzx')).not.toBeNull();
  });

  it('subsequence boundary bonus increases score', () => {
    const withBoundary = fuzzyScore('pn', 'p-note');
    const withoutBoundary = fuzzyScore('pn', 'xp-note');
    expect(withBoundary as number).toBeGreaterThan(withoutBoundary as number);
  });

  it('hides weak scattered matches below the threshold', () => {
    // 'a' at idx 2 preceded by 'x' (no boundary), 'e' at idx 6 preceded by 'x',
    // not consecutive → 1+1=2 < 4 → null (threshold is q.length * 2 = 4)
    expect(fuzzyScore('ae', 'xxaxxxexx')).toBeNull();
  });
});

describe('fuzzyFilter', () => {
  const items = [
    { label: 'zebra' },
    { label: 'plan-alpha' },
    { label: 'apple' },
    { label: 'p-l-a-n' },
  ];

  it('empty query returns the original array (same reference)', () => {
    expect(fuzzyFilter(items, '', (i) => i.label)).toBe(items);
  });

  it('filters and sorts by score, exact substring first', () => {
    const out = fuzzyFilter(items, 'plan', (i) => i.label);
    expect(out.map((i) => i.label)).toEqual(['plan-alpha', 'p-l-a-n']);
  });

  it('ties keep the original order (stable)', () => {
    const dup = [{ label: 'abc-1' }, { label: 'abc-2' }];
    const out = fuzzyFilter(dup, 'abc', (i) => i.label);
    expect(out.map((i) => i.label)).toEqual(['abc-1', 'abc-2']);
  });
});
