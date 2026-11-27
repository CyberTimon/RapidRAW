import { memo, useMemo, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import {
  ChevronsLeftRight,
  CircleAlert,
  Image as ImageIcon,
  Layers,
  Layers2,
  Link2,
  Music,
  Rewind,
  Snowflake,
  Square,
  SquareDashed,
  SquaresIntersect,
  Type,
  VolumeX,
  type LucideIcon,
} from 'lucide-react';
import { AudioItem, ClipItem, FrameRate, MediaInfo, Ticks, TimelineItem } from '../../../types/video';
import { useContextMenu } from '../../../context/ContextMenuContext';
import { useProcessStore } from '../../../store/useProcessStore';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { formatKeyCode } from '../../../utils/keyboardUtils';
import { BeatEntry, TimelineBeat, beatsOnTimeline } from '../../../store/videoBeats';
import { MAX_DUCK_DB, useDuckCurves } from '../../../store/videoDucking';
import { useProjectFps, useVideoStore } from '../../../store/useVideoStore';
import { useTimelapseState } from '../../../store/videoTimelapse';
import { AnimatedItem, animationMenu, isAnimatedItem } from '../../../store/videoEffects';
import { MOTION_ICONS } from '../../../utils/video/effectRegistry';
import {
  clipSpeed,
  fileName,
  isMovingVideo,
  isRamped,
  itemEnd,
  sourceLength,
  sourceOffsets,
  sourceTimeOf,
} from '../../../utils/video/model';
import type { MatteRole } from '../../../utils/video/matte';
import { isSequencePath, sequenceIdOf, sequenceRevision } from '../../../utils/video/nesting';
import { formatDuration, formatTimecode, frameTicks, secondsToTicks, ticksToSeconds } from '../../../utils/video/time';
import TimelapseProgress from '../TimelapseProgress';
import KeyframeMarks from './KeyframeMarks';
import Timecode from './Timecode';
import { useMediaImage } from './media';
import StripCanvas, { filmTiles } from './StripCanvas';
import { timeToX } from './layout';

export interface ItemHandlers {
  pointerDown(event: ReactPointerEvent, item: TimelineItem): void;
  trimStart(event: ReactPointerEvent, item: TimelineItem, edge: 'start' | 'end'): void;
  slipStart(event: ReactPointerEvent, item: TimelineItem): void;
  fadeStart(event: ReactPointerEvent, item: TimelineItem, edge: 'in' | 'out'): void;
  contextMenu(event: React.MouseEvent, item: TimelineItem): void;
  open(item: TimelineItem): void;
}

export interface SlideInfo {
  shift: Ticks;
  previousOut: Ticks | null;
  nextIn: Ticks | null;
}

export interface TrimInfo {
  edge: 'start' | 'end';
  shift: Ticks;
  duration: Ticks;
}

interface ItemViewProps {
  item: TimelineItem;
  path: string | null;
  name?: string;
  info?: MediaInfo;
  analysis?: BeatEntry;
  left: number;
  width: number;
  stripFrom: number;
  stripTo: number;
  height: number;
  pps: number;
  isSelected: boolean;
  isPartner: boolean;
  isGhost: boolean;
  isSlipping: boolean;
  slide?: SlideInfo | null;
  trim?: TrimInfo | null;
  isLinked: boolean;
  isLocked: boolean;
  matte?: MatteRole;
  coverStart: number;
  coverEnd: number;
  dropEdge?: 'in' | 'out' | null;
  handlers: ItemHandlers;
}

const MIN_SLIP_WIDTH = 48;
const MIN_EDGE_WIDTH = 16;
const EDGE_ICON_WIDTH = 22;
const EDGE_LABEL_WIDTH = 64;
const HEADER_PADDING = 6;
const MIN_WAVE_BAND = 14;

const waveBand = (height: number) => Math.max(MIN_WAVE_BAND, Math.floor(height / 4));

function TrimHandle({
  edge,
  tooltip,
  onPointerDown,
}: {
  edge: 'start' | 'end';
  tooltip: string;
  onPointerDown(e: ReactPointerEvent): void;
}) {
  return (
    <div
      className={clsx(
        'absolute top-0 bottom-0 w-2 z-20 cursor-ew-resize flex items-center justify-center',
        'opacity-0 group-hover:opacity-100 transition-opacity',
        edge === 'start' ? 'left-0' : 'right-0',
      )}
      onPointerDown={onPointerDown}
      data-edge={edge}
      data-tooltip={tooltip}
    >
      <div className="w-1 h-1/2 rounded-full bg-white/80 shadow" />
    </div>
  );
}

function FadeRamps({
  fadeIn,
  fadeOut,
  width,
  pps,
  target,
}: {
  fadeIn: number;
  fadeOut: number;
  width: number;
  pps: number;
  target?: 'in' | 'out' | null;
}) {
  const size = (ticks: number) => Math.min(width / 2, ticksToSeconds(ticks) * pps);
  const tone = (edge: 'in' | 'out') => (target === edge ? 'bg-accent/55' : 'bg-black/40');
  return (
    <>
      {fadeIn > 0 && (
        <div
          className={clsx('absolute top-0 bottom-0 left-0 pointer-events-none transition-colors', tone('in'))}
          style={{ width: size(fadeIn), clipPath: 'polygon(0 0, 100% 0, 0 100%)' }}
        />
      )}
      {fadeOut > 0 && (
        <div
          className={clsx('absolute top-0 bottom-0 right-0 pointer-events-none transition-colors', tone('out'))}
          style={{ width: size(fadeOut), clipPath: 'polygon(0 0, 100% 0, 100% 100%)' }}
        />
      )}
      {target && (
        <div
          className={clsx(
            'absolute top-0 bottom-0 w-0.5 bg-accent shadow-[0_0_6px] shadow-accent pointer-events-none',
            target === 'in' ? 'left-0' : 'right-0',
          )}
        />
      )}
    </>
  );
}

function EdgeMarker({
  item,
  edge,
  width,
  pps,
  isTarget,
  canResize,
  onResize,
}: {
  item: AnimatedItem;
  edge: 'in' | 'out';
  width: number;
  pps: number;
  isTarget: boolean;
  canResize: boolean;
  onResize(event: ReactPointerEvent): void;
}) {
  const { t } = useTranslation();
  const { showContextMenu } = useContextMenu();
  const fade = edge === 'in' ? item.fadeIn : item.fadeOut;
  if (fade <= 0) return null;
  const kind = item[edge === 'in' ? 'animIn' : 'animOut']?.kind ?? 'fade';
  const Icon = MOTION_ICONS[kind];
  const ramp = Math.min(width / 2, ticksToSeconds(fade) * pps);
  const size = Math.min(width / 2, Math.max(MIN_EDGE_WIDTH, ramp));
  const label = formatDuration(fade);
  const isIn = edge === 'in';

  const openMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    showContextMenu(event.clientX, event.clientY, animationMenu(item, edge));
  };

  return (
    <div
      className={clsx('group/edge absolute top-0 bottom-0 z-10', isIn ? 'left-0' : 'right-0')}
      style={{ width: size }}
      onContextMenu={openMenu}
      data-tooltip={`${t(isIn ? 'video.inspector.animIn' : 'video.inspector.animOut')} · ${t(`video.transitions.${kind}`)} · ${label}`}
    >
      <div
        className={clsx(
          'absolute top-0 bottom-0 pointer-events-none transition-colors',
          isIn ? 'left-0' : 'right-0',
          isTarget ? 'bg-accent/55' : 'bg-black/45',
        )}
        style={{ width: ramp, clipPath: isIn ? 'polygon(0 0, 100% 0, 0 100%)' : 'polygon(0 0, 100% 0, 100% 100%)' }}
      />
      <div className="absolute inset-0 rounded-md ring-1 ring-inset ring-white/0 group-hover/edge:ring-white/40 transition-shadow pointer-events-none" />
      {size >= EDGE_ICON_WIDTH && (
        <div
          className={clsx(
            'absolute inset-x-0 top-4 bottom-0 flex items-center gap-1 px-1 text-white pointer-events-none',
            isIn ? 'justify-start' : 'justify-end',
          )}
        >
          <Icon size={12} className="shrink-0 drop-shadow" />
          {size >= EDGE_LABEL_WIDTH && (
            <span className="text-[10px] font-medium tabular-nums drop-shadow">{label}</span>
          )}
        </div>
      )}
      {canResize && (
        <div
          className={clsx(
            'absolute top-0 bottom-0 w-1.5 z-20 cursor-ew-resize opacity-0 group-hover/edge:opacity-100 bg-white/40',
            isIn ? 'right-0' : 'left-0',
          )}
          onPointerDown={onResize}
        />
      )}
      {isTarget && (
        <div
          className={clsx(
            'absolute top-0 bottom-0 w-0.5 bg-accent shadow-[0_0_6px] shadow-accent pointer-events-none',
            isIn ? 'left-0' : 'right-0',
          )}
        />
      )}
    </div>
  );
}

