#!/usr/bin/env node
/**
 * Planning DevLog Server - Feature planning and research tools
 * Provides planning, research capture, and roadmap generation
 */

import { createDevlogServer, startServer } from './base-server.js';
import { planningTools } from '../tools/planning-tools.js';
import { conflictTools } from '../tools/conflict-tools.js';
import { ToolDefinition } from '../tools/registry.js';

// Combine planning and conflict detection tools
const planningServerTools: ToolDefinition[] = [
  // Planning tools
  ...planningTools,
  
  // Conflict detection (useful for planning)
  ...conflictTools
];

const config = {
  name: 'dokoro-planning',
  version: '1.0.0',
  description: 'Feature planning and research tools for DevLog'
};

const server = createDevlogServer(config);

// Start the server
startServer(server, planningServerTools, config).catch(console.error);