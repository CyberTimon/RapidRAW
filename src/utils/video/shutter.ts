import { ClipItem, FrameRate, Ticks } from '../../types/video';
import { Adjustments } from '../adjustments';
import { sourceOffset } from './model';
import { frameTicks, ticksToSeconds } from './time';

export const DEFAULT_SHUTTER = 180;

const SHUTTER_KEYS = [
  'motionBlurType',
  'motionBlurShutter',
  'motionBlurHighlights',
  'motionBlurFootage',
  'activeTools',
] as const;

export interface StillShutter {
  look: Partial<Adjustments>;
  advance: number;
}

export const shutterLook = (look: Adjustments): Partial<Adjustments> | null =>
  look.motionBlurType === 'shutter' ? Object.fromEntries(SHUTTER_KEYS.map((key) => [key, look[key]])) : null;

export const stillShutter = (look: Adjustments, clip: ClipItem, time: Ticks, fps: FrameRate): StillShutter | null => {
  const shutter = shutterLook(look);
  if (!shutter) return null;
  const local = time - clip.start;
  const advance = Math.abs(sourceOffset(clip, local + frameTicks(fps), fps) - sourceOffset(clip, local, fps));
  return { look: shutter, advance: ticksToSeconds(advance) };
};
