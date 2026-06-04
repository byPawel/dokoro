#!/usr/bin/env node
/**
 * Devlog CLI Entry Point
 *
 * This is the bin entry that gets installed when you npm install -g @dokoro-mcp/core
 * It delegates to the TypeScript CLI via tsx.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the CLI source
const cliPath = join(__dirname, '..', 'src', 'dokoro-cli.ts');

// Run via tsx
const child = spawn('npx', ['tsx', cliPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
