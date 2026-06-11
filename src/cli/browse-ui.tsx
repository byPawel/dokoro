/**
 * Interactive `dokoro browse` TUI (ink). Three-level navigation:
 *
 *   categories ──enter──▶ items ──enter──▶ content preview
 *
 * Keys: ↑/↓ move (scroll in preview), PgUp/PgDn page in preview, enter open,
 * esc/backspace back (esc at the category level quits), `/` filter-as-you-type
 * on the items list (fuzzy match on label+sublabel (exact substrings rank first); esc clears),
 * q quits anywhere — except while typing a filter, where q is a literal char.
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
import { lineText, plainToLines, renderMarkdown, type MdLine } from './markdown-ansi.js';

type Level = 'categories' | 'items' | 'preview';

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
  // setSpinnerOn gets its producer (async load wiring) in a follow-up task.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [spinnerOn, setSpinnerOn] = useState(false);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [pulseLines, setPulseLines] = useState<ReadonlySet<number>>(new Set());
  // Refs mirror state for use inside watcher/poller callbacks (stale-closure guard).
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const selectedIdRef = useRef<string | null>(null);
  const contentRef = useRef<MdLine[]>([]);
  contentRef.current = contentLines;

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
      const list = await listItems(dokoroPath, categoryId);
      setItems((prev) => {
        if (JSON.stringify(prev) === JSON.stringify(list)) return prev;
        const visible = fuzzyFilter(list, filterRef.current, (i) => `${i.label} ${i.sublabel ?? ''}`);
        const pos = selectedIdRef.current === null
          ? -1
          : visible.findIndex((i) => i.id === selectedIdRef.current);
        setItemIndex(pos >= 0 ? pos : 0);
        return list;
      });
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
      setPulseLines(changed);
    };

    const handle = item.path !== undefined
      ? watchDirs([path.dirname(item.path)], () => { void refresh(); })
      : startPolling(1500, refresh);
    return () => { seq++; handle.stop(); };
  }, [level, selectedItem, selectedCategory, dokoroPath]);

  useInput((input, key) => {
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
        if (filter !== '') { setFilter(''); setItemIndex(0); return; }
        setLevel('categories');
        return;
      }
      if (input === '/') { setTypingFilter(true); return; }
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
    hint = typingFilter
      ? filterHint
      : `${filterHint}↑/↓ move · enter open · / filter · esc/⌫ back · q quit · ${filteredItems.length === 0 ? 0 : safeItemIndex + 1}/${filteredItems.length}`;
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
    hint = `↑/↓ scroll · PgUp/PgDn page · esc/⌫ back · q quit${lineInfo}`;
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
