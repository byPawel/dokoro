/**
 * ADVISORY per-file claims (Working memory layer) — multi-agent file coordination.
 *
 * Multiple agents share one worktree; claims let them see who is editing what.
 * Claims WARN, they never block: a conflict report is advisory and force:true
 * always wins. Lease semantics (DynamoDB lock-client style): a claim expires at
 * expires_at unless renewed (re-claiming bumps heartbeat_seq and extends the
 * lease). Holder liveness is corroborated at read time with agent_presence —
 * an unexpired claim whose holder's heartbeat is stale (> 900s) may be taken
 * over; a holder with NO presence row is treated as live while the claim is
 * unexpired (presence is evidence only when present).
 *
 * Identity is claim_key — the casefolded normalized root-relative path
 * (src/utils/claim-path.ts) — so one file maps to exactly one row. Only
 * root-relative paths are stored; `root` defaults to the server process cwd,
 * so pass it explicitly when the MCP server's cwd differs from the worktree.
 *
 * All timestamps are server-assigned SQLite unixepoch seconds
 * (strftime('%s','now')) — one clock domain, never Date.now(). Per-project only.
 */
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { ToolDefinition } from './registry.js';
import { getSqliteDb } from '../db/index.js';
import { DOKORO_PATH } from '../shared/dokoro-utils.js';
import { normalizeClaimPath } from '../utils/claim-path.js';
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

/** Default claim lease: 5 minutes. Renew by re-claiming before expiry. */
const DEFAULT_TTL_SECONDS = 300;
/** Hard cap on a single lease. */
const MAX_TTL_SECONDS = 3600;
/** Presence liveness window — matches dokoro_presence_list's default. */
const PRESENCE_TTL_SECONDS = 900;
/** Rows older than this (released, or expired-and-open) are pruned opportunistically. */
const PRUNE_AGE_SECONDS = 86400;

interface ClaimRow {
  claim_key: string;
  file_path: string;
  agent_id: string;
  session_id: string | null;
  intent: string | null;
  claimed_at: number;
  expires_at: number;
  heartbeat_seq: number;
  released_at: number | null;
}

type PresenceLabel = 'live' | 'stale' | 'unknown';

/** Read the server clock (SQLite unixepoch seconds) — single clock domain. */
function nowSeconds(sqlite: Database.Database): number {
  const row = sqlite.prepare(`SELECT strftime('%s','now') AS n`).get() as { n: string | number };
  return Number(row.n);
}

/**
 * Presence label for a holder: 'live' if heartbeat within TTL, 'stale' if the
 * presence row exists but is old, 'unknown' when the agent never pinged.
 */
function presenceLabel(sqlite: Database.Database, agentId: string, now: number): PresenceLabel {
  const row = sqlite.prepare('SELECT last_heartbeat FROM agent_presence WHERE agent_id = ?')
    .get(agentId) as { last_heartbeat: number } | undefined;
  if (!row) return 'unknown';
  return now - row.last_heartbeat <= PRESENCE_TTL_SECONDS ? 'live' : 'stale';
}

/**
 * Opportunistic pruning of dead coordination state (no background sweeper):
 * released rows older than a day, and open rows whose lease expired over a
 * day ago. Safe — claims are ephemeral coordination state, not memory.
 */
function pruneOldClaims(sqlite: Database.Database): void {
  sqlite.prepare(`
    DELETE FROM file_claims
    WHERE (released_at IS NOT NULL AND released_at < strftime('%s','now') - ${PRUNE_AGE_SECONDS})
       OR (released_at IS NULL AND expires_at < strftime('%s','now') - ${PRUNE_AGE_SECONDS})
  `).run();
}

interface NormalizedTarget { input: string; relPath: string; claimKey: string }

/**
 * Normalize all input paths against `root`. Any failure rejects the whole
 * batch (all-or-nothing). Duplicate spellings of the same file collapse to
 * one target via claimKey.
 */
