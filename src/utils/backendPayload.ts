import { invoke } from '@tauri-apps/api/core';
import { useEditorStore } from '../store/useEditorStore';
import { Invokes } from '../types/invokes';
import { Adjustments } from './adjustments';

const CACHED_EFFECT_MAP_PREFIX = '__cached__:';
const EFFECT_MAP_KEYS = ['lensBlurDepthMap', 'fogDepthMap', 'motionBlurDepthMap', 'relightNormalMap'] as const;
const MAX_TRACKED_EFFECT_MAPS = 16;

const effectMapIds = new Map<string, number>();
let nextEffectMapId = 1;

const getEffectMapId = (value: string): number => {
  let id = effectMapIds.get(value);
  if (id === undefined) {
    id = nextEffectMapId++;
    effectMapIds.set(value, id);
    if (effectMapIds.size > MAX_TRACKED_EFFECT_MAPS) {
      const oldest = effectMapIds.keys().next().value;
      if (oldest !== undefined) effectMapIds.delete(oldest);
    }
  }
  return id;
};

let sentEpoch = 0;
let cacheResets = 0;

export const forgetSentPatches = () => {
  sentEpoch += 1;
  useEditorStore.getState().patchesSentToBackend.clear();
};

const resettingPatchCache = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
  forgetSentPatches();
  cacheResets += 1;
  try {
    return await invoke<T>(command, args);
  } finally {
    cacheResets -= 1;
    forgetSentPatches();
  }
};

export const loadImage = <T>(path: string) => resettingPatchCache<T>(Invokes.LoadImage, { path });

export const clearSessionCaches = () => resettingPatchCache<void>('clear_session_caches');

export interface AdjustmentsPayload {
  payload: any;
  markSent(): void;
}

export const prepareAdjustmentsPayload = (adjustments: Adjustments): AdjustmentsPayload => {
  const epoch = sentEpoch;
  const { lensBlurDepthMap, fogDepthMap, motionBlurDepthMap, relightNormalMap, aiPatches, ...rest } = adjustments;
  const payload: any = structuredClone(rest);
  payload.aiPatches = Array.isArray(aiPatches)
    ? aiPatches.map(({ patchData, ...patch }: any) => ({ ...structuredClone(patch), patchData }))
    : aiPatches;

  const { patchesSentToBackend } = useEditorStore.getState();
  const newlySent = new Set<string>();

  const effectMaps: Record<string, unknown> = { lensBlurDepthMap, fogDepthMap, motionBlurDepthMap, relightNormalMap };
  const sentEffectMapIds: Record<string, number> = {};
  for (const key of EFFECT_MAP_KEYS) {
    const value = effectMaps[key];
    if (typeof value === 'string' && value.length > 0) {
      const id = getEffectMapId(value);
      const marker = `effectMap:${id}`;
      if (patchesSentToBackend.has(marker)) {
        payload[key] = `${CACHED_EFFECT_MAP_PREFIX}${id}`;
      } else {
        payload[key] = value;
        sentEffectMapIds[key] = id;
        newlySent.add(marker);
      }
    } else if (value !== undefined) {
      payload[key] = value;
    }
  }
  if (Object.keys(sentEffectMapIds).length > 0) {
    payload.effectMapIds = sentEffectMapIds;
  }

  const processSubMasks = (subMasks: any[]) => {
    if (!Array.isArray(subMasks)) return;
    subMasks.forEach((sm: any) => {
      if (sm.id && sm.parameters) {
        const keys = ['mask_data_base64', 'maskDataBase64'];
        let foundMaskData = false;

        for (const key of keys) {
          if (sm.parameters[key] !== undefined && sm.parameters[key] !== null) {
            foundMaskData = true;
            if (patchesSentToBackend.has(sm.id)) {
              sm.parameters[key] = null;
            }
          }
        }
        if (foundMaskData && !patchesSentToBackend.has(sm.id)) {
          newlySent.add(sm.id);
        }
      }
    });
  };

  if (payload.aiPatches && Array.isArray(payload.aiPatches)) {
    payload.aiPatches.forEach((p: any) => {
      if (p.id && p.patchData && !p.isLoading) {
        if (patchesSentToBackend.has(p.id)) {
          p.patchData = null;
        } else {
          newlySent.add(p.id);
        }
      }
      if (p.subMasks) processSubMasks(p.subMasks);
    });
  }

  if (payload.masks && Array.isArray(payload.masks)) {
    payload.masks.forEach((container: any) => {
      if (container.subMasks) processSubMasks(container.subMasks);
    });
  }

  return {
    payload,
    markSent: () => {
      if (epoch !== sentEpoch || cacheResets > 0) return;
      const sent = useEditorStore.getState().patchesSentToBackend;
      newlySent.forEach((id) => sent.add(id));
    },
  };
};
