/**
 * browse-ui.tsx smoke tests. DOKORO_PATH is pointed at a per-file temp fixture
 * BEFORE browse-ui is loaded (archive paths + the a/u gate read it at import),
 * and BrowseApp is loaded via a deferred dynamic import (not a static one, which
 * would be hoisted above the env assignment) so it picks that fixture up. The
 * file is treated as ESM by jest (extensionsToTreatAsEsm: ['.tsx']), so ink@6 /
 * ink-testing-library — pure ESM with a transitive top-level await in
 * yoga-layout's wasm loader — load cleanly where a CJS require() cannot.
 */
import React from 'react';
import Database from 'better-sqlite3';
import { render } from 'ink-testing-library';
import { promises as fs, mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

const FIXTURE = mkdtempSync(path.join(os.tmpdir(), 'dokoro-ui-fixture-'));
process.env.DOKORO_PATH = FIXTURE;
const { BrowseApp } = (await import('./browse-ui.js')) as typeof import('./browse-ui.js');

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let db: Database.Database;

async function resetFixture(): Promise<void> {
  rmSync(FIXTURE, { recursive: true, force: true });
  await fs.mkdir(FIXTURE, { recursive: true });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

beforeEach(async () => {
  await resetFixture();
  await fs.writeFile(path.join(FIXTURE, 'current.md'), '# Now\n');
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_presence (agent_id TEXT PRIMARY KEY, session_id TEXT, status TEXT, current_focus TEXT, last_heartbeat INTEGER NOT NULL, heartbeat_seq INTEGER DEFAULT 0);
    CREATE TABLE file_claims (claim_key TEXT PRIMARY KEY, file_path TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT, intent TEXT, claimed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, heartbeat_seq INTEGER DEFAULT 0, released_at INTEGER);
    CREATE TABLE agent_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, confidence REAL, latency_ms INTEGER, error_message TEXT, doc_id TEXT, session_id TEXT, metadata_json TEXT, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE entities (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, name TEXT NOT NULL, canonical_name TEXT NOT NULL, description TEXT, metadata_json TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(type, canonical_name));
    CREATE TABLE entity_relations (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL, target_id INTEGER NOT NULL, relation_type TEXT NOT NULL, weight REAL DEFAULT 1.0, metadata_json TEXT, valid_from TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), valid_to TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
  `);
  (globalThis as Record<string, unknown>).__TEST_DB__ = db;
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__TEST_DB__;
  db.close();
});

it('renders categories on mount', async () => {
  const { lastFrame, unmount } = render(<BrowseApp dokoroPath={FIXTURE} />);
  await delay(60);
  expect(lastFrame()).toContain('Current workspace');
  unmount();
});

it('? opens help and any key closes it back to the same level', async () => {
  const { lastFrame, stdin, unmount } = render(<BrowseApp dokoroPath={FIXTURE} />);
  await delay(60);
  stdin.write('?');
  await delay(20);
  expect(lastFrame()).toContain('Navigation');
  stdin.write('x');
  await delay(20);
  expect(lastFrame()).not.toContain('press any key to close help');
  expect(lastFrame()).toContain('Current workspace');
  unmount();
});

it('/ filter typing keeps a literal q (no quit)', async () => {
  const { lastFrame, stdin, unmount } = render(<BrowseApp dokoroPath={FIXTURE} />);
  await delay(60);
  stdin.write('\r'); // open the first category (Current) → items level
  await delay(40);
  stdin.write('/');
  await delay(20);
  stdin.write('q');
  await delay(20);
  expect(lastFrame()).toContain('filter: q');
  unmount();
});

it('confirm mode swallows navigation keys', async () => {
  // A live plan is archivable; arming its confirm requires dokoroPath === DOKORO_PATH
  // (satisfied: both are FIXTURE).
  await writeJson(path.join(FIXTURE, '.mcp', 'plans', 'plan-x.json'), {
    id: 'plan-x', title: 'Plan X', status: 'active', items: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  await writeJson(path.join(FIXTURE, '.mcp', 'plans', 'index.json'), { 'plan-x': 'Plan X' });

  // Jump straight to Plans via initialCategory (Task 2) so the arm is deterministic.
  const { lastFrame, stdin, unmount } = render(<BrowseApp dokoroPath={FIXTURE} initialCategory="plans" />);
  await delay(80);
  stdin.write('a'); // arm the archive confirm on the live plan
  await delay(30);
  expect(lastFrame()).toContain('Archive "Plan X"? y/n');
  const framed = lastFrame();
  stdin.write('[B'); // a real down arrow — must be swallowed by confirm mode
  await delay(20);
  expect(lastFrame()).toBe(framed); // unchanged — navigation did not move selection
  stdin.write('n'); // cancel the confirm
  await delay(20);
  unmount();
});
