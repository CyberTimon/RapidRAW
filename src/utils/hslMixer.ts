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

const rgbToHueSat = (r: number, g: number, b: number): [number, number] => {
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let hue = 0;
  if (delta > 0) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;
  return [hue, max > 0 ? delta / max : 0];
};

const bandInfluence = (hue: number, center: number, width: number) => {
  const dist = Math.min(Math.abs(hue - center), 360 - Math.abs(hue - center));
  const falloff = dist / (width * 0.5);
  return Math.exp(-1.5 * falloff * falloff);
};

export const hslBandWeights = (r: number, g: number, b: number, property: HslMixerProperty): number[] => {
  if (Math.abs(r - g) < 0.001 && Math.abs(g - b) < 0.001) return HSL_RANGES.map(() => 0);
  const [hue, saturation] = rgbToHueSat(Math.max(r, 0), Math.max(g, 0), Math.max(b, 0));
  const gate = property === 'luminance' ? smoothstep(0, 1, saturation) : smoothstep(0.05, 0.2, saturation);
  const raw = HSL_RANGES.map(([center, width]) => bandInfluence(hue, center, width));
  const total = raw.reduce((sum, v) => sum + v, 0);
  return raw.map((v) => (v / total) * gate);
};

export const sampleHslPresence = (rgba: Uint8ClampedArray, property: HslMixerProperty): HslPresence => {
  const totals = HSL_RANGES.map(() => 0);
  const count = rgba.length / 4;
  for (let i = 0; i < rgba.length; i += 4) {
    hslBandWeights(rgba[i] / 255, rgba[i + 1] / 255, rgba[i + 2] / 255, property).forEach((w, band) => {
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
