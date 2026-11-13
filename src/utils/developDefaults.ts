import { useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Adjustments, INITIAL_ADJUSTMENTS, normalizeLoadedAdjustments } from './adjustments';
import type { SliderResetResolver } from '../context/SliderResetContext';
import type { ImageDefaults } from '../types/editor';
import type { AppSettings, Camera, DefaultsSource } from '../types/settings';
import { Invokes } from '../types/invokes';
import { useEditorStore } from '../store/useEditorStore';
import { useSettingsStore } from '../store/useSettingsStore';

export const fetchImageDefaults = async (path: string): Promise<ImageDefaults> => {
  const result = await invoke<{ adjustments: Partial<Adjustments>; camera: Camera | null; source: DefaultsSource }>(
    Invokes.GetDefaultAdjustments,
    { path },
  );
  return { ...result, path, adjustments: normalizeLoadedAdjustments(result.adjustments as Adjustments) };
};

const loadedOpenImageDefaults = (): Adjustments | null => {
  const { selectedImage, imageDefaults } = useEditorStore.getState();
  return selectedImage && imageDefaults?.path === selectedImage.path ? imageDefaults.adjustments : null;
};

export const getDefaultAdjustments = (): Adjustments =>
  structuredClone(loadedOpenImageDefaults() ?? INITIAL_ADJUSTMENTS);

export const getDefaultAdjustmentsFor = async (path: string): Promise<Adjustments> => {
  const { selectedImage } = useEditorStore.getState();
  const loaded = selectedImage?.path === path ? loadedOpenImageDefaults() : null;
  return loaded ? structuredClone(loaded) : (await fetchImageDefaults(path)).adjustments;
};

export const getOpenImageDefaults = async (): Promise<Adjustments> => {
  const { selectedImage } = useEditorStore.getState();
  return selectedImage ? getDefaultAdjustmentsFor(selectedImage.path) : structuredClone(INITIAL_ADJUSTMENTS);
};

export const hasCustomDefaults = (settings: AppSettings | null | undefined) => {
  const defaults = settings?.developDefaults;
  return !!defaults && (!!defaults.presetId || !!defaults.autoLensCorrection || !!defaults.cameras?.length);
};

export const openImageHasCustomDefaults = () => {
  const { selectedImage, imageDefaults } = useEditorStore.getState();
  return !!selectedImage && imageDefaults?.path === selectedImage.path && imageDefaults.source !== 'factory';
};

export const adjustmentsFromMetadata = (adjustments: unknown): Adjustments =>
  adjustments && typeof adjustments === 'object'
    ? normalizeLoadedAdjustments(adjustments as Adjustments)
    : structuredClone(INITIAL_ADJUSTMENTS);

const normalizeCameraPart = (value: string) => value.trim().replace(/^"|"$/g, '').replace(/\s+/g, ' ').toLowerCase();

export const isSameCamera = (a: Camera, b: Camera) =>
  normalizeCameraPart(a.make) === normalizeCameraPart(b.make) &&
  normalizeCameraPart(a.model) === normalizeCameraPart(b.model);

export const cameraDisplayName = ({ make, model }: Camera) => {
  const brand = make.trim().split(/\s+/)[0] ?? '';
  return brand && model.trim().toLowerCase().startsWith(brand.toLowerCase())
    ? model.trim()
    : `${make.trim()} ${model.trim()}`.trim();
};

const valueAtPath = (source: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], source);

export const useAdjustmentSliderReset = (): SliderResetResolver | null => {
  const resetToDefaults = useSettingsStore((state) => state.appSettings?.sliderResetTarget === 'defaults');
  const imageDefaults = useEditorStore((state) => state.imageDefaults);
  return useMemo(() => {
    if (!resetToDefaults || !imageDefaults) return null;
    return (key: string) => {
      const defaults = loadedOpenImageDefaults();
      const value = defaults ? valueAtPath(defaults, key) : undefined;
      return typeof value === 'number' ? value : undefined;
    };
  }, [resetToDefaults, imageDefaults]);
};
