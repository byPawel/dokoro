import { existsSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const VENDORED_PATHS = [
  'src/server',
  'src/client',
  'src/types.ts',
  'src/inMemory.ts',
  'src/spec.types.ts',
  'src/shared/protocol.ts',
  'src/shared/transport.ts',
];

describe('SDK is de-vendored', () => {
  it.each(VENDORED_PATHS)('no vendored SDK path present: %s', (p) => {
    expect(existsSync(p)).toBe(false);
  });

  it('McpServer resolves from the npm package', () => {
    expect(typeof McpServer).toBe('function');
  });

  it('CallToolResult type is importable from the package', () => {
    const r: CallToolResult = { content: [] };
    expect(r.content).toEqual([]);
  });
});
