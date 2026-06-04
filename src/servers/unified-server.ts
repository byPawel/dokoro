#!/usr/bin/env node
/**
 * Unified DevLog Server - All tools in one process
 *
 * Zero-config starter mode: devlog init && devlog serve
 * Registers core + search + planning + tracking tools.
 */

import { createDevlogServer, startServer } from './base-server.js';
import { workspaceTools } from '../tools/workspace-tools.js';
import { currentWorkspaceTools } from '../tools/current-workspace-tools.js';
import { devlogInitTool } from '../tools/dokoro-init-tool.js';
import { questionTools } from '../tools/question-tools.js';
import { assetTools } from '../tools/asset-tools.js';
import { planTools } from '../tools/plan-tools.js';
import { contextTools } from '../tools/context-tools.js';
import { basicTools } from '../tools/basic-tools.js';
import { entityTools } from '../tools/entity-tools.js';
import type { ToolDefinition } from '../tools/registry.js';

async function main() {
  const allTools: ToolDefinition[] = [
    ...workspaceTools,
    ...currentWorkspaceTools,
    ...questionTools,
    ...assetTools,
    ...planTools,
    ...contextTools,
    devlogInitTool,
    ...basicTools,
    ...entityTools,
  ];

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
    version: '2.0.0',
    description: 'Unified DevLog MCP Server - all tools in one process',
  };

  const server = createDevlogServer(config);
  await startServer(server, allTools, config);
}

main().catch(console.error);
