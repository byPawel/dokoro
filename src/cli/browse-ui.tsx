/**
 * Interactive `dokoro browse` TUI (ink). Three-level navigation:
 *
 *   categories ──enter──▶ items ──enter──▶ content preview
 *
 * Keys: ↑/↓ move (scroll in preview), PgUp/PgDn page in preview, enter/→ open,
 * esc/backspace back (esc at the category level quits), `/` filter-as-you-type
 * on the items list (fuzzy match on label+sublabel (exact substrings rank first); esc clears),
 * q quits anywhere — except while typing a filter, where q is a literal char.
 * In normal mode `?` opens a full-body help overlay listing the keybindings;
 * any key closes it and returns exactly where the user was.
 * On the items list, `a` archives the selected live plan or daily file and
 * `w` archives a daily file into its weekly archive — both behind a footer
 * y/n confirm (current-week daily files need a second, force-armed confirm).
 * `u` undoes the single most-recent archive from this session (same confirm).
 * `r` releases a stale advisory file claim (refused when the holder is live and
 * the claim is unexpired — no force) and `p` advances a plan one legal step
 * (draft→active, active→completed) — both behind the same y/n confirm.
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
import { render, Box, Text, useApp, useInput, useStdout, type Key } from 'ink';
import {
  dirsForCategory,
  listCategories,
  listItems,
  readItemContent,
  resolveCategoryId,
  sortItems,
  type BrowseCategory,
  type BrowseItem,
} from './browse-data.js';
import { startPolling, watchDirs } from './browse-live.js';
import { fuzzyFilter } from './fuzzy.js';
import { semanticSearchItems } from './semantic-search.js';
import { colorsEnabled, lineText, plainToLines, renderMarkdown, type MdLine } from './markdown-ansi.js';
import { archiveDailyFile, archivePlan } from '../utils/archive.js';
import { nextPlanStatus, planTransition, readPlanStatus, releaseClaim, undoArchive, type ArchiveUndoRecord } from './browse-actions.js';
import { DOKORO_PATH } from '../shared/dokoro-utils.js';

type Level = 'categories' | 'items' | 'preview';
type SortOrder = 'default' | 'reverse' | 'label';

/** Pending footer y/n confirmation, discriminated by the mutation it will run.
 * Stores the item's identity — not its list index — so live reloads can't
 * retarget it. `claim` releases a stale file claim; `plan-transition` advances
 * a plan one legal step (from/to captured at arm time for the prompt + guard).
 * `undo` reverses the single most-recent archive (`record` carries the paths). */
type ConfirmState =
  | { kind: 'plan'; id: string; label: string }
  | { kind: 'daily'; id: string; label: string; fileName: string; force: boolean }
  | { kind: 'claim'; claimKey: string; label: string }
  | { kind: 'plan-transition'; id: string; label: string; from: string; to: string }
  | { kind: 'undo'; label: string; record: ArchiveUndoRecord };

/** Footer prompt for a pending confirm. Used by BOTH the items- and preview-
 * level hints: an in-flight openItem can resolve after a confirm is set,
 * flipping the level to 'preview' while the prompt must stay visible. */
function confirmHint(c: ConfirmState): string {
  switch (c.kind) {
    case 'plan': return `Archive "${c.label}"? y/n`;
    case 'daily': return c.force
      ? `⚠ "${c.label}" is CURRENT WEEK — archive anyway? y/n`
      : `Archive "${c.label}"? y/n`;
    case 'claim': return `Release claim "${c.label}"? y/n`;
    case 'plan-transition': return `Plan "${c.label}": ${c.from} → ${c.to}? y/n`;
    case 'undo': return `Undo archive of "${c.label}"? y/n`;
  }
}

/** Visible window of a list, centered on the selection. */
function windowSlice<T>(list: T[], selected: number, height: number): { slice: T[]; start: number } {
  if (list.length <= height) return { slice: list, start: 0 };
  let start = Math.max(0, selected - Math.floor(height / 2));
  start = Math.min(start, list.length - height);
  return { slice: list.slice(start, start + height), start };
}

