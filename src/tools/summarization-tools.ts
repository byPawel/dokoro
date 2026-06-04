/**
 * MCP Tool Definitions for Auto-Summarization
 * Provides tools for generating summaries of devlog content
 */

import { z } from 'zod';
import { ToolDefinition } from './registry.js';
import { summarizer } from './summarizer.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import matter from 'gray-matter';

export const summarizationTools: ToolDefinition[] = [
  {
    name: 'dokoro_summarize',
    title: 'Summarize Content',
    description: 'Generate a summary of devlog content',
    inputSchema: {
      content: z.string().describe('Content to summarize'),
      maxWords: z.number().default(100).describe('Maximum words in summary'),
      style: z.enum(['bullets', 'paragraph', 'structured']).default('paragraph').describe('Summary style'),
      focusOn: z.array(z.string()).optional().describe('Keywords to focus on')
    },
    handler: async (args: { content: string; maxWords?: number; style?: 'bullets' | 'paragraph' | 'structured'; focusOn?: string[] }): Promise<CallToolResult> => {
      const { content, maxWords = 100, style = 'paragraph', focusOn = [] } = args;
      try {
        const summary = await summarizer.summarize(content, {
          maxLength: maxWords,
          style,
          focusOn
        });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              summary: summary.text,
              style: summary.style,
              metadata: {
                originalWords: content.split(/\s+/).length,
                summaryWords: summary.metadata?.wordCount,
                compression: `${(summary.metadata?.compressionRatio ? summary.metadata.compressionRatio * 100 : 0).toFixed(1)}%`,
                keywords: summary.keywords
              },
              keyPoints: summary.keyPoints
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Failed to summarize: ${(error as Error).message}`
          }],
          isError: true
        };
      }
    }
  },

  {
    name: 'dokoro_summarize_file',
    title: 'Summarize File',
    description: 'Summarize a specific devlog file',
    inputSchema: {
      file: z.string().describe('File path to summarize'),
      maxWords: z.number().default(150).describe('Maximum words'),
      includeMetadata: z.boolean().default(true).describe('Include file metadata in summary')
    },
    handler: async (args: { file: string; maxWords?: number; includeMetadata?: boolean }): Promise<CallToolResult> => {
      const { file, maxWords = 150, includeMetadata = true } = args;
      try {
        const devlogPath = process.env.DOKORO_PATH || path.join(process.cwd(), 'devlog');
        const filePath = path.join(devlogPath, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const parsed = matter(content);

        // Generate summary
        const summary = await summarizer.summarize(parsed.content, {
          maxLength: maxWords,
          style: 'structured',
          includeMetadata
        });

        const result = {
          file,
          summary: summary.text,
          keyPoints: summary.keyPoints,
          compression: `${(summary.metadata?.compressionRatio ? summary.metadata.compressionRatio * 100 : 0).toFixed(1)}%`
        };

        // Add metadata if requested
        if (includeMetadata && parsed.data) {
          Object.assign(result, {
            metadata: {
              title: parsed.data.title,
              date: parsed.data.date,
              tags: Array.isArray(parsed.data.tags) ? parsed.data.tags : [parsed.data.tags].filter(Boolean),
              author: parsed.data.author
            }
          });
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Failed to summarize file: ${(error as Error).message}`
          }],
          isError: true
        };
      }
    }
  },

  {
    name: 'dokoro_batch_summarize',
    title: 'Batch Summarize',
    description: 'Summarize multiple devlog files',
    inputSchema: {
      pattern: z.string().default('**/*.md').describe('File pattern to match'),
      directory: z.string().default('devlog').describe('Directory to search'),
      maxFiles: z.number().default(10).describe('Maximum files to process'),
      maxWordsPerSummary: z.number().default(50).describe('Max words per summary')
    },
    handler: async (args: { pattern?: string; directory?: string; maxFiles?: number; maxWordsPerSummary?: number }): Promise<CallToolResult> => {
      const { pattern = '**/*.md', directory = 'devlog', maxFiles = 10, maxWordsPerSummary = 50 } = args;
      try {
        const glob = (await import('glob')).glob;
        const files = await glob(pattern, { cwd: directory });
        const processFiles = files.slice(0, maxFiles);
        
        const results = [];
        for (const file of processFiles) {
          const filePath = path.join(directory, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const parsed = matter(content);
          
          if (!parsed.content.trim()) continue;

          const summary = await summarizer.summarize(parsed.content, {
            maxLength: maxWordsPerSummary,
            style: 'paragraph'
          });

          results.push({
            file,
            title: parsed.data.title || file,
            summary: summary.text,
            wordCount: summary.metadata?.wordCount,
            tags: Array.isArray(parsed.data.tags) ? parsed.data.tags : []
          });
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              processed: results.length,
              summaries: results,
              recommendation: generateBatchRecommendation(results)
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Failed to batch summarize: ${(error as Error).message}`
          }],
          isError: true
        };
      }
    }
  },

  {
    name: 'dokoro_timeline_summary',
    title: 'Timeline Summary',
    description: 'Generate a timeline summary of devlog entries',
    inputSchema: {
      period: z.enum(['day', 'week', 'month']).default('week').describe('Time period to summarize'),
      directory: z.string().default('devlog').describe('Directory to analyze')
    },
    handler: async (args: { period?: 'day' | 'week' | 'month'; directory?: string }): Promise<CallToolResult> => {
      const { period = 'week', directory = 'devlog' } = args;
      try {
        const glob = (await import('glob')).glob;
        const files = await glob('**/*.md', { cwd: directory });
        
        // Calculate date range
        const now = new Date();
        const startDate = new Date();
        switch (period) {
          case 'day':
            startDate.setDate(now.getDate() - 1);
            break;
          case 'week':
            startDate.setDate(now.getDate() - 7);
            break;
          case 'month':
            startDate.setMonth(now.getMonth() - 1);
            break;
        }

        const timelineEntries = [];
        const themes = new Map<string, number>();
        const progress = {
          completed: [] as string[],
          inProgress: [] as string[],
          planned: [] as string[]
        };

        for (const file of files) {
          try {
            const filePath = path.join(directory, file);
            const stats = await fs.stat(filePath);
            
            if (stats.mtime < startDate) continue;

            const content = await fs.readFile(filePath, 'utf-8');
            const parsed = matter(content);
            
            if (!parsed.content.trim()) continue;

            // Extract status
            const tags = Array.isArray(parsed.data.tags) ? parsed.data.tags : [];
            const status = tags.find((t: string) => t.startsWith('status:'))?.split(':')[1];
            
            // Quick summary
            const summary = await summarizer.summarize(parsed.content, {
              maxLength: 30,
              style: 'paragraph'
            });

            const entry = {
              file,
              date: stats.mtime,
              title: parsed.data.title || file,
              summary: summary.text,
              status
            };

            timelineEntries.push(entry);

            // Track progress
            if (status === 'completed') progress.completed.push(entry.title);
            else if (status === 'in-progress') progress.inProgress.push(entry.title);
            else if (status === 'planned') progress.planned.push(entry.title);

            // Extract themes
            summary.keywords?.forEach(keyword => {
              themes.set(keyword, (themes.get(keyword) || 0) + 1);
            });
          } catch {
            // Skip files with errors
          }
        }

        // Sort by date
        timelineEntries.sort((a, b) => b.date.getTime() - a.date.getTime());

        // Get top themes
        const topThemes = Array.from(themes.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([theme]) => theme);

        // Generate highlights
        const highlights = timelineEntries
          .slice(0, 5)
          .map(e => `${e.date.toISOString().split('T')[0]}: ${e.summary}`);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              period,
              dateRange: {
                from: startDate.toISOString().split('T')[0],
                to: now.toISOString().split('T')[0]
              },
              entries: timelineEntries.length,
              highlights,
              themes: topThemes,
              progress: {
                completed: `${progress.completed.length} items`,
                inProgress: `${progress.inProgress.length} items`,
                planned: `${progress.planned.length} items`,
                details: progress
              },
              summary: generateTimelineSummary(timelineEntries, period)
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Failed to generate timeline: ${(error as Error).message}`
          }],
          isError: true
        };
      }
    }
  },

  {
    name: 'dokoro_smart_digest',
    title: 'Smart Digest',
    description: 'Generate an intelligent digest of recent activity',
    inputSchema: {
      focusAreas: z.array(z.string()).optional().describe('Areas to focus on (e.g., features, bugs, research)'),
      days: z.number().default(7).describe('Number of days to include')
    },
    handler: async (args: { focusAreas?: string[]; days?: number }): Promise<CallToolResult> => {
      const { focusAreas = [], days = 7 } = args;
      try {
        const glob = (await import('glob')).glob;
        const files = await glob('**/*.md', { cwd: 'devlog' });
        
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);

        const relevantEntries = [];
        const insights = {
          productivity: { high: 0, normal: 0 },
          categories: new Map<string, number>(),
          momentum: [] as string[]
        };

        for (const file of files) {
          try {
            const filePath = path.join('devlog', file);
            const stats = await fs.stat(filePath);
            
            if (stats.mtime < cutoffDate) continue;

            const content = await fs.readFile(filePath, 'utf-8');
            const parsed = matter(content);
            
            // Check if matches focus areas
            const matchesFocus = focusAreas.length === 0 || 
              focusAreas.some((area: string) => 
                content.toLowerCase().includes(area.toLowerCase()) ||
                file.toLowerCase().includes(area.toLowerCase())
              );
            
            if (!matchesFocus) continue;

            // Analyze content
            const summary = await summarizer.summarize(parsed.content, {
              maxLength: 75,
              style: 'structured',
              focusOn: focusAreas
            });

            relevantEntries.push({
              file,
              date: stats.mtime,
              summary: summary.text,
              keyPoints: summary.keyPoints,
              category: extractCategory(file, parsed.data.tags)
            });

            // Track insights
            const category = extractCategory(file, parsed.data.tags);
            insights.categories.set(category, (insights.categories.get(category) || 0) + 1);
          } catch {
            // Skip errors
          }
        }

        // Sort by date
        relevantEntries.sort((a, b) => b.date.getTime() - a.date.getTime());

        // Generate digest sections
        const digest = {
          period: `Last ${days} days`,
          focusAreas: focusAreas.length > 0 ? focusAreas : ['all areas'],
          totalEntries: relevantEntries.length,
          
          highlights: generateHighlights(relevantEntries),
          
          byCategory: Array.from(insights.categories.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([cat, count]) => ({ category: cat, count })),
          
          keyAchievements: relevantEntries
            .filter(e => e.summary.toLowerCase().includes('complet') || 
                        e.summary.toLowerCase().includes('finish'))
            .slice(0, 5)
            .map(e => e.summary),
          
          recommendations: generateDigestRecommendations(relevantEntries, insights)
        };

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(digest, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Failed to generate digest: ${(error as Error).message}`
          }],
          isError: true
        };
      }
    }
  }
];

// Helper functions
function generateBatchRecommendation(results: Array<{ wordCount?: number }>): string {
  const avgWords = results.reduce((sum, r) => sum + (r.wordCount || 0), 0) / results.length;
  
  if (avgWords > 100) {
    return 'Consider creating more concise entries for better readability';
  } else if (results.length > 20) {
    return 'You have many entries - consider consolidating related topics';
  }
  
  return 'Good balance of content across entries';
}

function generateTimelineSummary(entries: Array<{ status?: string }>, period: string): string {
  if (entries.length === 0) return `No activity in the last ${period}`;
  
  const completed = entries.filter(e => e.status === 'completed').length;
  const active = entries.filter(e => e.status === 'in-progress').length;
  
  return `${entries.length} entries in the last ${period}: ${completed} completed, ${active} in progress`;
}

function extractCategory(file: string, tags: unknown): string {
  // Extract from tags
  if (Array.isArray(tags)) {
    const typeTag = tags.find((t: string) => t.startsWith('type:'));
    if (typeTag) return typeTag.split(':')[1];
  }
  
  // Extract from file path
  const parts = file.split('/');
  if (parts.includes('features')) return 'feature';
  if (parts.includes('bugs')) return 'bugfix';
  if (parts.includes('research')) return 'research';
  
  return 'general';
}

function generateHighlights(entries: Array<{ summary: string }>): string[] {
  const highlights = [];
  
  // Most recent important entry
  const recent = entries[0];
  if (recent) {
    highlights.push(`Latest: ${recent.summary.substring(0, 100)}...`);
  }
  
  // Completed items
  const completed = entries.filter(e => 
    e.summary.toLowerCase().includes('complet') || 
    e.summary.toLowerCase().includes('finish')
  );
  
  if (completed.length > 0) {
    highlights.push(`Completed ${completed.length} items this period`);
  }
  
  return highlights;
}

function generateDigestRecommendations(entries: Array<{ date: Date }>, insights: { categories: Map<string, number> }): string[] {
  const recommendations = [];
  
  // Check productivity
  if (entries.length < 3) {
    recommendations.push('Activity is low - consider setting daily goals');
  }
  
  // Check category balance
  const categories = Array.from(insights.categories.values()) as number[];
  const maxCategory = categories.length > 0 ? Math.max(...categories) : 0;
  const totalCategory = categories.reduce((a: number, b: number) => a + b, 0);
  
  if (maxCategory > totalCategory * 0.7) {
    recommendations.push('Consider diversifying work across different areas');
  }
  
  // Check for stale work
  const oldEntries = entries.filter(e => {
    const daysSince = (Date.now() - e.date.getTime()) / (1000 * 60 * 60 * 24);
    return daysSince > 5;
  });
  
  if (oldEntries.length > entries.length * 0.5) {
    recommendations.push('Several entries are getting stale - review and update');
  }
  
  return recommendations;
}