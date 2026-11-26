import { ClipItem, Equalizer } from '../../types/video';

export const SAMPLE_RATE = 48000;
export const MIN_HZ = 20;
export const MAX_HZ = 20000;
export const MAX_EQ_DB = 12;
export const MAX_LOW_CUT_HZ = 300;
export const MIN_HIGH_CUT_HZ = 2000;

export type Sound = Pick<ClipItem, 'eq' | 'lowCut' | 'highCut' | 'compress' | 'denoise'>;
export type EqBand = keyof Equalizer;

export const EQ_BANDS: Array<EqBand> = ['low', 'mid', 'high'];
export const BAND_HZ: Record<EqBand, number> = { low: 110, mid: 1000, high: 7000 };

const SHELF_Q = 0.6;
const PEAK_Q = 0.8;
const CUT_Q = 0.707;
const MIN_COMPRESS_THRESHOLD_DB = -12;
const MAX_COMPRESS_THRESHOLD_DB = -30;
const MAX_COMPRESS_RATIO = 6;
const COMPRESS_KNEE = 2.82843;

type Coefficients = [number, number, number];

interface Biquad {
  b: Coefficients;
  a: Coefficients;
}

type BiquadKind = 'highpass' | 'lowpass' | 'bass' | 'equalizer' | 'treble';

const biquad = (kind: BiquadKind, frequency: number, q: number, gain = 0): Biquad => {
  const amplitude = 10 ** (gain / 40);
  const w0 = (2 * Math.PI * frequency) / SAMPLE_RATE;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const beta = Math.sqrt(2 * amplitude) * alpha;
  const up = amplitude + 1;
  const down = amplitude - 1;
  switch (kind) {
    case 'highpass':
      return { b: [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2], a: [1 + alpha, -2 * cos, 1 - alpha] };
    case 'lowpass':
      return { b: [(1 - cos) / 2, 1 - cos, (1 - cos) / 2], a: [1 + alpha, -2 * cos, 1 - alpha] };
    case 'equalizer':
      return {
        b: [1 + alpha * amplitude, -2 * cos, 1 - alpha * amplitude],
        a: [1 + alpha / amplitude, -2 * cos, 1 - alpha / amplitude],
      };
    case 'bass':
      return {
        b: [
          amplitude * (up - down * cos + beta),
          2 * amplitude * (down - up * cos),
          amplitude * (up - down * cos - beta),
        ],
        a: [up + down * cos + beta, -2 * (down + up * cos), up + down * cos - beta],
      };
    case 'treble':
      return {
        b: [
          amplitude * (up + down * cos + beta),
          -2 * amplitude * (down + up * cos),
          amplitude * (up + down * cos - beta),
        ],
        a: [up - down * cos + beta, 2 * (down - up * cos), up - down * cos - beta],
      };
  }
};

export const soundFilters = (sound: Sound): Array<Biquad> => {
  const filters: Array<Biquad> = [];
  if ((sound.lowCut ?? 0) > 0) filters.push(biquad('highpass', sound.lowCut!, CUT_Q));
  if ((sound.highCut ?? 0) > 0) filters.push(biquad('lowpass', sound.highCut!, CUT_Q));
  const eq = sound.eq;
  if (eq?.low) filters.push(biquad('bass', BAND_HZ.low, SHELF_Q, eq.low));
  if (eq?.mid) filters.push(biquad('equalizer', BAND_HZ.mid, PEAK_Q, eq.mid));
  if (eq?.high) filters.push(biquad('treble', BAND_HZ.high, SHELF_Q, eq.high));
  return filters;
};

export const responseDb = (filters: Array<Biquad>, frequency: number) => {
  const w = (2 * Math.PI * frequency) / SAMPLE_RATE;
  const [cos1, sin1, cos2, sin2] = [Math.cos(w), Math.sin(w), Math.cos(2 * w), Math.sin(2 * w)];
  const power = ([c0, c1, c2]: Coefficients) => (c0 + c1 * cos1 + c2 * cos2) ** 2 + (c1 * sin1 + c2 * sin2) ** 2;
  return filters.reduce((gain, { b, a }) => gain + 10 * Math.log10(power(b) / power(a)), 0);
};

export const formatDb = (value: number) =>
  value === 0 ? '0 dB' : `${value > 0 ? '+' : '−'}${Math.abs(value).toFixed(1)} dB`;

const MIN_VOLUME_DB = -40;
const SILENCE = '−∞';

export const gainToDb = (gain: number) => (gain > 0 ? Math.max(MIN_VOLUME_DB, 20 * Math.log10(gain)) : MIN_VOLUME_DB);
export const dbToGain = (db: number) => (db <= MIN_VOLUME_DB ? 0 : 10 ** (db / 20));

export const formatGain = (gain: number) => (gain > 0 ? formatDb(20 * Math.log10(gain)) : `${SILENCE} dB`);

export const VOLUME_SLIDER = {
  min: MIN_VOLUME_DB,
  max: 6,
  step: 0.5,
  defaultValue: 0,
  suffix: ' dB',
  minLabel: SILENCE,
};

export const GAIN_DB = { toDisplay: gainToDb, fromDisplay: dbToGain };

export const isNeutralSound = (sound: Sound) =>
  !sound.lowCut && !sound.highCut && !sound.eq?.low && !sound.eq?.mid && !sound.eq?.high;

export const frequencyToUnit = (frequency: number) => Math.log(frequency / MIN_HZ) / Math.log(MAX_HZ / MIN_HZ);
export const unitToFrequency = (unit: number) => MIN_HZ * (MAX_HZ / MIN_HZ) ** unit;

interface Compressor {
  threshold: number;
  ratio: number;
  makeup: number;
}

export const compressorOf = (amount: number): Compressor => {
  const clamped = Math.min(1, Math.max(0, amount));
  const threshold = MIN_COMPRESS_THRESHOLD_DB + (MAX_COMPRESS_THRESHOLD_DB - MIN_COMPRESS_THRESHOLD_DB) * clamped;
  const ratio = 1 + (MAX_COMPRESS_RATIO - 1) * clamped;
  return { threshold, ratio, makeup: -threshold * (1 - 1 / ratio) * 0.5 };
};

const hermite = (x: number, x0: number, x1: number, p0: number, p1: number, m0: number, m1: number) => {
  const width = x1 - x0;
  const t = (x - x0) / width;
  const [s0, s1] = [m0 * width, m1 * width];
  return (2 * p0 + s0 - 2 * p1 + s1) * t ** 3 + (-3 * p0 - 2 * s0 + 3 * p1 - s1) * t ** 2 + s0 * t + p0;
};

export const compressedDb = ({ threshold, ratio, makeup }: Compressor, inputDb: number) => {
  const toLog = Math.LN10 / 20;
  const level = inputDb * toLog;
  const thres = threshold * toLog;
  const kneeStart = thres - Math.log(COMPRESS_KNEE) / 2;
  const kneeStop = thres + Math.log(COMPRESS_KNEE) / 2;
  if (ratio <= 1 || level <= kneeStart) return inputDb + makeup;
  const output =
    level < kneeStop
      ? hermite(level, kneeStart, kneeStop, kneeStart, (kneeStop - thres) / ratio + thres, 1, 1 / ratio)
      : (level - thres) / ratio + thres;
  return output / toLog + makeup;
};
