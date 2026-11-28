import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ParseKeys, TFunction } from 'i18next';
import clsx from 'clsx';
import { ChartSpline, Spline, Trash2 } from 'lucide-react';
import { Ticks, TimelineItem, VideoProject } from '../../../types/video';
import { OPTION_SEPARATOR, Panel } from '../../../types/ui';
import { useContextMenu } from '../../../context/ContextMenuContext';
import { editProject, setPlayhead, useProjectFps, useVideoStore } from '../../../store/useVideoStore';
import {
  isKeyframeSelected,
  keyframeDragOffset,
  moveSelectedKeyframes,
  previewKeyframeOffset,
  selectKeyframe,
  selectedKeyframeMarks,
  sourceFpsOf,
  toggleKeyframeSelection,
  useKeyframeSelection,
} from '../../../store/videoEditing';
import { useUIStore } from '../../../store/useUIStore';
import {
  KeyMark,
  KeyRef,
  channelGroup,
  clearKeyframes,
  easeKeyframes,
  groupHeads,
  groupMembers,
  keyframeEase,
  keyframeMarks,
  lookChannelPath,
  removeKeyframes,
  trackedSpans,
} from '../../../utils/video/edit';
import { lookOf } from '../../../utils/video/model';
import { lookValueLabel } from '../../../utils/video/lookLabels';
import { formatTimecode, secondsToTicks, snapTicks, ticksToSeconds } from '../../../utils/video/time';
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
  collapse: boolean;
}

