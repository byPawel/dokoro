/**
 * Tool usage tracking for all MCP operations
 * Automatically tracks which tools are used and how often
 */

import { getCurrentWorkspace } from './workspace.js';
import { extractMetadata, updateMetadata, classifyToolActivity } from './session-metadata.js';
import { updateLockHeartbeat } from './lock-manager.js';
import { notifyActivity } from './heartbeat-manager.js';
import { getSqliteDb } from '../db/index.js';
import { DEVLOG_PATH } from '../shared/devlog-utils.js';
import * as path from 'node:path';

interface ToolContext {
  toolName: string;
  timestamp: string;
  taskId?: string;
}

// Global tracker instance
let isTracking = false;
let pendingUpdates: ToolContext[] = [];
let updateTimer: NodeJS.Timeout | null = null;

export async function enableToolTracking(): Promise<void> {
  isTracking = true;
}

export async function disableToolTracking(): Promise<void> {
  isTracking = false;
  if (updateTimer) {
    clearTimeout(updateTimer);
    updateTimer = null;
  }
}

export async function trackToolUsage(toolName: string, context?: {taskId?: string}): Promise<void> {
  if (!isTracking) return;
  
  // Notify heartbeat manager of activity
  notifyActivity();
  
  // Queue the update
  pendingUpdates.push({
    toolName,
    timestamp: new Date().toISOString(),
    taskId: context?.taskId
  });
  
  // Batch updates every 5 seconds to avoid too many file writes
  if (!updateTimer) {
    updateTimer = setTimeout(processPendingUpdates, 5000);
  }
}

async function processPendingUpdates(): Promise<void> {
  if (pendingUpdates.length === 0) return;
  
  try {
    const workspace = await getCurrentWorkspace();
    if (!workspace.exists) return;
    
    const metadata = await extractMetadata(workspace.path);
    if (!metadata) return;
    
    // Process all pending updates
    const updates = [...pendingUpdates];
    pendingUpdates = [];
    
    for (const update of updates) {
      // Update global tool usage
      metadata.tool_usage[update.toolName] = (metadata.tool_usage[update.toolName] || 0) + 1;
      
      // Update task-specific usage if in a task
      if (metadata.active_task) {
        const task = metadata.tasks.find(t => t.id === metadata.active_task);
        if (task) {
          task.tool_usage[update.toolName] = (task.tool_usage[update.toolName] || 0) + 1;
        }
      }
      
      // Update activity breakdown
      const activityType = classifyToolActivity(update.toolName);
      metadata.activity_breakdown[activityType]++;
    }
    
    // Update timing
    const now = new Date();
    const lastHeartbeat = new Date(metadata.session.last_heartbeat);
    const minutesSinceLastUpdate = (now.getTime() - lastHeartbeat.getTime()) / 60000;
    
    // If more than 5 minutes, add to pause time
    if (minutesSinceLastUpdate > 5) {
      metadata.timing.pauses.push({
        start: lastHeartbeat.toISOString(),
        end: now.toISOString(),
        reason: 'auto_inactive'
      });
      metadata.timing.pause_minutes += Math.round(minutesSinceLastUpdate);
    } else {
      // Otherwise add to active time
      metadata.timing.active_minutes += Math.round(minutesSinceLastUpdate);
    }
    
    // Update heartbeat
    metadata.session.last_heartbeat = now.toISOString();
    
    // Update lock heartbeat (multi-agent safety)
    await updateLockHeartbeat(metadata.session.agent_id);
    
    // Save metadata
    await updateMetadata(workspace.path, metadata);
    
  } catch (error) {
    console.error('Failed to update tool tracking:', error);
  } finally {
    updateTimer = null;
  }
}

/**
 * Get a SQLite handle for auto-feedback recording.
 * In tests, `globalThis.__TEST_DB__` is used; in production the project DB is used.
 */
function getAutoFeedbackDb(): import('better-sqlite3').Database | null {
  try {
    const testDb = (globalThis as Record<string, unknown>).__TEST_DB__ as import('better-sqlite3').Database | undefined;
    if (testDb) return testDb;
    const projectPath = path.dirname(DEVLOG_PATH);
    return getSqliteDb({ projectPath, devlogFolder: path.basename(DEVLOG_PATH) });
  } catch {
    return null;
  }
}

/**
 * Record a tool outcome into agent_feedback.
 * Failures are swallowed silently — this must never impact the tool's own error propagation.
 */
function recordAutoFeedback(toolName: string, outcome: 'success' | 'failure', latencyMs: number): void {
  if (process.env.DEVLOG_AUTO_FEEDBACK === 'false') return;
  try {
    const db = getAutoFeedbackDb();
    if (!db) return;
    const agentId = process.env.DEVLOG_AGENT_ID ?? 'unknown';
    db.prepare(`
      INSERT INTO agent_feedback (agent_id, tool_name, outcome, latency_ms, recorded_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(agentId, toolName, outcome, latencyMs);
  } catch {
    // Silently ignore — auto-feedback must never break tool execution
  }
}

// Wrapper for MCP tool handlers to add tracking
export function withToolTracking<T extends (...args: unknown[]) => Promise<unknown>>(
  toolName: string,
  handler: T
): T {
  return (async (...args: unknown[]) => {
    // Track tool usage
    await trackToolUsage(toolName, args[0] as {taskId?: string} | undefined);

    const t0 = Date.now();
    try {
      const result = await handler(...args);
      // MCP handlers commonly report errors as a return value `{ isError: true, ... }`
      // rather than throwing. Treat those as failures so they don't pollute routing.
      const isError = (result as { isError?: unknown } | null | undefined)?.isError === true;
      recordAutoFeedback(toolName, isError ? 'failure' : 'success', Date.now() - t0);
      return result;
    } catch (err) {
      recordAutoFeedback(toolName, 'failure', Date.now() - t0);
      throw err; // re-throw — must not swallow handler errors
    }
  }) as T;
}

// Force flush any pending updates
export async function flushToolTracking(): Promise<void> {
  if (updateTimer) {
    clearTimeout(updateTimer);
    updateTimer = null;
  }
  await processPendingUpdates();
}