/**
 * Weekly integration tools for issue/feature tracking
 * Integrates with currentWeek.md and existing weekly planning system
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import path from 'path';
import { ToolDefinition } from './registry.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DOKORO_PATH } from '../types/devlog.js';

// Item types for weekly integration
const WeeklyItemType = z.enum(['issue', 'feature', 'task']);
const WeeklyItemPriority = z.enum(['low', 'medium', 'high', 'critical']);

interface WeeklyItem {
  type: string;
  title: string;
  priority: string;
  effort?: string;
  status: string;
  id?: string;
  created_date: string;
}

// Get current week's file path
function getCurrentWeekFilePath(): string {
  return path.join(DOKORO_PATH, 'currentWeek.md');
}

// Parse currentWeek.md to extract existing structure
async function parseCurrentWeek(): Promise<{
  content: string;
  sections: { [key: string]: { start: number; end: number; content: string } };
  yamlEndLine: number;
}> {
  try {
    const filePath = getCurrentWeekFilePath();
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    
    const sections: { [key: string]: { start: number; end: number; content: string } } = {};
    let currentSection = '';
    let sectionStart = 0;
    let yamlEndLine = -1;
    let inYaml = false;
    
    // First, find where YAML frontmatter ends
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (i === 0 && line === '---') {
        inYaml = true;
        continue;
      }
      
      if (inYaml && line === '---') {
        yamlEndLine = i;
        inYaml = false;
        break;
      }
    }
    
    // Then parse sections, starting after YAML
    const startLine = yamlEndLine >= 0 ? yamlEndLine + 1 : 0;
    
    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i];
      
      // Detect section headers
      if (line.match(/^#{1,3}\s+/)) {
        // Save previous section
        if (currentSection) {
          sections[currentSection] = {
            start: sectionStart,
            end: i - 1,
            content: lines.slice(sectionStart, i).join('\n')
          };
        }
        
        // Start new section
        currentSection = line.replace(/^#{1,3}\s+/, '').replace(/[^\w\s-]/g, '').trim();
        sectionStart = i;
      }
    }
    
    // Save last section
    if (currentSection) {
      sections[currentSection] = {
        start: sectionStart,
        end: lines.length - 1,
        content: lines.slice(sectionStart).join('\n')
      };
    }
    
    return { content, sections, yamlEndLine };
  } catch (error) {
    throw new Error(`Failed to parse currentWeek.md: ${error}`);
  }
}

// Add item to currentWeek.md without removing existing content
async function addItemToCurrentWeek(item: WeeklyItem): Promise<void> {
  const filePath = getCurrentWeekFilePath();
  const weekData = await parseCurrentWeek();
  let content = weekData.content;
  const sections = weekData.sections;
  
  // Find or create the tracking section
  const trackingSectionName = '🐛 Issues & 🚀 Features This Week';
  let trackingSection = sections[trackingSectionName];
  
  if (!trackingSection) {
    // Create new tracking section before "Related Files" section
    const relatedFilesSection = sections['Related Files'] || sections['🔗 Related Files'];
    
    let insertPoint: number;
    
    if (relatedFilesSection) {
      // Insert before Related Files section
      insertPoint = content.lastIndexOf('\n', content.indexOf('\n## ', relatedFilesSection.start * 10));
    } else {
      // Insert at end of file, but ensure we have proper spacing
      insertPoint = content.length;
      // Add newline if needed
      if (!content.endsWith('\n\n')) {
        if (!content.endsWith('\n')) {
          insertPoint = content.length;
          content += '\n';
        }
        insertPoint = content.length;
        content += '\n';
      }
    }
    
    const newSection = `## 🐛 Issues & 🚀 Features This Week\n\n### 🐛 Active Issues\n_No active issues_\n\n### 🚀 Feature Pipeline\n_No active features_\n\n`;
    
    const newContent = content.slice(0, insertPoint) + newSection + content.slice(insertPoint);
    await fs.writeFile(filePath, newContent);
    
    // Re-parse to get updated structure
    const updated = await parseCurrentWeek();
    trackingSection = updated.sections[trackingSectionName];
  }
  
  if (!trackingSection) {
    throw new Error('Failed to create or find tracking section');
  }
  
  // Determine which subsection to add to
  const subsection = item.type === 'issue' ? '### 🐛 Active Issues' : '### 🚀 Feature Pipeline';
  const lines = trackingSection.content.split('\n');
  
  let subsectionIndex = -1;
  
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(subsection)) {
      subsectionIndex = i;
      break;
    }
  }
  
  if (subsectionIndex === -1) {
    throw new Error(`Could not find subsection: ${subsection}`);
  }
  
  // Create item line
  const priorityEmoji = {
    critical: '🔴',
    high: '🟠',
    medium: '🟡',
    low: '🟢'
  }[item.priority] || '⚪';
  
  const statusEmoji = item.type === 'issue' ? '⏳' : '💡';
  const effortText = item.effort ? ` (Est: ${item.effort})` : '';
  const idText = item.id ? ` [${item.id}]` : '';
  
  const itemLine = `- [ ] ${statusEmoji} **${item.title}** ${priorityEmoji}${effortText}${idText}`;
  
  // Check if this is the first item (replacing placeholder)
  const placeholderLine = subsectionIndex + 1 < lines.length ? lines[subsectionIndex + 1] : '';
  const isPlaceholder = placeholderLine.includes('_No active') || placeholderLine.trim() === '';
  
  if (isPlaceholder) {
    // Replace placeholder with first item
    lines[subsectionIndex + 1] = itemLine;
  } else {
    // Add as new item
    lines.splice(subsectionIndex + 1, 0, itemLine);
  }
  
  // Reconstruct content
  const updatedSectionContent = lines.join('\n');
  const beforeSection = content.slice(0, trackingSection.start);
  const afterSection = content.slice(content.indexOf('\n', trackingSection.start + trackingSection.content.length));
  
  const newContent = beforeSection + updatedSectionContent + afterSection;
  await fs.writeFile(filePath, newContent);
}

// Extract items from current.md
async function extractItemsFromCurrent(): Promise<WeeklyItem[]> {
  try {
    const currentPath = path.join(DOKORO_PATH, 'current.md');
    const content = await fs.readFile(currentPath, 'utf-8');
    const lines = content.split('\n');
    
    const items: WeeklyItem[] = [];
    let inProgressSection = false;
    
    for (const line of lines) {
      // Detect progress or task sections
      if (line.includes('🚧 Progress') || line.includes('🎯 Active Task') || line.includes('📝 Progress')) {
        inProgressSection = true;
        continue;
      }
      
      // Stop at next major section
      if (line.startsWith('## ') && !line.includes('Progress') && !line.includes('Active')) {
        inProgressSection = false;
        continue;
      }
      
      // Extract checklist items
      if (inProgressSection && line.trim().startsWith('- [ ]')) {
        const itemText = line.replace(/^- \[ \]\s*/, '').trim();
        
        // Skip metadata lines
        if (itemText.startsWith('[') || itemText.includes('<!--') || !itemText) {
          continue;
        }
        
        // Determine type based on keywords
        let type = 'task';
        if (itemText.toLowerCase().includes('bug') || itemText.toLowerCase().includes('fix') || itemText.toLowerCase().includes('error')) {
          type = 'issue';
        } else if (itemText.toLowerCase().includes('feature') || itemText.toLowerCase().includes('implement') || itemText.toLowerCase().includes('add')) {
          type = 'feature';
        }
        
        // Extract priority (if mentioned)
        let priority = 'medium';
        if (itemText.toLowerCase().includes('critical') || itemText.toLowerCase().includes('urgent')) {
          priority = 'critical';
        } else if (itemText.toLowerCase().includes('high')) {
          priority = 'high';
        } else if (itemText.toLowerCase().includes('low')) {
          priority = 'low';
        }
        
        items.push({
          type,
          title: itemText,
          priority,
          status: 'pending',
          created_date: new Date().toISOString()
        });
      }
    }
    
    return items;
  } catch {
    return [];
  }
}

