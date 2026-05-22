# Memory-Layer Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `devlog-mcp` from a passive log store into a self-aware agent memory with five clearly separated layers (working / episodic / semantic / procedural / affective), drop dead schema, add bi-temporal facts, expose session recall, kill the 3361-LOC legacy entrypoint, and ship a README that explains the resulting taxonomy.

**Architecture:**
- Keep the existing Drizzle + better-sqlite3 + LanceDB foundation.
- **Add one new table** (`agent_feedback`) for the missing affective layer.
- **Mutate one existing table** (`entity_relations`) to be bi-temporal (Zep-style validity windows).
- **Add one new MCP tool group** (`feedback-tools.ts`) exposing read/write for affective memory.
- **Add one new MCP tool** (`devlog_session_recall`) to surface the already-populated `conversation_summaries` table.
- **Delete** unwired schema tables and `simple-devlog-server.ts` (3361 LOC, no live imports).
- Rewrite `README.md` to be organised around the five memory types instead of the current tool grab-bag.

**Tech Stack:** TypeScript 5.x, Drizzle ORM 0.45, better-sqlite3 12, Zod 3, Jest 29, MCP SDK (in-tree).

**Reading order for the implementer:**
- `src/db/schema.ts` — Drizzle schema, current shape
- `src/db/migrate.ts` — how migrations run
- `src/tools/registry.ts` + `src/tools/entity-tools.ts` — tool registration pattern
- `src/services/compaction-service.ts:32,66` — existing readers of `conversation_summaries`
- `src/servers/core-server.ts` — where new tools get wired in

**Convention used in this plan:** all multi-statement SQL is run inside a `db.transaction(() => { ... })()` block using `db.prepare(sql).run()` per statement, which is equivalent to a single multi-statement call but plays nicer with the linter and gives atomic migrations.

---

## Task 1: Investigate and confirm the kill list

**Files:**
- Read-only: `src/db/schema.ts`, `src/**/*.ts`

This task is investigative; it produces a typed kill list that locks in scope for Tasks 2 and 3. Do not skip it — assumptions about which tables are dead were made by a one-pass audit and must be re-verified before deletion.

- [ ] **Step 1: Confirm each suspected-dead table has zero non-schema references**

Run for each table:
```bash
cd /Users/gravity/Documents/WORK/TACHIBOT_ALL/devlog-mcp
for t in sessionContext knowledgeLinks syncQueue dailyTimeline modifications docAssignments; do
  echo "=== $t ===";
  grep -rn "\b${t}\b" src --include="*.ts" | grep -v schema.ts | grep -v "\.test\.ts" || echo "  (no live refs)";
done
```
Expected: each block prints either `(no live refs)` or only `schema.ts` matches.

- [ ] **Step 2: Confirm `simple-devlog-server.ts` is dead**

Run:
```bash
grep -rn "simple-devlog-server" /Users/gravity/Documents/WORK/TACHIBOT_ALL/devlog-mcp/{src,bin,package.json,*.sh} 2>/dev/null
```
Expected: only one match — a comment in `src/tools/enhanced-compression-helper.ts:31`. No `import`, no script entry. Safe to delete.

- [ ] **Step 3: Record decisions**

Open this plan file, scroll to the bottom, and fill the "Kill-list confirmed" section with the table names + the dead file. Anything that turned out to still have live refs is moved out of the deletion task into a follow-up task.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-05-22-memory-layer-upgrade.md
git commit -m "docs(plan): confirm memory-layer kill list"
```

---

## Task 2: Add the affective-memory table (`agent_feedback`)

**Files:**
- Modify: `src/db/schema.ts` (append)
- Modify: `src/db/migrate.ts` (add migration step)
- Test: `src/db/agent-feedback.test.ts` (new)

This is the new memory layer. It captures per-action outcomes so future routing decisions can use historical success/failure rather than treating each tool call as untrustworthy.

- [ ] **Step 1: Write the failing test**

Create `src/db/agent-feedback.test.ts`:
```typescript
import Database from 'better-sqlite3';
import { runMigrations } from './migrate.js';

