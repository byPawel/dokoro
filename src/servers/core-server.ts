#!/usr/bin/env node
/**
 * Core DevLog Server - Always loaded
 * Provides essential workspace management tools
 */

import { createDevlogServer, startServer } from './base-server.js';
import { workspaceTools } from '../tools/workspace-tools.js';
import { currentWorkspaceTools } from '../tools/current-workspace-tools.js';
import { devlogInitTool } from '../tools/devlog-init-tool.js';
import { questionTools } from '../tools/question-tools.js';
import { assetTools } from '../tools/asset-tools.js';
import { planTools } from '../tools/plan-tools.js';
import { entityTools } from '../tools/entity-tools.js';
import { feedbackTools } from '../tools/feedback-tools.js';

// Select only the core tools
const coreTools = [
  // Workspace management (includes time tracking)
  workspaceTools.find(t => t.name === 'devlog_workspace_status')!,
  workspaceTools.find(t => t.name === 'devlog_workspace_claim')!,
  workspaceTools.find(t => t.name === 'devlog_workspace_dump')!,
  workspaceTools.find(t => t.name === 'devlog_session_log')!,
  workspaceTools.find(t => t.name === 'devlog_session_recall')!,

  // Current.md management
  currentWorkspaceTools.find(t => t.name === 'devlog_current_update')!,

  // Question tracking
  ...questionTools,

  // Asset management (images, files)
  ...assetTools,

  // Plan tracking with timestamps
  ...planTools,

  // Entity knowledge graph
  ...entityTools,

  // Affective memory (agent feedback)
  ...feedbackTools,

  // Initialization
  devlogInitTool
].filter(Boolean);

const config = {
  name: 'devlog-core',
  version: '1.0.0',
  description: 'Core DevLog workspace management tools'
};

const server = createDevlogServer(config);

// Start the server
startServer(server, coreTools, config).catch(console.error);