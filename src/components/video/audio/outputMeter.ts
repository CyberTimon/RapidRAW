import { RefObject, useEffect } from 'react';
import { AudioTap, timelineAudio } from '../../../utils/video/audio';
import { OutputMeter } from '../../../utils/video/audioMeter';
import { SAMPLE_RATE, unitToFrequency } from '../../../utils/video/sound';
import { getVideo, useVideoStore } from '../../../store/useVideoStore';

const FRAME_MS = 15;
const SPECTRUM_MS = 33;
const MAX_FRAME_SECONDS = 0.25;
const SETTLE_MS = 2000;
const SPECTRUM_COLUMN_PX = 2;
const SPECTRUM_TILT_DB_PER_OCTAVE = 3;
const SPECTRUM_PIVOT_HZ = 1000;

export interface OutputFrame {
  meter: OutputMeter;
  spectrum: Float32Array | null;
  fresh: boolean;
  live: boolean;
}

type OutputDraw = (frame: OutputFrame) => void;

let request = 0;
let lastFrame = 0;
let stoppedAt: number | null = null;
let live = false;
let focused: string | null = null;

class OutputFeed {
  private readonly meter = new OutputMeter();
  private readonly spectrum = new Float32Array(timelineAudio.spectrumBins);
  private lastTime: number | null = null;
  private spectrumAt: number | null = null;

  constructor(private readonly tap: AudioTap) {}

  frame(fresh: boolean): OutputFrame {
    return { meter: this.meter, spectrum: live && this.spectrumAt !== null ? this.spectrum : null, fresh, live };
  }

  reset() {
    this.meter.reset();
    this.lastTime = null;
  }

  measure(playing: boolean, elapsed: number) {
    const capture = playing ? timelineAudio.captureOutput(this.tap) : null;
    if (capture) {
      const length = capture.channels[0].length;
      const added =
        this.lastTime === null
          ? 0
          : Math.min(length, Math.max(0, Math.round((capture.time - this.lastTime) * SAMPLE_RATE)));
      this.lastTime = capture.time;
      this.meter.push(capture.channels, length - added, added, elapsed);
    } else {
      this.lastTime = null;
      this.meter.fall(live ? elapsed : Infinity);
    }
  }

  refreshSpectrum(now: number) {
    if (!live) {
      this.spectrumAt = null;
      return true;
    }
    if (this.spectrumAt !== null && now - this.spectrumAt < SPECTRUM_MS) return false;
    if (!timelineAudio.captureSpectrum(this.tap, this.spectrum)) return false;
    this.spectrumAt = now;
    return true;
  }
}

const feeds: Record<AudioTap, OutputFeed> = { mix: new OutputFeed('mix'), clip: new OutputFeed('clip') };
const draws = new Map<OutputDraw, string | null>();
const tapOf = (item: string | null): AudioTap => (item === null ? 'mix' : 'clip');

const tick = (now: number) => {
  request = 0;
  const playing = getVideo().isPlaying;
  stoppedAt = playing ? null : (stoppedAt ?? now);
  live = playing || now - stoppedAt! < SETTLE_MS;
  if (now - lastFrame >= FRAME_MS || !live) {
    const elapsed = Math.min(MAX_FRAME_SECONDS, (now - lastFrame) / 1000);
    lastFrame = now;
    feeds.mix.measure(playing, elapsed);
    feeds.clip.measure(playing, elapsed);
    const frames: Partial<Record<AudioTap, OutputFrame>> = {};
    draws.forEach((item, draw) => {
      const tap = tapOf(item);
      draw((frames[tap] ??= feeds[tap].frame(feeds[tap].refreshSpectrum(now))));
    });
  }
  if (live && draws.size > 0) request = requestAnimationFrame(tick);
};

const wake = () => {
  if (request === 0 && draws.size > 0) request = requestAnimationFrame(tick);
};

useVideoStore.subscribe((state, previous) => {
  const started = state.isPlaying && !previous.isPlaying;
  if (!started && state.session === previous.session) return;
  feeds.mix.reset();
  feeds.clip.reset();
  wake();
});

