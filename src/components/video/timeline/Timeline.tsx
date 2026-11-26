import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject } from 'react';
import { flushSync } from 'react-dom';
import { useDndMonitor, useDroppable } from '@dnd-kit/core';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import {
  AudioWaveform,
  Blend,
  Bookmark,
  Camera,
  Captions,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Eye,
  EyeOff,
  FlagOff,
  FlagTriangleLeft,
  FlagTriangleRight,
  FoldHorizontal,
  Gauge,
  Group,
  Layers,
  Link2,
  Link2Off,
  Lock,
  LockOpen,
  Magnet,
  Maximize2,
  Merge,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Play,
  Repeat,
  Rewind,
  Scissors,
  SkipBack,
  SkipForward,
  Snowflake,
  Split,
  SwatchBook,
  Trash2,
  Type,
  Ungroup,
  Unlink,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import Text from '../../ui/Text';
import { TextVariants } from '../../../types/typography';
import { OPTION_SEPARATOR, Option, Panel } from '../../../types/ui';
import { ClipItem, TICKS_PER_SECOND, Ticks, TimelineItem, TrackKind, VideoProject } from '../../../types/video';
import { useContextMenu } from '../../../context/ContextMenuContext';
import TransitionMarker, { transitionCover } from './TransitionMarker';
import { toggleSidePanel, toggleTimeline, useUIStore } from '../../../store/useUIStore';
import {
  DEFAULT_PIXELS_PER_SECOND,
  editProject,
  getVideo,
  isMediaCandidate,
  resizeTracks,
  selectItems,
  setPlayhead,
  setVideo,
  splitAtPlayhead,
  useProjectFps,
  useVideoStore,
} from '../../../store/useVideoStore';
import { editAudio, playInToOut, toggleLoop } from '../../../store/videoPlayback';
import { exportFrame, nextFrame, previousFrame, toStart } from '../../../store/videoShortcuts';
import { beatPathOf, loadBeats, useVideoBeats } from '../../../store/videoBeats';
import { useDuckCurveSync } from '../../../store/videoDucking';
import { editCaptions } from '../../../store/videoCaptions';
import { addTitle, transitionClips, transitionMenu } from '../../../store/videoEffects';
import { canUnnest, leaveNested, nestSelection, openNested, unnestSelection } from '../../../store/videoNesting';
import { setClipReversed } from '../../../store/videoMotion';
import { nestItems, openSequences } from '../../../utils/video/nesting';
import {
  canFreeze,
  clearRange,
  setRangeAtPlayhead,
  copyLook,
  copySelection,
  deleteSelected,
  duplicateSelection,
  freezeFrame,
  hasClipboard,
  hasCopiedLook,
  joinSelection,
  linkSelection,
  markerAtPlayhead,
  mediaDurationOf,
  pasteAtPlayhead,
  pasteCopiedLook,
  rippleDeleteSelection,
  selectGap,
  selectKeyframe,
  toggleMarkerAtPlayhead,
  toggleRecordKeyframes,
  toggleSnapping,
  unlinkSelection,
  useGapSelection,
} from '../../../store/videoEditing';
import { savePresetFromItem } from '../../../store/videoPresets';
import {
  addMarker,
  canJoin,
  canLink,
  canSlide,
  detachAudio,
  groupLeaders,
  linkedIds,
  lookUsers,
  mainSlotOf,
  makeLookUnique,
  MoveTarget,
  moveItems,
  pairedLinks,
  rollEdit,
  setItemSpeed,
  previousAudio,
  setCrossfade,
  DEFAULT_TRANSITION_SECONDS,
  setRangeEdge,
  setTransitionDuration,
  slideItem,
  slipLinked,
  trimItem,
  updateItem,
  updateTrack,
} from '../../../utils/video/edit';
import {
  allItems,
  hasLook,
  isRamped,
  itemEnd,
  locateItem,
  mediaOf,
  sequenceDuration,
  sourceLength,
  sourceTimeOf,
} from '../../../utils/video/model';
import { matteRoles } from '../../../utils/video/matte';
import {
  formatRulerTime,
  formatTimecode,
  frameTicks,
  secondsToTicks,
  snapTicks,
  ticksToSeconds,
} from '../../../utils/video/time';
import { alignHaptic } from '../../../utils/haptics';
import CaptionLane from './CaptionLane';
import ItemView, { type ItemHandlers, type SlideInfo, type TrimInfo } from './ItemView';
import GapLayer from './GapLayer';
import Timecode, { PlayheadState, PlayheadTimecode, usePlayheadEffect } from './Timecode';
import { LaneGuides, RulerMarkers } from './MarkerLayer';
import { PlaybackMenuButton, preventFocus } from './PlaybackControls';
import PlayButton from '../PlayButton';
import TrackToggle from '../TrackToggle';
import { RECORDING_CLASS } from '../RecordingBadge';
import {
  DRAG_THRESHOLD,
  HEADER_WIDTH,
  HeightOverrides,
  Layout,
  RULER_HEIGHT,
  Row,
  clampTrackHeight,
  computeLayout,
  cutRowTop,
  isMainRow,
  registerTimelineGeometry,
  rowAt,
  spanBox,
  stableLayout,
  storedTrackHeights,
  timeToX,
  trackLabel,
  trackScaleLimits,
  xToTime,
} from './layout';
import { snapSpan, snapTargets, snapTo, snapTolerance } from './snapping';
import { beginDropPreview, draggedPaths, endDropPreview, isDropPreviewing, useDropPlan } from './drop';
import { usePointerDrag } from './gestures';
import type { VideoDragData } from '../EffectsPanel';
import { montageMenu } from './montageMenu';
import { useShortcut, useShortcuts } from '../../../hooks/useShortcuts';
import type { ShortcutAction } from '../../../utils/keyboardUtils';

const MIN_PPS = 2;
const MAX_PPS = 600;
const RULER_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const MINOR_TICKS = 4;
const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4];
const TRACK_SCALE_SPEED = 0.0015;
const TRACK_SCALE_COMMIT_MS = 250;
const TRAILING_SPACE = 192;
const FIT_MARGIN = 48;
const STRIP_STEP = 512;
const SCROLL_STEP = 256;
const REFLOW_MS = 150;
const HEADER_BUTTON =
  'w-5 h-5 shrink-0 flex items-center justify-center rounded text-text-secondary hover:text-text-primary disabled:opacity-40 disabled:pointer-events-none';
const HEADER_TOGGLE = 'w-5 h-5 shrink-0';

const useLinger = (active: boolean, ms: number) => {
  const [wasActive, setWasActive] = useState(active);
  const [settling, setSettling] = useState(0);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active) setSettling((count) => count + 1);
  }
  useEffect(() => {
    if (!settling) return;
    const timer = window.setTimeout(() => setSettling(0), ms);
    return () => window.clearTimeout(timer);
  }, [settling, ms]);
  return active || settling > 0;
};

const revealRow = (el: HTMLElement, top: number, height: number) => {
  const view = el.clientHeight - RULER_HEIGHT;
  if (top < el.scrollTop) el.scrollTop = top;
  else if (top + height > el.scrollTop + view) el.scrollTop = top + height - view;
};

const transitionOverlap = (items: Array<TimelineItem>, index: number, frame: Ticks) => {
  const item = items[index];
  if (index <= 0 || !item || item.type !== 'clip' || !item.transitionIn) return 0;
  const overlap = itemEnd(items[index - 1]) - item.start;
  return overlap < frame ? 0 : overlap;
};

const ToolbarButton = memo(function ToolbarButton({
  icon: Icon,
  tooltip,
  onClick,
  disabled = false,
  isActive = false,
  activeClassName = 'bg-surface text-text-primary',
  shortcut,
  className,
}: {
  icon: React.ElementType;
  tooltip: string;
  onClick(): void;
  disabled?: boolean;
  isActive?: boolean;
  activeClassName?: string;
  shortcut?: ShortcutAction;
  className?: string;
}) {
  const shortcutProps = useShortcut(shortcut);
  return (
    <button
      className={clsx(
        'w-8 h-8 shrink-0 flex items-center justify-center rounded-md transition-colors',
        isActive ? activeClassName : 'text-text-secondary hover:bg-surface hover:text-text-primary',
        'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent',
        className,
      )}
      disabled={disabled}
      onMouseDown={preventFocus}
      onClick={onClick}
      data-tooltip={tooltip}
      aria-label={tooltip}
      {...shortcutProps}
    >
      <Icon size={16} />
    </button>
  );
});

