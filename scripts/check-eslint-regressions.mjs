#!/usr/bin/env node
/** Compare ESLint errors on the edited UI files against the upstream parent revision.
 *  Existing lint failures remain visible; only *new* issues fail this job.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';

const [feature, baseline] = process.argv.slice(2);
const files = [
  'src/components/adjustments/ColorHarmonizer.tsx',
  'src/components/adjustments/HarmonyRulePicker.tsx',
  'src/components/adjustments/AdjustmentSection.tsx',
  'src/utils/colorHarmony.ts',
  'src/utils/adjustments.ts',
  'src/components/ui/AppProperties.tsx',
  'src/store/useUIStore.ts',
  'src/components/panel/right/MasksPanel.tsx',
  'src/components/adjustments/AdjustmentSubSection.tsx',
  'src/components/adjustments/Color.tsx',
  'src/components/panel/right/ControlsPanel.tsx',
  'src/components/ui/Slider.tsx',
];
function inspect(directory) {
  const cmd = path.join(directory, 'node_modules', 'eslint', 'bin', 'eslint.js');
  const existingFiles = files.filter((file) => existsSync(path.join(directory, file)));
  const proc = spawnSync(process.execPath, [cmd, '--format', 'json', ...existingFiles], {
    cwd: directory,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (proc.error || (proc.status !== 0 && proc.status !== 1)) {
    throw new Error(`ESLint execution failed: ${proc.error || proc.stderr}`);
  }
  const output = JSON.parse(proc.stdout);
  const errors = new Map();
  for (const file of output) {
    const name = path.relative(directory, file.filePath);
    for (const problem of file.messages) {
      const key = [name, problem.ruleId ?? 'parse-error', problem.message, problem.severity].join('::');
      errors.set(key, (errors.get(key) || 0) + 1);
    }
  }
  return errors;
}

const old = inspect(baseline);
const now = inspect(feature);
const count = (map) => [...map.values()].reduce((a, b) => a + b, 0);
let added = 0;
for (const [key, occurrences] of now) {
  const diff = occurrences - (old.get(key) || 0);
  if (diff > 0) {
    added += diff;
    console.error(`New ESLint issue (x${diff}): ${key}`);
  }
}
console.log(`ESLint: baseline=${count(old)}, feature=${count(now)}, new=${added}`);
if (added > 0) process.exit(1);