describe('agent_feedback table', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => db.close());

  it('records a tool outcome and reads it back', () => {
    db.prepare(`
      INSERT INTO agent_feedback
        (agent_id, tool_name, outcome, confidence, latency_ms, error_message, doc_id, session_id, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run('claude-opus-4-7', 'devlog_entity_extract_deep', 'success', 0.91, 1240, null, 'doc-42', 'sess-99');

    const row = db.prepare(`SELECT outcome, confidence FROM agent_feedback WHERE tool_name = ?`)
      .get('devlog_entity_extract_deep') as { outcome: string; confidence: number };

    expect(row.outcome).toBe('success');
    expect(row.confidence).toBeCloseTo(0.91, 2);
  });

  it('computes per-tool success rate', () => {
    const insert = db.prepare(`
      INSERT INTO agent_feedback (agent_id, tool_name, outcome, confidence, recorded_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `);
    insert.run('a', 't', 'success', 1.0);
    insert.run('a', 't', 'success', 1.0);
    insert.run('a', 't', 'failure', 0.0);

    const stats = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS wins
      FROM agent_feedback WHERE tool_name = ?
    `).get('t') as { total: number; wins: number };

    expect(stats.total).toBe(3);
    expect(stats.wins).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx jest src/db/agent-feedback.test.ts -v
```
Expected: FAIL with `SQLITE_ERROR: no such table: agent_feedback`.

- [ ] **Step 3: Add the Drizzle table**

Append to `src/db/schema.ts` (after the `entityRelations` block, before `// SESSIONS`):

```typescript
// ═══════════════════════════════════════════════════════════════════════════
// AFFECTIVE MEMORY (agent feedback / success-failure history)
// ═══════════════════════════════════════════════════════════════════════════

export const agentFeedback = sqliteTable(
  "agent_feedback",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentId: text("agent_id").notNull(),
    toolName: text("tool_name").notNull(),
    outcome: text("outcome").notNull(),
    confidence: real("confidence").default(1.0),
    latencyMs: integer("latency_ms"),
    errorMessage: text("error_message"),
    docId: text("doc_id").references(() => docs.id, { onDelete: "set null" }),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    metadataJson: text("metadata_json"),
    recordedAt: text("recorded_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_feedback_tool").on(table.toolName),
    index("idx_feedback_agent").on(table.agentId),
    index("idx_feedback_outcome").on(table.outcome),
    index("idx_feedback_session").on(table.sessionId),
    index("idx_feedback_recorded").on(table.recordedAt),
  ]
);
```

- [ ] **Step 4: Add the migration**

Open `src/db/migrate.ts` and locate the migrations array. Append a new migration step:

```typescript
{
  version: <NEXT_VERSION_NUMBER>,
  description: "Add agent_feedback table (affective memory)",
  up: (db) => {
    db.transaction(() => {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS agent_feedback (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          outcome TEXT NOT NULL,
          confidence REAL DEFAULT 1.0,
          latency_ms INTEGER,
          error_message TEXT,
          doc_id TEXT REFERENCES docs(id) ON DELETE SET NULL,
          session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
          metadata_json TEXT,
          recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_feedback_tool ON agent_feedback(tool_name)`).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_feedback_agent ON agent_feedback(agent_id)`).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_feedback_outcome ON agent_feedback(outcome)`).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_feedback_session ON agent_feedback(session_id)`).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_feedback_recorded ON agent_feedback(recorded_at)`).run();
    })();
  },
}
```

Replace `<NEXT_VERSION_NUMBER>` with `currentMaxVersion + 1` after reading the existing migrations.

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx jest src/db/agent-feedback.test.ts -v
```
Expected: both tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/migrate.ts src/db/agent-feedback.test.ts
git commit -m "feat(memory): add agent_feedback table (affective memory layer)"
```

---

## Task 3: Expose affective memory via MCP tools

**Files:**
- Create: `src/tools/feedback-tools.ts`
- Create: `src/tools/feedback-tools.test.ts`
- Modify: `src/servers/core-server.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tools/feedback-tools.test.ts`:
```typescript
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { feedbackTools } from './feedback-tools.js';

