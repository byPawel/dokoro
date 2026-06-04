import { promises as fs } from 'fs';
import path from 'path';
import { WorkspaceInfo, AgentInfo, DOKORO_PATH } from '../types/dokoro.js';

/**
 * Generate a unique agent ID with collision detection
 */
export async function generateAgentId(): Promise<string> {
  const now = new Date();
  
  // High-precision timestamp (seconds-level)
  const timestamp = now.toISOString()
    .slice(2, 19)           // YY-MM-DDTHH:MM:SS
    .replace(/[-:T]/g, '')  // YYMMDDHHMMSS
    .slice(0, 10);          // YYMMDDHHMM (keep 10 chars for readability)
  
  // Add seconds for precision
  const seconds = now.getSeconds().toString().padStart(2, '0');
  let agentId = `agent-${timestamp}${seconds}`;
  
  // Collision detection and auto-increment
  const workspace = await getCurrentWorkspace();
  if (workspace.exists && workspace.content) {
    const { agentId: currentAgent } = parseAgentFromContent(workspace.content);
    
    if (currentAgent && currentAgent.startsWith(agentId)) {
      // Extract counter from existing agent ID (e.g., agent-250622025145-2 → 2)
      const match = currentAgent.match(/agent-(\d{12})-?(\d+)?$/);
      const counter = match?.[2] ? parseInt(match[2]) + 1 : 2;
      agentId = `${agentId}-${counter}`;
    }
  }
  
  return agentId;
}

/**
 * Get current workspace information
 */
export async function getCurrentWorkspace(): Promise<WorkspaceInfo> {
  const currentPath = path.join(DOKORO_PATH, 'current.md');
  try {
    const content = await fs.readFile(currentPath, 'utf-8');
    return { path: currentPath, content, exists: true };
  } catch {
    return { path: currentPath, content: null, exists: false };
  }
}

/**
 * Parse agent information from workspace content
 */
export function parseAgentFromContent(content: string): AgentInfo {
  const agentMatch = content.match(/agent_id:\s*"?([^"\n]+)"?/);
  const activeMatch = content.match(/last_active:\s*"?([^"\n]+)"?/);
  return {
    agentId: agentMatch ? agentMatch[1] : null,
    lastActive: activeMatch ? activeMatch[1] : null
  };
}