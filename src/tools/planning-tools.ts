import { z } from 'zod';
import { promises as fs } from 'fs';
import path from 'path';
import { ToolDefinition } from './registry.js';
import { searchDevlogs } from '../utils/search.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DEVLOG_PATH } from '../types/devlog.js';
// renderOutput available for future migration
// import { renderOutput } from '../utils/render-output.js';
import { icon } from '../utils/icons.js';

// Helper function for analyzing codebase (duplicate for now, will be refactored)
// async function analyzeCodebaseForFeature(feature: string) {
//   const results = await searchDevlogs(feature);
//   
//   return {
//     checklist: [
//       'Research existing patterns and conventions',
//       'Create feature branch from main',
//       'Implement core functionality',
//       'Add comprehensive tests',
//       'Update documentation'
//     ],
//     conflicts: [],
//     components: results.slice(0, 3).map(r => r.file),
//     testScenarios: [
//       'Unit tests for core logic',
//       'Integration tests',
//       'Edge case handling',
//       'Error scenarios'
//     ]
//   };
// }

export const planningTools: ToolDefinition[] = [
  {
    name: 'devlog_plan_feature',
    title: 'Plan Feature',
    description: 'Create implementation plan based on research and existing patterns',
    inputSchema: {
      feature: z.string().describe('Feature name to plan'),
      approach: z.enum(['do_new_research', 'use_existing_research', 'plan_only', 'use_docs']).default('use_existing_research'),
      context: z.string().optional().describe('Additional context or requirements'),
    },
    handler: async ({ feature, approach, context }): Promise<CallToolResult> => {
      let plan = `# ${icon('task')} Implementation Plan: ${feature}\n\n`;

      // Add context if provided
      if (context) {
        plan += `## ${icon('info')} Context\n${context}\n\n`;
      }

      // Based on approach, gather information
      switch (approach) {
        case 'use_existing_research': {
          // Search for existing research
          const research = await searchDevlogs(feature, 'insights');
          if (research.length > 0) {
            plan += `## ${icon('search')} Existing Research Found\n`;
            research.slice(0, 3).forEach(r => {
              plan += `${icon('file')} ${r.file}: ${r.excerpt}\n`;
            });
            plan += '\n';
          } else {
            plan += `## ${icon('note')} Note\nNo existing research found for "${feature}". Consider using 'do_new_research' approach.\n\n`;
          }
          break;
        }

        case 'do_new_research': {
          plan += `## ${icon('search')} Research Needed\n`;
          plan += `1. Search for "${feature}" implementation patterns\n`;
          plan += `2. Review documentation and best practices\n`;
          plan += `3. Check for similar implementations in codebase\n`;
          plan += `4. Identify potential conflicts or dependencies\n\n`;
          plan += `${icon('sparkle')} Use Perplexity or Claude.ai to research this feature, then save findings with devlog_capture_research.\n\n`;
          break;
        }

        case 'use_docs': {
          plan += `## ${icon('file')} Documentation Review\n`;
          plan += `Search project documentation for:\n`;
          plan += `${icon('arrow')} API references related to ${feature}\n`;
          plan += `${icon('arrow')} Architecture decisions that might impact this feature\n`;
          plan += `${icon('arrow')} Existing patterns or conventions to follow\n\n`;
          break;
        }
      }

      // Search for similar features to learn from
      const similarFeatures = await searchDevlogs(feature.split(' ')[0], 'features');
      if (similarFeatures.length > 0) {
        plan += `## ${icon('folder')} Similar Features (for reference)\n`;
        similarFeatures.slice(0, 3).forEach(f => {
          plan += `${icon('file')} ${f.file}\n`;
        });
        plan += '\n';
      }

      // Check for conflicts
      const conflicts = await searchDevlogs(feature);
      const potentialConflicts = conflicts.filter(c =>
        c.fullContent?.includes('conflict') ||
        c.fullContent?.includes('broke') ||
        c.fullContent?.includes('regression')
      );

      if (potentialConflicts.length > 0) {
        plan += `## ${icon('warning')} Potential Conflicts\n`;
        potentialConflicts.slice(0, 3).forEach(c => {
          plan += `${icon('error')} ${c.file}: Check for conflicts\n`;
        });
        plan += '\n';
      }
      
      // Generate implementation steps
      plan += `## ${icon('chart')} Implementation Steps\n`;
      plan += `1. **Research & Planning** ${approach === 'do_new_research' ? '(REQUIRED)' : '(if needed)'}\n`;
      plan += `   ${icon('arrow')} Gather requirements and constraints\n`;
      plan += `   ${icon('arrow')} Review existing patterns\n`;
      plan += `   ${icon('arrow')} Document approach in insights/\n\n`;

      plan += `2. **Core Implementation**\n`;
      plan += `   ${icon('arrow')} Create feature branch\n`;
      plan += `   ${icon('arrow')} Implement core functionality\n`;
      plan += `   ${icon('arrow')} Add necessary types/interfaces\n\n`;

      plan += `3. **Integration**\n`;
      plan += `   ${icon('arrow')} Update dependent components\n`;
      plan += `   ${icon('arrow')} Ensure backward compatibility\n`;
      plan += `   ${icon('arrow')} Handle edge cases\n\n`;

      plan += `4. **Testing & Validation**\n`;
      plan += `   ${icon('arrow')} Write unit tests\n`;
      plan += `   ${icon('arrow')} Manual testing\n`;
      plan += `   ${icon('arrow')} Performance validation\n\n`;

      plan += `5. **Documentation**\n`;
      plan += `   ${icon('arrow')} Update feature status in features/\n`;
      plan += `   ${icon('arrow')} Document in devlog\n`;
      plan += `   ${icon('arrow')} Update any relevant configs\n\n`;
      
      // Save plan to file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const planFile = path.join(DEVLOG_PATH, 'planning', `${timestamp}-${feature.replace(/\s+/g, '-').toLowerCase()}-plan.md`);
      
      try {
        await fs.mkdir(path.dirname(planFile), { recursive: true });
        await fs.writeFile(planFile, plan);

        return {
          content: [
            {
              type: 'text',
              text: `${icon('success')} **Feature plan created:** ${planFile}\n\n${plan}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `${icon('task')} Plan for "${feature}":\n\n${plan}\n\n${icon('warning')} Could not save to file: ${error}`,
            },
          ],
        };
      }
    }
  },
  
  {
    name: 'devlog_capture_research',
    title: 'Capture Research',
    description: 'Save research findings from Perplexity/Claude',
    inputSchema: {
      topic: z.string().describe('Research topic'),
      findings: z.string().describe('Key findings and insights'),
      sources: z.array(z.string()).optional().describe('Source URLs or references'),
      tags: z.record(z.any()).optional().describe('Tags for categorization'),
    },
    handler: async ({ topic, findings, sources, tags }): Promise<CallToolResult> => {
      const timestamp = new Date().toISOString().split('T')[0];
      const fileName = `${timestamp}-${topic.replace(/\s+/g, '-').toLowerCase()}-research.md`;
      const filePath = path.join(DEVLOG_PATH, 'insights', fileName);
      
      // Build content
      let content = '---\n';
      content += `title: "${topic} Research"\n`;
      content += `date: ${timestamp}\n`;
      content += 'tags:\n';
      
      // Add default tags
      const defaultTags = {
        type: 'research',
        category: 'insights',
        status: 'captured',
        ...tags
      };
      
      Object.entries(defaultTags).forEach(([key, value]) => {
        if (Array.isArray(value)) {
          content += `  ${key}:\n`;
          value.forEach(v => content += `    - ${v}\n`);
        } else {
          content += `  ${key}: ${value}\n`;
        }
      });
      
      content += '---\n\n';
      content += `# ${topic} Research\n\n`;
      content += `## Key Findings\n\n${findings}\n\n`;
      
      if (sources && sources.length > 0) {
        content += `## Sources\n\n`;
        sources.forEach((source: string, i: number) => {
          content += `${i + 1}. ${source}\n`;
        });
        content += '\n';
      }
      
      content += `## Next Steps\n\n`;
      content += `- [ ] Review and validate findings\n`;
      content += `- [ ] Create implementation plan\n`;
      content += `- [ ] Identify potential challenges\n`;
      
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content);

        return {
          content: [
            {
              type: 'text',
              text: `${icon('success')} **Research captured:** ${filePath}\n\n${icon('tag')} Topic: ${topic}\n\n${icon('sparkle')} Use 'devlog_plan_feature' with approach='use_existing_research' to create an implementation plan based on this research.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `${icon('error')} **Failed to save research:** ${error}`,
            },
          ],
        };
      }
    }
  },
  
  {
    name: 'devlog_whats_next',
    title: 'What\'s Next',
    description: 'Get prioritized suggestions for next tasks',
    inputSchema: {
      context: z.string().optional().describe('Current context or focus area'),
    },
    handler: async ({ context }): Promise<CallToolResult> => {
      // Get pending items
      const allResults = await searchDevlogs('');
      
      // Find incomplete items
      const pending = allResults.filter(r => {
        const content = r.fullContent?.toLowerCase() || '';
        return content.includes('todo') || 
               content.includes('in progress') ||
               content.includes('pending') ||
               content.includes('🚧');
      });
      
      // Find recent research without implementation
      const recentResearch = allResults
        .filter(r => r.file.includes('insights/') && !r.file.includes('implementation'))
        .slice(0, 5);
      
      // Build suggestions
      const suggestions: string[] = [];
      
      // Priority 1: In-progress items
      const inProgress = pending.filter(p =>
        p.fullContent?.includes('in progress') ||
        p.fullContent?.includes('🚧')
      );

      if (inProgress.length > 0) {
        suggestions.push(`## ${icon('active')} Continue In-Progress Work`);
        inProgress.slice(0, 3).forEach(item => {
          suggestions.push(`${icon('arrow')} Complete: ${item.file}`);
        });
        suggestions.push('');
      }

      // Priority 2: Context-specific tasks
      if (context) {
        const contextTasks = pending.filter(p =>
          p.fullContent?.toLowerCase().includes(context.toLowerCase())
        );

        if (contextTasks.length > 0) {
          suggestions.push(`## ${icon('target')} ${context} Tasks`);
          contextTasks.slice(0, 3).forEach(task => {
            suggestions.push(`${icon('arrow')} ${task.file}`);
          });
          suggestions.push('');
        }
      }

      // Priority 3: Research to implement
      if (recentResearch.length > 0) {
        suggestions.push(`## ${icon('sparkle')} Implement Recent Research`);
        recentResearch.slice(0, 3).forEach(research => {
          const topic = research.title || research.file.split('/').pop()?.replace('.md', '');
          suggestions.push(`${icon('arrow')} Plan and implement: ${topic}`);
        });
        suggestions.push('');
      }

      // Priority 4: Stale items
      const now = new Date();
      const staleItems = pending.filter(p => {
        const daysSince = (now.getTime() - p.lastModified.getTime()) / (1000 * 60 * 60 * 24);
        return daysSince > 7;
      });

      if (staleItems.length > 0) {
        suggestions.push(`## ${icon('time')} Address Stale Items`);
        staleItems.slice(0, 3).forEach(item => {
          const daysSince = Math.round((now.getTime() - item.lastModified.getTime()) / (1000 * 60 * 60 * 24));
          suggestions.push(`${icon('warning')} ${item.file} (${daysSince} days old)`);
        });
        suggestions.push('');
      }

      // Add general suggestions
      suggestions.push(`## ${icon('task')} General Suggestions`);
      suggestions.push(`${icon('chart')} Run \`devlog_velocity_insights\` to check your productivity patterns`);
      suggestions.push(`${icon('tag')} Use \`devlog_tag_stats\` to ensure good documentation coverage`);
      suggestions.push(`${icon('search')} Review \`devlog_pending staleness=stale\` for forgotten tasks`);
      
      return {
        content: [
          {
            type: 'text',
            text: suggestions.join('\n'),
          },
        ],
      };
    }
  }
];