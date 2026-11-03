import type { TFunction } from 'i18next';
import type en from '../i18n/locales/en.json';
import type { UIState } from '../store/useUIStore';

export type PanoramaMessageCode = keyof (typeof en)['modals']['panorama']['messages'];

export interface PanoramaMessage {
  code: PanoramaMessageCode;
  params?: Record<string, string | number>;
}

export type PanoramaProjection = keyof (typeof en)['modals']['panorama']['projections'];

export interface PanoramaCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PanoramaDroppedImage {
  filename: string;
  reason: PanoramaMessage;
}

export interface PanoramaFrameMeta {
  nativeMm: number | null;
  focal35: number | null;
  shutter: string | null;
  aperture: number | null;
  iso: number | null;
}

export interface PanoramaFrameInfo {
  name: string;
  focal35: number | null;
  meta: PanoramaFrameMeta | null;
  focalOutlier: boolean;
  dropped: boolean;
}

export interface PanoramaPreview {
  image: string;
  overlay: string;
  winnerMap: string;
  width: number;
  height: number;
  crop: PanoramaCropRect;
  dropped: Array<PanoramaDroppedImage>;
  frames: Array<PanoramaFrameInfo>;
  recommendedProjection: PanoramaProjection;
  selectedProjection: PanoramaProjection;
  projections: Array<PanoramaProjection>;
  minQuality: number;
}

export const PANORAMA_FULL_QUALITY = 1;

export type PanoramaFailureCode = Extract<PanoramaMessageCode, 'taskFailed' | 'reprojectFailed' | 'saveFailed'>;

export function toPanoramaMessage(err: unknown, fallback: PanoramaFailureCode): PanoramaMessage {
  if (err && typeof err === 'object' && 'code' in err) return err as PanoramaMessage;
  return { code: fallback, params: { detail: String(err) } };
}

export function panoramaMessage(t: TFunction, message: PanoramaMessage | null | undefined): string {
  if (!message) return '';
  return String(t(`modals.panorama.messages.${message.code}`, message.params ?? {}));
}

export function updateOpenPanorama(patch: Partial<UIState['panoramaModalState']>) {
  return (state: UIState): Partial<UIState> =>
    state.panoramaModalState.isOpen ? { panoramaModalState: { ...state.panoramaModalState, ...patch } } : state;
}
