#!/usr/bin/env node
/**
 * Search DevLog Server - LanceDB powered semantic search
 * Provides hybrid vector + FTS5 search with Ollama embeddings
 */

import { createDevlogServer, startServer } from './base-server.js';
import { lancedbTools } from '../tools/lancedb-tools.js';
import { basicTools } from '../tools/basic-tools.js';
import { getSqliteDb } from '../db/index.js';
import { startBackgroundIndexer } from '../services/background-indexer.js';
import { DOKORO_PATH } from '../shared/dokoro-utils.js';
import * as path from 'node:path';
import type { ToolDefinition } from '../tools/registry.js';

async function main() {
  // All LanceDB tools + grep-based fallback
  const allTools: ToolDefinition[] = [
    ...lancedbTools,
    basicTools.find(t => t.name === 'search_devlogs')!,
  ].filter(Boolean);

  // Conditionally load tachibot bridge tools (dynamic import = zero cost when disabled)
  if (process.env.DOKORO_ENABLE_TACHIBOT_BRIDGE === 'true') {
    const { bridgeTools } = await import('../tools/bridge-tools.js');
    allTools.push(...bridgeTools);
    console.error(`[SearchServer] Tachibot bridge: ${bridgeTools.length} tools loaded`);
  }

  const config = {
    name: 'dokoro-search',
    version: '2.0.0',
    description: 'LanceDB-powered hybrid semantic search for DevLog entries',
  };

  const server = createDevlogServer(config);

  // Start the server, then kick off background indexing
  await startServer(server, allTools, config);

  try {
    const projectPath = path.dirname(DOKORO_PATH);
    const sqlite = getSqliteDb({ projectPath, devlogFolder: path.basename(DOKORO_PATH) });
    startBackgroundIndexer(sqlite, path.join(projectPath, path.basename(DOKORO_PATH)));
  } catch (err) {
    console.error('[SearchServer] Background indexer failed to start:', err);
  }
}

main().catch(console.error);
