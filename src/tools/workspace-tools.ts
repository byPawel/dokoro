import { z } from 'zod';
import { promises as fs } from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { ToolDefinition } from './registry.js';
import { getCurrentWorkspace, generateAgentId, parseAgentFromContent } from '../utils/workspace.js';
import { CallToolResult } from '../types.js';
import { DEVLOG_PATH } from '../types/devlog.js';
import { getSqliteDb } from '../db/index.js';

function getSqlite(): Database.Database {
  const projectPath = path.dirname(DEVLOG_PATH);
  return getSqliteDb({ projectPath, devlogFolder: path.basename(DEVLOG_PATH) });
}

function db(): Database.Database {
  const existing = (globalThis as Record<string, unknown>).__TEST_DB__ as Database.Database | undefined;
  if (existing) return existing;
  return getSqlite();
}
import { acquireLock, releaseLock, checkLock } from '../utils/lock-manager.js';
import {
  createInitialMetadata,
  updateMetadata,
  extractMetadata,
  generateSessionSummary,
  formatDuration,
  calculateDuration
} from '../utils/session-metadata.js';
import { enableToolTracking, disableToolTracking, flushToolTracking } from '../utils/tool-tracker.js';
import { CompactionService } from '../services/compaction-service.js';
import { EmbeddingService } from '../services/vector-service.js';
import { floatArrayToBlob, blobToFloatArray, cosineSimilarity } from '../utils/vector-math.js';
import { ensureEpisodicEmbeddingColumn } from '../db/episodic-tables.js';
import { startHeartbeat, stopHeartbeat } from '../utils/heartbeat-manager.js';
import { renderOutput } from '../utils/render-output.js';
import { icon } from '../utils/icons.js';

