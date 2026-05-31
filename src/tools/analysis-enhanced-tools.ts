import { z } from 'zod';
import { ToolDefinition } from './registry.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { readFile, readdir } from 'fs/promises';
import { join, basename } from 'path';
import { DEVLOG_PATH } from '../types/devlog.js';
import matter from 'gray-matter';

interface Pattern {
  pattern: string;
  count: number;
  files: string[];
  impact: 'high' | 'medium' | 'low';
  category: string;
}

interface Dependency {
  from: string;
  to: string;
  type: 'blocks' | 'requires' | 'relates';
}

interface BurndownData {
  date: string;
  completed: number;
  remaining: number;
  added: number;
}

interface AgentMetrics {
  agentId: string;
  sessions: number;
  productivity: { hour: number; tasks: number }[];
  handoffs: { to: string; efficiency: number }[];
}

interface DevLogFile {
  path: string;
  name: string;
  content: string;
}

interface ParsedContent {
  content: string;
  metadata: {
    date?: string;
    title?: string;
    tags?: { status?: string };
    agent_id?: string;
    [key: string]: unknown;
  };
}

// Helper function to read devlog files
async function readDevLogFiles(): Promise<DevLogFile[]> {
  const files: DevLogFile[] = [];
  
  async function scanDirectory(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        await scanDirectory(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const content = await readFile(fullPath, 'utf-8');
        files.push({
          path: fullPath,
          name: entry.name,
          content
        });
      }
    }
  }
  
  await scanDirectory(DEVLOG_PATH);
  return files;
}

// Helper function to parse content with gray-matter
async function parseContent(file: DevLogFile): Promise<ParsedContent> {
  const parsed = matter(file.content);
  return {
    content: parsed.content,
    metadata: {
      ...parsed.data,
      tags: parsed.data.tags || {}
    }
  };
}

