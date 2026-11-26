import { create } from 'zustand';
import { ClipItem, Ticks, TimeRange, TimelineItem, VideoProject } from '../types/video';
import { Adjustments, INITIAL_ADJUSTMENTS, MaskContainer, copyableAdjustments, pastePatch } from '../utils/adjustments';
import { stripAiMaskResults } from '../utils/maskUtils';
import {
  ClipboardEntry,
  assignLook,
  canLink,
  closeGap,
  copyItems,
  duplicateItems,
  editTrackFor,
  groupLeaders,
  insertFreeze,
  insertItemAt,
  isMarkAt,
  joinItems,
  keyframeMarks,
  linkItems,
  mainGaps,
  markerAt,
  nudgeItems,
  overwriteItemAt,
  pasteItems,
  removeKeyframes,
  rippleDelete,
  setRangeEdge,
  splitAll,
  toggleMarker,
  trimItem,
  unlinkItems,
} from '../utils/video/edit';
import { removeCaptions } from '../utils/video/captions';
import { animateLook, recordLookEdit } from '../utils/video/lookAnimation';
import type { TrackedContainer } from '../utils/video/maskTracking';
import { allItems, hasLook, itemEnd, locateItem, lookOf, mediaDurationTicks, mediaOf } from '../utils/video/model';
import { frameTicks, secondsToTicks, snapTicks } from '../utils/video/time';
import { useEditorStore } from './useEditorStore';
import { useProcessStore } from './useProcessStore';
import { useSettingsStore } from './useSettingsStore';
import { followPastedAiMasks, unfollowSubMask, watchFollows } from './videoMotion';
import {
  clampPlayhead,
  deleteSelection,
  editProject,
  editorClipAt,
  editorLookTime,
  getVideo,
  mediaItems,
  prepareMedia,
  setPlayhead,
  setVideo,
  useVideoStore,
} from './useVideoStore';

const FREEZE_SECONDS = 2;

let clipboard: Array<ClipboardEntry> = [];

export const hasClipboard = () => clipboard.length > 0;

export const canCopySelection = () => {
  const { project, selection } = getVideo();
  return !!project && copyItems(project, selection).length > 0;
};

export const copySelection = () => {
  const { project, selection } = getVideo();
  if (!project) return;
  const entries = copyItems(project, selection);
  if (entries.length > 0) clipboard = entries;
};

export const pasteAtPlayhead = () => {
  const { project, playhead } = getVideo();
  if (!project || clipboard.length === 0) return;
  let pasted: Array<string> = [];
  editProject((current) => {
    const [next, ids] = pasteItems(current, clipboard, snapTicks(playhead, current.settings.fps));
    pasted = ids;
    return next;
  });
  setVideo({ selection: pasted });
};

export const useGapSelection = create<{ selected: string | null }>(() => ({ selected: null }));

export const selectGap = (selected: string | null) => {
  if (useGapSelection.getState().selected !== selected) useGapSelection.setState({ selected });
};

const selectedGap = () => {
  const { selected } = useGapSelection.getState();
  const { project, selection } = getVideo();
  return project && selection.length === 0 && mainGaps(project).some((gap) => gap.id === selected) ? selected : null;
};

export const hasGapSelection = () => selectedGap() !== null;

export const deleteGap = (id: string) => {
  selectGap(null);
  editProject((current) => closeGap(current, id));
};

useVideoStore.subscribe((state, prev) => {
  if (state.selection !== prev.selection && state.selection.length > 0) selectGap(null);
});

watchFollows();

export const rippleDeleteSelection = () => {
  const gap = selectedGap();
  if (gap) {
    deleteGap(gap);
    return;
  }
  const { project, selection } = getVideo();
  if (!project || selection.length === 0) return;
  editProject((current) => removeCaptions(rippleDelete(current, selection), selection));
  setVideo({ selection: [] });
};

