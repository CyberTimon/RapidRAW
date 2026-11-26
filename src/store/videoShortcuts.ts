import { Ticks, TimeRange, TimelineItem } from '../types/video';
import { Panel } from '../types/ui';
import { comboCandidates, comboMapFor } from '../utils/keyboardUtils';
import type { VideoKind } from './videoIntegration';
import { keyframeMarks, toggleKeyframesAt, visualItemsAt } from '../utils/video/edit';
import { itemEnd, locateItem, mainTrack } from '../utils/video/model';
import { fpsValue, secondsToTicks, snapTicks } from '../utils/video/time';
import {
  editProject,
  getVideo,
  isProjectSession,
  redoProject,
  saveOpenProject,
  selectItems,
  setPlayhead,
  splitAtPlayhead,
  stepFrames,
  undoProject,
} from './useVideoStore';
import { isPanelAvailable, useUIStore } from './useUIStore';
import { setTrimPoint } from './videoClip';
import {
  clearRange,
  canCopySelection,
  copyLook,
  copySelection,
  deleteSelected,
  duplicateSelection,
  editMediaAtPlayhead,
  freezeFrame,
  hasClipboard,
  hasGapSelection,
  hasCopiedLook,
  jumpTo,
  jumpToEdit,
  jumpToMarker,
  nudgeSelection,
  pasteAtPlayhead,
  pasteCopiedLook,
  rippleDeleteSelection,
  selectAllItems,
  setRangeAtPlayhead,
  splitAllAtPlayhead,
  toggleMarkerAtPlayhead,
  toggleRecordKeyframes,
  toggleSnapping,
  trimSelectionToPlayhead,
  type MediaEdit,
} from './videoEditing';
import { addTitle } from './videoEffects';
import { exportVideoFrame } from './videoExport';
import { nestSelection, unnestSelection } from './videoNesting';
import { pause, play, playInToOut, toggleLoop, togglePlay } from './videoPlayback';
import { fitTimeline, zoomTimeline } from '../components/video/timeline/layout';
import { clearSkimmedRange, markSkimmedMedia } from '../components/video/mediaPool/media';

const REPLAY_SECONDS = 3;
const ZOOM_STEP = 1.5;
const NUDGE_FRAMES = 5;

interface VideoShortcut {
  run(): void;
  projectOnly?: boolean;
  enabled?(): boolean;
}

const hasSelection = () => getVideo().selection.length > 0;

const hasTarget = () => hasSelection() || hasGapSelection();

const secondInFrames = () => Math.round(fpsValue(getVideo().project!.settings.fps));

const anySession = (run: () => void): VideoShortcut => ({ run });
const projectOnly = (run: () => void, enabled?: () => boolean): VideoShortcut => ({ run, projectOnly: true, enabled });

export const toStart = () => setPlayhead(0);
export const previousFrame = () => stepFrames(-1);
export const nextFrame = () => stepFrames(1);
export const exportFrame = () => void exportVideoFrame();
const backSecond = anySession(() => stepFrames(-secondInFrames()));
const forwardSecond = anySession(() => stepFrames(secondInFrames()));
const focusedMedia = () => {
  const tile =
    document.activeElement instanceof HTMLElement
      ? document.activeElement.closest<HTMLElement>('[data-media-id]')
      : null;
  const id = tile?.dataset.mediaId;
  return id && getVideo().project?.media.some((media) => media.id === id) ? id : null;
};
const mediaEdit = (mode: MediaEdit) =>
  projectOnly(
    () => {
      const id = focusedMedia();
      if (id) void editMediaAtPlayhead(id, mode);
    },
    () => focusedMedia() !== null,
  );
const markRange = (edge: keyof TimeRange) =>
  anySession(() => {
    if (markSkimmedMedia(edge)) return;
    if (isProjectSession()) setRangeAtPlayhead(edge);
    else setTrimPoint(edge === 'start' ? 'in' : 'out');
  });
const redo = projectOnly(redoProject);
const remove = projectOnly(deleteSelected, hasTarget);
const rippleRemove = projectOnly(rippleDeleteSelection, hasTarget);

const covers = (item: TimelineItem, time: Ticks) => time >= item.start && time < itemEnd(item);