function MatteSpans({ spans, start, pps }: { spans: MatteRole['spans']; start: number; pps: number }) {
  return (
    <>
      {spans.map((span) => (
        <div
          key={span.start}
          className="absolute inset-y-0 pointer-events-none bg-black/25 bg-[repeating-linear-gradient(135deg,rgb(255_255_255/0.16)_0_2px,transparent_2px_7px)]"
          style={{ left: ticksToSeconds(span.start - start) * pps, width: ticksToSeconds(span.end - span.start) * pps }}
        />
      ))}
    </>
  );
}

function Frames({
  path,
  info,
  item,
  left,
  from,
  to,
  height,
  pps,
  fps,
}: {
  path: string;
  info?: MediaInfo;
  item: ClipItem;
  left: number;
  from: number;
  to: number;
  height: number;
  pps: number;
  fps: FrameRate;
}) {
  const isVideo = isMovingVideo(info);
  const sequence = sequenceIdOf(path);
  const project = useVideoStore((s) => (sequence ? s.project : null));
  const revision = useMemo(() => (project && sequence ? sequenceRevision(project, sequence) : ''), [project, sequence]);
  const rendering = useTimelapseState(path)?.state === 'running';
  const strip = useMediaImage('sprite', path, isVideo && !rendering, revision);
  const thumbnail = useProcessStore((s) => s.thumbnails[path]);
  const duration = info?.duration ?? 0;
  const tiles = useMemo(() => {
    if (!strip || duration <= 0) return null;
    const start = timeToX(item.start, pps);
    const anchored = !item.freeze && !isRamped(item);
    const lead = (ticksToSeconds(item.sourceIn) / clipSpeed(item)) * pps * (item.reverse ? -1 : 1);
    return filmTiles(strip, from, to, (anchored ? start - lead : start) - left, height, (centers) => {
      const locals = centers.map((center) => {
        const local = secondsToTicks((left + center) / pps) - item.start;
        return anchored ? local : Math.min(item.duration, Math.max(0, local));
      });
      return sourceOffsets(item, locals, fps).map((offset) => ticksToSeconds(item.sourceIn + offset) / duration);
    });
  }, [strip, duration, item, pps, left, from, to, height, fps]);
  if (!strip || !tiles) {
    return thumbnail ? (
      <div
        className="absolute inset-0 opacity-90"
        style={{ backgroundImage: `url(${thumbnail})`, backgroundSize: 'auto 100%', backgroundRepeat: 'repeat-x' }}
      />
    ) : null;
  }
  return <StripCanvas strip={strip} from={from} to={to} height={height} tiles={tiles} className="opacity-90" />;
}