export const joinSelection = () => {
  const { project, selection } = getVideo();
  if (!project || selection.length === 0) return;
  let kept = selection;
  editProject((current) => {
    const [next, ids] = joinItems(current, selection);
    kept = ids;
    return next;
  });
  setVideo({ selection: kept });
};

export const nudgeSelection = (frames: number, ids = getVideo().selection) => {
  if (!getVideo().project || ids.length === 0) return;
  editProject(
    (current) => nudgeItems(current, ids, frames * frameTicks(current.settings.fps)),
    `nudge:${ids.join(',')}`,
  );
};

export const selectAllItems = () => {
  const { project } = getVideo();
  if (project) setVideo({ selection: allItems(project).map((item) => item.id) });
};

export const splitAllAtPlayhead = () => {
  const { project, playhead } = getVideo();
  if (project) editProject((current) => splitAll(current, playhead));
};

export const markerAtPlayhead = (project: VideoProject, playhead: Ticks) =>
  markerAt(project, snapTicks(playhead, project.settings.fps));

export const toggleMarkerAtPlayhead = () => {
  const { project, playhead } = getVideo();
  if (project) {
    editProject((current) => toggleMarker(current, snapTicks(playhead, current.settings.fps)));
  }
};

interface SelectedKeyframe {
  itemId: string;
  time: Ticks;
}

export const useKeyframeSelection = create<{ selected: SelectedKeyframe | null }>(() => ({ selected: null }));

export const selectKeyframe = (selected: SelectedKeyframe | null) => useKeyframeSelection.setState({ selected });

const selectedKeyframeMark = () => {
  const { selected } = useKeyframeSelection.getState();
  const { project, selection } = getVideo();
  const item = project && selected && selection.includes(selected.itemId) ? locateItem(project, selected.itemId) : null;
  if (!project || !selected || !item) return null;
  const mark = keyframeMarks(project, item.item).find((candidate) =>
    isMarkAt(candidate, selected.time, project.settings.fps),
  );
  return mark ? { itemId: selected.itemId, mark } : null;
};

export const deleteSelected = () => {
  const gap = selectedGap();
  if (gap) {
    deleteGap(gap);
    return;
  }
  const target = selectedKeyframeMark();
  selectKeyframe(null);
  if (!target) {
    deleteSelection();
    return;
  }
  editProject((current) => removeKeyframes(current, target.itemId, target.mark.keys));
};

export const jumpTo = (times: Array<Ticks>, direction: 1 | -1) => {
  const { playhead } = getVideo();
  const target = [...times].sort((a, b) => (a - b) * direction).find((time) => (time - playhead) * direction > 0);
  if (target !== undefined) setPlayhead(target);
};

export const jumpToMarker = (direction: 1 | -1) => {
  const markers = getVideo().project?.markers.map((marker) => marker.time) ?? [];
  jumpTo(markers, direction);
};

export const jumpToEdit = (direction: 1 | -1) => {
  const { project } = getVideo();
  if (!project) return;
  const edits = project.videoTracks.flatMap((track) =>
    track.items.flatMap((item) => [item.start, itemEnd(item)].map((time) => clampPlayhead(project, time))),
  );
  jumpTo(edits, direction);
};

const mediaRefOf = (project: VideoProject, item: TimelineItem) =>
  'media' in item ? mediaOf(project, item.media) : null;

export const mediaDurationOf = (project: VideoProject, item: TimelineItem) => {
  const ref = mediaRefOf(project, item);
  return ref ? mediaDurationTicks(getVideo().media[ref.path], ref.kind) : Number.POSITIVE_INFINITY;
};

export const sourceFpsOf = (project: VideoProject, item: TimelineItem) => {
  const ref = mediaRefOf(project, item);
  return ref ? getVideo().media[ref.path]?.fps : undefined;
};