const itemsAtPlayhead = () => {
  const { project, playhead } = getVideo();
  if (!project) return [];
  return [
    ...visualItemsAt(project, playhead).map(({ item }) => item),
    ...project.audioTracks.flatMap((track) => track.items.filter((item) => covers(item, playhead))),
  ];
};

const fallbackTargets = (fallback: () => TimelineItem | undefined) => {
  const { selection } = getVideo();
  if (selection.length > 0) return selection;
  const item = fallback();
  return item ? [item.id] : [];
};

const mainClipAtPlayhead = () => {
  const { project, playhead } = getVideo();
  return project ? mainTrack(project).items.find((item) => covers(item, playhead)) : undefined;
};

const trimTargets = () => fallbackTargets(mainClipAtPlayhead);

const nudgeTargets = () =>
  fallbackTargets(() => {
    const { project, playhead } = getVideo();
    return project
      ? visualItemsAt(project, playhead)
          .filter(({ trackIndex }) => trackIndex > 0)
          .at(-1)?.item
      : undefined;
  });

const nudge = (frames: number) =>
  projectOnly(
    () => nudgeSelection(frames, nudgeTargets()),
    () => nudgeTargets().length > 0,
  );

const selectClipAtPlayhead = () => {
  const { selection } = getVideo();
  const stack = itemsAtPlayhead();
  const current = stack.findIndex((item) => selection.includes(item.id));
  const next = [...stack.slice(current + 1), ...stack.slice(0, current + 1)].find(
    (item) => !selection.includes(item.id),
  );
  if (next) selectItems([next.id], false);
};

const keyframeTargets = () => {
  const { project, playhead } = getVideo();
  return project
    ? trimTargets().flatMap((id) => {
        const item = locateItem(project, id)?.item;
        return item && covers(item, playhead) ? [item] : [];
      })
    : [];
};

const toggleKeyframes = () => {
  const { project, playhead } = getVideo();
  const targets = keyframeTargets();
  if (!project || targets.length === 0) return;
  const time = snapTicks(playhead, project.settings.fps);
  editProject((current) =>
    targets.reduce((next, item) => toggleKeyframesAt(next, item.id, time - item.start), current),
  );
};

const jumpToKeyframe = (direction: 1 | -1) => {
  const { project } = getVideo();
  if (!project) return;
  const items = trimTargets().flatMap((id) => locateItem(project, id)?.item ?? []);
  jumpTo(
    items.flatMap((item) => keyframeMarks(project, item).map((mark) => item.start + mark.time)),
    direction,
  );
};

const replay = () => {
  setPlayhead(getVideo().playhead - secondsToTicks(REPLAY_SECONDS));
  void play();
};

const showPanel = (panel: Panel) => () => {
  const ui = useUIStore.getState();
  if (isPanelAvailable(ui, panel)) ui.setPanel(panel);
};

