import { SAMPLE_RATE } from './sound';

const [S1, S2] = [
  [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585],
  [1.0, -2.0, 1.0, -1.99004745483398, 0.99007225036621],
];
const OFFSET_DB = -0.691;
const SILENCE_LUFS = -120;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;
const GATE_BINS_PER_LU = 10;
const GATE_BINS = 1000;
const STEP_FRAMES = SAMPLE_RATE / 10;
const MOMENTARY_STEPS = 4;
const SHORT_TERM_STEPS = 30;
const PEAK_HOLD_SECONDS = 1.5;
const PEAK_FALL_DB_PER_SECOND = 24;
const RMS_SECONDS = 0.3;

export const HISTORY_STEPS = 300;

const amplitudeDb = (amplitude: number) => (amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity);
const loudness = (energy: number) => {
  const lufs = energy > 0 ? OFFSET_DB + 10 * Math.log10(energy) : -Infinity;
  return lufs > SILENCE_LUFS ? lufs : -Infinity;
};
const gateBin = (lufs: number) => Math.min(GATE_BINS - 1, Math.floor((lufs - ABSOLUTE_GATE_LUFS) * GATE_BINS_PER_LU));

interface GateBin {
  sum: number;
  blocks: Array<number>;
}

export class OutputMeter {
  readonly level = [-Infinity, -Infinity];
  readonly hold = [-Infinity, -Infinity];
  readonly rms = [-Infinity, -Infinity];
  readonly history: Array<number> = [];
  momentary = -Infinity;
  shortTerm = -Infinity;
  integrated = -Infinity;
  revision = 0;
  private state = new Float64Array(8);
  private holdAge = [0, 0];
  private squares = [0, 0];
  private stepEnergy = 0;
  private stepFrames = 0;
  private steps: Array<number> = [];
  private gatedSum = 0;
  private gatedCount = 0;
  private gateBins: Array<GateBin> = [];

  reset() {
    this.level.fill(-Infinity);
    this.hold.fill(-Infinity);
    this.rms.fill(-Infinity);
    this.history.length = 0;
    this.momentary = -Infinity;
    this.shortTerm = -Infinity;
    this.integrated = -Infinity;
    this.revision += 1;
    this.state.fill(0);
    this.holdAge.fill(0);
    this.squares.fill(0);
    this.stepEnergy = 0;
    this.stepFrames = 0;
    this.steps = [];
    this.gatedSum = 0;
    this.gatedCount = 0;
    this.gateBins = [];
  }

  push([left, right]: Array<Float32Array>, from: number, count: number, elapsed: number) {
    const state = this.state;
    let [l1, l2, l3, l4, r1, r2, r3, r4] = state;
    let [peakLeft, peakRight, sumLeft, sumRight] = [0, 0, 0, 0];
    for (let frame = from; frame < from + count; frame++) {
      const a = left[frame];
      const b = right[frame];
      peakLeft = Math.max(peakLeft, Math.abs(a));
      peakRight = Math.max(peakRight, Math.abs(b));
      sumLeft += a * a;
      sumRight += b * b;
      const la = S1[0] * a + l1;
      l1 = S1[1] * a - S1[3] * la + l2;
      l2 = S1[2] * a - S1[4] * la;
      const lb = S2[0] * la + l3;
      l3 = S2[1] * la - S2[3] * lb + l4;
      l4 = S2[2] * la - S2[4] * lb;
      const ra = S1[0] * b + r1;
      r1 = S1[1] * b - S1[3] * ra + r2;
      r2 = S1[2] * b - S1[4] * ra;
      const rb = S2[0] * ra + r3;
      r3 = S2[1] * ra - S2[3] * rb + r4;
      r4 = S2[2] * ra - S2[4] * rb;
      this.stepEnergy += lb * lb + rb * rb;
      if (++this.stepFrames === STEP_FRAMES) this.closeStep();
    }
    state.set([l1, l2, l3, l4, r1, r2, r3, r4]);
    this.settle(0, peakLeft, count > 0 ? sumLeft / count : null, elapsed);
    this.settle(1, peakRight, count > 0 ? sumRight / count : null, elapsed);
  }

  fall(elapsed: number) {
    this.settle(0, 0, 0, elapsed);
    this.settle(1, 0, 0, elapsed);
  }

  private closeStep() {
    this.steps.push(this.stepEnergy / STEP_FRAMES);
    if (this.steps.length > SHORT_TERM_STEPS) this.steps.shift();
    this.stepEnergy = 0;
    this.stepFrames = 0;
    if (this.steps.length < MOMENTARY_STEPS) return;
    const mean = (steps: Array<number>) => steps.reduce((sum, step) => sum + step, 0) / steps.length;
    const block = mean(this.steps.slice(-MOMENTARY_STEPS));
    this.addBlock(block);
    this.momentary = loudness(block);
    this.shortTerm = loudness(mean(this.steps));
    this.integrated = this.gated();
    this.history.push(this.shortTerm);
    if (this.history.length > HISTORY_STEPS) this.history.shift();
    this.revision += 1;
  }

  private addBlock(block: number) {
    const lufs = loudness(block);
    if (lufs <= ABSOLUTE_GATE_LUFS) return;
    this.gatedSum += block;
    this.gatedCount += 1;
    const index = gateBin(lufs);
    while (this.gateBins.length <= index) this.gateBins.push({ sum: 0, blocks: [] });
    this.gateBins[index].sum += block;
    this.gateBins[index].blocks.push(block);
  }

  private gated() {
    if (this.gatedCount === 0) return -Infinity;
    const gate = Math.max(ABSOLUTE_GATE_LUFS, loudness(this.gatedSum / this.gatedCount) + RELATIVE_GATE_LU);
    const first = gateBin(gate);
    let [sum, count] = [0, 0];
    for (const block of this.gateBins[first]?.blocks ?? []) {
      if (loudness(block) > gate) {
        sum += block;
        count += 1;
      }
    }
    for (let index = first + 1; index < this.gateBins.length; index++) {
      sum += this.gateBins[index].sum;
      count += this.gateBins[index].blocks.length;
    }
    return loudness(count > 0 ? sum / count : 0);
  }

  private settle(channel: number, peak: number, meanSquare: number | null, elapsed: number) {
    const peakDb = amplitudeDb(peak);
    this.level[channel] = Math.max(peakDb, this.level[channel] - PEAK_FALL_DB_PER_SECOND * elapsed);
    this.holdAge[channel] += elapsed;
    if (peakDb >= this.hold[channel]) {
      this.hold[channel] = peakDb;
      this.holdAge[channel] = 0;
    } else if (this.holdAge[channel] > PEAK_HOLD_SECONDS) {
      this.hold[channel] = this.level[channel];
      this.holdAge[channel] = 0;
    }
    if (meanSquare === null) return;
    this.squares[channel] += (meanSquare - this.squares[channel]) * (1 - Math.exp(-elapsed / RMS_SECONDS));
    this.rms[channel] = amplitudeDb(Math.sqrt(this.squares[channel]));
  }
}
