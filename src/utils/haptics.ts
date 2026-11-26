import { invoke } from '@tauri-apps/api/core';
import { platform } from '@tauri-apps/plugin-os';
import { Invokes } from '../types/invokes';

type HapticKind = 'alignment' | 'level';

const MIN_INTERVAL_MS = 80;

let supported: boolean | null = null;
let lastPerformed = -Infinity;
const gestures = new WeakMap<object, Array<unknown>>();

const isSupported = () => {
  if (supported === null) {
    try {
      supported = platform() === 'macos';
    } catch {
      supported = false;
    }
  }
  return supported;
};

const haptic = (kind: HapticKind) => {
  if (!isSupported()) return;
  const now = performance.now();
  if (now - lastPerformed < MIN_INTERVAL_MS) return;
  lastPerformed = now;
  invoke(Invokes.Haptic, { kind }).catch(() => {});
};

const engaged = (state: unknown) => state !== null && state !== undefined && state !== false;

export const alignHaptic = (gesture: object, ...states: Array<unknown>) => {
  const previous = gestures.get(gesture);
  gestures.set(gesture, states);
  if (previous && states.some((state, index) => engaged(state) && state !== previous[index])) haptic('alignment');
};

export const detentHaptic = (previous: number | null, next: number, detent: number, min: number, max: number) => {
  if (previous === null || detent <= min || detent >= max || previous === detent) return;
  if (Math.sign(next - detent) !== Math.sign(previous - detent)) haptic('level');
};
