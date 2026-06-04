/**
 * Shared utilities for all devlog servers
 */

import path from 'path';
import { promises as fs, existsSync } from 'fs';

// Get devlog path from environment or use default
// Prevents devlog/devlog doubling when cwd is already the devlog directory
export const DOKORO_PATH = process.env.DOKORO_PATH || (() => {
  const cwd = process.cwd();
  const withDevlog = path.join(cwd, 'devlog');
  // If cwd is already named 'devlog' and there's no nested devlog/ subfolder, use cwd directly
  if (path.basename(cwd) === 'devlog' && !existsSync(withDevlog)) {
    return cwd;
  }
  return withDevlog;
})();

// Shared date formatting functions
export function formatDate(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  
  return `${year}-${month}-${day}-${hour}h${minute}`;
}

export function getDayName(date: Date = new Date()): string {
  return date.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
}

// Check if file exists
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Ensure directory exists
export async function ensureDir(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch {
    // Directory might already exist, that's okay
  }
}

// Read file with error handling
export async function readFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    console.error(`Error reading file ${filePath}`);
    return null;
  }
}

// Write file with directory creation
export async function writeFile(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, 'utf-8');
}