export const enhancedAnalysisTools: ToolDefinition[] = [
  {
    name: 'devlog_analyze_patterns',
    title: 'Analyze Patterns',
    description: 'Find recurring issues, patterns, and technical debt across devlogs',
    inputSchema: {
      timeRange: z.string().optional().default('30d').describe('Time range to analyze (e.g., "7d", "30d", "all")'),
      minOccurrences: z.number().optional().default(3).describe('Minimum occurrences to be considered a pattern')
    },
    handler: async (args: { timeRange?: string; minOccurrences?: number }): Promise<CallToolResult> => {
      const { timeRange = '30d', minOccurrences = 3 } = args;
      const files = await readDevLogFiles();
      const patterns: Map<string, Pattern> = new Map();
      
      // Common issue patterns to look for
      const issuePatterns = [
        { regex: /401|unauthorized/i, category: 'auth', impact: 'high' as const },
        { regex: /rate limit|429/i, category: 'performance', impact: 'high' as const },
        { regex: /timeout|timed out/i, category: 'performance', impact: 'medium' as const },
        { regex: /duplicate|duplication/i, category: 'quality', impact: 'medium' as const },
        { regex: /TODO|FIXME|HACK/g, category: 'tech-debt', impact: 'low' as const },
        { regex: /workaround|temporary fix/i, category: 'tech-debt', impact: 'medium' as const },
        { regex: /failed|failure|error/i, category: 'reliability', impact: 'high' as const },
        { regex: /circular reference|dependency cycle/i, category: 'architecture', impact: 'high' as const },
        { regex: /performance issue|slow|bottleneck/i, category: 'performance', impact: 'medium' as const },
        { regex: /breaking change|regression/i, category: 'quality', impact: 'high' as const }
      ];
      
      // Filter files by time range
      const cutoffDate = timeRange === 'all' ? new Date(0) : 
        new Date(Date.now() - parseInt(timeRange) * 24 * 60 * 60 * 1000);
      
      for (const file of files) {
        const parsed = await parseContent(file);
        const fileDate = new Date(parsed.metadata.date || file.name.slice(0, 10));
        
        if (fileDate < cutoffDate) continue;
        
        const content = parsed.content.toLowerCase();
        
        for (const { regex, category, impact } of issuePatterns) {
          const matches = content.match(regex);
          if (matches) {
            const key = `${category}:${regex.source}`;
            const existing = patterns.get(key) || {
              pattern: regex.source,
              count: 0,
              files: [],
              impact,
              category
            };
            
            existing.count += matches.length;
            if (!existing.files.includes(file.path)) {
              existing.files.push(file.path);
            }
            
            patterns.set(key, existing);
          }
        }
      }
      
      // Filter by minimum occurrences and sort
      const significantPatterns = Array.from(patterns.values())
        .filter(p => p.count >= minOccurrences)
        .sort((a, b) => {
          // Sort by impact first, then count
          const impactOrder = { high: 3, medium: 2, low: 1 };
          const impactDiff = impactOrder[b.impact] - impactOrder[a.impact];
          return impactDiff !== 0 ? impactDiff : b.count - a.count;
        });
      
      // Generate recommendations
      const recommendations = generatePatternRecommendations(significantPatterns);
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            summary: {
              patternsFound: significantPatterns.length,
              highImpact: significantPatterns.filter(p => p.impact === 'high').length,
              categories: [...new Set(significantPatterns.map(p => p.category))],
              timeRange,
              filesAnalyzed: files.length
            },
            patterns: significantPatterns,
            recommendations
          }, null, 2)
        }]
      };
    }
  },
  
  {
    name: 'devlog_dependency_graph',
    title: 'Dependency Graph',
    description: 'Visualize feature dependencies and blocking relationships',
    inputSchema: {
      format: z.enum(['mermaid', 'json', 'dot']).optional().default('mermaid').describe('Output format for the dependency graph'),
      scope: z.string().optional().default('features').describe('Filter to specific scope (e.g., "features", "all")')
    },
    handler: async (args: { format?: 'mermaid' | 'json' | 'dot'; scope?: string }): Promise<CallToolResult> => {
      const { format = 'mermaid', scope = 'features' } = args;
      const files = await readDevLogFiles();
      const dependencies: Dependency[] = [];
      const nodes: Map<string, { title: string; status: string }> = new Map();
      
      // Extract dependencies from content
      for (const file of files) {
        const parsed = await parseContent(file);
        
        if (scope !== 'all' && !file.path.includes(scope)) continue;
        
        const nodeId = basename(file.path, '.md');
        nodes.set(nodeId, {
          title: parsed.metadata.title || nodeId,
          status: parsed.metadata.tags?.status || 'unknown'
        });
        
        // Look for dependency indicators
        const content = parsed.content;
        
        // Blocks/blocked by
        const blocksMatches = content.match(/blocks?:?\s*\[(.*?)\]|blocked by:?\s*\[(.*?)\]/gi);
        if (blocksMatches) {
          for (const match of blocksMatches) {
            const refs = match.match(/\[(.*?)\]/)?.[1];
            if (refs) {
              const targets = refs.split(',').map((t: string) => t.trim());
              for (const target of targets) {
                dependencies.push({
                  from: nodeId,
                  to: target,
                  type: 'blocks'
                });
              }
            }
          }
        }
        
        // Requires/depends on
        const requiresMatches = content.match(/requires?:?\s*\[(.*?)\]|depends on:?\s*\[(.*?)\]/gi);
        if (requiresMatches) {
          for (const match of requiresMatches) {
            const refs = match.match(/\[(.*?)\]/)?.[1];
            if (refs) {
              const targets = refs.split(',').map((t: string) => t.trim());
              for (const target of targets) {
                dependencies.push({
                  from: nodeId,
                  to: target,
                  type: 'requires'
                });
              }
            }
          }
        }
      }
      
      // Generate output based on format
      let output = '';
      
      if (format === 'mermaid') {
        output = generateMermaidGraph(nodes, dependencies);
      } else if (format === 'json') {
        output = JSON.stringify({
          nodes: Array.from(nodes.entries()).map(([id, data]) => ({ id, ...data })),
          edges: dependencies
        }, null, 2);
      } else if (format === 'dot') {
        output = generateDotGraph(nodes, dependencies);
      }
      
      return {
        content: [{
          type: 'text',
          text: output
        }]
      };
    }
  },
  
  {
    name: 'devlog_burndown_chart',
    title: 'Burndown Chart',
    description: 'Track progress on epics/features with burndown visualization',
    inputSchema: {
      epic: z.string().optional().describe('Epic or feature name to track'),
      days: z.number().optional().default(30).describe('Number of days to include in chart')
    },
    handler: async (args: { epic?: string; days?: number }): Promise<CallToolResult> => {
      const { epic, days = 30 } = args;
      const files = await readDevLogFiles();
      const burndownData: BurndownData[] = [];
      const dailyProgress: Map<string, { completed: Set<string>; added: Set<string> }> = new Map();
      
      // Filter files related to the epic
      const epicFiles = epic 
        ? files.filter((f: DevLogFile) => f.path.toLowerCase().includes(epic.toLowerCase()) || 
                           f.name.toLowerCase().includes(epic.toLowerCase()))
        : files;
      
      // Analyze progress over time
      for (const file of epicFiles) {
        const parsed = await parseContent(file);
        const date = parsed.metadata.date?.slice(0, 10) || file.name.slice(0, 10);
        const status = parsed.metadata.tags?.status;
        
        if (!dailyProgress.has(date)) {
          dailyProgress.set(date, { completed: new Set(), added: new Set() });
        }
        
        const dayData = dailyProgress.get(date)!;
        
        if (status === 'completed') {
          dayData.completed.add(file.path);
        } else {
          dayData.added.add(file.path);
        }
      }
      
      // Generate burndown data
      const sortedDates = Array.from(dailyProgress.keys()).sort();
      let totalWork = 0;
      let completedWork = 0;
      
      for (const date of sortedDates) {
        const dayData = dailyProgress.get(date)!;
        totalWork += dayData.added.size;
        completedWork += dayData.completed.size;
        
        burndownData.push({
          date,
          completed: completedWork,
          remaining: totalWork - completedWork,
          added: dayData.added.size
        });
      }
      
      // Calculate velocity and projection
      const recentData = burndownData.slice(-7);
      const avgVelocity = recentData.length > 1 
        ? (recentData[recentData.length - 1].completed - recentData[0].completed) / recentData.length
        : 0;
      
      const remaining = totalWork - completedWork;
      const projectedDays = avgVelocity > 0 ? Math.ceil(remaining / avgVelocity) : -1;
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            epic: epic || 'All Features',
            summary: {
              totalItems: totalWork,
              completed: completedWork,
              remaining,
              percentComplete: totalWork > 0 ? Math.round((completedWork / totalWork) * 100) : 0,
              avgVelocity: avgVelocity.toFixed(2),
              projectedCompletionDays: projectedDays
            },
            chartData: burndownData.slice(-days),
            recommendation: generateBurndownRecommendation(avgVelocity, remaining, projectedDays)
          }, null, 2)
        }]
      };
    }
  },
  
  {
    name: 'devlog_team_metrics',
    title: 'Team Metrics',
    description: 'Analyze multi-agent collaboration and productivity metrics',
    inputSchema: {
      days: z.number().optional().default(7).describe('Number of days to analyze')
    },
    handler: async (args: { days?: number }): Promise<CallToolResult> => {
      const { days = 7 } = args;
      const files = await readDevLogFiles();
      const agentMetrics: Map<string, AgentMetrics> = new Map();
      const handoffs: Map<string, Map<string, number>> = new Map();
      
      // Analyze agent activity
      const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      
      for (const file of files) {
        const parsed = await parseContent(file);
        const fileDate = new Date(parsed.metadata.date || file.name.slice(0, 10));
        
        if (fileDate < cutoffDate) continue;
        
        const agentId = parsed.metadata.agent_id || 'unknown';
        const hour = parseInt(parsed.metadata.date?.slice(11, 13) || '0');
        
        if (!agentMetrics.has(agentId)) {
          agentMetrics.set(agentId, {
            agentId,
            sessions: 0,
            productivity: Array.from({ length: 24 }, (_, i) => ({ hour: i, tasks: 0 })),
            handoffs: []
          });
        }
        
        const metrics = agentMetrics.get(agentId)!;
        metrics.sessions++;
        metrics.productivity[hour].tasks++;
      }
      
      // Analyze handoffs from current.md history
      const currentFile = files.find((f: DevLogFile) => f.name === 'current.md');
      if (currentFile) {
        const parsed = await parseContent(currentFile);
        const content = parsed.content;
        
        // Extract agent handoff patterns
        const handoffMatches = content.match(/Previous Agent: (agent-\w+).*?Current Agent: (agent-\w+)/gs);
        if (handoffMatches) {
          for (const match of handoffMatches) {
            const [, from, to] = match.match(/Previous Agent: (agent-\w+).*?Current Agent: (agent-\w+)/s) || [];
            if (from && to) {
              if (!handoffs.has(from)) handoffs.set(from, new Map());
              const fromHandoffs = handoffs.get(from)!;
              fromHandoffs.set(to, (fromHandoffs.get(to) || 0) + 1);
            }
          }
        }
      }
      
      // Calculate handoff efficiency
      for (const [agentId, metrics] of agentMetrics.entries()) {
        const agentHandoffs = handoffs.get(agentId);
        if (agentHandoffs) {
          metrics.handoffs = Array.from(agentHandoffs.entries())
            .map(([to, _count]) => ({
              to,
              efficiency: calculateHandoffEfficiency(agentId, to, files)
            }));
        }
      }
      
      // Generate insights
      const insights = generateTeamInsights(agentMetrics, handoffs);
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            period: `Last ${days} days`,
            agents: Array.from(agentMetrics.values()),
            insights,
            recommendations: generateTeamRecommendations(agentMetrics)
          }, null, 2)
        }]
      };
    }
  }
];

