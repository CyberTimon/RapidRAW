import { memo, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { ClipItem, Ticks } from '../../../types/video';
import { useContextMenu } from '../../../context/ContextMenuContext';
import { transitionMenu } from '../../../store/videoEffects';
import { TRANSITION_ICONS } from '../../../utils/video/effectRegistry';
import { formatDuration, ticksToSeconds } from '../../../utils/video/time';
import { timeToX } from './layout';

const MIN_WIDTH = 18;
const LABEL_WIDTH = 64;
const SIDES = [-1, 1];

const markerWidth = (overlap: Ticks, pps: number) => Math.max(MIN_WIDTH, ticksToSeconds(overlap) * pps);

export const transitionCover = (overlap: Ticks, pps: number) =>
  overlap > 0 ? (ticksToSeconds(overlap) * pps + markerWidth(overlap, pps)) / 2 : 0;

interface TransitionMarkerProps {
  item: ClipItem;
  overlap: Ticks;
  pps: number;
  isSelected: boolean;
  isTarget: boolean;
  onSelect(id: string): void;
  onResize(event: ReactPointerEvent, item: ClipItem, side: number): void;
}

export default memo(function TransitionMarker({
  item,
  overlap,
  pps,
  isSelected,
  isTarget,
  onSelect,
  onResize,
}: TransitionMarkerProps) {
  const { t } = useTranslation();
  const { showContextMenu } = useContextMenu();
  const transition = item.transitionIn;
  if (!transition) return null;
  const Icon = TRANSITION_ICONS[transition.kind];
  const width = markerWidth(overlap, pps);
  const label = formatDuration(overlap);

  const openMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onSelect(item.id);
    showContextMenu(event.clientX, event.clientY, transitionMenu([item]));
  };

  const tooltip = `${t(`video.transitions.${transition.kind}`)} · ${label}`;
  const select = (event: ReactPointerEvent) => {
    event.stopPropagation();
    onSelect(item.id);
  };

  return (
    <div
      className={clsx(
        'group/transition absolute top-0 bottom-0 z-20 -translate-x-1/2 rounded-md overflow-hidden pointer-events-none',
        'ring-inset transition-shadow',
        isTarget
          ? 'bg-accent/35 ring-2 ring-accent shadow-lg shadow-black/40'
          : 'bg-linear-to-r from-black/55 via-black/20 to-black/55 backdrop-blur-[1px]',
        !isTarget && (isSelected ? 'ring-2 ring-accent' : 'ring-1 ring-white/30 hover:ring-white/60'),
      )}
      style={{ left: timeToX(item.start + overlap / 2, pps), width }}
    >
      {SIDES.map((side) => (
        <div
          key={`select${side}`}
          className={clsx(
            'absolute top-0 bottom-0 cursor-pointer pointer-events-auto',
            side < 0 ? 'left-1.5 right-[calc(50%+6px)]' : 'left-[calc(50%+6px)] right-1.5',
          )}
          onPointerDown={select}
          onContextMenu={openMenu}
          data-tooltip={tooltip}
        />
      ))}
      <svg className="absolute inset-0 w-full h-full pointer-events-none" preserveAspectRatio="none" viewBox="0 0 1 1">
        <line
          x1="0"
          y1="1"
          x2="1"
          y2="0"
          stroke="white"
          strokeOpacity="0.35"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="relative h-full flex items-center justify-center gap-1 px-1 text-white pointer-events-none">
        <Icon size={12} className="shrink-0 drop-shadow" />
        {width >= LABEL_WIDTH && <span className="text-[10px] font-medium tabular-nums drop-shadow">{label}</span>}
      </div>
      {SIDES.map((side) => (
        <div
          key={side}
          className={clsx(
            'absolute top-0 bottom-0 w-1.5 cursor-ew-resize pointer-events-auto opacity-0 group-hover/transition:opacity-100 bg-white/40',
            side < 0 ? 'left-0' : 'right-0',
          )}
          onPointerDown={(event) => onResize(event, item, side)}
        />
      ))}
    </div>
  );
});
