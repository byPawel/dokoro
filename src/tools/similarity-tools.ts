/**
 * MCP Tool Definitions for Similarity Detection
 * Provides tools for finding similar content and preventing duplicates
 */

import { z } from 'zod';
import { ToolDefinition } from './registry.js';
import { similarityDetector } from './similarity-detector.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as path from 'path';

export const similarityTools: ToolDefinition[] = [
  {
    name: 'devlog_find_similar',
    title: 'Find Similar Content',
    description: 'Find devlog entries similar to provided content',
    inputSchema: {
      content: z.string().describe('Content to find similar entries for'),
      threshold: z.number().default(0.3).describe('Similarity threshold (0-1)'),
      maxResults: z.number().default(10).describe('Maximum results to return'),
      boostRecent: z.boolean().default(true).describe('Boost recent files in results')
    },
    handler: async (args: { content: string; threshold?: number; maxResults?: number; boostRecent?: boolean }): Promise<CallToolResult> => {
      const { content, threshold = 0.3, maxResults = 10, boostRecent = true } = args;
      try {
        const results = await similarityDetector.findSimilar(content, {
          threshold,
          maxResults,
          boostRecent
        });

        if (results.length === 0) {
          return {
            content: [{
              type: 'text',
              text: 'No similar content found'
            }]
          };
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              summary: `Found ${results.length} similar entries`,
              results: results.map(r => ({
                file: r.file,
                similarity: `${(r.score * 100).toFixed(1)}%`,
                title: r.metadata.title || r.file,
                tags: r.metadata.tags || [],
                wordCount: r.metadata.wordCount,
                excerpt: r.excerpt
              })),
              recommendations: generateRecommendations(results)
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Failed to find similar content: ${(error as Error).message}`
          }],
          isError: true
        };
      }
    }
  },

  {
    name: 'devlog_check_before_write',
    title: 'Check Before Writing',
    description: 'Check if similar content already exists before creating new entry',
    inputSchema: {
      title: z.string().optional().describe('Proposed title'),
      content: z.string().describe('Proposed content'),
      tags: z.array(z.string()).optional().describe('Proposed tags')
    },
    handler: async (args: { title?: string; content: string; tags?: string[] }): Promise<CallToolResult> => {
      const { title, content, tags = [] } = args;
      try {
        // Combine title and content for better matching
        const fullContent = title ? `${title}\n\n${content}` : content;
        
        const results = await similarityDetector.findSimilar(fullContent, {
          threshold: 0.4,  // Higher threshold for duplicate detection
          maxResults: 5,
          boostRecent: true
        });

        const highSimilarity = results.filter(r => r.score > 0.7);
        const mediumSimilarity = results.filter(r => r.score > 0.5 && r.score <= 0.7);

        let recommendation = '';
        let shouldProceed = true;

        if (highSimilarity.length > 0) {
          shouldProceed = false;
          recommendation = '🚨 DUPLICATE DETECTED: Very similar content already exists';
        } else if (mediumSimilarity.length > 0) {
          recommendation = '⚠️ SIMILAR CONTENT: Consider updating existing entry instead';
        } else if (results.length > 0) {
          recommendation = '✅ UNIQUE CONTENT: Some related entries exist but content is sufficiently different';
        } else {
          recommendation = '✅ NEW TOPIC: No similar content found';
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              shouldProceed,
              recommendation,
              similarEntries: results.map(r => ({
                file: r.file,
                similarity: `${(r.score * 100).toFixed(1)}%`,
                title: r.metadata.title || r.file,
                suggestion: r.score > 0.7 ? 'Consider updating this instead' : 
                           r.score > 0.5 ? 'Maybe reference or link to this' : 
                           'Related but different enough'
              })),
              proposedTags: tags,
              suggestedAction: getSuggestedAction(results)
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Failed to check content: ${(error as Error).message}`
          }],
          isError: true
        };
      }
    }
  },

  {
    name: 'devlog_find_related',
    title: 'Find Related Entries',
    description: 'Find entries related to a specific file',
    inputSchema: {
      file: z.string().describe('File path to find related entries for'),
      maxResults: z.number().default(10).describe('Maximum results')
    },
    handler: async (args: { file: string; maxResults?: number }): Promise<CallToolResult> => {
      const { file, maxResults = 10 } = args;
      try {
        const results = await similarityDetector.findSimilarToFile(file, {
          maxResults,
          boostRecent: false  // Don't boost recent for related search
        });

        if (results.length === 0) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                message: `No related entries found for ${file}`,
                results: []
              }, null, 2)
            }]
          };
        }

        // Group by similarity level
        const closelyRelated = results.filter(r => r.score > 0.6);
        const moderatelyRelated = results.filter(r => r.score > 0.4 && r.score <= 0.6);
        const looselyRelated = results.filter(r => r.score <= 0.4);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              summary: `Found ${results.length} related entries for ${file}`,
              closelyRelated: formatResults(closelyRelated, 'Closely Related'),
              moderatelyRelated: formatResults(moderatelyRelated, 'Moderately Related'),
              looselyRelated: formatResults(looselyRelated, 'Loosely Related'),
              graph: generateRelationshipGraph(file, results)
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Failed to find related entries: ${(error as Error).message}`
          }],
          isError: true
        };
      }
    }
  },

  {
    name: 'devlog_cluster_topics',
    title: 'Cluster Topics',
    description: 'Group similar devlog entries into topic clusters',
    inputSchema: {
      threshold: z.number().default(0.5).describe('Clustering threshold (0-1)'),
      directory: z.string().default('devlog').describe('Directory to analyze')
    },
    handler: async (args: { threshold?: number; directory?: string }): Promise<CallToolResult> => {
      const { threshold = 0.5, directory = 'devlog' } = args;
      try {
        // Build index first
        await similarityDetector.buildIndex([`${directory}/**/*.md`]);
        
        // Cluster documents
        const clusters = await similarityDetector.clusterDocuments(threshold);
        
        if (clusters.size === 0) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                message: 'No clusters found at this threshold',
                clusters: []
              }, null, 2)
            }]
          };
        }

        // Analyze each cluster
        const clusterAnalysis = [];
        for (const [clusterId, files] of clusters) {
          const clusterInfo = await analyzeCluster(files);
          clusterAnalysis.push({
            clusterId,
            size: files.length,
            files: files.slice(0, 5),  // Show first 5 files
            theme: clusterInfo.theme,
            commonTags: clusterInfo.commonTags,
            keywords: clusterInfo.keywords
          });
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              summary: `Found ${clusters.size} topic clusters`,
              totalFiles: Array.from(clusters.values()).reduce((sum, files) => sum + files.length, 0),
              clusters: clusterAnalysis.sort((a, b) => b.size - a.size),
              insights: generateClusteringInsights(clusterAnalysis)
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Failed to cluster topics: ${(error as Error).message}`
          }],
          isError: true
        };
      }
    }
  },

  {
    name: 'devlog_similarity_index',
    title: 'Build Similarity Index', 
    description: 'Build or rebuild the similarity index for better performance',
    inputSchema: {
      patterns: z.array(z.string()).default(['devlog/**/*.md']).describe('File patterns to index'),
      force: z.boolean().default(false).describe('Force rebuild even if index exists')
    },
    handler: async (args: { patterns?: string[]; force?: boolean }): Promise<CallToolResult> => {
      const { patterns = ['devlog/**/*.md'] } = args;
      try {
        const startTime = Date.now();
        
        await similarityDetector.buildIndex(patterns);
        
        const duration = Date.now() - startTime;
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: 'Similarity index built successfully',
              stats: {
                duration: `${duration}ms`,
                patterns: patterns,
                timestamp: new Date().toISOString()
              }
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Failed to build index: ${(error as Error).message}`
          }],
          isError: true
        };
      }
    }
  }
];

// Helper functions
function generateRecommendations(results: Array<{ score: number; file: string; metadata: { title?: string; tags?: string[]; wordCount?: number }; excerpt: string }>): string[] {
  const recommendations = [];
  
  const duplicates = results.filter(r => r.score > 0.8);
  if (duplicates.length > 0) {
    recommendations.push(`Found ${duplicates.length} potential duplicates - consider consolidating`);
  }
  
  const related = results.filter(r => r.score > 0.5 && r.score <= 0.8);
  if (related.length > 0) {
    recommendations.push(`Found ${related.length} closely related entries - consider linking them`);
  }
  
  return recommendations;
}

function getSuggestedAction(results: Array<{ score: number }>): string {
  if (results.length === 0) return 'Create new entry';
  
  const topScore = results[0].score;
  if (topScore > 0.8) return 'Update existing entry instead';
  if (topScore > 0.6) return 'Create new entry but reference existing';
  return 'Create new entry';
}

function formatResults(results: Array<{ score: number; file: string; metadata: { title?: string; tags?: string[]; wordCount?: number } }>, label: string): { label: string; count: number; entries: Array<{ file: string; similarity: string; title: string }> } | null {
  if (results.length === 0) return null;
  
  return {
    label,
    count: results.length,
    entries: results.map(r => ({
      file: r.file,
      similarity: `${(r.score * 100).toFixed(1)}%`,
      title: r.metadata.title || r.file
    }))
  };
}

function generateRelationshipGraph(centerFile: string, results: Array<{ score: number; file: string }>): string {
  // Simple ASCII representation
  let graph = `\n${centerFile}\n`;
  results.slice(0, 5).forEach(r => {
    const strength = r.score > 0.7 ? '===' : r.score > 0.5 ? '--' : '..';
    graph += `  ${strength}> ${r.file} (${(r.score * 100).toFixed(0)}%)\n`;
  });
  return graph;
}

async function analyzeCluster(files: string[]): Promise<{ theme: string; commonTags: string[]; keywords: string[] }> {
  // This is simplified - in reality would analyze content
  const commonTags = new Map<string, number>();
  
  // For now, just extract from filenames
  const keywords = files
    .map(f => path.basename(f, '.md'))
    .join(' ')
    .split(/[-_\s]+/)
    .filter(w => w.length > 3);
  
  return {
    theme: keywords.slice(0, 3).join(' '),
    commonTags: Array.from(commonTags.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tag]) => tag),
    keywords: [...new Set(keywords)].slice(0, 5)
  };
}

function generateClusteringInsights(clusters: Array<{ size: number }>): string[] {
  const insights = [];
  
  const largeClusters = clusters.filter(c => c.size > 5);
  if (largeClusters.length > 0) {
    insights.push(`Found ${largeClusters.length} major topic areas with 5+ related entries`);
  }
  
  const singletons = clusters.filter(c => c.size === 2);
  if (singletons.length > 3) {
    insights.push(`Many small clusters - consider raising threshold for broader grouping`);
  }
  
  return insights;
}