function PanelToggles({ edge }: { edge: 'start' | 'end' }) {
  const { t } = useTranslation();
  const { leftPanel, rightPanel } = useUIStore(useShallow((state) => state.uiVisibility));
  const collapsed = useUIStore((state) => state.timelineCollapsed);
  if (edge === 'start') {
    return (
      <div className="flex items-center gap-1 shrink-0 @max-[52rem]:hidden">
        <ToolbarButton
          icon={PanelLeft}
          tooltip={leftPanel ? t('ui.bottomBar.tooltips.collapseLeft') : t('ui.bottomBar.tooltips.expandLeft')}
          onClick={() => toggleSidePanel('left')}
          shortcut="toggle_left_panel"
        />
        <div className="h-5 w-px bg-surface mx-1" />
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1 shrink-0 @max-[52rem]:hidden">
      <div className="h-5 w-px bg-surface mx-1" />
      <ToolbarButton
        icon={PanelBottom}
        tooltip={collapsed ? t('video.timeline.expand') : t('video.timeline.collapse')}
        onClick={toggleTimeline}
        shortcut="toggle_bottom_panel"
      />
      <ToolbarButton
        icon={PanelRight}
        tooltip={rightPanel ? t('ui.bottomBar.tooltips.collapseRight') : t('ui.bottomBar.tooltips.expandRight')}
        onClick={() => toggleSidePanel('right')}
        shortcut="toggle_right_panel"
      />
    </div>
  );
}

const Transport = memo(function Transport({ duration }: { duration: Ticks }) {
  const { t } = useTranslation();
  const loop = useVideoStore((s) => s.loop);
  const fps = useProjectFps();
  const toEnd = useCallback(() => setPlayhead(duration), [duration]);
  return (
    <div className="flex items-center gap-1">
      <ToolbarButton
        icon={SkipBack}
        tooltip={t('video.timeline.toStart')}
        onClick={toStart}
        shortcut="video_go_start"
        className="@max-[40rem]:hidden"
      />
      <ToolbarButton
        icon={ChevronLeft}
        tooltip={t('video.timeline.previousFrame')}
        onClick={previousFrame}
        shortcut="video_prev_frame"
        className="@max-[50rem]:hidden"
      />
      <PlayButton className="mx-1" />
      <ToolbarButton
        icon={ChevronRight}
        tooltip={t('video.timeline.nextFrame')}
        onClick={nextFrame}
        shortcut="video_next_frame"
        className="@max-[50rem]:hidden"
      />
      <ToolbarButton
        icon={SkipForward}
        tooltip={t('video.timeline.toEnd')}
        onClick={toEnd}
        shortcut="video_go_end"
        className="@max-[40rem]:hidden"
      />
      <ToolbarButton
        icon={Repeat}
        tooltip={t('video.timeline.loop')}
        onClick={toggleLoop}
        isActive={loop}
        shortcut="video_loop"
        className="@max-[30rem]:hidden"
      />
      <ToolbarButton
        icon={Camera}
        tooltip={t('video.frame.export')}
        onClick={exportFrame}
        shortcut="video_export_frame"
        className="@max-[30rem]:hidden"
      />
      <Text as="span" variant={TextVariants.small} className="ml-2 flex items-center gap-1 whitespace-nowrap">
        <PlayheadTimecode fps={fps} className="text-text-primary" />
        <span className="text-text-secondary">/</span>
        <Timecode value={formatTimecode(duration, fps)} className="text-text-secondary" />
      </Text>
    </div>
  );
});

const translateX = (x: number) => `translateX(${x}px)`;

const GLIDE_SECONDS = 60;
const GLIDE_TOLERANCE_SECONDS = 0.01;

interface Glide {
  animation: Animation;
  x: number;
  at: number;
  pps: number;
}

const glides = new WeakMap<HTMLElement, Glide>();

const glideTo = (element: HTMLElement | null, x: number, pps: number, moving: boolean) => {
  if (!element) return;
  const now = performance.now();
  const glide = glides.get(element);
  if (
    moving &&
    glide?.pps === pps &&
    glide.animation.playState === 'running' &&
    Math.abs(glide.x + (pps * (now - glide.at)) / 1000 - x) <= Math.max(0.5, pps * GLIDE_TOLERANCE_SECONDS)
  ) {
    return;
  }
  glide?.animation.cancel();
  glides.delete(element);
  element.style.transform = translateX(x);
  if (!moving) return;
  const animation = element.animate(
    [{ transform: translateX(x) }, { transform: translateX(x + pps * GLIDE_SECONDS) }],
    { duration: GLIDE_SECONDS * 1000, easing: 'linear', fill: 'forwards' },
  );
  animation.startTime = now;
  glides.set(element, { animation, x, at: now, pps });
};

const usePlayheadMotion = (apply: (state: PlayheadState, moving: boolean) => void) => {
  const last = useRef<PlayheadState | null>(null);
  const place = useCallback(
    ({ playhead, isPlaying }: PlayheadState) => {
      const previous = last.current;
      last.current = { playhead, isPlaying };
      apply({ playhead, isPlaying }, isPlaying && !!previous?.isPlaying && playhead !== previous.playhead);
    },
    [apply],
  );
  usePlayheadEffect(place);
};

function PlayheadHead({ pps }: { pps: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const place = useCallback(
    ({ playhead }: PlayheadState, moving: boolean) => glideTo(ref.current, timeToX(playhead, pps), pps, moving),
    [pps],
  );
  usePlayheadMotion(place);
  return (
    <div ref={ref} className="absolute top-0 bottom-0 left-0 z-10 pointer-events-none will-change-transform">
      <div
        className="absolute bottom-0 w-3 h-3.5 -translate-x-1/2 bg-text-primary"
        style={{ clipPath: 'polygon(0 0, 100% 0, 100% 60%, 50% 100%, 0 60%)' }}
      />
    </div>
  );
}

interface Visible {
  start: number;
  end: number;
}

function PlayheadLine({
  pps,
  scrollRef,
  visibleRef,
  onPointerDown,
}: {
  pps: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  visibleRef: RefObject<Visible>;
  onPointerDown(e: ReactPointerEvent): void;
}) {
  const gripRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const place = useCallback(
    ({ playhead, isPlaying }: PlayheadState, moving: boolean) => {
      const x = Math.max(0.5, timeToX(playhead, pps));
      glideTo(gripRef.current, x, pps, moving);
      glideTo(lineRef.current, x, pps, moving);
      const el = scrollRef.current;
      const { start, end } = visibleRef.current;
      if (!el || !isPlaying || (x >= start && x <= end - 40)) return;
      el.scrollLeft = Math.round(Math.max(0, x - (end - start) * 0.1));
    },
    [pps, scrollRef, visibleRef],
  );
  usePlayheadMotion(place);
  return (
    <>
      <div
        ref={gripRef}
        className="absolute top-0 bottom-0 left-0 z-[15] w-[9px] -ml-[4.5px] cursor-ew-resize will-change-transform"
        onPointerDown={onPointerDown}
      />
      <div
        ref={lineRef}
        className="absolute top-0 bottom-0 left-0 z-30 w-px -ml-[0.5px] bg-text-primary pointer-events-none will-change-transform"
      />
    </>
  );
}

const Ruler = memo(function Ruler({
  duration,
  pps,
  scroll,
}: {
  duration: Ticks;
  pps: number;
  scroll: { start: number; end: number };
}) {
  const fps = useProjectFps();
  const step = RULER_STEPS.find((candidate) => candidate * pps >= 72) ?? RULER_STEPS.at(-1)!;
  const minor = step / MINOR_TICKS;
  const first = Math.max(0, Math.floor(scroll.start / pps / minor));
  const last = Math.ceil(Math.min(ticksToSeconds(duration) + step, scroll.end / pps + step) / minor);
  const ticks: Array<ReactNode> = [];
  for (let index = first; index <= last; index++) {
    const time = secondsToTicks(index * minor);
    const isMajor = index % MINOR_TICKS === 0;
    ticks.push(
      <div
        key={index}
        className={clsx(
          'absolute bottom-0 w-px',
          isMajor ? 'h-2.5 bg-text-secondary/60' : 'h-1.5 bg-text-secondary/25',
        )}
        style={{ left: timeToX(time, pps) }}
      >
        {isMajor && (
          <span className="absolute bottom-2 left-1 text-[10px] leading-none text-text-secondary whitespace-nowrap tabular-nums">
            {formatRulerTime(time, fps, step < 1)}
          </span>
        )}
      </div>,
    );
  }
  return <>{ticks}</>;
});

interface ResizeHandlers {
  start(event: ReactPointerEvent, trackId: string, height: number): void;
  reset(trackId: string): void;
}

const TrackHeader = memo(function TrackHeader({
  kind,
  trackIndex,
  trackId,
  height,
  isNew,
  hidden,
  muted,
  locked,
  label,
  resize,
}: {
  kind: TrackKind;
  trackIndex: number;
  trackId: string;
  height: number;
  isNew: boolean;
  hidden: boolean;
  muted: boolean;
  locked: boolean;
  label: string;
  resize: ResizeHandlers;
}) {
  const { t } = useTranslation();
  const toggle = (patch: Parameters<typeof updateTrack>[3], edit: typeof editAudio = editProject) =>
    edit((project) => updateTrack(project, kind, trackIndex, patch));
  return (
    <div
      className="sticky left-0 flex items-center gap-0.5 pl-2 pr-1.5 bg-bg-secondary border-r border-surface"
      style={{ width: HEADER_WIDTH, height }}
    >
      <Text
        as="span"
        variant={TextVariants.small}
        className={clsx('flex-1 min-w-0 truncate font-medium', isNew && 'text-accent')}
      >
        {label}
      </Text>
      {!isNew && (
        <>
          {kind === 'video' ? (
            <TrackToggle
              tone="off"
              active={hidden}
              className={HEADER_TOGGLE}
              onClick={() => toggle({ hidden: !hidden })}
              label={hidden ? t('video.timeline.showTrack') : t('video.timeline.hideTrack')}
            >
              {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
            </TrackToggle>
          ) : (
            <span className={HEADER_TOGGLE} />
          )}
          <TrackToggle
            tone="off"
            active={muted}
            className={HEADER_TOGGLE}
            onClick={() => toggle({ muted: !muted }, editAudio)}
            label={muted ? t('video.clip.unmute') : t('video.clip.mute')}
          >
            {muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
          </TrackToggle>
          <TrackToggle
            tone="lock"
            active={locked}
            className={HEADER_TOGGLE}
            onClick={() => toggle({ locked: !locked })}
            label={locked ? t('video.timeline.unlockTrack') : t('video.timeline.lockTrack')}
          >
            {locked ? <Lock size={12} /> : <LockOpen size={12} />}
          </TrackToggle>
          <div
            className="group/resize absolute inset-x-0 -top-1 z-10 h-2 flex items-center cursor-row-resize"
            onPointerDown={(event) => resize.start(event, trackId, height)}
            onDoubleClick={() => resize.reset(trackId)}
          >
            <div className="w-full h-0.5 bg-accent opacity-0 transition-opacity group-hover/resize:opacity-60" />
          </div>
        </>
      )}
    </div>
  );
});

const selectTransition = (id: string) => {
  selectItems([id]);
  useUIStore.getState().setPanel(Panel.Inspector);
};

const rowKey = (row: Row) => (row.isNew ? `new-${row.kind}-${row.trackIndex}` : `${row.kind}-${row.track.id}`);

const CaptionHeader = memo(function CaptionHeader({ enabled, height }: { enabled: boolean; height: number }) {
  const { t } = useTranslation();
  return (
    <div
      className="sticky left-0 flex items-center gap-0.5 pl-2 pr-1.5 bg-bg-secondary border-r border-surface"
      style={{ width: HEADER_WIDTH, height }}
    >
      <span className="flex-1 min-w-0 flex text-text-secondary" data-tooltip={t('video.captions.title')}>
        <Captions size={14} aria-label={t('video.captions.title')} />
      </span>
      <TrackToggle
        tone="off"
        active={!enabled}
        className={HEADER_TOGGLE}
        onClick={() => editCaptions((captions) => ({ ...captions, enabled: !enabled }))}
        label={enabled ? t('video.timeline.hideTrack') : t('video.timeline.showTrack')}
      >
        {enabled ? <Eye size={12} /> : <EyeOff size={12} />}
      </TrackToggle>
      <span className={HEADER_TOGGLE} />
      <span className={HEADER_TOGGLE} />
    </div>
  );
});

const RangeButtons = memo(function RangeButtons() {
  const { t } = useTranslation();
  const shortcut = useShortcuts();
  const hasRange = useVideoStore((s) => !!s.project?.range);
  const buttons = [
    {
      icon: FlagTriangleRight,
      label: t('video.timeline.setIn'),
      onClick: () => setRangeAtPlayhead('start'),
      action: 'video_set_in',
    },
    {
      icon: FlagTriangleLeft,
      label: t('video.timeline.setOut'),
      onClick: () => setRangeAtPlayhead('end'),
      action: 'video_set_out',
    },
    {
      icon: FlagOff,
      label: t('video.timeline.clearRange'),
      onClick: clearRange,
      disabled: !hasRange,
      action: 'video_clear_range',
    },
  ];
  return (
    <div
      className="sticky left-0 z-20 shrink-0 flex items-center justify-end gap-0.5 pr-1.5 bg-bg-secondary border-r border-b border-surface"
      style={{ width: HEADER_WIDTH }}
    >
      {buttons.map(({ icon: Icon, label, onClick, disabled, action }) => (
        <button
          key={label}
          className={HEADER_BUTTON}
          onMouseDown={preventFocus}
          onClick={onClick}
          disabled={disabled}
          data-tooltip={label}
          aria-label={label}
          {...shortcut(action)}
        >
          <Icon size={12} />
        </button>
      ))}
    </div>
  );
});

const leaveOne = () => leaveNested();

const SequencePath = memo(function SequencePath({ project }: { project: VideoProject }) {
  const { t } = useTranslation();
  const open = openSequences(project);
  if (open.length === 0) return null;
  return (
    <div className="flex items-center gap-0.5 min-w-0 mr-1">
      <ToolbarButton icon={ChevronLeft} tooltip={t('video.nesting.back')} onClick={leaveOne} />
      {[{ id: null, name: project.name }, ...open].map((entry, index) => (
        <div key={entry.id ?? 'root'} className="flex items-center gap-0.5 min-w-0">
          {index > 0 && <ChevronRight size={12} className="shrink-0 text-text-secondary" />}
          <button
            type="button"
            className={clsx(
              'truncate max-w-32 px-1 rounded text-xs',
              index === open.length ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary',
            )}
            disabled={index === open.length}
            onClick={() => leaveNested(open.length - index)}
          >
            {entry.name}
          </button>
        </div>
      ))}
      <div className="h-5 w-px bg-surface mx-1" />
    </div>
  );
});

const JoinButton = memo(function JoinButton({
  project,
  selection,
}: {
  project: VideoProject;
  selection: Array<string>;
}) {
  const { t } = useTranslation();
  const joinable = useMemo(() => canJoin(project, selection), [project, selection]);
  return <ToolbarButton icon={Merge} tooltip={t('video.timeline.join')} onClick={joinSelection} disabled={!joinable} />;
});

const SplitButton = memo(function SplitButton({ project }: { project: VideoProject }) {
  const { t } = useTranslation();
  const canSplit = useVideoStore((s) =>
    allItems(project).some((item) => s.playhead > item.start && s.playhead < itemEnd(item)),
  );
  return (
    <ToolbarButton
      icon={Scissors}
      tooltip={t('video.timeline.split')}
      onClick={splitAtPlayhead}
      disabled={!canSplit}
      shortcut="video_split"
    />
  );
});

const MarkerButton = memo(function MarkerButton() {
  const { t } = useTranslation();
  const isOnMarker = useVideoStore((s) => !!s.project && !!markerAtPlayhead(s.project, s.playhead));
  return (
    <ToolbarButton
      icon={Bookmark}
      tooltip={isOnMarker ? t('video.markers.remove') : t('video.markers.add')}
      onClick={toggleMarkerAtPlayhead}
      isActive={isOnMarker}
      shortcut="video_add_marker"
    />
  );
});

type Interaction =
  | { kind: 'scrub' }
  | {
      kind: 'move';
      id: string;
      ids: Array<string>;
      startX: number;
      startY: number;
      grab: Ticks;
      moved: boolean;
      additive: boolean;
      single: boolean;
    }
  | { kind: 'trim' | 'roll'; id: string; edge: 'start' | 'end'; moved: boolean }
  | { kind: 'slip'; id: string; startX: number; moved: boolean }
  | { kind: 'slide'; id: string; startX: number; moved: boolean }
  | { kind: 'transition'; id: string; startX: number; side: number; duration: Ticks; moved: boolean }
  | {
      kind: 'empty';
      x: number;
      y: number;
      moved: boolean;
      base: Array<string>;
      before: Array<string>;
      single: boolean;
    };

type Drag = Extract<Interaction, { kind: 'move' | 'trim' | 'roll' | 'slip' | 'slide' | 'transition' }>;

type TimelineHandlers = ItemHandlers & {
  resizeTransition(event: ReactPointerEvent, item: ClipItem, side: number): void;
};

const slideOf = (base: VideoProject, preview: VideoProject, id: string): SlideInfo | null => {
  const before = locateItem(base, id);
  const after = locateItem(preview, id);
  if (!before || !after) return null;
  const items = after.track.items as Array<TimelineItem>;
  const previous = items[after.index - 1];
  const next = items[after.index + 1];
  const fps = preview.settings.fps;
  return {
    shift: after.item.start - before.item.start,
    previousOut: previous && 'sourceIn' in previous ? sourceTimeOf(previous, itemEnd(previous), fps) : null,
    nextIn: next && 'sourceIn' in next ? next.sourceIn : null,
  };
};

const trimOf = (base: VideoProject, preview: VideoProject, id: string, edge: 'start' | 'end'): TrimInfo | null => {
  const before = locateItem(base, id)?.item;
  const after = locateItem(preview, id)?.item;
  if (!before || !after) return null;
  const at = (item: TimelineItem) => (edge === 'start' ? item.start : itemEnd(item));
  return { edge, shift: at(after) - at(before), duration: after.duration };
};

interface Preview {
  project: VideoProject;
  snap: Ticks | null;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Resize {
  heights: HeightOverrides;
  anchor: string;
}

const anchorOffset = (layout: Layout, spare: number, key: string | null) => {
  const row = layout.rows.find((candidate) => (key ? candidate.track.id === key : isMainRow(candidate)));
  return row ? row.top + row.height - spare : null;
};

export default function Timeline() {
  const { t } = useTranslation();
  const { showContextMenu } = useContextMenu();
  const { project, selection, pps, media, snapping, recordKeyframes } = useVideoStore(
    useShallow((s) => ({
      project: s.project,
      selection: s.selection,
      pps: s.pixelsPerSecond,
      media: s.media,
      snapping: s.snapping,
      recordKeyframes: s.recordKeyframes,
    })),
  );
  const collapsed = useUIStore((state) => state.timelineCollapsed);
  const gapSelected = useGapSelection((state) => state.selected !== null);
  const beatAnalyses = useVideoBeats();
  useDuckCurveSync();
  const plan = useDropPlan((state) => state.plan);
  const [drag, setDrag] = useState<{ project: VideoProject; snap: Ticks | null } | null>(null);
  const [captionSnap, setCaptionSnap] = useState<Ticks | null>(null);
  const [slipping, setSlipping] = useState<string | null>(null);
  const [sliding, setSliding] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [scroll, setScroll] = useState({ start: 0, end: 2048, width: 2000 });
  const visibleRef = useRef<Visible>({ start: 0, end: 2000 });
  const [spare, setSpare] = useState(0);
  const [resize, setResize] = useState<Resize | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const frameRef = useRef(0);
  const applyPointer = useRef<() => void>(() => {});
  const spareRef = useRef(0);
  const scrollTopRef = useRef(0);
  const baseHeightRef = useRef(0);
  const anchorRef = useRef<{ id: string; key: string | null; offset: number } | null>(null);
  const rowIdsRef = useRef<Set<string> | null>(null);
  const resizeRef = useRef<Resize | null>(null);
  const edgeRef = useRef<{ id: string; startY: number; startHeight: number } | null>(null);
  const scaleRef = useRef<{ kind: TrackKind; start: HeightOverrides; scale: number } | null>(null);
  const scaleTimer = useRef(0);
  const layoutRef = useRef<Layout | null>(null);
  const itemActions = useRef<TimelineHandlers | null>(null);
  const itemHandlers = useMemo<TimelineHandlers>(
    () => ({
      pointerDown: (event, item) => itemActions.current?.pointerDown(event, item),
      trimStart: (event, item, edge) => itemActions.current?.trimStart(event, item, edge),
      slipStart: (event, item) => itemActions.current?.slipStart(event, item),
      contextMenu: (event, item) => itemActions.current?.contextMenu(event, item),
      open: (item) => itemActions.current?.open(item),
      resizeTransition: (event, item, side) => itemActions.current?.resizeTransition(event, item, side),
    }),
    [],
  );
  const { setNodeRef: setDropRef } = useDroppable({ id: 'video-timeline', data: { type: 'video-timeline' } });

  useDndMonitor({
    onDragStart: ({ active }) => {
      const data = active.data.current;
      if (data?.type === 'library-image') {
        const paths = draggedPaths(data.path, data.paths).filter(isMediaCandidate);
        if (paths.length > 0) beginDropPreview({ type: 'library-image', paths });
      } else if (String(data?.type).startsWith('video-')) beginDropPreview(data as VideoDragData);
    },
    onDragEnd: endDropPreview,
    onDragCancel: endDropPreview,
  });

  const draft = drag?.project ?? plan?.project ?? null;
  const shown = draft ?? project;
  const reflows = useLinger(!!plan || (!!drag && interactionRef.current?.kind === 'move'), REFLOW_MS);
  const layout = useMemo(
    () => (project ? computeLayout(project, spare, resize?.heights) : null),
    [project, spare, resize],
  );
  layoutRef.current = layout;
  const viewTop = draft ? scrollTopRef.current : 0;
  const view = useMemo(
    () => (layout && draft ? stableLayout(layout, draft, viewTop) : layout),
    [layout, draft, viewTop],
  );
  const leaders = useMemo(() => new Set(project ? groupLeaders(project, selection) : selection), [project, selection]);
  const beatPaths = useMemo(
    () =>
      project
        ? [
            ...new Set(
              allItems(project).flatMap((item) =>
                item.type === 'audio' && item.beats ? (beatPathOf(project, item) ?? []) : [],
              ),
            ),
          ].join('\n')
        : '',
    [project],
  );
  useEffect(() => {
    if (beatPaths) beatPaths.split('\n').forEach((path) => void loadBeats(path));
  }, [beatPaths]);
  const paired = useMemo(() => (shown ? pairedLinks(shown) : new Set<string>()), [shown]);
  const mattes = useMemo(() => matteRoles(shown?.videoTracks ?? []), [shown?.videoTracks]);
  const duration = shown ? sequenceDuration(shown) : 0;
  const contentWidth = Math.max(scroll.width, timeToX(duration, pps) + TRAILING_SPACE);

  const fitSpare = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !anchorRef.current) return;
    const next = Math.max(0, Math.floor(el.clientHeight - RULER_HEIGHT - baseHeightRef.current));
    spareRef.current = next;
    setSpare(next);
  }, []);

  const updateScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    scrollTopRef.current = el.scrollTop;
    const width = el.clientWidth - HEADER_WIDTH;
    visibleRef.current = { start: el.scrollLeft, end: el.scrollLeft + width };
    const start = Math.floor(el.scrollLeft / SCROLL_STEP) * SCROLL_STEP;
    const end = Math.ceil((el.scrollLeft + width) / SCROLL_STEP) * SCROLL_STEP;
    setScroll((current) =>
      current.start === start && current.end === end && current.width === width ? current : { start, end, width },
    );
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScroll();
    let height = el.clientHeight;
    const observer = new ResizeObserver(() => {
      updateScroll();
      if (el.clientHeight === height) return;
      height = el.clientHeight;
      fitSpare();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateScroll, fitSpare]);

  baseHeightRef.current = layout ? layout.height - spare : 0;
  const projectId = project?.id ?? null;
  const anchorKey = resize?.anchor ?? null;
  useLayoutEffect(() => {
    const previous = anchorRef.current;
    const known = rowIdsRef.current;
    rowIdsRef.current = layout ? new Set(layout.rows.map((row) => row.track.id)) : null;
    const offset = layout && anchorOffset(layout, spare, anchorKey);
    anchorRef.current = projectId && offset !== null ? { id: projectId, key: anchorKey, offset } : null;
    const el = scrollRef.current;
    if (!layout || !projectId || offset === null || !el) return;
    if (!previous || previous.id !== projectId) {
      fitSpare();
      return;
    }
    const moved = anchorOffset(layout, spare, previous.key);
    const delta = moved === null ? 0 : moved - previous.offset;
    if (delta !== 0) {
      const top = scrollTopRef.current;
      const current = spareRef.current;
      const used = delta > 0 ? Math.min(current, delta) : 0;
      const back = delta < 0 ? Math.min(top, -delta) : 0;
      const grown = current - delta - back;
      const fit = Math.max(0, Math.floor(el.clientHeight - RULER_HEIGHT - baseHeightRef.current));
      const next = delta > 0 ? current - used : anchorKey === null ? Math.min(grown, fit) : grown;
      el.scrollTop = delta > 0 ? top + delta - used : top - back;
      scrollTopRef.current = el.scrollTop;
      spareRef.current = next;
      setSpare(next);
    }
    const added =
      known && layout.rows.some((row) => known.has(row.track.id))
        ? layout.rows.find((row) => !known.has(row.track.id))
        : undefined;
    const shift = spareRef.current - spare;
    if (!interactionRef.current && !isDropPreviewing()) {
      if (added) revealRow(el, added.top + shift, added.height);
      const top = anchorKey === null && (delta !== 0 || added) ? cutRowTop(layout, el.scrollTop - shift) : null;
      if (top !== null) el.scrollTop = top + shift;
    }
    scrollTopRef.current = el.scrollTop;
  }, [projectId, layout, spare, anchorKey, fitSpare]);

  const showResize = useCallback((next: Resize | null) => {
    resizeRef.current = next;
    setResize(next);
  }, []);

  const commitResize = useCallback(() => {
    window.clearTimeout(scaleTimer.current);
    scaleRef.current = null;
    const pending = resizeRef.current;
    const current = getVideo().project;
    if (pending && current) resizeTracks(storedTrackHeights(current, pending.heights));
    showResize(null);
  }, [showResize]);

  const anchorAt = useCallback(
    (anchor: string) => flushSync(() => showResize({ heights: resizeRef.current?.heights ?? {}, anchor })),
    [showResize],
  );

  useEffect(
    () => () => {
      if (resizeRef.current) commitResize();
    },
    [commitResize],
  );

  const endResize = (commit: boolean) => {
    if (!edgeRef.current) return;
    edgeRef.current = null;
    if (commit) commitResize();
    else showResize(null);
  };

  const startResize = usePointerDrag({
    move: (event) => {
      const edge = edgeRef.current;
      if (!edge) return;
      const height = clampTrackHeight(edge.startHeight - event.clientY + edge.startY);
      const current = resizeRef.current;
      if (current?.heights[edge.id] === height) return;
      showResize({ heights: { ...current?.heights, [edge.id]: height }, anchor: edge.id });
    },
    end: () => endResize(true),
    cancel: () => endResize(false),
  });

  const resizeHandlers = useMemo<ResizeHandlers>(
    () => ({
      start: (event, trackId, height) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        startResize(event);
        if (scaleRef.current) commitResize();
        edgeRef.current = { id: trackId, startY: event.clientY, startHeight: height };
        anchorAt(trackId);
      },
      reset: (trackId) => {
        anchorAt(trackId);
        resizeTracks({ [trackId]: null });
        showResize(null);
      },
    }),
    [showResize, commitResize, anchorAt, startResize],
  );

  const scaleTracks = useCallback(
    (clientY: number, factor: number) => {
      const current = layoutRef.current;
      const lanes = lanesRef.current;
      if (!current || !lanes || edgeRef.current) return;
      const hit = rowAt(current, clientY - lanes.getBoundingClientRect().top);
      const kind: TrackKind = hit && 'row' in hit ? hit.row.kind : (hit?.newTrack ?? 'video');
      const rows = current.rows.filter((row) => row.kind === kind);
      const anchor = rows.reduce((lowest, row) => (row.top > lowest.top ? row : lowest)).track.id;
      if (scaleRef.current?.kind !== kind) anchorAt(anchor);
      const gesture =
        scaleRef.current?.kind === kind
          ? scaleRef.current
          : { kind, start: Object.fromEntries(rows.map((row) => [row.track.id, row.height])), scale: 1 };
      const limits = trackScaleLimits(Object.values(gesture.start));
      gesture.scale = Math.min(limits.max, Math.max(limits.min, gesture.scale * factor));
      scaleRef.current = gesture;
      const scaled = Object.entries(gesture.start).map(([id, height]) => [
        id,
        clampTrackHeight(height * gesture.scale),
      ]);
      showResize({ heights: { ...resizeRef.current?.heights, ...Object.fromEntries(scaled) }, anchor });
      window.clearTimeout(scaleTimer.current);
      scaleTimer.current = window.setTimeout(commitResize, TRACK_SCALE_COMMIT_MS);
    },
    [showResize, commitResize, anchorAt],
  );

  const zoomTo = useCallback(
    (next: number, anchorX?: number, anchorTime?: number) => {
      const el = scrollRef.current;
      const clamped = Math.min(MAX_PPS, Math.max(MIN_PPS, next));
      if (!el) {
        setVideo({ pixelsPerSecond: clamped });
        return;
      }
      const at = anchorX ?? (el.clientWidth - HEADER_WIDTH) / 2;
      const time = anchorTime ?? (el.scrollLeft + at) / pps;
      setVideo({ pixelsPerSecond: clamped });
      requestAnimationFrame(() => {
        el.scrollLeft = Math.round(Math.max(0, time * clamped - at));
        updateScroll();
      });
    },
    [pps, updateScroll],
  );

  const zoomToFit = useCallback(() => {
    const el = scrollRef.current;
    if (!el || duration <= 0) return;
    zoomTo((el.clientWidth - HEADER_WIDTH - FIT_MARGIN) / ticksToSeconds(duration), 0, 0);
  }, [duration, zoomTo]);

  const zoomOut = useCallback(() => zoomTo(pps / 1.5), [zoomTo, pps]);
  const zoomIn = useCallback(() => zoomTo(pps * 1.5), [zoomTo, pps]);

  useEffect(() => {
    if (!lanesRef.current || !scrollRef.current || !layout) return;
    registerTimelineGeometry({
      viewport: scrollRef.current,
      lanes: lanesRef.current,
      layout,
      pps,
      zoom: (factor) => zoomTo(pps * factor),
      fit: zoomToFit,
    });
    return () => registerTimelineGeometry(null);
  }, [layout, pps, zoomTo, zoomToFit]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const rect = el.getBoundingClientRect();
        if (event.clientX - rect.left < HEADER_WIDTH && event.clientY - rect.top > RULER_HEIGHT) {
          scaleTracks(event.clientY, Math.exp(-event.deltaY * TRACK_SCALE_SPEED));
        } else {
          zoomTo(pps * Math.exp(-event.deltaY * 0.002), event.clientX - rect.left - HEADER_WIDTH);
        }
      } else if (
        !event.shiftKey &&
        Math.abs(event.deltaY) > Math.abs(event.deltaX) &&
        el.scrollHeight <= el.clientHeight + 1
      ) {
        event.preventDefault();
        el.scrollLeft += event.deltaY;
      }
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [pps, zoomTo, scaleTracks]);

  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  const pointerTime = useCallback(
    (clientX: number) => {
      const lanes = lanesRef.current;
      return lanes ? xToTime(clientX - lanes.getBoundingClientRect().left, pps) : 0;
    },
    [pps],
  );

  const pointerX = (clientX: number) => clientX - (lanesRef.current?.getBoundingClientRect().left ?? 0);
  const pointerY = (clientY: number) => clientY - (lanesRef.current?.getBoundingClientRect().top ?? 0);

  const capture = (event: ReactPointerEvent) => {
    startDrag(event);
    selectKeyframe(null);
  };

  const beginScrub = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    capture(event);
    interactionRef.current = { kind: 'scrub' };
    setPlayhead(pointerTime(event.clientX));
  };

  const beginEmpty = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    capture(event);
    selectGap((event.target as HTMLElement).closest<HTMLElement>('[data-gap]')?.dataset.gap ?? null);
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    interactionRef.current = {
      kind: 'empty',
      x: pointerX(event.clientX),
      y: pointerY(event.clientY),
      moved: false,
      base: additive ? selection : [],
      before: selection,
      single: event.altKey,
    };
  };

  const selectInBox = (interaction: Extract<Interaction, { kind: 'empty' }>, box: Box) => {
    if (!project || !layout) return;
    const from = xToTime(box.left, pps);
    const to = xToTime(box.left + box.width, pps);
    const hits = layout.rows
      .filter((row) => !row.track.locked && row.top < box.top + box.height && row.top + row.height > box.top)
      .flatMap((row) =>
        (row.track.items as Array<TimelineItem>)
          .filter((item) => item.start < to && itemEnd(item) > from)
          .map((item) => item.id),
      );
    const touched = interaction.single ? hits : linkedIds(project, hits);
    const next = [...interaction.base, ...touched.filter((id) => !interaction.base.includes(id))];
    const current = useVideoStore.getState().selection;
    if (next.length !== current.length || next.some((id, index) => id !== current[index])) {
      setVideo({ selection: next });
    }
  };

  const beginSlip = (event: ReactPointerEvent, item: TimelineItem) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    capture(event);
    interactionRef.current = { kind: 'slip', id: item.id, startX: event.clientX, moved: false };
    setSlipping(item.id);
    selectItems([item.id], false, false);
  };

  const beginSlide = (event: ReactPointerEvent, item: TimelineItem) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    capture(event);
    interactionRef.current = { kind: 'slide', id: item.id, startX: event.clientX, moved: false };
    setSliding(item.id);
    selectItems([item.id], false, false);
  };

  const beginTransition = (event: ReactPointerEvent, item: ClipItem, side: number) => {
    event.stopPropagation();
    if (event.button !== 0 || !item.transitionIn) return;
    capture(event);
    interactionRef.current = {
      kind: 'transition',
      id: item.id,
      startX: event.clientX,
      side,
      duration: item.transitionIn.duration,
      moved: false,
    };
  };

  const beginMove = (event: ReactPointerEvent, item: TimelineItem, row: Row) => {
    event.stopPropagation();
    if (event.button !== 0 || !project) return;
    if (row.track.locked) {
      selectItems([item.id], false);
      return;
    }
    if (event.altKey && event.shiftKey) {
      if (canSlide(project, item.id, (other) => mediaDurationOf(project, other))) beginSlide(event, item);
      else selectItems([item.id], false);
      return;
    }
    if (event.altKey && Number.isFinite(mediaDurationOf(project, item))) {
      beginSlip(event, item);
      return;
    }
    capture(event);
    const group = event.altKey
      ? [item.id]
      : linkedIds(
          project,
          selection.includes(item.id) ? [item.id, ...selection.filter((id) => id !== item.id)] : [item.id],
        );
    interactionRef.current = {
      kind: 'move',
      id: item.id,
      ids: group.filter((id) => !locateItem(project, id)?.track.locked),
      startX: event.clientX,
      startY: event.clientY,
      grab: pointerTime(event.clientX) - item.start,
      moved: false,
      additive: event.shiftKey || event.ctrlKey || event.metaKey,
      single: event.altKey,
    };
  };

  const beginTrim = (event: ReactPointerEvent, item: TimelineItem, edge: 'start' | 'end') => {
    event.stopPropagation();
    if (event.button !== 0 || !project) return;
    capture(event);
    const edgeTime = edge === 'start' ? item.start : itemEnd(item);
    const rolls =
      event.altKey && rollEdit(project, item.id, edge, edgeTime, (other) => mediaDurationOf(project, other));
    interactionRef.current = { kind: rolls ? 'roll' : 'trim', id: item.id, edge, moved: false };
    if (!selection.includes(item.id)) selectItems([item.id], false);
  };

  const movedProject = (
    base: VideoProject,
    interaction: Extract<Interaction, { kind: 'move' }>,
    clientX: number,
    clientY: number,
  ): Preview | null => {
    const { id, ids } = interaction;
    const location = locateItem(base, id);
    if (!location) return null;
    const { item } = location;
    const raw = snapTicks(Math.max(0, pointerTime(clientX) - interaction.grab), base.settings.fps);
    const { time: start, snap } = snapSpan(raw, item.duration, snapTargets(base, ids), snapTolerance(pps));
    const hit = layoutRef.current && rowAt(layoutRef.current, pointerY(clientY), scrollRef.current?.scrollTop);
    const kind = item.type === 'audio' ? 'audio' : 'video';
    const isMain = location.kind === 'video' && location.trackIndex === 0;
    const own: MoveTarget = { kind, trackIndex: location.trackIndex, start };
    const row = hit && 'row' in hit ? hit.row : null;
    const tracks = kind === 'video' ? base.videoTracks : base.audioTracks;
    const empties =
      !isMain &&
      location.trackIndex === tracks.length - 1 &&
      (location.track.items as Array<TimelineItem>).every((other) => ids.includes(other.id));
    const target: MoveTarget | null =
      hit && 'newTrack' in hit && hit.newTrack === kind
        ? empties
          ? own
          : { kind, trackIndex: 0, start, newTrack: true }
        : !row || row.kind !== kind || row.track.locked
          ? isMain
            ? null
            : own
          : row.kind === 'video' && row.trackIndex === 0 && item.type !== 'clip'
            ? null
            : { kind, trackIndex: row.trackIndex, start };
    const chosen = target ?? (ids.length > 1 ? own : null);
    const moved = chosen && moveItems(base, ids, id, chosen, pointerTime(clientX));
    if (!moved) return null;
    const placed = locateItem(moved, id)?.item;
    return { project: moved, snap: placed && (placed.start === snap || itemEnd(placed) === snap) ? snap : null };
  };

  const trimmedProject = (
    base: VideoProject,
    interaction: Extract<Interaction, { kind: 'trim' | 'roll' }>,
    clientX: number,
  ): Preview | null => {
    const { id, edge } = interaction;
    if (!locateItem(base, id)) return null;
    const targets = snapTargets(base, linkedIds(base, [id]));
    const { time, snap } = snapTo(snapTicks(pointerTime(clientX), base.settings.fps), targets, snapTolerance(pps));
    const durations = (other: TimelineItem) => mediaDurationOf(base, other);
    const trimmed =
      interaction.kind === 'roll'
        ? rollEdit(base, id, edge, time, durations)
        : trimItem(base, id, edge, time, durations);
    const item = trimmed && locateItem(trimmed, id)?.item;
    if (!trimmed || !item) return null;
    return { project: trimmed, snap: (edge === 'start' ? item.start : itemEnd(item)) === snap ? snap : null };
  };

  const shiftedProject = (
    base: VideoProject,
    interaction: Extract<Interaction, { kind: 'slip' | 'slide' }>,
    clientX: number,
  ): Preview | null => {
    const { id } = interaction;
    if (!locateItem(base, id)) return null;
    const delta = snapTicks(secondsToTicks((clientX - interaction.startX) / pps), base.settings.fps);
    const shift = interaction.kind === 'slip' ? slipLinked : slideItem;
    return { project: shift(base, id, delta, (other) => mediaDurationOf(base, other)), snap: null };
  };

  const resizedProject = (
    base: VideoProject,
    interaction: Extract<Interaction, { kind: 'transition' }>,
    clientX: number,
  ): Preview | null => {
    if (!locateItem(base, interaction.id)) return null;
    const delta = ((clientX - interaction.startX) / pps) * TICKS_PER_SECOND * 2 * interaction.side;
    return { project: setTransitionDuration(base, interaction.id, interaction.duration + delta), snap: null };
  };

  const draggedProject = (base: VideoProject, interaction: Drag, clientX: number, clientY: number) =>
    interaction.kind === 'move'
      ? movedProject(base, interaction, clientX, clientY)
      : interaction.kind === 'slip' || interaction.kind === 'slide'
        ? shiftedProject(base, interaction, clientX)
        : interaction.kind === 'transition'
          ? resizedProject(base, interaction, clientX)
          : trimmedProject(base, interaction, clientX);

  applyPointer.current = () => {
    const interaction = interactionRef.current;
    const point = pointerRef.current;
    if (!interaction || !point) return;
    if (interaction.kind === 'scrub') {
      setPlayhead(pointerTime(point.x));
    } else if (interaction.kind === 'empty') {
      const x = pointerX(point.x);
      const y = pointerY(point.y);
      const box = {
        left: Math.min(x, interaction.x),
        top: Math.min(y, interaction.y),
        width: Math.abs(x - interaction.x),
        height: Math.abs(y - interaction.y),
      };
      setMarquee(box);
      selectInBox(interaction, box);
    } else {
      const base = getVideo().project;
      const preview = base && draggedProject(base, interaction, point.x, point.y);
      alignHaptic(interaction, preview?.snap, preview && mainSlotOf(preview.project, interaction.id));
      setDrag(preview ?? null);
    }
  };

  const handlePointerMove = (event: PointerEvent) => {
    const interaction = interactionRef.current;
    if (!interaction) return;
    if (interaction.kind !== 'scrub' && !interaction.moved) {
      const distance =
        interaction.kind === 'move'
          ? Math.hypot(event.clientX - interaction.startX, event.clientY - interaction.startY)
          : interaction.kind === 'empty'
            ? Math.hypot(pointerX(event.clientX) - interaction.x, pointerY(event.clientY) - interaction.y)
            : DRAG_THRESHOLD;
      if (distance < DRAG_THRESHOLD) return;
      interaction.moved = true;
    }
    pointerRef.current = { x: event.clientX, y: event.clientY };
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      applyPointer.current();
    });
  };

  const finishInteraction = () => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    const interaction = interactionRef.current;
    interactionRef.current = null;
    pointerRef.current = null;
    setDrag(null);
    setSlipping(null);
    setSliding(null);
    setMarquee(null);
    return interaction;
  };

  const cancelInteraction = () => {
    const interaction = finishInteraction();
    if (interaction?.kind === 'empty') setVideo({ selection: interaction.before });
  };

  const handlePointerUp = (event: PointerEvent) => {
    const interaction = finishInteraction();
    if (!interaction) return;
    if (interaction.kind === 'empty') {
      if (!interaction.moved) {
        setVideo({ selection: [] });
        setPlayhead(pointerTime(event.clientX));
      }
    } else if (interaction.kind === 'move' && !interaction.moved) {
      const { project: live, selection: current } = getVideo();
      const group = interaction.single || !live ? [interaction.id] : linkedIds(live, [interaction.id]);
      if (interaction.additive) {
        setVideo({
          selection: current.includes(interaction.id)
            ? current.filter((id) => !group.includes(id))
            : [...current, ...group.filter((id) => !current.includes(id))],
        });
      } else {
        selectItems([interaction.id], true, !interaction.single);
      }
    } else if (interaction.kind === 'scrub') {
      setPlayhead(pointerTime(event.clientX));
    } else if (interaction.moved) {
      let applied = false;
      editProject((current) => {
        const next = draggedProject(current, interaction, event.clientX, event.clientY)?.project;
        applied = !!next;
        return next ?? current;
      });
      if (applied && interaction.kind === 'move') setVideo({ selection: interaction.ids });
    }
  };

  const startDrag = usePointerDrag({ move: handlePointerMove, end: handlePointerUp, cancel: cancelInteraction });

  const openItemMenu = (event: React.MouseEvent, item: TimelineItem, row: Row) => {
    event.preventDefault();
    event.stopPropagation();
    if (!project) return;
    selectKeyframe(null);
    if (!selection.includes(item.id)) selectItems([item.id], false);
    const targets = selection.includes(item.id) ? selection : [item.id];
    const single = groupLeaders(project, linkedIds(project, targets)).length === 1;
    const isMain = row.kind === 'video' && row.trackIndex === 0;
    const cuts = transitionClips(project, targets);
    const playhead = useVideoStore.getState().playhead;
    const canSplit = playhead > item.start && playhead < itemEnd(item);
    const isUnderPlayhead = playhead >= item.start && playhead < itemEnd(item);
    const infoOf = (target: TimelineItem) => {
      const targetRef = 'media' in target ? mediaOf(project, target.media) : null;
      return targetRef ? media[targetRef.path] : undefined;
    };
    const ref = 'media' in item ? mediaOf(project, item.media) : null;
    const info = infoOf(item);
    const hasAudio = item.type === 'clip' && !!info?.hasAudio && !info.isStill;
    const detached =
      item.type === 'clip' &&
      linkedIds(project, [item.id]).some((id) => {
        const partner = locateItem(project, id)?.item;
        return partner?.type === 'audio' && partner.media === item.media;
      });
    const retimed = targets.flatMap((id) => {
      const target = locateItem(project, id)?.item;
      const targetInfo = target && infoOf(target);
      return target?.type === 'clip' && targetInfo && !targetInfo.isStill && !target.freeze ? [target] : [];
    });
    const speeds = new Set(retimed.map((target) => (isRamped(target) ? null : target.speed)));
    const currentSpeed = speeds.size === 1 ? [...speeds][0] : null;
    const patch = (update: Partial<TimelineItem>) =>
      editProject((current) => updateItem<TimelineItem>(current, item.id, update));
    const sharedLook = hasLook(item) && item.look && lookUsers(project, item.look).length > 1;
    const muted = 'muted' in item && item.muted;

    const structure: Array<Option> = [
      {
        icon: Scissors,
        label: t('video.timeline.split'),
        disabled: !canSplit,
        onClick: splitAtPlayhead,
        shortcut: 'video_split',
      },
      { icon: Merge, label: t('video.timeline.join'), disabled: !canJoin(project, targets), onClick: joinSelection },
      {
        icon: Group,
        label: t('video.nesting.nest'),
        disabled: 'refusal' in nestItems(project, targets, ''),
        onClick: nestSelection,
        shortcut: 'video_nest',
      },
      ...(ref?.kind === 'sequence'
        ? [
            {
              icon: Layers,
              label: t('video.nesting.open'),
              disabled: !single,
              onClick: () => openNested(item.id),
            },
            {
              icon: Ungroup,
              label: t('video.nesting.unnest'),
              disabled: !canUnnest(item.id),
              onClick: unnestSelection,
              shortcut: 'video_unnest',
            },
          ]
        : []),
    ];

    const clipboard: Array<Option> = [
      { icon: Copy, label: t('video.timeline.copy'), onClick: copySelection, shortcut: 'video_copy' },
      {
        icon: ClipboardPaste,
        label: t('video.timeline.paste'),
        disabled: !hasClipboard(),
        onClick: pasteAtPlayhead,
        shortcut: 'video_paste',
      },
      {
        icon: CopyPlus,
        label: t('video.timeline.duplicate'),
        onClick: duplicateSelection,
        shortcut: 'video_duplicate',
      },
    ];

    const adjustments: Array<Option> = hasLook(item)
      ? [
          {
            icon: Copy,
            label: t('contextMenus.editor.copyAdjustments'),
            onClick: () => copyLook(item.id),
            shortcut: 'video_copy_adjustments',
          },
          {
            icon: ClipboardPaste,
            label: t('contextMenus.editor.pasteAdjustments'),
            disabled: !hasCopiedLook(),
            onClick: pasteCopiedLook,
            shortcut: 'video_paste_adjustments',
          },
          { icon: SwatchBook, label: t('video.timeline.saveAsPreset'), onClick: () => savePresetFromItem(item.id) },
          ...(sharedLook
            ? [
                {
                  icon: Split,
                  label: t('video.timeline.makeLookUnique'),
                  disabled: !single,
                  onClick: () => editProject((current) => makeLookUnique(current, item.id)),
                },
              ]
            : []),
        ]
      : [];

    const time: Array<Option> = [
      ...(retimed.some((target) => target.id === item.id)
        ? [
            {
              icon: Gauge,
              label: t('video.clip.speed'),
              submenu: SPEED_PRESETS.map((speed) => ({
                icon: speed === currentSpeed ? Check : undefined,
                label: `${speed}×`,
                onClick: () =>
                  editProject((current) =>
                    retimed.reduce(
                      (next, target) =>
                        setItemSpeed(next, target.id, speed, sourceLength(target, current.settings.fps)),
                      current,
                    ),
                  ),
              })),
            },
          ]
        : []),
      ...(canFreeze(project, item)
        ? [
            {
              icon: Snowflake,
              label: t('video.timeline.freezeFrame'),
              disabled: !isUnderPlayhead || !single,
              onClick: () => freezeFrame(item.id),
              shortcut: 'video_freeze_frame',
            },
          ]
        : []),
      ...(item.type === 'clip' && ref?.kind === 'video' && !item.freeze
        ? [
            {
              icon: item.reverse ? Check : Rewind,
              label: t('video.timeline.reverse'),
              disabled: !single,
              onClick: () => setClipReversed(item.id, ref.path, !item.reverse),
            },
          ]
        : []),
      ...(cuts.length > 0
        ? [
            {
              icon: Blend,
              label: t('video.timeline.transition'),
              submenu: transitionMenu(cuts),
            },
          ]
        : []),
    ];

    const audio: Array<Option> = [
      ...(hasAudio && !muted
        ? [
            {
              icon: Unlink,
              label: t('video.timeline.detachAudio'),
              disabled: !single,
              onClick: () => editProject((current) => detachAudio(current, item.id)),
            },
          ]
        : []),
      ...(linkedIds(project, [item.id]).length > 1
        ? [{ icon: Link2Off, label: t('video.timeline.unlink'), onClick: unlinkSelection }]
        : []),
      ...(canLink(project, targets) ? [{ icon: Link2, label: t('video.timeline.link'), onClick: linkSelection }] : []),
      ...((hasAudio && !detached) || item.type === 'audio'
        ? [
            {
              icon: muted ? Volume2 : VolumeX,
              label: muted ? t('video.clip.unmute') : t('video.clip.mute'),
              disabled: !single,
              onClick: () => patch({ muted: !muted } as Partial<TimelineItem>),
            },
          ]
        : []),
      ...(item.type === 'audio' && previousAudio(project, item)
        ? [
            {
              icon: Blend,
              label: item.crossfade ? t('video.timeline.removeCrossfade') : t('video.timeline.crossfade'),
              disabled: !single,
              onClick: () =>
                editProject((current) =>
                  setCrossfade(current, item.id, item.crossfade ? 0 : secondsToTicks(DEFAULT_TRANSITION_SECONDS)),
                ),
            },
          ]
        : []),
      ...(item.type === 'audio' && beatPathOf(project, item)
        ? [
            {
              icon: AudioWaveform,
              label: item.beats ? t('video.timeline.hideBeats') : t('video.timeline.showBeats'),
              disabled: !single,
              onClick: () => patch({ beats: !item.beats } as Partial<TimelineItem>),
            },
          ]
        : []),
    ];

    const remove: Array<Option> = [
      {
        icon: Trash2,
        label: t('video.timeline.delete'),
        isDestructive: true,
        onClick: deleteSelected,
        shortcut: 'video_delete',
      },
      ...(isMain
        ? []
        : [
            {
              icon: FoldHorizontal,
              label: t('video.timeline.rippleDelete'),
              isDestructive: true,
              onClick: rippleDeleteSelection,
              shortcut: 'video_ripple_delete',
            },
          ]),
    ];

    showContextMenu(
      event.clientX,
      event.clientY,
      [structure, clipboard, adjustments, time, audio, montageMenu(t), remove]
        .filter((group) => group.length > 0)
        .flatMap((group, index) => (index === 0 ? group : [{ type: OPTION_SEPARATOR }, ...group])),
    );
  };

  const openRulerMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    if (!project) return;
    const time = snapTicks(pointerTime(event.clientX), project.settings.fps);
    showContextMenu(event.clientX, event.clientY, [
      {
        icon: Bookmark,
        label: t('video.markers.addHere'),
        onClick: () => editProject((current) => addMarker(current, time)[0]),
      },
      { type: OPTION_SEPARATOR },
      {
        icon: FlagTriangleRight,
        label: t('video.timeline.setIn'),
        onClick: () => editProject((current) => setRangeEdge(current, 'start', time)),
      },
      {
        icon: FlagTriangleLeft,
        label: t('video.timeline.setOut'),
        onClick: () => editProject((current) => setRangeEdge(current, 'end', time)),
      },
      {
        icon: FlagOff,
        label: t('video.timeline.clearRange'),
        disabled: !project.range,
        onClick: clearRange,
        shortcut: 'video_clear_range',
      },
      { type: OPTION_SEPARATOR },
      {
        icon: Play,
        label: t('video.timeline.playInToOut'),
        disabled: !project.range,
        onClick: playInToOut,
        shortcut: 'video_play_in_out',
      },
    ]);
  };

  if (!shown || !view) return null;

  const frame = frameTicks(shown.settings.fps);
  const mainItems = shown.videoTracks[0].items;

  const spanFor = (row: Row, item: TimelineItem, index: number) => {
    if (!isMainRow(row)) return { start: item.start, end: itemEnd(item) };
    const before = index > 0 ? Math.max(0, itemEnd(mainItems[index - 1]) - item.start) : 0;
    const next = mainItems[index + 1];
    const after = next ? Math.max(0, itemEnd(item) - next.start) : 0;
    return { start: item.start + before / 2, end: itemEnd(item) - after / 2 };
  };
  const margin = scroll.width;
  const stripStart = (Math.floor(scroll.start / STRIP_STEP) - 1) * STRIP_STEP;
  const stripEnd = (Math.ceil(scroll.end / STRIP_STEP) + 1) * STRIP_STEP;
  const interaction = interactionRef.current;
  const interacting = !interaction
    ? []
    : interaction.kind === 'move'
      ? interaction.ids
      : 'id' in interaction
        ? [interaction.id]
        : [];
  const ghosts = new Set(drag && interaction?.kind === 'move' ? interaction.ids : (plan?.ghosts ?? []));
  const snap = drag?.snap ?? plan?.snap ?? captionSnap;
  const trimming = drag && (interaction?.kind === 'trim' || interaction?.kind === 'roll') ? interaction : null;
  const rowOf = (item: TimelineItem) => view.rows.find((row) => row.track.items.some(({ id }) => id === item.id));
  itemActions.current = {
    pointerDown: (event, item) => {
      const row = rowOf(item);
      if (row) beginMove(event, item, row);
    },
    trimStart: (event, item, edge) => beginTrim(event, item, edge),
    slipStart: (event, item) => {
      const row = rowOf(item);
      if (event.altKey && event.shiftKey && row) beginMove(event, item, row);
      else beginSlip(event, item);
    },
    contextMenu: (event, item) => {
      const row = rowOf(item);
      if (row) openItemMenu(event, item, row);
    },
    open: (item) => openNested(item.id),
    resizeTransition: (event, item, side) => beginTransition(event, item, side),
  };

  return (
    <div className="flex flex-col h-full select-none">
      <div
        className={clsx(
          '@container h-10 shrink-0 flex items-center gap-1 px-2 border-b transition-colors',
          collapsed ? 'border-transparent' : 'border-surface',
        )}
      >
        <div className="flex-1 flex items-center gap-1 h-8">
          <PanelToggles edge="start" />
          <SequencePath project={shown} />
          <SplitButton project={shown} />
          <JoinButton project={shown} selection={selection} />
          <ToolbarButton
            icon={Trash2}
            tooltip={t('video.timeline.delete')}
            onClick={deleteSelected}
            disabled={selection.length === 0 && !gapSelected}
            shortcut="video_delete"
          />
          <div className="flex-1 flex flex-wrap items-center gap-1 h-8 min-w-0 overflow-hidden before:h-8 before:-mr-1 before:content-['']">
            <div className="h-5 w-px bg-surface mx-1" />
            <ToolbarButton
              icon={Type}
              tooltip={t('video.timeline.addTitle')}
              onClick={addTitle}
              shortcut="video_add_title"
            />
            <MarkerButton />
          </div>
        </div>
        <Transport duration={duration} />
        <div className="flex-1 flex items-center gap-1 h-8">
          <div className="flex-1 flex flex-row-reverse flex-wrap items-center gap-1 h-8 min-w-0 overflow-hidden before:h-8 before:-ml-1 before:content-['']">
            <ToolbarButton
              icon={Maximize2}
              tooltip={t('video.timeline.fit')}
              onClick={zoomToFit}
              shortcut="video_zoom_fit"
            />
            <div className="flex items-center gap-1 @max-[59rem]:hidden">
              <ToolbarButton
                icon={ZoomOut}
                tooltip={t('video.timeline.zoomOut')}
                onClick={zoomOut}
                shortcut="video_zoom_out"
              />
              <input
                type="range"
                min={Math.log(MIN_PPS)}
                max={Math.log(MAX_PPS)}
                step={0.01}
                value={Math.log(pps)}
                onChange={(e) => zoomTo(Math.exp(parseFloat(e.target.value)))}
                onDoubleClick={() => zoomTo(DEFAULT_PIXELS_PER_SECOND)}
                onMouseUp={(e) => e.currentTarget.blur()}
                className="w-24 h-1.5 shrink-0 appearance-none bg-surface rounded-full cursor-pointer slider-input @max-[71rem]:hidden"
                aria-label={t('video.timeline.zoom')}
              />
              <ToolbarButton
                icon={ZoomIn}
                tooltip={t('video.timeline.zoomIn')}
                onClick={zoomIn}
                shortcut="video_zoom_in"
              />
            </div>
            <div className="h-5 w-px bg-surface mx-1" />
            <ToolbarButton
              icon={Magnet}
              tooltip={t('video.timeline.snapping')}
              onClick={toggleSnapping}
              isActive={snapping}
              shortcut="video_toggle_snapping"
            />
            <ToolbarButton
              icon={CircleDot}
              tooltip={recordKeyframes ? t('video.keyframes.stopRecording') : t('video.keyframes.record')}
              onClick={toggleRecordKeyframes}
              isActive={recordKeyframes}
              activeClassName={RECORDING_CLASS}
              shortcut="video_record_keyframes"
            />
            <PlaybackMenuButton />
          </div>
          <PanelToggles edge="end" />
        </div>
      </div>

      <div
        ref={(node) => {
          scrollRef.current = node;
          setDropRef(node);
        }}
        className={clsx(
          'relative flex-1 min-h-0 overflow-auto custom-scrollbar transition-[opacity,visibility] duration-300 ease-in-out',
          collapsed && 'opacity-0 invisible',
        )}
        onScroll={updateScroll}
      >
        <div className="relative" style={{ width: contentWidth + HEADER_WIDTH, minHeight: '100%' }}>
          <div className="sticky top-0 z-50 flex bg-bg-secondary" style={{ height: RULER_HEIGHT }}>
            <RangeButtons />
            <div
              className="relative flex-1 border-b border-surface cursor-ew-resize"
              onPointerDown={beginScrub}
              onContextMenu={openRulerMenu}
            >
              <Ruler duration={duration} pps={pps} scroll={scroll} />
              <RulerMarkers
                markers={shown.markers}
                range={shown.range ?? null}
                fps={shown.settings.fps}
                pps={pps}
                timeAt={pointerTime}
              />
              <PlayheadHead pps={pps} />
            </div>
          </div>

          <div className="relative flex" style={{ height: view.height }}>
            <div className="sticky left-0 z-40 shrink-0 bg-bg-secondary" style={{ width: HEADER_WIDTH }}>
              {view.captions && (
                <div className="absolute left-0" style={{ top: view.captions.top }}>
                  <CaptionHeader enabled={shown.captions?.enabled ?? false} height={view.captions.height} />
                </div>
              )}
              {view.rows.map((row) => (
                <div
                  key={rowKey(row)}
                  className={clsx('absolute left-0', row.isNew && 'z-10')}
                  style={{ top: row.top }}
                >
                  <TrackHeader
                    kind={row.kind}
                    trackIndex={row.trackIndex}
                    trackId={row.track.id}
                    height={row.height}
                    isNew={!!row.isNew}
                    hidden={row.track.hidden}
                    muted={row.track.muted}
                    locked={row.track.locked}
                    label={trackLabel(row.kind, row.trackIndex, t('video.timeline.main'))}
                    resize={resizeHandlers}
                  />
                </div>
              ))}
            </div>
            <div
              ref={lanesRef}
              data-lane
              className={clsx(
                'relative flex-1',
                reflows &&
                  '[&_[data-item]:not([data-ghost])]:transition-[left] [&_[data-item]:not([data-ghost])]:duration-150',
              )}
              onPointerDown={beginEmpty}
            >
              <LaneGuides markers={shown.markers} range={shown.range ?? null} pps={pps} />
              {view.captions && (
                <CaptionLane
                  captions={shown.captions}
                  fps={shown.settings.fps}
                  pps={pps}
                  top={view.captions.top}
                  height={view.captions.height}
                  timeAt={pointerTime}
                  onSnap={setCaptionSnap}
                />
              )}
              {view.rows.map((row) => (
                <div
                  key={rowKey(row)}
                  className={clsx(
                    'absolute left-0 right-0 rounded-md',
                    row.isNew
                      ? 'z-30 bg-bg-secondary bg-linear-to-b from-accent/5 to-accent/5 ring-1 ring-inset ring-accent/40'
                      : isMainRow(row)
                        ? 'bg-bg-primary/60'
                        : 'bg-bg-primary/30',
                    row.track.hidden && 'opacity-40',
                  )}
                  style={{ top: row.top, height: row.height }}
                  data-lane
                >
                  {isMainRow(row) && <GapLayer project={shown} pps={pps} />}
                  {row.track.items.map((item, index) => {
                    const span = spanFor(row, item, index);
                    const { left, width } = spanBox(span.start, span.end, pps);
                    const isSelected = selection.includes(item.id);
                    const isGhost = ghosts.has(item.id);
                    const offscreen = left > scroll.end + margin || left + width < scroll.start - margin;
                    if (offscreen && !isSelected && !isGhost && !interacting.includes(item.id)) return null;
                    const ref = 'media' in item ? mediaOf(shown, item.media) : null;
                    const covers = isMainRow(row) ? row.track.items : null;
                    return (
                      <ItemView
                        key={item.id}
                        item={item}
                        path={ref?.path ?? null}
                        name={ref?.name}
                        info={ref ? media[ref.path] : undefined}
                        analysis={ref && item.type === 'audio' ? beatAnalyses[ref.path] : undefined}
                        left={left}
                        width={width}
                        stripFrom={item.type === 'clip' ? Math.min(width, Math.max(0, stripStart - left)) : 0}
                        stripTo={item.type === 'clip' ? Math.min(width, Math.max(0, stripEnd - left)) : 0}
                        height={row.height}
                        pps={pps}
                        isSelected={isSelected}
                        isPartner={isSelected && !leaders.has(item.id)}
                        isGhost={isGhost}
                        isSlipping={slipping === item.id}
                        slide={sliding === item.id && project ? slideOf(project, shown, item.id) : null}
                        trim={
                          trimming?.id === item.id && project ? trimOf(project, shown, item.id, trimming.edge) : null
                        }
                        isLinked={!!item.link && paired.has(item.link)}
                        isLocked={row.track.locked}
                        matte={mattes.get(item.id)}
                        coverStart={covers ? transitionCover(transitionOverlap(covers, index, frame), pps) : 0}
                        coverEnd={covers ? transitionCover(transitionOverlap(covers, index + 1, frame), pps) : 0}
                        dropEdge={plan?.edge?.item === item.id ? plan.edge.edge : null}
                        handlers={itemHandlers}
                      />
                    );
                  })}
                  {isMainRow(row) &&
                    row.track.items.map((item, index) => {
                      const overlap = transitionOverlap(row.track.items, index, frame);
                      if (item.type !== 'clip' || overlap === 0) return null;
                      return (
                        <TransitionMarker
                          key={`transition-${item.id}`}
                          item={item}
                          overlap={overlap}
                          pps={pps}
                          isSelected={selection.includes(item.id)}
                          isTarget={plan?.cut === item.id}
                          onSelect={selectTransition}
                          onResize={itemHandlers.resizeTransition}
                        />
                      );
                    })}
                </div>
              ))}
              {snap !== null && (
                <div
                  className="absolute top-0 bottom-0 z-30 w-px -ml-px bg-accent shadow-[0_0_6px] shadow-accent pointer-events-none"
                  style={{ left: Math.max(1, timeToX(snap, pps)) }}
                />
              )}
              {marquee && (
                <div
                  className="absolute z-30 rounded-sm border border-accent bg-accent/10 pointer-events-none"
                  style={marquee}
                />
              )}
              <PlayheadLine pps={pps} scrollRef={scrollRef} visibleRef={visibleRef} onPointerDown={beginScrub} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
