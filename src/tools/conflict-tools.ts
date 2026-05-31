import { z } from 'zod';
import { ToolDefinition } from './registry.js';
import { searchDevlogs } from '../utils/search.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { renderOutput } from '../utils/render-output.js';

export const conflictTools: ToolDefinition[] = [
  {
    name: 'devlog_detect_conflicts',
    title: 'Detect Conflicts',
    description: 'Find potential conflicts with existing features',
    inputSchema: {
      feature: z.string().describe('Feature name or description to check for conflicts'),
    },
    handler: async ({ feature }): Promise<CallToolResult> => {
      // Search for similar features
      const results = await searchDevlogs(feature);
      
      const conflicts = results.filter(r => {
        const content = r.fullContent?.toLowerCase() || '';
        const featureLower = feature.toLowerCase();
        
        // Check for exact matches or similar implementations
        return content.includes(featureLower) || 
               content.includes('implement') && content.includes(featureLower.split(' ')[0]);
      });
      
      if (conflicts.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'No Conflicts',
                  status: 'success',
                  message: `Safe to implement: "${feature}"`,
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
              type: 'status-card',
              data: {
                title: `${conflicts.length} Potential Conflicts`,
                status: 'warning',
                message: `Feature: "${feature}"`,
                details: Object.fromEntries(
                  conflicts.slice(0, 5).map((c, i) => [`Conflict ${i + 1}`, c.file])
                ),
              },
            }),
          },
        ],
      };
    }
  },
  
  {
    name: 'devlog_check_duplicate',
    title: 'Check Duplicate',
    description: 'Check if feature has already been implemented',
    inputSchema: {
      description: z.string().describe('Feature description to check for duplicates'),
    },
    handler: async ({ description }): Promise<CallToolResult> => {
      // Search for similar descriptions in features
      const results = await searchDevlogs(description, 'features');
      
      const duplicates = results.filter(r => {
        const content = r.fullContent?.toLowerCase() || '';
        
        // Check for implementations with similar descriptions
        return content.includes('implemented') || content.includes('completed');
      });
      
      if (duplicates.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'No Duplicates',
                  status: 'success',
                  message: `Safe to implement: "${description}"`,
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
              type: 'status-card',
              data: {
                title: `${duplicates.length} Similar Implementations`,
                status: 'warning',
                message: 'Review existing implementations before proceeding.',
                details: Object.fromEntries(
                  duplicates.slice(0, 5).map((d, i) => [`Match ${i + 1}`, d.file])
                ),
              },
            }),
          },
        ],
      };
    }
  },
  
  {
    name: 'devlog_regression_history',
    title: 'Regression History',
    description: 'Track what broke before - prevent repeating failures',
    inputSchema: {
      component: z.string().describe('Component or feature name to check regression history'),
    },
    handler: async ({ component }): Promise<CallToolResult> => {
      // Search for regression patterns
      const results = await searchDevlogs(component);
      
      const regressions = results.filter(r => {
        const content = r.fullContent?.toLowerCase() || '';
        return content.includes('broke') || 
               content.includes('regression') || 
               content.includes('failed') ||
               content.includes('bug') ||
               content.includes('issue');
      });
      
      if (regressions.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'No Regressions',
                  status: 'success',
                  message: `Clean history for: "${component}"`,
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
              type: 'status-card',
              data: {
                title: `Regression History: ${component}`,
                status: 'warning',
                message: `Found ${regressions.length} past issues.`,
                details: Object.fromEntries(
                  regressions.slice(0, 5).map((r, i) => [
                    `Issue ${i + 1}`,
                    `${r.file} (${r.lastModified.toISOString().split('T')[0]})`
                  ])
                ),
              },
            }),
          },
        ],
      };
    }
  }
];