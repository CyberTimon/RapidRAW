import type { TFunction } from 'i18next';
import { ClipItem, FrameRate, Interpolation } from '../../types/video';
import { clipSpeed } from './model';
import { fpsValue } from './time';

const RATE_TOLERANCE = 0.01;
const INTERPOLATIONS: Array<Interpolation> = ['none', 'blend', 'flow'];

export const interpolationOptions = (t: TFunction) =>
  INTERPOLATIONS.map((id) => ({ id, label: t(`video.inspector.interpolation.${id}`) }));

const slowestSpeed = (item: ClipItem) =>
  item.speedRamp?.length && !item.freeze
    ? Math.min(...item.speedRamp.map((key) => clipSpeed({ speed: key.value })))
    : clipSpeed(item);

export const missingFrames = (item: ClipItem, sourceFps: number, projectFps: FrameRate) =>
  !item.freeze && sourceFps > 0 && sourceFps * slowestSpeed(item) < fpsValue(projectFps) * (1 - RATE_TOLERANCE);