const RAMP_SEGMENT_PX = 16;
const MAX_RAMP_SEGMENTS = 64;

function Waveform({
  path,
  item,
  info,
  width,
  fps,
  className,
  height,
  color,
}: {
  path: string;
  item: TimelineItem;
  info?: MediaInfo;
  width: number;
  fps: FrameRate;
  className: string;
  height?: number;
  color: string;
}) {
  const duration = info?.duration ?? 0;
  const waveform = useMediaImage('waveform', path, duration > 0 && !!info?.hasAudio);
  const segments = useMemo(() => {
    if (!('sourceIn' in item)) return [];
    const count = isRamped(item) ? Math.min(MAX_RAMP_SEGMENTS, Math.max(1, Math.ceil(width / RAMP_SEGMENT_PX))) : 1;
    const locals = Array.from({ length: count + 1 }, (_, index) => Math.round((item.duration * index) / count));
    const edges = sourceOffsets(item, locals, fps).map((offset, index) => ({
      left: (width * index) / count,
      source: item.sourceIn + offset,
    }));
    return edges.slice(1).map((edge, index) => ({ from: edges[index], to: edge }));
  }, [item, width, fps]);
  if (!waveform || duration <= 0) return null;
  return (
    <div className={className} style={{ height }}>
      {segments.map(({ from, to }) => {
        const segmentWidth = to.left - from.left;
        const length = ticksToSeconds(Math.abs(to.source - from.source));
        const fullWidth = (segmentWidth * duration) / Math.max(length, 1e-3);
        const offset = (-ticksToSeconds(Math.min(from.source, to.source)) / duration) * fullWidth;
        return (
          <div
            key={from.left}
            className={clsx('absolute inset-y-0', color)}
            style={{
              left: from.left,
              width: segmentWidth,
              ...(to.source < from.source ? { transform: 'scaleX(-1)' } : {}),
              maskImage: `url(${waveform})`,
              WebkitMaskImage: `url(${waveform})`,
              maskSize: `${fullWidth}px 100%`,
              WebkitMaskSize: `${fullWidth}px 100%`,
              maskPosition: `${offset}px 0`,
              WebkitMaskPosition: `${offset}px 0`,
              maskRepeat: 'no-repeat',
              WebkitMaskRepeat: 'no-repeat',
            }}
          />
        );
      })}
    </div>
  );
}

