/**
 * Issue tracking tools for bug/enhancement/research tracking
 * Integrates with existing time tracking and session management
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import path from 'path';
import { ToolDefinition } from './registry.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getCurrentWorkspace } from '../utils/workspace.js';
import { DEVLOG_PATH } from '../types/devlog.js';
import { renderOutput } from '../utils/render-output.js';
import { icon } from '../utils/icons.js';

// Issue status enum
// const _IssueStatus = z.enum(['pending', 'active', 'resolved', 'archived']);
const IssueCategory = z.enum(['bug', 'enhancement', 'research', 'question']);
const IssuePriority = z.enum(['low', 'medium', 'high', 'critical']);

// Issue data structure
interface Issue {
  id: string;
  title: string;
  category: string;
  priority: string;
  status: string;
  estimate: string;
  description?: string;
  solution?: string;
  created_date: string;
  updated_date: string;
  session_id?: string;
  time_spent?: string;
  file_path: string;
}

// Generate unique issue ID
function generateIssueId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const time = now.toISOString().slice(11, 16).replace(':', 'h'); // HHhMM
  const dayOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][now.getDay()];
  // Note: Filename will be further customized with issue summary when creating the file
  return `${date}-${time}-${dayOfWeek}`;
}

// Get issue file path
function getIssueFilePath(status: string, id: string, title?: string): string {
  // If title is provided, create a summary suffix
  let filename = id;
  if (title) {
    const summary = title.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '') // Remove special chars
      .trim()
      .split(/\s+/) // Split by whitespace
      .slice(0, 5) // Take first 5 words max
      .join('-');
    if (summary) {
      filename = `${id}-${summary}`;
    }
  }
  return path.join(DEVLOG_PATH, 'tracking', 'issues', status, `${filename}.md`);
}

// Create issue file content
function createIssueContent(issue: Issue): string {
  return `---
title: "${issue.title}"
date: "${issue.created_date}"
tags:
  type: issue
  category: ${issue.category}
  priority: ${issue.priority}
  status: ${issue.status}
  effort: ${issue.estimate}
  scope: [tracking]
issue_id: "${issue.id}"
created_date: "${issue.created_date}"
updated_date: "${issue.updated_date}"
${issue.session_id ? `session_id: "${issue.session_id}"` : ''}
${issue.time_spent ? `time_spent: "${issue.time_spent}"` : ''}
---

# Issue: ${issue.title}

## Details
- **Category**: ${issue.category}
- **Priority**: ${issue.priority}
- **Status**: ${issue.status}
- **Estimate**: ${issue.estimate}
- **Created**: ${issue.created_date}

${issue.description ? `## Description\n${issue.description}\n` : ''}

## Solution
${issue.solution || '_To be determined_'}

## Time Tracking
${issue.time_spent ? `- **Time Spent**: ${issue.time_spent}` : '- **Time Spent**: _Not started_'}
${issue.session_id ? `- **Session**: ${issue.session_id}` : ''}

## Progress Log
_Updates will be logged here during work sessions_
`;
}

// Parse existing issue file
async function parseIssueFile(filePath: string): Promise<Issue | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    
    // Extract YAML frontmatter
    let inFrontmatter = false;
    // let frontmatterEnd = 0;
    const yamlLines: string[] = [];
    
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === '---') {
        if (!inFrontmatter) {
          inFrontmatter = true;
          continue;
        } else {
          // frontmatterEnd = i;
          break;
        }
      }
      if (inFrontmatter) {
        yamlLines.push(lines[i]);
      }
    }
    
    // Parse YAML manually (simple key-value extraction)
    const issue: Partial<Issue> = { file_path: filePath };
    
    for (const line of yamlLines) {
      const match = line.match(/^(\w+):\s*"?([^"]+)"?$/);
      if (match) {
        const [, key, value] = match;
        if (key === 'title') issue.title = value.replace(/"/g, '');
        if (key === 'issue_id') issue.id = value.replace(/"/g, '');
        if (key === 'date') issue.created_date = value.replace(/"/g, ''); // Handle 'date' field
        if (key === 'created_date') issue.created_date = value.replace(/"/g, '');
        if (key === 'updated_date') issue.updated_date = value.replace(/"/g, '');
        if (key === 'session_id') issue.session_id = value.replace(/"/g, '');
        if (key === 'time_spent') issue.time_spent = value.replace(/"/g, '');
      }
      
      // Handle tags section
      if (line.includes('category:')) {
        const match = line.match(/category:\s*(\w+)/);
        if (match) issue.category = match[1];
      }
      if (line.includes('priority:')) {
        const match = line.match(/priority:\s*(\w+)/);
        if (match) issue.priority = match[1];
      }
      if (line.includes('status:')) {
        const match = line.match(/status:\s*(\w+)/);
        if (match) issue.status = match[1];
      }
      if (line.includes('effort:')) {
        const match = line.match(/effort:\s*([^\s]+)/);
        if (match) issue.estimate = match[1];
      }
    }
    
    // Extract solution from content
    const solutionMatch = content.match(/## 🔧 Solution\n(.*?)(?=\n## |$)/s);
    if (solutionMatch) {
      issue.solution = solutionMatch[1].trim().replace('_To be determined_', '');
    }
    
    return issue as Issue;
  } catch {
    return null;
  }
}

// List issues in a directory
async function listIssuesInDirectory(dir: string): Promise<Issue[]> {
  try {
    const dirPath = path.join(DEVLOG_PATH, 'tracking', 'issues', dir);
    const files = await fs.readdir(dirPath);
    const issues: Issue[] = [];
    
    for (const file of files) {
      if (file.endsWith('.md')) {
        const filePath = path.join(dirPath, file);
        const issue = await parseIssueFile(filePath);
        if (issue) {
          issues.push(issue);
        }
      }
    }
    
    return issues.sort((a, b) => new Date(b.created_date).getTime() - new Date(a.created_date).getTime());
  } catch {
    return [];
  }
}

export const issueTrackingTools: ToolDefinition[] = [
  {
    name: 'devlog_issue_add',
    title: 'Add Issue',
    description: 'Create a new issue/bug for tracking and later resolution',
    inputSchema: {
      title: z.string().describe('Issue title'),
      category: IssueCategory.default('bug').describe('Issue category'),
      priority: IssuePriority.default('medium').describe('Issue priority'),
      estimate: z.string().default('1h').describe('Estimated effort (30m, 1h, 2h, 4h, 1d)'),
      description: z.string().optional().describe('Optional detailed description'),
    },
    handler: async ({ title, category, priority, estimate, description }): Promise<CallToolResult> => {
      try {
        // Ensure tracking directories exist
        const trackingDir = path.join(DEVLOG_PATH, 'tracking', 'issues', 'pending');
        await fs.mkdir(trackingDir, { recursive: true });
        
        // Generate issue
        const now = new Date().toISOString();
        const issueId = generateIssueId();
        
        const issue: Issue = {
          id: issueId,
          title,
          category,
          priority,
          status: 'pending',
          estimate,
          description,
          created_date: now,
          updated_date: now,
          file_path: getIssueFilePath('pending', issueId, title)
        };
        
        // Get current session if available
        const workspace = await getCurrentWorkspace();
        if (workspace.exists) {
          // Extract session ID from workspace metadata if available
          try {
            const workspaceContent = await fs.readFile(workspace.path, 'utf-8');
            const sessionMatch = workspaceContent.match(/session_id:\s*"([^"]+)"/);
            if (sessionMatch) {
              issue.session_id = sessionMatch[1];
            }
          } catch {
            // Ignore if can't extract session ID
          }
        }
        
        // Create issue file
        const content = createIssueContent(issue);
        await fs.writeFile(issue.file_path, content);
        
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'Issue Created',
                  status: 'success',
                  message: `Use \`/issue:work\` to start working on this issue.`,
                  details: {
                    'Title': title,
                    'File': issue.file_path,
                    'ID': issueId,
                    'Details': `${category} | ${priority} | ${estimate}`,
                  },
                },
              }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'Issue Creation Failed',
                  status: 'error',
                  message: `${error}`,
                },
              }),
            },
          ],
        };
      }
    },
  },

  {
    name: 'devlog_issue_list',
    title: 'List Issues',
    description: 'List issues by status and/or priority',
    inputSchema: {
      status: z.enum(['all', 'pending', 'active', 'resolved', 'archived']).default('all').describe('Filter by status'),
      priority: z.enum(['all', 'critical', 'high', 'medium', 'low']).default('all').describe('Filter by priority'),
      limit: z.number().default(20).describe('Maximum number of issues to return'),
    },
    handler: async ({ status, priority, limit }): Promise<CallToolResult> => {
      try {
        let allIssues: Issue[] = [];
        
        // Collect issues from relevant directories
        const directories = status === 'all' ? ['pending', 'active', 'resolved', 'archived'] : [status];
        
        for (const dir of directories) {
          const issues = await listIssuesInDirectory(dir);
          allIssues = allIssues.concat(issues);
        }
        
        // Filter by priority if specified
        if (priority !== 'all') {
          allIssues = allIssues.filter(issue => issue.priority === priority);
        }
        
        // Sort and limit
        allIssues.sort((a, b) => {
          // Sort by priority first (critical > high > medium > low)
          const priorityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
          const aPriority = priorityOrder[a.priority as keyof typeof priorityOrder] || 0;
          const bPriority = priorityOrder[b.priority as keyof typeof priorityOrder] || 0;
          
          if (aPriority !== bPriority) {
            return bPriority - aPriority;
          }
          
          // Then by creation date (newest first)
          return new Date(b.created_date).getTime() - new Date(a.created_date).getTime();
        });
        
        const limitedIssues = allIssues.slice(0, limit);
        
        if (limitedIssues.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `${icon('issue')} No issues found matching: status=${status}, priority=${priority}`,
              },
            ],
          };
        }

        // Format output
        let output = `${icon('issue')} **Issues** (${limitedIssues.length}/${allIssues.length})\n\n`;

        for (const issue of limitedIssues) {
          const statusIcon = {
            pending: icon('pending'),
            active: icon('sync'),
            resolved: icon('completed'),
            archived: icon('folder')
          }[issue.status] || icon('info');

          const priorityIcon = {
            critical: icon('error'),
            high: icon('warning'),
            medium: icon('info'),
            low: icon('success')
          }[issue.priority] || icon('pending');

          output += `${statusIcon} **${issue.title}**\n`;
          output += `   ${priorityIcon} ${issue.priority} | ${issue.category} | ${issue.estimate}`;
          if (issue.time_spent) {
            output += ` | ${icon('time')} ${issue.time_spent}`;
          }
          output += `\n   ${icon('tag')} \`${issue.id}\` | ${icon('time')} ${issue.created_date.slice(0, 10)}\n\n`;
        }

        output += `\n${icon('arrow')} Use \`/issue:work <issue_id>\` to start working on an issue\n`;
        output += `${icon('arrow')} Use \`/issue:done <issue_id>\` to complete an issue`;
        
        return {
          content: [
            {
              type: 'text',
              text: output,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'List Failed',
                  status: 'error',
                  message: `${error}`,
                },
              }),
            },
          ],
        };
      }
    },
  },

  {
    name: 'devlog_issue_work',
    title: 'Start Working on Issue',
    description: 'Start working on an issue (integrates with time tracking)',
    inputSchema: {
      issue_id: z.string().describe('Issue ID to work on'),
    },
    handler: async ({ issue_id }): Promise<CallToolResult> => {
      try {
        // Find the issue file
        const directories = ['pending', 'active', 'resolved', 'archived'];
        let issueFile: string | null = null;
        let currentStatus: string | null = null;
        
        for (const dir of directories) {
          const filePath = getIssueFilePath(dir, issue_id);
          try {
            await fs.access(filePath);
            issueFile = filePath;
            currentStatus = dir;
            break;
          } catch {
            // File doesn't exist in this directory, continue
          }
        }
        
        if (!issueFile || !currentStatus) {
          return {
            content: [
              {
                type: 'text',
                text: renderOutput({
                  type: 'status-card',
                  data: {
                    title: 'Issue Not Found',
                    status: 'error',
                    message: `${issue_id}\nUse \`/issue:list\` to see available issues.`,
                  },
                }),
              },
            ],
          };
        }

        // Parse existing issue
        const issue = await parseIssueFile(issueFile);
        if (!issue) {
          return {
            content: [
              {
                type: 'text',
                text: renderOutput({
                  type: 'status-card',
                  data: {
                    title: 'Parse Failed',
                    status: 'error',
                    message: `Could not parse: ${issueFile}`,
                  },
                }),
              },
            ],
          };
        }
        
        // Move to active if not already there
        if (currentStatus !== 'active') {
          const newFilePath = getIssueFilePath('active', issue_id);
          const activeDir = path.dirname(newFilePath);
          await fs.mkdir(activeDir, { recursive: true });
          
          // Update issue status and move file
          issue.status = 'active';
          issue.updated_date = new Date().toISOString();
          
          const newContent = createIssueContent(issue);
          await fs.writeFile(newFilePath, newContent);
          await fs.unlink(issueFile);
          
          issue.file_path = newFilePath;
        }
        
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: `Working on: ${issue.title}`,
                  status: 'success',
                  message: `${icon('info')} This issue is now marked as 'active'\n${icon('info')} Use \`devlog_task_track start "Issue: ${issue.title}"\` to start time tracking\n${icon('info')} Use \`/issue:done ${issue_id}\` when completed`,
                  details: {
                    'Details': `${issue.category} | ${issue.priority} | ${issue.estimate}`,
                    'File': issue.file_path,
                  },
                },
              }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'Start Failed',
                  status: 'error',
                  message: `${error}`,
                },
              }),
            },
          ],
        };
      }
    },
  },

  {
    name: 'devlog_issue_complete',
    title: 'Complete Issue',
    description: 'Mark an issue as completed with solution (integrates with time tracking)',
    inputSchema: {
      issue_id: z.string().describe('Issue ID to complete'),
      solution: z.string().describe('Description of the solution implemented'),
    },
    handler: async ({ issue_id, solution }): Promise<CallToolResult> => {
      try {
        // Find the issue file
        const directories = ['pending', 'active', 'resolved', 'archived'];
        let issueFile: string | null = null;
        let currentStatus: string | null = null;
        
        for (const dir of directories) {
          const filePath = getIssueFilePath(dir, issue_id);
          try {
            await fs.access(filePath);
            issueFile = filePath;
            currentStatus = dir;
            break;
          } catch {
            // File doesn't exist in this directory, continue
          }
        }
        
        if (!issueFile || !currentStatus) {
          return {
            content: [
              {
                type: 'text',
                text: renderOutput({
                  type: 'status-card',
                  data: {
                    title: 'Issue Not Found',
                    status: 'error',
                    message: issue_id,
                  },
                }),
              },
            ],
          };
        }

        // Parse existing issue
        const issue = await parseIssueFile(issueFile);
        if (!issue) {
          return {
            content: [
              {
                type: 'text',
                text: renderOutput({
                  type: 'status-card',
                  data: {
                    title: 'Parse Failed',
                    status: 'error',
                    message: `Could not parse: ${issueFile}`,
                  },
                }),
              },
            ],
          };
        }

        // Move to resolved
        const newFilePath = getIssueFilePath('resolved', issue_id);
        const resolvedDir = path.dirname(newFilePath);
        await fs.mkdir(resolvedDir, { recursive: true });
        
        // Update issue
        issue.status = 'resolved';
        issue.solution = solution;
        issue.updated_date = new Date().toISOString();
        
        const newContent = createIssueContent(issue);
        await fs.writeFile(newFilePath, newContent);
        
        // Remove old file if moving
        if (currentStatus !== 'resolved') {
          await fs.unlink(issueFile);
        }
        
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: `Issue Completed: ${issue.title}`,
                  status: 'success',
                  message: `${icon('info')} Issue moved to 'resolved' status\n${icon('info')} Use \`devlog_task_track complete\` to stop time tracking if active`,
                  details: {
                    'Solution': solution,
                    'File': newFilePath,
                  },
                },
              }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'Completion Failed',
                  status: 'error',
                  message: `${error}`,
                },
              }),
            },
          ],
        };
      }
    },
  },
];