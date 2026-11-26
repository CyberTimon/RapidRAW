import { memo, type MouseEvent, type ReactNode } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import {
  AudioLines,
  Clapperboard,
  Gauge,
  Image as ImageIcon,
  Layers,
  Plus,
  Star,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import Text from '../../ui/Text';
import { TextColors, TextVariants } from '../../../types/typography';
import { ImageFlag } from '../../../types/library';
import { MediaKind, TimeRange } from '../../../types/video';
import { useProcessStore } from '../../../store/useProcessStore';
import { useVideoStore } from '../../../store/useVideoStore';
import { ProxyState } from '../../../store/videoProxies';
import { COLOR_LABELS } from '../../../utils/adjustments';
import { FLAG_ICONS } from '../../../utils/imageFlags';
import { mediaRangeWithin } from '../../../utils/video/edit';
import { fileName } from '../../../utils/video/model';
import { formatDuration, secondsToTicks } from '../../../utils/video/time';
import MediaSkim from './MediaSkim';
import { proxyLabel } from './proxyStatus';

const RING_RADIUS = 8;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

export const KIND_ICONS: Record<MediaKind, LucideIcon> = {
  video: Clapperboard,
  image: ImageIcon,
  audio: AudioLines,
  sequence: Layers,
};

export interface MediaTileProps {
  id: string;
  path: string;
  name?: string;
  kind: MediaKind;
  dragId: string;
  dragPaths?: Array<string>;
  tooltip?: string;
  isSelected?: boolean;
  isMissing?: boolean;
  isUsed?: boolean;
  proxy?: ProxyState;
  range?: TimeRange;
  rating?: number;
  flag?: ImageFlag | null;
  color?: string;
  onSelect?(id: string, event: MouseEvent): void;
  onActivate(id: string, path: string): void;
  onLocate?(id: string): void;
  onAdd(path: string): void;
  onMenu(event: MouseEvent, id: string, isMissing: boolean): void;
}

function Badge({ className, tooltip, children }: { className: string; tooltip?: string; children: ReactNode }) {
  return (
    <div
      className={clsx(
        'h-5 w-5 rounded-full flex items-center justify-center shadow-md shrink-0',
        !tooltip && 'pointer-events-none',
        className,
      )}
      data-tooltip={tooltip}
    >
      {children}
    </div>
  );
}

function ProxyBadge({ proxy }: { proxy: ProxyState }) {
  const tooltip = proxyLabel(proxy) ?? undefined;
  if (proxy.state === 'running') {
    return (
      <Badge className="bg-black/50" tooltip={tooltip}>
        <svg viewBox="0 0 20 20" className="h-5 w-5 -rotate-90">
          <circle cx="10" cy="10" r={RING_RADIUS} fill="none" strokeWidth="2" className="stroke-white/25" />
          <circle
            cx="10"
            cy="10"
            r={RING_RADIUS}
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            className="stroke-accent transition-[stroke-dashoffset]"
            strokeDasharray={RING_LENGTH}
            strokeDashoffset={RING_LENGTH * (1 - Math.min(1, Math.max(0, proxy.progress)))}
          />
        </svg>
      </Badge>
    );
  }
  return (
    <Badge className={proxy.state === 'ready' ? 'bg-accent' : 'bg-black/50'} tooltip={tooltip}>
      <Gauge size={11} className={proxy.state === 'ready' ? 'text-button-text' : 'text-white/70'} />
    </Badge>
  );
}

function MetadataBadge({ rating, flag, color }: { rating: number; flag: ImageFlag | null; color?: string }) {
  const label = COLOR_LABELS.find((entry) => entry.name === color);
  const shownRating = flag === ImageFlag.Reject ? 0 : rating;
  if (!label && shownRating <= 0 && !flag) return null;
  const FlagIcon = flag ? FLAG_ICONS[flag] : null;
  return (
    <div className="h-5 px-1.5 rounded-full flex items-center gap-1 bg-black/30 shadow-md pointer-events-none">
      {label && <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: label.color }} />}
      {shownRating > 0 && (
        <div className="flex items-center gap-0.5">
          <span className="text-[10px] leading-none tabular-nums text-white">{shownRating}</span>
          <Star size={10} className="text-white fill-white" />
        </div>
      )}
      {FlagIcon && <FlagIcon size={11} className={clsx('text-white', flag === ImageFlag.Pick && 'fill-white')} />}
    </div>
  );
}