const MIN_BEAT_SPACING = 5;

function BeatTicks({ beats, start, pps }: { beats: Array<TimelineBeat>; start: number; pps: number }) {
  if (beats.length < 2) return null;
  const spacing = (ticksToSeconds(beats[beats.length - 1].time - beats[0].time) / (beats.length - 1)) * pps;
  const shown = spacing >= MIN_BEAT_SPACING ? beats : beats.filter((beat) => beat.isDownbeat);
  return (
    <>
      {shown.map((beat) => (
        <div
          key={beat.time}
          className={clsx(
            'absolute bottom-0 w-px pointer-events-none',
            beat.isDownbeat ? 'top-0 bg-white/90' : 'top-1/2 bg-white/55',
          )}
          style={{ left: ticksToSeconds(beat.time - start) * pps }}
        />
      ))}
    </>
  );
}

const spareMedia = (item: TimelineItem, info: MediaInfo | undefined, fps: FrameRate) =>
  'sourceIn' in item && !!info && !info.isStill && info.duration > 0
    ? secondsToTicks(info.duration) - sourceLength(item, fps) >= frameTicks(fps)
    : false;

const READOUT_CHIP = 'px-1 py-0.5 rounded bg-black/60';

function Readout({ chips, children }: { chips: ReactNode; children?: ReactNode }) {
  return (
    <div className="absolute inset-0 z-20 flex flex-col justify-end gap-1 p-1 bg-black/40 pointer-events-none">
      <div className="flex justify-between gap-1 text-[10px] leading-none text-white">{chips}</div>
      {children}
    </div>
  );
}

function ShiftChip({ shift, fps }: { shift: Ticks; fps: FrameRate }) {
  return (
    <Timecode
      value={`${shift < 0 ? '-' : '+'}${formatTimecode(Math.abs(shift), fps)}`}
      className={clsx(READOUT_CHIP, 'text-accent')}
    />
  );
}

