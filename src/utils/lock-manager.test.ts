/**
 * Tests for lock-manager atomic O_EXCL acquisition (BUG-19)
 *
 * Strategy: set tmpDir BEFORE requiring the lock-manager module so that
 * DEVLOG_PATH (and therefore LOCK_FILE) resolve to the temp directory.
 * We use jest.isolateModules() to get a fresh module instance per test suite.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

let tmpDir: string;

// We must set tmpDir synchronously before the module loads.
// Using jest.mock with a getter — but LOCK_FILE is computed at module scope
// with path.join(DEVLOG_PATH, ...), so the getter must be evaluated at that
// moment.  The only reliable way is to set tmpDir before any require().

// Set a placeholder so the mock registration itself doesn't blow up.
tmpDir = os.tmpdir();

jest.mock('../types/devlog.js', () => ({
  get DEVLOG_PATH() {
    return tmpDir;
  },
}));

// Import AFTER mock registration via require (not top-level import) so the
// module sees the mock.  We use jest.isolateModules inside beforeEach to get
// a fresh module per test so LOCK_FILE re-evaluates with the new tmpDir.

type LockManager = typeof import('./lock-manager.js');

let lockManager: LockManager;

async function freshModule(): Promise<LockManager> {
  return new Promise<LockManager>((resolve) => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      resolve(require('./lock-manager.js') as LockManager);
    });
  });
}

describe('lock-manager (BUG-19 — atomic O_EXCL)', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-lock-test-'));
    await fs.mkdir(path.join(tmpDir, '.mcp'), { recursive: true });
    // Refresh the module so LOCK_FILE picks up the new tmpDir
    lockManager = await freshModule();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('allows a single acquire to succeed', async () => {
    const result = await lockManager.acquireLock('agent-1', 'session-1');
    expect(result.success).toBe(true);
    expect(result.lock).toBeDefined();
    expect(result.lock?.agent_id).toBe('agent-1');
  });

  it('two concurrent acquireLock calls — exactly one wins (TOCTOU race test)', async () => {
    const [r1, r2] = await Promise.all([
      lockManager.acquireLock('agent-A', 'session-A'),
      lockManager.acquireLock('agent-B', 'session-B'),
    ]);

    const successes = [r1, r2].filter(r => r.success);
    const failures = [r1, r2].filter(r => !r.success);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });

  it('second acquire fails with an error message when lock is held', async () => {
    await lockManager.acquireLock('agent-1', 'session-1');
    const result = await lockManager.acquireLock('agent-2', 'session-2');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/locked by agent-1/i);
  });

  it('stale lock is reclaimable', async () => {
    const lockFile = path.join(tmpDir, '.mcp', 'workspace.lock');
    const staleDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    const staleLock = {
      agent_id: 'old-agent',
      session_id: 'old-session',
      acquired_at: staleDate,
      expires_at: staleDate, // expired
      last_heartbeat: staleDate, // no heartbeat > STALE_THRESHOLD (1h)
      pid: 99999,
    };
    await fs.writeFile(lockFile, JSON.stringify(staleLock, null, 2));

    const result = await lockManager.acquireLock('new-agent', 'new-session');
    expect(result.success).toBe(true);
    expect(result.lock?.agent_id).toBe('new-agent');
  });

  it('fresh lock by another agent is NOT overrideable without force', async () => {
    await lockManager.acquireLock('agent-X', 'session-X');
    const result = await lockManager.acquireLock('agent-Y', 'session-Y');
    expect(result.success).toBe(false);
  });

  it('fresh lock can be force-overridden', async () => {
    await lockManager.acquireLock('agent-X', 'session-X');
    const result = await lockManager.acquireLock('agent-Y', 'session-Y', /* force= */ true);
    expect(result.success).toBe(true);
    expect(result.lock?.agent_id).toBe('agent-Y');
  });

  it('isLockExpired returns true for stale lock', () => {
    const staleDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const staleLock = {
      agent_id: 'a',
      session_id: 's',
      acquired_at: staleDate,
      expires_at: staleDate,
      last_heartbeat: staleDate,
    };
    expect(lockManager.isLockExpired(staleLock)).toBe(true);
  });

  it('isLockExpired returns false for fresh lock', () => {
    const now = new Date();
    const future = new Date(now.getTime() + 30 * 60 * 1000);
    const freshLock = {
      agent_id: 'a',
      session_id: 's',
      acquired_at: now.toISOString(),
      expires_at: future.toISOString(),
      last_heartbeat: now.toISOString(),
    };
    expect(lockManager.isLockExpired(freshLock)).toBe(false);
  });

  it('released lock can be re-acquired', async () => {
    const r1 = await lockManager.acquireLock('agent-1', 'session-1');
    expect(r1.success).toBe(true);
    await lockManager.releaseLock('agent-1');
    const r2 = await lockManager.acquireLock('agent-2', 'session-2');
    expect(r2.success).toBe(true);
    expect(r2.lock?.agent_id).toBe('agent-2');
  });
});
