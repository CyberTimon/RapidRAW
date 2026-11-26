import { ReactNode } from 'react';
import clsx from 'clsx';
import Text from '../../ui/Text';
import { TextColors, TextVariants } from '../../../types/typography';

interface TooltipLabelProps {
  children: ReactNode;
  tooltip?: string | null;
}

interface SettingItemProps {
  children?: ReactNode;
  description?: string | null;
  label: string;
  status?: string | null;
  statusAction?: { label: string; onClick(): void } | null;
  tooltip?: string | null;
}

interface SettingsSectionProps {
  children: ReactNode;
  description?: string;
  title: string;
  tooltip?: string;
}

export const TooltipLabel = ({ children, tooltip }: TooltipLabelProps) => (
  <span
    className={clsx(
      tooltip && 'cursor-help underline decoration-dotted decoration-text-secondary/50 underline-offset-4',
    )}
    data-tooltip={tooltip || undefined}
  >
    {children}
  </span>
);

export const SettingsSection = ({ children, description, title, tooltip }: SettingsSectionProps) => (
  <div className="p-6 bg-surface rounded-xl shadow-md">
    <Text variant={TextVariants.title} color={TextColors.accent} className="mb-5">
      <TooltipLabel tooltip={tooltip}>{title}</TooltipLabel>
    </Text>
    {description && <Text className="mb-6">{description}</Text>}
    {children}
  </div>
);

export default function SettingItem({ children, description, label, status, statusAction, tooltip }: SettingItemProps) {
  return (
    <div>
      <Text variant={TextVariants.heading} className="block mb-2">
        <TooltipLabel tooltip={tooltip}>{label}</TooltipLabel>
      </Text>
      {children}
      {description && (
        <Text variant={TextVariants.small} className={clsx(children && 'mt-2')}>
          {description}
        </Text>
      )}
      {status && (
        <Text variant={TextVariants.small} className={description ? 'mt-1' : clsx(children && 'mt-2')}>
          {status}
          {statusAction && (
            <>
              {' '}
              <button className="text-accent hover:underline focus:outline-none" onClick={statusAction.onClick}>
                {statusAction.label}
              </button>
            </>
          )}
        </Text>
      )}
    </div>
  );
}