export const trimSelectionToPlayhead = (edge: 'start' | 'end', ids = getVideo().selection) => {
  const { project, playhead } = getVideo();
  if (!project) return;
  editProject((current) =>
    groupLeaders(current, ids).reduce((next, id) => {
      const item = locateItem(next, id)?.item;
      return item && playhead > item.start && playhead < itemEnd(item)
        ? trimItem(next, id, edge, playhead, (other) => mediaDurationOf(next, other))
        : next;
    }, current),
  );
};

export const linkSelection = () => {
  const { project, selection } = getVideo();
  if (project && canLink(project, selection)) editProject((current) => linkItems(current, selection));
};

export const unlinkSelection = () => {
  const { project, selection } = getVideo();
  if (project) editProject((current) => unlinkItems(current, selection));
};

export const duplicateSelection = () => {
  const { project, selection } = getVideo();
  if (project) editProject((current) => duplicateItems(current, selection));
};

export const canFreeze = (project: VideoProject, item: TimelineItem | null | undefined): item is ClipItem => {
  const kind = item?.type === 'clip' && !item.freeze ? mediaOf(project, item.media)?.kind : null;
  return kind === 'video' || kind === 'sequence';
};

export const freezeFrame = (id?: string) => {
  const { project, playhead, selection } = getVideo();
  if (!project) return;
  const selected = selection
    .map((selectedId) => locateItem(project, selectedId)?.item)
    .find((item) => canFreeze(project, item) && playhead >= item.start && playhead < itemEnd(item));
  const clip = id ? locateItem(project, id)?.item : (selected ?? editorClipAt(project, playhead));
  if (!canFreeze(project, clip)) return;
  const sourceFps = sourceFpsOf(project, clip);
  let frozen = null as string | null;
  editProject((current) => {
    const [next, freezeId] = insertFreeze(current, clip.id, playhead, secondsToTicks(FREEZE_SECONDS), sourceFps);
    frozen = freezeId;
    return next;
  });
  if (frozen) setVideo({ selection: [frozen] });
};

export type MediaEdit = 'insert' | 'overwrite';

export const editMediaAtPlayhead = async (mediaId: string, mode: MediaEdit) => {
  const media = getVideo().project?.media.find((entry) => entry.id === mediaId);
  const [prepared] = media ? await prepareMedia([media.path]) : [];
  if (!prepared) return;
  let placed: TimelineItem | null = null;
  editProject((current) => {
    const { playhead, selection } = getVideo();
    const target = editTrackFor(current, selection, prepared.kind === 'audio' ? 'audio' : 'video');
    const [withMedia, [item]] = mediaItems(current, [prepared], target.kind === 'video' && target.trackIndex > 0);
    if (!item) return current;
    const time = snapTicks(playhead, withMedia.settings.fps);
    const next =
      mode === 'insert'
        ? insertItemAt(withMedia, item, target, time)
        : overwriteItemAt(withMedia, item, target, time, (other) => mediaDurationOf(withMedia, other));
    placed = locateItem(next, item.id)?.item ?? null;
    return placed ? next : current;
  });
  const landed = placed as TimelineItem | null;
  if (!landed) return;
  setVideo({ selection: [landed.id] });
  setPlayhead(itemEnd(landed));
};

interface LookSource {
  adjustments: Adjustments;
  itemId: string;
  path: string | null;
}

let copiedSource: LookSource | null = null;

const unboundMasks = (masks: Array<MaskContainer>, tracked: boolean) =>
  stripAiMaskResults(masks).map((container) => ({
    ...container,
    ...(!tracked && (container as TrackedContainer).track ? { track: null } : {}),
    subMasks: container.subMasks.map(unfollowSubMask),
  }));

const keepsMaskResults = (project: VideoProject, item: TimelineItem, source: LookSource | null) => {
  if (!source) return false;
  if (source.itemId === item.id) return true;
  const ref = mediaRefOf(project, item);
  return ref?.kind === 'image' && ref.path === source.path;
};