export const workspaceTools: ToolDefinition[] = [
  {
    name: 'devlog_workspace_claim',
    title: 'Claim Workspace',
    description: 'Claim workspace with multi-agent lock and tracking',
    inputSchema: {
      task: z.string().describe('Current task or focus area'),
      force: z.boolean().optional().default(false).describe('Force claim even if locked'),
      tags: z.record(z.any()).optional().describe('Tags for this session'),
    },
    handler: async ({ task, force = false, tags }): Promise<CallToolResult> => {
      const workspace = await getCurrentWorkspace();
      const agentId = await generateAgentId();
      const sessionId = `session-${new Date().toISOString().replace(/[:.]/g, '-')}-${agentId}`;
      
      // Try to acquire lock
      const lockResult = await acquireLock(agentId, sessionId, force);
      if (!lockResult.success) {
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'Lock Conflict',
                  status: 'error',
                  message: lockResult.error || 'Failed to acquire lock',
                },
              }),
            },
          ],
        };
      }
      
      // Create initial metadata
      const metadata = createInitialMetadata(agentId, sessionId);
      if (lockResult.lock) {
        metadata.session.lock_acquired = lockResult.lock.acquired_at;
        metadata.session.lock_expires = lockResult.lock.expires_at;
      }
      
      // Build workspace content
      const now = new Date().toISOString();
      let content = '---\n';
      content += `agent_id: "${agentId}"\n`;
      content += `session_id: "${sessionId}"\n`;
      content += `session_start: "${now}"\n`;
      content += `last_active: "${now}"\n`;
      content += `task: "${task}"\n`;
      
      if (tags) {
        content += 'tags:\n';
        Object.entries(tags).forEach(([key, value]) => {
          if (Array.isArray(value)) {
            content += `  ${key}:\n`;
            value.forEach(v => content += `    - ${v}\n`);
          } else {
            content += `  ${key}: ${value}\n`;
          }
        });
      }
      
      content += '---\n\n';
      content += `# Current Workspace\n\n`;
      content += `## ${icon('task')} Active Task\n${task}\n\n`;
      content += `## ${icon('chart')} Session Info\n`;
      content += `- Agent: ${agentId}\n`;
      content += `- Session: ${sessionId}\n`;
      content += `- Started: ${now}\n`;
      content += `- Lock expires: ${new Date(metadata.session.lock_expires || now).toLocaleString()}\n\n`;
      content += `## ${icon('active')} Progress\n\n`;
      content += `- [ ] Task started\n`;
      
      try {
        await fs.writeFile(workspace.path, content);
        
        // Add metadata to file
        await updateMetadata(workspace.path, metadata);
        
        // Enable tool tracking and heartbeat
        await enableToolTracking();
        await startHeartbeat(agentId);

        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'Workspace Claimed',
                  status: 'success',
                  message: `${icon('heart')} Tracking and heartbeat enabled.`,
                  details: {
                    'Agent': agentId,
                    'Session': sessionId,
                    'Task': task,
                    'Lock': 'expires in 30 minutes',
                  },
                },
              }),
            },
          ],
        };
      } catch (error) {
        // Release lock on failure
        await releaseLock(agentId);
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'Claim Failed',
                  status: 'error',
                  message: `${error}`,
                },
              }),
            },
          ],
        };
      }
    }
  },
  
  {
    name: 'devlog_workspace_status',
    title: 'Workspace Status',
    description: 'Get current workspace status, lock info, and tracking data',
    inputSchema: {},
    handler: async (): Promise<CallToolResult> => {
      const workspace = await getCurrentWorkspace();

      if (!workspace.exists || !workspace.content) {
        // Check if there's a stale lock
        const lock = await checkLock();
        if (lock) {
          return {
            content: [
              {
                type: 'text',
                text: renderOutput({
                  type: 'status-card',
                  data: {
                    title: 'No Active Workspace',
                    status: 'warning',
                    message: `Found existing lock by ${lock.agent_id}. Use devlog_workspace_claim to start.`,
                    details: {
                      'Lock expires': lock.expires_at,
                    },
                  },
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'No Workspace',
                  status: 'info',
                  message: 'Use devlog_workspace_claim to create one.',
                },
              }),
            },
          ],
        };
      }

      const { agentId, lastActive } = parseAgentFromContent(workspace.content);

      // Extract task from content
      const taskMatch = workspace.content.match(/task:\s*"([^"]+)"/);
      const task = taskMatch ? taskMatch[1] : 'Unknown';

      // Get lock info
      const lock = await checkLock();

      // Get tracking metadata
      const metadata = await extractMetadata(workspace.path);

      // Build details
      const details: Record<string, string> = {
        'Agent': agentId || 'Not set',
        'Task': task,
        'Last Active': lastActive || 'Unknown',
      };

      if (lock) {
        details['Lock'] = `expires ${lock.expires_at}`;
      }

      if (metadata) {
        const activeTasks = metadata.tasks.filter(t => t.status === 'active').length;
        const completedTasks = metadata.tasks.filter(t => t.status === 'completed').length;
        const totalDuration = formatDuration(metadata.timing.total_minutes + metadata.timing.active_minutes);
        const toolCalls = Object.values(metadata.tool_usage).reduce((a, b) => a + b, 0);

        details['Duration'] = `${totalDuration} (Active: ${formatDuration(metadata.timing.active_minutes)})`;
        details['Tasks'] = `${activeTasks} active, ${completedTasks} completed`;
        details['Tool calls'] = `${toolCalls}`;
      }

      return {
        content: [
          {
            type: 'text',
            text: renderOutput({
              type: 'workspace-status',
              data: {
                workspaceId: workspace.path.split('/').pop() || 'workspace',
                isLocked: !!lock,
                lockedBy: lock?.agent_id,
                task: task,
                sessionDuration: metadata ? formatDuration(metadata.timing.total_minutes) : undefined,
                entries: metadata?.tasks.length,
              },
            }),
          },
        ],
      };
    }
  },
  
  {
    name: 'devlog_session_log',
    title: 'Session Log',
    description: 'Log progress or notes to current session',
    inputSchema: {
      entry: z.string().describe('Log entry or progress update'),
      type: z.enum(['progress', 'note', 'issue', 'decision']).optional().default('progress'),
    },
    handler: async ({ entry, type }): Promise<CallToolResult> => {
      const workspace = await getCurrentWorkspace();

      if (!workspace.exists || !workspace.content) {
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'No Workspace',
                  status: 'error',
                  message: 'Use devlog_workspace_claim first.',
                },
              }),
            },
          ],
        };
      }

      const timestamp = new Date().toISOString().slice(11, 19); // HH:MM:SS
      const iconMap: Record<string, string> = {
        progress: icon('completed'),
        note: icon('note'),
        issue: icon('warning'),
        decision: icon('task'),
      };
      const logIcon = iconMap[type];

      // Append to workspace atomically — fs.appendFile is safe for concurrent
      // writers since the OS performs the seek+write atomically (BUG-25).
      const logEntry = `\n${logIcon} [${timestamp}] ${entry}\n`;

      try {
        await fs.appendFile(workspace.path, logEntry);

        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'Entry Logged',
                  status: 'success',
                  message: entry,
                  details: {
                    'Type': type,
                    'Time': timestamp,
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
                  title: 'Log Failed',
                  status: 'error',
                  message: `${error}`,
                },
              }),
            },
          ],
        };
      }
    }
  },
  
  {
    name: 'devlog_workspace_dump',
    title: 'Dump Workspace',
    description: 'Save current workspace to daily log with tracking analytics. Shows exact save location.',
    inputSchema: {
      reason: z.string().describe('Reason for dumping workspace'),
      keepActive: z.boolean().optional().default(true).describe('Keep workspace active after dump'),
      status: z.enum(['active', 'pending', 'backlog', 'done', 'paused', 'blocked']).optional().default('active')
        .describe('Status for the saved devlog (default: active)'),
      docType: z.enum(['issue', 'prd', 'research', 'decision', 'note', 'session', 'plan']).optional().default('session')
        .describe('Document type for categorization'),
    },
    handler: async ({ reason, keepActive = true, status = 'active', docType = 'session' }): Promise<CallToolResult> => {
      const workspace = await getCurrentWorkspace();

      if (!workspace.exists || !workspace.content) {
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'No Workspace',
                  status: 'error',
                  message: 'Nothing to dump.',
                },
              }),
            },
          ],
        };
      }
      
      const { agentId } = parseAgentFromContent(workspace.content);
      // const sessionIdMatch = workspace.content.match(/session_id:\s*"([^"]+)"/);
      // const _sessionId = sessionIdMatch ? sessionIdMatch[1] : 'unknown';
      
      // Flush any pending tool tracking
      await flushToolTracking();
      
      // Get metadata and finalize
      const metadata = await extractMetadata(workspace.path);
      if (metadata) {
        metadata.session.end = new Date().toISOString();
        metadata.timing.total_minutes = calculateDuration(
          metadata.session.start,
          metadata.session.end
        );
        
        // Update workspace with final metadata
        await updateMetadata(workspace.path, metadata);
      }
      
      const now = new Date();
      const dateStr = now.toISOString().split('T')[0];
      const timeStr = now.toISOString().slice(11, 16).replace(':', 'h');
      const dayName = now.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
      
      // Extract focus from task
      const taskMatch = workspace.content.match(/task:\s*"([^"]+)"/);
      const task = taskMatch ? taskMatch[1] : 'session';
      const safeTopic = task.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 30);
      
      // Create filename
      const filename = `${dateStr}-${timeStr}-${dayName}-session-${safeTopic}.md`;
      const dailyDir = path.join(DEVLOG_PATH, 'daily');
      const sessionFile = path.join(dailyDir, filename);
      
      // Prepare session content
      let sessionContent = '---\n';
      sessionContent += `title: "Session: ${task}"\n`;
      sessionContent += `date: "${now.toISOString()}"\n`;
      sessionContent += `agent_id: "${agentId || 'unknown'}"\n`;
      sessionContent += `dump_reason: "${reason}"\n`;
      
      // Add timing from metadata
      if (metadata) {
        sessionContent += `session_start: "${metadata.session.start}"\n`;
        sessionContent += `session_end: "${metadata.session.end}"\n`;
        sessionContent += `duration_minutes: ${metadata.timing.total_minutes}\n`;
        sessionContent += `duration_hours: ${(metadata.timing.total_minutes / 60).toFixed(1)}\n`;
      }
      
      sessionContent += `status: "${status}"\n`;
      sessionContent += `docType: "${docType}"\n`;
      sessionContent += 'tags:\n';
      sessionContent += `  type: ${docType}\n`;
      sessionContent += '  scope: [' + (metadata ? Object.keys(metadata.activity_breakdown)
        .filter(k => metadata.activity_breakdown[k as keyof typeof metadata.activity_breakdown] > 0)
        .join(', ') : 'general') + ']\n';
      sessionContent += `  status: ${status}\n`;
      sessionContent += `  focus: "${task}"\n`;
      
      if (metadata && metadata.timing.total_minutes > 0) {
        sessionContent += `  duration: "${formatDuration(metadata.timing.total_minutes)}"\n`;
      }
      
      sessionContent += '---\n\n';
      sessionContent += `# Session: ${task}\n\n`;
      sessionContent += `**Date**: ${dateStr} (${dayName.charAt(0).toUpperCase() + dayName.slice(1)})\n`;
      sessionContent += `**Time**: ${timeStr.replace('h', ':')}\n`;
      sessionContent += `**Agent**: ${agentId}\n`;
      sessionContent += `**Reason**: ${reason}\n\n`;
      
      // Add summary section
      if (metadata && metadata.tasks.length > 0) {
        const completedTasks = metadata.tasks.filter(t => t.status === 'completed');
        const activeTasks = metadata.tasks.filter(t => t.status === 'active');

        sessionContent += `## Summary\n`;
        if (completedTasks.length > 0) {
          sessionContent += `### ${icon('completed')} Completed\n`;
          completedTasks.forEach(t => {
            sessionContent += `- ${icon('completed')} ${t.title} (${formatDuration(t.duration_minutes || 0)})\n`;
          });
        }
        if (activeTasks.length > 0) {
          sessionContent += `### ${icon('active')} In Progress\n`;
          activeTasks.forEach(t => {
            sessionContent += `- ${icon('active')} ${t.title}\n`;
          });
        }
        sessionContent += '\n';
      }
      
      sessionContent += `## Workspace Content at Time of Dump\n\n`;
      sessionContent += workspace.content;
      
      // Add analytics summary if available
      if (metadata) {
        sessionContent += '\n\n' + generateSessionSummary(metadata);
      }
      
      try {
        // Create daily directory if needed
        await fs.mkdir(dailyDir, { recursive: true });
        
        // Save session log
        await fs.writeFile(sessionFile, sessionContent);

        // Register in docs table so entity_extract_deep can find it
        try {
          const projectPath = path.dirname(DEVLOG_PATH);
          const db = getSqliteDb({ projectPath, devlogFolder: path.basename(DEVLOG_PATH) });
          const docId = path.basename(filename, '.md');
          const relPath = path.relative(DEVLOG_PATH, sessionFile);
          const now_iso = new Date().toISOString();
          db.prepare(`
            INSERT INTO docs (id, filepath, title, content, doc_type, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              filepath    = excluded.filepath,
              title       = excluded.title,
              content     = excluded.content,
              doc_type    = excluded.doc_type,
              status      = excluded.status,
              updated_at  = excluded.updated_at
          `).run(docId, relPath, `Session: ${task}`, sessionContent, docType, status, now_iso, now_iso);
        } catch (dbErr) {
          // DB registration is best-effort — file is already saved
          console.error('[workspace-dump] docs table registration failed:', dbErr);
        }

        // Handle workspace based on keepActive
        if (!keepActive) {
          // Release lock and clear workspace
          await releaseLock(agentId || '');
          await disableToolTracking();
          stopHeartbeat();
          await fs.unlink(workspace.path);
        } else {
          // Just update the workspace to show it was dumped
          const updatedContent = workspace.content.replace(
            /## .* Progress/,
            `## ${icon('active')} Progress\n\n${icon('tag')} Session dumped to: [${filename}](daily/${filename})\n`
          );
          await fs.writeFile(workspace.path, updatedContent);
        }

        const details: Record<string, string> = {
          'Full path': sessionFile,
          'Relative': path.relative(DEVLOG_PATH, sessionFile),
          'Status': status.toUpperCase(),
          'Type': docType,
          'Reason': reason,
        };
        if (metadata) {
          details['Duration'] = `${formatDuration(metadata.timing.total_minutes)} (Active: ${formatDuration(metadata.timing.active_minutes)})`;
        }

        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: `${icon('completed')} Saved to Devlog`,
                  status: 'success',
                  message: `📍 ${sessionFile}`,
                  details,
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
                  title: 'Dump Failed',
                  status: 'error',
                  message: `${error}`,
                },
              }),
            },
          ],
        };
      }
    }
  },

  {
    name: 'devlog_session_summary_add',
    title: 'Record a session summary',
    description: 'Persist a conversation summary into episodic memory (conversation_summaries), readable later via devlog_session_recall.',
    inputSchema: {
      session_id: z.string(),
      ai_model: z.string(),
      summary: z.string(),
      key_decisions: z.array(z.string()).optional(),
      key_topics: z.array(z.string()).optional(),
      message_count: z.number().int().optional(),
      token_count: z.number().int().optional(),
    },
    handler: async (args): Promise<CallToolResult> => {
      try {
        const a = args as {
          session_id: string;
          ai_model: string;
          summary: string;
          key_decisions?: string[];
          key_topics?: string[];
          message_count?: number;
          token_count?: number;
        };
        // Embed the summary for semantic recall. Soft-fail (store null) when
        // Ollama is unavailable so recall falls back to substring + recency.
        ensureEpisodicEmbeddingColumn(db());
        let embeddingBlob: Buffer | null = null;
        try {
          const { embedding } = await new EmbeddingService().embed(a.summary);
          if (embedding && embedding.length) embeddingBlob = floatArrayToBlob(embedding);
        } catch { /* offline -> null embedding */ }

        db().prepare(`INSERT INTO conversation_summaries
          (session_id, ai_model, summary, key_decisions_json, key_topics_json, message_count, token_count, started_at, summary_embedding)
          VALUES (?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), ?)`).run(
          a.session_id,
          a.ai_model,
          a.summary,
          a.key_decisions ? JSON.stringify(a.key_decisions) : null,
          a.key_topics ? JSON.stringify(a.key_topics) : null,
          a.message_count ?? null,
          a.token_count ?? null,
          embeddingBlob,
        );

        // Episodic compaction: once cumulative summary tokens exceed the
        // threshold, merge this session's summaries into sessions.summary.
        const compactor = new CompactionService(db());
        let note = '';
        if (compactor.needsCompaction(a.session_id)) {
          const res = await compactor.compact(a.session_id);
          note = ` (compacted ${res.compactedSummaries} summaries, ~${res.compactedTokens} tokens)`;
        }
        return { content: [{ type: 'text' as const, text: `summary recorded for session ${a.session_id}${note}` }] };
      } catch (e) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `session_summary_add failed: ${(e as Error).message}` }],
        };
      }
    },
  },

  {
    name: 'devlog_session_recall',
    title: 'Recall past sessions',
    description: 'Read conversation summaries from finished sessions (episodic memory). Filter by query substring, session_id, or since timestamp.',
    inputSchema: {
      query: z.string().optional().describe('Substring to filter summaries.'),
      session_id: z.string().optional(),
      since: z.string().optional().describe('ISO timestamp lower bound.'),
      limit: z.number().int().positive().max(100).optional(),
    },
    handler: async (args): Promise<CallToolResult> => {
      try {
        const a = args as { query?: string; session_id?: string; since?: string; limit?: number };
        const where: string[] = [];
        const params: unknown[] = [];
        if (a.query)      { where.push('summary LIKE ?');  params.push(`%${a.query}%`); }
        if (a.session_id) { where.push('session_id = ?'); params.push(a.session_id); }
        if (a.since)      { where.push('started_at >= ?'); params.push(a.since); }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

        ensureEpisodicEmbeddingColumn(db());
        const userLimit = a.limit ?? 10;
        // With a query we semantically re-rank, so the recency LIMIT must NOT
        // truncate candidates first — otherwise a relevant older summary outside
        // the recency window is lost. Pull a bounded wider pool, rank, then slice.
        const RANK_CANDIDATE_CAP = 500;
        const fetchLimit = a.query ? Math.max(userLimit, RANK_CANDIDATE_CAP) : userLimit;
        const rows = db().prepare(`
          SELECT session_id, ai_model, summary, message_count, token_count, started_at, ended_at, summary_embedding
          FROM conversation_summaries
          ${whereSql}
          ORDER BY started_at DESC
          LIMIT ?
        `).all(...params, fetchLimit) as Array<Record<string, unknown>>;

        // Semantic re-rank when a query is provided and embeds successfully;
        // otherwise keep the recency order from the SQL above.
        let ordered = rows;
        if (a.query) {
          try {
            const { embedding } = await new EmbeddingService().embed(a.query);
            if (embedding && embedding.length) {
              ordered = [...rows]
                .map((r) => {
                  const blob = r['summary_embedding'] as Buffer | null;
                  const sim = blob ? cosineSimilarity(embedding, blobToFloatArray(blob)) : -1;
                  return { r, sim };
                })
                .sort((x, y) => y.sim - x.sim)
                .map((x) => x.r);
            }
          } catch { /* keep recency order on embed failure */ }
        }
        // Apply the user-facing limit AFTER ranking (recency path already capped).
        ordered = ordered.slice(0, userLimit);

        const text = ordered.map((r) =>
          `[${r['started_at']}] session=${r['session_id']} model=${r['ai_model']} msgs=${r['message_count']}\n  ${r['summary']}`
        ).join('\n\n') || '(no past sessions)';
        return { content: [{ type: 'text' as const, text }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `session_recall failed: ${msg}` }],
        };
      }
    },
  },
];