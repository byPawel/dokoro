/**
 * Interactive `dokoro browse` TUI (ink). Three-level navigation:
 *
 *   categories ──enter──▶ items ──enter──▶ content preview
 *
 * Keys: ↑/↓ move (scroll in preview), PgUp/PgDn page in preview, enter open,
 * esc/backspace back (esc at the category level quits), `/` filter-as-you-type
 * on the items list (fuzzy match on label+sublabel (exact substrings rank first); esc clears),
 * q quits anywhere — except while typing a filter, where q is a literal char.
 * On the items list, `a` archives the selected live plan or daily file and
 * `w` archives a daily file into its weekly archive — both behind a footer
 * y/n confirm (current-week daily files need a second, force-armed confirm).
 * `s` opens semantic search: type a query, enter runs a hybrid (FTS5+vector)
 * search via src/cli/semantic-search.ts and swaps the list for the results;
 * esc/⌫ restores the original list.
 *
 * All data comes from src/cli/browse-data.ts (pure, never throws). The preview
 * renders markdown files as styled spans via src/cli/markdown-ansi.ts; other
 * content stays plain. When stdin is not a TTY (raw mode unavailable), a
 * static category summary is printed instead of mounting the interactive app.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import path from 'path';
import { render, Box, Text, useApp, useInput, useStdout } from 'ink';
import {
  dirsForCategory,
  listCategories,
  listItems,
  readItemContent,
  type BrowseCategory,
  type BrowseItem,
} from './browse-data.js';
import { startPolling, watchDirs } from './browse-live.js';
import { fuzzyFilter } from './fuzzy.js';
import { semanticSearchItems } from './semantic-search.js';
import { lineText, plainToLines, renderMarkdown, type MdLine } from './markdown-ansi.js';
import { archiveDailyFile, archivePlan } from '../utils/archive.js';
import { DOKORO_PATH } from '../shared/dokoro-utils.js';

type Level = 'categories' | 'items' | 'preview';

/** Pending archive confirmation (footer y/n prompt). Stores the item's
 * identity — not its list index — so live reloads can't retarget it. */
interface ConfirmState {
  kind: 'plan' | 'daily';
  id: string;
  label: string;
  fileName: string;
  force: boolean;
}

/** Footer prompt for a pending archive confirm. Used by BOTH the items- and
 * preview-level hints: an in-flight openItem can resolve after a confirm is
 * set, flipping the level to 'preview' while the prompt must stay visible. */
function confirmHint(c: ConfirmState): string {
  return c.force
    ? `⚠ "${c.label}" is CURRENT WEEK — archive anyway? y/n`
    : `Archive "${c.label}"? y/n`;
}

/** Visible window of a list, centered on the selection. */
function windowSlice<T>(list: T[], selected: number, height: number): { slice: T[]; start: number } {
  if (list.length <= height) return { slice: list, start: 0 };
  let start = Math.max(0, selected - Math.floor(height / 2));
  start = Math.min(start, list.length - height);
  return { slice: list.slice(start, start + height), start };
}

const Header: React.FC<{ crumbs: string[]; width: number }> = ({ crumbs, width }) => (
  <Box flexDirection="column">
    <Text wrap="truncate-end">
      <Text color="cyan" bold>dokoro</Text>
      {crumbs.map((crumb, i) => (
        <Text key={i}>
          <Text color="gray"> › </Text>
          <Text bold={i === crumbs.length - 1}>{crumb}</Text>
        </Text>
      ))}
    </Text>
    <Text color="gray">{'─'.repeat(Math.max(10, width))}</Text>
  </Box>
);

const Footer: React.FC<{ hint: string; width: number }> = ({ hint, width }) => (
  <Box flexDirection="column">
    <Text color="gray">{'─'.repeat(Math.max(10, width))}</Text>
    <Text color="gray" wrap="truncate-end">{hint}</Text>
  </Box>
);

