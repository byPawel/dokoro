/**
 * Tools for managing current.md workspace file
 * Auto-generate and update current workspace status
 */

import { ToolDefinition } from './registry.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import matter from 'gray-matter';
import { glob } from 'glob';
import { z } from 'zod';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { renderOutput } from '../utils/render-output.js';
import { icon } from '../utils/icons.js';

import { DOKORO_PATH } from '../shared/dokoro-utils.js';

interface CurrentWorkspaceParams {
  includeDays?: number;
  preserveSections?: string[];
}

interface UpdateSectionParams {
  section: string;
  content: string;
  append?: boolean;
}

export const currentWorkspaceTools: ToolDefinition[] = [
  {
    name: 'dokoro_regenerate_current',
    title: 'Regenerate Current Workspace',
    description: 'Auto-generate or update current.md based on recent activity',
    inputSchema: {
      includeDays: z.number().optional().default(7).describe('Days of history to analyze'),
      preserveSections: z.array(z.string()).optional().describe('Sections to preserve from existing current.md')
    },
    handler: async ({ includeDays = 7, preserveSections = [] }: CurrentWorkspaceParams): Promise<CallToolResult> => {
      try {
        const currentPath = path.join(DOKORO_PATH, 'current.md');
        
        // Read existing current.md if it exists
        let existingContent = '';
        let existingData: Record<string, unknown> = {};
        try {
          existingContent = await fs.readFile(currentPath, 'utf-8');
          const parsed = matter(existingContent);
          existingData = parsed.data;
        } catch {
          // File doesn't exist, will create new
        }

        // Analyze recent activity
        const analysis = await analyzeRecentActivity(includeDays);
        
        // Generate new content
        const newContent = await generateCurrentContent(analysis, existingData, preserveSections, existingContent);
        
        // Write updated file
        await fs.writeFile(currentPath, newContent, 'utf-8');
        
        return {
          content: [{
            type: 'text',
            text: renderOutput({
              type: 'status-card',
              data: {
                title: 'Regenerated current.md',
                status: 'success',
                message: 'Workspace updated based on recent activity.',
                details: {
                  'In Progress': `${analysis.inProgress.length}`,
                  'Completed': `${analysis.recentlyCompleted.length}`,
                  'Upcoming': `${analysis.upcomingTasks.length}`,
                  'Active Tags': `${analysis.activeTags.size}`,
                  'Path': currentPath,
                },
              },
            }),
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: renderOutput({
              type: 'status-card',
              data: {
                title: 'Regeneration Failed',
                status: 'error',
                message: error instanceof Error ? error.message : String(error),
              },
            }),
          }]
        };
      }
    }
  },
  
  {
    name: 'dokoro_update_current_section',
    title: 'Update Current Section',
    description: 'Update a specific section in current.md',
    inputSchema: {
      section: z.string().describe('Section name (e.g., "Current Focus", "Next Steps")'),
      content: z.string().describe('New content for the section'),
      append: z.boolean().optional().default(false).describe('Append to existing section instead of replacing')
    },
    handler: async ({ section, content, append = false }: UpdateSectionParams): Promise<CallToolResult> => {
      try {
        const currentPath = path.join(DOKORO_PATH, 'current.md');
        
        // Read existing file
        const existingContent = await fs.readFile(currentPath, 'utf-8');
        
        // Update the section
        const updatedContent = updateSection(existingContent, section, content, append);
        
        // Write back
        await fs.writeFile(currentPath, updatedContent, 'utf-8');
        
        return {
          content: [{
            type: 'text',
            text: renderOutput({
              type: 'status-card',
              data: {
                title: `Updated "${section}"`,
                status: 'success',
                message: append ? 'Appended to section' : 'Replaced section',
              },
            }),
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: renderOutput({
              type: 'status-card',
              data: {
                title: 'Update Failed',
                status: 'error',
                message: error instanceof Error ? error.message : String(error),
              },
            }),
          }]
        };
      }
    }
  },

  {
    name: 'dokoro_get_current_focus',
    title: 'Get Current Focus',
    description: 'Get the current focus and active tasks from current.md',
    inputSchema: {},
    handler: async (): Promise<CallToolResult> => {
      try {
        const currentPath = path.join(DOKORO_PATH, 'current.md');
        const content = await fs.readFile(currentPath, 'utf-8');
        const parsed = matter(content);
        
        // Extract key sections (support both old emoji and new icon formats)
        const focusMatch = content.match(/## .* Current Focus\s*\n([\s\S]*?)(?=\n##|$)/);
        const inProgressMatch = content.match(/## .* In Progress\s*\n([\s\S]*?)(?=\n##|$)/);
        const nextStepsMatch = content.match(/## .* Next Steps\s*\n([\s\S]*?)(?=\n##|$)/);
        
        let summary = '# Current Workspace Status\n\n';
        
        if (parsed.data.lastUpdated) {
          summary += `*Last Updated: ${parsed.data.lastUpdated}*\n\n`;
        }
        
        if (focusMatch) {
          summary += `## ${icon('task')} Current Focus\n${focusMatch[1].trim()}\n\n`;
        }

        if (inProgressMatch) {
          summary += `## ${icon('active')} In Progress\n${inProgressMatch[1].trim()}\n\n`;
        }

        if (nextStepsMatch) {
          summary += `## ${icon('time')} Next Steps\n${nextStepsMatch[1].trim()}\n\n`;
        }
        
        return {
          content: [{
            type: 'text',
            text: summary
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: renderOutput({
              type: 'status-card',
              data: {
                title: 'Read Failed',
                status: 'error',
                message: error instanceof Error ? error.message : String(error),
              },
            }),
          }]
        };
      }
    }
  }
];

interface ActivityAnalysis {
  inProgress: Array<{task: string, file: string}>;
  recentlyCompleted: Array<{task: string, date: Date}>;
  upcomingTasks: Array<{task: string, priority?: string}>;
  activeTags: Set<string>;
  recentDecisions: Array<{decision: string, date: Date}>;
  insights: string[];
}

// Helper functions
async function analyzeRecentActivity(days: number): Promise<ActivityAnalysis> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  
  const analysis: ActivityAnalysis = {
    inProgress: [],
    recentlyCompleted: [],
    upcomingTasks: [],
    activeTags: new Set(),
    recentDecisions: [],
    insights: []
  };
  
  // Analyze daily files
  const dailyPattern = path.join(DOKORO_PATH, 'daily', '**/*.md');
  const dailyFiles = await glob(dailyPattern);
  
  for (const file of dailyFiles) {
    const content = await fs.readFile(file, 'utf-8');
    const parsed = matter(content);
    
    // Extract date from filename or frontmatter
    const fileDate = parsed.data.date ? new Date(parsed.data.date) : 
                     new Date(path.basename(file).substring(0, 10));
    
    if (fileDate >= cutoffDate) {
      // Extract in-progress tasks
      const inProgressMatches = content.matchAll(/- \[ \] (.+)/g);
      for (const match of inProgressMatches) {
        analysis.inProgress.push({ task: match[1], file });
      }
      
      // Extract completed tasks
      const completedMatches = content.matchAll(/- \[x\] (.+)/g);
      for (const match of completedMatches) {
        analysis.recentlyCompleted.push({ task: match[1], date: fileDate });
      }
      
      // Collect tags
      if (parsed.data.tags) {
        const tags = Array.isArray(parsed.data.tags) ? parsed.data.tags : [parsed.data.tags];
        tags.forEach(tag => analysis.activeTags.add(tag));
      }
    }
  }
  
  // Sort by recency
  analysis.recentlyCompleted.sort((a, b) => b.date.getTime() - a.date.getTime());
  
  return analysis;
}

async function generateCurrentContent(
  analysis: ActivityAnalysis,
  existingData: Record<string, unknown>,
  preserveSections: string[],
  existingContent: string
): Promise<string> {
  const now = new Date();
  
  // Generate frontmatter
  let content = `---
title: Current Workspace
lastUpdated: ${now.toISOString()}
autoGenerated: true
activeTags: [${Array.from(analysis.activeTags).join(', ')}]
`;
  
  // Preserve custom frontmatter fields
  for (const [key, value] of Object.entries(existingData)) {
    if (!['title', 'lastUpdated', 'autoGenerated', 'activeTags'].includes(key)) {
      content += `${key}: ${JSON.stringify(value)}\n`;
    }
  }
  
  content += `---

# Current Workspace Status

*Auto-generated on ${now.toLocaleString()}*

## 🎯 Current Focus

`;
  
  // Add current focus based on most recent in-progress tasks
  if (analysis.inProgress.length > 0) {
    const topTasks = analysis.inProgress.slice(0, 3);
    topTasks.forEach(({ task }) => {
      content += `- [ ] ${task}\n`;
    });
  } else {
    content += `*No active tasks found in recent logs*\n`;
  }
  
  content += `
## 🚧 In Progress

`;
  
  // List all in-progress tasks
  if (analysis.inProgress.length > 0) {
    analysis.inProgress.forEach(({ task, file }) => {
      const relPath = path.relative(DOKORO_PATH, file);
      content += `- [ ] ${task} *(${relPath})*\n`;
    });
  } else {
    content += `*No tasks currently in progress*\n`;
  }
  
  content += `
## ✅ Recently Completed

`;
  
  // Show recently completed tasks
  if (analysis.recentlyCompleted.length > 0) {
    const recent = analysis.recentlyCompleted.slice(0, 10);
    recent.forEach(({ task, date }) => {
      const daysAgo = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
      const timeStr = daysAgo === 0 ? 'today' : 
                      daysAgo === 1 ? 'yesterday' : 
                      `${daysAgo} days ago`;
      content += `- [x] ${task} *(${timeStr})*\n`;
    });
  } else {
    content += `*No recently completed tasks*\n`;
  }
  
  content += `
## 📅 Next Steps

`;
  
  // Preserve Next Steps section if requested
  if (preserveSections.includes('Next Steps') && existingContent) {
    const nextStepsMatch = existingContent.match(/## 📅 Next Steps\s*\n([\s\S]*?)(?=\n##|$)/);
    if (nextStepsMatch) {
      content += nextStepsMatch[1].trim() + '\n';
    } else {
      content += `*Add your planned next steps here*\n`;
    }
  } else {
    content += `*Add your planned next steps here*\n`;
  }
  
  // Add custom preserved sections
  for (const section of preserveSections) {
    if (section !== 'Next Steps' && existingContent) {
      const sectionRegex = new RegExp(`## [^\\n]*${section}[^\\n]*\\n([\\s\\S]*?)(?=\\n##|$)`, 'i');
      const sectionMatch = existingContent.match(sectionRegex);
      if (sectionMatch) {
        content += `\n## ${section}\n\n${sectionMatch[1].trim()}\n`;
      }
    }
  }
  
  content += `
## 📊 Activity Summary

- **Active Tags**: ${Array.from(analysis.activeTags).join(', ') || 'None'}
- **In Progress**: ${analysis.inProgress.length} tasks
- **Recently Completed**: ${analysis.recentlyCompleted.length} tasks (last ${analysis.recentlyCompleted.length > 0 ? Math.floor((now.getTime() - analysis.recentlyCompleted[analysis.recentlyCompleted.length - 1].date.getTime()) / (1000 * 60 * 60 * 24)) : 0} days)

---
*This file is auto-generated. To preserve custom sections, use the \`preserveSections\` parameter when regenerating.*
`;
  
  return content;
}

function updateSection(content: string, sectionName: string, newContent: string, append: boolean): string {
  // Normalize section name
  const normalizedSection = sectionName.replace(/^#+\s*/, '').trim();
  
  // Try to find the section with various heading levels
  let sectionRegex = new RegExp(`(## [^\\n]*${normalizedSection}[^\\n]*\\n)([\\s\\S]*?)(?=\\n##|$)`, 'i');
  let match = content.match(sectionRegex);
  
  if (!match) {
    // Try with single #
    sectionRegex = new RegExp(`(# [^\\n]*${normalizedSection}[^\\n]*\\n)([\\s\\S]*?)(?=\\n#|$)`, 'i');
    match = content.match(sectionRegex);
  }
  
  if (match) {
    const [fullMatch, heading, existingContent] = match;
    const updatedSectionContent = append ? 
      existingContent.trim() + '\n' + newContent : 
      newContent;
    
    return content.replace(fullMatch, `${heading}${updatedSectionContent}\n`);
  } else {
    // Section doesn't exist, append it
    return content.trim() + `\n\n## ${normalizedSection}\n\n${newContent}\n`;
  }
}