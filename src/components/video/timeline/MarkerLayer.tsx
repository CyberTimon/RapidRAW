import { memo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Palette, Pencil, Trash2 } from 'lucide-react';
import { OPTION_SEPARATOR } from '../../../types/ui';
import { FrameRate, Marker, Ticks, TimeRange } from '../../../types/video';
import { useContextMenu } from '../../../context/ContextMenuContext';
import { editProject, getVideo, setPlayhead } from '../../../store/useVideoStore';
import { removeMarker, updateMarker } from '../../../utils/video/edit';
import { sequenceDuration } from '../../../utils/video/model';
import { frameTicks, snapTicks } from '../../../utils/video/time';
import { alignHaptic } from '../../../utils/haptics';
import { timeToX } from './layout';
import { dragStarted, useInlineEdit, usePointerDrag } from './gestures';
import { snapTargets, snapTo, snapTolerance } from './snapping';

const MARKER_COLORS = [
  { id: 'yellow', value: '#facc15' },
  { id: 'red', value: '#ef4444' },
  { id: 'green', value: '#22c55e' },
  { id: 'blue', value: '#38bdf8' },
  { id: 'purple', value: '#a855f7' },
  { id: 'orange', value: '#f97316' },
] as const;

export const markerColor = (marker: Marker) => marker.color ?? MARKER_COLORS[0].value;

interface Drag {
  id: string;
  startX: number;
  grab: Ticks;
  moved: boolean;
}

type Edge = keyof TimeRange;

interface RangeDrag {
  edge: Edge;
  startX: number;
  grab: Ticks;
  targets: Array<Ticks>;
  duration: Ticks;
  moved: boolean;
}

interface RulerProps {
  markers: Array<Marker>;
  range: TimeRange | null;
  fps: FrameRate;
  pps: number;
  timeAt(clientX: number): Ticks;
}

function RulerRange({ range: base, fps, pps, timeAt }: Omit<RulerProps, 'markers'>) {
  const { t } = useTranslation();
  const [dragged, setDragged] = useState<TimeRange | null>(null);
  const drag = useRef<RangeDrag | null>(null);
  const range = dragged ?? base;

  const finish = (commit: boolean) => {
    const moved = !!drag.current?.moved;
    drag.current = null;
    const changed = dragged && (dragged.start !== base?.start || dragged.end !== base?.end);
    if (commit && moved && changed) editProject((next) => ({ ...next, range: dragged }));
    setDragged(null);
  };

  const startDrag = usePointerDrag({
    move: (event) => {
      const current = drag.current;
      if (!current || !base || !dragStarted(current, event.clientX)) return;
      const raw = snapTicks(timeAt(event.clientX) - current.grab, fps);
      const { time, snap } = snapTo(raw, current.targets, snapTolerance(pps));
      alignHaptic(current, snap);
      const frame = frameTicks(fps);
      setDragged(
        current.edge === 'start'
          ? { ...base, start: Math.min(base.end - frame, Math.max(0, time)) }
          : { ...base, end: Math.max(base.start + frame, Math.min(current.duration, time)) },
      );
    },
    end: () => finish(true),
    cancel: () => finish(false),
  });

  if (!range) return null;

  const begin = (event: ReactPointerEvent, edge: Edge) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    const { project } = getVideo();
    if (!project) return;
    startDrag(event);
    drag.current = {
      edge,
      startX: event.clientX,
      grab: timeAt(event.clientX) - range[edge],
      targets: snapTargets({ ...project, range: null }),
      duration: sequenceDuration(project),
      moved: false,
    };
  };

  const handle = (edge: Edge) => (
    <div
      className="absolute bottom-0 z-[15] w-2.5 h-3.5 -translate-x-1/2 flex justify-center cursor-ew-resize group/edge"
      style={{ left: timeToX(range[edge], pps) }}
      onPointerDown={(event) => begin(event, edge)}
      data-tooltip={t(edge === 'start' ? 'video.timeline.dragIn' : 'video.timeline.dragOut')}
    >
      <div className="w-0.5 h-full bg-accent group-hover/edge:w-1 transition-all" />
    </div>
  );

  return (
    <>
      <div
        className="absolute bottom-0 h-2 bg-accent/35 pointer-events-none"
        style={{
          left: timeToX(range.start, pps),
          width: Math.max(2, timeToX(range.end, pps) - timeToX(range.start, pps)),
        }}
      />
      {handle('start')}
      {handle('end')}
    </>
  );
}

