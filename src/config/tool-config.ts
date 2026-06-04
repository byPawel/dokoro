/**
 * Tool Configuration System
 * Allows enabling/disabling specific tools per environment
 */

import * as fs from 'fs';

export interface ToolConfig {
  [toolName: string]: {
    enabled: boolean;
    config?: Record<string, unknown>;
  };
}

export function loadToolConfig(): ToolConfig {
  // Default all tools enabled
  const defaultConfig: ToolConfig = {
    // Core tools (always enabled)
    dokoro_workspace_status: { enabled: true },
    dokoro_workspace_claim: { enabled: true },
    dokoro_session_log: { enabled: true },
    
    // Analytics tools
    dokoro_analytics_summary: { enabled: true },
    dokoro_analytics_patterns: { enabled: true },
    dokoro_analytics_report: { enabled: true },
    
    // AI-powered tools (can be disabled)
    dokoro_ai_analysis: { 
      enabled: process.env.DOKORO_ENABLE_AI_ANALYSIS === 'true',
      config: { model: process.env.DOKORO_AI_MODEL || 'gpt-4.1-mini' }
    },
    dokoro_ai_planning: { 
      enabled: process.env.DOKORO_ENABLE_AI_PLANNING === 'true' 
    },
    
    // Search tools
    dokoro_search: { enabled: true },
    dokoro_search_semantic: {
      enabled: process.env.DOKORO_ENABLE_SEMANTIC_SEARCH === 'true'
    },

    // Tachibot bridge tools (connects tachibot-mcp to devlog persistence)
    bridge_index_research: { enabled: process.env.DOKORO_ENABLE_TACHIBOT_BRIDGE === 'true' },
    bridge_import_plan: { enabled: process.env.DOKORO_ENABLE_TACHIBOT_BRIDGE === 'true' },
    bridge_get_context: { enabled: process.env.DOKORO_ENABLE_TACHIBOT_BRIDGE === 'true' },
  };

  // Load from environment variable
  const configOverride = process.env.DOKORO_TOOL_CONFIG;
  if (configOverride) {
    try {
      const override = JSON.parse(configOverride);
      return { ...defaultConfig, ...override };
    } catch {
      console.warn('Invalid DOKORO_TOOL_CONFIG, using defaults');
    }
  }

  // Load from file if exists
  const configPath = process.env.DOKORO_TOOL_CONFIG_PATH;
  if (configPath) {
    try {
      const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return { ...defaultConfig, ...fileConfig };
    } catch {
      console.warn(`Could not load config from ${configPath}, using defaults`);
    }
  }

  return defaultConfig;
}

export function isToolEnabled(toolName: string, config?: ToolConfig): boolean {
  const toolConfig = config || loadToolConfig();
  return toolConfig[toolName]?.enabled !== false;
}