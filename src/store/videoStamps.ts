import { invoke } from '@tauri-apps/api/core';
import { Invokes } from '../types/invokes';
import { Coord } from '../utils/adjustments';
import { getOrientedDimensions } from '../utils/cropUtils';
import { StampContainer, StampWarps, shownStamp, stampWarps, storedStamp } from '../utils/video/maskTracking';
import { useEditorStore } from './useEditorStore';
import { getVideo, isVideoPath, useVideoStore } from './useVideoStore';
import { maskFrameTime } from './videoMotion';
import { locateItem, mediaOf } from '../utils/video/model';

const showsVideoFrames = (state: ReturnType<typeof getVideo>) => {
  const { session, project, editorItemId } = state;
  if (session?.kind === 'clip') return isVideoPath(session.path);
  const item = session && project ? locateItem(project, editorItemId)?.item : null;
  return !!project && item?.type === 'clip' && mediaOf(project, item.media)?.kind === 'video';
};

export const isVideoRetouch = () => showsVideoFrames(getVideo());

export const useVideoRetouch = () => useVideoStore(showsVideoFrames);

const stampFrame = () => {
  const { selectedImage, adjustments } = useEditorStore.getState();
  return getOrientedDimensions(
    selectedImage?.width ?? 0,
    selectedImage?.height ?? 0,
    adjustments.orientationSteps ?? 0,
  );
};

export const stampWarpsNow = (container: StampContainer): StampWarps => {
  const { width, height } = stampFrame();
  return stampWarps(container, maskFrameTime(getVideo(), true), width, height);
};

export const shownStampContainer = (container: StampContainer, warps: StampWarps): StampContainer => ({
  ...container,
  subMasks: container.subMasks.map((subMask) => ({
    ...subMask,
    parameters: shownStamp(subMask.type, subMask.parameters ?? {}, warps),
  })),
});

export const findStampSource = async (container: StampContainer, variant: number): Promise<Coord> => {
  const warps = stampWarpsNow(container);
  const [x, y] = await invoke<[number, number]>(Invokes.FindCloneSource, {
    patchDefinition: shownStampContainer(container, warps),
    currentAdjustments: useEditorStore.getState().adjustments,
    sourceVariant: variant,
  });
  const stored = storedStamp('', { sourceX: x, sourceY: y }, warps);
  return { x: stored.sourceX, y: stored.sourceY };
};
