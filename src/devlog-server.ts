#!/usr/bin/env node
import { z } from 'zod';
import { promises as fs } from 'fs';
import path from 'path';
import { glob } from 'glob';
import { McpServer } from './server/mcp.js';
import { StdioServerTransport } from './server/stdio.js';
import { CallToolResult, GetPromptResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

// Get devlog path from environment or use default
import { DEVLOG_PATH } from './shared/devlog-utils.js';

// Initialize the MCP server
const server = new McpServer({
  name: 'mcp-devlog',
  vendor: 'turbowizard',
  version: '2.0.0',
  description: 'DevLog MCP server for development insights and test tracking'
}, {
  capabilities: {
    resources: {},
    tools: {},
    prompts: {},
  },
});

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

// Register tools
server.tool(
  'search_devlogs',
  'Search across all devlog entries',
  {
    query: z.string().describe('Search query'),
    type: z.enum(['posts', 'ideas', 'features', 'all']).optional().default('all'),
    limit: z.number().optional().default(10),
  },
  async ({ query, type, limit }): Promise<CallToolResult> => {
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

server.tool(
  'list_recent_devlogs',
  'List recently modified devlog entries',
  {
    days: z.number().optional().default(7).describe('Number of days to look back'),
    type: z.enum(['posts', 'ideas', 'features', 'all']).optional().default('all'),
  },
  async ({ days, type }): Promise<CallToolResult> => {
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

server.tool(
  'analyze_feature_history',
  'Get the development history of a specific feature',
  {
    featureName: z.string().describe('Name of the feature to analyze'),
  },
  async ({ featureName }): Promise<CallToolResult> => {
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

// Register prompts
server.registerPrompt(
  'devlog_summary',
  {
    title: 'DevLog Summary',
    description: 'Generate a summary of recent development activities',
    argsSchema: {
      days: z.string().optional().describe('Number of days to analyze'),
    },
  },
  async ({ days = '7' }): Promise<GetPromptResult> => {
    const numDays = parseInt(days, 10);
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Please analyze the devlogs from the last ${numDays} days and provide:
1. A summary of completed features
2. Current work in progress
3. Identified blockers or issues
4. Upcoming priorities

Use the list_recent_devlogs tool to get the recent files, then analyze their content.`,
          },
        },
      ],
    };
  }
);

server.registerPrompt(
  'test_coverage_analysis',
  {
    title: 'Test Coverage Analysis',
    description: 'Analyze which features need more testing',
    argsSchema: {
      feature: z.string().optional().describe('Specific feature to analyze'),
    },
  },
  async ({ feature }): Promise<GetPromptResult> => {
    const featureClause = feature ? ` for the "${feature}" feature` : '';
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Please analyze the devlogs${featureClause} and identify:
1. Which components have been tested
2. Which areas lack test coverage
3. Potential edge cases that need testing
4. Regression risks

Use the search_devlogs and analyze_feature_history tools to gather information.`,
          },
        },
      ],
    };
  }
);

server.registerPrompt(
  'development_velocity',
  {
    title: 'Development Velocity',
    description: 'Analyze development pace and patterns',
    argsSchema: {
      period: z.enum(['week', 'month']).optional().describe('Period to analyze'),
    },
  },
  async ({ period = 'week' }): Promise<GetPromptResult> => {
    const days = period === 'week' ? 7 : 30;
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Please analyze the development velocity over the last ${period}:
1. Number of features completed
2. Average time from idea to implementation
3. Common blockers or delays
4. Productivity patterns

Use the list_recent_devlogs tool with ${days} days to gather data.`,
          },
        },
      ],
    };
  }
);

// Register resources
server.registerResource(
  'recent-posts',
  'devlog://posts/recent',
  {
    title: 'Recent DevLog Posts',
    description: 'List recent devlog posts',
    mimeType: 'text/plain',
  },
  async (): Promise<ReadResourceResult> => {
    const postFiles = await glob('posts/**/*.md', { cwd: DEVLOG_PATH });
    const sortedFiles = await Promise.all(
      postFiles.map(async (file: string) => {
        const stats = await fs.stat(path.join(DEVLOG_PATH, file));
        return { file, mtime: stats.mtime };
      })
    );
    
    sortedFiles.sort((a: { mtime: Date }, b: { mtime: Date }) => b.mtime.getTime() - a.mtime.getTime());
    const recent = sortedFiles.slice(0, 10);
    
    return {
      contents: recent.map(({ file }: { file: string }) => ({
        uri: `devlog://posts/${file}`,
        mimeType: 'text/markdown',
        text: file,
      })),
    };
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('DevLog MCP Server v2.0 running...');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});