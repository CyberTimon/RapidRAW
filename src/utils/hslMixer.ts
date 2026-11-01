export const HSL_MIXER_BANDS = [
  'reds',
  'oranges',
  'yellows',
  'greens',
  'aquas',
  'blues',
  'purples',
  'magentas',
] as const;

export type HslMixerBand = (typeof HSL_MIXER_BANDS)[number];
export type HslMixerProperty = 'hue' | 'saturation' | 'luminance';
export type HslPresence = Partial<Record<HslMixerBand, number>>;
export type HslPresenceMode = HslMixerProperty | 'monochrome';

const HSL_RANGES: Array<[number, number]> = [
  [358, 35],
  [25, 45],
  [60, 40],
  [115, 90],
  [180, 60],
  [225, 60],
  [280, 55],
  [330, 50],
];

const MIN_PRESENCE = 0.03;

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
};

const bandInfluence = (hue: number, center: number, width: number) => {
  const dist = Math.min(Math.abs(hue - center), 360 - Math.abs(hue - center));
  const falloff = dist / (width * 0.5);
  return Math.exp(-1.5 * falloff * falloff);
};

const presenceGate = (saturation: number, value: number, mode: HslPresenceMode) => {
  if (mode === 'monochrome') return smoothstep(0.05, 0.4, saturation) * smoothstep(0, 0.1, saturation * value);
  if (mode === 'luminance') return smoothstep(0, 1, saturation);
  return smoothstep(0.05, 0.2, saturation);
};

const hslBandWeights = (hue: number, saturation: number, value: number, mode: HslPresenceMode): number[] => {
  const gate = presenceGate(saturation, value, mode);
  const raw = HSL_RANGES.map(([center, width]) => bandInfluence(hue, center, width));
  const total = raw.reduce((sum, v) => sum + v, 0);
  return raw.map((v) => (v / total) * gate);
};

export const sampleHslPresence = (probe: Uint8Array, mode: HslPresenceMode): HslPresence => {
  const totals = HSL_RANGES.map(() => 0);
  const count = probe.length / 4;
  for (let i = 0; i < probe.length; i += 4) {
    hslBandWeights((probe[i] / 255) * 360, probe[i + 1] / 255, probe[i + 2] / 255, mode).forEach((w, band) => {
      totals[band] += w;
    });
  }
  const max = Math.max(...totals);
  const presence: HslPresence = {};
  if (count === 0 || max / count < MIN_PRESENCE) return presence;
  HSL_MIXER_BANDS.forEach((band, i) => {
    if (totals[i] / max >= MIN_PRESENCE) presence[band] = totals[i] / max;
  });
  return presence;
};
