/**
 * Affective Memory MCP Tools
 *
 * Provides two tools for recording and querying agent feedback (affective memory layer):
 * - devlog_feedback_record: Persist the outcome of a tool call
 * - devlog_feedback_query: Summarise success rates and per-tool stats
 */

import { z } from 'zod';
import type Database from 'better-sqlite3';
import { ToolDefinition } from './registry.js';
import { getSqliteDb } from '../db/index.js';
import { DEVLOG_PATH } from '../shared/devlog-utils.js';
import * as path from 'node:path';

function getSqlite(): Database.Database {
  const projectPath = path.dirname(DEVLOG_PATH);
  return getSqliteDb({ projectPath, devlogFolder: path.basename(DEVLOG_PATH) });
}

function db(): Database.Database {
  const existing = (globalThis as Record<string, unknown>).__TEST_DB__ as Database.Database | undefined;
  if (existing) return existing;
  return getSqlite();
}

const Outcome = z.enum(['success', 'failure', 'partial', 'rejected', 'timeout']);

/**
 * Wilson score lower bound at z=1.96 (95% confidence).
 * Returns a lower bound on the true success rate given n trials and k successes.
 * This is used as the sort key for devlog_feedback_route so a tool with 1/1 does
 * not outrank a tool with 95/100.
 */
function wilsonLower(k: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const phat = k / n;
  const z2 = z * z;
  const numerator = phat + z2 / (2 * n) - z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  const denominator = 1 + z2 / n;
  return numerator / denominator;
}

