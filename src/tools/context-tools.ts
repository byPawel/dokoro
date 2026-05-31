import { z } from 'zod';
import { ToolDefinition } from './registry.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { renderOutput } from '../utils/render-output.js';
import { AmbientContextService } from '../services/ambient-context.js';

export const contextTools: ToolDefinition[] = [
  {
    name: 'devlog_ambient_context',
    title: 'Ambient Context',
    description: 'Auto-detect project context from git state and surface relevant devlog entries',
    inputSchema: {
      projectPath: z.string().optional().describe('Project path (defaults to cwd)'),
    },
    handler: async ({ projectPath }: { projectPath?: string }): Promise<CallToolResult> => {
      const cwd = projectPath || process.cwd();
      const ctx = AmbientContextService.getGitContext(cwd);

      if (!ctx) {
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'Git Context Unavailable',
                  status: 'warning',
                  message: 'Could not read git state. Is this a git repository?',
                  details: {
                    'Path': cwd,
                  },
                },
              }),
            },
          ],
        };
      }

      const query = AmbientContextService.buildSearchQuery(ctx);
      const branchKeywords = AmbientContextService.branchToKeywords(ctx.branch);
      const commitKeywords = AmbientContextService.commitsToKeywords(ctx.recentCommits);
      const fileKeywords = AmbientContextService.filesToKeywords(ctx.changedFiles);

      return {
        content: [
          {
            type: 'text',
            text: renderOutput({
              type: 'status-card',
              data: {
                title: 'Ambient Git Context',
                status: 'info',
                message: `Search query: ${query}`,
                details: {
                  'Branch': ctx.branch,
                  'Branch keywords': branchKeywords.join(', ') || '(none)',
                  'Commit keywords': commitKeywords.join(', ') || '(none)',
                  'File keywords': fileKeywords.join(', ') || '(none)',
                  'Recent commits': ctx.recentCommits.length.toString(),
                  'Changed files': ctx.changedFiles.length.toString(),
                },
              },
            }),
          },
        ],
      };
    },
  },
];
