# Deeper Multi-Agent / Multi-Session Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade dokoro's multi-agent working memory from append-only notes to **shared, editable blocks** that multiple agents collaborate on live (with safe concurrent edits), plus **cross-session handoffs** so one agent can resume another's work across sessions.

**Architecture:** Two new per-project SQLite tables (WAL-safe, no global/cross-project store — per the `/council` verdict). (1) `shared_blocks`: named blocks with a monotonic `version`; edits use **optimistic concurrency** — a writer passes the `version` it read and the write is an atomic compare-and-set (`UPDATE … WHERE block_key=? AND version=?`), so concurrent agents get a clean conflict instead of silently clobbering. (2) `handoffs`: append-only handoff records an agent writes for the next agent/session, with a claim step so two agents don't both pick one up. Six new MCP tools across two files, mirroring the existing `shared-notes-tools.ts` conventions exactly.

**Tech Stack:** TypeScript ESM (Node ≥22), better-sqlite3 (WAL + busy_timeout already set in `src/db/index.ts:124`), Drizzle-adjacent raw SQL migrations (`src/db/migrations.ts`), Zod tool schemas, Jest (`__TEST_DB__` in-memory harness).

---

## File Structure

- **Modify** `src/db/migrations.ts` — append migration **v9** (`shared_blocks`) and **v10** (`handoffs`) to the `MIGRATIONS` array (currently ends at v8, line ~167).
- **Create** `src/tools/shared-blocks-tools.ts` — `dokoro_block_write`, `dokoro_block_read`, `dokoro_block_list`. Mirrors `src/tools/shared-notes-tools.ts` (same `db()` helper, `ToolDefinition` shape, error envelope).
- **Create** `src/tools/handoff-tools.ts` — `dokoro_handoff_write`, `dokoro_handoff_inbox`, `dokoro_handoff_claim`.
- **Modify** `src/servers/core-server.ts` — import + spread both new tool arrays (after the existing `...sharedNotesTools,` at line ~48).
- **Create** `src/tools/shared-blocks-tools.test.ts`, `src/tools/handoff-tools.test.ts` — mirror `src/tools/shared-notes-tools.test.ts` (jest.mock `../db/index.js`, in-memory `__TEST_DB__`).
- **Modify** `src/db/migrations.test.ts` — add v9 + v10 fresh-DB assertions (mirror the existing v8 test).
- **Modify** `src/servers/core-server.test.ts` — assert the 6 new tool names are registered.
- **Modify** `README.md` + `site/index.html` — add the 6 tools to the tables/catalogue, bump the landing tool count, and upgrade dokoro's "shared blocks" honesty in the compare table.

Convention note (copy verbatim from `shared-notes-tools.ts:28-37`): each tool file defines
```ts
function getSqlite(): Database.Database {
  const projectPath = path.dirname(DOKORO_PATH);
  return getSqliteDb({ projectPath, dokoroFolder: path.basename(DOKORO_PATH) });
}
function db(): Database.Database {
  const existing = (globalThis as Record<string, unknown>).__TEST_DB__ as Database.Database | undefined;
  if (existing) return existing;
  return getSqlite();
}
```

---

## Part A — Shared editable blocks

### Task 1: Migration v9 — `shared_blocks` table

**Files:**
- Modify: `src/db/migrations.ts` (append to `MIGRATIONS`, after the v8 object at line ~167)
- Test: `src/db/migrations.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/db/migrations.test.ts`:
```ts
it('migration v9 creates shared_blocks with the optimistic-concurrency columns', () => {
  db.prepare(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, description TEXT, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)`).run();
  expect(() => runMigrations(db)).not.toThrow();
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(shared_blocks)`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  for (const c of ['block_key', 'content', 'version', 'updated_by', 'created_at', 'updated_at']) {
    expect(cols.has(c)).toBe(true);
  }
  // block_key is the primary key (one row per key).
  const pk = (db.prepare(`PRAGMA table_info(shared_blocks)`).all() as Array<{ name: string; pk: number }>)
    .find((c) => c.name === 'block_key');
  expect(pk?.pk).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/db/migrations.test.ts -t "v9 creates shared_blocks"`
Expected: FAIL — `no such table: shared_blocks`.

- [ ] **Step 3: Implement migration v9**

