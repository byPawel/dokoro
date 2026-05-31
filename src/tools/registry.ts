import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ZodRawShape } from 'zod';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodRawShape;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (...args: any[]) => Promise<CallToolResult>;
}

/**
 * Register a tool with the MCP server
 */
export function registerTool(server: McpServer, tool: ToolDefinition) {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: tool.inputSchema as any,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tool.handler as any
  );
}

/**
 * Register multiple tools at once
 */
export function registerTools(server: McpServer, tools: ToolDefinition[]) {
  tools.forEach(tool => registerTool(server, tool));
}