// Helper functions
function generatePatternRecommendations(patterns: Pattern[]): string[] {
  const recommendations: string[] = [];
  
  const authIssues = patterns.filter(p => p.category === 'auth');
  if (authIssues.length > 0) {
    recommendations.push('🔐 Multiple authentication issues detected. Review API permissions and token management.');
  }
  
  const perfIssues = patterns.filter(p => p.category === 'performance');
  if (perfIssues.length > 0) {
    recommendations.push('⚡ Performance patterns indicate potential bottlenecks. Consider implementing caching or rate limiting.');
  }
  
  const techDebt = patterns.filter(p => p.category === 'tech-debt');
  if (techDebt.length > 0) {
    recommendations.push('🛠️ High technical debt accumulation. Schedule refactoring sessions to address TODOs and workarounds.');
  }
  
  return recommendations;
}

function generateMermaidGraph(nodes: Map<string, { title: string; status: string }>, dependencies: Dependency[]): string {
  let mermaid = 'graph TD\n';
  
  // Add nodes
  for (const [id, data] of nodes.entries()) {
    const status = data.status;
    const style = status === 'completed' ? 'fill:#90EE90' : 
                 status === 'in_progress' ? 'fill:#FFD700' : 
                 'fill:#FFB6C1';
    mermaid += `    ${id}["${data.title}"]\n`;
    mermaid += `    style ${id} ${style}\n`;
  }
  
  // Add edges
  for (const dep of dependencies) {
    const arrow = dep.type === 'blocks' ? '-->|blocks|' : '-.->|requires|';
    mermaid += `    ${dep.from} ${arrow} ${dep.to}\n`;
  }
  
  return mermaid;
}