function SlipReadout({ item, info, fps }: { item: TimelineItem; info: MediaInfo; fps: FrameRate }) {
  if (!('sourceIn' in item)) return null;
  const out = sourceTimeOf(item, itemEnd(item), fps);
  const total = Math.max(1, secondsToTicks(info.duration));
  const from = Math.min(item.sourceIn, out) / total;
  const to = Math.max(item.sourceIn, out) / total;
  return (
    <Readout
      chips={
        <>
          <Timecode value={formatTimecode(item.sourceIn, fps)} className={READOUT_CHIP} />
          <Timecode value={formatTimecode(out, fps)} className={READOUT_CHIP} />
        </>
      }
    >
      <div className="relative h-1 shrink-0 rounded-full bg-white/25">
        <div
          className="absolute inset-y-0 rounded-full bg-accent"
          style={{ left: `${from * 100}%`, width: `${Math.max(1, (to - from) * 100)}%` }}
        />
      </div>
    </Readout>
  );
}

function SlideReadout({ slide, fps }: { slide: SlideInfo; fps: FrameRate }) {
  const point = (time: Ticks | null) => (time === null ? '--' : formatTimecode(time, fps));
  return (
    <Readout
      chips={
        <>
          <Timecode value={point(slide.previousOut)} className={READOUT_CHIP} />
          <ShiftChip shift={slide.shift} fps={fps} />
          <Timecode value={point(slide.nextIn)} className={READOUT_CHIP} />
        </>
      }
    />
  );
}

function TrimReadout({ trim, fps }: { trim: TrimInfo; fps: FrameRate }) {
  const shift = <ShiftChip shift={trim.shift} fps={fps} />;
  const duration = <Timecode value={formatTimecode(trim.duration, fps)} className={READOUT_CHIP} />;
  return (
    <Readout
      chips={
        trim.edge === 'start' ? (
          <>
            {shift}
            {duration}
          </>
        ) : (
          <>
            {duration}
            {shift}
          </>
        )
      }
    />
  );
}

