/**
 * scripts/run-tests.mjs
 *
 * Runs every scripts/test-*.mjs harness and reports a single pass/fail.
 *
 * The harnesses are plain node scripts with no framework: each prints its own
 * PASS/FAIL lines and exits non-zero on failure. This runner just discovers
 * them and aggregates, so adding a new test-*.mjs file needs no wiring here.
 *
 * Run with: npm test
 *
 * Note: node is not on PATH on Ravi's machine, it lives in a conda env. See
 * CLAUDE.md for the PATH prefix if npm appears to be missing.
 */

import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const SCRIPTS = path.resolve(import.meta.dirname);

function run(file) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(SCRIPTS, file)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Kept separate: the summary line is always on stdout, while harnesses
    // that deliberately simulate failures also write to stderr. Merging them
    // lets a stray warning masquerade as the result.
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ file, code, stdout, stderr }));
  });
}

const all = await readdir(SCRIPTS);
const tests = all.filter(f => f.startsWith('test-') && f.endsWith('.mjs')).sort();

if (tests.length === 0) {
  console.error('No scripts/test-*.mjs harnesses found.');
  process.exit(1);
}

const results = [];
for (const t of tests) results.push(await run(t));

console.log('');
let failed = 0;
for (const r of results) {
  const ok = r.code === 0;
  if (!ok) failed++;
  // Surface the harness's own summary line, which is the useful part.
  const summary = r.stdout.trim().split('\n').filter(Boolean).pop() || '(no output)';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.file.padEnd(26)} ${summary}`);
}

if (failed > 0) {
  console.log(`\n${failed} of ${tests.length} suites FAILED. Full output:\n`);
  for (const r of results) {
    if (r.code !== 0) console.log(`----- ${r.file} -----\n${r.stdout}${r.stderr}`);
  }
  process.exit(1);
}

console.log(`\nAll ${tests.length} suites passed.`);
