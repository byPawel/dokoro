/**
 * Regression test: core-server must register both episodic-memory tools so
 * that the WRITE path (dokoro_session_summary_add) is reachable alongside
 * the READ path (dokoro_session_recall).
 *
 * We reconstruct the coreTools selection locally (mirroring core-server.ts)
 * rather than importing the entry-point file, which would start the server as
 * a side-effect.
 */
import Database from 'better-sqlite3';
import { jest } from '@jest/globals';

// Mock db and ESM-only modules the same way other dokoro tool tests do.
jest.mock('../db/index.js', () => ({
  getSqliteDb: () => {
    const test = (globalThis as { __TEST_DB__?: Database.Database }).__TEST_DB__;
    if (test) return test;
    throw new Error('test DB not set');
  },
  ensureVectorTables: () => {},
}));

jest.mock('../utils/render-output.js', () => ({
  renderOutput: (data: unknown) => JSON.stringify(data),
}));
jest.mock('../utils/color-setup.js', () => ({}));

// Stub the server runtime so importing core-server.ts to inspect its exported
// coreTools selection does NOT start a real MCP server as an import side-effect.
jest.mock('./base-server.js', () => ({
  createDokoroServer: () => ({}),
  startServer: () => Promise.resolve(),
}));

// Import after mocks are registered (require style avoids import.meta issues).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { workspaceTools } = require('../tools/workspace-tools.js') as typeof import('../tools/workspace-tools.js');

// Names that core-server cherry-picks from workspaceTools.
const CORE_WORKSPACE_TOOL_NAMES = [
  'dokoro_workspace_status',
  'dokoro_workspace_claim',
  'dokoro_workspace_dump',
  'dokoro_session_log',
  'dokoro_session_recall',
  'dokoro_session_summary_add',
];

describe('core-server tool registration', () => {
  it('includes dokoro_session_recall (episodic read)', () => {
    const tool = workspaceTools.find((t: { name: string }) => t.name === 'dokoro_session_recall');
    expect(tool).toBeDefined();
  });

  it('includes dokoro_session_summary_add (episodic write)', () => {
    const tool = workspaceTools.find((t: { name: string }) => t.name === 'dokoro_session_summary_add');
    expect(tool).toBeDefined();
  });

  it('all workspace tool names cherry-picked by core-server resolve to a defined tool', () => {
    for (const name of CORE_WORKSPACE_TOOL_NAMES) {
      const tool = workspaceTools.find((t: { name: string }) => t.name === name);
      expect(tool).toBeDefined();
    }
  });

  it('exported coreTools has no undefined entries (every cherry-picked name resolves)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { coreTools } = require('./core-server.js') as typeof import('./core-server.js');
    expect(coreTools.length).toBeGreaterThan(0);
    expect(coreTools.every((t: { name?: string }) => typeof t?.name === 'string')).toBe(true);
  });

  it('coreTools includes the current.md management tools', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { coreTools } = require('./core-server.js') as typeof import('./core-server.js');
    const names = coreTools.map((t: { name: string }) => t.name);
    expect(names).toContain('dokoro_regenerate_current');
    expect(names).toContain('dokoro_update_current_section');
    expect(names).toContain('dokoro_get_current_focus');
  });

  it('coreTools includes the shared working-memory tools (concurrent multi-agent)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { coreTools } = require('./core-server.js') as typeof import('./core-server.js');
    const names = coreTools.map((t: { name: string }) => t.name);
    expect(names).toContain('dokoro_shared_note_append');
    expect(names).toContain('dokoro_shared_note_read');
  });

  it('coreTools includes the shared editable-block tools', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { coreTools } = require('./core-server.js') as typeof import('./core-server.js');
    const names = coreTools.map((t: { name: string }) => t.name);
    expect(names).toContain('dokoro_block_write');
    expect(names).toContain('dokoro_block_read');
    expect(names).toContain('dokoro_block_list');
  });

  it('coreTools includes the cross-session handoff tools', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { coreTools } = require('./core-server.js') as typeof import('./core-server.js');
    const names = coreTools.map((t: { name: string }) => t.name);
    expect(names).toContain('dokoro_handoff_write');
    expect(names).toContain('dokoro_handoff_inbox');
    expect(names).toContain('dokoro_handoff_claim');
  });

  it('coreTools includes the presence (heartbeat) tools', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { coreTools } = require('./core-server.js') as typeof import('./core-server.js');
    const names = coreTools.map((t: { name: string }) => t.name);
    expect(names).toContain('dokoro_presence_ping');
    expect(names).toContain('dokoro_presence_list');
  });

  it('coreTools includes the advisory file-claim tools', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { coreTools } = require('./core-server.js') as typeof import('./core-server.js');
    const names = coreTools.map((t: { name: string }) => t.name);
    expect(names).toContain('dokoro_file_claim');
    expect(names).toContain('dokoro_file_release');
    expect(names).toContain('dokoro_claim_list');
  });
});
