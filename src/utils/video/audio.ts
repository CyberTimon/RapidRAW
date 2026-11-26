import { invoke } from '@tauri-apps/api/core';
import { platform } from '@tauri-apps/plugin-os';
import { Invokes } from '../../types/invokes';
import { VideoProject } from '../../types/video';
import { withRevision } from './revisions';
import { SAMPLE_RATE } from './sound';

export type AudioTap = 'mix' | 'clip';

const CHANNELS = 2;
const FIRST_CHUNK_SECONDS = 0.6;
const CHUNK_SECONDS = 3;
const LOOKAHEAD_SECONDS = 4;
const SEAM_SECONDS = 0.02;
const PICTURE_LATENCY = 0.02;
const RETUNE_LEAD_SECONDS = 0.08;
const CLOCK_POLL_MS = 10;
const CLOCK_WAIT_MS = 500;
const CAPTURE_WINDOW = 8192;
const SPECTRUM_WINDOW = 8192;
const SPECTRUM_SMOOTHING = 0.75;
const WEBKIT_OUTPUT_LATENCY: Partial<Record<string, number>> = { macos: 0.015, linux: 0.04 };
const SILENT_KEYS = new Set([
  'look',
  'transform',
  'fit',
  'cellAspect',
  'blend',
  'stabilize',
  'interpolation',
  'trackMatte',
  'motionBlur',
  'height',
]);

const latency = (seconds: number) => (Number.isFinite(seconds) && seconds > 0 ? seconds : 0);

const fallbackOutputLatency = () => {
  try {
    return WEBKIT_OUTPUT_LATENCY[platform()] ?? 0;
  } catch (_error) {
    return 0;
  }
};

const audioSignature = (project: VideoProject | null) =>
  project &&
  JSON.stringify(
    { ...project, looks: null, markers: null, captions: null, modified: null, name: null },
    (key, value) => (SILENT_KEYS.has(key) ? undefined : value),
  );

interface Chunk {
  start: number;
  duration: number;
  buffer: AudioBuffer | null;
  solo: Promise<AudioBuffer | null> | null;
}

interface Playing {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

interface ClipLane {
  bus: GainNode;
  previous: Playing | null;
  queue: Promise<void>;
}

interface Prefetch {
  start: number;
  chunk: Promise<Chunk>;
}

interface Span {
  at: number;
  start: number;
  duration: number;
  wrap: boolean;
}

interface Taps {
  input: GainNode;
  channels: Array<AnalyserNode>;
  samples: Array<Float32Array<ArrayBuffer>>;
  spectrum: AnalyserNode;
}

class TimelineAudio {
  readonly spectrumBins = SPECTRUM_WINDOW / 2;
  private context: AudioContext | null = null;
  private generation = 0;
  private playing: Array<Playing> = [];
  private taps: Taps | null = null;
  private clipTaps: Taps | null = null;
  private focused: string | null = null;
  private clipLane: ClipLane | null = null;
  private mix: GainNode | null = null;
  private project: VideoProject | null = null;
  private signature: string | null = null;
  private to = 0;
  private loopFrom: number | null = null;
  private retune = false;
  private refocus = false;
  private wake: (() => void) | null = null;

