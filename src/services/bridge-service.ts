/**
 * Bridge Service - Connects tachibot-mcp outputs to devlog-mcp persistence
 *
 * Pure business logic, no MCP/Zod awareness.
 * Three functions: indexResearch, importPlan, getContext
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { DOKORO_PATH } from '../shared/devlog-utils.js';
import { getSqliteDb, ensureVectorTables } from '../db/index.js';
import { createVectorServices, type SearchResult } from './vector-service.js';

// ═══════════════════════════════════════════════════════════════════════════
// LAZY-INIT SINGLETONS (same pattern as lancedb-tools.ts)
// ═══════════════════════════════════════════════════════════════════════════

let vectorServicesInstance: ReturnType<typeof createVectorServices> | null = null;

function getVectorServices() {
  if (!vectorServicesInstance) {
    const projectPath = path.dirname(DOKORO_PATH);
    const sqlite = getSqliteDb({ projectPath, devlogFolder: path.basename(DOKORO_PATH) });
    ensureVectorTables(sqlite);
    vectorServicesInstance = createVectorServices(sqlite, path.join(projectPath, path.basename(DOKORO_PATH)));
  }
  return vectorServicesInstance;
}

function getSqlite() {
  const projectPath = path.dirname(DOKORO_PATH);
  return getSqliteDb({ projectPath, devlogFolder: path.basename(DOKORO_PATH) });
}

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface IndexResearchInput {
  source: string;
  query: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface IndexResearchResult {
  docId: string;
  chunks: number;
  tokens: number;
  action: 'indexed' | 'reindexed' | 'unchanged';
}

export interface ImportPlanInput {
  title: string;
  phases: string[];
  filepath?: string;
  status?: string;
}

export interface ImportPlanResult {
  planId: string;
  itemCount: number;
  planPath: string;
}

export interface GetContextInput {
  query: string;
  limit?: number;
  include_research?: boolean;
  include_plans?: boolean;
}

export interface ContextEntry {
  title: string;
  type: string;
  excerpt: string;
  score: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// INDEX RESEARCH
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Upserts a research document into SQLite and indexes into LanceDB vectors.
 * Doc ID is deterministic: research-{source}-{sha256(source:query).slice(0,12)}
 * so re-indexing the same query replaces the old doc.
 */
export async function indexResearch(input: IndexResearchInput): Promise<IndexResearchResult> {
  const { source, query, content, metadata } = input;

  // Deterministic ID
  const hash = crypto.createHash('sha256').update(`${source}:${query}`).digest('hex').slice(0, 12);
  const docId = `research-${source}-${hash}`;

  const sqlite = getSqlite();
  const { indexingService } = getVectorServices();

  // Upsert doc into SQLite
  const now = new Date().toISOString();
  const metadataJson = metadata ? JSON.stringify({ ...metadata, source, query }) : JSON.stringify({ source, query });

  const existing = sqlite.prepare('SELECT id FROM docs WHERE id = ?').get(docId);
  const action: IndexResearchResult['action'] = existing ? 'reindexed' : 'indexed';

  if (existing) {
    sqlite.prepare(`
      UPDATE docs SET
        title = ?, content = ?, doc_type = 'research',
        updated_at = ?, metadata_json = ?,
        content_hash = ?
      WHERE id = ?
    `).run(
      `[${source}] ${query}`,
      content,
      now,
      metadataJson,
      crypto.createHash('sha256').update(content).digest('hex'),
      docId,
    );
  } else {
    sqlite.prepare(`
      INSERT INTO docs (id, filepath, title, content, doc_type, status, created_at, updated_at, metadata_json, content_hash)
      VALUES (?, ?, ?, ?, 'research', 'active', ?, ?, ?, ?)
    `).run(
      docId,
      `bridge://research/${source}/${hash}`,
      `[${source}] ${query}`,
      content,
      now,
      now,
      metadataJson,
      crypto.createHash('sha256').update(content).digest('hex'),
    );
  }

  // Index into LanceDB vectors
  const result = await indexingService.indexDocument(docId, content, `[${source}] ${query}`);

  if (result.chunks === 0 && result.tokens === 0 && action === 'reindexed') {
    return { docId, chunks: 0, tokens: 0, action: 'unchanged' };
  }

  return { docId, chunks: result.chunks, tokens: result.tokens, action };
}

// ═══════════════════════════════════════════════════════════════════════════
// IMPORT PLAN
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates a Plan JSON matching plan-tools.ts interface.
 * Writes to DOKORO_PATH/.mcp/plans/{planId}.json + updates index.json.
 * Imported plans immediately work with dokoro_plan_check, dokoro_plan_validate, etc.
 */
export async function importPlan(input: ImportPlanInput): Promise<ImportPlanResult> {
  const { title, phases, status = 'active' } = input;

  const now = new Date().toISOString();
  const planId = `plan-${Date.now().toString(36)}`;

  const plan = {
    id: planId,
    title,
    description: `Imported from tachibot planner_maker`,
    items: phases.map((text: string, idx: number) => ({
      id: `item-${idx}`,
      text,
      completed: false,
      created_at: now,
    })),
    created_at: now,
    updated_at: now,
    status: status as 'draft' | 'active' | 'completed' | 'validated' | 'failed',
    completion_percentage: 0,
  };

  // Write plan file
  const plansDir = path.join(DOKORO_PATH, '.mcp', 'plans');
  await fs.mkdir(plansDir, { recursive: true });

  const planPath = path.join(plansDir, `${planId}.json`);
  await fs.writeFile(planPath, JSON.stringify(plan, null, 2));

  // Update index.json
  const indexPath = path.join(plansDir, 'index.json');
  let index: Record<string, string> = {};
  try {
    const indexContent = await fs.readFile(indexPath, 'utf-8');
    index = JSON.parse(indexContent);
  } catch {
    // Index doesn't exist yet
  }
  index[planId] = title;
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2));

  return { planId, itemCount: phases.length, planPath };
}

// ═══════════════════════════════════════════════════════════════════════════
// GET CONTEXT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calls searchService.search(), optionally filters by docType,
 * returns compact {title, type, excerpt, score}[] format optimized
 * for pasting into tachibot tool inputs.
 */
export async function getContext(input: GetContextInput): Promise<ContextEntry[]> {
  const { query, limit = 10, include_research = true, include_plans = true } = input;

  const { searchService } = getVectorServices();
  const results = await searchService.search(query, limit * 2);

  // Filter by requested types
  const filtered = results.filter((r: SearchResult) => {
    if (r.docType === 'research' && !include_research) return false;
    if (r.docType === 'plan' && !include_plans) return false;
    return true;
  });

  // Return compact format
  return filtered.slice(0, limit).map((r: SearchResult) => ({
    title: r.title || r.docId,
    type: r.docType || 'unknown',
    excerpt: (r.highlight?.excerpt || r.matchedSnippet || '').slice(0, 300),
    score: r.score,
  }));
}
