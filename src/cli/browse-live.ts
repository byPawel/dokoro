/**
 * Live-refresh primitives for the browse TUI. NO ink imports.
 *
 * `watchDirs` watches DIRECTORIES (never individual files: the MCP server
 * writes plans and index.json via temp-file + atomic rename, which breaks
 * per-file watchers silently). Events are treated as debounced dirty hints —
 * callers rescan from the source of truth. A slow reconcile tick recovers
 * anything fs.watch missed. `startPolling` is a recursive setTimeout loop
 * whose ticks never overlap.
 */

import { watch, type FSWatcher } from 'fs';

export interface LiveHandle {
  stop(): void;
}

export interface WatchOptions {
  /** Quiet window after the last fs event before firing. Default 300ms. */
  debounceMs?: number;
  /** Safety-net tick when fs.watch drops events. Default 20s. */
  reconcileMs?: number;
}

export function watchDirs(
  dirs: string[],
  onDirty: () => void,
  opts: WatchOptions = {},
): LiveHandle {
  const debounceMs = opts.debounceMs ?? 300;
  const reconcileMs = opts.reconcileMs ?? 20_000;
  const watchers: FSWatcher[] = [];
  let debounce: NodeJS.Timeout | null = null;
  let stopped = false;

  const fire = (): void => {
    if (stopped) return;
    if (debounce !== null) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      if (!stopped) onDirty();
    }, debounceMs);
  };

  for (const dir of dirs) {
    try {
      const w = watch(dir, fire);
      w.on('error', () => { /* deleted dir etc. — reconcile tick covers it */ });
      watchers.push(w);
    } catch {
      // Missing directory: stay silent, reconcile tick still runs.
    }
  }

  const reconcile = setInterval(() => {
    if (!stopped) onDirty();
  }, reconcileMs);

  return {
    stop(): void {
      stopped = true;
      if (debounce !== null) clearTimeout(debounce);
      clearInterval(reconcile);
      for (const w of watchers) w.close();
    },
  };
}

export function startPolling(intervalMs: number, tick: () => Promise<void>): LiveHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const loop = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick()
        .catch(() => { /* poll errors are non-fatal; next tick retries */ })
        .finally(() => loop());
    }, intervalMs);
  };

  loop();
  return {
    stop(): void {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
}