const Header: React.FC<{ crumbs: string[]; width: number; colorsEnabled: boolean }> = ({ crumbs, width, colorsEnabled: colorsOn }) => (
  <Box flexDirection="column">
    <Text wrap="truncate-end">
      <Text color={colorsOn ? 'cyan' : undefined} bold>dokoro</Text>
      {crumbs.map((crumb, i) => (
        <Text key={i}>
          <Text color={colorsOn ? 'gray' : undefined}> › </Text>
          <Text bold={i === crumbs.length - 1}>{crumb}</Text>
        </Text>
      ))}
    </Text>
    <Text color={colorsOn ? 'gray' : undefined}>{'─'.repeat(Math.max(10, width))}</Text>
  </Box>
);

const Footer: React.FC<{ hint: string; width: number; colorsEnabled: boolean }> = ({ hint, width, colorsEnabled: colorsOn }) => (
  <Box flexDirection="column">
    <Text color={colorsOn ? 'gray' : undefined}>{'─'.repeat(Math.max(10, width))}</Text>
    <Text color={colorsOn ? 'gray' : undefined} wrap="truncate-end">{hint}</Text>
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

export const BrowseApp: React.FC<{ dokoroPath: string; initialCategory?: string }> = ({ dokoroPath, initialCategory }) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const width = Math.max(20, (stdout?.columns ?? 80) - 2);
  // Header (2 lines) + footer (2 lines) + padding line.
  const viewport = Math.max(3, rows - 5);
  // NO_COLOR: collapse every hardcoded color prop to undefined; dim falls away.
  const col = (c?: string): string | undefined => (colorsEnabled ? c : undefined);

  const [level, setLevel] = useState<Level>('categories');
  const [categories, setCategories] = useState<BrowseCategory[] | null>(null);
  const [catIndex, setCatIndex] = useState(0);
  const [items, setItems] = useState<BrowseItem[]>([]);
  const [itemIndex, setItemIndex] = useState(0);
  const [selectedCategory, setSelectedCategory] = useState<BrowseCategory | null>(null);
  const [selectedItem, setSelectedItem] = useState<BrowseItem | null>(null);
  const [filter, setFilter] = useState('');
  const [typingFilter, setTypingFilter] = useState(false);
  const [order, setOrder] = useState<SortOrder>('default');
  const [contentLines, setContentLines] = useState<MdLine[]>([]);
  const [scroll, setScroll] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [spinnerOn, setSpinnerOn] = useState(false);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [pulseLines, setPulseLines] = useState<ReadonlySet<number>>(new Set());
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  // The single most-recent archive this session, armed for `u` undo (null = nothing).
  const [lastArchive, setLastArchive] = useState<ArchiveUndoRecord | null>(null);
  // Presentational help overlay flag; any key dismisses it (see useInput).
  const [help, setHelp] = useState(false);
  // Semantic search: snapshot of the pre-search items (null = not searching).
  const [searchSnapshot, setSearchSnapshot] = useState<BrowseItem[] | null>(null);
  const [typingSearch, setTypingSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Run a confirmed mutation (archive / claim release / plan transition). A
  // daily 'currentWeek' refusal escalates to a second, force-armed confirm
  // instead of toasting. The live-refresh watcher/poller picks up the resulting
  // file/index/DB changes — no manual reload here.
  const runConfirm = async (c: ConfirmState): Promise<void> => {
    setConfirm(null);
    // Undo the last archive. undoArchive never throws; a success clears the
    // single-slot record so a second `u` reports 'nothing to undo'.
    if (c.kind === 'undo') {
      const outcome = await undoArchive(c.record);
      switch (outcome) {
        case 'restored': setToast(`restored: ${c.label}`); setLastArchive(null); break;
        case 'missing': setToast('undo: archived file is gone'); break;
        case 'occupied': setToast('undo: original path is occupied'); break;
        case 'failed': setToast('undo failed'); break;
      }
      return;
    }
    // The action modules never throw today, but the call site discards this
    // promise with `void` — fence regressions into a toast.
    try {
      if (c.kind === 'plan') {
        const result = await archivePlan(c.id);
        // Remember a real move (not a no-op) so `u` can reverse it this session.
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
      if (c.kind === 'claim') {
        const result = releaseClaim(dokoroPath, c.claimKey);
        switch (result.outcome) {
          case 'released': setToast(`released claim: ${c.label}`); break;
          case 'alreadyReleased': setToast('claim already released'); break;
          case 'holderLive': setToast('holder is live — not releasing'); break;
          case 'missing': setToast('claim is gone'); break;
          case 'dbUnavailable': setToast('database unavailable'); break;
          case 'failed': setToast(`release failed: ${result.error ?? 'unknown'}`); break;
        }
        return;
      }
      if (c.kind === 'plan-transition') {
        // Re-read guarded by the status shown at arm time: a drift aborts.
        const result = await planTransition(dokoroPath, c.id, c.from);
        switch (result.outcome) {
          case 'transitioned': setToast(`plan ${result.from} → ${result.to}: ${c.label}`); break;
          case 'noTransition': setToast('no legal transition'); break;
          case 'changed': setToast('plan changed — aborted'); break;
          case 'missing': setToast('plan file is gone'); break;
          case 'failed': setToast(`transition failed: ${result.error ?? 'unknown'}`); break;
        }
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
      setToast(`action failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Arm a plan-transition confirm: read the plan's current status (fresh) so
  // the prompt shows the exact step, and capture it as the guard the confirmed
  // apply re-checks. No legal step from the current status → a toast, no arm.
  const armPlanTransition = async (item: BrowseItem): Promise<void> => {
    const status = await readPlanStatus(dokoroPath, item.id);
    const to = nextPlanStatus(status);
    if (to === null) {
      setToast(status === null ? 'plan unavailable' : `no transition from ${status}`);
      return;
    }
    setConfirm({ kind: 'plan-transition', id: item.id, label: item.label, from: status as string, to });
  };

  // Run a semantic search and swap the items list for the results. The
  // snapshot keeps the original list so esc can restore it; failures only
  // toast (the breaker in semantic-search.ts handles repeated ones).
  const runSemanticSearch = async (query: string): Promise<void> => {
    setSpinnerOn(true);
    // Same dokoro folder as browse-data's tryDb — one canonical data dir.
    const outcome = await semanticSearchItems(dokoroPath, query);
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
    // Results arrive relevance-ranked — a lingering reverse/label order would
    // silently override that. The per-category memory (categoryOrdersRef) is
    // untouched, so leaving/re-entering the category still restores it.
    setOrder('default');
  };

  // Refs mirror state for use inside watcher/poller callbacks (stale-closure guard).
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const orderRef = useRef(order);
  orderRef.current = order;
  // Remembers each category's last filter so returning to it restores that filter.
  const categoryFiltersRef = useRef<Map<BrowseCategory['id'], string>>(new Map());
  // Remembers each category's last sort order so returning to it restores that order.
  const categoryOrdersRef = useRef<Map<BrowseCategory['id'], SortOrder>>(new Map());
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const searchSnapshotRef = useRef(searchSnapshot);
  searchSnapshotRef.current = searchSnapshot;
  const selectedIdRef = useRef<string | null>(null);
  const didJumpRef = useRef(false);
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

  const orderedItems = useMemo(() => sortItems(items, order), [items, order]);
  const filteredItems = useMemo(
    () => fuzzyFilter(orderedItems, filter, (i) => `${i.label} ${i.sublabel ?? ''}`),
    [orderedItems, filter],
  );

  const safeItemIndex = Math.max(0, Math.min(itemIndex, filteredItems.length - 1));
  const maxScroll = Math.max(0, contentLines.length - viewport);

  // Each filter-text change invalidates the filtered list (and any previous
  // index) — pin the selection back to the top.
  useEffect(() => {
    setItemIndex(0);
  }, [filter]);

  // Remember each category's last filter so returning restores it.
  useEffect(() => {
    if (selectedCategory !== null) {
      categoryFiltersRef.current.set(selectedCategory.id, filter);
    }
  }, [filter, selectedCategory]);

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
      setFilter(categoryFiltersRef.current.get(cat.id) ?? '');
      setOrder(categoryOrdersRef.current.get(cat.id) ?? 'default');
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
        const visible = fuzzyFilter(sortItems(list, orderRef.current), filterRef.current, (i) => `${i.label} ${i.sublabel ?? ''}`);
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

  // Pending archive confirm: y runs, n/esc cancels, everything else is
  // swallowed so stray keys can't navigate or retarget the action.
  const handleConfirmInput = (input: string, key: Key): void => {
    if (confirm === null) return;
    if (input === 'y' || input === 'Y') { void runConfirm(confirm); return; }
    if (input === 'n' || input === 'N' || key.escape) { setConfirm(null); return; }
  };

  // Help overlay: any key (esc/? included) dismisses it, leaving all other
  // state untouched so the user lands back exactly where they were.
  const handleHelpInput = (): void => {
    setHelp(false);
  };

  // Search typing mode: printable chars are literal query text; enter runs.
  const handleSearchInput = (input: string, key: Key): void => {
    if (key.escape) { setSearchQuery(''); setTypingSearch(false); return; }
    if (key.return) {
      setTypingSearch(false);
      if (searchQuery.trim() !== '') void runSemanticSearch(searchQuery.trim());
      return;
    }
    if (key.backspace || key.delete) { setSearchQuery((q) => q.slice(0, -1)); return; }
    if (input !== '' && !key.ctrl && !key.meta) setSearchQuery((q) => q + input);
  };

  // Filter typing mode: printable chars (incl. 'q') are literal filter text.
  const handleFilterInput = (input: string, key: Key): void => {
    if (key.escape) { setFilter(''); setTypingFilter(false); return; }
    if (key.return) { setTypingFilter(false); return; }
    if (key.backspace || key.delete) { setFilter((f) => f.slice(0, -1)); return; }
    if (key.upArrow) { setItemIndex(Math.max(0, safeItemIndex - 1)); return; }
    if (key.downArrow) { setItemIndex(Math.max(0, Math.min(filteredItems.length - 1, safeItemIndex + 1))); return; }
    if (input !== '' && !key.ctrl && !key.meta) setFilter((f) => f + input);
  };

  // Normal (non-typing) mode: global q/? plus the per-level navigation.
  const handleNormalInput = (input: string, key: Key): void => {
    if (input === 'q') { exit(); return; }
    if (input === '?') { setHelp(true); return; }

    if (level === 'categories') {
      if (key.escape) { exit(); return; }
      if (categories === null || categories.length === 0) return;
      if (key.upArrow) { setCatIndex((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setCatIndex((i) => Math.min(categories.length - 1, i + 1)); return; }
      if (key.return || key.rightArrow) openCategory(categories[Math.min(catIndex, categories.length - 1)]);
      return;
    }

    if (level === 'items') {
      if (key.escape || key.backspace || key.delete || key.leftArrow) {
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
      if (input === 'o') {
        const next: SortOrder = order === 'default' ? 'reverse' : order === 'reverse' ? 'label' : 'default';
        setOrder(next);
        if (selectedCategory !== null) categoryOrdersRef.current.set(selectedCategory.id, next);
        setItemIndex(0);
        return;
      }
      if (input === 'a' || input === 'w') {
        if (filteredItems.length === 0) return;
        const item = filteredItems[safeItemIndex];
        if (item.archived === true) { setToast('already archived'); return; }
        // archive.ts resolves paths from the module-level DOKORO_PATH; a
        // --path override would archive against the WRONG tree — refuse.
        if (dokoroPath !== DOKORO_PATH) { setToast('archive keys disabled for --path overrides'); return; }
        if (item.kind === 'plan' && input === 'a') {
          setConfirm({ kind: 'plan', id: item.id, label: item.label });
          return;
        }
        if (item.kind === 'file' && item.path !== undefined && item.id.startsWith('daily/')) {
          setConfirm({ kind: 'daily', id: item.id, label: item.label, fileName: path.basename(item.path), force: false });
          return;
        }
        setToast(input === 'a' ? 'not archivable' : 'w archives daily files only');
        return;
      }
      if (input === 'u') {
        if (lastArchive === null) { setToast('nothing to undo'); return; }
        // archive.ts (and thus the captured undo paths) target the module
        // DOKORO_PATH; an override can only ever leave lastArchive null, but
        // guard the message explicitly to mirror a/w.
        if (dokoroPath !== DOKORO_PATH) { setToast('undo disabled for --path overrides'); return; }
        setConfirm({ kind: 'undo', label: path.basename(lastArchive.from), record: lastArchive });
        return;
      }
      // r/p resolve their paths from dokoroPath (browse-actions), so unlike
      // a/w they carry NO --path-override guard.
      if (input === 'r') {
        if (filteredItems.length === 0) return;
        const item = filteredItems[safeItemIndex];
        if (item.kind !== 'claim') { setToast('r releases file claims only'); return; }
        setConfirm({ kind: 'claim', claimKey: item.id, label: item.label });
        return;
      }
      if (input === 'p') {
        if (filteredItems.length === 0) return;
        const item = filteredItems[safeItemIndex];
        if (item.kind !== 'plan') { setToast('p advances plans only'); return; }
        if (item.archived === true) { setToast('plan is archived (read-only)'); return; }
        void armPlanTransition(item);
        return;
      }
      if (input === 's') { setTypingSearch(true); setSearchQuery(''); return; }
      if (key.upArrow) { setItemIndex(Math.max(0, safeItemIndex - 1)); return; }
      if (key.downArrow) { setItemIndex(Math.max(0, Math.min(filteredItems.length - 1, safeItemIndex + 1))); return; }
      if (key.return || key.rightArrow) {
        // No-op on an empty (filtered) list — never index into nothing.
        if (filteredItems.length === 0) return;
        openItem(filteredItems[safeItemIndex]);
      }
      return;
    }

    // Preview level: scroll.
    if (key.escape || key.backspace || key.delete || key.leftArrow) { setLevel('items'); return; }
    if (key.upArrow) { setScroll((s) => Math.max(0, s - 1)); return; }
    if (key.downArrow) { setScroll((s) => Math.min(maxScroll, s + 1)); return; }
    if (key.pageUp) { setScroll((s) => Math.max(0, s - viewport)); return; }
    if (key.pageDown) setScroll((s) => Math.min(maxScroll, s + viewport));
  };

  // A confirm can arm AFTER help opened ('p'/'a' arm across an await; '?'
  // lands mid-flight) — close help so the y/n prompt is never buried under
  // "press any key to close help" while confirm-mode swallows keys.
  useEffect(() => {
    if (confirm !== null) setHelp(false);
  }, [confirm]);

  // Explicit input-mode dispatch. Precedence matters: a pending confirm
  // swallows every key (help/typing included); help sits above the typing
  // modes; typing modes are items-level only; everything else is normal.
  type InputMode = 'confirm' | 'help' | 'search' | 'filter' | 'normal';
  const inputMode: InputMode =
    confirm !== null ? 'confirm'
      : help ? 'help'
        : level === 'items' && typingSearch ? 'search'
          : level === 'items' && typingFilter ? 'filter'
            : 'normal';

  useInput((input, key) => {
    switch (inputMode) {
      case 'confirm': handleConfirmInput(input, key); return;
      case 'help': handleHelpInput(); return;
      case 'search': handleSearchInput(input, key); return;
      case 'filter': handleFilterInput(input, key); return;
      case 'normal': handleNormalInput(input, key); return;
    }
  });

  // ── Render ────────────────────────────────────────────────────────────────

  const crumbs: string[] = [];
  if (level !== 'categories' && selectedCategory !== null) crumbs.push(selectedCategory.label);
  if (level === 'preview' && selectedItem !== null) crumbs.push(selectedItem.label);

  let body: React.ReactElement;
  let hint: string;

  if (help) {
    // Full-body help replacement; the live-refresh effects keep running under
    // it, and any key restores the view (see handleHelpInput).
    hint = 'press any key to close help';
    body = (
      <Box flexDirection="column">
        <Text color={col('cyan')} bold>Navigation</Text>
        <Text color={col('gray')}>  ↑/↓ move (scroll in preview) · enter/→ open · esc/⌫/← back · PgUp/PgDn page (preview) · q quit</Text>
        <Text color={col('cyan')} bold>Filter (items)</Text>
        <Text color={col('gray')}>  / filter as you type · esc clears</Text>
        <Text color={col('cyan')} bold>Sort (items)</Text>
        <Text color={col('gray')}>  o cycle order: newest → oldest → label</Text>
        <Text color={col('cyan')} bold>Search (items)</Text>
        <Text color={col('gray')}>  s semantic search · enter run · esc cancel / restore list</Text>
        <Text color={col('cyan')} bold>Archive (items)</Text>
        <Text color={col('gray')}>  a archive live plan or daily file · w archive daily file → weekly · y/n confirm</Text>
        <Text color={col('gray')}>  u undo the last archive · y/n confirm</Text>
        <Text color={col('cyan')} bold>Claims & plans (items)</Text>
        <Text color={col('gray')}>  r release a stale file claim (refused if holder live) · p advance a plan (draft→active→completed) · y/n confirm</Text>
        <Text color={col('cyan')} bold>Help</Text>
        <Text color={col('gray')}>  ? open this help · any key closes it</Text>
      </Box>
    );
  } else if (level === 'categories') {
    const catCount = categories?.length ?? 0;
    const catPos = catCount === 0 ? 0 : Math.min(catIndex, catCount - 1) + 1;
    hint = `↑/↓ move · enter/→ open · ? help · q/esc quit · ${catPos}/${catCount}`;
    if (categories === null) {
      body = <Text color={col('gray')}>Loading…</Text>;
    } else {
      const { slice, start } = windowSlice(categories, catIndex, viewport);
      body = (
        <Box flexDirection="column">
          {slice.map((cat, i) => {
            const selected = start + i === catIndex;
            return (
              <Text key={cat.id} wrap="truncate-end">
                <Text color={selected ? col('cyan') : undefined} bold={selected}>
                  {selected ? '▸ ' : '  '}{cat.label}
                </Text>
                <Text color={col('gray')}> ({cat.count})</Text>
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
    // The search-results view is the only state whose back key does something
    // unusual (restore the pre-search list), so it earns an inline note; normal
    // ↑/↓ move · ↵ open · esc/⌫/← back are universal and live in the ? help
    // overlay, and dropping them keeps this line inside 80 cols even with the
    // contextual action and a 3-digit counter (see the hint assembly below).
    const escHint = searchSnapshot !== null ? 'esc restore list · ' : '';
    // Contextual action key: only the relevant category advertises r/p, so the
    // (already long) hint line stays readable elsewhere.
    const actionHint = selectedCategory?.id === 'claims'
      ? ' · r release'
      : selectedCategory?.id === 'plans'
        ? ' · p advance'
        : '';
    const orderHint = order === 'default' ? '' : `[${order}] `;
    if (confirm !== null) {
      hint = confirmHint(confirm);
    } else if (typingSearch) {
      hint = `search: ${searchQuery}▌ (enter run · esc cancel)`;
    } else {
      hint = typingFilter
        ? filterHint
        : `${orderHint}${filterHint}${escHint}/ filter · o sort · s search · a/w archive${actionHint} · ? help · q quit · ${filteredItems.length === 0 ? 0 : safeItemIndex + 1}/${filteredItems.length}`;
    }
    if (filteredItems.length === 0) {
      body = (
        <Text color={col('gray')}>
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
                <Text color={selected ? col('cyan') : undefined} bold={selected} dimColor={colorsEnabled ? (item.archived === true && !selected) : false}>
                  {selected ? '▸ ' : '  '}{item.label}
                </Text>
                {item.sublabel !== undefined && <Text color={col('gray')}>  {item.sublabel}</Text>}
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
      : `↑/↓ scroll · PgUp/PgDn page · esc/⌫/← back · ? help · q quit${lineInfo}`;
    const visible = contentLines.slice(scroll, scroll + viewport);
    body = (
      <Box flexDirection="column">
        {visible.map((line, i) => (
          <Text key={i} wrap="truncate-end">
            {lineText(line) === '' ? ' ' : line.map((s, j) => (
              <Text
                key={j}
                color={pulseLines.has(scroll + i) ? col('yellow') : s.color}
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

  // A pending confirm outranks every branch hint: it can arm mid-await after
  // esc dropped back to categories (force-escalation) or while help renders,
  // and confirm-mode swallows keys — a hidden prompt would look dead.
  if (confirm !== null) hint = confirmHint(confirm);

  return (
    <Box flexDirection="column">
      <Header crumbs={crumbs} width={width} colorsEnabled={colorsEnabled} />
      <Box flexDirection="column" minHeight={viewport}>
        {body}
      </Box>
      <Footer
        hint={toast !== null ? `⚑ ${toast}` : spinnerOn ? `${SPINNER_FRAMES[spinnerFrame]} ${hint}` : hint}
        width={width}
        colorsEnabled={colorsEnabled}
      />
    </Box>
  );
};

/**
 * Run the browse TUI. When stdin/stdout is not a TTY (raw mode unavailable,
 * e.g. piped input), prints a static category summary instead of crashing.
 */
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
