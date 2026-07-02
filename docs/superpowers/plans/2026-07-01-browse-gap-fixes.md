# Browse Gap & Friction Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the PLANNED usability gaps in `dokoro browse` — jump-to-category, JSON dump, position counters, sort/filter/undo, NO_COLOR, a DB-poll short-circuit, an entities view, and the first TUI smoke tests — without touching the deferred/rejected items.

**Architecture:** The browse TUI keeps its layered shape: pure, never-throwing data/action modules (`browse-data.ts`, `browse-actions.ts`, `browse-live.ts`, `markdown-ansi.ts`, `fuzzy.ts`) carry all logic and get real unit tests; the ink component (`browse-ui.tsx`) wires state and keys and is exercised only by the new smoke tests (Task 10). Every new pure export is added to an existing module (no new speculative files except the smoke test), and the CLI entrypoint (`dokoro-cli.ts`) gains flag parsing that delegates to the pure layer before any TTY/ink cost.

**Tech Stack:** TypeScript (strict, ESM with `.js` import extensions), ink@^6.6.0 + react@^19.2.3, better-sqlite3 (Drizzle elsewhere; raw SQL here), Jest 29 (`globalThis.__TEST_DB__` injection), ink-testing-library (added in Task 10).

## Global Constraints

- Node >= 22.
- Full ESM with `.js` import extensions.
- ink@^6.6.0 + react@^19.2.3.
- 2-space indent, semicolons, single quotes, explicit return types.
- Data-layer modules (browse-data/browse-live/browse-actions) must have NO ink imports and NEVER throw.
- DB access via `globalThis.__TEST_DB__` then getSqliteDb.
- Tests co-located `*.test.ts`.
- Simplest solution, no speculative abstraction.
- Implementers must reconcile exact line numbers with current file state before editing.
- Run `npx jest <file>` + `npm run build` + `npm run lint` per task.
- Commit per task with conventional-commit messages using the GitHub noreply email.

**Cross-task naming contract (use these exact identifiers):** `resolveCategoryId` (Task 2), `browseJsonDump` (Task 3), `colorsEnabled` (Task 4), `sortItems` (Task 6), `undoArchive` + `ArchiveUndoRecord` (Task 7), `dbDataVersion` (Task 8).

**Reconcile-before-editing note:** `browse-ui.tsx` was refactored to explicit mode dispatch — `useInput` computes an `InputMode` (`'confirm' | 'help' | 'search' | 'filter' | 'normal'`) and delegates to `handleConfirmInput` / `handleHelpInput` / `handleSearchInput` / `handleFilterInput` / `handleNormalInput`. `handleNormalInput` owns the per-level keys (categories/items/preview). A separate agent may still be adding `r` (release-stale-claim) and `p` (plan-transition) action keys on the items level and may extend `ConfirmState`; write against whatever shape you find, keeping the mode-dispatch and `ConfirmState`-identity patterns intact. `browse-actions.ts` already exists with `releaseClaim`, `nextPlanStatus`, `readPlanStatus`, `planTransition`.

## File Structure

- `src/cli/browse-data.ts` — add `resolveCategoryId`, `browseJsonDump`, `sortItems`, `dbDataVersion`; add the read-only `entities` category and its item/detail builder. Tasks 2, 3, 6, 8, 9.
- `src/cli/browse-actions.ts` — add `ArchiveUndoRecord` + `undoArchive`. Task 7.
- `src/cli/markdown-ansi.ts` — add `colorsEnabled` and NO_COLOR span-stripping. Task 4.
- `src/cli/browse-ui.tsx` — categories position counter, `--category` jump on mount, NO_COLOR color-gating, filter persistence, `o` sort toggle, `u` undo, help-overlay copy, `export BrowseApp`. Tasks 1, 2, 4, 5, 6, 7, 10.
- `src/dokoro-cli.ts` — parse `--category` / `--json` for `browse`, delegate to the pure layer, update `printHelp`. Tasks 2, 3.
- Tests co-located: `browse-data.test.ts` (2, 3, 6, 8, 9), `browse-actions.test.ts` (new, Task 7), `markdown-ansi.test.ts` (4), `browse-ui.test.tsx` (new, Task 10).

---

## Task 1: Categories-level position counter

Adds the `N/M` position counter (selected index / total) to the categories-level footer hint, mirroring the items-level counter. Pure `browse-ui.tsx` hint change.

**TDD exception (explicit):** there is no UI test rig until Task 10, and this is a one-line presentational hint. This is the ONE task in this plan that does not start with a failing unit test; it is verified by build + lint + a manual visual check. Every later UI-touching task still relies on pure-layer tests plus Task 10.

**Files:**
- Modify: `src/cli/browse-ui.tsx` (the `else if (level === 'categories')` hint assignment, ~line 486-487)

**Interfaces:**
- Consumes: existing `categories: BrowseCategory[] | null` and `catIndex: number` state.
- Produces: nothing new (render-only change).

- [ ] **Step 1: Add the counter to the categories hint**

Find the categories branch (currently):

```tsx
  } else if (level === 'categories') {
    hint = '↑/↓ move · enter/→ open · ? help · q/esc quit';
```

Replace those two lines with (mirrors the items-level `${filteredItems.length === 0 ? 0 : safeItemIndex + 1}/${filteredItems.length}` expression):

