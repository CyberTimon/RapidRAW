import { memo } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { MediaBin } from '../../../types/video';
import { BIN_TARGET, acceptsBinDrop } from './poolDrag';

interface PathSegmentProps {
  id: string | null;
  name: string;
  isCurrent: boolean;
  onOpen(id: string | null): void;
}

function PathSegment({ id, name, isCurrent, onOpen }: PathSegmentProps) {
  const { setNodeRef, isOver, active } = useDroppable({
    id: `media-pool-path:${id ?? 'root'}`,
    data: { type: BIN_TARGET, bin: id },
    disabled: isCurrent,
  });
  const isTarget = isOver && !isCurrent && acceptsBinDrop(active, id);
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={clsx(
        'truncate max-w-32 px-1 rounded text-xs transition-[color,box-shadow]',
        isCurrent || isTarget ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary',
        isTarget && 'ring-2 ring-accent',
      )}
      disabled={isCurrent}
      onClick={() => onOpen(id)}
      data-tooltip={isCurrent ? undefined : name}
    >
      {name}
    </button>
  );
}

function PoolPath({ path, onOpen }: { path: Array<MediaBin>; onOpen(id: string | null): void }) {
  const { t } = useTranslation();
  const segments = [{ id: null, name: t('video.project.media') }, ...path];
  const parent = segments.at(-2)?.id ?? null;
  return (
    <div className="flex items-center gap-0.5 min-w-0 overflow-hidden px-2 pb-1.5 shrink-0">
      <button
        type="button"
        className="h-6 w-6 shrink-0 flex items-center justify-center rounded-md text-text-secondary hover:bg-surface hover:text-text-primary transition-colors"
        onClick={() => onOpen(parent)}
        data-tooltip={t('video.nesting.back')}
        aria-label={t('video.nesting.back')}
      >
        <ChevronLeft size={14} />
      </button>
      {segments.map((segment, index) => (
        <div key={segment.id ?? 'root'} className="flex items-center gap-0.5 min-w-0">
          {index > 0 && <ChevronRight size={12} className="shrink-0 text-text-secondary" />}
          <PathSegment id={segment.id} name={segment.name} isCurrent={index === segments.length - 1} onOpen={onOpen} />
        </div>
      ))}
    </div>
  );
}

export default memo(PoolPath);
