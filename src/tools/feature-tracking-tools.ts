/**
 * Feature tracking tools for idea/enhancement tracking
 * Integrates with existing time tracking and planning systems
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import path from 'path';
import { ToolDefinition } from './registry.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getCurrentWorkspace } from '../utils/workspace.js';
import { DOKORO_PATH } from '../types/devlog.js';

// Feature status enum
// const _FeatureStatus = z.enum(['ideas', 'planned', 'active', 'completed', 'archived']);
const FeatureComplexity = z.enum(['trivial', 'simple', 'moderate', 'complex', 'epic']);
const FeaturePriority = z.enum(['low', 'medium', 'high', 'critical']);

// Feature data structure
interface Feature {
  id: string;
  title: string;
  complexity: string;
  priority: string;
  status: string;
  estimate: string;
  description?: string;
  progress?: string;
  created_date: string;
  updated_date: string;
  session_id?: string;
  time_spent?: string;
  research_links?: string[];
  file_path: string;
}

// Generate unique feature ID
function generateFeatureId(): string {
  const now = new Date();
  const timestamp = now.toISOString().slice(0, 19).replace(/[:-]/g, '').replace('T', '-');
  return `feature-${timestamp}`;
}

// Get feature file path
function getFeatureFilePath(status: string, id: string): string {
  return path.join(DOKORO_PATH, 'tracking', 'features', status, `${id}.md`);
}

// Create feature file content
function createFeatureContent(feature: Feature): string {
  return `---
title: "${feature.title}"
date: "${feature.created_date}"
tags:
  type: feature
  complexity: ${feature.complexity}
  priority: ${feature.priority}
  status: ${feature.status}
  effort: ${feature.estimate}
  scope: [tracking]
feature_id: "${feature.id}"
created_date: "${feature.created_date}"
updated_date: "${feature.updated_date}"
${feature.session_id ? `session_id: "${feature.session_id}"` : ''}
${feature.time_spent ? `time_spent: "${feature.time_spent}"` : ''}
---

# Feature: ${feature.title}

## 📋 Details
- **Complexity**: ${feature.complexity}
- **Priority**: ${feature.priority}
- **Status**: ${feature.status}
- **Estimate**: ${feature.estimate}
- **Created**: ${feature.created_date}

${feature.description ? `## 📝 Description\n${feature.description}\n` : ''}

## 🚀 Implementation Progress
${feature.progress || '_Not started_'}

## ⏱️ Time Tracking
${feature.time_spent ? `- **Time Spent**: ${feature.time_spent}` : '- **Time Spent**: _Not started_'}
${feature.session_id ? `- **Session**: ${feature.session_id}` : ''}

${feature.research_links && feature.research_links.length > 0 ? 
  `## 🔗 Research Links\n${feature.research_links.map(link => `- ${link}`).join('\n')}\n` : 
  '## 🔗 Research Links\n_To be added_\n'}

## 📝 Development Log
_Updates will be logged here during implementation_
`;
}

// Parse existing feature file
async function parseFeatureFile(filePath: string): Promise<Feature | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    
    // Extract YAML frontmatter
    let inFrontmatter = false;
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
    const feature: Partial<Feature> = { file_path: filePath };
    
    for (const line of yamlLines) {
      const match = line.match(/^(\w+):\s*"?([^"]+)"?$/);
      if (match) {
        const [, key, value] = match;
        if (key === 'title') feature.title = value.replace(/"/g, '');
        if (key === 'feature_id') feature.id = value.replace(/"/g, '');
        if (key === 'created_date') feature.created_date = value.replace(/"/g, '');
        if (key === 'updated_date') feature.updated_date = value.replace(/"/g, '');
        if (key === 'session_id') feature.session_id = value.replace(/"/g, '');
        if (key === 'time_spent') feature.time_spent = value.replace(/"/g, '');
      }
      
      // Handle tags section
      if (line.includes('complexity:')) {
        const match = line.match(/complexity:\s*(\w+)/);
        if (match) feature.complexity = match[1];
      }
      if (line.includes('priority:')) {
        const match = line.match(/priority:\s*(\w+)/);
        if (match) feature.priority = match[1];
      }
      if (line.includes('status:')) {
        const match = line.match(/status:\s*(\w+)/);
        if (match) feature.status = match[1];
      }
      if (line.includes('effort:')) {
        const match = line.match(/effort:\s*([^\s]+)/);
        if (match) feature.estimate = match[1];
      }
    }
    
    // Extract progress from content
    const progressMatch = content.match(/## 🚀 Implementation Progress\n(.*?)(?=\n## |$)/s);
    if (progressMatch) {
      feature.progress = progressMatch[1].trim().replace('_Not started_', '');
    }
    
    // Extract research links
    const researchMatch = content.match(/## 🔗 Research Links\n(.*?)(?=\n## |$)/s);
    if (researchMatch) {
      const linkText = researchMatch[1].trim();
      if (linkText && linkText !== '_To be added_') {
        feature.research_links = linkText.split('\n')
          .filter(line => line.startsWith('- '))
          .map(line => line.substring(2));
      }
    }
    
    return feature as Feature;
  } catch {
    return null;
  }
}

// List features in a directory
async function listFeaturesInDirectory(dir: string): Promise<Feature[]> {
  try {
    const dirPath = path.join(DOKORO_PATH, 'tracking', 'features', dir);
    const files = await fs.readdir(dirPath);
    const features: Feature[] = [];
    
    for (const file of files) {
      if (file.endsWith('.md')) {
        const filePath = path.join(dirPath, file);
        const feature = await parseFeatureFile(filePath);
        if (feature) {
          features.push(feature);
        }
      }
    }
    
    return features.sort((a, b) => new Date(b.created_date).getTime() - new Date(a.created_date).getTime());
  } catch {
    return [];
  }
}

export const featureTrackingTools: ToolDefinition[] = [
  {
    name: 'dokoro_feature_add',
    title: 'Add Feature',
    description: 'Add a new feature idea for future development',
    inputSchema: {
      title: z.string().describe('Feature title'),
      complexity: FeatureComplexity.default('moderate').describe('Feature complexity'),
      priority: FeaturePriority.default('medium').describe('Feature priority'),
      estimate: z.string().default('1d').describe('Estimated effort (1h, 4h, 1d, 3d, 1w, 2w)'),
      description: z.string().optional().describe('Optional detailed description'),
    },
    handler: async ({ title, complexity, priority, estimate, description }): Promise<CallToolResult> => {
      try {
        // Ensure tracking directories exist
        const trackingDir = path.join(DOKORO_PATH, 'tracking', 'features', 'ideas');
        await fs.mkdir(trackingDir, { recursive: true });
        
        // Generate feature
        const now = new Date().toISOString();
        const featureId = generateFeatureId();
        
        const feature: Feature = {
          id: featureId,
          title,
          complexity,
          priority,
          status: 'ideas',
          estimate,
          description,
          created_date: now,
          updated_date: now,
          file_path: getFeatureFilePath('ideas', featureId)
        };
        
        // Get current session if available
        const workspace = await getCurrentWorkspace();
        if (workspace.exists) {
          try {
            const workspaceContent = await fs.readFile(workspace.path, 'utf-8');
            const sessionMatch = workspaceContent.match(/session_id:\s*"([^"]+)"/);
            if (sessionMatch) {
              feature.session_id = sessionMatch[1];
            }
          } catch {
            // Ignore if can't extract session ID
          }
        }
        
        // Create feature file
        const content = createFeatureContent(feature);
        await fs.writeFile(feature.file_path, content);
        
        return {
          content: [
            {
              type: 'text',
              text: `✅ Feature idea created: ${title}\n` +
                    `📁 File: ${feature.file_path}\n` +
                    `🆔 ID: ${featureId}\n` +
                    `📊 Complexity: ${complexity} | Priority: ${priority} | Estimate: ${estimate}\n\n` +
                    `Use \`/feature:plan ${featureId}\` to create implementation plan\n` +
                    `Use \`/weekly:add-feature\` to add to current week`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Failed to create feature: ${error}`,
            },
          ],
        };
      }
    },
  },

  {
    name: 'dokoro_feature_list',
    title: 'List Features',
    description: 'List features by status and/or priority',
    inputSchema: {
      status: z.enum(['all', 'ideas', 'planned', 'active', 'completed', 'archived']).default('all').describe('Filter by status'),
      priority: z.enum(['all', 'critical', 'high', 'medium', 'low']).default('all').describe('Filter by priority'),
      limit: z.number().default(20).describe('Maximum number of features to return'),
    },
    handler: async ({ status, priority, limit }): Promise<CallToolResult> => {
      try {
        let allFeatures: Feature[] = [];
        
        // Collect features from relevant directories
        const directories = status === 'all' ? ['ideas', 'planned', 'active', 'completed', 'archived'] : [status];
        
        for (const dir of directories) {
          const features = await listFeaturesInDirectory(dir);
          allFeatures = allFeatures.concat(features);
        }
        
        // Filter by priority if specified
        if (priority !== 'all') {
          allFeatures = allFeatures.filter(feature => feature.priority === priority);
        }
        
        // Sort and limit
        allFeatures.sort((a, b) => {
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
        
        const limitedFeatures = allFeatures.slice(0, limit);
        
        if (limitedFeatures.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `🚀 No features found matching criteria: status=${status}, priority=${priority}`,
              },
            ],
          };
        }
        
        // Format output
        let output = `🚀 Features (${limitedFeatures.length}/${allFeatures.length})\n\n`;
        
        for (const feature of limitedFeatures) {
          const statusEmoji = {
            ideas: '💡',
            planned: '📋',
            active: '🔄',
            completed: '✅',
            archived: '📦'
          }[feature.status] || '❓';
          
          const priorityEmoji = {
            critical: '🔴',
            high: '🟠',
            medium: '🟡',
            low: '🟢'
          }[feature.priority] || '⚪';
          
          const complexityEmoji = {
            trivial: '🟢',
            simple: '🟡',
            moderate: '🟠',
            complex: '🔴',
            epic: '🟣'
          }[feature.complexity] || '⚪';
          
          output += `${statusEmoji} **${feature.title}**\n`;
          output += `   ${priorityEmoji} ${feature.priority} | ${complexityEmoji} ${feature.complexity} | ${feature.estimate}`;
          if (feature.time_spent) {
            output += ` | ⏱️ ${feature.time_spent}`;
          }
          output += `\n   🆔 \`${feature.id}\` | 📅 ${feature.created_date.slice(0, 10)}\n\n`;
        }
        
        output += `\n💡 Use \`/feature:start <feature_id>\` to start working on a feature\n`;
        output += `💡 Use \`/feature:plan <feature_id>\` to create implementation plan`;
        
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
              text: `❌ Failed to list features: ${error}`,
            },
          ],
        };
      }
    },
  },

  {
    name: 'dokoro_feature_start',
    title: 'Start Working on Feature',
    description: 'Start working on a feature (integrates with time tracking)',
    inputSchema: {
      feature_id: z.string().describe('Feature ID to work on'),
    },
    handler: async ({ feature_id }): Promise<CallToolResult> => {
      try {
        // Find the feature file
        const directories = ['ideas', 'planned', 'active', 'completed', 'archived'];
        let featureFile: string | null = null;
        let currentStatus: string | null = null;
        
        for (const dir of directories) {
          const filePath = getFeatureFilePath(dir, feature_id);
          try {
            await fs.access(filePath);
            featureFile = filePath;
            currentStatus = dir;
            break;
          } catch {
            // File doesn't exist in this directory, continue
          }
        }
        
        if (!featureFile || !currentStatus) {
          return {
            content: [
              {
                type: 'text',
                text: `❌ Feature not found: ${feature_id}\nUse \`/feature:list\` to see available features.`,
              },
            ],
          };
        }
        
        // Parse existing feature
        const feature = await parseFeatureFile(featureFile);
        if (!feature) {
          return {
            content: [
              {
                type: 'text',
                text: `❌ Failed to parse feature file: ${featureFile}`,
              },
            ],
          };
        }
        
        // Move to active if not already there
        if (currentStatus !== 'active') {
          const newFilePath = getFeatureFilePath('active', feature_id);
          const activeDir = path.dirname(newFilePath);
          await fs.mkdir(activeDir, { recursive: true });
          
          // Update feature status and move file
          feature.status = 'active';
          feature.updated_date = new Date().toISOString();
          
          const newContent = createFeatureContent(feature);
          await fs.writeFile(newFilePath, newContent);
          await fs.unlink(featureFile);
          
          feature.file_path = newFilePath;
        }
        
        return {
          content: [
            {
              type: 'text',
              text: `🔄 Started working on feature: ${feature.title}\n` +
                    `📊 Complexity: ${feature.complexity} | Priority: ${feature.priority} | Estimate: ${feature.estimate}\n\n` +
                    `📁 File: ${feature.file_path}\n\n` +
                    `💡 Feature is now marked as 'active'\n` +
                    `💡 Use \`mcp: dokoro_task_track start "Feature: ${feature.title}"\` to start time tracking\n` +
                    `💡 Use \`/feature:plan ${feature_id}\` to create implementation plan`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Failed to start working on feature: ${error}`,
            },
          ],
        };
      }
    },
  },

  {
    name: 'dokoro_feature_plan',
    title: 'Create Feature Implementation Plan',
    description: 'Convert a feature idea into a detailed implementation plan',
    inputSchema: {
      feature_id: z.string().describe('Feature ID to create plan for'),
      approach: z.enum(['use_existing_research', 'do_new_research', 'plan_only']).default('plan_only').describe('Planning approach'),
    },
    handler: async ({ feature_id, approach }): Promise<CallToolResult> => {
      try {
        // Find the feature file
        const directories = ['ideas', 'planned', 'active', 'completed', 'archived'];
        let featureFile: string | null = null;
        let currentStatus: string | null = null;
        
        for (const dir of directories) {
          const filePath = getFeatureFilePath(dir, feature_id);
          try {
            await fs.access(filePath);
            featureFile = filePath;
            currentStatus = dir;
            break;
          } catch {
            // File doesn't exist in this directory, continue
          }
        }
        
        if (!featureFile || !currentStatus) {
          return {
            content: [
              {
                type: 'text',
                text: `❌ Feature not found: ${feature_id}`,
              },
            ],
          };
        }
        
        // Parse existing feature
        const feature = await parseFeatureFile(featureFile);
        if (!feature) {
          return {
            content: [
              {
                type: 'text',
                text: `❌ Failed to parse feature file: ${featureFile}`,
              },
            ],
          };
        }
        
        // Move to planned if coming from ideas
        let newFilePath = featureFile;
        if (currentStatus === 'ideas') {
          newFilePath = getFeatureFilePath('planned', feature_id);
          const plannedDir = path.dirname(newFilePath);
          await fs.mkdir(plannedDir, { recursive: true });
          
          feature.status = 'planned';
          feature.updated_date = new Date().toISOString();
        }
        
        // Create implementation plan
        const planDate = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '').replace('T', '-');
        const planFileName = `${planDate}-${feature.title.toLowerCase().replace(/\s+/g, '-')}-implementation-plan.md`;
        const planFilePath = path.join(DOKORO_PATH, 'features', planFileName);
        
        // Ensure features directory exists
        await fs.mkdir(path.dirname(planFilePath), { recursive: true });
        
        const planContent = `---
title: "${feature.title} - Implementation Plan"
date: "${planDate}"
tags:
  type: feature-plan
  complexity: ${feature.complexity}
  priority: ${feature.priority}
  status: planned
  effort: ${feature.estimate}
  scope: [implementation]
feature_id: "${feature.id}"
approach: "${approach}"
---

# ${feature.title} - Implementation Plan

*Created: ${new Date().toISOString().slice(0, 10)}*  
*Feature ID: ${feature.id}*  
*Approach: ${approach}*

## 🎯 Feature Overview
${feature.description || 'To be defined'}

## 📊 Planning Details
- **Complexity**: ${feature.complexity}
- **Priority**: ${feature.priority}
- **Estimate**: ${feature.estimate}
- **Status**: ${feature.status}

## 🔍 Research Phase
${approach === 'use_existing_research' ? 
  '- [ ] Review existing research documents\n- [ ] Identify relevant patterns and implementations\n- [ ] Extract key insights and requirements' :
  approach === 'do_new_research' ?
  '- [ ] Conduct new research on implementation approaches\n- [ ] Analyze similar features in other systems\n- [ ] Document findings and recommendations' :
  '- [ ] Define requirements based on current understanding\n- [ ] Identify key components and dependencies\n- [ ] Plan implementation approach'
}

## 🏗️ Implementation Phases

### Phase 1: Foundation
- [ ] Set up basic structure
- [ ] Create core components
- [ ] Implement basic functionality

### Phase 2: Core Features
- [ ] Implement main feature logic
- [ ] Add user interface components
- [ ] Integrate with existing systems

### Phase 3: Polish & Testing
- [ ] Add comprehensive tests
- [ ] Improve user experience
- [ ] Performance optimization
- [ ] Documentation

## 🧪 Testing Strategy
- [ ] Unit tests for core logic
- [ ] Integration tests
- [ ] End-to-end testing
- [ ] User acceptance testing

## 🚀 Deployment Plan
- [ ] Development environment testing
- [ ] Staging environment validation
- [ ] Production deployment
- [ ] Monitoring and rollback plan

## 📋 Success Criteria
- [ ] Feature works as specified
- [ ] Performance meets requirements
- [ ] User experience is intuitive
- [ ] Code quality standards met

## 🔗 Related Files
- **Feature Tracking**: [${feature.file_path}](${feature.file_path})
${feature.research_links ? feature.research_links.map(link => `- **Research**: ${link}`).join('\n') : ''}

## 📝 Implementation Notes
_Notes and decisions will be tracked here during implementation_
`;

        // Save the plan
        await fs.writeFile(planFilePath, planContent);
        
        // Update feature with plan link and move to planned if needed
        if (!feature.research_links) {
          feature.research_links = [];
        }
        feature.research_links.push(`[Implementation Plan](${planFilePath})`);
        
        const updatedContent = createFeatureContent(feature);
        await fs.writeFile(newFilePath, updatedContent);
        
        // Remove old file if moved
        if (newFilePath !== featureFile) {
          await fs.unlink(featureFile);
        }
        
        return {
          content: [
            {
              type: 'text',
              text: `📋 Implementation plan created for: ${feature.title}\n\n` +
                    `📁 Plan File: ${planFilePath}\n` +
                    `📁 Feature File: ${newFilePath}\n\n` +
                    `💡 Feature moved to 'planned' status\n` +
                    `💡 Use \`/feature:start ${feature_id}\` to begin implementation\n` +
                    `💡 Plan includes research, implementation phases, and testing strategy`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Failed to create feature plan: ${error}`,
            },
          ],
        };
      }
    },
  },
];