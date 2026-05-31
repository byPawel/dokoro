import { z } from 'zod';
import { ToolDefinition } from './registry.js';
import { searchDevlogs } from '../utils/search.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { renderOutput } from '../utils/render-output.js';
// icon available for future use
// import { icon } from '../utils/icons.js';

export const tagTools: ToolDefinition[] = [
  {
    name: 'devlog_query_by_tags',
    title: 'Query by Tags',
    description: 'Query devlogs by specific tags',
    inputSchema: {
      tags: z.record(z.any()).describe('Tag filters as key-value pairs'),
      limit: z.number().optional().default(10),
    },
    handler: async ({ tags, limit }): Promise<CallToolResult> => {
      const results = await searchDevlogs('', 'all', tags);
      const limited = results.slice(0, limit);
      
      if (limited.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No devlogs found with tags: ${JSON.stringify(tags)}`,
            },
          ],
        };
      }
      
      return {
        content: [
          {
            type: 'text',
            text: `Found ${results.length} devlogs with specified tags:\n\n` +
              limited.map(r => {
                const tagStr = r.tags ? Object.entries(r.tags).map(([k, v]) => 
                  Array.isArray(v) ? `${k}: ${v.join(', ')}` : `${k}: ${v}`
                ).join('; ') : '';
                return `- ${r.file}\n  Tags: ${tagStr}\n  ${r.excerpt}`;
              }).join('\n\n'),
          },
        ],
      };
    }
  },
  
  {
    name: 'devlog_tag_stats',
    title: 'Tag Statistics',
    description: 'Get statistics about tag usage in devlogs',
    inputSchema: {},
    handler: async (): Promise<CallToolResult> => {
      const results = await searchDevlogs('');
      
      const tagStats: Record<string, Record<string, number>> = {};
      let totalFiles = 0;
      let filesWithTags = 0;
      
      results.forEach(r => {
        totalFiles++;
        if (r.tags && Object.keys(r.tags).length > 0) {
          filesWithTags++;
          
          Object.entries(r.tags).forEach(([key, value]) => {
            if (!tagStats[key]) tagStats[key] = {};
            
            if (Array.isArray(value)) {
              value.forEach(v => {
                const vStr = String(v);
                tagStats[key][vStr] = (tagStats[key][vStr] || 0) + 1;
              });
            } else {
              const valueStr = String(value);
              tagStats[key][valueStr] = (tagStats[key][valueStr] || 0) + 1;
            }
          });
        }
      });
      
      const tagCoverage = filesWithTags > 0 ? ((filesWithTags / totalFiles) * 100).toFixed(1) : '0';
      
      // Build table data (for future table rendering)
      const _tableRows = Object.entries(tagStats).flatMap(([category, values]) => {
        const sortedValues = Object.entries(values)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3);
        return sortedValues.map(([v, c]) => [category, v, `${c}`]);
      });
      void _tableRows; // Reserved for table component

      return {
        content: [
          {
            type: 'text',
            text: renderOutput({
              type: 'status-card',
              data: {
                title: 'Tag Statistics',
                status: 'info',
                message: `${filesWithTags} of ${totalFiles} files have tags (${tagCoverage}%)`,
                details: Object.fromEntries(
                  Object.entries(tagStats).map(([cat, vals]) => [
                    cat,
                    Object.entries(vals).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([v, c]) => `${v}(${c})`).join(', ')
                  ])
                ),
              },
            }),
          },
        ],
      };
    }
  },
  
  {
    name: 'devlog_list_tag_values',
    title: 'List Tag Values',
    description: 'List all unique values for a specific tag',
    inputSchema: {
      tagName: z.string().describe('The tag name to list values for'),
    },
    handler: async ({ tagName }): Promise<CallToolResult> => {
      const results = await searchDevlogs('');
      
      const values = new Set<string>();
      let count = 0;
      
      results.forEach(r => {
        if (r.tags && r.tags[tagName]) {
          count++;
          const tagValue = r.tags[tagName];
          if (Array.isArray(tagValue)) {
            tagValue.forEach(v => values.add(String(v)));
          } else {
            values.add(String(tagValue));
          }
        }
      });
      
      if (values.size === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No values found for tag: "${tagName}"`,
            },
          ],
        };
      }
      
      const sortedValues = Array.from(values).sort();
      
      return {
        content: [
          {
            type: 'text',
            text: `Tag "${tagName}" values (found in ${count} files):\n\n` +
              sortedValues.map(v => `- ${v}`).join('\n'),
          },
        ],
      };
    }
  }
];