function findTool(name: string) {
  const t = feedbackTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

describe('feedback-tools', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    (globalThis as any).__TEST_DB__ = db;
  });
  afterEach(() => { db.close(); delete (globalThis as any).__TEST_DB__; });

  it('devlog_feedback_record persists a row', async () => {
    const tool = findTool('devlog_feedback_record');
    const res = await tool.handler({
      agent_id: 'claude-opus-4-7',
      tool_name: 'devlog_entity_extract_deep',
      outcome: 'success',
      confidence: 0.9,
      latency_ms: 1200,
    });
    expect(res.isError).toBeFalsy();
    const n = db.prepare('SELECT COUNT(*) AS n FROM agent_feedback').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('devlog_feedback_query returns success rate per tool', async () => {
    const rec = findTool('devlog_feedback_record');
    await rec.handler({ agent_id: 'a', tool_name: 't', outcome: 'success', confidence: 1 });
    await rec.handler({ agent_id: 'a', tool_name: 't', outcome: 'failure', confidence: 0 });

    const q = findTool('devlog_feedback_query');
    const res = await q.handler({ tool_name: 't' });
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toMatch(/success.*1/i);
    expect(text).toMatch(/failure.*1/i);
    expect(text).toMatch(/success_rate.*0\.5/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/tools/feedback-tools.test.ts -v
```
Expected: FAIL with `Cannot find module './feedback-tools.js'`.

- [ ] **Step 3: Implement `feedback-tools.ts`**

Create `src/tools/feedback-tools.ts`:
```typescript
import { z } from 'zod';
import type { ToolDefinition } from './registry.js';
import { getSqliteDb } from '../db/index.js';
import { DEVLOG_PATH } from '../shared/devlog-utils.js';
import * as path from 'node:path';

function db() {
  const existing = (globalThis as { __TEST_DB__?: import('better-sqlite3').Database }).__TEST_DB__;
  if (existing) return existing;
  const projectPath = path.dirname(DEVLOG_PATH);
  return getSqliteDb({ projectPath, devlogFolder: path.basename(DEVLOG_PATH) });
}

const Outcome = z.enum(['success', 'failure', 'partial', 'rejected', 'timeout']);

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
      const a = args as {
        agent_id: string; tool_name: string; outcome: z.infer<typeof Outcome>;
        confidence?: number; latency_ms?: number; error_message?: string;
        doc_id?: string; session_id?: string; metadata?: Record<string, unknown>;
      };
      db().prepare(`
        INSERT INTO agent_feedback
          (agent_id, tool_name, outcome, confidence, latency_ms, error_message, doc_id, session_id, metadata_json, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        a.agent_id, a.tool_name, a.outcome,
        a.confidence ?? null, a.latency_ms ?? null, a.error_message ?? null,
        a.doc_id ?? null, a.session_id ?? null,
        a.metadata ? JSON.stringify(a.metadata) : null,
      );
      return { content: [{ type: 'text', text: `recorded ${a.outcome} for ${a.tool_name}` }] };
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
      const a = args as { tool_name?: string; agent_id?: string; since?: string; limit?: number };
      const where: string[] = [];
      const params: unknown[] = [];
      if (a.tool_name) { where.push('tool_name = ?'); params.push(a.tool_name); }
      if (a.agent_id) { where.push('agent_id = ?'); params.push(a.agent_id); }
      if (a.since)    { where.push('recorded_at >= ?'); params.push(a.since); }
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
        `${r.tool_name}: total=${r.total} success=${r.success} failure=${r.failure} success_rate=${r.success_rate} avg_confidence=${r.avg_confidence}`
      );
      return { content: [{ type: 'text', text: lines.join('\n') || '(no feedback recorded)' }] };
    },
  },
];
```

- [ ] **Step 4: Wire into `core-server.ts`**

Edit `src/servers/core-server.ts`:
```typescript
import { entityTools } from '../tools/entity-tools.js';
import { feedbackTools } from '../tools/feedback-tools.js';   // NEW
```
And inside the `coreTools` array, add a block after entity tools:
```typescript
  // Entity knowledge graph
  ...entityTools,

  // Affective memory (agent feedback)
  ...feedbackTools,
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx jest src/tools/feedback-tools.test.ts -v
npm run lint
```
Expected: tests PASS, lint clean.

- [ ] **Step 6: Commit**

```bash
git add src/tools/feedback-tools.ts src/tools/feedback-tools.test.ts src/servers/core-server.ts
git commit -m "feat(memory): expose affective memory via devlog_feedback_record/query tools"
```

---

## Task 4: Make `entity_relations` bi-temporal

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/migrate.ts`
- Modify: `src/tools/entity-tools.ts` (graph traversal must respect validity windows)
- Test: `src/tools/entity-tools.bitemporal.test.ts` (new)

Borrowed from Zep/Graphiti: a relation has `valid_from` (when the fact became true) and `valid_to` (when it stopped being true, NULL = still true). Contradictions don't overwrite — they invalidate.

- [ ] **Step 1: Write the failing test**

Create `src/tools/entity-tools.bitemporal.test.ts`:
```typescript
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';

describe('bi-temporal entity_relations', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.transaction(() => {
      db.prepare(`INSERT INTO entities (id, type, name) VALUES (1, 'person', 'alice')`).run();
      db.prepare(`INSERT INTO entities (id, type, name) VALUES (2, 'project', 'phoenix')`).run();
    })();
  });
  afterEach(() => db.close());

  it('stores valid_from / valid_to', () => {
    db.prepare(`
      INSERT INTO entity_relations
        (source_id, target_id, relation_type, weight, valid_from, valid_to)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(1, 2, 'works_on', 1.0, '2026-01-01T00:00:00Z', null);
    const row = db.prepare(
      `SELECT valid_from, valid_to FROM entity_relations WHERE source_id = 1`
    ).get() as { valid_from: string; valid_to: string | null };
    expect(row.valid_from).toBe('2026-01-01T00:00:00Z');
    expect(row.valid_to).toBeNull();
  });

  it('invalidating a fact sets valid_to instead of deleting', () => {
    db.prepare(`
      INSERT INTO entity_relations
        (source_id, target_id, relation_type, valid_from, valid_to)
      VALUES (?, ?, ?, ?, ?)
    `).run(1, 2, 'works_on', '2026-01-01T00:00:00Z', null);

    db.prepare(`
      UPDATE entity_relations
      SET valid_to = ?
      WHERE source_id = 1 AND target_id = 2 AND relation_type = 'works_on' AND valid_to IS NULL
    `).run('2026-05-22T00:00:00Z');

    const open = db.prepare(
      `SELECT COUNT(*) AS n FROM entity_relations
       WHERE source_id = 1 AND target_id = 2 AND valid_to IS NULL`
    ).get() as { n: number };
    expect(open.n).toBe(0);

    const all = db.prepare(`SELECT COUNT(*) AS n FROM entity_relations`).get() as { n: number };
    expect(all.n).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/tools/entity-tools.bitemporal.test.ts -v
```
Expected: FAIL with `SQLITE_ERROR: table entity_relations has no column named valid_from`.

- [ ] **Step 3: Update schema**

In `src/db/schema.ts`, replace the `entityRelations` definition's column block with:
```typescript
export const entityRelations = sqliteTable(
  "entity_relations",
  {
    sourceId: integer("source_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    targetId: integer("target_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    relationType: text("relation_type").notNull(),
    weight: real("weight").default(1.0),
    metadataJson: text("metadata_json"),
    validFrom: text("valid_from").notNull().default(sql`CURRENT_TIMESTAMP`),
    validTo: text("valid_to"),
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_entity_rel_source").on(table.sourceId),
    index("idx_entity_rel_target").on(table.targetId),
    index("idx_entity_rel_valid_to").on(table.validTo),
  ]
);
```

- [ ] **Step 4: Add migration**

In `src/db/migrate.ts`, after the agent_feedback migration:
```typescript
{
  version: <NEXT_VERSION_NUMBER>,
  description: "Add bi-temporal columns to entity_relations",
  up: (db) => {
    db.transaction(() => {
      db.prepare(`ALTER TABLE entity_relations ADD COLUMN valid_from TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`).run();
      db.prepare(`ALTER TABLE entity_relations ADD COLUMN valid_to TEXT`).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_entity_rel_valid_to ON entity_relations(valid_to)`).run();
    })();
  },
}
```

- [ ] **Step 5: Update graph traversal in `entity-tools.ts`**

Open `src/tools/entity-tools.ts`. Find the SQL query that walks `entity_relations` (recursive CTE inside the `devlog_entity_graph` handler). Add a clause so traversal ignores closed facts:

```typescript
// Before:
//   JOIN entity_relations r ON r.source_id = w.entity_id
// After:
//   JOIN entity_relations r ON r.source_id = w.entity_id AND r.valid_to IS NULL
```

Also add an optional `as_of` input parameter to the tool's schema:
```typescript
as_of: z.string().datetime().optional().describe('ISO timestamp — traverse facts valid at this point in time. Defaults to now.'),
```
And use it in the SQL:
```typescript
const asOf = args.as_of ?? null;
// In SQL: AND (? IS NULL OR (r.valid_from <= ? AND (r.valid_to IS NULL OR r.valid_to > ?)))
// Bind asOf three times.
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
npx jest src/tools/entity-tools.bitemporal.test.ts src/tools/entity-tools.test.ts -v
```
Expected: all PASS. If any existing entity-tools.test.ts case breaks because of the new validity filter, fix that test to use `valid_to IS NULL` semantics rather than weakening the schema.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/migrate.ts src/tools/entity-tools.ts src/tools/entity-tools.bitemporal.test.ts src/tools/entity-tools.test.ts
git commit -m "feat(memory): bi-temporal entity_relations (valid_from/valid_to, Zep-style)"
```

---

## Task 5: Expose session recall (read path for `conversation_summaries`)

**Files:**
- Modify: `src/tools/workspace-tools.ts` (append a new tool to the exported array)
- Test: `src/tools/workspace-tools.recall.test.ts` (new)

`conversation_summaries` IS written/read by `compaction-service.ts` (lines 32, 66) but no MCP tool surfaces it. Add one.

- [ ] **Step 1: Write the failing test**

Create `src/tools/workspace-tools.recall.test.ts`:
```typescript
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { workspaceTools } from './workspace-tools.js';

describe('devlog_session_recall', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    (globalThis as any).__TEST_DB__ = db;
    db.prepare(`
      INSERT INTO sessions (id, started_at, status) VALUES ('s1', datetime('now','-2 days'), 'completed')
    `).run();
    db.prepare(`
      INSERT INTO conversation_summaries
        (session_id, ai_model, summary, message_count, token_count, started_at)
      VALUES ('s1', 'claude-opus-4-7', 'decided to use bi-temporal facts', 42, 3000, datetime('now','-2 days'))
    `).run();
  });
  afterEach(() => { db.close(); delete (globalThis as any).__TEST_DB__; });

  it('returns recent session summaries', async () => {
    const tool = workspaceTools.find((t) => t.name === 'devlog_session_recall');
    expect(tool).toBeDefined();
    const res = await tool!.handler({ limit: 5 });
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toMatch(/bi-temporal facts/);
    expect(text).toMatch(/claude-opus-4-7/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/tools/workspace-tools.recall.test.ts -v
```
Expected: FAIL — tool not found.

- [ ] **Step 3: Add the tool definition**

In `src/tools/workspace-tools.ts`, locate the exported `workspaceTools` array and append:
```typescript
{
  name: 'devlog_session_recall',
  title: 'Recall past sessions',
  description: 'Read conversation summaries from finished sessions (episodic memory).',
  inputSchema: {
    query: z.string().optional().describe('Substring to filter summaries.'),
    session_id: z.string().optional(),
    since: z.string().optional().describe('ISO timestamp lower bound.'),
    limit: z.number().int().positive().max(100).optional(),
  },
  handler: async (args) => {
    const a = args as { query?: string; session_id?: string; since?: string; limit?: number };
    const where: string[] = [];
    const params: unknown[] = [];
    if (a.query)      { where.push('summary LIKE ?');    params.push(`%${a.query}%`); }
    if (a.session_id) { where.push('session_id = ?');    params.push(a.session_id); }
    if (a.since)      { where.push('started_at >= ?');   params.push(a.since); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = db().prepare(`
      SELECT session_id, ai_model, summary, message_count, token_count, started_at, ended_at
      FROM conversation_summaries
      ${whereSql}
      ORDER BY started_at DESC
      LIMIT ?
    `).all(...params, a.limit ?? 10) as Array<Record<string, unknown>>;

    const text = rows.map((r) =>
      `[${r.started_at}] session=${r.session_id} model=${r.ai_model} msgs=${r.message_count}\n  ${r.summary}`
    ).join('\n\n') || '(no past sessions)';
    return { content: [{ type: 'text', text }] };
  },
},
```

If `workspace-tools.ts` doesn't already have a `db()` helper that respects `__TEST_DB__`, copy the pattern from `feedback-tools.ts` Task 3 Step 3.

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest src/tools/workspace-tools.recall.test.ts -v
npm run lint
```
Expected: PASS, lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/tools/workspace-tools.ts src/tools/workspace-tools.recall.test.ts
git commit -m "feat(memory): add devlog_session_recall (episodic memory read path)"
```

---

## Task 6: Drop dead schema

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/migrate.ts` (drop columns / tables migration)
- Modify: `src/db/schema.sql` (if it mirrors `schema.ts`)
- Test: `src/db/migrate.test.ts` (extend or create)

Only proceed if **Task 1 Step 1** printed `(no live refs)` for the table. Otherwise, treat that table like `conversation_summaries` (write a read tool first, then revisit).

- [ ] **Step 1: Write the failing test**

Add to (or create) `src/db/migrate.test.ts`:
```typescript
import Database from 'better-sqlite3';
import { runMigrations } from './migrate.js';

describe('migrations drop dead tables', () => {
  it('removes session_context, knowledge_links, sync_queue, daily_timeline, modifications, doc_assignments', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()
      .map((r) => (r as { name: string }).name);
    for (const dead of [
      'session_context','knowledge_links','sync_queue',
      'daily_timeline','modifications','doc_assignments',
    ]) {
      expect(tables).not.toContain(dead);
    }
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/db/migrate.test.ts -v
```
Expected: FAIL — table still present.

- [ ] **Step 3: Remove from `schema.ts`**

Delete these exports from `src/db/schema.ts`:
- `sessionContext`
- `knowledgeLinks`
- `syncQueue`
- `dailyTimeline`
- `modifications`
- `docAssignments`

Also remove their entries from the `relations(...)` blocks at the bottom (`docsRelations`, `usersRelations`, `sessionsRelations`).

- [ ] **Step 4: Add a drop migration**

In `src/db/migrate.ts`:
```typescript
{
  version: <NEXT_VERSION_NUMBER>,
  description: "Drop unused memory tables (session_context, knowledge_links, sync_queue, daily_timeline, modifications, doc_assignments)",
  up: (db) => {
    db.transaction(() => {
      for (const t of ['session_context','knowledge_links','sync_queue','daily_timeline','modifications','doc_assignments']) {
        db.prepare(`DROP TABLE IF EXISTS ${t}`).run();
      }
    })();
  },
}
```

If `schema.sql` is checked in and mirrors the Drizzle file, delete the corresponding `CREATE TABLE` blocks there too.

- [ ] **Step 5: Run tests + lint + full suite**

```bash
npx jest src/db/migrate.test.ts -v
npm run lint
npm test
```
Expected: all PASS. If any other test references the dead tables, decide: rewrite the test against an active table, or delete the test if the behaviour is gone.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/migrate.ts src/db/schema.sql src/db/migrate.test.ts
git commit -m "chore(memory): drop 6 unused schema tables (dead since project inception)"
```

---

## Task 7: Delete `simple-devlog-server.ts`

**Files:**
- Delete: `src/simple-devlog-server.ts`
- Modify: `src/tools/enhanced-compression-helper.ts` (kill the stale comment)

- [ ] **Step 1: Verify no live imports one more time**

```bash
grep -rn "from.*simple-devlog-server\|require.*simple-devlog-server" /Users/gravity/Documents/WORK/TACHIBOT_ALL/devlog-mcp/src /Users/gravity/Documents/WORK/TACHIBOT_ALL/devlog-mcp/bin /Users/gravity/Documents/WORK/TACHIBOT_ALL/devlog-mcp/package.json
```
Expected: no output. If anything appears, STOP and resolve that import first.

- [ ] **Step 2: Delete the file**

```bash
rm /Users/gravity/Documents/WORK/TACHIBOT_ALL/devlog-mcp/src/simple-devlog-server.ts
```

- [ ] **Step 3: Remove the stale comment**

Open `src/tools/enhanced-compression-helper.ts:31` and delete the line:
```typescript
// Import the existing analysis functions from simple-devlog-server
```

- [ ] **Step 4: Re-run lint, type-check, and tests**

```bash
npm run lint
npm run build:esm
npm test
```
Expected: clean build, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/simple-devlog-server.ts src/tools/enhanced-compression-helper.ts
git commit -m "chore: delete legacy simple-devlog-server.ts (3361 LOC, no live imports)"
```

---

## Task 8: Rewrite README.md around the memory taxonomy

**Files:**
- Modify: `README.md`

The current README lists tools as a flat grab-bag. Reorganise it so the top-level narrative is "this is an agent-memory store with five layers", then the tool tables hang off each layer.

- [ ] **Step 1: Read the current README**

```bash
wc -l /Users/gravity/Documents/WORK/TACHIBOT_ALL/devlog-mcp/README.md
```
Then read it in full (use the Read tool, not `cat`).

- [ ] **Step 2: Rewrite top-to-bottom**

Replace `README.md` with this structure (keep the project's existing Installation / Add-to-Claude / Ollama / Build sections verbatim — only the framing and the tool-listing section change):

```markdown
# devlog-mcp — Agent Memory for Claude Code & friends

A multi-layer **agent memory** MCP server. Persists what your agent does, what it knows, and how well it works — across sessions, models, and projects.

> Built on Anthropic's MCP TypeScript SDK. Storage: SQLite (Drizzle ORM) + LanceDB vectors + a small file-backed workspace.

## Why this exists

LLM agents forget every session. Most "memory" plugins are one undifferentiated vector store. `devlog-mcp` instead separates memory by **function** — borrowing the CoALA-inspired taxonomy used by Letta, Zep, Mem0, and Cognee — so the agent can ask the right layer the right question.

## The five memory layers

| Layer | What it remembers | Where it lives | MCP tools |
|---|---|---|---|
| **Working** | Current task, locks, open questions | `.devlog/.mcp/current-workspace.md` + `sessions(status='active')` + `questions.json` | `devlog_workspace_claim`, `devlog_workspace_dump`, `devlog_workspace_status`, `devlog_session_log`, `devlog_question_*` |
| **Episodic** | Past sessions, time entries, conversation summaries | `sessions`, `time_entries`, `conversation_summaries` | `devlog_session_recall`, `devlog_session_log` |
| **Semantic** | Facts, entities, relations, tags, doc vectors | `entities`, `entity_relations` (bi-temporal), `doc_entities`, `tags`, `doc_tags`, `docs`, LanceDB `doc_vectors` + `chunks` | `devlog_entity_graph`, `devlog_entity_extract_deep`, `search_universal` |
| **Procedural** | Plans, workflows, checklists | `docs(doc_type='plan')` + plan JSON files | `devlog_plan_create`, `devlog_plan_check`, `devlog_plan_validate`, `devlog_plan_status`, `devlog_plan_list`, `devlog_plan_blocker` |
| **Affective** | Per-tool/per-agent success, failure, latency, confidence | `agent_feedback` | `devlog_feedback_record`, `devlog_feedback_query` |

### What's special

- **Bi-temporal facts** (Zep-style): every `entity_relations` row has `valid_from` / `valid_to`. Contradictions don't overwrite — they close a window and open a new one. Query graph "as of" any timestamp.
- **Hybrid search**: SQLite FTS5 + LanceDB vectors merged via Reciprocal Rank Fusion.
- **Affective layer**: among the popular OSS memory libs (Mem0, Letta, Zep, Cognee, LangMem), devlog-mcp is the only one to natively track per-tool success/failure history. Use it to bias model routing.
- **Optional, local LLM**: Ollama (`nomic-embed-text` + `llama3.2`) for embeddings + deep entity extraction. Server works without it — falls back to regex extraction.

## Quick start

(keep the existing Installation / Add-to-Claude / Ollama sections verbatim)

## Architecture at a glance

```
+------------ working -------------+    +--------- affective -----------+
| workspace.md | sessions(active)  |    | agent_feedback                |
+----------------------------------+    +-------------------------------+
+---- episodic ----+  +------ semantic ------+  +---- procedural ----+
| sessions | time_ |  | entities | relations |  | docs(plan)         |
| entries  | conv_ |  | doc_vectors (Lance)  |  | plans/*.json       |
| summaries|       |  | tags | doc_entities  |  |                    |
+------------------+  +----------------------+  +--------------------+
                            up
                       Drizzle / SQLite
```

## Tools (full list)

(reorder the per-section tool tables from the previous README so they sit under the five memory-layer headings above instead of under "Workspace Management", "Question Tracking", etc.)

## Integration with `tachibot-mcp`

`devlog-mcp` is the memory backend for `tachibot-mcp` (multi-model orchestrator). Bridge tools (`bridge_index_research`, `bridge_import_plan`, `bridge_get_context`) connect tachibot's reasoning outputs into devlog's semantic layer. See `docs/superpowers/plans/2026-05-22-tachibot-as-orchestrator.md` for the full integration design.

## Differences from neighbouring projects

| Project | Architecture | Native temporal | Native affective |
|---|---|---|---|
| **devlog-mcp** | SQLite + LanceDB + entity graph | yes (bi-temporal relations) | yes (`agent_feedback`) |
| Mem0 | Vector + optional graph | no | no |
| Letta (MemGPT) | Tiered OS-like, self-editing | via metadata | via metadata |
| Zep / Graphiti | Temporal knowledge graph | yes (bi-temporal) | no |
| Cognee | Graph + vector poly-store | partial | no |
| LangMem | Modular over LangGraph | no | no |

## Development

(keep existing build/test/lint sections verbatim)
```

- [ ] **Step 3: Sanity-check the README**

```bash
# Make sure every tool name mentioned actually exists in the codebase
for t in devlog_workspace_claim devlog_workspace_dump devlog_workspace_status devlog_session_log devlog_session_recall devlog_question_add devlog_question_answer devlog_question_list devlog_question_check devlog_entity_graph devlog_entity_extract_deep devlog_plan_create devlog_plan_check devlog_plan_validate devlog_plan_status devlog_plan_list devlog_plan_blocker devlog_feedback_record devlog_feedback_query; do
  grep -rq "name: '$t'" /Users/gravity/Documents/WORK/TACHIBOT_ALL/devlog-mcp/src/tools && echo "ok $t" || echo "MISSING $t";
done
```
Expected: every name marked `ok`. Any `MISSING` means the README is lying — fix the README, not the codebase, unless you skipped a previous task.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README around five-memory-layer taxonomy"
```

---

## Task 9: End-to-end verification

- [ ] **Step 1: Fresh build**

```bash
cd /Users/gravity/Documents/WORK/TACHIBOT_ALL/devlog-mcp
rm -rf dist
npm run build
```
Expected: exits 0, `dist/esm/servers/core-server.js` present.

- [ ] **Step 2: Full test suite**

```bash
npm test
```
Expected: 0 failures.

- [ ] **Step 3: Lint**

```bash
npm run lint
```
Expected: clean.

- [ ] **Step 4: Manual smoke test against the core server**

In a scratch directory, launch the core server and round-trip the new tools via an MCP test harness (MCP inspector, or a tiny stdio client). Call `devlog_feedback_record` then `devlog_feedback_query`, then `devlog_session_recall`, then `devlog_entity_graph` with and without `as_of`. Expected: each tool returns a non-error result. Feedback round-trip persists. Session recall returns `(no past sessions)` on an empty DB. Entity graph runs without erroring on the new `valid_to` filter.

- [ ] **Step 5: Final commit (if anything was tweaked during smoke test)**

```bash
git status
# only commit if files changed
```

---

## Kill-list confirmed (Task 1 — fill in after running Task 1)

Verified on 2026-05-22 in worktree `worktree-memory-layer-upgrade`.

### Safe to drop (Task 6)
- `session_context` — refs found: 0 (schema only)
- `knowledge_links` — refs found: 0 (schema only)
- `sync_queue` — refs found: 0 (schema only)
- `daily_timeline` — refs found: 0 (schema only)
- `modifications` — refs found: 1 (HTML comment in devlog-http-server.ts:232, not a live reference)
- `doc_assignments` — refs found: 0 (schema only)

### NOT safe to drop (keep in Task 6 — move to follow-up if needed)
- (none — all suspected-dead tables confirmed as dead)

### Safe to delete (Task 7)
- `src/simple-devlog-server.ts` — stale comment reference only in `src/tools/enhanced-compression-helper.ts:31`. Legacy test script `test-mcp.sh` and config script `update-claude-config.sh` reference it but are not invoked by package.json or any active code path. No actual imports.

### Surprises / follow-ups
- None. All assumptions from the one-pass audit were confirmed. Legacy scripts exist but are inert.