function generateDotGraph(nodes: Map<string, { title: string; status: string }>, dependencies: Dependency[]): string {
  let dot = 'digraph Dependencies {\n';
  dot += '    rankdir=LR;\n';
  
  // Add nodes
  for (const [id, data] of nodes.entries()) {
    const color = data.status === 'completed' ? 'lightgreen' : 
                  data.status === 'in_progress' ? 'gold' : 
                  'lightpink';
    dot += `    "${id}" [label="${data.title}", style=filled, fillcolor=${color}];\n`;
  }
  
  // Add edges
  for (const dep of dependencies) {
    const style = dep.type === 'blocks' ? 'solid' : 'dashed';
    dot += `    "${dep.from}" -> "${dep.to}" [style=${style}, label="${dep.type}"];\n`;
  }
  
  dot += '}\n';
  return dot;
}

function generateBurndownRecommendation(velocity: number, remaining: number, projectedDays: number): string {
  if (velocity <= 0) {
    return '⚠️ No progress detected recently. Review blockers and resource allocation.';
  } else if (projectedDays > 30) {
    return '📅 Current velocity suggests completion in over a month. Consider parallelizing work or adjusting scope.';
  } else if (projectedDays < 7) {
    return '🚀 Excellent velocity! On track for completion within a week.';
  } else {
    return `📊 Steady progress. Projected completion in ${projectedDays} days at current velocity.`;
  }
}

function calculateHandoffEfficiency(_from: string, _to: string, _files: DevLogFile[]): number {
  // Simple efficiency calculation based on overlap and completion
  // In a real implementation, this would analyze actual handoff quality
  return 0.85; // Placeholder
}

function generateTeamInsights(metrics: Map<string, AgentMetrics>, handoffs: Map<string, Map<string, number>>): string[] {
  const insights: string[] = [];
  
  // Find most productive hours
  const hourlyProductivity: number[] = Array(24).fill(0);
  for (const agent of metrics.values()) {
    agent.productivity.forEach((p, i) => {
      hourlyProductivity[i] += p.tasks;
    });
  }
  
  const peakHour = hourlyProductivity.indexOf(Math.max(...hourlyProductivity));
  insights.push(`🕐 Peak productivity hour: ${peakHour}:00 - ${peakHour + 1}:00`);
  
  // Analyze collaboration patterns
  const totalHandoffs = Array.from(handoffs.values())
    .reduce((sum, h) => sum + Array.from(h.values()).reduce((s, c) => s + c, 0), 0);
  
  if (totalHandoffs > 10) {
    insights.push(`🤝 High collaboration: ${totalHandoffs} agent handoffs detected`);
  }
  
  return insights;
}

function generateTeamRecommendations(metrics: Map<string, AgentMetrics>): string[] {
  const recommendations: string[] = [];
  
  // Check for agent workload balance
  const sessionCounts = Array.from(metrics.values()).map(m => m.sessions);
  const avgSessions = sessionCounts.reduce((a, b) => a + b, 0) / sessionCounts.length;
  const maxSessions = Math.max(...sessionCounts);
  
  if (maxSessions > avgSessions * 2) {
    recommendations.push('⚖️ Workload imbalance detected. Consider distributing tasks more evenly.');
  }
  
  recommendations.push('📈 Consider scheduling collaborative sessions during peak productivity hours.');
  
  return recommendations;
}