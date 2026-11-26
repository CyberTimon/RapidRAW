import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { platform } from '@tauri-apps/plugin-os';
import { Invokes } from '../types/invokes';

const UI_SCALE_MIN = 0.5;
const UI_SCALE_MAX = 2;

export const UI_SCALE_PRESETS = [0.8, 0.9, 1, 1.1, 1.25];

let uiScale = 1;
let nativeScaleFactor: number | null = null;
let isAndroid = false;
let defaultViewport: string | null = null;

export const clampUiScale = (scale: number | null | undefined): number =>
  typeof scale === 'number' && Number.isFinite(scale) ? Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, scale)) : 1;

export const getDevicePixelRatio = (): number =>
  uiScale !== 1 && nativeScaleFactor !== null ? nativeScaleFactor * uiScale : window.devicePixelRatio || 1;

const syncAndroidViewport = () => {
  const meta = document.querySelector('meta[name="viewport"]');
  const viewport = window.visualViewport;
  if (!meta || !viewport || defaultViewport === null) return;

  const width = Math.round((viewport.width * viewport.scale) / uiScale);
  const content =
    uiScale === 1
      ? defaultViewport
      : `width=${width}, initial-scale=${uiScale}, minimum-scale=${uiScale}, maximum-scale=${uiScale}, user-scalable=no`;
  if (meta.getAttribute('content') !== content) meta.setAttribute('content', content);
};

export const setLocalUiScale = (scale: number | null | undefined) => {
  uiScale = clampUiScale(scale);
  if (isAndroid) syncAndroidViewport();
};

export const applyUiScale = (scale: number) => {
  setLocalUiScale(scale);
  if (isAndroid) return;
  invoke(Invokes.SetUiScale, { scale: uiScale }).catch((err) => console.error('Failed to apply UI scale:', err));
};

const initAndroidDisplayScale = () => {
  defaultViewport = document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? null;
  nativeScaleFactor = window.devicePixelRatio || 1;
  window.visualViewport?.addEventListener('resize', syncAndroidViewport);
};

const initDesktopDisplayScale = () => {
  const appWindow = getCurrentWindow();
  appWindow
    .scaleFactor()
    .then((factor) => (nativeScaleFactor = factor))
    .catch(console.error);
  appWindow.onScaleChanged(({ payload }) => (nativeScaleFactor = payload.scaleFactor)).catch(console.error);
  listen<number>('ui-scale-changed', ({ payload }) => setLocalUiScale(payload)).catch(console.error);
};

export const initDisplayScale = () => {
  try {
    isAndroid = platform() === 'android';
  } catch (_error) {
    isAndroid = false;
  }

  if (isAndroid) initAndroidDisplayScale();
  else initDesktopDisplayScale();
};
