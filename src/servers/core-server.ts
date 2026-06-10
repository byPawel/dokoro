#!/usr/bin/env node
/**
 * Core Dokoro Server - Always loaded
 * Provides essential workspace management tools
 */

import { createDokoroServer, startServer } from './base-server.js';
import { workspaceTools } from '../tools/workspace-tools.js';
import { currentWorkspaceTools } from '../tools/current-workspace-tools.js';
import { dokoroInitTool } from '../tools/dokoro-init-tool.js';
import { questionTools } from '../tools/question-tools.js';
import { assetTools } from '../tools/asset-tools.js';
import { planTools } from '../tools/plan-tools.js';
import { entityTools } from '../tools/entity-tools.js';
import { feedbackTools } from '../tools/feedback-tools.js';
import { sharedNotesTools } from '../tools/shared-notes-tools.js';
import { sharedBlocksTools } from '../tools/shared-blocks-tools.js';
import { handoffTools } from '../tools/handoff-tools.js';
import { presenceTools } from '../tools/presence-tools.js';
import { fileClaimTools } from '../tools/file-claim-tools.js';
import { contextInspectTools } from '../tools/context-inspect-tools.js';

// Select only the core tools
// Exported for use in tests.
export const coreTools = [
  // Workspace management (includes time tracking)
  workspaceTools.find(t => t.name === 'dokoro_workspace_status')!,
  workspaceTools.find(t => t.name === 'dokoro_workspace_claim')!,
  workspaceTools.find(t => t.name === 'dokoro_workspace_dump')!,
  workspaceTools.find(t => t.name === 'dokoro_session_log')!,
  workspaceTools.find(t => t.name === 'dokoro_session_recall')!,
  workspaceTools.find(t => t.name === 'dokoro_session_summary_add')!,

  // Current.md management
  ...currentWorkspaceTools,

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

  // Shared working memory (concurrent multi-agent notes, per-project)
  ...sharedNotesTools,

  // Shared editable working-memory blocks (optimistic concurrency, per-project)
  ...sharedBlocksTools,

  // Cross-session handoff (write/inbox/claim with atomic claim, per-project)
  ...handoffTools,

  // Agent presence (daemonless heartbeat, read-time liveness, per-project)
  ...presenceTools,

  // Advisory per-file claims (lease + takeover, per-project)
  ...fileClaimTools,

  // Context-inspector events (file-based JSONL, per-day)
  ...contextInspectTools,

  // Initialization
  dokoroInitTool
].filter(Boolean);

const config = {
  name: 'dokoro-core',
  version: '1.0.0',
  description: 'Core Dokoro workspace management tools'
};

const server = createDokoroServer(config);

// Start the server
startServer(server, coreTools, config).catch(console.error);