export const feedbackTools: ToolDefinition[] = [
  {
    name: 'devlog_feedback_record',
    title: 'Record agent feedback',
    description: 'Record the outcome of a tool call into the affective memory layer.',
    inputSchema: {
      agent_id: z.string(),
      tool_name: z.string(),
      outcome: Outcome,
      confidence: z.number().min(0).max(1).optional(),
      latency_ms: z.number().int().nonnegative().optional(),
      error_message: z.string().optional(),
      doc_id: z.string().optional(),
      session_id: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    },
    handler: async (args) => {
      try {
        const a = args as {
          agent_id: string;
          tool_name: string;
          outcome: z.infer<typeof Outcome>;
          confidence?: number;
          latency_ms?: number;
          error_message?: string;
          doc_id?: string;
          session_id?: string;
          metadata?: Record<string, unknown>;
        };
        db().prepare(`
          INSERT INTO agent_feedback
            (agent_id, tool_name, outcome, confidence, latency_ms, error_message, doc_id, session_id, metadata_json, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
          a.agent_id,
          a.tool_name,
          a.outcome,
          a.confidence ?? null,
          a.latency_ms ?? null,
          a.error_message ?? null,
          a.doc_id ?? null,
          a.session_id ?? null,
          a.metadata ? JSON.stringify(a.metadata) : null,
        );
        return { content: [{ type: 'text' as const, text: `recorded ${a.outcome} for ${a.tool_name}` }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `feedback_record failed: ${msg}` }],
        };
      }
    },
  },
  {
    name: 'devlog_feedback_query',
    title: 'Query agent feedback',
    description: 'Summarise affective memory: success rate, recent failures, per-tool stats.',
    inputSchema: {
      tool_name: z.string().optional(),
      agent_id: z.string().optional(),
      since: z.string().optional(),
      limit: z.number().int().positive().max(500).optional(),
    },
    handler: async (args) => {
      try {
        const a = args as {
          tool_name?: string;
          agent_id?: string;
          since?: string;
          limit?: number;
        };
        const where: string[] = [];
        const params: unknown[] = [];
        if (a.tool_name) { where.push('tool_name = ?'); params.push(a.tool_name); }
        if (a.agent_id)  { where.push('agent_id = ?');  params.push(a.agent_id); }
        if (a.since)     { where.push('recorded_at >= ?'); params.push(a.since); }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

        const summary = db().prepare(`
          SELECT tool_name,
                 COUNT(*)                                                              AS total,
                 SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END)                  AS success,
                 SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END)                  AS failure,
                 ROUND(AVG(CASE WHEN outcome = 'success' THEN 1.0 ELSE 0.0 END), 3)    AS success_rate,
                 ROUND(AVG(confidence), 3)                                             AS avg_confidence
          FROM agent_feedback ${whereSql}
          GROUP BY tool_name
          ORDER BY total DESC
          LIMIT ?
        `).all(...params, a.limit ?? 50) as Array<Record<string, unknown>>;

        const lines = summary.map((r) =>
          `${r['tool_name']}: total=${r['total']} success=${r['success']} failure=${r['failure']} success_rate=${r['success_rate']} avg_confidence=${r['avg_confidence']}`
        );
        return { content: [{ type: 'text' as const, text: lines.join('\n') || '(no feedback recorded)' }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `feedback_query failed: ${msg}` }],
        };
      }
    },
  },
  {
    name: 'devlog_feedback_route',
    title: 'Route tool selection via affective memory',
    description:
      'Return a statistically-sound ranked list of tools using Wilson lower bound (z=1.96) ' +
      'and recency-decayed success rate. Use this to bias tool selection toward historically ' +
      'reliable tools. Results include outcome breakdown and a confident flag (n >= min_samples).',
    inputSchema: {
      tool_name:      z.string().optional(),
      agent_id:       z.string().optional(),
      half_life_days: z.number().positive().optional(),
      min_samples:    z.number().int().positive().optional(),
    },
    handler: async (args) => {
      try {
        const a = args as {
          tool_name?: string;
          agent_id?: string;
          half_life_days?: number;
          min_samples?: number;
        };
        const halfLife = a.half_life_days ?? 14;
        const minSamples = a.min_samples ?? 5;

        // Build WHERE clause
        const where: string[] = [];
        const params: unknown[] = [];
        if (a.tool_name) { where.push('tool_name = ?'); params.push(a.tool_name); }
        if (a.agent_id)  { where.push('agent_id = ?');  params.push(a.agent_id); }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

        // Grouping is done in JS below: by tool_name when an agent filter is set,
        // else by (agent_id, tool_name) to avoid cross-agent contamination (BUG-17).

        // Fetch raw rows — we compute decay and Wilson in JS to keep the SQL readable
        // and avoid SQLite's lack of POW().  (SQLite has EXP/LOG but better to be explicit.)
        const rows = db().prepare(`
          SELECT
            agent_id,
            tool_name,
            outcome,
            COALESCE(confidence, 0)                                   AS confidence,
            CAST(julianday('now') - julianday(recorded_at) AS REAL)   AS age_days
          FROM agent_feedback
          ${whereSql}
        `).all(...params) as Array<{
          agent_id: string;
          tool_name: string;
          outcome: string;
          confidence: number;
          age_days: number;
        }>;

        if (rows.length === 0) {
          return { content: [{ type: 'text' as const, text: '(no feedback recorded)' }] };
        }

        // Group rows by (agent_id, tool_name) — or just tool_name when agent filtered
        type GroupKey = string;
        const groups = new Map<GroupKey, typeof rows>();
        for (const row of rows) {
          const key: GroupKey = a.agent_id
            ? row.tool_name
            : `${row.agent_id}\x00${row.tool_name}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key)!.push(row);
        }

        interface RouteEntry {
          agent_id: string;
          tool_name: string;
          n: number;
          success: number;
          failure: number;
          partial: number;
          rejected: number;
          timeout: number;
          decayed_rate: number;
          wilson_lower: number;
          confident: boolean;
        }

        const entries: RouteEntry[] = [];

        for (const grpRows of groups.values()) {
          const first = grpRows[0];
          const tool_name = first.tool_name;
          const agent_id = a.agent_id ?? first.agent_id;

          // Outcome counts
          let success = 0, failure = 0, partial = 0, rejected = 0, timeout = 0;
          for (const r of grpRows) {
            if (r.outcome === 'success')  success++;
            else if (r.outcome === 'failure')  failure++;
            else if (r.outcome === 'partial')  partial++;
            else if (r.outcome === 'rejected') rejected++;
            else if (r.outcome === 'timeout')  timeout++;
          }
          const n = grpRows.length;

          // Recency-decayed success rate: Σ(is_success · 0.5^(age/half_life)) / Σ(0.5^(age/half_life))
          let wSum = 0;
          let wSuccessSum = 0;
          for (const r of grpRows) {
            const age = Math.max(0, r.age_days);
            const w = Math.pow(0.5, age / halfLife);
            wSum += w;
            if (r.outcome === 'success') wSuccessSum += w;
          }
          const decayed_rate = wSum > 0 ? wSuccessSum / wSum : 0;

          // Wilson lower bound over raw counts (statistically sound for ranking)
          const wilson_lower = wilsonLower(success, n);

          entries.push({
            agent_id,
            tool_name,
            n,
            success,
            failure,
            partial,
            rejected,
            timeout,
            decayed_rate,
            wilson_lower,
            confident: n >= minSamples,
          });
        }

        // Sort by Wilson lower bound descending
        entries.sort((a, b) => b.wilson_lower - a.wilson_lower);

        const lines = entries.map((e) => {
          const parts = [
            e.tool_name,
            `n=${e.n}`,
            `success=${e.success}`,
            `failure=${e.failure}`,
            `partial=${e.partial}`,
            `rejected=${e.rejected}`,
            `timeout=${e.timeout}`,
            `decayed_rate=${e.decayed_rate.toFixed(3)}`,
            `wilson_lower=${e.wilson_lower.toFixed(4)}`,
            `confident=${e.confident}`,
          ];
          if (!a.agent_id) parts.splice(1, 0, `agent=${e.agent_id}`);
          return parts.join(' ');
        });

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `feedback_route failed: ${msg}` }],
        };
      }
    },
  },
];
