import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { watchDirs, startPolling } from './browse-live.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('watchDirs', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dokoro-live-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('coalesces rapid writes into one dirty callback (debounce)', async () => {
    const onDirty = jest.fn();
    const handle = watchDirs([dir], onDirty, { debounceMs: 50, reconcileMs: 60_000 });
    await fs.writeFile(path.join(dir, 'a.md'), '1');
    await fs.writeFile(path.join(dir, 'a.md'), '2');
    await fs.writeFile(path.join(dir, 'b.md'), '3');
    await sleep(300);
    handle.stop();
    expect(onDirty).toHaveBeenCalledTimes(1);
  });

  it('survives atomic temp+rename writes (the MCP write pattern)', async () => {
    const onDirty = jest.fn();
    const handle = watchDirs([dir], onDirty, { debounceMs: 30, reconcileMs: 60_000 });
    const tmp = path.join(dir, 'plan.json.tmp');
    await fs.writeFile(tmp, '{"x":1}');
    await fs.rename(tmp, path.join(dir, 'plan.json'));
    await sleep(200);
    handle.stop();
    expect(onDirty).toHaveBeenCalled();
  });

  it('ignores missing directories instead of throwing', () => {
    const handle = watchDirs([path.join(dir, 'nope')], jest.fn());
    handle.stop();
  });

  it('fires no callbacks after stop()', async () => {
    const onDirty = jest.fn();
    const handle = watchDirs([dir], onDirty, { debounceMs: 30, reconcileMs: 60_000 });
    handle.stop();
    await fs.writeFile(path.join(dir, 'late.md'), 'x');
    await sleep(150);
    expect(onDirty).not.toHaveBeenCalled();
  });

  it('reconcile tick fires without any fs events', async () => {
    const onDirty = jest.fn();
    const handle = watchDirs([dir], onDirty, { debounceMs: 30, reconcileMs: 80 });
    await sleep(300);
    handle.stop();
    expect(onDirty.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('startPolling', () => {
  it('ticks repeatedly and never overlaps a slow tick', async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const handle = startPolling(20, async () => {
      active++; runs++;
      maxActive = Math.max(maxActive, active);
      await sleep(50);
      active--;
    });
    await sleep(300);
    handle.stop();
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(maxActive).toBe(1);
  });

  it('swallows tick errors and keeps polling', async () => {
    let runs = 0;
    const handle = startPolling(15, async () => {
      runs++;
      throw new Error('boom');
    });
    await sleep(120);
    handle.stop();
    expect(runs).toBeGreaterThanOrEqual(2);
  });

  it('stops cleanly', async () => {
    let runs = 0;
    const handle = startPolling(15, async () => { runs++; });
    await sleep(60);
    handle.stop();
    const after = runs;
    await sleep(80);
    expect(runs).toBe(after);
  });
});
