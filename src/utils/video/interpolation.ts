import type { TFunction } from 'i18next';
import { ClipItem, Interpolation } from '../../types/video';
import { clipSpeed } from './model';

const RATE_TOLERANCE = 0.01;
const INTERPOLATIONS: Array<Interpolation> = ['none', 'blend', 'flow'];

export const interpolationOptions = (t: TFunction) =>
  INTERPOLATIONS.map((id) => ({ id, label: t(`video.inspector.interpolation.${id}`) }));

const slowestSpeed = (item: ClipItem) =>
  item.speedRamp?.length && !item.freeze
    ? Math.min(...item.speedRamp.map((key) => clipSpeed({ speed: key.value })))
    : clipSpeed(item);

export const framesMissing = (sourceFps: number, targetFps: number) =>
  sourceFps > 0 && sourceFps < targetFps * (1 - RATE_TOLERANCE);

export const missingFrames = (item: ClipItem, sourceFps: number, targetFps: number) =>
  !item.freeze && framesMissing(sourceFps * slowestSpeed(item), targetFps);
