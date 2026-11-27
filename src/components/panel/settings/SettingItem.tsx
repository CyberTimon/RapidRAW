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
  label: string;
  status?: string | null;
  statusAction?: { label: string; onClick(): void } | null;
  tooltip?: string | null;
}

interface SettingsSectionProps {
  children: ReactNode;
  title: string;
  tooltip?: string;
}

export const TooltipLabel = ({ children, tooltip }: TooltipLabelProps) => (
  <span className={clsx(tooltip && 'cursor-help')} data-tooltip={tooltip || undefined}>
    {children}
  </span>
);

export const SettingsSection = ({ children, title, tooltip }: SettingsSectionProps) => (
  <div className="p-6 bg-surface rounded-xl shadow-md">
    <Text variant={TextVariants.title} color={TextColors.accent} className="mb-5">
      <TooltipLabel tooltip={tooltip}>{title}</TooltipLabel>
    </Text>
    {children}
  </div>
);

export default function SettingItem({ children, label, status, statusAction, tooltip }: SettingItemProps) {
  return (
    <div>
      <Text variant={TextVariants.heading} className="block mb-2">
        <TooltipLabel tooltip={tooltip}>{label}</TooltipLabel>
      </Text>
      {children}
      {status && (
        <Text variant={TextVariants.small} className={clsx(children && 'mt-2')}>
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
