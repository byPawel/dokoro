/**
 * Cross-session multi-agent handoff (Working/Episodic boundary).
 *
 * An agent records a handoff for the next agent/session (summary + open items);
 * another agent reads the inbox and CLAIMS one (status open->claimed) so two agents
 * don't both pick it up. Per-project only; no global/cross-project store.
 */
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { ToolDefinition } from './registry.js';
import { getSqliteDb } from '../db/index.js';
import { DOKORO_PATH } from '../shared/dokoro-utils.js';
import * as path from 'node:path';

function getSqlite(): Database.Database {
  const projectPath = path.dirname(DOKORO_PATH);
  return getSqliteDb({ projectPath, dokoroFolder: path.basename(DOKORO_PATH) });
}
function db(): Database.Database {
  const existing = (globalThis as Record<string, unknown>).__TEST_DB__ as Database.Database | undefined;
  if (existing) return existing;
  return getSqlite();
}

const NOW = `strftime('%Y-%m-%dT%H:%M:%SZ','now')`;

export const handoffTools: ToolDefinition[] = [
  {
    name: 'dokoro_handoff_write',
    title: 'Write a cross-session handoff',
    description:
      'Record a handoff for the next agent/session in the current project: a summary and a list of open items. ' +
      'Optionally target a specific to_agent; otherwise any agent can claim it. Read later with dokoro_handoff_inbox. Scoped to the current project only.',
    inputSchema: {
      from_agent: z.string(),
      summary: z.string(),
      open_items: z.array(z.string()).optional(),
      to_agent: z.string().optional(),
      session_id: z.string().optional(),
    },
    handler: async (args) => {
      try {
        const a = args as { from_agent: string; summary: string; open_items?: string[]; to_agent?: string; session_id?: string };
        const info = db().prepare(
          `INSERT INTO handoffs (from_agent, to_agent, session_id, summary, open_items_json, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'open', ${NOW})`,
        ).run(a.from_agent, a.to_agent ?? null, a.session_id ?? null, a.summary, a.open_items ? JSON.stringify(a.open_items) : null);
        return { content: [{ type: 'text' as const, text: `handoff #${info.lastInsertRowid} recorded by ${a.from_agent}` }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: 'text' as const, text: `handoff_write failed: ${msg}` }] };
      }
    },
  },
  {
    name: 'dokoro_handoff_inbox',
    title: 'Read open cross-session handoffs',
    description: 'List OPEN handoffs for the current project, newest first. If agent_id is given, returns handoffs targeted to that agent plus untargeted ones; otherwise returns all open handoffs.',
    inputSchema: {
      agent_id: z.string().optional(),
      limit: z.number().int().positive().max(100).optional(),
    },
    handler: async (args) => {
      try {
        const a = args as { agent_id?: string; limit?: number };
        const where = ["status = 'open'"];
        const params: unknown[] = [];
        if (a.agent_id) { where.push('(to_agent IS NULL OR to_agent = ?)'); params.push(a.agent_id); }
        const rows = db().prepare(
          `SELECT id, from_agent, to_agent, summary, open_items_json, created_at
           FROM handoffs WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
        ).all(...params, a.limit ?? 20) as Array<{ id: number; from_agent: string; to_agent: string | null; summary: string; open_items_json: string | null; created_at: string }>;
        if (rows.length === 0) return { content: [{ type: 'text' as const, text: '(no open handoffs)' }] };
        const lines = rows.map((r) => {
          const items = r.open_items_json ? ` | open: ${(JSON.parse(r.open_items_json) as string[]).join('; ')}` : '';
          const to = r.to_agent ? ` -> ${r.to_agent}` : '';
          return `#${r.id} [${r.created_at}] from ${r.from_agent}${to}: ${r.summary}${items}`;
        });
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: 'text' as const, text: `handoff_inbox failed: ${msg}` }] };
      }
    },
  },
  {
    name: 'dokoro_handoff_claim',
    title: 'Claim a cross-session handoff',
    description: 'Atomically claim an OPEN handoff by id for the current project (status open->claimed). Fails if it was already claimed, so two agents never both take the same handoff.',
    inputSchema: {
      handoff_id: z.number().int().positive(),
      agent_id: z.string(),
    },
    handler: async (args) => {
      try {
        const a = args as { handoff_id: number; agent_id: string };
        // Atomic claim: only succeeds while still open.
        const info = db().prepare(`UPDATE handoffs SET status='claimed', claimed_by=?, claimed_at=${NOW} WHERE id=? AND status='open'`)
          .run(a.agent_id, a.handoff_id);
        if (info.changes !== 1) {
          return { isError: true, content: [{ type: 'text' as const, text: `handoff #${a.handoff_id} is not open (already claimed or missing)` }] };
        }
        return { content: [{ type: 'text' as const, text: `handoff #${a.handoff_id} claimed by ${a.agent_id}` }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: 'text' as const, text: `handoff_claim failed: ${msg}` }] };
      }
    },
  },
];