const VIDEO_SHORTCUTS: Record<string, VideoShortcut> = {
  video_play_pause: anySession(togglePlay),
  video_play: anySession(() => void play()),
  video_pause: anySession(pause),
  video_play_in_out: anySession(playInToOut),
  video_loop: anySession(toggleLoop),
  video_jump_back: anySession(replay),
  video_prev_frame: anySession(previousFrame),
  video_next_frame: anySession(nextFrame),
  video_prev_frame_alt: anySession(previousFrame),
  video_next_frame_alt: anySession(nextFrame),
  video_back_second: backSecond,
  video_forward_second: forwardSecond,
  video_back_second_alt: backSecond,
  video_forward_second_alt: forwardSecond,
  video_go_start: projectOnly(toStart),
  video_go_end: projectOnly(() => setPlayhead(secondsToTicks(24 * 3600))),
  video_prev_edit: projectOnly(() => jumpToEdit(-1)),
  video_next_edit: projectOnly(() => jumpToEdit(1)),
  video_prev_marker: projectOnly(() => jumpToMarker(-1)),
  video_next_marker: projectOnly(() => jumpToMarker(1)),
  video_prev_keyframe: projectOnly(() => jumpToKeyframe(-1)),
  video_next_keyframe: projectOnly(() => jumpToKeyframe(1)),
  video_save_project: projectOnly(() => void saveOpenProject()),
  video_undo: projectOnly(undoProject),
  video_redo: redo,
  video_redo_alt: redo,
  video_split: projectOnly(splitAtPlayhead),
  video_split_all: projectOnly(splitAllAtPlayhead),
  video_delete: remove,
  video_delete_alt: remove,
  video_ripple_delete: rippleRemove,
  video_ripple_delete_alt: rippleRemove,
  video_copy: projectOnly(copySelection, canCopySelection),
  video_paste: projectOnly(pasteAtPlayhead, hasClipboard),
  video_copy_adjustments: projectOnly(
    () => copyLook(getVideo().editorItemId),
    () => getVideo().editorItemId !== null,
  ),
  video_paste_adjustments: projectOnly(pasteCopiedLook, hasCopiedLook),
  video_duplicate: projectOnly(duplicateSelection, hasSelection),
  video_freeze_frame: projectOnly(() => freezeFrame()),
  video_insert: mediaEdit('insert'),
  video_overwrite: mediaEdit('overwrite'),
  video_select_all: projectOnly(selectAllItems),
  video_select_at_playhead: projectOnly(selectClipAtPlayhead),
  video_add_title: projectOnly(addTitle),
  video_toggle_keyframe: projectOnly(toggleKeyframes, () => keyframeTargets().length > 0),
  video_record_keyframes: projectOnly(toggleRecordKeyframes),
  video_trim_start: projectOnly(() => trimSelectionToPlayhead('start', trimTargets())),
  video_trim_end: projectOnly(() => trimSelectionToPlayhead('end', trimTargets())),
  video_nudge_left: nudge(-1),
  video_nudge_right: nudge(1),
  video_nudge_left_more: nudge(-NUDGE_FRAMES),
  video_nudge_right_more: nudge(NUDGE_FRAMES),
  video_nest: projectOnly(nestSelection, hasSelection),
  video_unnest: projectOnly(unnestSelection, hasSelection),
  video_export_frame: anySession(exportFrame),
  video_set_in: markRange('start'),
  video_set_out: markRange('end'),
  video_clear_range: projectOnly(() => clearSkimmedRange() || clearRange()),
  video_add_marker: projectOnly(toggleMarkerAtPlayhead),
  video_toggle_snapping: projectOnly(toggleSnapping),
  video_zoom_in: projectOnly(() => zoomTimeline(ZOOM_STEP)),
  video_zoom_out: projectOnly(() => zoomTimeline(1 / ZOOM_STEP)),
  video_zoom_fit: projectOnly(fitTimeline),
  video_panel_project: projectOnly(showPanel(Panel.MediaPool)),
  video_panel_inspector: projectOnly(showPanel(Panel.Inspector)),
  video_panel_effects: projectOnly(showPanel(Panel.Effects)),
  video_panel_captions: projectOnly(showPanel(Panel.Captions)),
  video_panel_mixer: projectOnly(showPanel(Panel.Mixer)),
};

export const isVideoShortcut = (action: string) => action in VIDEO_SHORTCUTS;

export const videoShortcutLive = (action: string, kind: VideoKind) => {
  const shortcut = VIDEO_SHORTCUTS[action];
  return !!shortcut && kind !== 'none' && (!shortcut.projectOnly || kind === 'project');
};

const videoShortcutFor = (action: string | undefined): (() => void) | null => {
  const { project, session } = getVideo();
  if (!project || !session || !action || !videoShortcutLive(action, session.kind)) return null;
  const shortcut = VIDEO_SHORTCUTS[action];
  return !shortcut.enabled || shortcut.enabled() ? shortcut.run : null;
};

export const videoShortcutMatcher = (keybinds: Record<string, Array<string>> | undefined, osPlatform?: string) => {
  const combos = comboMapFor('video', keybinds, osPlatform);
  const mediaCombos = comboMapFor('media', keybinds, osPlatform);
  return (event: KeyboardEvent) =>
    comboCandidates(event, osPlatform).reduce<(() => void) | null>((found, parts) => {
      const combo = parts.join('+');
      return found ?? videoShortcutFor(mediaCombos.get(combo)) ?? videoShortcutFor(combos.get(combo));
    }, null);
};
