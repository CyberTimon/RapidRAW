import type { Adjustments } from '../utils/adjustments';

export const CROP_KEYS = [
  'crop',
  'aspectRatio',
  'rotation',
  'orientationSteps',
  'flipHorizontal',
  'flipVertical',
] as const;
export type CropGeometry = Pick<Adjustments, (typeof CROP_KEYS)[number]>;
export interface CropSession {
  path: string;
  original: CropGeometry;
  history: CropGeometry[];
  index: number;
}

export function cropGeometry(adjustments: Adjustments): CropGeometry {
  return Object.fromEntries(CROP_KEYS.map((key) => [key, adjustments[key]])) as CropGeometry;
}

export function sameGeometry(a: CropGeometry, b: CropGeometry) {
  return CROP_KEYS.every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]));
}

export function beginSession(path: string, adjustments: Adjustments): CropSession {
  const original = cropGeometry(adjustments);
  return { path, original, history: [original], index: 0 };
}

export function recordGeometry(session: CropSession, adjustments: Adjustments): CropSession {
  const geometry = cropGeometry(adjustments);
  if (sameGeometry(session.history[session.index], geometry)) return session;
  const history = [...session.history.slice(0, session.index + 1), geometry].slice(-100);
  return { ...session, history, index: history.length - 1 };
}

export function committedAdjustments(adjustments: Adjustments, session: CropSession | null): Adjustments {
  return session ? { ...adjustments, ...session.original } : adjustments;
}