  private async runningClock() {
    const context = this.audioContext();
    await context.resume();
    const deadline = performance.now() + CLOCK_WAIT_MS;
    while (context.currentTime === 0 && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, CLOCK_POLL_MS));
    }
  }

  private outputTime() {
    const context = this.audioContext();
    const output = latency(context.outputLatency) || fallbackOutputLatency();
    return context.currentTime - latency(context.baseLatency) - output;
  }

  private audioContext() {
    this.context ??= new AudioContext({ sampleRate: SAMPLE_RATE });
    return this.context;
  }

  private createTaps(): Taps {
    const context = this.audioContext();
    const input = context.createGain();
    const splitter = context.createChannelSplitter(CHANNELS);
    const channels = Array.from({ length: CHANNELS }, (_, channel) => {
      const analyser = context.createAnalyser();
      analyser.fftSize = CAPTURE_WINDOW;
      splitter.connect(analyser, channel);
      return analyser;
    });
    const spectrum = context.createAnalyser();
    spectrum.fftSize = SPECTRUM_WINDOW;
    spectrum.smoothingTimeConstant = SPECTRUM_SMOOTHING;
    input.connect(splitter);
    input.connect(spectrum);
    return { input, channels, samples: channels.map(() => new Float32Array(CAPTURE_WINDOW)), spectrum };
  }

  private output() {
    if (!this.taps) {
      this.taps = this.createTaps();
      this.taps.input.connect(this.audioContext().destination);
    }
    return this.taps.input;
  }

  captureOutput(tap: AudioTap) {
    const taps = tap === 'mix' ? this.taps : this.clipTaps;
    if (!taps || !this.context) return null;
    taps.channels.forEach((analyser, channel) => analyser.getFloatTimeDomainData(taps.samples[channel]));
    return { time: this.context.currentTime, channels: taps.samples };
  }

  captureSpectrum(tap: AudioTap, out: Float32Array<ArrayBuffer>) {
    const taps = tap === 'mix' ? this.taps : this.clipTaps;
    if (!taps) return false;
    taps.spectrum.getFloatFrequencyData(out);
    return true;
  }

  focus(id: string | null) {
    if (id === this.focused) return;
    this.focused = id;
    this.clipTaps?.input.disconnect();
    this.clipTaps = null;
    this.clipLane?.bus.disconnect();
    this.clipLane = null;
    this.refocus = true;
    this.wake?.();
  }

  private async fetchBuffer(project: VideoProject, start: number, duration: number, solo: string | null = null) {
    const bytes = await withRevision(project, (revision) =>
      invoke<ArrayBuffer>(Invokes.VideoAudioChunk, { revision, start, duration, solo }),
    ).catch(() => null);
    if (!bytes || bytes.byteLength === 0) return null;
    const samples = new Int16Array(bytes);
    const frames = Math.floor(samples.length / CHANNELS);
    if (frames === 0 || samples.every((sample) => sample === 0)) return null;
    const buffer = this.audioContext().createBuffer(CHANNELS, frames, SAMPLE_RATE);
    for (let channel = 0; channel < CHANNELS; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < frames; i++) data[i] = samples[i * CHANNELS + channel] / 32768;
    }
    return buffer;
  }

  private async fetchChunk(project: VideoProject, start: number, duration: number): Promise<Chunk> {
    const buffer = await this.fetchBuffer(project, start, duration);
    return { start, duration, buffer, solo: this.fetchSolo(project, start, duration) };
  }

  private fetchSolo(project: VideoProject, start: number, duration: number) {
    return this.focused ? this.fetchBuffer(project, start, duration, this.focused) : null;
  }

  async prime(project: VideoProject, from: number, to: number, loopFrom: number | null = null) {
    this.stop();
    const generation = ++this.generation;
    this.project = project;
    this.signature = audioSignature(project);
    this.to = to;
    this.loopFrom = loopFrom;
    this.retune = false;
    this.refocus = false;
    const first = await this.fetchChunk(project, from, Math.min(FIRST_CHUNK_SECONDS, Math.max(0.05, to - from)));
    const position = from + first.duration;
    const seam = first.buffer ? Math.min(SEAM_SECONDS, position) : 0;
    const next =
      position < to
        ? {
            start: position - seam,
            chunk: this.fetchChunk(project, position - seam, Math.min(2 * FIRST_CHUNK_SECONDS, to - position) + seam),
          }
        : null;
    await this.runningClock();
    return (offset = 0) => this.run(generation, from, first, offset, next);
  }

  update(project: VideoProject, to: number, loopFrom: number | null) {
    const signature = audioSignature(project);
    const changed = signature !== this.signature || to !== this.to || loopFrom !== this.loopFrom;
    this.project = project;
    this.signature = signature;
    this.to = to;
    this.loopFrom = loopFrom;
    if (!changed) return;
    this.retune = true;
    this.wake?.();
  }

  private openBus(output: AudioNode, fadeIn: number | null) {
    const bus = this.audioContext().createGain();
    bus.connect(output);
    if (fadeIn !== null) {
      bus.gain.setValueAtTime(0, fadeIn);
      bus.gain.linearRampToValueAtTime(1, fadeIn + SEAM_SECONDS);
    }
    return bus;
  }

  private openClip(fadeIn: number | null) {
    this.clipLane?.bus.disconnect();
    if (this.focused) this.clipTaps ??= this.createTaps();
    this.clipLane = this.clipTaps
      ? { bus: this.openBus(this.clipTaps.input, fadeIn), previous: null, queue: Promise.resolve() }
      : null;
  }

  private openMix(fadeIn: number | null) {
    const mix = this.openBus(this.output(), fadeIn);
    this.openClip(fadeIn);
    this.mix = mix;
    return mix;
  }

  private schedule(
    chunk: Chunk,
    at: number,
    mix: GainNode,
    previous: Playing | null = null,
    wrap = false,
  ): Playing | null {
    const context = this.audioContext();
    if (previous) {
      const out = wrap ? at - SEAM_SECONDS : at;
      const fade = Math.max(out, context.currentTime);
      previous.gain.gain.setValueAtTime(1, fade);
      previous.gain.gain.linearRampToValueAtTime(0, Math.max(fade, out + SEAM_SECONDS));
    }
    if (!chunk.buffer) return null;
    const skip = Math.max(0, context.currentTime - at);
    if (skip >= chunk.duration) return null;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = chunk.buffer;
    source.connect(gain);
    gain.connect(mix);
    const begin = Math.max(at, context.currentTime);
    if (previous || wrap) {
      gain.gain.setValueAtTime(Math.min(1, skip / SEAM_SECONDS), begin);
      gain.gain.linearRampToValueAtTime(1, Math.max(begin, at + SEAM_SECONDS));
    }
    source.start(begin, skip);
    const playing = { source, gain };
    source.onended = () => {
      gain.disconnect();
      this.playing = this.playing.filter((entry) => entry !== playing);
    };
    this.playing.push(playing);
    return playing;
  }

  private follow(chunk: Chunk, at: number, wrap = false) {
    const { clipLane: lane } = this;
    const { solo } = chunk;
    if (!lane || !solo) return;
    lane.queue = lane.queue.then(async () => {
      const buffer = await solo;
      if (lane === this.clipLane)
        lane.previous = this.schedule({ ...chunk, buffer }, at, lane.bus, lane.previous, wrap);
    });
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private async run(generation: number, from: number, first: Chunk, offset: number, next: Prefetch | null) {
    const context = this.audioContext();
    let pending = next;
    let origin = this.outputTime() + PICTURE_LATENCY - offset;
    let segment = from;
    const place = (chunk: Chunk) => origin + (chunk.start - segment);
    const spanOf = (chunk: Chunk, at: number, wrap = false): Span => ({
      at,
      start: chunk.start,
      duration: chunk.duration,
      wrap,
    });
    let spans = [spanOf(first, place(first))];
    let mix = this.openMix(null);
    let previous = this.schedule(first, place(first), mix);
    this.follow(first, place(first));
    let position = first.start + first.duration;
    let wrap = false;
    while (generation === this.generation) {
      if (this.retune) {
        this.retune = false;
        this.refocus = false;
        pending = null;
        const at = context.currentTime + RETUNE_LEAD_SECONDS;
        const span = spans.find((entry) => entry.at <= at && at < entry.at + entry.duration);
        if (!span) continue;
        const reached = span.start + (at - span.at);
        const passed = reached - RETUNE_LEAD_SECONDS >= this.to;
        const restart = passed && this.loopFrom !== null && this.loopFrom < this.to ? this.loopFrom : null;
        const start = restart === null ? reached : restart + RETUNE_LEAD_SECONDS;
        const chunk = await this.fetchChunk(
          this.project!,
          start,
          Math.max(0, Math.min(FIRST_CHUNK_SECONDS, this.to - start)),
        );
        if (generation !== this.generation) return;
        origin = at;
        segment = start;
        const switchAt = Math.max(at, context.currentTime);
        const replaced = mix;
        replaced.gain.setValueAtTime(1, switchAt);
        replaced.gain.linearRampToValueAtTime(0, switchAt + SEAM_SECONDS);
        this.playing.forEach(({ source }) => source.stop(switchAt + SEAM_SECONDS));
        this.playing = [];
        window.setTimeout(() => replaced.disconnect(), (switchAt - context.currentTime + SEAM_SECONDS) * 1000 + 100);
        mix = this.openMix(switchAt);
        spans = [spanOf(chunk, at)];
        previous = this.schedule(chunk, at, mix);
        this.follow(chunk, at);
        position = start + chunk.duration;
        wrap = false;
        continue;
      }
      if (this.refocus) {
        this.refocus = false;
        pending = null;
        this.openClip(null);
        spans
          .filter((span) => span.at + span.duration > context.currentTime)
          .forEach(({ at, start, duration, wrap: wrapped }) =>
            this.follow(
              { start, duration, buffer: null, solo: this.fetchSolo(this.project!, start, duration) },
              at,
              wrapped,
            ),
          );
        continue;
      }
      const { to, loopFrom } = this;
      if (position >= to) {
        if (loopFrom === null || loopFrom >= to) {
          const remaining = origin + (to - segment) - context.currentTime;
          if (remaining <= 0) return;
          await this.sleep(remaining * 1000);
          continue;
        }
        origin += to - segment;
        segment = loopFrom;
        position = loopFrom;
        wrap = true;
      }
      const ahead = position - segment - (context.currentTime - origin);
      if (ahead > LOOKAHEAD_SECONDS) {
        await this.sleep((ahead - LOOKAHEAD_SECONDS) * 1000);
        continue;
      }
      const duration = Math.min(CHUNK_SECONDS, Math.max(FIRST_CHUNK_SECONDS, 2 * ahead), to - position);
      const seam = previous && !wrap ? Math.min(SEAM_SECONDS, position) : 0;
      const ready = pending?.start === position - seam ? pending.chunk : null;
      pending = null;
      const chunk = await (ready ?? this.fetchChunk(this.project!, position - seam, duration + seam));
      if (generation !== this.generation) return;
      if (this.retune) continue;
      const at = place(chunk);
      spans = [...spans.filter((entry) => entry.at + entry.duration > context.currentTime), spanOf(chunk, at, wrap)];
      previous = this.schedule(chunk, at, mix, previous, wrap);
      this.follow(chunk, at, wrap);
      position = chunk.start + chunk.duration;
      wrap = false;
    }
  }

  stop() {
    this.generation++;
    this.wake?.();
    this.playing.forEach(({ source }) => {
      try {
        source.stop();
      } catch {
        return;
      }
    });
    this.playing = [];
    this.mix?.disconnect();
    this.mix = null;
    this.clipLane?.bus.disconnect();
    this.clipLane = null;
  }
}

export const timelineAudio = new TimelineAudio();