/** Item content → styled lines. Markdown files get the renderer; the rest stay plain. */
function toMdLines(item: BrowseItem, content: string): MdLine[] {
  if (item.kind === 'file' && item.path !== undefined && item.path.endsWith('.md')) {
    return renderMarkdown(content);
  }
  return plainToLines(content);
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const BrowseApp: React.FC<{ dokoroPath: string }> = ({ dokoroPath }) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const width = Math.max(20, (stdout?.columns ?? 80) - 2);
  // Header (2 lines) + footer (2 lines) + padding line.
  const viewport = Math.max(3, rows - 5);

  const [level, setLevel] = useState<Level>('categories');
  const [categories, setCategories] = useState<BrowseCategory[] | null>(null);
  const [catIndex, setCatIndex] = useState(0);
  const [items, setItems] = useState<BrowseItem[]>([]);
  const [itemIndex, setItemIndex] = useState(0);
  const [selectedCategory, setSelectedCategory] = useState<BrowseCategory | null>(null);
  const [selectedItem, setSelectedItem] = useState<BrowseItem | null>(null);
  const [filter, setFilter] = useState('');
  const [typingFilter, setTypingFilter] = useState(false);
  const [contentLines, setContentLines] = useState<MdLine[]>([]);
  const [scroll, setScroll] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [spinnerOn, setSpinnerOn] = useState(false);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [pulseLines, setPulseLines] = useState<ReadonlySet<number>>(new Set());
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  // Semantic search: snapshot of the pre-search items (null = not searching).
  const [searchSnapshot, setSearchSnapshot] = useState<BrowseItem[] | null>(null);
  const [typingSearch, setTypingSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Run a confirmed archive. A 'currentWeek' refusal escalates to a second,
  // force-armed confirm instead of toasting. The live-refresh watcher picks
  // up the resulting file/index changes — no manual reload here.
  const runConfirm = async (c: ConfirmState): Promise<void> => {
    setConfirm(null);
    // archivePlan/archiveDailyFile never throw today, but the call site
    // discards this promise with `void` — fence regressions into a toast.
    try {
      if (c.kind === 'plan') {
        const result = await archivePlan(c.id);
        setToast(result.ok
          ? result.alreadyArchived === true ? 'already archived' : `archived: ${c.label}`
          : `archive failed: ${result.error ?? 'unknown'}`);
        return;
      }
      const result = await archiveDailyFile(c.fileName, { force: c.force });
      switch (result.outcome) {
        case 'moved': setToast(`moved to weekly archive: ${c.label}`); break;
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

  // Run a semantic search and swap the items list for the results. The
  // snapshot keeps the original list so esc can restore it; failures only
  // toast (the breaker in semantic-search.ts handles repeated ones).
  const runSemanticSearch = async (query: string): Promise<void> => {
    setSpinnerOn(true);
    // projectPath convention mirrors browse-data's tryDb: parent of the dokoro folder.
    const outcome = await semanticSearchItems(path.dirname(dokoroPath), query);
    setSpinnerOn(false);
    setToast(outcome.note);
    if (!outcome.ok) return;
    // itemsRef, not the render-time `items` capture: a watcher reload can
    // refresh the list during the (up to 5s) await, and esc must restore
    // the CURRENT list, not a stale one.
    setSearchSnapshot((prev) => prev ?? itemsRef.current);
    setItems(outcome.items);
    setItemIndex(0);
    setFilter('');
  };

  // Refs mirror state for use inside watcher/poller callbacks (stale-closure guard).
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const searchSnapshotRef = useRef(searchSnapshot);
  searchSnapshotRef.current = searchSnapshot;
  const selectedIdRef = useRef<string | null>(null);
  const contentRef = useRef<MdLine[]>([]);
  contentRef.current = contentLines;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  // Toast auto-clear; replaced toasts restart the timer.
  useEffect(() => {
    if (toast === null) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  // Spinner animation only while something is loading.
  useEffect(() => {
    if (!spinnerOn) return;
    const t = setInterval(() => setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(t);
  }, [spinnerOn]);

  useEffect(() => {
    void listCategories(dokoroPath).then(setCategories);
  }, [dokoroPath]);

  const filteredItems = useMemo(
    () => fuzzyFilter(items, filter, (i) => `${i.label} ${i.sublabel ?? ''}`),
    [items, filter],
  );

  const safeItemIndex = Math.max(0, Math.min(itemIndex, filteredItems.length - 1));
  const maxScroll = Math.max(0, contentLines.length - viewport);

  // Each filter-text change invalidates the filtered list (and any previous
  // index) — pin the selection back to the top.
  useEffect(() => {
    setItemIndex(0);
  }, [filter]);

  useEffect(() => {
    selectedIdRef.current = filteredItems[safeItemIndex]?.id ?? null;
  }, [filteredItems, safeItemIndex]);

  // Pulse decay: cleared 800ms after the last change (repeat changes extend).
  useEffect(() => {
    if (pulseLines.size === 0) return;
    const t = setTimeout(() => setPulseLines(new Set()), 800);
    return () => clearTimeout(t);
  }, [pulseLines]);

  const openCategory = (cat: BrowseCategory): void => {
    void listItems(dokoroPath, cat.id).then((list) => {
      setSelectedCategory(cat);
      setItems(list);
      setItemIndex(0);
      setFilter('');
      setTypingFilter(false);
      setSearchSnapshot(null);
      setTypingSearch(false);
      setSearchQuery('');
      setLevel('items');
    });
  };

  const openItem = (item: BrowseItem): void => {
    void readItemContent(item).then((content) => {
      setSelectedItem(item);
      setContentLines(toMdLines(item, content));
      setScroll(0);
      setLevel('preview');
    });
  };

  // Live items: file categories rescan on watcher dirty-hints, DB categories
  // poll. Hash short-circuit keeps unchanged data render-free; the selection
  // follows its item id across reloads.
  useEffect(() => {
    if (level !== 'items' || selectedCategory === null) return;
    const categoryId = selectedCategory.id;

    const reload = async (): Promise<void> => {
      // Semantic results on screen — a live reload would overwrite them.
      if (searchSnapshotRef.current !== null) return;
      const list = await listItems(dokoroPath, categoryId);
      let nextIndex: number | null = null;
      setItems((prev) => {
        if (JSON.stringify(prev) === JSON.stringify(list)) return prev;
        const visible = fuzzyFilter(list, filterRef.current, (i) => `${i.label} ${i.sublabel ?? ''}`);
        const pos = selectedIdRef.current === null
          ? -1
          : visible.findIndex((i) => i.id === selectedIdRef.current);
        nextIndex = pos >= 0 ? pos : 0;
        return list;
      });
      // Outside the updater (which must stay pure) but in the same batch.
      if (nextIndex !== null) setItemIndex(nextIndex);
    };

    const dirs = dirsForCategory(dokoroPath, categoryId);
    const handle = dirs !== null
      ? watchDirs(dirs, () => { void reload(); })
      : startPolling(1500, reload);
    return () => handle.stop();
  }, [level, selectedCategory, dokoroPath]);

  // Live preview: re-read on dirty-hint/poll, diff lines, pulse the changes.
  // The seq counter discards reads that resolve after navigation.
  useEffect(() => {
    if (level !== 'preview' || selectedItem === null) return;
    const item = selectedItem;
    const categoryId = selectedCategory?.id ?? null;
    let seq = 0;

    const refresh = async (): Promise<void> => {
      const mySeq = ++seq;
      let next: string;
      if (item.detail !== undefined && categoryId !== null) {
        // DB-backed cards (claims/agents): rebuild from a fresh list.
        const list = await listItems(dokoroPath, categoryId);
        const fresh = list.find((i) => i.id === item.id);
        next = await readItemContent(fresh ?? item);
      } else {
        next = await readItemContent(item);
      }
      if (mySeq !== seq) return; // stale read — user navigated away
      const nextLines = toMdLines(item, next);
      const prev = contentRef.current;
      const changed = new Set<number>();
      const max = Math.max(prev.length, nextLines.length);
      for (let i = 0; i < max; i++) {
        const a = prev[i] !== undefined ? lineText(prev[i]) : null;
        const b = nextLines[i] !== undefined ? lineText(nextLines[i]) : null;
        if (a !== b) changed.add(i);
      }
      if (changed.size === 0) return;
      setContentLines(nextLines);
      // Shrinking content can strand the scroll past the new end — clamp it.
      setScroll((s) => Math.min(s, Math.max(0, nextLines.length - viewportRef.current)));
      setPulseLines(changed);
    };

    const handle = item.path !== undefined
      ? watchDirs([path.dirname(item.path)], () => { void refresh(); })
      : startPolling(1500, refresh);
    return () => { seq++; handle.stop(); };
  }, [level, selectedItem, selectedCategory, dokoroPath]);

  useInput((input, key) => {
    // Pending archive confirm: y runs, n/esc cancels, everything else is
    // swallowed so stray keys can't navigate or retarget the action.
    if (confirm !== null) {
      if (input === 'y' || input === 'Y') { void runConfirm(confirm); return; }
      if (input === 'n' || input === 'N' || key.escape) { setConfirm(null); return; }
      return;
    }

    // Search typing mode: printable chars are literal query text; enter runs.
    if (level === 'items' && typingSearch) {
      if (key.escape) { setSearchQuery(''); setTypingSearch(false); return; }
      if (key.return) {
        setTypingSearch(false);
        if (searchQuery.trim() !== '') void runSemanticSearch(searchQuery.trim());
        return;
      }
      if (key.backspace || key.delete) { setSearchQuery((q) => q.slice(0, -1)); return; }
      if (input !== '' && !key.ctrl && !key.meta) setSearchQuery((q) => q + input);
      return;
    }

    // Filter typing mode: printable chars (incl. 'q') are literal filter text.
    if (level === 'items' && typingFilter) {
      if (key.escape) { setFilter(''); setTypingFilter(false); return; }
      if (key.return) { setTypingFilter(false); return; }
      if (key.backspace || key.delete) { setFilter((f) => f.slice(0, -1)); return; }
      if (key.upArrow) { setItemIndex(Math.max(0, safeItemIndex - 1)); return; }
      if (key.downArrow) { setItemIndex(Math.max(0, Math.min(filteredItems.length - 1, safeItemIndex + 1))); return; }
      if (input !== '' && !key.ctrl && !key.meta) setFilter((f) => f + input);
      return;
    }

    if (input === 'q') { exit(); return; }

    if (level === 'categories') {
      if (key.escape) { exit(); return; }
      if (categories === null || categories.length === 0) return;
      if (key.upArrow) { setCatIndex((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setCatIndex((i) => Math.min(categories.length - 1, i + 1)); return; }
      if (key.return) openCategory(categories[Math.min(catIndex, categories.length - 1)]);
      return;
    }

    if (level === 'items') {
      if (key.escape || key.backspace || key.delete) {
        if (searchSnapshot !== null) {
          setItems(searchSnapshot);
          setSearchSnapshot(null);
          setItemIndex(0);
          return;
        }
        if (filter !== '') { setFilter(''); setItemIndex(0); return; }
        setLevel('categories');
        return;
      }
      if (input === '/') { setTypingFilter(true); return; }
      if (input === 'a' || input === 'w') {
        if (filteredItems.length === 0) return;
        const item = filteredItems[safeItemIndex];
        if (item.archived === true) { setToast('already archived'); return; }
        // archive.ts resolves paths from the module-level DOKORO_PATH; a
        // --path override would archive against the WRONG tree — refuse.
        if (dokoroPath !== DOKORO_PATH) { setToast('archive keys disabled for --path overrides'); return; }
        if (item.kind === 'plan' && input === 'a') {
          setConfirm({ kind: 'plan', id: item.id, label: item.label, fileName: '', force: false });
          return;
        }
        if (item.kind === 'file' && item.path !== undefined && item.id.startsWith('daily/')) {
          setConfirm({ kind: 'daily', id: item.id, label: item.label, fileName: path.basename(item.path), force: false });
          return;
        }
        setToast(input === 'a' ? 'not archivable' : 'w archives daily files only');
        return;
      }
      if (input === 's') { setTypingSearch(true); setSearchQuery(''); return; }
      if (key.upArrow) { setItemIndex(Math.max(0, safeItemIndex - 1)); return; }
      if (key.downArrow) { setItemIndex(Math.max(0, Math.min(filteredItems.length - 1, safeItemIndex + 1))); return; }
      if (key.return) {
        // No-op on an empty (filtered) list — never index into nothing.
        if (filteredItems.length === 0) return;
        openItem(filteredItems[safeItemIndex]);
      }
      return;
    }

    // Preview level: scroll.
    if (key.escape || key.backspace || key.delete) { setLevel('items'); return; }
    if (key.upArrow) { setScroll((s) => Math.max(0, s - 1)); return; }
    if (key.downArrow) { setScroll((s) => Math.min(maxScroll, s + 1)); return; }
    if (key.pageUp) { setScroll((s) => Math.max(0, s - viewport)); return; }
    if (key.pageDown) setScroll((s) => Math.min(maxScroll, s + viewport));
  });

  // ── Render ────────────────────────────────────────────────────────────────

  const crumbs: string[] = [];
  if (level !== 'categories' && selectedCategory !== null) crumbs.push(selectedCategory.label);
  if (level === 'preview' && selectedItem !== null) crumbs.push(selectedItem.label);

  let body: React.ReactElement;
  let hint: string;

  if (level === 'categories') {
    hint = '↑/↓ move · enter open · q/esc quit';
    if (categories === null) {
      body = <Text color="gray">Loading…</Text>;
    } else {
      const { slice, start } = windowSlice(categories, catIndex, viewport);
      body = (
        <Box flexDirection="column">
          {slice.map((cat, i) => {
            const selected = start + i === catIndex;
            return (
              <Text key={cat.id} wrap="truncate-end">
                <Text color={selected ? 'cyan' : undefined} bold={selected}>
                  {selected ? '▸ ' : '  '}{cat.label}
                </Text>
                <Text color="gray"> ({cat.count})</Text>
              </Text>
            );
          })}
        </Box>
      );
    }
  } else if (level === 'items') {
    const filterHint = typingFilter
      ? `filter: ${filter}▌ (enter keep · esc clear)`
      : filter !== ''
        ? `filter: ${filter} (esc clears) · `
        : '';
    const escHint = searchSnapshot !== null ? 'esc restore list' : 'esc/⌫ back';
    if (confirm !== null) {
      hint = confirmHint(confirm);
    } else if (typingSearch) {
      hint = `search: ${searchQuery}▌ (enter run · esc cancel)`;
    } else {
      hint = typingFilter
        ? filterHint
        : `${filterHint}↑/↓ move · enter open · / filter · s search · ${escHint} · a archive · w weekly · q quit · ${filteredItems.length === 0 ? 0 : safeItemIndex + 1}/${filteredItems.length}`;
    }
    if (filteredItems.length === 0) {
      body = (
        <Text color="gray">
          {items.length === 0 ? '(no items)' : `(no items match "${filter}")`}
        </Text>
      );
    } else {
      const { slice, start } = windowSlice(filteredItems, safeItemIndex, viewport);
      body = (
        <Box flexDirection="column">
          {slice.map((item, i) => {
            const selected = start + i === safeItemIndex;
            return (
              <Text key={item.id} wrap="truncate-end">
                <Text color={selected ? 'cyan' : undefined} bold={selected} dimColor={item.archived === true && !selected}>
                  {selected ? '▸ ' : '  '}{item.label}
                </Text>
                {item.sublabel !== undefined && <Text color="gray">  {item.sublabel}</Text>}
              </Text>
            );
          })}
        </Box>
      );
    }
  } else {
    const lineInfo = contentLines.length > viewport
      ? ` · lines ${scroll + 1}-${Math.min(scroll + viewport, contentLines.length)}/${contentLines.length}`
      : '';
    // A confirm set just before openItem resolved must keep its prompt here —
    // confirm-mode swallows all keys, so a hidden prompt would look dead.
    hint = confirm !== null
      ? confirmHint(confirm)
      : `↑/↓ scroll · PgUp/PgDn page · esc/⌫ back · q quit${lineInfo}`;
    const visible = contentLines.slice(scroll, scroll + viewport);
    body = (
      <Box flexDirection="column">
        {visible.map((line, i) => (
          <Text key={i} wrap="truncate-end">
            {lineText(line) === '' ? ' ' : line.map((s, j) => (
              <Text
                key={j}
                color={pulseLines.has(scroll + i) ? 'yellow' : s.color}
                bold={pulseLines.has(scroll + i) ? true : s.bold}
                dimColor={pulseLines.has(scroll + i) ? false : s.dim}
                italic={s.italic}
              >
                {s.text}
              </Text>
            ))}
          </Text>
        ))}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header crumbs={crumbs} width={width} />
      <Box flexDirection="column" minHeight={viewport}>
        {body}
      </Box>
      <Footer
        hint={toast !== null ? `⚑ ${toast}` : spinnerOn ? `${SPINNER_FRAMES[spinnerFrame]} ${hint}` : hint}
        width={width}
      />
    </Box>
  );
};

/**
 * Run the browse TUI. When stdin/stdout is not a TTY (raw mode unavailable,
 * e.g. piped input), prints a static category summary instead of crashing.
 */
export async function runBrowse(dokoroPath: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const categories = await listCategories(dokoroPath);
    console.log(`dokoro browse — ${dokoroPath}`);
    console.log('(interactive mode requires a TTY; showing a static summary)');
    for (const cat of categories) {
      console.log(`  ${cat.label}: ${cat.count}`);
    }
    return;
  }

  const { waitUntilExit } = render(<BrowseApp dokoroPath={dokoroPath} />, { exitOnCtrlC: true });
  await waitUntilExit();
}
