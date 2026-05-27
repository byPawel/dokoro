#!/usr/bin/env node
/**
 * Base server setup for all devlog MCP servers
 */

import { McpServer } from '../server/mcp.js';
import { StdioServerTransport } from '../server/stdio.js';
import { ToolDefinition, registerTools } from '../tools/registry.js';
import { withToolTracking } from '../utils/tool-tracker.js';
import { DEVLOG_PATH } from '../shared/devlog-utils.js';
import { promises as fs } from 'fs';
import path from 'node:path';
import { getSqliteDb } from '../db/index.js';
import { CompactionService } from '../services/compaction-service.js';

export interface ServerConfig {
  name: string;
  version: string;
  description: string;
  vendor?: string;
}

export function createDevlogServer(config: ServerConfig): McpServer {
  const server = new McpServer({
    name: config.name,
    vendor: config.vendor || 'turbowizard',
    version: config.version,
    description: config.description
  }, {
    capabilities: {
      tools: {}
    }
  });
  return server;
}

async function isDevlogInitialized(): Promise<boolean> {
  try {
    await fs.access(DEVLOG_PATH);
    return true;
  } catch {
    return false;
  }
}

export async function startServer(server: McpServer, tools: ToolDefinition[], config: ServerConfig) {
  // Register all tools with tracking
  const trackedTools = tools.map(tool => ({
    ...tool,
    handler: withToolTracking(tool.name, tool.handler)
  }));
  
  registerTools(server, trackedTools);
  
  // Connect to transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  // Check if devlog is initialized
  const devlogExists = await isDevlogInitialized();
  
  if (!devlogExists) {
    console.error('⚠️  DevLog not initialized in this project!');
    console.error('   Run "devlog_init" to create devlog structure.');
    console.error('   Current path:', DEVLOG_PATH);
  } else {
    // Crash recovery: re-compact any sessions left mid-compaction at last exit.
    try {
      const projectPath = path.dirname(DEVLOG_PATH);
      const sqlite = getSqliteDb({ projectPath, devlogFolder: path.basename(DEVLOG_PATH) });
      const recovered = await new CompactionService(sqlite).recoverAll();
      if (recovered.length) {
        console.error(`   Recovered ${recovered.length} pending compaction(s).`);
      }
    } catch (e) {
      console.error('   Compaction recovery skipped:', (e as Error).message);
    }
    console.error(`✅ ${config.name} v${config.version} running...`);
    console.error('   DevLog path:', DEVLOG_PATH);
  }
}