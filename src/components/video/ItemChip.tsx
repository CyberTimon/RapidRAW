import { ReactNode } from 'react';
import clsx from 'clsx';
import { type LucideIcon } from 'lucide-react';
import Text from '../ui/Text';
import { TextColors, TextVariants } from '../../types/typography';

export function ItemChip({
  icon: Icon,
  label,
  tooltip = label,
  children,
}: {
  icon?: LucideIcon;
  label: string;
  tooltip?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={clsx(
        'min-w-0 flex items-center gap-1.5 h-8.5 px-3 rounded-full bg-surface',
        !Icon && '@max-[8rem]:hidden',
      )}
      data-tooltip={tooltip}
    >
      {Icon && <Icon size={13} className="shrink-0 text-text-secondary" />}
      <Text
        as="span"
        variant={TextVariants.small}
        color={TextColors.primary}
        className="min-w-0 truncate @max-[8rem]:hidden"
      >
        {label}
      </Text>
      {children}
    </div>
  );
}
