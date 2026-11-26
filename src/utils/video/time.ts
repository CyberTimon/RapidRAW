import { FrameRate, TICKS_PER_SECOND, Ticks } from '../../types/video';

const NTSC_RATES = [24, 30, 48, 60, 120];

export const DEFAULT_FPS: FrameRate = { num: 30, den: 1 };

export const secondsToTicks = (seconds: number): Ticks => Math.round(seconds * TICKS_PER_SECOND);

export const ticksToSeconds = (ticks: Ticks) => ticks / TICKS_PER_SECOND;

export const fpsValue = (fps: FrameRate) => fps.num / Math.max(1, fps.den);

export const rateFromNumber = (value: number): FrameRate => {
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) < 0.005) return { num: Math.max(1, rounded), den: 1 };
  const ntsc = NTSC_RATES.find((rate) => Math.abs(value - (rate * 1000) / 1001) < 0.01);
  if (ntsc) return { num: ntsc * 1000, den: 1001 };
  return { num: Math.round(value * 1000), den: 1000 };
};

export const sameRate = (a: FrameRate, b: FrameRate) => a.num * b.den === b.num * a.den;

export const FRAME_RATES: Array<{ label: string; rate: FrameRate }> = [
  { label: '23.976', rate: { num: 24000, den: 1001 } },
  { label: '24', rate: { num: 24, den: 1 } },
  { label: '25', rate: { num: 25, den: 1 } },
  { label: '29.97', rate: { num: 30000, den: 1001 } },
  { label: '30', rate: { num: 30, den: 1 } },
  { label: '50', rate: { num: 50, den: 1 } },
  { label: '59.94', rate: { num: 60000, den: 1001 } },
  { label: '60', rate: { num: 60, den: 1 } },
];

export const roundFps = (fps: number) => String(Math.round(fps * 1000) / 1000);

export const fpsLabel = (fps: FrameRate) =>
  FRAME_RATES.find((entry) => sameRate(entry.rate, fps))?.label ?? roundFps(fpsValue(fps));

export const toFrame = (ticks: Ticks, fps: FrameRate) =>
  Math.round((ticks * fps.num) / (TICKS_PER_SECOND * Math.max(1, fps.den)));

export const fromFrame = (frame: number, fps: FrameRate): Ticks =>
  Math.round((frame * TICKS_PER_SECOND * fps.den) / Math.max(1, fps.num));

export const frameTicks = (fps: FrameRate): Ticks => fromFrame(1, fps);

export const snapTicks = (ticks: Ticks, fps: FrameRate): Ticks => fromFrame(toFrame(ticks, fps), fps);

export const pad = (value: number, length = 2) => String(value).padStart(length, '0');

const timecodeParts = (ticks: Ticks, fps: FrameRate) => {
  const rate = Math.max(1, Math.round(fpsValue(fps)));
  const totalFrames = Math.max(0, toFrame(ticks, fps));
  const totalSeconds = Math.floor(totalFrames / rate);
  const totalMinutes = Math.floor(totalSeconds / 60);
  return {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
    seconds: totalSeconds % 60,
    frames: totalFrames % rate,
  };
};

export const formatTimecode = (ticks: Ticks, fps: FrameRate) => {
  const { hours, minutes, seconds, frames } = timecodeParts(ticks, fps);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
};

export const parseTimecode = (text: string, fps: FrameRate): Ticks | null => {
  const parts = text.trim().split(/[:;.]/);
  if (parts.length > 4 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const [frames = 0, seconds = 0, minutes = 0, hours = 0] = parts.map(Number).reverse();
  const rate = Math.max(1, Math.round(fpsValue(fps)));
  return fromFrame(((hours * 60 + minutes) * 60 + seconds) * rate + frames, fps);
};

export const formatRulerTime = (ticks: Ticks, fps: FrameRate, withFrames: boolean) => {
  const { hours, minutes, seconds, frames } = timecodeParts(ticks, fps);
  const clock = hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
  return withFrames ? `${clock}:${pad(frames)}` : clock;
};

const unit = (value: number | string, symbol: string) => `${value}\u00a0${symbol}`;

export const formatDuration = (ticks: Ticks) => {
  const tenths = Math.round(Math.max(0, ticksToSeconds(ticks)) * 10);
  if (tenths < 600) return unit((tenths / 10).toFixed(1), 's');
  const seconds = Math.round(tenths / 10);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${unit(minutes, 'min')} ${unit(seconds % 60, 's')}`;
  return `${unit(Math.floor(minutes / 60), 'h')} ${unit(minutes % 60, 'min')}`;
};
