#!/usr/bin/env node
/**
 * dokoro — package entrypoint (works from the published npm package; no tsx/src needed).
 *
 * Default (no subcommand): start the unified MCP server over stdio. This is what
 *   `claude mcp add dokoro -- npx -y dokoro` runs — each project gets its own
 *   ./dokoro store (DOKORO_PATH defaults to <cwd>/dokoro), so install is per-project
 *   with zero shared state.
 *
 * Subcommands (init, migrate, …): delegate to the compiled CLI.
 *
 * Both targets are the compiled output under dist/esm (shipped via package.json
 * "files"), so this runs under plain `node` without tsx or the TypeScript sources.
 */

const sub = process.argv[2];

if (sub) {
  // Any argument at all → the CLI. It owns the full command switch and fails
  // loudly ("Unknown command" + help, exit 1) on anything it doesn't know.
  // An allowlist here once let `dokoro browse` fall through to the MCP server
  // when the two drifted — the server sits reading stdin and looks like a hang.
  await import('../dist/esm/dokoro-cli.js');
} else {
  // No subcommand → run the MCP server (stdio). Default to the unified server so a
  // single `npx -y dokoro` exposes all tools in one process.
  await import('../dist/esm/servers/unified-server.js');
}
