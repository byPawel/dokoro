#!/usr/bin/env node
/**
 * Analytics DevLog Server - Time tracking and productivity analytics
 * Provides time tracking, velocity insights, and pattern analysis
 */

import { createDevlogServer, startServer } from './base-server.js';
import { taskTrackingTools } from '../tools/task-tracking-tools.js';
import { analysisTools } from '../tools/analysis-tools.js';
import { compressionTool } from '../tools/compression-tool.js';
import { ToolDefinition } from '../tools/registry.js';

// Combine analytics and time tracking tools
const analyticsTools: ToolDefinition[] = [
  // Time tracking tools (NEW)
  ...taskTrackingTools,
  
  // Analysis tools
  ...analysisTools,
  
  // Compression (includes analytics)
  compressionTool
];

const config = {
  name: 'dokoro-analytics',
  version: '1.0.0',
  description: 'Time tracking and productivity analytics for DevLog'
};

const server = createDevlogServer(config);

// Start the server
startServer(server, analyticsTools, config).catch(console.error);