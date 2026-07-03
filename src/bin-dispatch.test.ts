/**
 * Regression: `dokoro <subcommand>` must never silently fall through to the
 * unified MCP stdio server. A stale allowlist in bin/dokoro.js did exactly
 * that — `dokoro browse` on an older install booted the server (which sits
 * reading stdin and looks like a hang) instead of the TUI. Any subcommand
 * must delegate to the compiled CLI, which fails loudly on unknown commands;
 * only a bare `dokoro` starts the server.
 *
 * Spawns the real bin against dist/esm — requires a build (`npm run build`).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

const BIN = path.resolve(__dirname, '../bin/dokoro.js');
const DIST_CLI = path.resolve(__dirname, '../dist/esm/dokoro-cli.js');

describe('bin/dokoro.js dispatch', () => {
  it(
    'routes an unknown subcommand to the CLI (loud failure), not the MCP server',
    () => {
      if (!existsSync(DIST_CLI)) {
        throw new Error('dist/esm missing — run `npm run build` before this suite');
      }
      const r = spawnSync(process.execPath, [BIN, 'no-such-command'], {
        timeout: 20_000,
        encoding: 'utf8',
      });
      expect(r.stderr).not.toContain('[Unified]');
      expect(r.stderr).toContain('Unknown command');
      expect(r.status).toBe(1);
    },
    30_000,
  );
});