const sameFootage = (project: VideoProject, item: TimelineItem, source: LookSource | null) =>
  !!source?.path && item.type === 'clip' && mediaRefOf(project, item)?.path === source.path;

const editorTargets = () => {
  const { editorItemId } = getVideo();
  return editorItemId ? [editorItemId] : [];
};

const applyLook = (patch: Partial<Adjustments>, ids: Array<string>, source: LookSource | null = null) => {
  const { project, playhead, recordKeyframes } = getVideo();
  if (!project) return;
  const fps = project.settings.fps;
  const rebound: Array<string> = [];
  editProject((current) =>
    ids.reduce((next, id) => {
      const item = locateItem(next, id)?.item;
      if (!item || !hasLook(item)) return next;
      const keep = !patch.masks || keepsMaskResults(next, item, source);
      if (!keep) rebound.push(id);
      const stored = lookOf(next, item) ?? INITIAL_ADJUSTMENTS;
      const time = editorLookTime(next, item, playhead);
      const pasted = keep
        ? patch
        : { ...patch, masks: unboundMasks(patch.masks ?? [], sameFootage(next, item, source)) };
      const edited = { ...animateLook(stored, time), ...pasted };
      return assignLook(next, id, recordLookEdit(stored, edited, time, time, recordKeyframes, frameTicks(fps) / 2))[0];
    }, current),
  );
  if (rebound.length > 0) void followPastedAiMasks(rebound);
};

export const pasteLook = (patch: Partial<Adjustments>) => applyLook(patch, editorTargets());

export const pasteLookToSelection = (patch: Partial<Adjustments>) => applyLook(patch, getVideo().selection);

export const copyLook = (itemId: string | null) => {
  const { project, playhead, editorItemId } = getVideo();
  const item = project && itemId ? locateItem(project, itemId)?.item : null;
  if (!project || !item || !hasLook(item)) return;
  const look =
    item.id === editorItemId
      ? useEditorStore.getState().adjustments
      : animateLook(lookOf(project, item) ?? INITIAL_ADJUSTMENTS, editorLookTime(project, item, playhead));
  const copied = copyableAdjustments(look);
  const ref = mediaRefOf(project, item);
  copiedSource = { adjustments: copied, itemId: item.id, path: ref?.path ?? null };
  useEditorStore.getState().setEditor({ copiedAdjustments: copied, copiedAdjustmentsDefaults: INITIAL_ADJUSTMENTS });
  useProcessStore.getState().setProcess({ isCopied: true });
};

export const hasCopiedLook = () => useEditorStore.getState().copiedAdjustments !== null;

const pasteCopied = (ids: Array<string>) => {
  const { copiedAdjustments, copiedAdjustmentsDefaults } = useEditorStore.getState();
  if (!copiedAdjustments) return;
  const settings = useSettingsStore.getState().appSettings?.copyPasteSettings;
  const patch = pastePatch(copiedAdjustments, copiedAdjustmentsDefaults, settings);
  const source = copiedSource?.adjustments === copiedAdjustments ? copiedSource : null;
  if (Object.keys(patch).length > 0) applyLook(patch, ids, source);
  useProcessStore.getState().setProcess({ isPasted: true });
};

export const pasteCopiedLook = () => pasteCopied(getVideo().selection);

export const pasteCopiedLookToEditor = () => pasteCopied(editorTargets());

export const setRangeAtPlayhead = (edge: keyof TimeRange) => {
  const { project, playhead } = getVideo();
  if (project) editProject((current) => setRangeEdge(current, edge, snapTicks(playhead, current.settings.fps)));
};

export const clearRange = () => {
  if (getVideo().project?.range) editProject((current) => ({ ...current, range: null }));
};

export const toggleSnapping = () => setVideo((state) => ({ snapping: !state.snapping }));

export const toggleRecordKeyframes = () => setVideo((state) => ({ recordKeyframes: !state.recordKeyframes }));
