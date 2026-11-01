#!/usr/bin/env node
/**
 * Compare compiler diagnostics in the feature branch against the upstream parent commit
 * of the feature branch. This does not hide pre-existing errors: it reports their
 * count, and FAILS if the branch adds any diagnostic absent from main.
 *
 * This is temporary until upstream's baseline TypeScript errors are resolved.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const [feature, baseline] = process.argv.slice(2);
if (!feature || !baseline) {
  console.error('Usage: node check-typecheck-regressions.mjs <feature> <baseline>');
  process.exit(2);
}

function collect(directory) {
  const tsc = path.join(directory, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(process.execPath, [tsc, '--noEmit', '--pretty', 'false'], {
    cwd: directory,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || (result.status !== 0 && result.status !== 2)) {
    throw new Error(`TypeScript invocation failed in ${directory}: ${result.error ?? result.stderr}`);
  }

  const errors = new Map();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^(.+?)\(\d+,\d+\): error TS(\d+): (.+)$/);
    if (!match) continue;
    // Ignore human-readable diagnostic text, which changes when i18next's
    // translated-key union grows; compare file + error code + multiplicity.
    const key = `${match[1]}: TS${match[2]}`;
    errors.set(key, (errors.get(key) || 0) + 1);
  }
  if (result.status !== 0 && errors.size === 0) {
    throw new Error(`TypeScript failed without parseable diagnostics in ${directory}: ${result.stdout.slice(0, 1000)}`);
  }
  return errors;
}

const oldErrors = collect(baseline);
const newErrors = collect(feature);
const sum = (entries) => [...entries.values()].reduce((a, b) => a + b, 0);
let regressions = 0;
for (const [key, count] of newErrors) {
  const diff = count - (oldErrors.get(key) || 0);
  if (diff > 0) {
    regressions += diff;
    console.error(`NEW (x${diff}): ${key}`);
  }
}
console.log(`TypeScript: baseline=${sum(oldErrors)} errors, feature=${sum(newErrors)} errors, new=${regressions}`);
if (regressions > 0) process.exit(1);
