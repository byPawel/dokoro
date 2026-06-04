/**
 * Session metadata management for time tracking
 * Stores JSON metadata in .mcp/session.json (NOT in markdown files)
 */

import { promises as fs } from 'fs';
import { dirname, join } from 'path';

export interface SessionMetadata {
  session: {
    id: string;
    start: string;
    end: string | null;
    agent_id: string;
    lock_acquired?: string;
    lock_expires?: string;
    last_heartbeat: string;
  };
  timing: {
    total_minutes: number;
    active_minutes: number;
    pause_minutes: number;
    pauses: Array<{
      start: string;
      end: string;
      reason: string;
    }>;
  };
  tasks: Array<{
    id: string;
    title: string;
    start: string;
    end?: string;
    duration_minutes?: number;
    iterations: number;
    status: 'active' | 'paused' | 'completed' | 'abandoned';
    tool_usage: Record<string, number>;
  }>;
  active_task?: string;
  tool_usage: Record<string, number>;
  activity_breakdown: {
    coding: number;
    testing: number;
    research: number;
    planning: number;
    other: number;
  };
}

// Legacy markers for migration
const LEGACY_METADATA_START = '<!-- DOKORO_METADATA (do not edit manually)';
const LEGACY_METADATA_END = '-->';

/**
 * Get the path to session.json from a devlog file path
 */
function getSessionJsonPath(devlogFilePath: string): string {
  const devlogDir = dirname(devlogFilePath);
  return join(devlogDir, '.mcp', 'session.json');
}

/**
 * Migrate legacy metadata from markdown to session.json
 */
async function migrateLegacyMetadata(devlogFilePath: string): Promise<SessionMetadata | null> {
  try {
    const content = await fs.readFile(devlogFilePath, 'utf-8');

    // Check for legacy embedded metadata
    const startIdx = content.indexOf(LEGACY_METADATA_START);
    if (startIdx === -1) return null;

    const jsonStart = startIdx + LEGACY_METADATA_START.length;
    const endIdx = content.indexOf(LEGACY_METADATA_END, jsonStart);
    if (endIdx === -1) return null;

    const jsonStr = content.substring(jsonStart, endIdx).trim();
    const metadata = JSON.parse(jsonStr) as SessionMetadata;

    // Remove legacy metadata from markdown
    const cleanContent = content.substring(0, startIdx).trimEnd() +
                        content.substring(endIdx + LEGACY_METADATA_END.length);

    // Write cleaned markdown
    await fs.writeFile(devlogFilePath, cleanContent);

    // Save to session.json
    const sessionPath = getSessionJsonPath(devlogFilePath);
    await fs.mkdir(dirname(sessionPath), { recursive: true });
    await fs.writeFile(sessionPath, JSON.stringify(metadata, null, 2));

    return metadata;
  } catch {
    return null;
  }
}

export async function extractMetadata(filePath: string): Promise<SessionMetadata | null> {
  try {
    const sessionPath = getSessionJsonPath(filePath);

    try {
      // Try to read from session.json
      const content = await fs.readFile(sessionPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      // If session.json doesn't exist, try to migrate legacy metadata
      return await migrateLegacyMetadata(filePath);
    }
  } catch {
    return null;
  }
}

export async function updateMetadata(filePath: string, metadata: SessionMetadata): Promise<void> {
  try {
    const sessionPath = getSessionJsonPath(filePath);

    // Ensure .mcp directory exists
    await fs.mkdir(dirname(sessionPath), { recursive: true });

    // Write atomically to session.json
    const tempFile = `${sessionPath}.tmp`;
    await fs.writeFile(tempFile, JSON.stringify(metadata, null, 2));
    await fs.rename(tempFile, sessionPath);
  } catch (error) {
    throw new Error(`Failed to update metadata: ${error}`);
  }
}

export function createInitialMetadata(agentId: string, sessionId: string): SessionMetadata {
  const now = new Date().toISOString();
  
  return {
    session: {
      id: sessionId,
      start: now,
      end: null,
      agent_id: agentId,
      last_heartbeat: now
    },
    timing: {
      total_minutes: 0,
      active_minutes: 0,
      pause_minutes: 0,
      pauses: []
    },
    tasks: [],
    tool_usage: {},
    activity_breakdown: {
      coding: 0,
      testing: 0,
      research: 0,
      planning: 0,
      other: 0
    }
  };
}

export function classifyToolActivity(toolName: string): keyof SessionMetadata['activity_breakdown'] {
  const patterns: Record<string, string[]> = {
    coding: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
    testing: ['Bash', 'eslint', 'TodoWrite'],
    research: ['Read', 'Grep', 'Search', 'WebFetch', 'WebSearch', 'perplexity'],
    planning: ['think', 'exit_plan_mode', 'dokoro_plan', 'dokoro_whats_next']
  };
  
  for (const [activity, tools] of Object.entries(patterns)) {
    if (tools.some(t => toolName.includes(t))) {
      return activity as keyof SessionMetadata['activity_breakdown'];
    }
  }
  
  return 'other';
}

export function calculateDuration(start: string, end: string): number {
  const startTime = new Date(start).getTime();
  const endTime = new Date(end).getTime();
  return Math.round((endTime - startTime) / 60000); // minutes
}

export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  
  if (hours === 0) {
    return `${mins}m`;
  } else if (mins === 0) {
    return `${hours}h`;
  } else {
    return `${hours}h ${mins}m`;
  }
}

export function generateSessionSummary(metadata: SessionMetadata): string {
  const completedTasks = metadata.tasks.filter(t => t.status === 'completed');
  const topTools = Object.entries(metadata.tool_usage)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([tool, count]) => `${tool} (${count})`);
  
  return `## Session Analytics

**Duration**: ${formatDuration(metadata.timing.total_minutes)} (Active: ${formatDuration(metadata.timing.active_minutes)})
**Tasks**: ${completedTasks.length} completed, ${metadata.tasks.length} total
**Iterations**: ${metadata.tasks.reduce((sum, t) => sum + t.iterations, 0)} total
**Pauses**: ${metadata.timing.pauses.length} (${formatDuration(metadata.timing.pause_minutes)})

**Top Tools**: ${topTools.join(', ')}

**Activity Breakdown**:
- Coding: ${formatDuration(metadata.activity_breakdown.coding * 5)} 
- Testing: ${formatDuration(metadata.activity_breakdown.testing * 5)}
- Research: ${formatDuration(metadata.activity_breakdown.research * 5)}
- Planning: ${formatDuration(metadata.activity_breakdown.planning * 5)}`;
}