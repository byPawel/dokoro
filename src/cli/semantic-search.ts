/**
 * Hybrid (FTS5 + LanceDB) search wrapper for the browse TUI. NO ink imports.
 *
 * The vector stack is OPTIONAL (optionalDependencies + Ollama): everything is
 * lazily imported, capped by a hard timeout, and a failure trips a cooldown
 * breaker so the TUI never hangs repeatedly. Results map to BrowseItems by
 * FILEPATH (never docId — docs are dokoro documents; browse items are files),
 * so every result is an ordinary openable file item. Never throws.
 */

import path from 'path';
import type { BrowseItem } from './browse-data.js';

export interface SemanticOutcome {
  ok: boolean;
  items: BrowseItem[];
  note: string;
}

const TIMEOUT_MS = 5000;
const COOLDOWN_MS = 60_000;
let cooldownUntil = 0;

/** Test hook. */
export function resetSemanticCooldown(): void {
  cooldownUntil = 0;
}

export async function semanticSearchItems(
  projectPath: string,
  query: string,
  limit = 15,
): Promise<SemanticOutcome> {
  if (Date.now() < cooldownUntil) {
    return { ok: false, items: [], note: 'semantic search cooling down after a failure — using fuzzy only' };
  }
  // The race's timer must not hold the event loop open after a fast search.
  let timer: NodeJS.Timeout | undefined;
  try {
    const [{ createVectorServices }, { getSqliteDb }] = await Promise.all([
      import('../services/vector-service.js'),
      import('../db/index.js'),
    ]);
    const injected = (globalThis as Record<string, unknown>).__TEST_DB__;
    const sqlite = (injected ?? getSqliteDb({ projectPath })) as Parameters<typeof createVectorServices>[0];
    const { searchService } = createVectorServices(sqlite, projectPath);

    const results = await Promise.race([
      searchService.search(query, limit),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
      }),
    ]);

    const items: BrowseItem[] = results
      .filter((r): r is typeof r & { filepath: string } => typeof r.filepath === 'string' && r.filepath !== '')
      .map((r) => ({
        id: `search/${r.docId}`,
        label: r.title !== '' ? r.title : path.basename(r.filepath),
        sublabel: `${r.source} ${r.score.toFixed(3)} · ${r.filepath}`,
        kind: 'file' as const,
        path: path.isAbsolute(r.filepath) ? r.filepath : path.join(projectPath, r.filepath),
      }));
    return {
      ok: true,
      items,
      note: items.length === 0 ? 'no semantic matches' : `${items.length} hybrid results`,
    };
  } catch (error: unknown) {
    cooldownUntil = Date.now() + COOLDOWN_MS;
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, items: [], note: `semantic search unavailable: ${msg}` };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
