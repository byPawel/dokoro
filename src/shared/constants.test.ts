/**
 * Drift guard: DOKORO_VERSION is a hand-maintained constant (a runtime
 * package.json read breaks under the CJS/ESM split), so a version bump in
 * package.json without the matching constant update fails here — the server
 * banner once reported a stale "2.0.0" on a 0.x package, which sent a
 * misfiring `dokoro browse` diagnosis down the wrong path.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { DOKORO_VERSION } from './constants.js';

describe('DOKORO_VERSION', () => {
  it('matches package.json version', () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'),
    ) as { version: string };
    expect(DOKORO_VERSION).toBe(pkg.version);
  });
});