export const RulerMarkers = memo(function RulerMarkers({ markers, range, fps, pps, timeAt }: RulerProps) {
  const { t } = useTranslation();
  const { showContextMenu } = useContextMenu();
  const [dragged, setDragged] = useState<{ id: string; time: Ticks } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const drag = useRef<Drag | null>(null);
  const inlineEdit = useInlineEdit();

  const finish = (commit: boolean) => {
    const current = drag.current;
    drag.current = null;
    setDragged(null);
    const marker = current && markers.find((candidate) => candidate.id === current.id);
    if (!commit || !current || !marker) return;
    if (current.moved && dragged && dragged.time !== marker.time)
      editProject((next) => updateMarker(next, current.id, { time: dragged.time }));
    else if (!current.moved) setPlayhead(marker.time);
  };

  const startDrag = usePointerDrag({
    move: (event) => {
      const current = drag.current;
      if (!current || !dragStarted(current, event.clientX)) return;
      const { project } = getVideo();
      if (!project) return;
      const raw = snapTicks(Math.max(0, timeAt(event.clientX) - current.grab), fps);
      const { time, snap } = snapTo(raw, snapTargets(project, current.id), snapTolerance(pps));
      alignHaptic(current, snap);
      setDragged({ id: current.id, time });
    },
    end: () => finish(true),
    cancel: () => finish(false),
  });

  const begin = (event: ReactPointerEvent, marker: Marker) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    startDrag(event);
    drag.current = { id: marker.id, startX: event.clientX, grab: timeAt(event.clientX) - marker.time, moved: false };
  };

  const rename = (marker: Marker, label: string | null) => {
    setRenaming(null);
    if (label !== null && label.trim() !== marker.label)
      editProject((next) => updateMarker(next, marker.id, { label: label.trim() }));
  };

  const openMenu = (event: React.MouseEvent, marker: Marker) => {
    event.preventDefault();
    event.stopPropagation();
    showContextMenu(event.clientX, event.clientY, [
      { icon: Pencil, label: t('video.markers.rename'), onClick: () => setRenaming(marker.id) },
      {
        icon: Palette,
        label: t('video.markers.color'),
        submenu: MARKER_COLORS.map((color) => ({
          label: t(`video.markers.colors.${color.id}`),
          color: color.value,
          onClick: () => editProject((next) => updateMarker(next, marker.id, { color: color.value })),
        })),
      },
      { type: OPTION_SEPARATOR },
      {
        icon: Trash2,
        label: t('video.markers.delete'),
        isDestructive: true,
        onClick: () => editProject((next) => removeMarker(next, marker.id)),
      },
    ]);
  };

  return (
    <>
      <RulerRange range={range} fps={fps} pps={pps} timeAt={timeAt} />
      {markers.map((marker) => {
        const time = dragged?.id === marker.id ? dragged.time : marker.time;
        const left = timeToX(time, pps);
        return (
          <div key={marker.id} className="absolute top-0 z-10 flex items-start" style={{ left: left - 5 }}>
            <div
              className="w-2.5 h-3 shrink-0 cursor-pointer"
              style={{
                backgroundColor: markerColor(marker),
                clipPath: 'polygon(0 0, 100% 0, 100% 65%, 50% 100%, 0 65%)',
              }}
              onPointerDown={(event) => begin(event, marker)}
              onDoubleClick={(event) => {
                event.stopPropagation();
                setRenaming(marker.id);
              }}
              onContextMenu={(event) => openMenu(event, marker)}
              data-tooltip={marker.label || t('video.markers.marker')}
            />
            {renaming === marker.id ? (
              <input
                {...inlineEdit((label) => rename(marker, label))}
                defaultValue={marker.label}
                placeholder={t('video.markers.marker')}
                className="ml-1 w-32 h-4 px-1 rounded bg-bg-primary text-[10px] text-text-primary outline-hidden ring-1 ring-accent"
              />
            ) : (
              marker.label && (
                <span className="ml-1 max-w-32 truncate text-[10px] leading-3 text-text-primary pointer-events-none">
                  {marker.label}
                </span>
              )
            )}
          </div>
        );
      })}
    </>
  );
});

export const LaneGuides = memo(function LaneGuides({
  markers,
  range,
  pps,
}: Pick<RulerProps, 'markers' | 'range' | 'pps'>) {
  return (
    <>
      {range && (
        <div
          className="absolute top-0 bottom-0 bg-accent/5 border-x border-accent/40 pointer-events-none"
          style={{
            left: timeToX(range.start, pps),
            width: Math.max(1, timeToX(range.end, pps) - timeToX(range.start, pps)),
          }}
        />
      )}
      {markers.map((marker) => (
        <div
          key={marker.id}
          className="absolute top-0 bottom-0 w-px opacity-50 pointer-events-none"
          style={{ left: timeToX(marker.time, pps), backgroundColor: markerColor(marker) }}
        />
      ))}
    </>
  );
});
