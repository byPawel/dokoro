/**
 * Shared constants across all devlog servers
 */

export const LOCK_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
export const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

export const DOKORO_FOLDERS = {
  DAILY: 'daily',
  FEATURES: 'features',
  DECISIONS: 'decisions',
  INSIGHTS: 'insights',
  RESEARCH: 'research',
  RETROSPECTIVE: 'retrospective',
  PLANNING: 'planning',
  ARCHIVE: 'archive',
  MCP: '.mcp'
} as const;

export const FILE_PATTERNS = {
  ALL: '**/*.md',
  DAILY: 'daily/**/*.md',
  FEATURES: 'features/**/*.md',
  INSIGHTS: 'insights/**/*.md',
  DECISIONS: 'decisions/**/*.md',
  CURRENT: 'current.md'
} as const;

export const TAG_TYPES = {
  TYPE: ['research', 'analysis', 'decision', 'session', 'bugfix', 'feature', 'retrospective', 'planning'],
  SCOPE: ['forge', 'api', 'frontend', 'backend', 'ai', 'ui', 'dx', 'architecture'],
  PRIORITY: ['critical', 'high', 'medium', 'low'],
  STATUS: ['active', 'completed', 'blocked', 'archived', 'planned', 'in-progress'],
  SIZE: ['micro', 'detailed', 'comprehensive'],
  COMPLEXITY: ['trivial', 'simple', 'moderate', 'complex', 'epic'],
  CONFIDENCE: ['high', 'medium', 'low']
} as const;