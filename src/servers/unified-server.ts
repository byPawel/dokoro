#!/usr/bin/env node
/**
 * Unified Dokoro Server - All tools in one process
 *
 * Zero-config starter mode: dokoro init && dokoro serve
 * Registers core + search + planning + tracking tools.
 */

import { createDokoroServer, startServer } from './base-server.js';
import { workspaceTools } from '../tools/workspace-tools.js';
import { currentWorkspaceTools } from '../tools/current-workspace-tools.js';
import { dokoroInitTool } from '../tools/dokoro-init-tool.js';
import { questionTools } from '../tools/question-tools.js';
import { assetTools } from '../tools/asset-tools.js';
import { planTools } from '../tools/plan-tools.js';
import { contextTools } from '../tools/context-tools.js';
import { basicTools } from '../tools/basic-tools.js';
import { entityTools } from '../tools/entity-tools.js';
import { presenceTools } from '../tools/presence-tools.js';
import { fileClaimTools } from '../tools/file-claim-tools.js';
import { archiveTools } from '../tools/archive-tools.js';
import { DOKORO_VERSION } from '../shared/constants.js';
import type { ToolDefinition } from '../tools/registry.js';

// NOTE: the unified server registers a curated subset of tools — core-server.ts
// is the full surface (feedback, handoffs, shared notes/blocks, etc.).
// Exported for use in tests.
export const unifiedTools: ToolDefinition[] = [
  ...workspaceTools,
  ...currentWorkspaceTools,
  ...questionTools,
  ...assetTools,
  ...planTools,
  ...contextTools,
  dokoroInitTool,
  ...basicTools,
  ...entityTools,
  // Agent presence (heartbeat) — registered alongside the claim tools so claim
  // liveness labels don't silently degrade to "unknown" on the unified server.
  ...presenceTools,
  // Advisory per-file claims (lease + takeover, per-project)
  ...fileClaimTools,
  // Archive maintenance (workspace sweep + status readout)
  ...archiveTools,
];

async function main() {
  const allTools: ToolDefinition[] = [...unifiedTools];

  // Optional: LanceDB tools (requires Ollama)
  try {
    const { lancedbTools } = await import('../tools/lancedb-tools.js');
    allTools.push(...lancedbTools);
    console.error('[Unified] LanceDB tools loaded');
  } catch {
    console.error('[Unified] LanceDB tools unavailable (Ollama not running?)');
  }

  // Optional: Bridge tools
  if (process.env.DOKORO_ENABLE_TACHIBOT_BRIDGE === 'true') {
    const { bridgeTools } = await import('../tools/bridge-tools.js');
    allTools.push(...bridgeTools);
    console.error(`[Unified] Bridge tools loaded: ${bridgeTools.length} tools`);
  }

  const config = {
    name: 'dokoro-unified',
    version: DOKORO_VERSION,
    description: 'Unified Dokoro MCP Server - all tools in one process',
  };

  const server = createDokoroServer(config);
  await startServer(server, allTools, config);
}

main().catch(console.error);
