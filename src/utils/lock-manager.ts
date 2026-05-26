/**
 * Lock manager for multi-agent workspace coordination
 * Prevents conflicts when multiple agents try to access workspace
 */

import { promises as fs } from 'fs';
import path from 'path';
import { DEVLOG_PATH } from '../types/devlog.js';

export interface WorkspaceLock {
  agent_id: string;
  session_id: string;
  acquired_at: string;
  expires_at: string;
  last_heartbeat: string;
  pid?: number;
}

const LOCK_FILE = path.join(DEVLOG_PATH, '.mcp', 'workspace.lock');
const LOCK_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const STALE_THRESHOLD = 60 * 60 * 1000; // 1 hour - definitely stale

export async function checkLock(): Promise<WorkspaceLock | null> {
  try {
    const lockContent = await fs.readFile(LOCK_FILE, 'utf-8');
    return JSON.parse(lockContent);
  } catch {
    // No lock file means no lock
    return null;
  }
}

export function isLockExpired(lock: WorkspaceLock): boolean {
  const now = Date.now();
  const expiresAt = new Date(lock.expires_at).getTime();
  const lastHeartbeat = new Date(lock.last_heartbeat).getTime();

  // Lock is expired if past expiration OR no heartbeat for too long
  return now > expiresAt || (now - lastHeartbeat) > STALE_THRESHOLD;
}

/**
 * Attempt to exclusively create the lock file using O_EXCL (atomic).
 * Returns the FileHandle on success, throws EEXIST if the file already exists.
 */
async function tryExclusiveCreate(payload: string): Promise<void> {
  const fh = await fs.open(LOCK_FILE, 'wx'); // O_WRONLY | O_CREAT | O_EXCL
  try {
    await fh.writeFile(payload, 'utf-8');
  } finally {
    await fh.close();
  }
}

export async function acquireLock(agentId: string, sessionId: string, force = false): Promise<{ success: boolean; error?: string; lock?: WorkspaceLock }> {
  try {
    // Ensure lock directory exists
    await fs.mkdir(path.dirname(LOCK_FILE), { recursive: true });

    const now = new Date();
    const newLock: WorkspaceLock = {
      agent_id: agentId,
      session_id: sessionId,
      acquired_at: now.toISOString(),
      expires_at: new Date(now.getTime() + LOCK_TIMEOUT).toISOString(),
      last_heartbeat: now.toISOString(),
      pid: process.pid,
    };
    const payload = JSON.stringify(newLock, null, 2);

    // Attempt 1: atomic exclusive create (O_EXCL)
    try {
      await tryExclusiveCreate(payload);
      return { success: true, lock: newLock };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err; // unexpected error — rethrow
    }

    // File already exists.  Read and inspect it.
    const existingLock = await checkLock();

    if (existingLock) {
      const stale = isLockExpired(existingLock);

      if (!stale && !force && existingLock.agent_id !== agentId) {
        const minutesLeft = Math.round((new Date(existingLock.expires_at).getTime() - Date.now()) / 60000);
        return {
          success: false,
          error: `Workspace is locked by ${existingLock.agent_id}. Expires in ${minutesLeft} minutes. Use force=true to override.`,
        };
      }

      if (stale || force) {
        // Remove the stale/force-overridden lock and retry the exclusive create once.
        await fs.unlink(LOCK_FILE).catch(() => {
          // Another agent may have beaten us to the unlink; that's fine.
        });

        try {
          await tryExclusiveCreate(payload);
          return { success: true, lock: newLock };
        } catch (err2: unknown) {
          const code2 = (err2 as NodeJS.ErrnoException).code;
          if (code2 === 'EEXIST') {
            // A fresh agent slipped in between our unlink and our retry.
            return {
              success: false,
              error: 'Workspace was claimed by another agent just as the stale lock was cleared. Try again.',
            };
          }
          throw err2;
        }
      }
    }

    // Lock file exists but we couldn't read it (parse error, race, etc.) — treat as held.
    return {
      success: false,
      error: 'Workspace is currently locked. Try again or use force=true to override.',
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to acquire lock: ${error}`,
    };
  }
}

export async function updateLockHeartbeat(agentId: string): Promise<boolean> {
  try {
    const lock = await checkLock();

    if (!lock || lock.agent_id !== agentId) {
      return false;
    }

    // Update heartbeat and expiration
    const now = new Date();
    lock.last_heartbeat = now.toISOString();
    lock.expires_at = new Date(now.getTime() + LOCK_TIMEOUT).toISOString();

    // Write atomically
    const tempFile = `${LOCK_FILE}.tmp`;
    await fs.writeFile(tempFile, JSON.stringify(lock, null, 2));
    await fs.rename(tempFile, LOCK_FILE);

    return true;
  } catch (error) {
    console.error('Failed to update lock heartbeat:', error);
    return false;
  }
}

export async function releaseLock(agentId: string): Promise<boolean> {
  try {
    const lock = await checkLock();

    // Only release if we own it
    if (!lock || lock.agent_id !== agentId) {
      return false;
    }

    await fs.unlink(LOCK_FILE);
    return true;
  } catch (error) {
    console.error('Failed to release lock:', error);
    return false;
  }
}

export function formatLockInfo(lock: WorkspaceLock): string {
  const now = Date.now();
  const expiresAt = new Date(lock.expires_at).getTime();
  const minutesLeft = Math.round((expiresAt - now) / 60000);
  const lastHeartbeatAge = Math.round((now - new Date(lock.last_heartbeat).getTime()) / 60000);

  return `Agent: ${lock.agent_id}
Session: ${lock.session_id}
Acquired: ${new Date(lock.acquired_at).toLocaleString()}
Expires: ${minutesLeft > 0 ? `in ${minutesLeft} minutes` : 'EXPIRED'}
Last active: ${lastHeartbeatAge} minutes ago
${isLockExpired(lock) ? '⚠️ Lock is stale and can be overridden' : '✅ Lock is active'}`;
}
