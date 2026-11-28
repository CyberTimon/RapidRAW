import { create } from 'zustand';
import { ClipItem, FrameRate, Ticks, TimeRange, TimelineItem, VideoProject } from '../types/video';
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
  CopiedKeyframe,
  KeyMark,
  MarkedKeyframes,
  copyKeyframes,
  keyframeShiftLimit,
  pasteKeyframes,
  shiftKeyframes,
  rippleDelete,
  setRangeEdge,
  splitAll,
  toggleMarker,
  trimItem,
  unlinkItems,
} from '../utils/video/edit';
import { removeCaptions } from '../utils/video/captions';
import { contentSize } from '../utils/video/layouts';
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
let keyframeClipboard: Array<CopiedKeyframe> = [];

export const hasClipboard = () => clipboard.length > 0 || keyframeClipboard.length > 0;

const selectedKeyframeCopy = (project: VideoProject) => {
  const marks = selectedKeyframeMarks();
  const primary = marks[0]?.itemId;
  const item = primary ? locateItem(project, primary)?.item : null;
  return item
    ? copyKeyframes(
        project,
        item,
        marks.filter((entry) => entry.itemId === primary).map((entry) => entry.mark),
      )
    : null;
};

export const canCopySelection = () => {
  const { project, selection } = getVideo();
  if (!project) return false;
  const keyframes = selectedKeyframeCopy(project);
  return keyframes ? keyframes.length > 0 : copyItems(project, selection).length > 0;
};

export const copySelection = () => {
  const { project, selection } = getVideo();
  if (!project) return;
  const keyframes = selectedKeyframeCopy(project);
  if (keyframes) {
    if (keyframes.length > 0) {
      keyframeClipboard = keyframes;
      clipboard = [];
    }
    return;
  }
  const entries = copyItems(project, selection);
  if (entries.length > 0) {
    clipboard = entries;
    keyframeClipboard = [];
  }
};

const pasteKeyframesAtPlayhead = () => {
  const { project, playhead, selection } = getVideo();
  const item = project
    ? selection.map((id) => locateItem(project, id)?.item).find((candidate) => candidate && candidate.type !== 'audio')
    : null;
  if (!project || !item) return;
  const local = snapTicks(playhead, project.settings.fps) - item.start;
  if (local < 0 || local > item.duration) return;
  editProject((current) => pasteKeyframes(current, item.id, keyframeClipboard, local));
  selectKeyframe({ itemId: item.id, time: local });
};

export const pasteAtPlayhead = () => {
  if (keyframeClipboard.length > 0) {
    pasteKeyframesAtPlayhead();
    return;
  }
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

interface KeyframeSelection {
  selected: SelectedKeyframe | null;
  group: Array<SelectedKeyframe>;
  offset: Ticks | null;
}

export const useKeyframeSelection = create<KeyframeSelection>(() => ({ selected: null, group: [], offset: null }));

const sameKeyframe = (a: SelectedKeyframe, b: SelectedKeyframe, fps: FrameRate) =>
  a.itemId === b.itemId && Math.abs(a.time - b.time) <= frameTicks(fps) / 2;

export const selectKeyframe = (selected: SelectedKeyframe | null) =>
  useKeyframeSelection.setState({ selected, group: selected ? [selected] : [], offset: null });

export const toggleKeyframeSelection = (keyframe: SelectedKeyframe, fps: FrameRate) =>
  useKeyframeSelection.setState(({ group }) => {
    const chosen = group.some((other) => sameKeyframe(other, keyframe, fps));
    const next = chosen ? group.filter((other) => !sameKeyframe(other, keyframe, fps)) : [...group, keyframe];
    return { group: next, selected: chosen ? (next.at(-1) ?? null) : keyframe, offset: null };
  });

export const isKeyframeSelected = (group: Array<SelectedKeyframe>, itemId: string, mark: KeyMark, fps: FrameRate) =>
  group.some((keyframe) => keyframe.itemId === itemId && isMarkAt(mark, keyframe.time, fps));

export const selectedKeyframeMarks = (): Array<MarkedKeyframes> => {
  const { group } = useKeyframeSelection.getState();
  const { project, selection } = getVideo();
  if (!project) return [];
  return group.flatMap((keyframe) => {
    const item = selection.includes(keyframe.itemId) ? locateItem(project, keyframe.itemId)?.item : null;
    const mark = item
      ? keyframeMarks(project, item).find((candidate) => isMarkAt(candidate, keyframe.time, project.settings.fps))
      : null;
    return mark ? [{ itemId: keyframe.itemId, mark }] : [];
  });
};

export const keyframeDragOffset = (delta: Ticks) => {
  const { project } = getVideo();
  return project ? keyframeShiftLimit(project, selectedKeyframeMarks(), delta) : 0;
};

export const previewKeyframeOffset = (offset: Ticks | null) => useKeyframeSelection.setState({ offset });

export const moveSelectedKeyframes = (delta: Ticks) => {
  useKeyframeSelection.setState({ offset: null });
  const { project } = getVideo();
  const targets = selectedKeyframeMarks();
  if (!project || targets.length === 0) return;
  const fps = project.settings.fps;
  const shift = keyframeShiftLimit(project, targets, delta);
  if (shift === 0) return;
  editProject((current) => shiftKeyframes(current, targets, shift));
  const group = targets.map(({ itemId, mark }) => ({ itemId, time: snapTicks(mark.time + shift, fps) }));
  const { selected } = useKeyframeSelection.getState();
  useKeyframeSelection.setState({
    group,
    selected:
      (selected &&
        group.find((keyframe) => sameKeyframe(keyframe, { ...selected, time: selected.time + shift }, fps))) ??
      group.at(-1) ??
      null,
  });
};

useVideoStore.subscribe((state, previous) => {
  const undone = state.future.length > previous.future.length;
  if ((state.selection !== previous.selection || undone) && useKeyframeSelection.getState().group.length > 0)
    selectKeyframe(null);
});

export const nudgeSelectedKeyframes = (frames: number) => {
  const { project } = getVideo();
  if (project) moveSelectedKeyframes(frames * frameTicks(project.settings.fps));
};

export const hasKeyframeSelection = () => selectedKeyframeMarks().length > 0;

export const deleteSelected = () => {
  const gap = selectedGap();
  if (gap) {
    deleteGap(gap);
    return;
  }
  const targets = selectedKeyframeMarks();
  selectKeyframe(null);
  if (targets.length === 0) {
    deleteSelection();
    return;
  }
  editProject((current) =>
    targets.reduce((next, { itemId, mark }) => removeKeyframes(next, itemId, mark.keys), current),
  );
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
    const size = contentSize(current, clip, getVideo().media);
    const [next, freezeId] = insertFreeze(current, clip.id, playhead, secondsToTicks(FREEZE_SECONDS), size, sourceFps);
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
  const { project, playhead, recordKeyframes, recordFrom } = getVideo();
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
      const anchor = recordFrom === null ? null : editorLookTime(next, item, recordFrom);
      const recorded = recordLookEdit(stored, edited, time, time, recordKeyframes, frameTicks(fps) / 2, anchor);
      return assignLook(next, id, recorded)[0];
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

export const toggleRecordKeyframes = () =>
  setVideo((state) => ({
    recordKeyframes: !state.recordKeyframes,
    recordFrom: state.recordKeyframes ? null : state.playhead,
  }));
