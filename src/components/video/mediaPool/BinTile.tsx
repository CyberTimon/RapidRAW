import { memo, useCallback, useRef, useState, type MouseEvent } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { Folder, FolderOpen } from 'lucide-react';
import Text from '../../ui/Text';
import { TextVariants } from '../../../types/typography';
import { BIN_DRAG, BIN_DRAG_PREFIX, BIN_TARGET, acceptsBinDrop } from './poolDrag';

interface BinTileProps {
  id: string | null;
  name: string;
  count: number;
  isEditing: boolean;
  onOpen(id: string): void;
  onMenu(event: MouseEvent, id: string): void;
  onRename(id: string | null, name: string | null): void;
  onStartRename(id: string): void;
}

const stop = (event: { stopPropagation(): void }) => event.stopPropagation();

function BinName({ initial, onDone }: { initial: string; onDone(name: string | null): void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initial);
  const cancelled = useRef(false);
  return (
    <input
      autoFocus
      className="w-full min-w-0 h-5 -my-0.5 -mx-0.5 px-1 rounded-sm bg-bg-primary text-xs text-text-primary ring-1 ring-accent focus:outline-hidden"
      value={value}
      placeholder={t('video.mediaPool.newBin')}
      spellCheck={false}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => onDone(cancelled.current ? null : value.trim())}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          cancelled.current = true;
          event.currentTarget.blur();
        }
      }}
      onPointerDown={stop}
      onClick={stop}
      onDoubleClick={stop}
    />
  );
}

function BinTile({ id, name, count, isEditing, onOpen, onMenu, onRename, onStartRename }: BinTileProps) {
  const { t } = useTranslation();
  const key = id ?? 'draft';
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: `${BIN_DRAG_PREFIX}${key}`,
    data: { type: BIN_DRAG, bin: id, label: name, icon: Folder },
    disabled: !id || isEditing,
  });
  const {
    setNodeRef: setDropRef,
    isOver,
    active,
  } = useDroppable({
    id: `${BIN_TARGET}:${key}`,
    data: { type: BIN_TARGET, bin: id },
    disabled: !id,
  });
  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      setDragRef(node);
      setDropRef(node);
    },
    [setDragRef, setDropRef],
  );
  const isTarget = isOver && !!id && acceptsBinDrop(active, id);
  const Icon = isTarget ? FolderOpen : Folder;

  return (
    <div
      ref={setRefs}
      {...(isEditing ? {} : listeners)}
      {...attributes}
      className={clsx(
        'group flex flex-col gap-1 min-w-0 rounded-md outline-hidden cursor-pointer',
        isDragging && 'opacity-40',
      )}
      onDoubleClick={() => id && !isEditing && onOpen(id)}
      onKeyDown={(event) => {
        if (!id || isEditing || event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== 'F2') return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Enter') onOpen(id);
        else onStartRename(id);
      }}
      onContextMenu={(event) => {
        if (id) onMenu(event, id);
        else {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      data-tooltip={isEditing ? undefined : name}
    >
      <div
        className={clsx(
          'relative aspect-video rounded-md bg-surface flex items-center justify-center transition-shadow',
          'group-focus:outline group-focus:outline-offset-2 group-focus:outline-text-secondary/60',
          isTarget ? 'ring-2 ring-accent' : 'ring-1 ring-transparent group-hover:ring-border-color',
        )}
      >
        <Icon
          strokeWidth={1.5}
          className={clsx(
            'h-[42%] w-auto transition-[transform,color] duration-300',
            isTarget ? 'text-accent scale-110' : 'text-text-secondary group-hover:scale-[1.06]',
          )}
        />
        {count > 0 && (
          <span
            className="absolute bottom-1 left-1 px-1.5 rounded-full text-[10px] leading-4 tabular-nums bg-bg-primary/80 text-text-secondary"
            data-tooltip={t('video.mediaPool.itemCount', { count })}
          >
            {count}
          </span>
        )}
      </div>
      <div className="flex items-center h-4 px-0.5 min-w-0">
        {isEditing ? (
          <BinName initial={name} onDone={(value) => onRename(id, value)} />
        ) : (
          <Text variant={TextVariants.small} className="truncate leading-4">
            {name}
          </Text>
        )}
      </div>
    </div>
  );
}

export default memo(BinTile);
