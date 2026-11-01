import type { ColorHarmonySettings, HarmonyRule } from './adjustments';

export const HARMONY_RULES: HarmonyRule[] = [
  'monochromatic',
  'analogous',
  'analogousComplementary',
  'complementary',
  'splitComplementary',
  'dyad',
  'triad',
  'tetrad',
  'square',
  'custom',
];

// Angles in perceptual OKLCH hue space. Unlike darktable's RYB guides these
// offsets are not RYB-warped; they are the true angles used by our GPU kernel.
export const HARMONY_OFFSETS: Record<Exclude<HarmonyRule, 'custom'>, number[]> = {
  monochromatic: [0],
  analogous: [-30, 0, 30],
  analogousComplementary: [-30, 0, 30, 180],
  complementary: [0, 180],
  splitComplementary: [0, 150, 210],
  dyad: [-30, 30],
  triad: [0, 120, 240],
  tetrad: [-30, 30, 150, 210],
  square: [0, 90, 180, 270],
};

export const wrapHue = (angle: number): number => ((angle % 360) + 360) % 360;

export function ruleNodes(rule: Exclude<HarmonyRule, 'custom'>, anchor: number): number[] {
  return HARMONY_OFFSETS[rule].map((angle) => wrapHue(anchor + angle));
}

export function setHarmonyRule(harmony: ColorHarmonySettings, rule: HarmonyRule): ColorHarmonySettings {
  if (rule === 'custom') {
    return { ...harmony, rule, nodes: [...harmony.nodes], nodeSaturation: [...harmony.nodeSaturation] };
  }
  return { ...harmony, rule, nodes: ruleNodes(rule, harmony.anchor) };
}

export function rotateHarmony(harmony: ColorHarmonySettings, angle: number): ColorHarmonySettings {
  const anchor = wrapHue(angle);
  if (harmony.rule === 'custom') {
    const difference = ((anchor - harmony.anchor + 540) % 360) - 180;
    return { ...harmony, anchor, nodes: harmony.nodes.map((hue) => wrapHue(hue + difference)) };
  }
  return { ...harmony, anchor, nodes: ruleNodes(harmony.rule, anchor) };
}

export function moveHarmonyNode(harmony: ColorHarmonySettings, index: number, angle: number): ColorHarmonySettings {
  const nodes = [...harmony.nodes];
  nodes[index] = wrapHue(angle);
  // Dragging a node detaches from the symmetry pattern without moving others.
  return { ...harmony, rule: 'custom', nodes };
}

/**
 * Cap the Gaussian pull width using the largest gap between hue nodes.
 * This preserves a useful falloff and leaves older saved values untouched.
 */
export function getHarmonyWidthMax(nodes: number[]): number {
  const sorted = nodes
    .filter(Number.isFinite)
    .map(wrapHue)
    .sort((a, b) => a - b);
  const count = sorted.length;
  if (count <= 1) return 1.7;

  let largestGap = 0;
  for (let i = 0; i < count; i++) {
    const next = i + 1 < count ? sorted[i + 1] : sorted[0] + 360;
    largestGap = Math.max(largestGap, next - sorted[i]);
  }
  return Math.min(4, Math.max(1.7, (1.7 * largestGap * count) / 360));
}

/**
 * Rank separate peaks in the circular 72-bin source histogram.
 * A 30° exclusion radius avoids using neighboring bins for multiple nodes.
 */
export function dominantHarmonyHues(histogram: number[], desiredCount: number): number[] {
  const binCount = 72;
  if (histogram.length !== binCount || desiredCount <= 0) return [];

  const bins = histogram.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  const sample = (index: number) => bins[(index + binCount) % binCount];
  const smoothed = bins.map(
    (_, i) => sample(i) * 0.4 + (sample(i - 1) + sample(i + 1)) * 0.25 + (sample(i - 2) + sample(i + 2)) * 0.05,
  );
  const peakStrength = Math.max(...smoothed);
  if (peakStrength <= 0) return [];

  const candidates = smoothed
    .map((strength, index) => ({ strength, index }))
    .filter(
      ({ strength, index }) =>
        strength >= peakStrength * 0.01 &&
        strength >= smoothed[(index + binCount - 1) % binCount] &&
        strength >= smoothed[(index + 1) % binCount],
    )
    .sort((a, b) => b.strength - a.strength || a.index - b.index);

  const chosen: number[] = [];
  for (const { index } of candidates) {
    if (chosen.every((other) => Math.min(Math.abs(index - other), binCount - Math.abs(index - other)) >= 6)) {
      chosen.push(index);
      if (chosen.length >= Math.min(4, desiredCount)) break;
    }
  }

  return chosen.map((index) => wrapHue((index + 0.5) * 5));
}
