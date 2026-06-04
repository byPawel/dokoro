/**
 * Bridge Tools - Connects tachibot-mcp outputs to dokoro-mcp persistence
 *
 * Three tools:
 * - bridge_index_research: Index tachibot research into LanceDB
 * - bridge_import_plan: Import tachibot planner phases into devlog plans
 * - bridge_get_context: Pull relevant devlog knowledge for tachibot reasoning
 *
 * All opt-in via DOKORO_ENABLE_TACHIBOT_BRIDGE=true
 */

import { z } from 'zod';
import { ToolDefinition } from './registry.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  indexResearch,
  importPlan,
  getContext,
} from '../services/bridge-service.js';

export const bridgeTools: ToolDefinition[] = [
  {
    name: 'bridge_index_research',
    title: 'Index Tachibot Research',
    description:
      'Index research output from tachibot tools (perplexity, grok, openai, gemini) into LanceDB for semantic search. ' +
      'Uses deterministic IDs so re-indexing the same source+query replaces the old entry (no duplicates).',
    inputSchema: {
      source: z.enum([
        'perplexity_ask', 'perplexity_reason', 'perplexity_research',
        'grok_reason', 'grok_search',
        'openai_reason', 'openai_search',
        'gemini_search', 'gemini_analyze_code', 'gemini_analyze_text',
      ]).describe('Tachibot research tool that produced the content'),
      query: z.string().describe('The original query/prompt sent to the research tool'),
      content: z.string().describe('The research output content to index'),
      metadata: z.record(z.unknown()).optional().describe('Additional metadata (e.g. model, timestamp, links)'),
    },
    handler: async (args: {
      source: string;
      query: string;
      content: string;
      metadata?: Record<string, unknown>;
    }): Promise<CallToolResult> => {
      try {
        const result = await indexResearch(args);

        const actionMsg = result.action === 'unchanged'
          ? 'Content unchanged, skipped re-indexing'
          : result.action === 'reindexed'
            ? `Re-indexed (replaced previous entry)`
            : 'Indexed new research';

        return {
          content: [{
            type: 'text',
            text: [
              `**Research Indexed** (${result.action})`,
              `Doc ID: ${result.docId}`,
              `Source: ${args.source}`,
              `Query: ${args.query.slice(0, 80)}${args.query.length > 80 ? '...' : ''}`,
              result.action !== 'unchanged'
                ? `Chunks: ${result.chunks} | Tokens: ${result.tokens}`
                : actionMsg,
            ].join('\n'),
          }],
        };
      } catch (error: unknown) {
        return {
          content: [{
            type: 'text',
            text: `**Index Research Error:** ${(error as Error).message}`,
          }],
          isError: true,
        };
      }
    },
  },

  {
    name: 'bridge_import_plan',
    title: 'Import Tachibot Plan',
    description:
      'Import phases from tachibot planner_maker into the devlog plan tracking system. ' +
      'Creates a plan that works with dokoro_plan_check, dokoro_plan_validate, dokoro_plan_status, etc.',
    inputSchema: {
      title: z.string().describe('Plan title'),
      phases: z.array(z.string()).min(1).describe('List of plan phases/steps to track'),
      filepath: z.string().optional().describe('Optional source filepath reference'),
      status: z.enum(['draft', 'active']).default('active').describe('Initial plan status'),
    },
    handler: async (args: {
      title: string;
      phases: string[];
      filepath?: string;
      status?: string;
    }): Promise<CallToolResult> => {
      try {
        const result = await importPlan(args);

        return {
          content: [{
            type: 'text',
            text: [
              `**Plan Imported**`,
              `Plan ID: ${result.planId}`,
              `Title: ${args.title}`,
              `Items: ${result.itemCount} phases`,
              `Status: ${args.status || 'active'}`,
              `Path: ${result.planPath}`,
              '',
              'Use dokoro_plan_status, dokoro_plan_check, dokoro_plan_validate to manage this plan.',
            ].join('\n'),
          }],
        };
      } catch (error: unknown) {
        return {
          content: [{
            type: 'text',
            text: `**Import Plan Error:** ${(error as Error).message}`,
          }],
          isError: true,
        };
      }
    },
  },

  {
    name: 'bridge_get_context',
    title: 'Get Devlog Context',
    description:
      'Pull relevant knowledge from devlog (research, plans, docs) as compact context for tachibot reasoning tools. ' +
      'Returns title/type/excerpt/score entries optimized for pasting into tool inputs.',
    inputSchema: {
      query: z.string().describe('Search query (natural language or keywords)'),
      limit: z.number().default(5).describe('Maximum number of context entries to return'),
      include_research: z.boolean().default(true).describe('Include indexed research results'),
      include_plans: z.boolean().default(true).describe('Include plan documents'),
    },
    handler: async (args: {
      query: string;
      limit?: number;
      include_research?: boolean;
      include_plans?: boolean;
    }): Promise<CallToolResult> => {
      try {
        const entries = await getContext(args);

        if (entries.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `No relevant context found for: "${args.query}"`,
            }],
          };
        }

        // Compact format optimized for tachibot tool inputs
        const formatted = entries.map((e, i) =>
          `[${i + 1}] (${e.type}) ${e.title}\n${e.excerpt}`
        ).join('\n\n');

        return {
          content: [{
            type: 'text',
            text: `**${entries.length} context entries** for "${args.query}":\n\n${formatted}`,
          }],
        };
      } catch (error: unknown) {
        return {
          content: [{
            type: 'text',
            text: `**Get Context Error:** ${(error as Error).message}`,
          }],
          isError: true,
        };
      }
    },
  },
];
