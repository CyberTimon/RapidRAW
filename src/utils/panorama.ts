import type { TFunction } from 'i18next';
import type en from '../i18n/locales/en.json';

export type PanoramaMessageCode = keyof (typeof en)['modals']['panorama']['messages'];

export interface PanoramaMessage {
  code: PanoramaMessageCode;
  params?: Record<string, string | number>;
}

export type PanoramaFailureCode = Extract<PanoramaMessageCode, 'taskFailed' | 'reprojectFailed' | 'saveFailed'>;

export function toPanoramaMessage(err: unknown, fallback: PanoramaFailureCode): PanoramaMessage {
  if (err && typeof err === 'object' && 'code' in err) return err as PanoramaMessage;
  return { code: fallback, params: { detail: String(err) } };
}

export function panoramaMessage(t: TFunction, message: PanoramaMessage | null | undefined): string {
  if (!message) return '';
  return String(t(`modals.panorama.messages.${message.code}`, message.params ?? {}));
}
