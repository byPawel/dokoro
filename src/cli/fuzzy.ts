/**
 * Tiny fuzzy matcher for the browse TUI item filter. NO ink imports.
 *
 * Scoring contract (locked by the planning council):
 *  - exact substring beats ANY subsequence match (base 1000),
 *  - earlier match position and word-boundary starts score higher,
 *  - scattered subsequences below a threshold are hidden (null),
 *  - empty query = no filtering, original order preserved.
 */

/** Works on a plain string (UTF-16 unit index) or a codepoint array. */
function isBoundary(target: ArrayLike<string>, index: number): boolean {
  return index === 0 || /[^a-z0-9]/.test(target[index - 1]);
}

/** Match score for `query` in `target`, or null when it shouldn't be shown. */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q === '') return 0;

  const idx = t.indexOf(q);
  if (idx >= 0) {
    return 1000 + (isBoundary(t, idx) ? 100 : 0) - Math.min(idx, 99);
  }

  // Spread to codepoint arrays so non-BMP chars (emoji) compare as whole
  // codepoints instead of UTF-16 surrogate halves.
  const qChars = [...q];
  const tChars = [...t];
  let score = 0;
  let ti = 0;
  let lastMatch = -2;
  for (const ch of qChars) {
    let found = -1;
    while (ti < tChars.length) {
      if (tChars[ti] === ch) { found = ti; ti++; break; }
      ti++;
    }
    if (found === -1) return null;
    score += found === lastMatch + 1 ? 5 : 1;
    if (isBoundary(tChars, found)) score += 3;
    lastMatch = found;
  }
  // Junk guard: a scattered match must average better than bare hits.
  return score >= qChars.length * 2 ? score : null;
}

/** Filter+rank a list. Empty query returns the input array unchanged. */
export function fuzzyFilter<T>(items: T[], query: string, key: (item: T) => string): T[] {
  if (query === '') return items;
  return items
    .map((item, i) => ({ item, i, score: fuzzyScore(query, key(item)) }))
    .filter((s): s is { item: T; i: number; score: number } => s.score !== null)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((s) => s.item);
}