const refocus = () => {
  const item = [...draws.values()].reverse().find((entry) => entry !== null) ?? null;
  if (item === focused) return;
  focused = item;
  feeds.clip.reset();
  timelineAudio.focus(item);
};

export const redrawOutput = (draw: OutputDraw) => {
  const item = draws.get(draw);
  if (item !== undefined) draw(feeds[tapOf(item)].frame(true));
};

const attach = (draw: OutputDraw, item: string | null) => {
  draws.set(draw, item);
  refocus();
  redrawOutput(draw);
  wake();
};

const detach = (draw: OutputDraw) => {
  draws.delete(draw);
  refocus();
};

export function useOutputDraw(draw: OutputDraw, item: string | null, visibleRef?: RefObject<Element | null>) {
  useEffect(() => {
    const element = visibleRef?.current;
    if (!element) {
      attach(draw, item);
      return () => detach(draw);
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.intersectionRatio > 0) attach(draw, item);
      else detach(draw);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      detach(draw);
    };
  }, [draw, item, visibleRef]);
}

export function useCanvasSize(ref: RefObject<HTMLCanvasElement | null>, onResize: () => void) {
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const observer = new ResizeObserver(([entry]) => {
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(entry.contentRect.width * ratio));
      const height = Math.max(1, Math.round(entry.contentRect.height * ratio));
      if (canvas.width === width && canvas.height === height) return;
      canvas.width = width;
      canvas.height = height;
      onResize();
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [ref, onResize]);
}

export function useThemeChange(onChange: () => void) {
  useEffect(() => {
    const observer = new MutationObserver(onChange);
    observer.observe(document.documentElement, { attributeFilter: ['style'] });
    return () => observer.disconnect();
  }, [onChange]);
}

export const canvasColor = (canvas: HTMLCanvasElement, alpha = 1) => {
  const color = getComputedStyle(canvas).color;
  const channels =
    color
      .match(/[\d.]+/g)
      ?.slice(0, 3)
      .join(', ') ?? '128, 128, 128';
  return `rgba(${channels}, ${alpha})`;
};

const columnBins = new Map<number, Array<[number, number, number]>>();

const binsFor = (columns: number) => {
  const cached = columnBins.get(columns);
  if (cached) return cached;
  const perHz = (timelineAudio.spectrumBins * 2) / SAMPLE_RATE;
  const bins = Array.from({ length: columns + 1 }, (_, column): [number, number, number] => {
    const low = unitToFrequency((column - 0.5) / columns);
    const high = unitToFrequency((column + 0.5) / columns);
    const center = unitToFrequency(column / columns);
    const tilt = SPECTRUM_TILT_DB_PER_OCTAVE * Math.log2(center / SPECTRUM_PIVOT_HZ);
    return [Math.max(1, Math.round(low * perHz)), Math.max(1, Math.round(high * perHz)), tilt];
  });
  columnBins.set(columns, bins);
  return bins;
};

export function drawSpectrum(
  context: CanvasRenderingContext2D,
  data: Float32Array,
  width: number,
  height: number,
  floorDb: number,
  ceilingDb: number,
  color: string | CanvasGradient,
) {
  const columns = Math.max(2, Math.round(width / (SPECTRUM_COLUMN_PX * (window.devicePixelRatio || 1))));
  const bins = binsFor(columns);
  context.beginPath();
  context.moveTo(0, height);
  bins.forEach(([from, to, tilt], column) => {
    let level = -Infinity;
    for (let bin = from; bin <= Math.max(from, to) && bin < data.length; bin++) level = Math.max(level, data[bin]);
    const unit = Math.min(1, Math.max(0, (level + tilt - floorDb) / (ceilingDb - floorDb)));
    context.lineTo((column / columns) * width, height * (1 - unit));
  });
  context.lineTo(width, height);
  context.closePath();
  context.fillStyle = color;
  context.fill();
}