```tsx
  } else if (level === 'categories') {
    const catCount = categories?.length ?? 0;
    const catPos = catCount === 0 ? 0 : Math.min(catIndex, catCount - 1) + 1;
    hint = `↑/↓ move · enter/→ open · ? help · q/esc quit · ${catPos}/${catCount}`;
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS (no type errors).

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 4: Manual visual check**

Run `node dist/dokoro-cli.js browse` (or `npm run build && node dist/dokoro-cli.js browse`) in a TTY and confirm the categories-level footer ends with e.g. ` · 1/10`, incrementing as you press ↓. (No automated assertion — Task 10 adds the rig.)

- [ ] **Step 5: Commit**

```bash
git add src/cli/browse-ui.tsx
git commit -m "feat(browse): show N/M position counter at categories level"
```

---

## Task 2: `--category=<id>` jump flag

`dokoro browse --category=<id>` opens directly at that category's items level. A pure, tested `resolveCategoryId` validates the id; `runBrowse` gains an optional raw `initialCategory`; the non-TTY fallback prints that category's items instead of only counts; an invalid id toasts and stays at the categories level.

**Design note (locked):** a `--query` flag was considered and dropped — semantic search stays category-scoped via `s`, and a startup `--query` would introduce an ambiguous startup scope and pre-claim the reserved NL-query wedge.

**Files:**
- Modify: `src/cli/browse-data.ts` (add `resolveCategoryId`)
- Modify: `src/cli/browse-ui.tsx` (`runBrowse` signature + non-TTY fallback + `BrowseApp` mount jump)
- Modify: `src/dokoro-cli.ts` (`browse` case parses `--category`; `printHelp`)
- Test: `src/cli/browse-data.test.ts`

**Interfaces:**
- Produces: `export function resolveCategoryId(input: string): BrowseCategoryId | null` — trims + lowercases, returns the matching `BrowseCategoryId` or `null`.
- Produces: `export async function runBrowse(dokoroPath: string, initialCategory?: string): Promise<void>` — `initialCategory` is the RAW user string (may be invalid).
- Consumes (by Task 3): `resolveCategoryId`.

- [ ] **Step 1: Write the failing test**

Append to `src/cli/browse-data.test.ts`:

```ts
describe('resolveCategoryId', () => {
  it('resolves known ids case-insensitively', () => {
    expect(mod.resolveCategoryId('plans')).toBe('plans');
    expect(mod.resolveCategoryId('CLAIMS')).toBe('claims');
    expect(mod.resolveCategoryId('  Feedback ')).toBe('feedback');
  });
  it('returns null for unknown or empty input', () => {
    expect(mod.resolveCategoryId('nope')).toBeNull();
    expect(mod.resolveCategoryId('')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/cli/browse-data.test.ts -t "resolveCategoryId"`
Expected: FAIL with "mod.resolveCategoryId is not a function".

- [ ] **Step 3: Implement `resolveCategoryId` in `browse-data.ts`**

Add after the `CATEGORY_LABELS` declaration:

```ts
/** Validate a raw CLI/user category string against the known ids. */
export function resolveCategoryId(input: string): BrowseCategoryId | null {
  const key = input.trim().toLowerCase();
  const ids = Object.keys(CATEGORY_LABELS) as BrowseCategoryId[];
  return ids.includes(key as BrowseCategoryId) ? (key as BrowseCategoryId) : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/cli/browse-data.test.ts -t "resolveCategoryId"`
Expected: PASS.

- [ ] **Step 5: Wire `runBrowse` + non-TTY fallback + mount jump in `browse-ui.tsx`**

Import `resolveCategoryId` (extend the existing `browse-data.js` import):

```tsx
import {
  dirsForCategory,
  listCategories,
  listItems,
  readItemContent,
  resolveCategoryId,
  type BrowseCategory,
  type BrowseItem,
} from './browse-data.js';
```

Add the prop to `BrowseApp` and a one-shot jump guard. Change the component signature:

```tsx
const BrowseApp: React.FC<{ dokoroPath: string; initialCategory?: string }> = ({ dokoroPath, initialCategory }) => {
```

Add a ref beside the other refs (near `selectedIdRef`):

```tsx
  const didJumpRef = useRef(false);
```

Replace the mount effect that loads categories:

```tsx
  useEffect(() => {
    void listCategories(dokoroPath).then(setCategories);
  }, [dokoroPath]);
```

with a version that opens the initial category once categories are loaded:

```tsx
  useEffect(() => {
    void listCategories(dokoroPath).then((cats) => {
      setCategories(cats);
      if (initialCategory === undefined || didJumpRef.current) return;
      didJumpRef.current = true;
      const id = resolveCategoryId(initialCategory);
      const cat = id !== null ? cats.find((c) => c.id === id) ?? null : null;
      if (cat !== null) openCategory(cat);
      else setToast(`unknown category: ${initialCategory}`);
    });
  }, [dokoroPath]);
```

Replace `runBrowse` with the signature + non-TTY branch:

```tsx
export async function runBrowse(dokoroPath: string, initialCategory?: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const catId = initialCategory !== undefined ? resolveCategoryId(initialCategory) : null;
    if (initialCategory !== undefined && catId === null) {
      console.log(`dokoro browse — ${dokoroPath}`);
      console.log(`(unknown category: ${initialCategory})`);
      return;
    }
    if (catId !== null) {
      const items = await listItems(dokoroPath, catId);
      console.log(`dokoro browse — ${dokoroPath} — ${catId}`);
      for (const item of items) {
        console.log(`  ${item.label}${item.sublabel !== undefined ? `  ${item.sublabel}` : ''}`);
      }
      return;
    }
    const categories = await listCategories(dokoroPath);
    console.log(`dokoro browse — ${dokoroPath}`);
    console.log('(interactive mode requires a TTY; showing a static summary)');
    for (const cat of categories) {
      console.log(`  ${cat.label}: ${cat.count}`);
    }
    return;
  }

  const { waitUntilExit } = render(<BrowseApp dokoroPath={dokoroPath} initialCategory={initialCategory} />, { exitOnCtrlC: true });
  await waitUntilExit();
}
```

- [ ] **Step 6: Parse `--category` in `dokoro-cli.ts` and document it**

In the `case "browse":` block, pass the flag through:

```ts
      case "browse": {
        // Lazy import: keep ink/react startup cost off every other command.
        const { runBrowse } = await import("./cli/browse-ui.js");
        // Explicit --path wins; otherwise reuse the CLI's dokoro-folder discovery.
        const config = getConfig();
        const dokoroPath =
          typeof flags.path === "string"
            ? path.resolve(flags.path)
            : path.join(config.projectPath, config.dokoroFolder ?? "dokoro");
        const initialCategory = typeof flags.category === "string" ? flags.category : undefined;
        await runBrowse(dokoroPath, initialCategory);
        break;
      }
```

In `printHelp`, update the browse line and add an option line:

```
  browse [--path=DIR] [--category=ID] [--json]   Interactive workspace browser (TUI)
```
```
  --category=ID           Open 'browse' directly at a category (e.g. plans, claims)
```

- [ ] **Step 7: Build + lint**

Run: `npm run build && npm run lint`
Expected: PASS (confirms the `runBrowse`/`BrowseApp` signature change and JSX compile).

- [ ] **Step 8: Commit**

```bash
git add src/cli/browse-data.ts src/cli/browse-data.test.ts src/cli/browse-ui.tsx src/dokoro-cli.ts
git commit -m "feat(browse): --category jump flag and validated resolveCategoryId"
```

---

## Task 3: `--json` dump mode

`dokoro browse --json` prints a JSON snapshot of the category counts; `dokoro browse --json --category=<id>` prints that category's items (ids let scripts fetch the underlying files — no detail/content is dumped). Implemented as a pure `browseJsonDump`, called from the CLI before any TTY check.

**Scope ruling (locked by the per-project scope council):** per-project isolation is permanent. The v1 `--json` shape is FLAT with `dokoroPath` as a top-level string. Do NOT add a `workspace_id`, a nested `workspace` block, or any other workspace metadata — the two shapes below are exactly what ships.

**Files:**
- Modify: `src/cli/browse-data.ts` (add `browseJsonDump`)
- Modify: `src/dokoro-cli.ts` (`browse` case dumps JSON before mounting the TUI)
- Test: `src/cli/browse-data.test.ts`

**Interfaces:**
- Consumes: `listCategories`, `listItems`, `resolveCategoryId` (Task 2), `BrowseCategoryId`.
- Produces: `export async function browseJsonDump(dokoroPath: string, categoryId?: BrowseCategoryId): Promise<string>` — 2-space-indented JSON string. No `categoryId`: `{ dokoroPath, categories: [{id,label,count}] }`. With `categoryId`: `{ dokoroPath, category, items: [{id,label,sublabel,kind,archived}] }`.

- [ ] **Step 1: Write the failing test**

Append to `src/cli/browse-data.test.ts`:

```ts
describe('browseJsonDump', () => {
  it('dumps category counts as JSON when no category is given', async () => {
    await fs.writeFile(path.join(tmpDir, 'current.md'), '# Now\n');
    const parsed = JSON.parse(await mod.browseJsonDump(tmpDir)) as {
      dokoroPath: string;
      categories: Array<{ id: string; label: string; count: number }>;
    };
    expect(parsed.dokoroPath).toBe(tmpDir);
    const current = parsed.categories.find((c) => c.id === 'current');
    expect(current).toEqual({ id: 'current', label: 'Current workspace', count: 1 });
  });

  it('dumps a category\'s items (id/label/sublabel/kind/archived) as JSON', async () => {
    await fs.mkdir(dailyDir(), { recursive: true });
    await fs.writeFile(path.join(dailyDir(), '2026-06-10-10h00-wednesday-b.md'), '# b\n');
    const parsed = JSON.parse(await mod.browseJsonDump(tmpDir, 'daily')) as {
      dokoroPath: string;
      category: string;
      items: Array<{ id: string; label: string; kind: string }>;
    };
    expect(parsed.category).toBe('daily');
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({
      id: 'daily/2026-06-10-10h00-wednesday-b.md',
      label: '2026-06-10-10h00-wednesday-b.md',
      kind: 'file',
    });
  });

  it('emits 2-space-indented JSON', async () => {
    const out = await mod.browseJsonDump(tmpDir);
    expect(out).toContain('\n  "dokoroPath"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/cli/browse-data.test.ts -t "browseJsonDump"`
Expected: FAIL with "mod.browseJsonDump is not a function".

- [ ] **Step 3: Implement `browseJsonDump` in `browse-data.ts`**

Add near the end of the "Categories" section (after `listCategories`):

```ts
/**
 * Machine-readable snapshot of browse data for `dokoro browse --json`.
 * No category: `{ dokoroPath, categories: [{id,label,count}] }`.
 * With category: `{ dokoroPath, category, items: [{id,label,sublabel,kind,archived}] }`.
 * Detail/content is intentionally omitted — ids let scripts fetch the files.
 */
export async function browseJsonDump(dokoroPath: string, categoryId?: BrowseCategoryId): Promise<string> {
  if (categoryId === undefined) {
    const categories = (await listCategories(dokoroPath)).map((c) => ({ id: c.id, label: c.label, count: c.count }));
    return JSON.stringify({ dokoroPath, categories }, null, 2);
  }
  const items = (await listItems(dokoroPath, categoryId)).map((i) => ({
    id: i.id,
    label: i.label,
    sublabel: i.sublabel,
    kind: i.kind,
    archived: i.archived,
  }));
  return JSON.stringify({ dokoroPath, category: categoryId, items }, null, 2);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/cli/browse-data.test.ts -t "browseJsonDump"`
Expected: PASS.

- [ ] **Step 5: Wire the CLI to dump before mounting the TUI**

In `dokoro-cli.ts`, inside the `case "browse":` block, add the JSON branch immediately after `dokoroPath` is computed and BEFORE `runBrowse` is called (this runs regardless of TTY):

```ts
        const initialCategory = typeof flags.category === "string" ? flags.category : undefined;
        if (flags.json === true || typeof flags.json === "string") {
          const { browseJsonDump, resolveCategoryId } = await import("./cli/browse-data.js");
          const catId = initialCategory !== undefined ? resolveCategoryId(initialCategory) : null;
          console.log(await browseJsonDump(dokoroPath, catId ?? undefined));
          break;
        }
        await runBrowse(dokoroPath, initialCategory);
        break;
```

(Note: `runBrowse` is still imported at the top of the case. An invalid `--category` alongside `--json` resolves to `null` and dumps the category-counts shape — the simplest behavior; do not add invalid-category error surface here.)

- [ ] **Step 6: Build + lint**

Run: `npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/browse-data.ts src/cli/browse-data.test.ts src/dokoro-cli.ts
git commit -m "feat(browse): --json dump mode for categories and items"
```

---

## Task 4: NO_COLOR support

Honor the https://no-color.org contract: when `process.env.NO_COLOR` is set and non-empty, suppress all color/dim styling in the markdown renderer and the TUI. A single exported `colorsEnabled` flag in `markdown-ansi.ts` is the source of truth; the renderer strips color/dim from its own spans, and `browse-ui.tsx` gates its hardcoded color props on it (pulse flash falls back to bold).

**Files:**
- Modify: `src/cli/markdown-ansi.ts` (add `colorsEnabled` + span stripping)
- Modify: `src/cli/browse-ui.tsx` (gate hardcoded color/dim props)
- Test: `src/cli/markdown-ansi.test.ts`

**Interfaces:**
- Produces: `export const colorsEnabled: boolean` — `true` unless `NO_COLOR` is set and non-empty. Evaluated once at module import.
- Behavior: when `colorsEnabled` is `false`, `renderMarkdown` output spans carry no `color` and no `dim`.

- [ ] **Step 1: Write the failing test**

At the top of `src/cli/markdown-ansi.test.ts`, add the `jest` import:

```ts
import { describe, expect, it, jest } from '@jest/globals';
```

Append a new describe block:

```ts
describe('colorsEnabled / NO_COLOR', () => {
  const original = process.env.NO_COLOR;
  afterEach(() => {
    if (original === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = original;
  });

  function load(): typeof import('./markdown-ansi.js') {
    let m!: typeof import('./markdown-ansi.js');
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      m = require('./markdown-ansi.js') as typeof import('./markdown-ansi.js');
    });
    return m;
  }

  it('enables colors when NO_COLOR is unset', () => {
    delete process.env.NO_COLOR;
    const m = load();
    expect(m.colorsEnabled).toBe(true);
    const [h1] = m.renderMarkdown('# Title');
    expect(h1.some((s) => s.color === 'cyan')).toBe(true);
  });

  it('suppresses color and dim when NO_COLOR is set', () => {
    process.env.NO_COLOR = '1';
    const m = load();
    expect(m.colorsEnabled).toBe(false);
    const [h1] = m.renderMarkdown('# Title');
    expect(h1.every((s) => s.color === undefined)).toBe(true);
    const fm = m.renderMarkdown('---\ntitle: x\n---');
    expect(fm[0].every((s) => s.dim === undefined)).toBe(true);
  });

  it('treats an empty NO_COLOR as unset (colors on)', () => {
    process.env.NO_COLOR = '';
    const m = load();
    expect(m.colorsEnabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/cli/markdown-ansi.test.ts -t "NO_COLOR"`
Expected: FAIL with "m.colorsEnabled is undefined" / color still `cyan` under NO_COLOR.

- [ ] **Step 3: Implement `colorsEnabled` + stripping in `markdown-ansi.ts`**

Add after the `MdLine` type:

```ts
/** https://no-color.org — colors off when NO_COLOR is set and non-empty. */
export const colorsEnabled: boolean =
  process.env.NO_COLOR === undefined || process.env.NO_COLOR === '';

/** Drop color/dim from spans when colors are disabled; keep text/bold/italic. */
function stripColors(lines: MdLine[]): MdLine[] {
  return lines.map((line) =>
    line.map((span) => {
      const { color: _color, dim: _dim, ...rest } = span;
      return rest;
    }),
  );
}
```

In `renderMarkdown`, change the successful return (currently `return out;`) to:

```ts
    return colorsEnabled ? out : stripColors(out);
```

(The `catch` path returns `plainToLines(raw)`, which is already colorless — leave it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/cli/markdown-ansi.test.ts -t "NO_COLOR"`
Expected: PASS.

- [ ] **Step 5: Gate `browse-ui.tsx` hardcoded colors**

Import the flag (extend the existing `markdown-ansi.js` import):

```tsx
import { colorsEnabled, lineText, plainToLines, renderMarkdown, type MdLine } from './markdown-ansi.js';
```

Inside `BrowseApp`, define a color gate near the top of the component body (after the `viewport` calc):

```tsx
  // NO_COLOR: collapse every hardcoded color prop to undefined; dim falls away.
  const col = (c?: string): string | undefined => (colorsEnabled ? c : undefined);
```

Apply `col(...)` to every hardcoded `color="..."` prop in the component's JSX (`Header`, `Footer`, categories body, items body, preview body, help overlay). `Header`/`Footer` are separate components — pass the resolved color down, or inline them; the simplest is to replace their literal `color="gray"`/`color="cyan"` with `col('gray')`/`col('cyan')` by moving those two small components inside `BrowseApp` OR threading a `colorsEnabled` prop. Representative edits inside `BrowseApp`'s own JSX:

```tsx
  // categories item
  <Text color={selected ? col('cyan') : undefined} bold={selected}>
  ...
  <Text color={col('gray')}> ({cat.count})</Text>
```
```tsx
  // items row
  <Text color={selected ? col('cyan') : undefined} bold={selected} dimColor={colorsEnabled ? (item.archived === true && !selected) : false}>
  ...
  {item.sublabel !== undefined && <Text color={col('gray')}>  {item.sublabel}</Text>}
```
```tsx
  // preview span (pulse falls back to bold when colors are off)
  <Text
    key={j}
    color={pulseLines.has(scroll + i) ? col('yellow') : s.color}
    bold={pulseLines.has(scroll + i) ? true : s.bold}
    dimColor={pulseLines.has(scroll + i) ? false : s.dim}
    italic={s.italic}
  >
```

For `Header` and `Footer`, add a `colorsEnabled: boolean` prop and gate their internal `color="cyan"`/`color="gray"` the same way, passing `colorsEnabled` from `BrowseApp`. Markdown span colors are already stripped by `renderMarkdown` (Step 3), so `s.color`/`s.dim` are `undefined` under NO_COLOR automatically.

- [ ] **Step 6: Build + lint**

Run: `npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 7: Manual visual check**

Run `NO_COLOR=1 node dist/dokoro-cli.js browse` and confirm no ANSI color; run without it and confirm colors return.

- [ ] **Step 8: Commit**

```bash
git add src/cli/markdown-ansi.ts src/cli/markdown-ansi.test.ts src/cli/browse-ui.tsx
git commit -m "feat(browse): NO_COLOR support across renderer and TUI"
```

---

## Task 5: Filter persistence per category

Today `openCategory` resets the filter. Instead, remember the last filter per category in a `Map<BrowseCategoryId, string>` and restore it when returning to that category (the footer then shows it as usual). `esc` semantics are unchanged: `esc` clears the live filter first, then goes back.

**Files:**
- Modify: `src/cli/browse-ui.tsx` (per-category filter map; restore in `openCategory`; persist on change)

**No unit test (dependency note):** this is pure `browse-ui.tsx` state with no data-layer surface. It is covered by Task 10's UI smoke rig (which lands last). Verify here with build + lint + a manual check; Task 10 is the automated safety net.

**Interfaces:**
- Consumes: existing `filter`, `selectedCategory`, `openCategory`.
- Produces: nothing exported.

- [ ] **Step 1: Add the per-category filter map and restore-on-open**

Add a ref beside the other refs:

```tsx
  const categoryFiltersRef = useRef<Map<BrowseCategory['id'], string>>(new Map());
```

In `openCategory`, replace the unconditional `setFilter('')` with a restore from the map:

```tsx
  const openCategory = (cat: BrowseCategory): void => {
    void listItems(dokoroPath, cat.id).then((list) => {
      setSelectedCategory(cat);
      setItems(list);
      setItemIndex(0);
      setFilter(categoryFiltersRef.current.get(cat.id) ?? '');
      setTypingFilter(false);
      setSearchSnapshot(null);
      setTypingSearch(false);
      setSearchQuery('');
      setLevel('items');
    });
  };
```

- [ ] **Step 2: Persist the filter whenever it changes for the active category**

Add an effect near the other effects:

```tsx
  // Remember each category's last filter so returning restores it.
  useEffect(() => {
    if (selectedCategory !== null) {
      categoryFiltersRef.current.set(selectedCategory.id, filter);
    }
  }, [filter, selectedCategory]);
```

(`esc`-clear already calls `setFilter('')`, which persists `''` — i.e. the next visit shows no filter, matching "esc clears filter first". No other change to the esc/back handler.)

- [ ] **Step 3: Build + lint**

Run: `npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 4: Manual check**

In a TTY: open `Plans`, type `/` then a filter, `esc esc` back to categories, open `Daily`, back to categories, reopen `Plans` — the previous `Plans` filter is restored and shown in the footer.

- [ ] **Step 5: Commit**

```bash
git add src/cli/browse-ui.tsx
git commit -m "feat(browse): persist filter per category across round trips"
```

---

## Task 6: Sort toggle `o` on the items level

`o` cycles the items order per category: `default` (current hardcoded order — already newest-first for date categories) → `reverse` (oldest) → `label` (A→Z) → back to `default`. A pure, tested `sortItems` does the reordering; `browse-ui.tsx` holds the order per category, applies it before `fuzzyFilter`, shows the current order in the footer when non-default, and documents `o` in the help overlay.

**Files:**
- Modify: `src/cli/browse-data.ts` (add `sortItems`)
- Modify: `src/cli/browse-ui.tsx` (per-category order state, `o` key, footer hint, help copy)
- Test: `src/cli/browse-data.test.ts`

**Interfaces:**
- Produces: `export function sortItems(items: BrowseItem[], order: 'default' | 'reverse' | 'label'): BrowseItem[]` — `default` returns the input array as-is; `reverse` returns a reversed copy; `label` returns a copy sorted ascending by `label` (`localeCompare`). Never mutates the input.

- [ ] **Step 1: Write the failing test**

Append to `src/cli/browse-data.test.ts`:

```ts
describe('sortItems', () => {
  const items: import('./browse-data.js').BrowseItem[] = [
    { id: 'c', label: 'Charlie', kind: 'file' },
    { id: 'a', label: 'alpha', kind: 'file' },
    { id: 'b', label: 'Bravo', kind: 'file' },
  ];
  it('default returns the input order unchanged', () => {
    expect(mod.sortItems(items, 'default').map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });
  it('reverse returns a reversed copy without mutating input', () => {
    const out = mod.sortItems(items, 'reverse');
    expect(out.map((i) => i.id)).toEqual(['b', 'a', 'c']);
    expect(items.map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });
  it('label sorts ascending by label', () => {
    expect(mod.sortItems(items, 'label').map((i) => i.label)).toEqual(['alpha', 'Bravo', 'Charlie']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/cli/browse-data.test.ts -t "sortItems"`
Expected: FAIL with "mod.sortItems is not a function".

- [ ] **Step 3: Implement `sortItems` in `browse-data.ts`**

Add in the "Items" section (after `listItems`):

```ts
/** Reorder items for the UI sort toggle. `default` keeps the source order
 * (already newest-first for date categories); never mutates the input. */
export function sortItems(items: BrowseItem[], order: 'default' | 'reverse' | 'label'): BrowseItem[] {
  if (order === 'reverse') return [...items].reverse();
  if (order === 'label') return [...items].sort((a, b) => a.label.localeCompare(b.label));
  return items;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/cli/browse-data.test.ts -t "sortItems"`
Expected: PASS.

- [ ] **Step 5: Wire order state + `o` key + footer + help in `browse-ui.tsx`**

Import `sortItems` (extend the `browse-data.js` import) and add a type alias near `Level`:

```tsx
type SortOrder = 'default' | 'reverse' | 'label';
```

Add state + a per-category memory ref:

```tsx
  const [order, setOrder] = useState<SortOrder>('default');
  const categoryOrdersRef = useRef<Map<BrowseCategory['id'], SortOrder>>(new Map());
```

In `openCategory`, restore the saved order (add alongside the filter restore from Task 5):

```tsx
      setOrder(categoryOrdersRef.current.get(cat.id) ?? 'default');
```

Apply the order before filtering — replace the `filteredItems` memo:

```tsx
  const orderedItems = useMemo(() => sortItems(items, order), [items, order]);
  const filteredItems = useMemo(
    () => fuzzyFilter(orderedItems, filter, (i) => `${i.label} ${i.sublabel ?? ''}`),
    [orderedItems, filter],
  );
```

In `handleNormalInput`, items level, add an `o` handler (place it near the `/` and `s` handlers):

```tsx
      if (input === 'o') {
        const next: SortOrder = order === 'default' ? 'reverse' : order === 'reverse' ? 'label' : 'default';
        setOrder(next);
        if (selectedCategory !== null) categoryOrdersRef.current.set(selectedCategory.id, next);
        setItemIndex(0);
        return;
      }
```

In the items-level footer hint, surface the order when non-default. Update the normal (non-typing) hint string to include an order tag and the `o` key:

```tsx
      const orderHint = order === 'default' ? '' : `[${order}] `;
      hint = typingFilter
        ? filterHint
        : `${orderHint}${filterHint}↑/↓ move · enter/→ open · / filter · o sort · s search · ${escHint} · a archive · w weekly · ? help · q quit · ${filteredItems.length === 0 ? 0 : safeItemIndex + 1}/${filteredItems.length}`;
```

In the help overlay body, add a Sort section (near the Filter section):

```tsx
        <Text color="cyan" bold>Sort (items)</Text>
        <Text color="gray">  o cycle order: newest → oldest → label</Text>
```

(If Task 4 landed first, wrap those help colors with `col(...)` to match.)

- [ ] **Step 6: Build + lint**

Run: `npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/browse-data.ts src/cli/browse-data.test.ts src/cli/browse-ui.tsx
git commit -m "feat(browse): o sort toggle (newest/oldest/label) per category"
```

---

## Task 7: Archive undo `u`

Add a pure, never-throwing `undoArchive` to `browse-actions.ts` that reverses the most recent archive done this session, plus the `u` key that arms it behind the existing confirm ("Undo archive of X? y/n"). For a plan it must also reverse `archivePlan`'s index write (the entry was rewritten to `{title, archived:true, archive_path}`; undo restores the bare-title live entry). `browse-ui.tsx` keeps only the single most-recent archive record.

**IMPORTANT (read `src/utils/archive.ts` first):** `archivePlan` moves `.mcp/plans/<id>.json` → `.mcp/plans/archive/<YYYY-MM>/<id>.json` and sets `index[planId] = { title, archived: true, archive_path }` (relative). `archiveDailyFile` is a pure file move `daily/<name>.md` → `archive/daily/<ISO-week>/<name>.md` (no index). The undo record's `from` = original location, `to` = archive location; undo moves `to` → `from` and, for plans, restores `index[planId]` to the bare title string. The plans dir and index are derived from `record.from` (its dirname is `.mcp/plans`), so `undoArchive` needs no `dokoroPath` argument.

**Files:**
- Modify: `src/cli/browse-actions.ts` (add `ArchiveUndoRecord` + `undoArchive` + local `fileExists`/`moveFile`)
- Modify: `src/cli/browse-ui.tsx` (capture last archive, `u` key, confirm wiring, help copy)
- Test: `src/cli/browse-actions.test.ts` (new)

**Interfaces:**
- Produces: `export interface ArchiveUndoRecord { kind: 'plan' | 'daily'; from: string; to: string; }`
- Produces: `export type UndoArchiveOutcome = 'restored' | 'missing' | 'occupied' | 'failed';`
- Produces: `export async function undoArchive(record: ArchiveUndoRecord): Promise<UndoArchiveOutcome>` — `missing` when `record.to` is gone; `occupied` when `record.from` already exists; `restored` on success; `failed` on any thrown I/O.

- [ ] **Step 1: Write the failing test (new file `src/cli/browse-actions.test.ts`)**

```ts
/**
 * browse-actions.ts pure action layer — temp-dir fixtures, never-throw contract.
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { undoArchive, type ArchiveUndoRecord } from './browse-actions.js';

let tmpDir: string;
const plansDir = (): string => path.join(tmpDir, '.mcp', 'plans');

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dokoro-actions-test-'));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

describe('undoArchive: plan', () => {
  it('moves the archived plan back and restores the live index entry', async () => {
    const from = path.join(plansDir(), 'plan-x.json');
    const to = path.join(plansDir(), 'archive', '2026-07', 'plan-x.json');
    await writeJson(to, { title: 'Plan X', status: 'completed', items: [] });
    await writeJson(path.join(plansDir(), 'index.json'), {
      'plan-x': { title: 'Plan X', archived: true, archive_path: 'archive/2026-07/plan-x.json' },
    });

    const record: ArchiveUndoRecord = { kind: 'plan', from, to };
    expect(await undoArchive(record)).toBe('restored');

    expect(await fs.readFile(from, 'utf-8')).toContain('Plan X');
    await expect(fs.access(to)).rejects.toThrow();
    const index = JSON.parse(await fs.readFile(path.join(plansDir(), 'index.json'), 'utf-8'));
    expect(index['plan-x']).toBe('Plan X'); // bare-title live entry restored
  });

  it('returns "missing" when the archived file is gone', async () => {
    const record: ArchiveUndoRecord = {
      kind: 'plan',
      from: path.join(plansDir(), 'plan-x.json'),
      to: path.join(plansDir(), 'archive', '2026-07', 'plan-x.json'),
    };
    expect(await undoArchive(record)).toBe('missing');
  });

  it('returns "occupied" when the original path already exists', async () => {
    const from = path.join(plansDir(), 'plan-x.json');
    const to = path.join(plansDir(), 'archive', '2026-07', 'plan-x.json');
    await writeJson(to, { title: 'Plan X' });
    await writeJson(from, { title: 'Fresh Plan X' });
    const record: ArchiveUndoRecord = { kind: 'plan', from, to };
    expect(await undoArchive(record)).toBe('occupied');
    // archived file untouched
    expect(await fs.readFile(to, 'utf-8')).toContain('Plan X');
  });
});

describe('undoArchive: daily', () => {
  it('moves the archived daily file back to daily/', async () => {
    const from = path.join(tmpDir, 'daily', '2026-05-12-09h00-tuesday-x.md');
    const to = path.join(tmpDir, 'archive', 'daily', '2026-W20', '2026-05-12-09h00-tuesday-x.md');
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.writeFile(to, '# x\n');
    const record: ArchiveUndoRecord = { kind: 'daily', from, to };
    expect(await undoArchive(record)).toBe('restored');
    expect(await fs.readFile(from, 'utf-8')).toContain('# x');
    await expect(fs.access(to)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/cli/browse-actions.test.ts`
Expected: FAIL with "undoArchive is not exported" / cannot find name.

- [ ] **Step 3: Implement `undoArchive` in `browse-actions.ts`**

Add local helpers (near the top helper section, after `errMsg`):

```ts
async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Move a file, creating the destination dir; EXDEV-safe copy+unlink fallback. */
async function moveFile(src: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.rename(src, dest);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await fs.copyFile(src, dest);
    await fs.unlink(src);
  }
}
```

Add the undo section at the end of the file:

```ts
// ───────────────────────────────────────────────────────────────────────────
// Undo the most recent archive (reverse of archivePlan / archiveDailyFile)
// ───────────────────────────────────────────────────────────────────────────

/** The single most-recent archive the UI can offer to undo this session.
 * `from` = original location, `to` = archive location (both absolute). */
export interface ArchiveUndoRecord {
  kind: 'plan' | 'daily';
  from: string;
  to: string;
}

export type UndoArchiveOutcome = 'restored' | 'missing' | 'occupied' | 'failed';

/**
 * Reverse a single archive: move `record.to` back to `record.from`, and for a
 * plan restore its index entry from `{title, archived, archive_path}` back to
 * the bare title string. Fresh checks: the archived file must still exist
 * ('missing') and the original slot must be free ('occupied'). Never throws.
 */
export async function undoArchive(record: ArchiveUndoRecord): Promise<UndoArchiveOutcome> {
  try {
    if (!(await fileExists(record.to))) return 'missing';
    if (await fileExists(record.from)) return 'occupied';

    await moveFile(record.to, record.from);

    if (record.kind === 'plan') {
      const plansDir = path.dirname(record.from);
      const planId = path.basename(record.from).replace(/\.json$/, '');
      const indexPath = path.join(plansDir, 'index.json');
      let index: Record<string, unknown> = {};
      try {
        index = JSON.parse(await fs.readFile(indexPath, 'utf-8')) as Record<string, unknown>;
      } catch {
        index = {};
      }
      const entry = index[planId];
      const title =
        entry !== null && typeof entry === 'object' && typeof (entry as { title?: unknown }).title === 'string'
          ? (entry as { title: string }).title
          : planId;
      index[planId] = title; // reverse archivePlan's index write
      await writeFileAtomic(indexPath, JSON.stringify(index, null, 2));
    }

    return 'restored';
  } catch {
    return 'failed';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/cli/browse-actions.test.ts`
Expected: PASS (all `undoArchive` cases).

- [ ] **Step 5: Wire `u` + capture + confirm in `browse-ui.tsx`**

Import undo:

```tsx
import { undoArchive, type ArchiveUndoRecord } from './browse-actions.js';
```

Extend `ConfirmState` with an optional undo payload (leave the archive fields as-is):

```tsx
interface ConfirmState {
  kind: 'plan' | 'daily';
  id: string;
  label: string;
  fileName: string;
  force: boolean;
  undo?: ArchiveUndoRecord;
}
```

Add state to remember the last archive:

```tsx
  const [lastArchive, setLastArchive] = useState<ArchiveUndoRecord | null>(null);
```

In `confirmHint`, handle the undo case first:

```tsx
function confirmHint(c: ConfirmState): string {
  if (c.undo !== undefined) return `Undo archive of "${c.label}"? y/n`;
  return c.force
    ? `⚠ "${c.label}" is CURRENT WEEK — archive anyway? y/n`
    : `Archive "${c.label}"? y/n`;
}
```

In `runConfirm`, branch to undo at the top, and capture the record on successful archives:

```tsx
  const runConfirm = async (c: ConfirmState): Promise<void> => {
    setConfirm(null);
    if (c.undo !== undefined) {
      const outcome = await undoArchive(c.undo);
      setToast(
        outcome === 'restored' ? `restored: ${c.label}`
          : outcome === 'missing' ? 'undo: archived file is gone'
            : outcome === 'occupied' ? 'undo: original path is occupied'
              : 'undo failed');
      if (outcome === 'restored') setLastArchive(null);
      return;
    }
    try {
      if (c.kind === 'plan') {
        const result = await archivePlan(c.id);
        if (result.ok && result.alreadyArchived !== true && result.archivePath !== undefined) {
          setLastArchive({
            kind: 'plan',
            from: path.join(dokoroPath, '.mcp', 'plans', `${c.id}.json`),
            to: path.join(dokoroPath, '.mcp', 'plans', result.archivePath),
          });
        }
        setToast(result.ok
          ? result.alreadyArchived === true ? 'already archived' : `archived: ${c.label}`
          : `archive failed: ${result.error ?? 'unknown'}`);
        return;
      }
      const result = await archiveDailyFile(c.fileName, { force: c.force });
      switch (result.outcome) {
        case 'moved':
          if (result.to !== undefined) setLastArchive({ kind: 'daily', from: result.from, to: result.to });
          setToast(`moved to weekly archive: ${c.label}`);
          break;
        case 'alreadyArchived': setToast('already archived'); break;
        case 'claimed': setToast('skipped: file has a live claim'); break;
        case 'currentWeek':
          setConfirm({ ...c, force: true });
          break;
        case 'missing': setToast('file is gone (already moved?)'); break;
        case 'failed': setToast(`archive failed: ${result.error ?? 'unknown'}`); break;
      }
    } catch (e: unknown) {
      setToast(`archive failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
```

In `handleNormalInput`, items level, add the `u` handler (near `a`/`w`):

```tsx
      if (input === 'u') {
        if (lastArchive === null) { setToast('nothing to undo'); return; }
        // archive.ts (and thus the undo file paths) target the module DOKORO_PATH.
        if (dokoroPath !== DOKORO_PATH) { setToast('undo disabled for --path overrides'); return; }
        setConfirm({ kind: lastArchive.kind, id: '', label: path.basename(lastArchive.from), fileName: '', force: false, undo: lastArchive });
        return;
      }
```

In the help overlay Archive section, add the `u` line:

```tsx
        <Text color="gray">  u undo the last archive · y/n confirm</Text>
```

(If Task 4 landed first, wrap that color with `col(...)`.)

- [ ] **Step 6: Build + lint**

Run: `npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/browse-actions.ts src/cli/browse-actions.test.ts src/cli/browse-ui.tsx
git commit -m "feat(browse): u undo-last-archive with index restore"
```

---

## Task 8: DB-poll short-circuit via `PRAGMA data_version`

The claims/agents categories re-run their SQL every 1500ms poll tick. `PRAGMA data_version` is a per-connection counter that changes whenever ANOTHER connection commits a write to the DB. Cache the last-seen value per category and, when unchanged, return the previous items reference — so the `JSON.stringify` change-detector in `browse-ui`'s reload keeps the render free. Poll interval stays as-is; scope is claims/agents only.

**Placement decision (read both, then decide):** `browse-live.ts` has no DB imports (timers/watchers only); `browse-data.ts` already imports `Database`, opens the DB via `tryDb`, and owns `claimItems`/`agentItems`. The helper and cache therefore live in `browse-data.ts`.

**Same-connection caveat (documented):** in production, `browse-data` opens its OWN connection, so writes from agents (the MCP server's connection) bump `data_version` and invalidate the cache. Under a single injected `__TEST_DB__` connection, a write on that same handle does NOT bump `data_version`; the reference-identity test below relies on there being no write between the two calls. The module-level cache is reset per test by the existing `freshModule()` isolateModules pattern.

**Files:**
- Modify: `src/cli/browse-data.ts` (add `dbDataVersion` + per-category cache; wire into `claimItems`/`agentItems`)
- Test: `src/cli/browse-data.test.ts`

**Interfaces:**
- Produces: `export function dbDataVersion(db: Database.Database): number` — returns `PRAGMA data_version`.

- [ ] **Step 1: Write the failing test**

Append to `src/cli/browse-data.test.ts`:

```ts
describe('dbDataVersion', () => {
  it('returns an integer and changes after another connection writes', async () => {
    const file = path.join(tmpDir, 'dv.sqlite');
    const a = new Database(file);
    const b = new Database(file);
    a.exec('CREATE TABLE t (x INTEGER)');
    const v1 = mod.dbDataVersion(a);
    expect(Number.isInteger(v1)).toBe(true);
    b.prepare('INSERT INTO t (x) VALUES (1)').run(); // OTHER connection commits
    const v2 = mod.dbDataVersion(a);
    expect(v2).not.toBe(v1);
    a.close();
    b.close();
  });
});

describe('claims/agents poll short-circuit', () => {
  it('returns the same items reference when data_version is unchanged', async () => {
    insertLiveClaim('src/a.ts');
    const first = await mod.listItems(tmpDir, 'claims');
    const second = await mod.listItems(tmpDir, 'claims');
    expect(second).toBe(first); // cached reference — query skipped
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/cli/browse-data.test.ts -t "data_version|short-circuit"`
Expected: FAIL — `mod.dbDataVersion is not a function`; and `second` is a fresh array `!== first`.

- [ ] **Step 3: Implement `dbDataVersion` + cache + wiring in `browse-data.ts`**

Add the helper near `tryDb`/`nowSeconds`:

```ts
/** SQLite per-connection change counter — bumps when ANOTHER connection commits
 * a write. Lets the poll skip re-querying claims/agents when nothing changed. */
export function dbDataVersion(db: Database.Database): number {
  const row = db.prepare('PRAGMA data_version').get() as { data_version: number };
  return row.data_version;
}

interface DbListCache {
  version: number;
  items: BrowseItem[];
}
const claimsCache: { value: DbListCache | null } = { value: null };
const agentsCache: { value: DbListCache | null } = { value: null };
```

In `claimItems`, add the short-circuit right after acquiring `sqlite` and cache the result before returning:

```ts
function claimItems(dokoroPath: string): BrowseItem[] {
  const sqlite = tryDb(dokoroPath);
  if (sqlite === null) return [dbUnavailableItem('claim')];
  try {
    const version = dbDataVersion(sqlite);
    if (claimsCache.value !== null && claimsCache.value.version === version) return claimsCache.value.items;
    const now = nowSeconds(sqlite);
    const rows = sqlite.prepare(
      /* ...existing SELECT... */
    ).all() as ClaimRow[];

    const items = rows.map((row) => {
      /* ...existing mapping unchanged... */
    });
    claimsCache.value = { version, items };
    return items;
  } catch {
    return [dbUnavailableItem('claim')];
  }
}
```

Apply the identical pattern to `agentItems` using `agentsCache` (short-circuit after `dbDataVersion`, assign `agentsCache.value = { version, items }` before returning). Do NOT touch `feedbackItems` or the new `entityItems` — scope is claims/agents only.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/cli/browse-data.test.ts -t "data_version|short-circuit"`
Expected: PASS.

- [ ] **Step 5: Full file test (no regressions)**

Run: `npx jest src/cli/browse-data.test.ts`
Expected: PASS (existing claims/agents/listCategories tests still green — each call caches on first query; none re-query after a same-connection write within one test).

- [ ] **Step 6: Build + lint**

Run: `npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/browse-data.ts src/cli/browse-data.test.ts
git commit -m "perf(browse): skip claims/agents re-query via PRAGMA data_version"
```

---

## Task 9: Read-only `entities` category

Add an `entities` browse category mirroring the questions/feedback conventions already in `browse-data.ts` (read those final implementations first and copy their shape: never-throw, DB-unavailable placeholder, pre-rendered detail card, newest-first, counts via `listCategories`). Source is the bi-temporal entity graph (`entities` + `entity_relations`, per `src/db/entity-tables.ts`). Item label = entity name; sublabel = type + current relation count; detail card = the entity's facts/relations currently valid (as-of now: `valid_to IS NULL`).

**Files:**
- Modify: `src/cli/browse-data.ts` (add `entities` to the union/labels/switch/dirs, `entity` kind, `dbUnavailableItem`, `entityItems`)
- Test: `src/cli/browse-data.test.ts` (add entity tables to the DB fixture + tests; update the two count assertions)

**Interfaces:**
- Consumes: `tryDb`, `dbUnavailableItem`, `BrowseItem`.
- Produces: `entities` as a valid `BrowseCategoryId` and `entity` as a valid `BrowseItem['kind']`.

- [ ] **Step 1: Write the failing test**

First extend the DB fixture. In `src/cli/browse-data.test.ts` `beforeEach`, add the entity tables to the `db.exec(...)` schema block (after `agent_feedback`):

```ts
    CREATE TABLE entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      canonical_name TEXT NOT NULL,
      description TEXT,
      metadata_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(type, canonical_name)
    );
    CREATE TABLE entity_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      relation_type TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      metadata_json TEXT,
      valid_from TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      valid_to TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
```

Add an insert helper (near `insertFeedback`):

```ts
function insertEntity(type: string, name: string, opts: { description?: string; updatedAt?: string } = {}): number {
  const info = db.prepare(`
    INSERT INTO entities (type, name, canonical_name, description, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(type, name, name.toLowerCase(), opts.description ?? null, opts.updatedAt ?? new Date().toISOString());
  return Number(info.lastInsertRowid);
}
```

Update the two existing count assertions:
- In `listCategories > 'returns all categories with item counts'`, add `entities: 0,` to the `toEqual({...})` object (no entities inserted in that fixture).
- In `listCategories > 'handles a completely empty/missing workspace...'`, change `expect(categories).toHaveLength(10);` to `expect(categories).toHaveLength(11);`.

Add the entities describe block:

```ts
describe('listItems: entities', () => {
  it('lists entities newest first with type and relation count, and a detail card', async () => {
    const alice = insertEntity('person', 'Alice', { description: 'a person', updatedAt: '2026-06-01T09:00:00Z' });
    const dokoro = insertEntity('project', 'dokoro', { updatedAt: '2026-06-10T09:00:00Z' });
    db.prepare(`
      INSERT INTO entity_relations (source_id, target_id, relation_type, valid_from, valid_to)
      VALUES (?, ?, 'works_on', strftime('%Y-%m-%dT%H:%M:%SZ','now'), NULL)
    `).run(alice, dokoro);

    const items = await mod.listItems(tmpDir, 'entities');
    expect(items.map((i) => i.label)).toEqual(['dokoro', 'Alice']); // newest updated_at first
    expect(items.every((i) => i.kind === 'entity')).toBe(true);

    const aliceItem = items.find((i) => i.label === 'Alice');
    expect(aliceItem?.sublabel).toBe('person · 1 relation');
    const detail = await mod.readItemContent(aliceItem!);
    expect(detail).toContain('Entity');
    expect(detail).toContain('Alice --[works_on]--> dokoro');
  });

  it('returns an empty list when there are no entities', async () => {
    expect(await mod.listItems(tmpDir, 'entities')).toEqual([]);
  });

  it('falls back to a "(database unavailable)" item when the DB cannot be opened', async () => {
    delete (globalThis as Record<string, unknown>).__TEST_DB__;
    const items = await mod.listItems(tmpDir, 'entities');
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('(database unavailable)');
    expect(items[0].kind).toBe('entity');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/cli/browse-data.test.ts -t "entities"`
Expected: FAIL — `listItems(tmpDir, 'entities')` is not a known category / returns `[]` with wrong shape.

- [ ] **Step 3: Implement the `entities` category in `browse-data.ts`**

Add `'entities'` to the `BrowseCategoryId` union (after `'feedback'`):

```ts
export type BrowseCategoryId =
  | 'current'
  | 'daily'
  | 'weekly'
  | 'archive'
  | 'plans'
  | 'claims'
  | 'agents'
  | 'questions'
  | 'feedback'
  | 'entities'
  | 'sweep';
```

Add `'entity'` to `BrowseItem['kind']`:

```ts
  kind: 'file' | 'plan' | 'claim' | 'agent' | 'question' | 'feedback' | 'entity';
```

Add the label (after `feedback` in `CATEGORY_LABELS`):

```ts
  entities: 'Entities',
```

Extend `dbUnavailableItem`'s parameter type and the `listItems`/`dirsForCategory` switches:

```ts
function dbUnavailableItem(kind: 'claim' | 'agent' | 'feedback' | 'entity'): BrowseItem {
  return { id: `${kind}s-db-unavailable`, label: '(database unavailable)', kind };
}
```
```ts
      case 'entities': return entityItems(dokoroPath);
```
```ts
    case 'claims':
    case 'agents':
    case 'feedback':
    case 'entities':
      return null;
```

Add the row types and `entityItems` (mirrors `feedbackItems`; place after it):

```ts
interface EntityRow {
  id: number;
  type: string;
  name: string;
  description: string | null;
  relation_count: number;
}

interface EntityRelationRow {
  relation_type: string;
  source_name: string;
  target_name: string;
}

/** Read-only entity-graph view. Newest first (updated_at). Currently-valid
 * relations only (valid_to IS NULL). Unavailable DB → one placeholder item. */
function entityItems(dokoroPath: string): BrowseItem[] {
  const sqlite = tryDb(dokoroPath);
  if (sqlite === null) return [dbUnavailableItem('entity')];
  try {
    const rows = sqlite.prepare(
      `SELECT e.id, e.type, e.name, e.description,
              (SELECT COUNT(*) FROM entity_relations er
               WHERE (er.source_id = e.id OR er.target_id = e.id) AND er.valid_to IS NULL) AS relation_count
       FROM entities e
       ORDER BY e.updated_at DESC, e.id DESC`,
    ).all() as EntityRow[];

    return rows.map((row) => {
      const relations = sqlite.prepare(
        `SELECT er.relation_type, es.name AS source_name, et.name AS target_name
         FROM entity_relations er
         JOIN entities es ON er.source_id = es.id
         JOIN entities et ON er.target_id = et.id
         WHERE (er.source_id = ? OR er.target_id = ?) AND er.valid_to IS NULL
         ORDER BY er.valid_from DESC`,
      ).all(row.id, row.id) as EntityRelationRow[];

      const lines = [
        'Entity',
        '──────',
        `Name:      ${row.name}`,
        `Type:      ${row.type}`,
      ];
      if (row.description !== null && row.description !== '') lines.push(`Desc:      ${row.description}`);
      lines.push('', `Relations (${relations.length}):`);
      for (const r of relations) lines.push(`  ${r.source_name} --[${r.relation_type}]--> ${r.target_name}`);

      return {
        id: `entity-${row.id}`,
        label: row.name,
        sublabel: `${row.type} · ${row.relation_count} relation${row.relation_count === 1 ? '' : 's'}`,
        kind: 'entity' as const,
        detail: lines.join('\n'),
      };
    });
  } catch {
    return [dbUnavailableItem('entity')];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/cli/browse-data.test.ts -t "entities"`
Expected: PASS.

- [ ] **Step 5: Full file test (count assertions updated)**

Run: `npx jest src/cli/browse-data.test.ts`
Expected: PASS (the 11-category count and the `entities: 0` assertion hold).

- [ ] **Step 6: Build + lint**

Run: `npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/browse-data.ts src/cli/browse-data.test.ts
git commit -m "feat(browse): read-only entities category from the entity graph"
```

---

## Task 10: TUI smoke tests

Stand up the first `browse-ui.tsx` tests as a safety net. Add `ink-testing-library` (verify it installs against ink@6 / react@19; fall back to ink's own render if not — see the fallback note), export `BrowseApp`, and cover: renders categories on mount, `?` opens help and any key closes it, `/` filter typing keeps a literal `q`, and confirm mode swallows navigation keys.

**Key setup fact (load order):** `browse-ui.tsx` (transitively `archive.ts`/`browse-actions.ts`) reads `DOKORO_PATH` at import time (`process.env.DOKORO_PATH || <cwd>/dokoro`). To let the archive path resolve to a hermetic temp dir (needed to arm a confirm — `a`/`u` are gated on `dokoroPath === DOKORO_PATH`), set `process.env.DOKORO_PATH` to the fixture and load `browse-ui.js` via `require` AFTER setting it (static `import` is hoisted and would capture the real path). Use the same require registry for React so the component and `ink-testing-library` share one React instance.

**Files:**
- Modify: `package.json` (add `ink-testing-library` devDependency)
- Modify: `src/cli/browse-ui.tsx` (`export` the `BrowseApp` component)
- Test: `src/cli/browse-ui.test.tsx` (new)

**Interfaces:**
- Consumes: `BrowseApp` (now exported), `resolveCategoryId` behavior via `--category` (optional).
- Produces: nothing exported.

- [ ] **Step 1: Add the dev dependency and verify ink@6 compatibility**

Run: `npm install --save-dev ink-testing-library`
Then verify it imports against ink@6/react@19: `node -e "require('ink-testing-library')"` (Expected: no throw).

Fallback (only if install/peer-resolution fails against ink@6): do NOT add `ink-testing-library`. Instead render with ink's own `render` into a writable-stream stub and assert on captured output, and drive input by writing to a fake `stdin` (an `EventEmitter` with `isTTY=true`, `setRawMode`, `ref`, `unref`, `read`, `resume`, `pause`). State in the task PR description that the fallback was used and why. The four test bodies below stay the same except `render(...)` returns `{ lastFrame, stdin, unmount }` from your stub instead of the library.

- [ ] **Step 2: Export `BrowseApp` from `browse-ui.tsx`**

Change the component declaration from `const BrowseApp: React.FC<...> = ...` to an exported one:

```tsx
export const BrowseApp: React.FC<{ dokoroPath: string; initialCategory?: string }> = ({ dokoroPath, initialCategory }) => {
```

- [ ] **Step 3: Write the failing tests (new file `src/cli/browse-ui.test.tsx`)**

```tsx
/**
 * browse-ui.tsx smoke tests. DOKORO_PATH is pointed at a per-file temp fixture
 * BEFORE browse-ui is required (archive paths + the a/u gate read it at import),
 * and BrowseApp is required (not statically imported) so it picks that up while
 * still sharing one React instance with ink-testing-library.
 */
import React from 'react';
import Database from 'better-sqlite3';
import { render } from 'ink-testing-library';
import { promises as fs, mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

const FIXTURE = mkdtempSync(path.join(os.tmpdir(), 'dokoro-ui-fixture-'));
process.env.DOKORO_PATH = FIXTURE;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { BrowseApp } = require('./browse-ui.js') as typeof import('./browse-ui.js');

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let db: Database.Database;

async function resetFixture(): Promise<void> {
  rmSync(FIXTURE, { recursive: true, force: true });
  await fs.mkdir(FIXTURE, { recursive: true });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

beforeEach(async () => {
  await resetFixture();
  await fs.writeFile(path.join(FIXTURE, 'current.md'), '# Now\n');
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_presence (agent_id TEXT PRIMARY KEY, session_id TEXT, status TEXT, current_focus TEXT, last_heartbeat INTEGER NOT NULL, heartbeat_seq INTEGER DEFAULT 0);
    CREATE TABLE file_claims (claim_key TEXT PRIMARY KEY, file_path TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT, intent TEXT, claimed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, heartbeat_seq INTEGER DEFAULT 0, released_at INTEGER);
    CREATE TABLE agent_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, confidence REAL, latency_ms INTEGER, error_message TEXT, doc_id TEXT, session_id TEXT, metadata_json TEXT, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE entities (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, name TEXT NOT NULL, canonical_name TEXT NOT NULL, description TEXT, metadata_json TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(type, canonical_name));
    CREATE TABLE entity_relations (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL, target_id INTEGER NOT NULL, relation_type TEXT NOT NULL, weight REAL DEFAULT 1.0, metadata_json TEXT, valid_from TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), valid_to TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
  `);
  (globalThis as Record<string, unknown>).__TEST_DB__ = db;
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__TEST_DB__;
  db.close();
});

it('renders categories on mount', async () => {
  const { lastFrame, unmount } = render(<BrowseApp dokoroPath={FIXTURE} />);
  await delay(60);
  expect(lastFrame()).toContain('Current workspace');
  unmount();
});

it('? opens help and any key closes it back to the same level', async () => {
  const { lastFrame, stdin, unmount } = render(<BrowseApp dokoroPath={FIXTURE} />);
  await delay(60);
  stdin.write('?');
  await delay(20);
  expect(lastFrame()).toContain('Navigation');
  stdin.write('x');
  await delay(20);
  expect(lastFrame()).not.toContain('press any key to close help');
  expect(lastFrame()).toContain('Current workspace');
  unmount();
});

it('/ filter typing keeps a literal q (no quit)', async () => {
  const { lastFrame, stdin, unmount } = render(<BrowseApp dokoroPath={FIXTURE} />);
  await delay(60);
  stdin.write('\r'); // open the first category (Current) → items level
  await delay(40);
  stdin.write('/');
  await delay(20);
  stdin.write('q');
  await delay(20);
  expect(lastFrame()).toContain('filter: q');
  unmount();
});

it('confirm mode swallows navigation keys', async () => {
  // A live plan is archivable; arming its confirm requires dokoroPath === DOKORO_PATH
  // (satisfied: both are FIXTURE).
  await writeJson(path.join(FIXTURE, '.mcp', 'plans', 'plan-x.json'), {
    id: 'plan-x', title: 'Plan X', status: 'active', items: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  await writeJson(path.join(FIXTURE, '.mcp', 'plans', 'index.json'), { 'plan-x': 'Plan X' });

  // Jump straight to Plans via initialCategory (Task 2) so the arm is deterministic.
  const { lastFrame, stdin, unmount } = render(<BrowseApp dokoroPath={FIXTURE} initialCategory="plans" />);
  await delay(80);
  stdin.write('a'); // arm the archive confirm on the live plan
  await delay(30);
  expect(lastFrame()).toContain('Archive "Plan X"? y/n');
  const framed = lastFrame();
  stdin.write('[B'); // a real down arrow — must be swallowed by confirm mode
  await delay(20);
  expect(lastFrame()).toBe(framed); // unchanged — navigation did not move selection
  stdin.write('n'); // cancel the confirm
  await delay(20);
  unmount();
});
```

Note for the implementer: the fourth test jumps to `Plans` via `initialCategory="plans"` (Task 2) so the confirm arm is deterministic. If Task 2's jump is unavailable in your branch, replace that render with counted down-arrow presses (`stdin.write` of the `ESC [ B` sequence) to reach `Plans` plus a `\r` (enter) to open it. Tune the `delay(...)` values up (not down) if effects haven't settled on your machine — keep them; do not switch to fake timers unless flakiness appears, since the watchers use `unref`'d timers that won't hold the event loop.

- [ ] **Step 4: Run tests to verify they fail (then pass after wiring)**

Run: `npx jest src/cli/browse-ui.test.tsx`
Expected before Step 2's export lands / before deps: FAIL (`BrowseApp` undefined or module not found). After Step 1-2 and with all prior tasks merged: PASS.

- [ ] **Step 5: Build + lint**

Run: `npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 6: Full suite**

Run: `npm test`
Expected: PASS (all co-located tests including the new smoke tests).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/cli/browse-ui.tsx src/cli/browse-ui.test.tsx
git commit -m "test(browse): ink-testing-library smoke tests for the browse TUI"
```

---

## Execution notes

- **Baseline:** the suite is green at 393 tests before this plan (per the landing agents). Each task's `npx jest <file>` run should stay green, and `npm test` at the end of Task 10 should report the baseline plus the new tests added here — a drop below 393 means a regression, not just a new failure.
- The questions/feedback categories (kinds `'question'`/`'feedback'`) and `src/cli/browse-actions.ts` (`releaseClaim`/`planTransition`) are already landed; Tasks 7 and 9 are written against that real code (Task 9 copies the questions/feedback conventions; Task 7 adds `undoArchive` to the existing `browse-actions.ts`).
- Order is 1 → 10. Dependencies: Task 3 consumes `resolveCategoryId` (Task 2); Task 7's UI wiring reuses the `ConfirmState`/`DOKORO_PATH` guards; Task 9 copies the final questions/feedback conventions; Task 10 lands last as the safety net and can consume Task 2's `--category` jump for a deterministic confirm-arm.
- Tasks 1 and 5 have no unit test (no UI rig until Task 10) — they are build + lint + manual, called out explicitly in each task.
- Every task ends green on `npx jest <file>` (where applicable) + `npm run build` + `npm run lint`, one conventional commit per task, GitHub noreply email.
