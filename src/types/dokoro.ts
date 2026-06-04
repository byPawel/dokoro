// Shared types for DevLog MCP Server

export interface ParsedDevlog {
  content: string;
  data: Record<string, unknown>;
  tags: Record<string, unknown>;
  title?: string;
  date?: string;
}

export interface SearchResult {
  file: string;
  excerpt: string;
  lastModified: Date;
  fullContent: string;
  parsedContent?: string;
  title?: string;
  date?: string;
  tags?: Record<string, unknown>;
  frontmatter?: Record<string, unknown>;
}

export interface WorkspaceInfo {
  path: string;
  content: string | null;
  exists: boolean;
}

export interface AgentInfo {
  agentId: string | null;
  lastActive: string | null;
}

export interface ConflictResult {
  file: string;
  riskLevel: string;
  conflictScore: number;
  hasBreakingChanges: boolean;
  hasRegression: boolean;
  excerpt: string;
  lastModified: Date;
}

export interface DuplicateResult {
  file: string;
  similarityScore: number;
  status: string;
  excerpt: string;
  lastModified: Date;
}

export interface FeatureAnalysis {
  checklist: string[];
  conflicts: Array<{ component: string; reason: string }>;
  components: string[];
  testScenarios: string[];
}

export interface ResearchSource {
  tool: string;
  query: string;
  key_findings: string[];
  links?: string[];
  code_snippets?: string[];
  warnings?: string[];
}

// Environment configuration
// Re-export from shared utils to ensure single source of truth for path resolution
export { DOKORO_PATH } from '../shared/dokoro-utils.js';