function DuckCurve({ item, width }: { item: AudioItem; width: number }) {
  const points = useDuckCurves((state) => state[item.id]);
  if (!item.duck || !points?.some(([, depth]) => depth > 0)) return null;
  const dip = Math.min(1, -item.duck / MAX_DUCK_DB) * 100;
  const line = points
    .map(
      ([time, depth]) =>
        `${(((secondsToTicks(time) - item.start) / item.duration) * width).toFixed(1)},${(depth * dip).toFixed(1)}`,
    )
    .join(' ');
  return (
    <svg
      className="absolute inset-x-0 bottom-0 top-4 h-[calc(100%-1rem)] pointer-events-none"
      width={width}
      viewBox={`0 0 ${Math.max(1, width)} 100`}
      preserveAspectRatio="none"
    >
      <polygon points={`0,0 ${line} ${width},0`} className="fill-black/35" />
      <polyline points={line} className="fill-none stroke-white/70" strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const ITEM_STYLE: Record<TimelineItem['type'], string> = {
  clip: 'bg-surface',
  audio: 'bg-accent/25',
  title: 'bg-sky-500/25',
  adjustment: 'bg-violet-500/25',
  solid: 'bg-card-active',
};

const ITEM_ICON: Record<Exclude<TimelineItem['type'], 'clip'>, LucideIcon> = {
  audio: Music,
  title: Type,
  adjustment: Layers2,
  solid: Square,
};

function ItemView({
  item,
  path,
  name,
  info,
  analysis,
  left,
  width,
  stripFrom,
  stripTo,
  height,
  pps,
  isSelected,
  isPartner,
  isGhost,
  isSlipping,
  slide,
  trim,
  isLinked,
  isLocked,
  matte,
  coverStart,
  coverEnd,
  dropEdge,
  handlers,
}: ItemViewProps) {
  const { t } = useTranslation();
  const osPlatform = useSettingsStore((state) => state.osPlatform);
  const fps = useProjectFps();
  const beats = useMemo(() => (item.type === 'audio' ? beatsOnTimeline(item, analysis) : null), [item, analysis]);
  const tempo = item.type === 'audio' && item.beats && typeof analysis === 'object' ? analysis.tempo : undefined;
  const missing = 'media' in item && !info;
  const speed = 'speed' in item && !isRamped(item) ? clipSpeed(item) : 1;
  const muted = 'muted' in item && item.muted;
  const isLeader = isSelected && !isPartner;
  let label: ReactNode;
  let content: ReactNode = null;
  const nested = !!path && isSequencePath(path);
  if (item.type === 'clip') {
    label = missing ? t('video.timeline.missing') : (name ?? (nested || !path ? '' : fileName(path)));
    if (path) {
      content = (
        <>
          <Frames
            path={path}
            info={info}
            item={item}
            left={left}
            from={stripFrom}
            to={stripTo}
            height={height}
            pps={pps}
            fps={fps}
          />
          <TimelapseProgress path={path} className="absolute inset-x-1 bottom-1 bg-black/40" />
          {!nested && !muted && !item.freeze && info?.hasAudio && !info.isStill && (
            <Waveform
              path={path}
              item={item}
              info={info}
              width={width}
              fps={fps}
              className="absolute inset-x-0 bottom-0"
              height={waveBand(height)}
              color="bg-white/75"
            />
          )}
        </>
      );
    }
  } else if (item.type === 'audio') {
    label = `${path ? fileName(path) : ''}${tempo ? ` · ${Math.round(tempo)} BPM` : ''}`;
    if (path)
      content = (
        <>
          <Waveform
            path={path}
            item={item}
            info={info}
            width={width}
            fps={fps}
            className="absolute inset-0 top-4"
            color="bg-accent"
          />
          <DuckCurve item={item} width={width} />
        </>
      );
  } else if (item.type === 'title') {
    label = item.text.split('\n')[0] || t('video.titles.text');
  } else if (item.type === 'adjustment') {
    label = t('video.timeline.adjustmentLayer');
  } else {
    label = t('video.timeline.solid');
    content = <div className="absolute inset-0 opacity-70" style={{ backgroundColor: item.color }} />;
  }
  const Icon =
    item.type === 'clip'
      ? nested
        ? Layers
        : info?.isStill
          ? ImageIcon
          : item.freeze
            ? Snowflake
            : item.reverse
              ? Rewind
              : null
      : item.type === 'audio' && item.reverse
        ? Rewind
        : ITEM_ICON[item.type];
  const isTall = item.type === 'clip';
  const alt = formatKeyCode('alt', osPlatform);
  const trimHint = isLocked ? '' : t('video.timeline.trimHint', { alt });
  const canSlip = !isLocked && !isGhost && !slide && !trim && width >= MIN_SLIP_WIDTH && spareMedia(item, info, fps);
  const onHeader = isLeader ? 'text-button-text' : isTall ? 'text-white/95' : 'text-text-primary/90';

  return (
    <div
      className={clsx(
        'group absolute top-0 bottom-0 rounded-md overflow-hidden ring-inset select-none',
        isLocked ? 'cursor-default' : 'cursor-grab active:cursor-grabbing',
        missing ? 'bg-red-500/20' : nested ? 'bg-emerald-500/25' : ITEM_STYLE[item.type],
        isGhost
          ? 'ring-2 ring-accent opacity-75 shadow-lg shadow-black/40'
          : isLeader
            ? 'ring-2 ring-accent'
            : isPartner
              ? 'ring-2 ring-accent/45'
              : 'ring-1 ring-black/30 hover:ring-white/25',
      )}
      style={{ left, width: Math.max(4, width) }}
      data-item={item.id}
      data-ghost={isGhost || undefined}
      data-locked={isLocked || undefined}
      onPointerDown={(event) => handlers.pointerDown(event, item)}
      onContextMenu={(event) => handlers.contextMenu(event, item)}
      onDoubleClick={nested ? () => handlers.open(item) : undefined}
    >
      {content}
      {beats && <BeatTicks beats={beats} start={item.start} pps={pps} />}
      {isAnimatedItem(item) ? (
        (['in', 'out'] as const).map((edge) => (
          <EdgeMarker
            key={edge}
            item={item}
            edge={edge}
            width={width}
            pps={pps}
            isTarget={dropEdge === edge}
            canResize={!isLocked && !isGhost}
            onResize={(event) => handlers.fadeStart(event, item, edge)}
          />
        ))
      ) : (
        <FadeRamps fadeIn={item.fadeIn} fadeOut={item.fadeOut} width={width} pps={pps} target={dropEdge} />
      )}
      {matte && <MatteSpans spans={matte.spans} start={item.start} pps={pps} />}
      {isSelected && <div className="absolute inset-0 pointer-events-none bg-white/5" />}
      <div
        className={clsx(
          'absolute inset-x-0 top-0 h-4 flex items-center gap-1 min-w-0',
          isLeader ? 'bg-accent' : isPartner ? 'bg-accent/35' : isTall && 'bg-linear-to-b from-black/60 to-black/25',
        )}
        style={{ paddingLeft: HEADER_PADDING + coverStart, paddingRight: HEADER_PADDING + coverEnd }}
      >
        {missing && <CircleAlert size={11} className="shrink-0 text-red-300" />}
        {Icon && <Icon size={11} className={clsx('shrink-0', onHeader)} />}
        {isLinked && <Link2 size={11} className={clsx('shrink-0', onHeader)} />}
        {matte?.matted && <SquaresIntersect size={11} className={clsx('shrink-0', onHeader)} />}
        {!!matte?.spans.length && <SquareDashed size={11} className={clsx('shrink-0', onHeader)} />}
        {muted && item.type !== 'audio' && <VolumeX size={11} className={clsx('shrink-0', onHeader)} />}
        <span className={clsx('text-[10px] leading-tight truncate', isLeader && 'font-medium', onHeader)}>{label}</span>
        {isTall && width > 90 && (
          <span className={clsx('ml-auto text-[10px] leading-tight shrink-0', onHeader)}>
            {speed !== 1 && `${speed}× · `}
            {formatDuration(item.duration)}
          </span>
        )}
      </div>
      {isSelected && !isGhost && <KeyframeMarks item={item} pps={pps} />}
      {isSlipping && info && <SlipReadout item={item} info={info} fps={fps} />}
      {slide && <SlideReadout slide={slide} fps={fps} />}
      {trim && <TrimReadout trim={trim} fps={fps} />}
      {canSlip && (
        <div
          className={clsx(
            'absolute left-1/2 -translate-x-1/2 z-20 h-4 px-1.5 rounded-full flex items-center cursor-ew-resize',
            'ring-1 ring-white/20 transition-opacity',
            isSlipping
              ? 'bg-black/80 text-white'
              : 'bg-black/60 text-white/90 hover:bg-black/80 hover:text-white opacity-0 group-hover:opacity-100',
          )}
          style={{ bottom: isTall ? waveBand(height) + 2 : 4 }}
          onPointerDown={(event) => handlers.slipStart(event, item)}
          data-tooltip={isSlipping ? undefined : t('video.timeline.slipHint', { alt })}
        >
          <ChevronsLeftRight size={11} />
        </div>
      )}
      {!isLocked && !isGhost && (
        <>
          <TrimHandle
            edge="start"
            tooltip={trimHint}
            onPointerDown={(event) => handlers.trimStart(event, item, 'start')}
          />
          <TrimHandle edge="end" tooltip={trimHint} onPointerDown={(event) => handlers.trimStart(event, item, 'end')} />
        </>
      )}
    </div>
  );
}

export default memo(ItemView);
