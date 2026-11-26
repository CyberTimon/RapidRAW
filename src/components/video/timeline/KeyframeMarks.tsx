import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ParseKeys, TFunction } from 'i18next';
import clsx from 'clsx';
import { ChartSpline, Spline, Trash2 } from 'lucide-react';
import { Ticks, TimelineItem, VideoProject } from '../../../types/video';
import { OPTION_SEPARATOR, Panel } from '../../../types/ui';
import { useContextMenu } from '../../../context/ContextMenuContext';
import { editProject, setPlayhead, useProjectFps, useVideoStore } from '../../../store/useVideoStore';
import { selectKeyframe, sourceFpsOf, useKeyframeSelection } from '../../../store/videoEditing';
import { useUIStore } from '../../../store/useUIStore';
import {
  KeyMark,
  KeyRef,
  channelGroup,
  clearKeyframes,
  easeKeyframes,
  groupHeads,
  groupMembers,
  isMarkAt,
  keyframeEase,
  keyframeMarks,
  lookChannelPath,
  moveKeyframes,
  removeKeyframes,
  trackedSpans,
} from '../../../utils/video/edit';
import { lookOf } from '../../../utils/video/model';
import { lookValueLabel } from '../../../utils/video/lookLabels';
import { secondsToTicks, snapTicks, ticksToSeconds } from '../../../utils/video/time';
import { easeOptions } from '../inspector/CurveEditor';
import { dragStarted, usePointerDrag } from './gestures';

const VALUE_LABELS: Record<string, ParseKeys> = {
  'transform.x': 'video.inspector.positionX',
  'transform.y': 'video.inspector.positionY',
  'transform.scale': 'video.inspector.scale',
  'transform.rotation': 'video.inspector.rotation',
  'transform.opacity': 'video.inspector.opacity',
  'transform.radius': 'video.inspector.cornerRadius',
  volume: 'video.inspector.volume',
  opacity: 'video.inspector.opacity',
  speed: 'video.inspector.speed',
};

export const channelLabel = (t: TFunction, project: VideoProject, item: TimelineItem, channel: string) => {
  const path = lookChannelPath(channel);
  if (path !== null) {
    const look = lookOf(project, item);
    return look ? lookValueLabel(look, path, t) : path;
  }
  return VALUE_LABELS[channel] ? t(VALUE_LABELS[channel]) : channel;
};

interface Drag {
  mark: KeyMark;
  startX: number;
  moved: boolean;
}

