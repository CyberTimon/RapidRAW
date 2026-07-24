#!/usr/bin/env node
// Diff two bench/replay.js result JSONs.
//
// Usage:
//   node bench/analyze.mjs bench/out/before.json
//   node bench/analyze.mjs bench/out/before.json bench/out/after.json

import { readFileSync } from 'node:fs';

const START_MARKER = 'BENCH_RESULT_JSON_START';
const END_MARKER = 'BENCH_RESULT_JSON_END';

const PHASES = ['scroll', 'open', 'edit'];
const METRICS = [
  ['durationMs', 'ms', false],
  ['avgFps', 'fps', true],
  ['worstFrameMs', 'ms', false],
  ['droppedFrameCount', '', false],
  ['droppedFrameTimeMs', 'ms', false],
];

// Tolerate pasting the raw devtools console pane instead of just the JSON:
// strips "[Log] " prefixes, "(file.ts, line N)" source-location suffixes
// devtools appends to each log line, and REPL echo lines (e.g. the
// "< Promise {...}" devtools prints for the pasted async IIFE's return
// value). Also slices out just the BENCH_RESULT_JSON_START/END span if
// present, so noise before/after (like the "copied to clipboard" log) is
// ignored automatically.
function extractJson(raw) {
  const startIdx = raw.indexOf(START_MARKER);
  const endIdx = raw.indexOf(END_MARKER);
  const body =
    startIdx !== -1 && endIdx !== -1 && endIdx > startIdx
      ? raw.slice(startIdx + START_MARKER.length, endIdx)
      : raw;

  return body
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*<.*$/, '')
        .replace(/^\[(?:Log|Info|Debug|Warn|Error)\]\s?/, '')
        .replace(/\s*\([^()]*,\s*line\s*\d+\)\s*$/i, ''),
    )
    .join('\n')
    .trim();
}

function load(path) {
  const raw = readFileSync(path, 'utf8');
  const jsonText = extractJson(raw);
  try {
    return JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `could not parse ${path} as JSON, even after stripping devtools console noise (${err.message})`,
    );
  }
}

function pct(a, b) {
  if (a === 0) return 'n/a';
  return `${(((b - a) / a) * 100).toFixed(1)}%`.replace(/^(?!-)/, '+');
}

function fmt(v, unit) {
  return `${v.toFixed(1)}${unit ? ' ' + unit : ''}`;
}

function reportSingle(path, r) {
  console.log(`=== ${path}`);
  console.log(`  user agent: ${r.userAgent}`);
  const vp = r.viewport;
  console.log(`  viewport: ${vp.width}x${vp.height} @ dpr ${vp.devicePixelRatio}`);
  const n = r.iterations.filter((it) => !it.warmup).length;
  console.log(`  measured iterations: ${n} (+ ${r.config.warmupIterations} warmup, discarded)`);
  for (const phase of PHASES) {
    console.log(`  [${phase}]`);
    for (const [metric, unit] of METRICS) {
      const s = r.summary[phase][metric];
      console.log(
        `    ${metric}: median ${fmt(s.median, unit)}, p95 ${fmt(s.p95, unit)}, stdev ${fmt(s.stdev, unit)}`,
      );
    }
  }
  console.log();
}

function checkEnvironmentMatch(pathA, a, pathB, b) {
  const va = a.viewport;
  const vb = b.viewport;
  if (va.width !== vb.width || va.height !== vb.height || va.devicePixelRatio !== vb.devicePixelRatio) {
    console.log(
      `WARNING: viewport differs between runs (${pathA}: ${va.width}x${va.height}@${va.devicePixelRatio} vs ` +
        `${pathB}: ${vb.width}x${vb.height}@${vb.devicePixelRatio}). Slider pixel-deltas map to different ` +
        `value-deltas at different sizes -- these results are not comparable. Re-run both at the same window size.`,
    );
    console.log();
  }
}

function reportDiff(pathA, a, pathB, b) {
  reportSingle(pathA, a);
  reportSingle(pathB, b);
  checkEnvironmentMatch(pathA, a, pathB, b);

  console.log('=== diff (before -> after), median values');
  for (const phase of PHASES) {
    console.log(`  [${phase}]`);
    for (const [metric, unit, higherIsBetter] of METRICS) {
      const av = a.summary[phase][metric].median;
      const bv = b.summary[phase][metric].median;
      const change = pct(av, bv);
      const flag = higherIsBetter ? (bv < av ? ' (worse)' : bv > av ? ' (better)' : '') : bv > av ? ' (worse)' : bv < av ? ' (better)' : '';
      console.log(`    ${metric}: ${fmt(av, unit)} -> ${fmt(bv, unit)}  (${change})${flag}`);
    }
  }
}

const [, , pathA, pathB] = process.argv;
if (!pathA) {
  console.log('Usage: node bench/analyze.mjs <result.json> [other-result.json]');
  process.exit(1);
}

if (!pathB) {
  reportSingle(pathA, load(pathA));
} else {
  reportDiff(pathA, load(pathA), pathB, load(pathB));
}
