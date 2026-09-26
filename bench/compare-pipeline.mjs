#!/usr/bin/env node
// Diff two `RapidRAW bench --json` results. Exits 1 if any phase output differs.
//
// Usage:
//   node bench/compare-pipeline.mjs bench/out/pipeline-before.json bench/out/pipeline-after.json

import { readFileSync } from 'node:fs';

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error('Usage: node bench/compare-pipeline.mjs <before.json> <after.json>');
  process.exit(2);
}

const before = JSON.parse(readFileSync(beforePath, 'utf8'));
const after = JSON.parse(readFileSync(afterPath, 'utf8'));

function quantile(values, q) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.round((sorted.length - 1) * q)];
}

function totals(phase) {
  return phase.iterations.map((it) => it.total_ms);
}

function stageMeans(phase) {
  const sums = {};
  for (const it of phase.iterations) {
    for (const [name, ms] of Object.entries(it.stages)) sums[name] = (sums[name] ?? 0) + ms;
  }
  for (const name of Object.keys(sums)) sums[name] /= phase.iterations.length;
  return sums;
}

const fmtMs = (ms) => (Number.isNaN(ms) ? '-' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`);
const pad = (s, n) => String(s).padStart(n);

const phases = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) => !name.startsWith('_'));

// Runs are only comparable with the same image, GPU and output-affecting settings.
const beforeMeta = before._meta ?? {};
const afterMeta = after._meta ?? {};
if (!before._meta || !after._meta) {
  console.warn('Warning: a result has no _meta block, so its settings cannot be checked.\n');
} else {
  const differing = [...new Set([...Object.keys(beforeMeta), ...Object.keys(afterMeta)])].filter(
    (key) => JSON.stringify(beforeMeta[key]) !== JSON.stringify(afterMeta[key]),
  );
  for (const key of differing) {
    console.warn(`Warning: ${key} differs (${JSON.stringify(beforeMeta[key])} vs ${JSON.stringify(afterMeta[key])})`);
  }
  if (differing.length > 0) console.warn('Timings and output hashes are not comparable across these runs.\n');
}
let mismatches = 0;

console.log(
  `${'phase'.padEnd(10)} ${pad('before p50', 11)} ${pad('after p50', 11)} ${pad('before p90', 11)} ${pad('after p90', 11)} ${pad('speedup', 8)}  output`,
);
for (const name of phases) {
  const b = before[name];
  const a = after[name];
  const b50 = b ? quantile(totals(b), 0.5) : NaN;
  const a50 = a ? quantile(totals(a), 0.5) : NaN;
  const b90 = b ? quantile(totals(b), 0.9) : NaN;
  const a90 = a ? quantile(totals(a), 0.9) : NaN;
  const speedup = b && a ? `${(b50 / a50).toFixed(1)}x` : '-';

  let output = 'n/a';
  if (b?.output_blake3 && a?.output_blake3) {
    if (b.output_blake3 === a.output_blake3) {
      output = 'identical';
    } else {
      output = 'DIFFERENT';
      mismatches += 1;
    }
  }
  console.log(
    `${name.padEnd(10)} ${pad(fmtMs(b50), 11)} ${pad(fmtMs(a50), 11)} ${pad(fmtMs(b90), 11)} ${pad(fmtMs(a90), 11)} ${pad(speedup, 8)}  ${output}`,
  );
}

console.log('\nLargest stage changes (mean per iteration):');
for (const name of phases) {
  if (!before[name] || !after[name]) continue;
  const b = stageMeans(before[name]);
  const a = stageMeans(after[name]);
  const rows = [...new Set([...Object.keys(b), ...Object.keys(a)])]
    .map((stage) => ({ stage, b: b[stage] ?? 0, a: a[stage] ?? 0 }))
    .sort((x, y) => Math.abs(y.b - y.a) - Math.abs(x.b - x.a))
    .slice(0, 3)
    .filter((r) => Math.abs(r.b - r.a) >= 1);
  if (rows.length === 0) continue;
  console.log(`  ${name}`);
  for (const r of rows) console.log(`    ${r.stage.padEnd(32)} ${pad(fmtMs(r.b), 10)} -> ${pad(fmtMs(r.a), 10)}`);
}

if (mismatches > 0) {
  console.error(`\n${mismatches} phase(s) produced different output between the two builds.`);
  process.exit(1);
}