function MediaTile({
  id,
  path,
  name = fileName(path),
  kind,
  dragId,
  dragPaths,
  tooltip,
  isSelected = false,
  isMissing = false,
  isUsed = false,
  proxy,
  range,
  rating = 0,
  flag = null,
  color,
  onSelect,
  onActivate,
  onLocate,
  onAdd,
  onMenu,
}: MediaTileProps) {
  const { t } = useTranslation();
  const thumbnail = useProcessStore((state) => (kind === 'audio' ? undefined : state.thumbnails[path]));
  const duration = useVideoStore((state) => (kind === 'image' ? 0 : (state.media[path]?.duration ?? 0)));
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: dragId,
    data: { type: 'library-image', path, paths: dragPaths ?? [path] },
    disabled: isMissing,
  });

  const KindIcon = KIND_ICONS[kind];
  const shownRange = mediaRangeWithin(range, secondsToTicks(duration));
  const isRejected = flag === ImageFlag.Reject;

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={clsx(
        'group flex flex-col gap-1 min-w-0 rounded-md outline-hidden',
        isMissing ? 'cursor-pointer' : 'cursor-grab',
        isDragging && 'opacity-40',
      )}
      onClick={(event) => onSelect?.(id, event)}
      onDoubleClick={() => (isMissing ? onLocate?.(id) : onActivate(id, path))}
      onContextMenu={(event) => onMenu(event, id, isMissing)}
      data-tooltip={tooltip ?? name}
      data-media-id={id}
    >
      <div
        className={clsx(
          'relative aspect-video rounded-md overflow-hidden bg-surface transition-shadow',
          'group-focus:outline group-focus:outline-offset-2 group-focus:outline-text-secondary/60',
          isSelected ? 'ring-2 ring-accent' : 'ring-1 ring-transparent group-hover:ring-border-color',
        )}
      >
        {thumbnail ? (
          <img
            src={thumbnail}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            className={clsx(
              'w-full h-full object-cover transition-[transform,opacity] duration-300 group-hover:scale-[1.03]',
              isMissing && 'opacity-40 grayscale',
              isRejected && !isMissing && 'opacity-40 group-hover:opacity-100',
            )}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <KindIcon
              size={kind === 'audio' ? 26 : 18}
              className={clsx(
                'text-text-secondary',
                (kind === 'video' || kind === 'image') && !isMissing && 'animate-pulse',
              )}
            />
          </div>
        )}
        {kind !== 'image' && !isMissing && <MediaSkim path={path} kind={kind} />}
        <Badge className="absolute top-1 left-1 bg-black/40">
          <KindIcon size={11} className="text-white" />
        </Badge>
        <div className="absolute top-1 right-1 flex items-center gap-1">
          <MetadataBadge rating={rating} flag={flag} color={color} />
          {isMissing ? (
            <Badge className="bg-red-500" tooltip={t('video.mediaPool.missing')}>
              <TriangleAlert size={11} className="text-white" />
            </Badge>
          ) : (
            proxy && proxy.state !== 'none' && <ProxyBadge proxy={proxy} />
          )}
        </div>
        {duration > 0 && (
          <span
            className={clsx(
              'absolute bottom-1 left-1 px-1.5 rounded-full text-[10px] leading-4 tabular-nums pointer-events-none',
              shownRange ? 'bg-accent text-button-text' : 'bg-black/50 text-white',
            )}
          >
            {formatDuration(shownRange ? shownRange.end - shownRange.start : secondsToTicks(duration))}
          </span>
        )}
        {!isMissing && (
          <button
            type="button"
            className="absolute bottom-1 right-1 h-6 w-6 rounded-full flex items-center justify-center bg-accent text-button-text shadow-md opacity-0 scale-90 group-hover:opacity-100 group-hover:scale-100 focus-visible:opacity-100 transition-all"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onAdd(path);
            }}
            onDoubleClick={(event) => event.stopPropagation()}
            data-tooltip={t('video.mediaPool.addToTimeline')}
            aria-label={t('video.mediaPool.addToTimeline')}
          >
            <Plus size={14} />
          </button>
        )}
      </div>
      <div className="flex items-center gap-1 h-4 px-0.5 min-w-0">
        <Text
          variant={TextVariants.small}
          color={isMissing ? TextColors.error : isSelected ? TextColors.primary : TextColors.secondary}
          className="truncate leading-4"
        >
          {name}
        </Text>
        {isUsed && (
          <span
            className="ml-auto -mr-1 p-1 shrink-0"
            data-tooltip={t('video.mediaPool.used')}
            aria-label={t('video.mediaPool.used')}
          >
            <span className="block h-1.5 w-1.5 rounded-full bg-accent" />
          </span>
        )}
      </div>
    </div>
  );
}

export default memo(MediaTile);

export function EmptyState({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-3 py-10 px-4">
      <Text color={TextColors.secondary}>{message}</Text>
      {children}
    </div>
  );
}
