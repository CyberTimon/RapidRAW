import { memo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { Merge, Pencil, Scissors, Trash2 } from 'lucide-react';
import { OPTION_SEPARATOR } from '../../../types/ui';
import { Caption, Captions, FrameRate, Ticks } from '../../../types/video';
import { useContextMenu } from '../../../context/ContextMenuContext';
import { getVideo, setVideo, useVideoStore } from '../../../store/useVideoStore';
import { editCaptionItems, editCaptionText, selectCaption } from '../../../store/videoCaptions';
import { captionLimits, mergeWithNext, splitCaption } from '../../../utils/video/captions';
import { minItemDuration } from '../../../utils/video/edit';
import { snapTicks } from '../../../utils/video/time';
import { alignHaptic } from '../../../utils/haptics';
import { spanBox } from './layout';
import { dragStarted, usePointerDrag } from './gestures';
import { nearest, snapTargets, snapTolerance } from './snapping';

type Mode = 'move' | 'start' | 'end';

interface Drag {
  id: string;
  mode: Mode;
  startX: number;
  grab: Ticks;
  moved: boolean;
  items: Array<Caption> | null;
}

export default memo(function CaptionLane({
  captions,
  fps,
  pps,
  top,
  height,
  timeAt,
  onSnap,
}: {
  captions: Captions | null;
  fps: FrameRate;
  pps: number;
  top: number;
  height: number;
  timeAt(clientX: number): Ticks;
  onSnap(snap: Ticks | null): void;
}) {
  const { t } = useTranslation();
  const { showContextMenu } = useContextMenu();
  const selection = useVideoStore((s) => s.selection);
  const [draft, setDraft] = useState<Array<Caption> | null>(null);
  const drag = useRef<Drag | null>(null);
  const minimum = minItemDuration(fps);
  const items = draft ?? captions?.items ?? [];

  const dragged = (current: Drag, clientX: number) => {
    const source = captions?.items ?? [];
    const caption = source.find((item) => item.id === current.id);
    const { project } = getVideo();
    if (!caption || !project) return { items: source, snap: null };
    const { earliest, latest } = captionLimits(source, current.id);
    const targets = snapTargets(project, current.id);
    const snap = (time: Ticks) => nearest(snapTicks(Math.max(0, time), fps), targets, snapTolerance(pps));
    const end = caption.start + caption.duration;
    let next: Caption;
    if (current.mode === 'move') {
      const raw = snap(timeAt(clientX) - current.grab);
      const byEnd = snap(raw + caption.duration) - caption.duration;
      const start = Math.min(latest - caption.duration, Math.max(earliest, raw !== byEnd ? byEnd : raw));
      next = { ...caption, start: Math.max(earliest, start) };
    } else if (current.mode === 'start') {
      const start = Math.min(end - minimum, Math.max(earliest, snap(timeAt(clientX))));
      next = { ...caption, start, duration: end - start };
    } else {
      const finish = Math.max(caption.start + minimum, Math.min(latest, snap(timeAt(clientX))));
      next = { ...caption, duration: finish - caption.start };
    }
    const edges = {
      move: [next.start, next.start + next.duration],
      start: [next.start],
      end: [next.start + next.duration],
    }[current.mode];
    const aligned = (time: Ticks) => targets.includes(time) && time;
    alignHaptic(current, aligned(next.start), aligned(next.start + next.duration));
    return {
      items: source.map((item) => (item.id === current.id ? next : item)),
      snap: edges.find((time) => targets.includes(time)) ?? null,
    };
  };

  const finish = () => {
    drag.current = null;
    setDraft(null);
    onSnap(null);
  };

  const startDrag = usePointerDrag({
    move: (event) => {
      const current = drag.current;
      if (!current || !dragStarted(current, event.clientX)) return;
      const next = dragged(current, event.clientX);
      current.items = next.items;
      setDraft(next.items);
      onSnap(next.snap);
    },
    end: () => {
      const current = drag.current;
      finish();
      if (!current) return;
      if (current.moved && current.items) {
        const committed = current.items;
        editCaptionItems(() => committed);
        return;
      }
      const caption = captions?.items.find((item) => item.id === current.id);
      if (!current.moved && caption) selectCaption(caption);
    },
    cancel: finish,
  });

  const begin = (event: ReactPointerEvent, caption: Caption, mode: Mode) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    drag.current = {
      id: caption.id,
      mode,
      startX: event.clientX,
      grab: timeAt(event.clientX) - caption.start,
      moved: false,
      items: null,
    };
    startDrag(event);
  };

  const openMenu = (event: React.MouseEvent, caption: Caption) => {
    event.preventDefault();
    event.stopPropagation();
    setVideo({ selection: [caption.id] });
    const playhead = useVideoStore.getState().playhead;
    const canSplit = playhead - caption.start >= minimum && caption.start + caption.duration - playhead >= minimum;
    showContextMenu(event.clientX, event.clientY, [
      { icon: Pencil, label: t('video.captions.editText'), onClick: () => editCaptionText(caption) },
      {
        icon: Scissors,
        label: t('video.timeline.split'),
        disabled: !canSplit,
        onClick: () => editCaptionItems((list) => splitCaption(list, caption.id, playhead, minimum)),
      },
      {
        icon: Merge,
        label: t('video.captions.mergeWithNext'),
        disabled: captionLimits(items, caption.id).latest === Number.POSITIVE_INFINITY,
        onClick: () => editCaptionItems((list) => mergeWithNext(list, caption.id)),
      },
      { type: OPTION_SEPARATOR },
      {
        icon: Trash2,
        label: t('video.captions.delete'),
        isDestructive: true,
        onClick: () => editCaptionItems((list) => list.filter((item) => item.id !== caption.id)),
        shortcut: 'video_delete',
      },
    ]);
  };

  return (
    <div
      className={clsx('absolute left-0 right-0 rounded-md bg-bg-primary/30', !captions?.enabled && 'opacity-40')}
      style={{ top, height }}
      data-lane
    >
      {items.map((caption) => {
        const box = spanBox(caption.start, caption.start + caption.duration, pps);
        const isSelected = selection.includes(caption.id);
        return (
          <div
            key={caption.id}
            className={clsx(
              'group absolute top-0 bottom-0 rounded-md bg-amber-500/30 cursor-grab active:cursor-grabbing select-none',
              isSelected ? 'ring-2 ring-accent z-10' : 'ring-1 ring-black/30 hover:ring-text-secondary/60',
            )}
            style={{ left: box.left, width: Math.max(4, box.width) }}
            onPointerDown={(event) => begin(event, caption, 'move')}
            onDoubleClick={(event) => {
              event.stopPropagation();
              editCaptionText(caption);
            }}
            onContextMenu={(event) => openMenu(event, caption)}
            data-tooltip={caption.text}
          >
            <span className="absolute inset-0 px-1.5 flex items-center text-[10px] leading-tight text-text-primary truncate pointer-events-none">
              {caption.text.replace(/\n/g, ' ')}
            </span>
            {(['start', 'end'] as const).map((edge) => (
              <div
                key={edge}
                className={clsx(
                  'absolute top-0 bottom-0 w-2 z-20 cursor-ew-resize opacity-0 group-hover:opacity-100 flex items-center justify-center',
                  edge === 'start' ? 'left-0' : 'right-0',
                )}
                onPointerDown={(event) => begin(event, caption, edge)}
              >
                <div className="w-1 h-1/2 rounded-full bg-white/80 shadow" />
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
});
