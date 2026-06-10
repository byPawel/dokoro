/**
 * findDailyFiles: filename-format compatibility.
 *
 * Daily session dumps switched to the shared UTC timestamp slug
 * (formatTimestampSlug). findDailyFiles selects files by their `YYYY-MM-DD`
 * filename prefix, so it must keep matching BOTH:
 *  - old-format files written before the change (weekday possibly from the
 *    LOCAL timezone, e.g. `2026-06-08-23h55-monday-...` near UTC midnight), and
 *  - new-format files where the weekday always agrees with the UTC date.
 *
 * Strategy: DOKORO_PATH is captured at module import time, so we point
 * process.env.DOKORO_PATH at a temp dir and load a fresh module instance via
 * jest.isolateModules() (same pattern as context-inspect-tools.test.ts).
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

type CompressionModule = typeof import('./compression-tool.js');

let tmpDir: string;
let mod: CompressionModule;

function freshModule(): Promise<CompressionModule> {
  return new Promise<CompressionModule>((resolve) => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      resolve(require('./compression-tool.js') as CompressionModule);
    });
  });
}

describe('findDailyFiles', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dokoro-compress-test-'));
    process.env['DOKORO_PATH'] = tmpDir;
    await fs.mkdir(path.join(tmpDir, 'daily'), { recursive: true });
    mod = await freshModule();
  });

  afterEach(async () => {
    delete process.env['DOKORO_PATH'];
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function touchDaily(name: string): Promise<void> {
    await fs.writeFile(path.join(tmpDir, 'daily', name), '# stub\n');
  }

  it('matches old-format (local-TZ weekday) and new-format (UTC slug) files by date prefix', async () => {
    // Old format: weekday came from toLocaleDateString and could disagree
    // with the UTC date (2026-06-08 is a Monday; "sunday" simulates the skew).
    await touchDaily('2026-06-08-23h55-sunday-session-old-format.md');
    // New format: formatTimestampSlug — weekday consistent with UTC date.
    await touchDaily('2026-06-09-10h15-tuesday-session-new-format.md');
    // Plan validation report with the new slug prefix also lives in daily/.
    await touchDaily('2026-06-10-08h00-wednesday-validation-plan-abc123.md');
    // Outside the window: must be excluded.
    await touchDaily('2026-06-15-09h00-monday-session-next-week.md');
    // No date prefix: must be ignored.
    await touchDaily('notes-without-date-prefix.md');

    const files = await mod.findDailyFiles(new Date('2026-06-08'), new Date('2026-06-14'));
    const names = files.map((f) => path.basename(f)).sort();

    expect(names).toEqual([
      '2026-06-08-23h55-sunday-session-old-format.md',
      '2026-06-09-10h15-tuesday-session-new-format.md',
      '2026-06-10-08h00-wednesday-validation-plan-abc123.md',
    ]);
  });

  it('is inclusive of both window boundaries', async () => {
    await touchDaily('2026-06-08-00h01-monday-session-start.md');
    await touchDaily('2026-06-14-23h59-sunday-session-end.md');

    const files = await mod.findDailyFiles(new Date('2026-06-08'), new Date('2026-06-14'));
    expect(files.map((f) => path.basename(f)).sort()).toEqual([
      '2026-06-08-00h01-monday-session-start.md',
      '2026-06-14-23h59-sunday-session-end.md',
    ]);
  });
});
