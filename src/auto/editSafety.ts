import { invoke } from '@tauri-apps/api/core';
import type { Adjustments } from '../utils/adjustments';
import { useAutoStore } from './store';

const persisted = new WeakSet<object>();
export function markAutoHydration<T extends object>(value: T): T {
  persisted.add(value);
  return value;
}
export function isAutoHydration(value: object): boolean {
  return persisted.has(value);
}
export function protectAutoEdit(previous: Adjustments, next: Adjustments, path?: string): Adjustments {
  if (previous === next) return next;
  if (path && useAutoStore.getState().progress?.running) {
    void invoke('plugin:scene-auto|protect', { path }).catch(console.error);
  }
  const masks = next.masks.map((mask) => {
    const old = previous.masks.find((item) => item.id === mask.id);
    if (!mask.autoOwner || !old || JSON.stringify(old) === JSON.stringify(mask)) return mask;
    const { autoOwner: _owner, ...manual } = mask;
    return manual;
  });
  return {
    ...next,
    masks,
    ...(next.autoProvenance ? { autoProvenance: { ...next.autoProvenance, manual: true } } : {}),
  };
}
