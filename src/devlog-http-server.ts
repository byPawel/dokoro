#!/usr/bin/env node
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { promises as fs } from 'fs';
import path from 'path';
import { glob } from 'glob';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolResult, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

// Get devlog path from environment or use default
const DEVLOG_PATH = process.env.DEVLOG_PATH || path.join(process.cwd(), '..', 'devlog');
const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT) : 3100;

// Helper to read devlog files
async function readDevlogFile(filePath: string) {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    console.error(`Error reading file ${filePath}:`, error);
    return null;
  }
}

// Helper to search devlog entries
async function searchDevlogs(query: string, type: string = 'all') {
  const patterns: Record<string, string> = {
    posts: 'posts/**/*.md',
    ideas: 'ideas-to-verify/**/*.md',
    features: 'features_plan/**/*.md',
    all: '**/*.md',
  };
  
  const pattern = patterns[type] || patterns.all;
  const files = await glob(pattern, { cwd: DEVLOG_PATH });
  
  const results = [];
  for (const file of files) {
    const content = await readDevlogFile(path.join(DEVLOG_PATH, file));
    if (content && content.toLowerCase().includes(query.toLowerCase())) {
      results.push({
        file,
        excerpt: content.substring(0, 200) + '...',
        lastModified: (await fs.stat(path.join(DEVLOG_PATH, file))).mtime,
      });
    }
  }
  
  return results.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
}

// Create DevLog MCP server
const getDevLogServer = () => {
  const server = new McpServer({
    name: 'mcp-devlog-http',
    version: '2.0.0',
    description: 'DevLog MCP server (HTTP mode) for development insights'
  }, {
    capabilities: {
      resources: {},
      tools: {},
      prompts: {},
    },
  });

  // Register search tool
  server.registerTool(
    'search_devlogs',
    {
      title: 'Search DevLogs',
      description: 'Search across all devlog entries',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: {
        query: z.string().describe('Search query'),
        type: z.enum(['posts', 'ideas', 'features', 'all']).optional().default('all'),
        limit: z.number().optional().default(10),
      } as any,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async ({ query, type, limit }: any): Promise<CallToolResult> => {
      const results = await searchDevlogs(query, type);
      const limited = results.slice(0, limit);
      
      return {
        content: [
          {
            type: 'text',
            text: `Found ${results.length} results for "${query}":\n\n` +
              limited.map(r => `- ${r.file} (${r.lastModified.toISOString()})\n  ${r.excerpt}`).join('\n\n'),
          },
        ],
      };
    }
  );

  // Register recent devlogs tool
  server.registerTool(
    'list_recent_devlogs',
    {
      title: 'List Recent DevLogs',
      description: 'List recently modified devlog entries',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: {
        days: z.number().optional().default(7).describe('Number of days to look back'),
        type: z.enum(['posts', 'ideas', 'features', 'all']).optional().default('all'),
      } as any,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async ({ days, type }: any): Promise<CallToolResult> => {
      const patterns: Record<string, string> = {
        posts: 'posts/**/*.md',
        ideas: 'ideas-to-verify/**/*.md',
        features: 'features_plan/**/*.md',
        all: '**/*.md',
      };
      
      const pattern = patterns[type] || patterns.all;
      const files = await glob(pattern, { cwd: DEVLOG_PATH });
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);
      
      const recentFiles = [];
      for (const file of files) {
        const stats = await fs.stat(path.join(DEVLOG_PATH, file));
        if (stats.mtime > cutoffDate) {
          recentFiles.push({
            file,
            modified: stats.mtime,
          });
        }
      }
      
      recentFiles.sort((a, b) => b.modified.getTime() - a.modified.getTime());
      
      return {
        content: [
          {
            type: 'text',
            text: `Recent devlogs (last ${days} days):\n\n` +
              recentFiles.map(f => `- ${f.file} (${f.modified.toISOString()})`).join('\n'),
          },
        ],
      };
    }
  );

  // Register feature history tool
  server.registerTool(
    'analyze_feature_history',
    {
      title: 'Analyze Feature History',
      description: 'Get the development history of a specific feature',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: {
        featureName: z.string().describe('Name of the feature to analyze'),
      } as any,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async ({ featureName }: any): Promise<CallToolResult> => {
      const results = await searchDevlogs(featureName);
      
      // Group by type
      const posts = results.filter(r => r.file.startsWith('posts/'));
      const ideas = results.filter(r => r.file.startsWith('ideas-to-verify/'));
      const features = results.filter(r => r.file.startsWith('features_plan/'));
      
      return {
        content: [
          {
            type: 'text',
            text: `Feature "${featureName}" analysis:\n\n` +
              `Development Posts (${posts.length}):\n` +
              posts.map(p => `- ${p.file}`).join('\n') +
              `\n\nIdeas (${ideas.length}):\n` +
              ideas.map(i => `- ${i.file}`).join('\n') +
              `\n\nFeature Plans (${features.length}):\n` +
              features.map(f => `- ${f.file}`).join('\n'),
          },
        ],
      };
    }
  );

  // Register a test tool
  server.registerTool(
    'test_devlog_connection',
    {
      title: 'Test DevLog Connection',
      description: 'Test if the devlog server is working',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: {} as any,
    },
    async (): Promise<CallToolResult> => {
      return {
        content: [
          {
            type: 'text',
            text: `✅ DevLog MCP Server is running!\n\nDevLog Path: ${DEVLOG_PATH}\nServer Port: ${MCP_PORT}`,
          },
        ],
      };
    }
  );

  return server;
};

// Create Express app
const app = express();
app.use(cors());
app.use(express.json());

// Map to store transports by session ID
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

// Welcome page
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>DevLog MCP Server</title></head>
      <body>
        <h1>DevLog MCP Server v2.0</h1>
        <p>HTTP-based Model Context Protocol server for DevLog analysis</p>
        
        <h2>Status</h2>
        <ul>
          <li>Server: ✅ Running</li>
          <li>Port: ${MCP_PORT}</li>
          <li>DevLog Path: ${DEVLOG_PATH}</li>
          <li>Active Sessions: ${Object.keys(transports).length}</li>
        </ul>
        
        <h2>Available Tools</h2>
        <ul>
          <li><code>search_devlogs</code> - Search across devlog entries</li>
          <li><code>list_recent_devlogs</code> - List recent modifications</li>
          <li><code>analyze_feature_history</code> - Analyze feature development</li>
          <li><code>test_devlog_connection</code> - Test server connection</li>
        </ul>
        
        <h2>Test with curl</h2>
        <pre>
# Initialize session
curl -X POST http://localhost:${MCP_PORT}/mcp \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl-test","version":"1.0.0"}},"id":1}'
        </pre>
      </body>
    </html>
  `);
});

// MCP POST endpoint
app.post('/mcp', async (req, res) => {
  console.log('Received MCP request:', req.body);
  
  try {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      // Reuse existing transport
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New initialization request
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          console.log(`Session initialized with ID: ${sessionId}`);
          transports[sessionId] = transport;
        }
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          console.log(`Transport closed for session ${sid}`);
          delete transports[sid];
        }
      };

      // Connect the transport to the MCP server
      const server = getDevLogServer();
      await server.connect(transport);

      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID provided',
        },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
});

// Start server
app.listen(MCP_PORT, () => {
  console.log(`🚀 DevLog MCP HTTP Server running at http://localhost:${MCP_PORT}`);
  console.log(`📁 DevLog Path: ${DEVLOG_PATH}`);
  console.log(`\n📄 Visit http://localhost:${MCP_PORT} for server info`);
});