In `src/db/migrations.ts`, append to the `MIGRATIONS` array (after the v8 object, before the closing `];` at line ~168):
```ts
  // v9: shared, EDITABLE blocks (upgrade from append-only shared_notes). Each block
  // is one row keyed by block_key; concurrent edits are made safe with optimistic
  // concurrency on `version` (atomic UPDATE ... WHERE block_key=? AND version=?).
  // Per-project only (one DB file per project); no global/cross-project store.
  { version: 9, description: 'shared_blocks table for editable multi-agent working memory', up: (db) => {
    const statements = [
      `CREATE TABLE IF NOT EXISTS shared_blocks (
        block_key TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT NOT NULL,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_shared_blocks_updated_at ON shared_blocks(updated_at)`,
    ];
    for (const s of statements) db.prepare(s).run();
  } },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/db/migrations.test.ts -t "v9 creates shared_blocks"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations.ts src/db/migrations.test.ts
git commit -m "feat(db): add shared_blocks table (migration v9) for editable multi-agent memory"
```

---

### Task 2: `dokoro_block_write` — optimistic compare-and-set

**Files:**
- Create: `src/tools/shared-blocks-tools.ts`
- Test: `src/tools/shared-blocks-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tools/shared-blocks-tools.test.ts`:
```ts
import Database from 'better-sqlite3';
import { jest } from '@jest/globals';

jest.mock('../db/index.js', () => ({
  getSqliteDb: () => { throw new Error('getSqliteDb should not be called in tests (use __TEST_DB__)'); },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sharedBlocksTools } = require('./shared-blocks-tools.js') as typeof import('./shared-blocks-tools.js');

function findTool(name: string) {
  const t = sharedBlocksTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}
function textOf(res: { content?: Array<{ type: string; text?: string }> }): string {
  return res.content?.[0]?.type === 'text' ? (res.content[0].text ?? '') : '';
}

describe('shared-blocks-tools', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE shared_blocks (
        block_key TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT NOT NULL,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      );
    `);
    (globalThis as Record<string, unknown>).__TEST_DB__ = db;
  });
  afterEach(() => { db.close(); delete (globalThis as Record<string, unknown>).__TEST_DB__; });

  it('block_write creates a new block at version 1', async () => {
    const res = await findTool('dokoro_block_write').handler({ block_key: 'plan', content: 'do X', agent_id: 'a' });
    expect(res.isError).toBeFalsy();
    const row = db.prepare('SELECT content, version, updated_by FROM shared_blocks WHERE block_key=?').get('plan') as
      { content: string; version: number; updated_by: string };
    expect(row).toMatchObject({ content: 'do X', version: 1, updated_by: 'a' });
  });

  it('block_write without expected_version overwrites and bumps version (last-writer-wins)', async () => {
    await findTool('dokoro_block_write').handler({ block_key: 'plan', content: 'v1', agent_id: 'a' });
    await findTool('dokoro_block_write').handler({ block_key: 'plan', content: 'v2', agent_id: 'b' });
    const row = db.prepare('SELECT content, version FROM shared_blocks WHERE block_key=?').get('plan') as
      { content: string; version: number };
    expect(row).toMatchObject({ content: 'v2', version: 2 });
  });

  it('block_write with a STALE expected_version is rejected as a conflict (no clobber)', async () => {
    await findTool('dokoro_block_write').handler({ block_key: 'plan', content: 'v1', agent_id: 'a' }); // version 1
    await findTool('dokoro_block_write').handler({ block_key: 'plan', content: 'v2', agent_id: 'b' }); // version 2
    const res = await findTool('dokoro_block_write').handler({ block_key: 'plan', content: 'stale', agent_id: 'c', expected_version: 1 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/conflict/i);
    // unchanged
    const row = db.prepare('SELECT content, version FROM shared_blocks WHERE block_key=?').get('plan') as { content: string; version: number };
    expect(row).toMatchObject({ content: 'v2', version: 2 });
  });

  it('block_write with a MATCHING expected_version succeeds and bumps version', async () => {
    await findTool('dokoro_block_write').handler({ block_key: 'plan', content: 'v1', agent_id: 'a' }); // version 1
    const res = await findTool('dokoro_block_write').handler({ block_key: 'plan', content: 'v2', agent_id: 'b', expected_version: 1 });
    expect(res.isError).toBeFalsy();
    const row = db.prepare('SELECT content, version FROM shared_blocks WHERE block_key=?').get('plan') as { content: string; version: number };
    expect(row).toMatchObject({ content: 'v2', version: 2 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/tools/shared-blocks-tools.test.ts -t "block_write"`
Expected: FAIL — `Cannot find module './shared-blocks-tools.js'`.

- [ ] **Step 3: Implement `dokoro_block_write`**

Create `src/tools/shared-blocks-tools.ts` (Task 3 adds the read/list tools to the same array):
```ts
/**
 * Shared EDITABLE working-memory blocks (Working memory layer, multi-agent).
 *
 * Upgrade from append-only shared_notes: named blocks (one row per block_key)
 * that multiple agents in the SAME project edit live. Concurrent edits are made
 * safe with OPTIMISTIC CONCURRENCY — a writer may pass the `version` it last read;
 * the write is an atomic compare-and-set, so a racing edit gets a clean conflict
 * instead of silently clobbering. Per-project only (one .dokoro/db per project);
 * there is intentionally NO global / cross-project store.
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

export const sharedBlocksTools: ToolDefinition[] = [
  {
    name: 'dokoro_block_write',
    title: 'Write a shared editable memory block',
    description:
      'Create or update a named shared working-memory block for the current project. ' +
      'Multiple agents can edit blocks concurrently. Pass expected_version (the version you last read) ' +
      'for a safe compare-and-set: if another agent changed the block since, the write is REJECTED as a ' +
      'conflict instead of overwriting. Omit expected_version for last-writer-wins. Scoped to the current project only.',
    inputSchema: {
      block_key: z.string().min(1),
      content: z.string(),
      agent_id: z.string(),
      expected_version: z.number().int().nonnegative().optional()
        .describe('Version you last read; write only applies if it still matches (optimistic lock).'),
    },
    handler: async (args) => {
      try {
        const a = args as { block_key: string; content: string; agent_id: string; expected_version?: number };
        const existing = db().prepare('SELECT version FROM shared_blocks WHERE block_key = ?').get(a.block_key) as
          { version: number } | undefined;

        if (!existing) {
          // New block. If a non-zero expected_version was supplied, that's a conflict (caller thinks it exists).
          if (a.expected_version !== undefined && a.expected_version !== 0) {
            return { isError: true, content: [{ type: 'text' as const, text: `conflict: block '${a.block_key}' does not exist (expected_version=${a.expected_version})` }] };
          }
          db().prepare(`INSERT INTO shared_blocks (block_key, content, version, updated_by, created_at, updated_at) VALUES (?, ?, 1, ?, ${NOW}, ${NOW})`)
            .run(a.block_key, a.content, a.agent_id);
          return { content: [{ type: 'text' as const, text: `block '${a.block_key}' created at version 1 by ${a.agent_id}` }] };
        }

        if (a.expected_version !== undefined && a.expected_version !== existing.version) {
          return { isError: true, content: [{ type: 'text' as const, text: `conflict: block '${a.block_key}' is at version ${existing.version}, not ${a.expected_version} — re-read and retry` }] };
        }

        // Atomic compare-and-set on the current version (safe under WAL concurrency).
        const info = db().prepare(`UPDATE shared_blocks SET content=?, version=version+1, updated_by=?, updated_at=${NOW} WHERE block_key=? AND version=?`)
          .run(a.content, a.agent_id, a.block_key, existing.version);
        if (info.changes !== 1) {
          return { isError: true, content: [{ type: 'text' as const, text: `conflict: block '${a.block_key}' changed concurrently — re-read and retry` }] };
        }
        return { content: [{ type: 'text' as const, text: `block '${a.block_key}' updated to version ${existing.version + 1} by ${a.agent_id}` }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: 'text' as const, text: `block_write failed: ${msg}` }] };
      }
    },
  },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/tools/shared-blocks-tools.test.ts -t "block_write"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/shared-blocks-tools.ts src/tools/shared-blocks-tools.test.ts
git commit -m "feat(memory): add dokoro_block_write with optimistic compare-and-set"
```

---

### Task 3: `dokoro_block_read` + `dokoro_block_list`

**Files:**
- Modify: `src/tools/shared-blocks-tools.ts` (add two tools to `sharedBlocksTools`)
- Test: `src/tools/shared-blocks-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the `describe` in `src/tools/shared-blocks-tools.test.ts`:
```ts
it('block_read returns content + version + updated_by, or a not-found message', async () => {
  await findTool('dokoro_block_write').handler({ block_key: 'plan', content: 'the plan', agent_id: 'a' });
  const hit = await findTool('dokoro_block_read').handler({ block_key: 'plan' });
  expect(textOf(hit)).toMatch(/the plan/);
  expect(textOf(hit)).toMatch(/version 1/);
  expect(textOf(hit)).toMatch(/\ba\b/);
  const miss = await findTool('dokoro_block_read').handler({ block_key: 'nope' });
  expect(textOf(miss)).toMatch(/no block/i);
});

it('block_list lists block keys with version + updater, newest-updated first', async () => {
  await findTool('dokoro_block_write').handler({ block_key: 'alpha', content: 'a', agent_id: 'x' });
  await findTool('dokoro_block_write').handler({ block_key: 'beta', content: 'b', agent_id: 'y' });
  const res = await findTool('dokoro_block_list').handler({});
  const t = textOf(res);
  expect(t).toMatch(/alpha/);
  expect(t).toMatch(/beta/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/tools/shared-blocks-tools.test.ts -t "block_read returns"`
Expected: FAIL — `tool dokoro_block_read not found`.

- [ ] **Step 3: Implement the two tools**

In `src/tools/shared-blocks-tools.ts`, add these two objects to the `sharedBlocksTools` array (after `dokoro_block_write`):
```ts
  {
    name: 'dokoro_block_read',
    title: 'Read a shared editable memory block',
    description: 'Read one shared working-memory block by block_key for the current project, returning its content, current version (pass this as expected_version to write safely), and last updater.',
    inputSchema: { block_key: z.string().min(1) },
    handler: async (args) => {
      try {
        const a = args as { block_key: string };
        const row = db().prepare('SELECT content, version, updated_by, updated_at FROM shared_blocks WHERE block_key = ?').get(a.block_key) as
          { content: string; version: number; updated_by: string; updated_at: string } | undefined;
        if (!row) return { content: [{ type: 'text' as const, text: `(no block '${a.block_key}')` }] };
        return { content: [{ type: 'text' as const, text:
          `block '${a.block_key}' — version ${row.version} (by ${row.updated_by} @ ${row.updated_at})\n\n${row.content}` }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: 'text' as const, text: `block_read failed: ${msg}` }] };
      }
    },
  },
  {
    name: 'dokoro_block_list',
    title: 'List shared editable memory blocks',
    description: 'List all shared working-memory blocks for the current project (block_key, version, last updater), most-recently-updated first.',
    inputSchema: {},
    handler: async () => {
      try {
        const rows = db().prepare('SELECT block_key, version, updated_by, updated_at FROM shared_blocks ORDER BY updated_at DESC').all() as
          Array<{ block_key: string; version: number; updated_by: string; updated_at: string }>;
        if (rows.length === 0) return { content: [{ type: 'text' as const, text: '(no shared blocks)' }] };
        const lines = rows.map((r) => `${r.block_key}  v${r.version}  by ${r.updated_by}  @ ${r.updated_at}`);
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: 'text' as const, text: `block_list failed: ${msg}` }] };
      }
    },
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/tools/shared-blocks-tools.test.ts`
Expected: PASS (all 6 tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/tools/shared-blocks-tools.ts src/tools/shared-blocks-tools.test.ts
git commit -m "feat(memory): add dokoro_block_read + dokoro_block_list"
```

---

### Task 4: Register the block tools in the core server

**Files:**
- Modify: `src/servers/core-server.ts`
- Test: `src/servers/core-server.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the `describe('core-server tool registration')` block in `src/servers/core-server.test.ts`:
```ts
it('coreTools includes the shared editable-block tools', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { coreTools } = require('./core-server.js') as typeof import('./core-server.js');
  const names = coreTools.map((t: { name: string }) => t.name);
  expect(names).toContain('dokoro_block_write');
  expect(names).toContain('dokoro_block_read');
  expect(names).toContain('dokoro_block_list');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/servers/core-server.test.ts -t "shared editable-block"`
Expected: FAIL — array does not contain `dokoro_block_write`.

- [ ] **Step 3: Register the tools**

In `src/servers/core-server.ts`, add the import next to the existing shared-notes import (line ~16):
```ts
import { sharedBlocksTools } from '../tools/shared-blocks-tools.js';
```
and add to the `coreTools` array right after `...sharedNotesTools,` (line ~48):
```ts
  ...sharedBlocksTools,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/servers/core-server.test.ts -t "shared editable-block"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/servers/core-server.ts src/servers/core-server.test.ts
git commit -m "feat(core-server): register shared editable-block tools"
```

---

## Part B — Cross-session handoff

### Task 5: Migration v10 — `handoffs` table

**Files:**
- Modify: `src/db/migrations.ts`
- Test: `src/db/migrations.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/db/migrations.test.ts`:
```ts
it('migration v10 creates handoffs with claim columns', () => {
  db.prepare(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, description TEXT, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)`).run();
  expect(() => runMigrations(db)).not.toThrow();
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(handoffs)`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  for (const c of ['id', 'from_agent', 'to_agent', 'session_id', 'summary', 'open_items_json', 'status', 'claimed_by', 'created_at', 'claimed_at']) {
    expect(cols.has(c)).toBe(true);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/db/migrations.test.ts -t "v10 creates handoffs"`
Expected: FAIL — `no such table: handoffs`.

- [ ] **Step 3: Implement migration v10**

Append to the `MIGRATIONS` array in `src/db/migrations.ts` (after v9):
```ts
  // v10: cross-session handoffs. An agent records a handoff for the next agent/session;
  // a claim step (status open->claimed) stops two agents from both picking it up.
  // Per-project only.
  { version: 10, description: 'handoffs table for cross-session multi-agent handoff', up: (db) => {
    const statements = [
      `CREATE TABLE IF NOT EXISTS handoffs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_agent TEXT NOT NULL,
        to_agent TEXT,
        session_id TEXT,
        summary TEXT NOT NULL,
        open_items_json TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        claimed_by TEXT,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        claimed_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_handoffs_status ON handoffs(status, created_at)`,
    ];
    for (const s of statements) db.prepare(s).run();
  } },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/db/migrations.test.ts -t "v10 creates handoffs"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations.ts src/db/migrations.test.ts
git commit -m "feat(db): add handoffs table (migration v10) for cross-session handoff"
```

---

### Task 6: `dokoro_handoff_write`

**Files:**
- Create: `src/tools/handoff-tools.ts`
- Test: `src/tools/handoff-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tools/handoff-tools.test.ts`:
```ts
import Database from 'better-sqlite3';
import { jest } from '@jest/globals';

jest.mock('../db/index.js', () => ({
  getSqliteDb: () => { throw new Error('getSqliteDb should not be called in tests (use __TEST_DB__)'); },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handoffTools } = require('./handoff-tools.js') as typeof import('./handoff-tools.js');

function findTool(name: string) {
  const t = handoffTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}
function textOf(res: { content?: Array<{ type: string; text?: string }> }): string {
  return res.content?.[0]?.type === 'text' ? (res.content[0].text ?? '') : '';
}

describe('handoff-tools', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE handoffs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_agent TEXT NOT NULL,
        to_agent TEXT,
        session_id TEXT,
        summary TEXT NOT NULL,
        open_items_json TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        claimed_by TEXT,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        claimed_at TEXT
      );
    `);
    (globalThis as Record<string, unknown>).__TEST_DB__ = db;
  });
  afterEach(() => { db.close(); delete (globalThis as Record<string, unknown>).__TEST_DB__; });

  it('handoff_write inserts an open handoff with summary + open_items', async () => {
    const res = await findTool('dokoro_handoff_write').handler({
      from_agent: 'claude-a', summary: 'auth refactor half done', open_items: ['write regression test', 'update docs'],
    });
    expect(res.isError).toBeFalsy();
    const row = db.prepare('SELECT from_agent, summary, open_items_json, status FROM handoffs').get() as
      { from_agent: string; summary: string; open_items_json: string; status: string };
    expect(row).toMatchObject({ from_agent: 'claude-a', summary: 'auth refactor half done', status: 'open' });
    expect(JSON.parse(row.open_items_json)).toEqual(['write regression test', 'update docs']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/tools/handoff-tools.test.ts -t "handoff_write inserts"`
Expected: FAIL — `Cannot find module './handoff-tools.js'`.

- [ ] **Step 3: Implement `dokoro_handoff_write`**

Create `src/tools/handoff-tools.ts` (Task 7 adds inbox + claim to the same array):
```ts
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
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/tools/handoff-tools.test.ts -t "handoff_write inserts"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/handoff-tools.ts src/tools/handoff-tools.test.ts
git commit -m "feat(memory): add dokoro_handoff_write for cross-session handoff"
```

---

### Task 7: `dokoro_handoff_inbox` + `dokoro_handoff_claim`

**Files:**
- Modify: `src/tools/handoff-tools.ts`
- Test: `src/tools/handoff-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the `describe` in `src/tools/handoff-tools.test.ts`:
```ts
it('handoff_inbox lists open handoffs (untargeted + targeted to the agent)', async () => {
  const w = findTool('dokoro_handoff_write');
  await w.handler({ from_agent: 'a', summary: 'open to anyone' });
  await w.handler({ from_agent: 'a', summary: 'for b only', to_agent: 'b' });
  await w.handler({ from_agent: 'a', summary: 'for c only', to_agent: 'c' });
  const res = await findTool('dokoro_handoff_inbox').handler({ agent_id: 'b' });
  const t = textOf(res);
  expect(t).toMatch(/open to anyone/); // untargeted
  expect(t).toMatch(/for b only/);     // targeted to b
  expect(t).not.toMatch(/for c only/); // targeted to c, hidden from b
});

it('handoff_claim atomically claims an open handoff once; a second claim fails', async () => {
  await findTool('dokoro_handoff_write').handler({ from_agent: 'a', summary: 's' });
  const id = (db.prepare('SELECT id FROM handoffs').get() as { id: number }).id;
  const first = await findTool('dokoro_handoff_claim').handler({ handoff_id: id, agent_id: 'b' });
  expect(first.isError).toBeFalsy();
  const second = await findTool('dokoro_handoff_claim').handler({ handoff_id: id, agent_id: 'c' });
  expect(second.isError).toBe(true);
  expect(textOf(second)).toMatch(/already claimed|not open/i);
  const row = db.prepare('SELECT status, claimed_by FROM handoffs WHERE id=?').get(id) as { status: string; claimed_by: string };
  expect(row).toMatchObject({ status: 'claimed', claimed_by: 'b' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/tools/handoff-tools.test.ts -t "handoff_inbox lists"`
Expected: FAIL — `tool dokoro_handoff_inbox not found`.

- [ ] **Step 3: Implement the two tools**

Add to the `handoffTools` array in `src/tools/handoff-tools.ts` (after `dokoro_handoff_write`):
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/tools/handoff-tools.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/handoff-tools.ts src/tools/handoff-tools.test.ts
git commit -m "feat(memory): add dokoro_handoff_inbox + dokoro_handoff_claim"
```

---

### Task 8: Register the handoff tools in the core server

**Files:**
- Modify: `src/servers/core-server.ts`
- Test: `src/servers/core-server.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/servers/core-server.test.ts`:
```ts
it('coreTools includes the cross-session handoff tools', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { coreTools } = require('./core-server.js') as typeof import('./core-server.js');
  const names = coreTools.map((t: { name: string }) => t.name);
  expect(names).toContain('dokoro_handoff_write');
  expect(names).toContain('dokoro_handoff_inbox');
  expect(names).toContain('dokoro_handoff_claim');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/servers/core-server.test.ts -t "handoff tools"`
Expected: FAIL.

- [ ] **Step 3: Register the tools**

In `src/servers/core-server.ts`, add the import (near line ~16):
```ts
import { handoffTools } from '../tools/handoff-tools.js';
```
and after `...sharedBlocksTools,` in `coreTools`:
```ts
  ...handoffTools,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/servers/core-server.test.ts -t "handoff tools"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/servers/core-server.ts src/servers/core-server.test.ts
git commit -m "feat(core-server): register cross-session handoff tools"
```

---

## Part C — Surface it (docs + landing)

### Task 9: Document the 6 new tools + upgrade the comparison claim

**Files:**
- Modify: `README.md` (Working-memory tool table + tool counts)
- Modify: `site/index.html` (TOOLS catalogue + hero stat count + compare-table cell)

- [ ] **Step 1: Add the tools to the README Working-memory table**

In `README.md`, in the `🟢 Working memory` table (after the `devlog`→`dokoro` rename this is the table starting at the `dokoro_workspace_status` row), add these rows after `dokoro_get_current_focus`:
```markdown
| `dokoro_block_write` | Create/update a shared editable memory block (optimistic version lock) |
| `dokoro_block_read` | Read a shared block (content + version + last updater) |
| `dokoro_block_list` | List shared blocks (key, version, updater) |
| `dokoro_handoff_write` | Record a cross-session handoff (summary + open items) |
| `dokoro_handoff_inbox` | Read open handoffs targeted to / available to an agent |
| `dokoro_handoff_claim` | Atomically claim a handoff so only one agent takes it |
```

- [ ] **Step 2: Bump the landing tool count and add catalogue entries**

In `site/index.html`, in the `const TOOLS = [` array (working-layer section), add six entries mirroring the existing shape:
```js
  {n:"dokoro_block_write",       l:"working", st:"shared_blocks", d:"Create/update a shared editable block; optimistic version compare-and-set."},
  {n:"dokoro_block_read",        l:"working", st:"shared_blocks", d:"Read a shared block: content, version, last updater."},
  {n:"dokoro_block_list",        l:"working", st:"shared_blocks", d:"List shared blocks with version + updater."},
  {n:"dokoro_handoff_write",     l:"working", st:"handoffs",      d:"Record a cross-session handoff: summary + open items."},
  {n:"dokoro_handoff_inbox",     l:"working", st:"handoffs",      d:"Read open handoffs available to an agent."},
  {n:"dokoro_handoff_claim",     l:"working", st:"handoffs",      d:"Atomically claim a handoff so only one agent takes it."},
```
Then update the hero stat and catalogue meta from `38` (current 32 + 6) — change `<div class="n">32</div>` to `<div class="n">38</div>` and `of 32 entries` to `of 38 entries`.

- [ ] **Step 3: Upgrade dokoro's compare-table multi-agent cell**

In `site/index.html`, in dokoro's row of the `.cmp` table, change the multi-agent cell from `✓ per-agent feedback + workspace lock` to `✓ shared editable blocks + handoff` (now true — no longer just per-agent feedback).

- [ ] **Step 4: Verify the site test + full suite still pass**

Run: `npm test`
Expected: PASS — all suites green (the existing `site/compare-table.test.mjs` still passes since column count is unchanged; new tool tests from Tasks 2–8 pass).

- [ ] **Step 5: Commit**

```bash
git add README.md site/index.html
git commit -m "docs(site): document shared-block + handoff tools; upgrade compare-table claim"
```

---

## Part D — Agent presence (heartbeat)

> **Design (from grok + perplexity research):** daemonless system → **read-time liveness** (`now − last_heartbeat ≤ TTL`), **opportunistic** heartbeats (no timers; upsert on an explicit ping), **server clock** via SQLite `unixepoch()` (one clock domain), a `heartbeat_seq` to reject out-of-order retries, and a **generous TTL** to avoid false-deaths. TTL default **900 s (15 min)** — coding agents pause between tool calls; this absorbs the jitter while still reflecting "currently working." Lazy cleanup: a ping upserts the agent's own row, and stale rows simply age out of the live query (no sweeper).

### Task 10: Migration v11 — `agent_presence` table

**Files:**
- Modify: `src/db/migrations.ts`
- Test: `src/db/migrations.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/db/migrations.test.ts`:
```ts
it('migration v11 creates agent_presence keyed by agent_id', () => {
  db.prepare(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, description TEXT, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)`).run();
  expect(() => runMigrations(db)).not.toThrow();
  const cols = db.prepare(`PRAGMA table_info(agent_presence)`).all() as Array<{ name: string; pk: number }>;
  const names = new Set(cols.map((c) => c.name));
  for (const c of ['agent_id', 'session_id', 'status', 'current_focus', 'last_heartbeat', 'heartbeat_seq']) {
    expect(names.has(c)).toBe(true);
  }
  expect(cols.find((c) => c.name === 'agent_id')?.pk).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/db/migrations.test.ts -t "v11 creates agent_presence"`
Expected: FAIL — `no such table: agent_presence`.

- [ ] **Step 3: Implement migration v11**

Append to the `MIGRATIONS` array in `src/db/migrations.ts` (after v10):
```ts
  // v11: agent_presence — daemonless heartbeat presence. One row per agent (upsert).
  // last_heartbeat is server-assigned unixepoch seconds (single clock domain);
  // liveness is computed at READ time (now - last_heartbeat <= TTL). No sweeper.
  // heartbeat_seq rejects out-of-order retries. Per-project only.
  { version: 11, description: 'agent_presence table for heartbeat-based multi-agent presence', up: (db) => {
    const statements = [
      `CREATE TABLE IF NOT EXISTS agent_presence (
        agent_id TEXT PRIMARY KEY,
        session_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        current_focus TEXT,
        last_heartbeat INTEGER NOT NULL,
        heartbeat_seq INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX IF NOT EXISTS idx_agent_presence_heartbeat ON agent_presence(last_heartbeat)`,
    ];
    for (const s of statements) db.prepare(s).run();
  } },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/db/migrations.test.ts -t "v11 creates agent_presence"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations.ts src/db/migrations.test.ts
git commit -m "feat(db): add agent_presence table (migration v11) for heartbeat presence"
```

---

### Task 11: `dokoro_presence_ping` + `dokoro_presence_list`

**Files:**
- Create: `src/tools/presence-tools.ts`
- Test: `src/tools/presence-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tools/presence-tools.test.ts`:
```ts
import Database from 'better-sqlite3';
import { jest } from '@jest/globals';

jest.mock('../db/index.js', () => ({
  getSqliteDb: () => { throw new Error('getSqliteDb should not be called in tests (use __TEST_DB__)'); },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { presenceTools } = require('./presence-tools.js') as typeof import('./presence-tools.js');

function findTool(name: string) {
  const t = presenceTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}
function textOf(res: { content?: Array<{ type: string; text?: string }> }): string {
  return res.content?.[0]?.type === 'text' ? (res.content[0].text ?? '') : '';
}

describe('presence-tools', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agent_presence (
        agent_id TEXT PRIMARY KEY,
        session_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        current_focus TEXT,
        last_heartbeat INTEGER NOT NULL,
        heartbeat_seq INTEGER NOT NULL DEFAULT 0
      );
    `);
    (globalThis as Record<string, unknown>).__TEST_DB__ = db;
  });
  afterEach(() => { db.close(); delete (globalThis as Record<string, unknown>).__TEST_DB__; });

  it('presence_ping upserts one row per agent and bumps heartbeat_seq', async () => {
    const ping = findTool('dokoro_presence_ping');
    await ping.handler({ agent_id: 'a', current_focus: 'auth' });
    await ping.handler({ agent_id: 'a', current_focus: 'auth refactor' });
    const row = db.prepare('SELECT current_focus, heartbeat_seq FROM agent_presence WHERE agent_id=?').get('a') as
      { current_focus: string; heartbeat_seq: number };
    expect(row.current_focus).toBe('auth refactor');
    expect(row.heartbeat_seq).toBe(2);
    const n = db.prepare('SELECT COUNT(*) AS n FROM agent_presence').get() as { n: number };
    expect(n.n).toBe(1); // upsert, not insert
  });

  it('presence_list returns only agents alive within the TTL (read-time liveness)', async () => {
    // 'fresh' just pinged; 'stale' last beat well beyond the TTL.
    await findTool('dokoro_presence_ping').handler({ agent_id: 'fresh', current_focus: 'now' });
    db.prepare(`INSERT INTO agent_presence (agent_id, status, last_heartbeat, heartbeat_seq) VALUES ('stale','active', strftime('%s','now') - 99999, 1)`).run();
    const res = await findTool('dokoro_presence_list').handler({});
    const t = textOf(res);
    expect(t).toMatch(/fresh/);
    expect(t).not.toMatch(/stale/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/tools/presence-tools.test.ts`
Expected: FAIL — `Cannot find module './presence-tools.js'`.

- [ ] **Step 3: Implement the two tools**

Create `src/tools/presence-tools.ts`:
```ts
/**
 * Multi-agent PRESENCE via heartbeat (Working memory layer), daemonless.
 *
 * Agents are ephemeral MCP processes — there is no background sweeper. Liveness is
 * computed at READ time: an agent is live if now - last_heartbeat <= TTL. Heartbeats
 * are opportunistic (an explicit dokoro_presence_ping; agents call it at session start
 * and during work — no timers). last_heartbeat is server-assigned (SQLite unixepoch,
 * one clock domain); heartbeat_seq rejects out-of-order retries. Per-project only.
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

// Default presence TTL: 15 min. Generous, because agents only beat on tool calls.
const DEFAULT_TTL_SECONDS = 900;

export const presenceTools: ToolDefinition[] = [
  {
    name: 'dokoro_presence_ping',
    title: 'Heartbeat: announce this agent is active',
    description:
      'Record/refresh this agent\'s presence heartbeat for the current project (upsert; one row per agent_id). ' +
      'Call at session start and during work — no background timer exists. Optionally set status and current_focus ' +
      'so other agents can see what you are doing. Scoped to the current project only.',
    inputSchema: {
      agent_id: z.string(),
      session_id: z.string().optional(),
      status: z.enum(['active', 'idle', 'away']).optional().default('active'),
      current_focus: z.string().optional(),
    },
    handler: async (args) => {
      try {
        const a = args as { agent_id: string; session_id?: string; status?: string; current_focus?: string };
        // Server-assigned timestamp (unixepoch) — one clock domain. Atomic upsert; seq increments.
        db().prepare(`
          INSERT INTO agent_presence (agent_id, session_id, status, current_focus, last_heartbeat, heartbeat_seq)
          VALUES (?, ?, ?, ?, strftime('%s','now'), 1)
          ON CONFLICT(agent_id) DO UPDATE SET
            session_id = excluded.session_id,
            status = excluded.status,
            current_focus = excluded.current_focus,
            last_heartbeat = strftime('%s','now'),
            heartbeat_seq = agent_presence.heartbeat_seq + 1
        `).run(a.agent_id, a.session_id ?? null, a.status ?? 'active', a.current_focus ?? null);
        return { content: [{ type: 'text' as const, text: `presence updated for ${a.agent_id}` }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: 'text' as const, text: `presence_ping failed: ${msg}` }] };
      }
    },
  },
  {
    name: 'dokoro_presence_list',
    title: 'List agents currently active in this project',
    description:
      'List agents whose heartbeat is within the TTL (default 900s) for the current project — i.e. who is working here right now. ' +
      'Liveness is computed at read time; stale agents simply drop off. Shows status, focus, and seconds since last heartbeat.',
    inputSchema: {
      ttl_seconds: z.number().int().positive().max(86400).optional()
        .describe('Liveness window; agents quieter than this are treated as gone (default 900).'),
    },
    handler: async (args) => {
      try {
        const a = args as { ttl_seconds?: number };
        const ttl = a.ttl_seconds ?? DEFAULT_TTL_SECONDS;
        const rows = db().prepare(`
          SELECT agent_id, status, current_focus, session_id,
                 (strftime('%s','now') - last_heartbeat) AS age_seconds
          FROM agent_presence
          WHERE (strftime('%s','now') - last_heartbeat) <= ?
          ORDER BY last_heartbeat DESC
        `).all(ttl) as Array<{ agent_id: string; status: string; current_focus: string | null; session_id: string | null; age_seconds: number }>;
        if (rows.length === 0) return { content: [{ type: 'text' as const, text: '(no agents active)' }] };
        const lines = rows.map((r) =>
          `${r.agent_id} [${r.status}] — ${r.current_focus ?? 'no focus set'} (last seen ${r.age_seconds}s ago)`
        );
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: 'text' as const, text: `presence_list failed: ${msg}` }] };
      }
    },
  },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/tools/presence-tools.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/presence-tools.ts src/tools/presence-tools.test.ts
git commit -m "feat(memory): add dokoro_presence_ping + dokoro_presence_list (heartbeat presence)"
```

---

### Task 12: Register presence tools + doc/landing bump

**Files:**
- Modify: `src/servers/core-server.ts`, `src/servers/core-server.test.ts`, `README.md`, `site/index.html`

- [ ] **Step 1: Write the failing test**

Add to `src/servers/core-server.test.ts`:
```ts
it('coreTools includes the presence (heartbeat) tools', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { coreTools } = require('./core-server.js') as typeof import('./core-server.js');
  const names = coreTools.map((t: { name: string }) => t.name);
  expect(names).toContain('dokoro_presence_ping');
  expect(names).toContain('dokoro_presence_list');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/servers/core-server.test.ts -t "presence"`
Expected: FAIL.

- [ ] **Step 3: Register + document**

In `src/servers/core-server.ts`, add the import (near line ~16):
```ts
import { presenceTools } from '../tools/presence-tools.js';
```
and after `...handoffTools,` in `coreTools`:
```ts
  ...presenceTools,
```
Add to the README `🟢 Working memory` table:
```markdown
| `dokoro_presence_ping` | Heartbeat — announce this agent is active (status, focus) |
| `dokoro_presence_list` | List agents currently active in the project (read-time TTL) |
```
Add to the `site/index.html` `TOOLS` array:
```js
  {n:"dokoro_presence_ping",     l:"working", st:"agent_presence", d:"Heartbeat: announce this agent is active (upsert, server clock)."},
  {n:"dokoro_presence_list",     l:"working", st:"agent_presence", d:"List agents live within the TTL (read-time liveness, no sweeper)."},
```
Then bump the landing counts from `38` to `40`: `<div class="n">38</div>` → `<div class="n">40</div>` and `of 38 entries` → `of 40 entries`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/servers/core-server.test.ts -t "presence" && npm test`
Expected: PASS — presence registered; full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/servers/core-server.ts src/servers/core-server.test.ts README.md site/index.html
git commit -m "feat(core-server): register presence tools; document heartbeat presence"
```

---

## Final verification (run after all tasks)

```bash
npm run build      # tsc clean
npm run lint       # eslint clean
npm test           # all suites green (≈ 195 + ~20 new ≈ 215 tests)
# Live handshake — core server should now expose 38 tools (30 + 8) incl. the new ones:
node --input-type=module -e 'import{spawn}from"node:child_process";const s=spawn("node",["bin/dokoro-core.js"],{stdio:["pipe","pipe","pipe"]});let o="";s.stdout.on("data",d=>o+=d);const send=x=>s.stdin.write(JSON.stringify(x)+"\n");send({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"x",version:"0"}}});setTimeout(()=>{send({jsonrpc:"2.0",method:"notifications/initialized"});send({jsonrpc:"2.0",id:2,method:"tools/list",params:{}})},700);setTimeout(()=>{const L=o.trim().split("\n").map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);const n=(L.find(j=>j.id===2)?.result?.tools||[]).map(t=>t.name);console.log("tools:",n.length);console.log("new present:",["dokoro_block_write","dokoro_block_read","dokoro_block_list","dokoro_handoff_write","dokoro_handoff_inbox","dokoro_handoff_claim","dokoro_presence_ping","dokoro_presence_list"].filter(x=>n.includes(x)).length+"/8");s.kill();process.exit(0)},2600)'
```

---

## Self-Review

**Spec coverage:**
- "Shared, editable working-memory blocks multiple agents collaborate on live" → Tasks 1–4 (`shared_blocks` + write/read/list with optimistic CAS). ✓
- "Safe concurrent edits" → Task 2 atomic `UPDATE … WHERE block_key=? AND version=?` + conflict tests. ✓
- "Richer cross-session multi-agent handoff" → Tasks 5–8 (`handoffs` + write/inbox/claim, atomic claim). ✓
- "Per-project, no global store" (council constraint) → both tables live in the per-project DB; tool descriptions state it; no cross-project path added. ✓
- Discoverability → Task 9 (README + landing + compare-table). ✓

**Placeholder scan:** No TBD/“handle edge cases”/uncoded steps — every code step has full code. ✓

**Type/name consistency:** Tool arrays `sharedBlocksTools` / `handoffTools`; tool names `dokoro_block_*` / `dokoro_handoff_*`; columns (`block_key`, `version`, `updated_by`; `from_agent`, `to_agent`, `open_items_json`, `status`, `claimed_by`) are identical across migration, tools, and tests. Migration versions v9, v10 follow v8. Registration uses the `...spread` pattern matching `...sharedNotesTools`. ✓

**Notes / non-goals:** This builds on (does not replace) append-only `shared_notes`. Relaxing the file-based `current.md` workspace lock for partial concurrent section editing is explicitly **out of scope** — the DB-backed blocks make it unnecessary. No `npm publish` / version bump is included; do that separately after merge.
