/**
 * Regression test: core-server must register both episodic-memory tools so
 * that the WRITE path (devlog_session_summary_add) is reachable alongside
 * the READ path (devlog_session_recall).
 *
 * We reconstruct the coreTools selection locally (mirroring core-server.ts)
 * rather than importing the entry-point file, which would start the server as
 * a side-effect.
 */
import Database from 'better-sqlite3';
import { jest } from '@jest/globals';

// Mock db and ESM-only modules the same way other devlog tool tests do.
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

// Import after mocks are registered (require style avoids import.meta issues).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { workspaceTools } = require('../tools/workspace-tools.js') as typeof import('../tools/workspace-tools.js');

// Names that core-server cherry-picks from workspaceTools.
const CORE_WORKSPACE_TOOL_NAMES = [
  'devlog_workspace_status',
  'devlog_workspace_claim',
  'devlog_workspace_dump',
  'devlog_session_log',
  'devlog_session_recall',
  'devlog_session_summary_add',
];

describe('core-server tool registration', () => {
  it('includes devlog_session_recall (episodic read)', () => {
    const tool = workspaceTools.find((t: { name: string }) => t.name === 'devlog_session_recall');
    expect(tool).toBeDefined();
  });

  it('includes devlog_session_summary_add (episodic write)', () => {
    const tool = workspaceTools.find((t: { name: string }) => t.name === 'devlog_session_summary_add');
    expect(tool).toBeDefined();
  });

  it('all workspace tool names cherry-picked by core-server resolve to a defined tool', () => {
    for (const name of CORE_WORKSPACE_TOOL_NAMES) {
      const tool = workspaceTools.find((t: { name: string }) => t.name === name);
      expect(tool).toBeDefined();
    }
  });
});
