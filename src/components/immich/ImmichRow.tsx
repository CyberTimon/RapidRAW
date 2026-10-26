import { ReactNode } from 'react';
import clsx from 'clsx';
import { LucideIcon } from 'lucide-react';
import Text from '../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';

export default function ImmichRow({
  icon: Icon,
  label,
  count,
  showCount = false,
  isSelected,
  onSelect,
  trailing,
}: {
  icon: LucideIcon;
  label: string;
  count?: number;
  showCount?: boolean;
  isSelected: boolean;
  onSelect(): void;
  trailing?: ReactNode;
}) {
  return (
    <Text as="div" color={TextColors.primary} weight={TextWeights.medium}>
      <div
        className={clsx('flex items-center gap-2 p-1.5 rounded-md transition-colors cursor-pointer', {
          'bg-surface': isSelected,
          'hover:bg-card-active': !isSelected,
        })}
        onClick={onSelect}
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
