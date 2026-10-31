import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

// Run the actual TypeScript color-harmony implementation without adding a
// testing framework or importing the heavyweight React/Tauri editor.
const source = await readFile(new URL('../src/utils/colorHarmony.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
const { ruleNodes, getHarmonyWidthMax, dominantHarmonyHues, HARMONY_RULES } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
);

const near = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `expected ${actual} to be near ${expected}`);

// The upper bound corresponds to 84%-ish Gaussian influence at the most
// weakly covered hue, independent of the number/arrangement of nodes.
for (const rule of HARMONY_RULES.filter((value) => value !== 'custom')) {
  const nodes = ruleNodes(rule, 0);
  const max = getHarmonyWidthMax(nodes);
  assert.ok(max >= 1.7 && max <= 4, `${rule}: max=${max}`);
  assert.ok(max > 1, `${rule}: no room to widen from default`);

  // The wheel sector must expand continuously and never hit the old 85°
  // plateau in the range exposed to users.
  const halfWidth = (max * 90) / nodes.length;
  assert.ok(halfWidth < 175, `${rule}: sector clips at the right end`);
}
near(getHarmonyWidthMax([0]), 1.7);
near(getHarmonyWidthMax([0, 180]), 1.7);
assert.ok(getHarmonyWidthMax([0, 110]) > getHarmonyWidthMax([0, 180]));
assert.ok(getHarmonyWidthMax([0, 10]) > getHarmonyWidthMax([0, 110]));
assert.ok(getHarmonyWidthMax([0, 15, 30, 45]) > getHarmonyWidthMax([0, 90, 180, 270]));
assert.equal(getHarmonyWidthMax([0, 0, 0, 0]), 4);
near(getHarmonyWidthMax([359, 179]), 1.7);

// Custom: take independent peaks, not just rotate a linked palette.
const histogram = Array(72).fill(0);
histogram[0] = 1;
histogram[24] = 0.75;
histogram[49] = 0.5;
histogram[65] = 0.3;
const picks = dominantHarmonyHues(histogram, 4);
assert.deepEqual(picks, [2.5, 122.5, 247.5, 327.5]);
assert.deepEqual(dominantHarmonyHues(histogram, 1), [2.5]);
assert.deepEqual(dominantHarmonyHues(histogram, 2), [2.5, 122.5]);
assert.deepEqual(dominantHarmonyHues(histogram, 3), [2.5, 122.5, 247.5]);

// Nearby bins, including across the 0°/360° seam, count as ONE color.
const wrapped = Array(72).fill(0);
wrapped[71] = 1;
wrapped[0] = 0.9;
wrapped[1] = 0.8;
wrapped[30] = 0.7;
const wrappedPicks = dominantHarmonyHues(wrapped, 4);
assert.equal(wrappedPicks.length, 2);
assert.ok(wrappedPicks.some((hue) => hue >= 350 || hue <= 10));
assert.ok(wrappedPicks.some((hue) => hue >= 145 && hue <= 160));

// Gray/no color: do not invent dominant hues to fill unused nodes.
assert.deepEqual(dominantHarmonyHues(Array(72).fill(0), 4), []);
assert.equal(dominantHarmonyHues([1, 2, 3], 2).length, 0);
assert.equal(dominantHarmonyHues(histogram, 0).length, 0);

console.log('Color harmonizer width and dominant-hue regression tests passed.');