export const weeklyIntegrationTools: ToolDefinition[] = [
  {
    name: 'dokoro_weekly_add_item',
    title: 'Add Item to Current Week',
    description: 'Add issue/feature/task to currentWeek.md without removing existing items',
    inputSchema: {
      type: WeeklyItemType.describe('Type of item to add'),
      title: z.string().describe('Item title'),
      priority: WeeklyItemPriority.default('medium').describe('Item priority'),
      effort: z.string().optional().describe('Estimated effort (1h, 4h, 1d, etc.)'),
      id: z.string().optional().describe('Optional ID for linking to tracked item'),
    },
    handler: async (args: { type: string; title: string; priority?: string; effort?: string; id?: string }): Promise<CallToolResult> => {
      const { type, title, priority, effort, id } = args;
      try {
        const item: WeeklyItem = {
          type,
          title,
          priority: priority || 'medium',
          effort,
          id,
          status: 'pending',
          created_date: new Date().toISOString()
        };
        
        await addItemToCurrentWeek(item);
        
        return {
          content: [
            {
              type: 'text',
              text: `✅ Added ${type} to current week: ${title}\n` +
                    `📊 Priority: ${priority}${effort ? ` | Effort: ${effort}` : ''}${id ? ` | ID: ${id}` : ''}\n\n` +
                    `📁 Updated: currentWeek.md\n\n` +
                    `💡 Use \`/weekly:status\` to see current week overview`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Failed to add item to current week: ${error}`,
            },
          ],
        };
      }
    },
  },

  {
    name: 'dokoro_weekly_sync',
    title: 'Sync Current to Weekly',
    description: 'Sync pending items from current.md to currentWeek.md',
    inputSchema: {
      dry_run: z.boolean().default(false).describe('Preview changes without making them'),
    },
    handler: async (args: { dry_run?: boolean }): Promise<CallToolResult> => {
      const { dry_run } = args;
      try {
        const items = await extractItemsFromCurrent();
        
        if (items.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `📋 No pending items found in current.md to sync`,
              },
            ],
          };
        }
        
        if (dry_run) {
          let output = `🔍 Sync Preview (${items.length} items found):\n\n`;
          
          for (const item of items) {
            const typeEmoji = {
              issue: '🐛',
              feature: '🚀',
              task: '📋'
            }[item.type] || '📋';
            
            const priorityEmoji = {
              critical: '🔴',
              high: '🟠',
              medium: '🟡',
              low: '🟢'
            }[item.priority] || '⚪';
            
            output += `${typeEmoji} **${item.title}** ${priorityEmoji}\n`;
            output += `   Type: ${item.type} | Priority: ${item.priority}\n\n`;
          }
          
          output += `💡 Run \`/weekly:sync\` (without dry_run) to apply changes`;
          
          return {
            content: [
              {
                type: 'text',
                text: output,
              },
            ],
          };
        }
        
        // Actually sync the items
        let syncedCount = 0;
        const errors: string[] = [];
        
        for (const item of items) {
          try {
            await addItemToCurrentWeek(item);
            syncedCount++;
          } catch (error) {
            errors.push(`Failed to sync "${item.title}": ${error}`);
          }
        }
        
        let output = `✅ Synced ${syncedCount}/${items.length} items from current.md to currentWeek.md\n\n`;
        
        if (errors.length > 0) {
          output += `⚠️ Errors:\n${errors.map(e => `- ${e}`).join('\n')}\n\n`;
        }
        
        output += `📁 Updated: currentWeek.md\n`;
        output += `💡 Use \`/weekly:status\` to see updated weekly overview`;
        
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
              text: `❌ Failed to sync items: ${error}`,
            },
          ],
        };
      }
    },
  },

  {
    name: 'dokoro_weekly_status',
    title: 'Show Weekly Status',
    description: 'Show current week progress with time breakdown',
    inputSchema: {
      include_time: z.boolean().default(false).describe('Include time tracking analysis'),
      include_summary: z.boolean().default(true).describe('Include progress summary'),
    },
    handler: async (args: { include_time?: boolean; include_summary?: boolean }): Promise<CallToolResult> => {
      const { include_time, include_summary } = args;
      try {
        const { content } = await parseCurrentWeek();
        
        // Extract key information from currentWeek.md
        const lines = content.split('\n');
        
        let weekTitle = 'Current Week';
        let totalItems = 0;
        let completedItems = 0;
        let issues = 0;
        let features = 0;
        
        // Track numbered features
        const numberedFeatures: { title: string; status: string; completed: boolean }[] = [];
        
        // Track checkbox items in daily schedule
        let inDailySection = false;
        
        for (const line of lines) {
          // Extract week title
          if (line.startsWith('# ')) {
            weekTitle = line.replace('# ', '');
          }
          
          // Detect numbered features (e.g., "### 1. **Task Preview Generation Fixes**")
          const numberedMatch = line.match(/^###\s+\d+\.\s+\*\*(.*?)\*\*/);
          if (numberedMatch) {
            const title = numberedMatch[1];
            const isIssue = title.toLowerCase().includes('fix') || title.toLowerCase().includes('bug');
            
            totalItems++;
            if (isIssue) {
              issues++;
            } else {
              features++;
            }
            
            numberedFeatures.push({ title, status: '', completed: false });
          }
          
          // Check status for numbered features
          if (numberedFeatures.length > 0 && line.startsWith('**Status**:')) {
            const statusMatch = line.match(/\*\*Status\*\*:\s*(.+)/);
            if (statusMatch) {
              const lastFeature = numberedFeatures[numberedFeatures.length - 1];
              lastFeature.status = statusMatch[1];
              
              // Check if completed
              if (statusMatch[1].includes('✅') || statusMatch[1].toLowerCase().includes('completed')) {
                lastFeature.completed = true;
                completedItems++;
              }
            }
          }
          
          // Track daily schedule sections
          if (line.match(/^###\s+\*\*(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/)) {
            inDailySection = true;
          }
          
          // End daily section at next heading
          if (inDailySection && line.startsWith('##')) {
            inDailySection = false;
          }
          
          // Count checkbox items in daily sections
          if (inDailySection && line.trim().startsWith('- [')) {
            totalItems++;
            
            if (line.includes('- [x]')) {
              completedItems++;
            }
            
            // Categorize daily tasks
            if (line.toLowerCase().includes('fix') || line.toLowerCase().includes('bug')) {
              issues++;
            } else {
              features++;
            }
          }
          
          // Also check for the traditional tracking section format
          if (line.includes('🐛 Issues & 🚀 Features This Week') || line.includes('Issues & Features')) {
            let trackingLine = lines.indexOf(line) + 1;
            while (trackingLine < lines.length && !lines[trackingLine].startsWith('##')) {
              const trackLine = lines[trackingLine];
              if (trackLine.trim().startsWith('- [')) {
                totalItems++;
                
                if (trackLine.includes('- [x]')) {
                  completedItems++;
                }
                
                if (trackLine.includes('🐛') || trackLine.toLowerCase().includes('bug') || trackLine.toLowerCase().includes('fix')) {
                  issues++;
                } else if (trackLine.includes('🚀') || trackLine.toLowerCase().includes('feature')) {
                  features++;
                }
              }
              trackingLine++;
            }
            break;
          }
        }
        
        // Add debug information about what was found
        const debugInfo = {
          numberedFeaturesFound: numberedFeatures.length,
          dailyCheckboxesFound: totalItems - numberedFeatures.length,
          features: numberedFeatures.map(f => ({ title: f.title, status: f.status, completed: f.completed }))
        };
        
        // Calculate completion percentage
        const completionPercentage = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;
        
        let output = `📊 **${weekTitle}**\n\n`;
        
        if (include_summary) {
          output += `## 📈 Progress Summary\n`;
          output += `- **Total Items**: ${totalItems}\n`;
          output += `- **Completed**: ${completedItems} (${completionPercentage}%)\n`;
          output += `- **Remaining**: ${totalItems - completedItems}\n`;
          output += `- **Issues**: ${issues}\n`;
          output += `- **Features**: ${features}\n\n`;
          
          // Progress bar
          const progressBarLength = 20;
          const filledBars = Math.round((completionPercentage / 100) * progressBarLength);
          const emptyBars = progressBarLength - filledBars;
          const progressBar = '█'.repeat(filledBars) + '░'.repeat(emptyBars);
          
          output += `**Progress**: ${progressBar} ${completionPercentage}%\n\n`;
          
          // Add debug info temporarily
          output += `\n<!-- Debug: Found ${debugInfo.numberedFeaturesFound} numbered features, ${debugInfo.dailyCheckboxesFound} checkboxes -->\n\n`;
        }
        
        if (include_time) {
          output += `## ⏱️ Time Analysis\n`;
          
          try {
            // Try to extract time information from current.md metadata
            const currentPath = path.join(DOKORO_PATH, 'current.md');
            const currentContent = await fs.readFile(currentPath, 'utf-8');
            
            // Extract timing metadata
            const metadataMatch = currentContent.match(/<!-- DOKORO_METADATA[^>]*\n(.*?)\n-->/s);
            if (metadataMatch) {
              const metadata = JSON.parse(metadataMatch[1]);
              
              if (metadata.timing) {
                const activeMinutes = metadata.timing.active_minutes || 0;
                const hours = Math.floor(activeMinutes / 60);
                const minutes = activeMinutes % 60;
                
                output += `- **Today's Active Time**: ${hours}h ${minutes}m\n`;
                
                if (metadata.activity_breakdown) {
                  const breakdown = metadata.activity_breakdown;
                  output += `- **Coding**: ${breakdown.coding || 0} sessions\n`;
                  output += `- **Research**: ${breakdown.research || 0} sessions\n`;
                  output += `- **Planning**: ${breakdown.planning || 0} sessions\n`;
                  output += `- **Other**: ${breakdown.other || 0} sessions\n`;
                }
              }
            }
          } catch {
            output += `- Time tracking data not available\n`;
          }
          
          output += `\n💡 Use time tracking tools to get detailed time analysis\n\n`;
        }
        
        output += `## 🎯 Quick Actions\n`;
        output += `- \`/issue:add\` - Add new issue\n`;
        output += `- \`/feature:add\` - Add new feature\n`;
        output += `- \`/weekly:sync\` - Sync from current.md\n`;
        output += `- \`/weekly:add-issue\` - Add issue to week\n`;
        output += `- \`/weekly:add-feature\` - Add feature to week`;
        
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
              text: `❌ Failed to get weekly status: ${error}`,
            },
          ],
        };
      }
    },
  },
];