export default function KeyframeMarks({ item, pps }: { item: TimelineItem; pps: number }) {
  const { t } = useTranslation();
  const { showContextMenu } = useContextMenu();
  const project = useVideoStore((state) => state.project);
  const group = useKeyframeSelection((state) => state.group);
  const offset = useKeyframeSelection((state) => state.offset);
  const sourceFps = useVideoStore((state) => (state.project ? sourceFpsOf(state.project, item) : undefined));
  const [dragging, setDragging] = useState<Ticks | null>(null);
  const drag = useRef<Drag | null>(null);
  const marks = useMemo(() => (project ? keyframeMarks(project, item) : []), [project, item]);
  const spans = useMemo(() => (project ? trackedSpans(project, item, sourceFps) : []), [project, item, sourceFps]);
  const fps = useProjectFps();
  useEffect(
    () => () => {
      if (drag.current) previewKeyframeOffset(null);
    },
    [],
  );

  const deltaAt = (current: Drag, clientX: number) =>
    keyframeDragOffset(
      snapTicks(current.mark.time + secondsToTicks((clientX - current.startX) / pps), fps) - current.mark.time,
    );

  const startDrag = usePointerDrag({
    move: (event) => {
      const current = drag.current;
      if (!current || !dragStarted(current, event.clientX)) return;
      previewKeyframeOffset(deltaAt(current, event.clientX));
    },
    end: (event) => {
      const current = drag.current;
      drag.current = null;
      setDragging(null);
      if (!current?.moved) {
        previewKeyframeOffset(null);
        if (current?.collapse) selectKeyframe({ itemId: item.id, time: current.mark.time });
        return;
      }
      const delta = deltaAt(current, event.clientX);
      moveSelectedKeyframes(delta);
      setPlayhead(item.start + current.mark.time + delta);
    },
    cancel: () => {
      drag.current = null;
      setDragging(null);
      previewKeyframeOffset(null);
    },
  });

  if (!project || (marks.length === 0 && spans.length === 0)) return null;

  const valuesOf = (keys: Array<KeyRef>) =>
    groupHeads(keys).map((key) => ({ key, label: channelLabel(t, project, item, channelGroup(key.channel)) }));

  const begin = (event: ReactPointerEvent, mark: KeyMark) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    const keyframe = { itemId: item.id, time: mark.time };
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const chosen = isKeyframeSelected(group, item.id, mark, fps);
    if (additive) {
      toggleKeyframeSelection(keyframe, fps);
      if (chosen) return;
    } else if (!chosen) {
      selectKeyframe(keyframe);
    } else {
      useKeyframeSelection.setState({ selected: keyframe });
    }
    startDrag(event);
    drag.current = { mark, startX: event.clientX, moved: false, collapse: !additive && chosen && group.length > 1 };
    setDragging(mark.time);
    setPlayhead(item.start + mark.time);
  };

  const targetsFor = (mark: KeyMark) => {
    if (!isKeyframeSelected(group, item.id, mark, fps)) selectKeyframe({ itemId: item.id, time: mark.time });
    return selectedKeyframeMarks();
  };

  const remove = (targets: Array<{ itemId: string; keys: Array<KeyRef> }>) =>
    editProject((next) => targets.reduce((current, { itemId, keys }) => removeKeyframes(current, itemId, keys), next));

  const clear = (keys: Array<KeyRef>) =>
    editProject((next) =>
      groupMembers(next, item, keys).reduce((current, key) => clearKeyframes(current, item.id, key), next),
    );

  const openMenu = (event: React.MouseEvent, mark: KeyMark) => {
    event.preventDefault();
    event.stopPropagation();
    const targets = targetsFor(mark);
    const single = targets.length <= 1;
    const values = valuesOf(mark.keys);
    const editCurve = () => {
      selectKeyframe({ itemId: item.id, time: mark.time });
      useUIStore.getState().setPanel(Panel.Inspector);
    };
    const ease = (preset: Parameters<typeof easeKeyframes>[3]) =>
      editProject((next) =>
        targets.reduce((current, target) => easeKeyframes(current, target.itemId, target.mark.keys, preset), next),
      );
    showContextMenu(event.clientX, event.clientY, [
      {
        icon: Spline,
        label: t('video.keyframes.easing'),
        submenu: easeOptions(t, single ? keyframeEase(project, item, mark.keys) : null, ease),
      },
      ...(single ? [{ icon: ChartSpline, label: t('video.keyframes.editCurve'), onClick: editCurve }] : []),
      { type: OPTION_SEPARATOR },
      !single || values.length === 1
        ? {
            icon: Trash2,
            label: t('video.keyframes.delete'),
            isDestructive: true,
            onClick: () => remove(targets.map((target) => ({ itemId: target.itemId, keys: target.mark.keys }))),
            shortcut: 'video_delete',
          }
        : {
            icon: Trash2,
            label: t('video.keyframes.delete'),
            isDestructive: true,
            submenu: [
              ...values.map(({ key, label }) => ({
                label,
                onClick: () =>
                  remove([
                    {
                      itemId: item.id,
                      keys: mark.keys.filter((other) => channelGroup(other.channel) === channelGroup(key.channel)),
                    },
                  ]),
              })),
              { type: OPTION_SEPARATOR },
              {
                label: t('video.keyframes.allValues'),
                onClick: () => remove([{ itemId: item.id, keys: mark.keys }]),
                shortcut: 'video_delete',
              },
            ],
          },
      ...(single
        ? [
            values.length === 1
              ? {
                  icon: Trash2,
                  label: t('video.keyframes.deleteAll'),
                  isDestructive: true,
                  onClick: () => clear(values.map(({ key }) => key)),
                }
              : {
                  icon: Trash2,
                  label: t('video.keyframes.deleteAll'),
                  isDestructive: true,
                  submenu: [
                    ...values.map(({ key, label }) => ({ label, onClick: () => clear([key]) })),
                    { type: OPTION_SEPARATOR },
                    { label: t('video.keyframes.allValues'), onClick: () => clear(values.map(({ key }) => key)) },
                  ],
                },
          ]
        : []),
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
        const isSelected = isKeyframeSelected(group, item.id, mark, fps);
        const time = isSelected && offset !== null ? mark.time + offset : mark.time;
        const isDragged = dragging === mark.time && offset !== null;
        return (
          <div
            key={mark.time}
            className="absolute bottom-0 z-30 w-3.5 h-3.5 -ml-[7px] flex items-center justify-center cursor-pointer group/key"
            style={{ left: ticksToSeconds(time) * pps }}
            onPointerDown={(event) => begin(event, mark)}
            onContextMenu={(event) => openMenu(event, mark)}
            onDoubleClick={(event) => event.stopPropagation()}
            data-tooltip={
              isDragged
                ? undefined
                : valuesOf(mark.keys)
                    .map(({ label }) => label)
                    .join(', ')
            }
            data-keyframe
          >
            {isDragged && (
              <span className="absolute bottom-full mb-1 px-1.5 py-0.5 rounded-sm bg-surface text-[10px] text-text-primary tabular-nums whitespace-nowrap shadow-md pointer-events-none">
                {formatTimecode(item.start + time, fps)}
              </span>
            )}
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