export default function KeyframeMarks({ item, pps }: { item: TimelineItem; pps: number }) {
  const { t } = useTranslation();
  const { showContextMenu } = useContextMenu();
  const project = useVideoStore((state) => state.project);
  const selected = useKeyframeSelection((state) => state.selected);
  const sourceFps = useVideoStore((state) => (state.project ? sourceFpsOf(state.project, item) : undefined));
  const [dragged, setDragged] = useState<{ key: Ticks; to: Ticks } | null>(null);
  const drag = useRef<Drag | null>(null);
  const marks = useMemo(() => (project ? keyframeMarks(project, item) : []), [project, item]);
  const spans = useMemo(() => (project ? trackedSpans(project, item, sourceFps) : []), [project, item, sourceFps]);
  const fps = useProjectFps();

  const target = (current: Drag, clientX: number) =>
    Math.max(
      0,
      Math.min(item.duration, snapTicks(current.mark.time + secondsToTicks((clientX - current.startX) / pps), fps)),
    );

  const startDrag = usePointerDrag({
    move: (event) => {
      const current = drag.current;
      if (!current || !dragStarted(current, event.clientX)) return;
      setDragged({ key: current.mark.time, to: target(current, event.clientX) });
    },
    end: (event) => {
      const current = drag.current;
      drag.current = null;
      setDragged(null);
      if (!current?.moved) return;
      const time = target(current, event.clientX);
      if (time === current.mark.time) return;
      editProject((next) => moveKeyframes(next, item.id, current.mark, time));
      selectKeyframe({ itemId: item.id, time });
      setPlayhead(item.start + time);
    },
    cancel: () => {
      drag.current = null;
      setDragged(null);
    },
  });

  if (!project || (marks.length === 0 && spans.length === 0)) return null;

  const begin = (event: ReactPointerEvent, mark: KeyMark) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    startDrag(event);
    drag.current = { mark, startX: event.clientX, moved: false };
    selectKeyframe({ itemId: item.id, time: mark.time });
    setPlayhead(item.start + mark.time);
  };

  const remove = (keys: Array<KeyRef>) => editProject((next) => removeKeyframes(next, item.id, keys));

  const clear = (keys: Array<KeyRef>) =>
    editProject((next) =>
      groupMembers(next, item, keys).reduce((current, key) => clearKeyframes(current, item.id, key), next),
    );

  const openMenu = (event: React.MouseEvent, mark: KeyMark) => {
    event.preventDefault();
    event.stopPropagation();
    selectKeyframe({ itemId: item.id, time: mark.time });
    const channels = groupHeads(mark.keys);
    const editCurve = () => {
      selectKeyframe({ itemId: item.id, time: mark.time });
      useUIStore.getState().setPanel(Panel.Inspector);
    };
    showContextMenu(event.clientX, event.clientY, [
      {
        icon: Spline,
        label: t('video.keyframes.easing'),
        submenu: easeOptions(t, keyframeEase(project, item, mark.keys), (preset) =>
          editProject((next) => easeKeyframes(next, item.id, mark.keys, preset)),
        ),
      },
      { icon: ChartSpline, label: t('video.keyframes.editCurve'), onClick: editCurve },
      { type: OPTION_SEPARATOR },
      {
        icon: Trash2,
        label: t('video.keyframes.delete'),
        isDestructive: true,
        onClick: () => remove(mark.keys),
        shortcut: 'video_delete',
      },
      channels.length === 1
        ? { icon: Trash2, label: t('video.keyframes.deleteAll'), isDestructive: true, onClick: () => clear(channels) }
        : {
            icon: Trash2,
            label: t('video.keyframes.deleteAll'),
            isDestructive: true,
            submenu: [
              ...channels.map((key) => ({
                label: channelLabel(t, project, item, channelGroup(key.channel)),
                onClick: () => clear([key]),
              })),
              { type: OPTION_SEPARATOR },
              { label: t('video.keyframes.allValues'), onClick: () => clear(channels) },
            ],
          },
    ]);
  };

  return (
    <>
      {spans.map(([from, to], index) => (
        <div
          key={index}
          className="absolute bottom-1.5 z-10 h-[3px] rounded-full bg-white/50 ring-1 ring-black/30 pointer-events-none"
          style={{ left: ticksToSeconds(from) * pps, width: ticksToSeconds(to - from) * pps }}
        />
      ))}
      {marks.map((mark) => {
        const time = dragged?.key === mark.time ? dragged.to : mark.time;
        const isSelected = selected?.itemId === item.id && isMarkAt(mark, selected.time, fps);
        return (
          <div
            key={mark.time}
            className="absolute bottom-0 z-30 w-3.5 h-3.5 -ml-[7px] flex items-center justify-center cursor-pointer group/key"
            style={{ left: ticksToSeconds(time) * pps }}
            onPointerDown={(event) => begin(event, mark)}
            onContextMenu={(event) => openMenu(event, mark)}
            onDoubleClick={(event) => event.stopPropagation()}
            data-keyframe
          >
            <div
              className={clsx(
                'w-2 h-2 rotate-45 ring-1 transition-transform',
                isSelected
                  ? 'bg-white ring-accent scale-125'
                  : 'bg-accent ring-black/40 group-hover/key:scale-125 group-hover/key:bg-white',
              )}
            />
          </div>
        );
      })}
    </>
  );
}