function normalizeAll(paths: string[], root: string):
  { ok: true; targets: NormalizedTarget[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const byKey = new Map<string, NormalizedTarget>();
  for (const input of paths) {
    const r = normalizeClaimPath(input, root);
    if (!r.ok) { errors.push(`${input}: ${r.error}`); continue; }
    if (!byKey.has(r.claimKey)) byKey.set(r.claimKey, { input, relPath: r.relPath, claimKey: r.claimKey });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, targets: [...byKey.values()] };
}

type ClaimAction = 'insert' | 'reuse_released' | 'renew' | 'takeover' | 'takeover_forced' | 'conflict';

interface ClaimEval extends NormalizedTarget {
  action: ClaimAction;
  holder?: ClaimRow;
  presence?: PresenceLabel;
}

const ROOT_DESCRIPTION =
  'Workspace root the paths are relative to (defaults to the server process cwd). ' +
  'Claims store only normalized root-relative paths, so all agents must use the same root.';

export const fileClaimTools: ToolDefinition[] = [
  {
    name: 'dokoro_file_claim',
    title: 'Claim files for editing (advisory lease)',
    description:
      'ADVISORY claim on one or more files in the current project so cooperating agents can see who is editing what. ' +
      'All-or-nothing: if ANY path is held by a live agent (and force is not set), NOTHING is claimed and a per-path conflict report is returned. ' +
      'Re-claiming your own file renews the lease (extends expiry, bumps heartbeat_seq). Expired or stale-holder claims are taken over automatically. ' +
      'Claims never block edits — they warn. Paths are stored root-relative; ' + ROOT_DESCRIPTION,
    inputSchema: {
      paths: z.array(z.string()).min(1).max(50).describe('Files to claim (relative to root, or absolute under it).'),
      agent_id: z.string().describe('Your stable agent identity.'),
      session_id: z.string().optional(),
      intent: z.string().optional().describe('What you plan to do with these files (shown to other agents).'),
      ttl_seconds: z.number().int().positive().max(MAX_TTL_SECONDS).optional()
        .describe(`Lease duration in seconds (default ${DEFAULT_TTL_SECONDS}, max ${MAX_TTL_SECONDS}). Renew by re-claiming.`),
      root: z.string().optional().describe(ROOT_DESCRIPTION),
      force: z.boolean().optional().describe('Override even live holders (recorded as a forced takeover). Default false.'),
    },
    handler: async (args) => {
      try {
        const a = args as {
          paths: string[]; agent_id: string; session_id?: string; intent?: string;
          ttl_seconds?: number; root?: string; force?: boolean;
        };
        const root = a.root ?? process.cwd();
        const ttl = a.ttl_seconds ?? DEFAULT_TTL_SECONDS;
        const force = a.force ?? false;

        const normalized = normalizeAll(a.paths, root);
        if (!normalized.ok) {
          return {
            isError: true,
            content: [{
              type: 'text' as const,
              text: `file_claim rejected — NOTHING was claimed. Invalid path(s):\n${normalized.errors.map((e) => `- ${e}`).join('\n')}`,
            }],
          };
        }
        const targets = normalized.targets;
        const sqlite = db();
        pruneOldClaims(sqlite);

        // Evaluate AND apply inside one immediate transaction: the liveness
        // re-check and the conditional takeover cannot interleave with another
        // writer, so acquisition is all-or-nothing and race-free.
        const txn = sqlite.transaction(():
          { committed: boolean; now: number; expiresAt: number; evals: ClaimEval[] } => {
          const now = nowSeconds(sqlite);
          const expiresAt = now + ttl;
          const selectClaim = sqlite.prepare('SELECT * FROM file_claims WHERE claim_key = ?');

          const evals: ClaimEval[] = targets.map((t) => {
            const row = selectClaim.get(t.claimKey) as ClaimRow | undefined;
            if (!row) return { ...t, action: 'insert' };
            if (row.released_at !== null) return { ...t, action: 'reuse_released', holder: row };
            if (row.agent_id === a.agent_id) return { ...t, action: 'renew', holder: row };
            const presence = presenceLabel(sqlite, row.agent_id, now);
            const claimUnexpired = row.expires_at > now;
            // Holder is live while the claim is unexpired UNLESS presence
            // positively shows them dead. No presence row = live (don't
            // punish agents that never ping).
            const holderLive = claimUnexpired && presence !== 'stale';
            if (!holderLive) return { ...t, action: 'takeover', holder: row, presence };
            if (force) return { ...t, action: 'takeover_forced', holder: row, presence };
            return { ...t, action: 'conflict', holder: row, presence };
          });

          // Any conflict (without force) -> abort with NO changes at all.
          if (evals.some((e) => e.action === 'conflict')) {
            return { committed: false, now, expiresAt, evals };
          }

          const insert = sqlite.prepare(`
            INSERT INTO file_claims (claim_key, file_path, agent_id, session_id, intent, claimed_at, expires_at, heartbeat_seq, released_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)
          `);
          const reuseReleased = sqlite.prepare(`
            UPDATE file_claims SET file_path = ?, agent_id = ?, session_id = ?, intent = ?,
              claimed_at = ?, expires_at = ?, heartbeat_seq = 0, released_at = NULL
            WHERE claim_key = ? AND released_at IS NOT NULL
          `);
          const renew = sqlite.prepare(`
            UPDATE file_claims SET expires_at = ?, heartbeat_seq = heartbeat_seq + 1,
              intent = COALESCE(?, intent), session_id = COALESCE(?, session_id)
            WHERE claim_key = ? AND released_at IS NULL AND agent_id = ?
          `);
          // Stale takeover is GUARDED: it only fires while the row is still the
          // expired/stale claim we evaluated (re-checked inside the txn).
          const guardedTakeover = sqlite.prepare(`
            UPDATE file_claims SET file_path = ?, agent_id = ?, session_id = ?, intent = ?,
              claimed_at = ?, expires_at = ?, heartbeat_seq = 0, released_at = NULL
            WHERE claim_key = ? AND released_at IS NULL AND (expires_at <= ? OR agent_id = ?)
          `);
          const forcedTakeover = sqlite.prepare(`
            UPDATE file_claims SET file_path = ?, agent_id = ?, session_id = ?, intent = ?,
              claimed_at = ?, expires_at = ?, heartbeat_seq = 0, released_at = NULL
            WHERE claim_key = ? AND released_at IS NULL
          `);

          for (const e of evals) {
            let changes = 0;
            switch (e.action) {
              case 'insert':
                changes = insert.run(e.claimKey, e.relPath, a.agent_id, a.session_id ?? null, a.intent ?? null, now, expiresAt).changes;
                break;
              case 'reuse_released':
                changes = reuseReleased.run(e.relPath, a.agent_id, a.session_id ?? null, a.intent ?? null, now, expiresAt, e.claimKey).changes;
                break;
              case 'renew':
                changes = renew.run(expiresAt, a.intent ?? null, a.session_id ?? null, e.claimKey, a.agent_id).changes;
                break;
              case 'takeover':
                changes = guardedTakeover.run(e.relPath, a.agent_id, a.session_id ?? null, a.intent ?? null, now, expiresAt, e.claimKey, now, e.holder!.agent_id).changes;
                break;
              case 'takeover_forced':
                changes = forcedTakeover.run(e.relPath, a.agent_id, a.session_id ?? null, a.intent ?? null, now, expiresAt, e.claimKey).changes;
                break;
              /* istanbul ignore next -- conflicts returned above */
              case 'conflict':
                break;
            }
            // Throwing rolls the whole transaction back (all-or-nothing).
            if (changes !== 1) throw new Error(`claim acquisition lost a race on ${e.relPath} — nothing was claimed, retry`);
          }
          return { committed: true, now, expiresAt, evals };
        });
        const result = txn.immediate();

        if (!result.committed) {
          // Advisory conflict: NOT an error. Structured per-path report.
          const report = result.evals.map((e) => {
            if (e.action === 'conflict') {
              return {
                path: e.relPath,
                status: 'conflict' as const,
                holder: {
                  agent_id: e.holder!.agent_id,
                  intent: e.holder!.intent,
                  expires_in_seconds: e.holder!.expires_at - result.now,
                  presence: e.presence!,
                },
              };
            }
            return { path: e.relPath, status: 'would_acquire' as const };
          });
          const lines = result.evals.map((e) => {
            if (e.action === 'conflict') {
              const h = e.holder!;
              return `- CONFLICT ${e.relPath} — held by ${h.agent_id} (presence: ${e.presence}, expires in ${h.expires_at - result.now}s${h.intent ? `, intent: ${h.intent}` : ''})`;
            }
            const note = (e.action === 'takeover' && e.holder)
              ? ` (would take over ${e.holder.expires_at <= result.now ? 'expired' : 'stale-presence'} claim held by ${e.holder.agent_id})`
              : '';
            return `- would_acquire ${e.relPath}${note}`;
          });
          const text =
            `CONFLICT — NOTHING was claimed (all-or-nothing):\n${lines.join('\n')}\n` +
            'Options: claim different files, wait for the holder\'s lease to expire, or retry with force:true to override. ' +
            'Claims are advisory — they warn, they never block.';
          return {
            content: [
              { type: 'text' as const, text },
              { type: 'text' as const, text: JSON.stringify({ claimed: false, report }) },
            ],
          };
        }

        // Success: every path acquired/renewed. Surface takeovers explicitly
        // (fail-and-surface — expired-but-present claims are never silent).
        const statusOf = (e: ClaimEval): 'claimed' | 'renewed' | 'taken_over' | 'taken_over_forced' => {
          if (e.action === 'renew') return 'renewed';
          if (e.action === 'takeover') return 'taken_over';
          if (e.action === 'takeover_forced') return 'taken_over_forced';
          return 'claimed';
        };
        const report = result.evals.map((e) => ({ path: e.relPath, status: statusOf(e) }));
        const lines = result.evals.map((e) => {
          const status = statusOf(e);
          if (status === 'taken_over' && e.holder) {
            const why = e.holder.expires_at <= result.now
              ? `claim expired ${result.now - e.holder.expires_at}s ago`
              : 'holder presence stale';
            return `- taken_over ${e.relPath} (was held by ${e.holder.agent_id}; ${why})`;
          }
          if (status === 'taken_over_forced' && e.holder) {
            return `- taken_over_forced ${e.relPath} (FORCED over live holder ${e.holder.agent_id})`;
          }
          return `- ${status} ${e.relPath}`;
        });
        const text =
          `${result.evals.length} file(s) claimed by ${a.agent_id}, lease expires at ${result.expiresAt} (in ${ttl}s):\n${lines.join('\n')}\n` +
          'Reminder: claims are ADVISORY — they warn other agents, they never block edits. Renew before expiry by claiming again.';
        return {
          content: [
            { type: 'text' as const, text },
            { type: 'text' as const, text: JSON.stringify({ claimed: true, expires_at: result.expiresAt, expires_in_seconds: ttl, report }) },
          ],
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: 'text' as const, text: `file_claim failed: ${msg}` }] };
      }
    },
  },
  {
    name: 'dokoro_file_release',
    title: 'Release file claims',
    description:
      'Release advisory file claims held by you in the current project: specific paths, or all:true for everything you hold. ' +
      'Owner-aware (you can only release your own claims) and idempotent — unknown or already-released paths report not_found, never an error. ' +
      ROOT_DESCRIPTION,
    inputSchema: {
      agent_id: z.string().describe('Your stable agent identity (only your claims are released).'),
      paths: z.array(z.string()).min(1).max(50).optional().describe('Specific files to release. Omit when using all:true.'),
      all: z.boolean().optional().describe('Release every open claim held by agent_id.'),
      root: z.string().optional().describe(ROOT_DESCRIPTION),
    },
    handler: async (args) => {
      try {
        const a = args as { agent_id: string; paths?: string[]; all?: boolean; root?: string };
        const hasPaths = Array.isArray(a.paths) && a.paths.length > 0;
        if (!hasPaths && !a.all) {
          return { isError: true, content: [{ type: 'text' as const, text: 'file_release failed: provide paths[] or all:true' }] };
        }
        if (hasPaths && a.all) {
          return { isError: true, content: [{ type: 'text' as const, text: 'file_release failed: provide either paths[] or all:true, not both' }] };
        }
        const sqlite = db();

        if (a.all) {
          const txn = sqlite.transaction((): string[] => {
            const rows = sqlite.prepare('SELECT file_path FROM file_claims WHERE agent_id = ? AND released_at IS NULL')
              .all(a.agent_id) as Array<{ file_path: string }>;
            sqlite.prepare(`UPDATE file_claims SET released_at = strftime('%s','now') WHERE agent_id = ? AND released_at IS NULL`)
              .run(a.agent_id);
            return rows.map((r) => r.file_path);
          });
          const released = txn.immediate();
          const report = released.map((p) => ({ path: p, status: 'released' as const }));
          const text = released.length === 0
            ? `no open claims held by ${a.agent_id}`
            : `released ${released.length} claim(s) held by ${a.agent_id}:\n${released.map((p) => `- ${p}`).join('\n')}`;
          return {
            content: [
              { type: 'text' as const, text },
              { type: 'text' as const, text: JSON.stringify({ report }) },
            ],
          };
        }

        const root = a.root ?? process.cwd();
        const normalized = normalizeAll(a.paths!, root);
        if (!normalized.ok) {
          return {
            isError: true,
            content: [{
              type: 'text' as const,
              text: `file_release rejected — invalid path(s):\n${normalized.errors.map((e) => `- ${e}`).join('\n')}`,
            }],
          };
        }
        const txn = sqlite.transaction((): Array<{ path: string; status: 'released' | 'not_held_by_you' | 'not_found' }> => {
          const release = sqlite.prepare(`
            UPDATE file_claims SET released_at = strftime('%s','now')
            WHERE claim_key = ? AND agent_id = ? AND released_at IS NULL
          `);
          const lookup = sqlite.prepare('SELECT agent_id, released_at FROM file_claims WHERE claim_key = ?');
          return normalized.targets.map((t) => {
            if (release.run(t.claimKey, a.agent_id).changes === 1) return { path: t.relPath, status: 'released' as const };
            const row = lookup.get(t.claimKey) as { agent_id: string; released_at: number | null } | undefined;
            if (row && row.released_at === null) return { path: t.relPath, status: 'not_held_by_you' as const };
            return { path: t.relPath, status: 'not_found' as const };
          });
        });
        const report = txn.immediate();
        const lines = report.map((r) => `- ${r.status} ${r.path}`);
        return {
          content: [
            { type: 'text' as const, text: lines.join('\n') },
            { type: 'text' as const, text: JSON.stringify({ report }) },
          ],
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: 'text' as const, text: `file_release failed: ${msg}` }] };
      }
    },
  },
  {
    name: 'dokoro_claim_list',
    title: 'List open file claims',
    description:
      'List open advisory file claims in the current project, soonest expiry first, with holder liveness from agent_presence ' +
      `(live = heartbeat within ${PRESENCE_TTL_SECONDS}s, stale = older heartbeat, unknown = never pinged). ` +
      'Expired claims are hidden unless include_expired:true. Paths are root-relative.',
    inputSchema: {
      agent_id: z.string().optional().describe('Only show claims held by this agent.'),
      include_expired: z.boolean().optional().describe('Also show open claims whose lease already expired (default false).'),
      root: z.string().optional().describe(ROOT_DESCRIPTION + ' Informational here — listed paths are root-relative.'),
    },
    handler: async (args) => {
      try {
        const a = args as { agent_id?: string; include_expired?: boolean; root?: string };
        const where = ['fc.released_at IS NULL'];
        const params: unknown[] = [];
        if (!a.include_expired) where.push(`fc.expires_at > strftime('%s','now')`);
        if (a.agent_id) { where.push('fc.agent_id = ?'); params.push(a.agent_id); }
        const sqlite = db();
        const now = nowSeconds(sqlite);
        const rows = sqlite.prepare(`
          SELECT fc.file_path, fc.agent_id, fc.intent, fc.claimed_at, fc.expires_at, fc.heartbeat_seq,
                 ap.last_heartbeat
          FROM file_claims fc
          LEFT JOIN agent_presence ap ON ap.agent_id = fc.agent_id
          WHERE ${where.join(' AND ')}
          ORDER BY fc.expires_at ASC, fc.claim_key ASC
        `).all(...params) as Array<{
          file_path: string; agent_id: string; intent: string | null;
          claimed_at: number; expires_at: number; heartbeat_seq: number; last_heartbeat: number | null;
        }>;
        if (rows.length === 0) return { content: [{ type: 'text' as const, text: '(no open claims)' }] };
        const enriched = rows.map((r) => {
          const presence: PresenceLabel = r.last_heartbeat === null
            ? 'unknown'
            : (now - r.last_heartbeat <= PRESENCE_TTL_SECONDS ? 'live' : 'stale');
          return {
            path: r.file_path,
            agent_id: r.agent_id,
            intent: r.intent,
            expires_in_seconds: r.expires_at - now,
            heartbeat_seq: r.heartbeat_seq,
            presence,
          };
        });
        const table = [
          '| path | agent | intent | expires_in_s | presence |',
          '| --- | --- | --- | --- | --- |',
          ...enriched.map((r) =>
            `| ${r.path} | ${r.agent_id} | ${r.intent ?? ''} | ${r.expires_in_seconds} | ${r.presence} |`),
        ].join('\n');
        return {
          content: [
            { type: 'text' as const, text: table },
            { type: 'text' as const, text: JSON.stringify({ claims: enriched }) },
          ],
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: 'text' as const, text: `claim_list failed: ${msg}` }] };
      }
    },
  },
];
