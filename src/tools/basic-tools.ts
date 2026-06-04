import { z } from 'zod';
import { ToolDefinition } from './registry.js';
import { searchDevlogs } from '../utils/search.js';
import { DOKORO_PATH } from '../types/dokoro.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { renderOutput } from '../utils/render-output.js';

export const basicTools: ToolDefinition[] = [
  {
    name: 'test_connection',
    title: 'Test Connection',
    description: 'Test if the MCP server is working',
    inputSchema: {},
    handler: async (): Promise<CallToolResult> => {
      return {
        content: [
          {
            type: 'text',
            text: renderOutput({
              type: 'status-card',
              data: {
                title: 'MCP DevLog Server',
                status: 'success',
                message: 'Server is working!',
                details: {
                  'DevLog Path': DOKORO_PATH,
                },
              },
            }),
          },
        ],
      };
    }
  },

  {
    name: 'search_devlogs',
    title: 'Search DevLogs',
    description: 'Search across all devlog entries with optional tag filtering',
    inputSchema: {
      query: z.string().describe('Search query (optional if using tags)').optional().default(''),
      type: z.enum(['insights', 'decisions', 'features', 'daily', 'current', 'all']).optional().default('all'),
      limit: z.number().optional().default(10),
      tags: z.record(z.any()).optional().describe('Tag filters as key-value pairs'),
    },
    handler: async ({ query, type, limit, tags }): Promise<CallToolResult> => {
      const results = await searchDevlogs(query || '', type, tags);
      const limited = results.slice(0, limit);

      return {
        content: [
          {
            type: 'text',
            text: renderOutput({
              type: 'search-results',
              data: limited.map(r => ({
                file: r.file,
                title: r.title,
                excerpt: r.excerpt,
                tags: r.tags,
                lastModified: r.lastModified,
              })),
            }),
          },
        ],
      };
    }
  },

  {
    name: 'list_recent_devlogs',
    title: 'List Recent DevLogs',
    description: 'List recently modified devlog entries',
    inputSchema: {
      days: z.number().optional().default(7).describe('Number of days to look back'),
      type: z.enum(['posts', 'ideas', 'features', 'all']).optional().default('all'),
    },
    handler: async ({ days, type }): Promise<CallToolResult> => {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      const results = await searchDevlogs('', type);
      const recent = results.filter(r => r.lastModified > cutoffDate);

      if (recent.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'Recent DevLogs',
                  status: 'info',
                  message: `No devlog entries found in the last ${days} days.`,
                },
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: renderOutput({
              type: 'search-results',
              data: recent.map(r => ({
                file: r.file,
                title: r.title,
                excerpt: r.excerpt,
                lastModified: r.lastModified,
              })),
            }),
          },
        ],
      };
    }
  }
];