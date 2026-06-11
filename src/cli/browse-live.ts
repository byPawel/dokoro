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

/** Handle to a live-refresh loop; stop() tears down timers/watchers and prevents further callbacks. */
export interface LiveHandle {
  stop(): void;
}

export interface WatchOptions {
  /** Quiet window after the last fs event before firing. Default 300ms. */
  debounceMs?: number;
  /** Safety-net tick when fs.watch drops events. Default 20s. */
  reconcileMs?: number;
}

/** Watches directories (never files) and fires debounced dirty hints, with a slow reconcile tick as a safety net. */
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
      // LOAD-BEARING: clearTimeout in stop() is best-effort — a timer that
      // already expired in the same tick still runs its callback.
      if (!stopped) onDirty();
    }, debounceMs);
    debounce.unref();
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
  reconcile.unref();

  return {
    stop(): void {
      stopped = true;
      if (debounce !== null) clearTimeout(debounce);
      clearInterval(reconcile);
      for (const w of watchers) w.close();
    },
  };
}

/** Runs tick on a recursive setTimeout loop so ticks never overlap; tick errors are swallowed. */
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
    timer.unref();
  };

  loop();
  return {
    stop(): void {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
}
