import { ReactNode } from 'react';
import clsx from 'clsx';
import { useDroppable } from '@dnd-kit/core';
import { LucideIcon, MoveRight } from 'lucide-react';
import Text from '../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';
import { useUIStore } from '../../store/useUIStore';

export default function ImmichRow({
  icon,
  label,
  count,
  showCount = false,
  dropId,
  isSelected,
  onSelect,
  tooltip,
  trailing,
}: {
  icon: LucideIcon;
  label: string;
  count?: number;
  showCount?: boolean;
  dropId?: string;
  isSelected: boolean;
  onSelect(): void;
  tooltip?: string;
  trailing?: ReactNode;
}) {
  const isLayoutDragging = useUIStore((state) => !!state.activeLayoutDragItem);
  const { setNodeRef, isOver, active } = useDroppable({
    id: `album-immich-${dropId ?? label}`,
    data: { type: 'album', id: dropId },
    disabled: !dropId || isLayoutDragging,
  });
  const isDropTarget = !!dropId && isOver && active?.data?.current?.type === 'library-image';
  const Icon = isDropTarget ? MoveRight : icon;

  return (
    <Text as="div" color={TextColors.primary} weight={TextWeights.medium}>
      <div
        ref={setNodeRef}
        className={clsx('flex items-center gap-2 p-1.5 rounded-md transition-colors cursor-pointer', {
          'bg-surface': isSelected && !isDropTarget,
          'hover:bg-card-active': !isSelected && !isDropTarget,
          'bg-accent/20': isDropTarget,
        })}
        onClick={onSelect}
        data-tooltip={tooltip}
      >
        <div className="w-5 h-5 flex items-center justify-center p-0.5 rounded-sm text-text-secondary shrink-0">
          <Icon size={16} />
        </div>
        <span className="min-w-0 flex-1 select-none">
          <span className="block truncate">{label}</span>
        </span>
        {count !== undefined && (
          <Text
            as="span"
            variant={TextVariants.small}
            color={TextColors.secondary}
            className={clsx(
              'ml-auto min-w-8 shrink-0 text-right tabular-nums transition-opacity ease-in-out duration-300',
              showCount ? 'opacity-100' : 'opacity-0',
            )}
          >
            {count}
          </Text>
        )}
        <div className="w-5 h-5 shrink-0 flex items-center justify-center text-text-secondary" aria-hidden="true">
          {trailing}
        </div>
      </div>
    </Text>
  );
}
