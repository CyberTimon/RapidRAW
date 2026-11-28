import { ReactNode } from 'react';
import clsx from 'clsx';
import Text from '../../ui/Text';
import { TextColors, TextVariants, VariantConfig } from '../../../types/typography';

interface TooltipLabelProps {
  children: ReactNode;
  tooltip?: string | null;
}

interface SettingItemProps {
  children?: ReactNode;
  description?: string | null;
  inline?: boolean;
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

export const settingTitle: VariantConfig = { ...TextVariants.heading, size: 'text-[15px]', defaultWeight: 'medium' };

export const TooltipLabel = ({ children, tooltip }: TooltipLabelProps) => (
  <span className={clsx(tooltip && 'cursor-help')} data-tooltip={tooltip || undefined}>
    {children}
  </span>
);

export const SettingsSection = ({ children, description, title, tooltip }: SettingsSectionProps) => (
  <div className="p-6 bg-surface rounded-xl shadow-md">
    <Text variant={TextVariants.title} color={TextColors.accent} className="mb-5">
      <TooltipLabel tooltip={tooltip}>{title}</TooltipLabel>
    </Text>
    {description && <Text className="mb-5">{description}</Text>}
    {children}
  </div>
);

export default function SettingItem({
  children,
  description,
  inline,
  label,
  status,
  statusAction,
  tooltip,
}: SettingItemProps) {
  const title = <TooltipLabel tooltip={tooltip}>{label}</TooltipLabel>;
  const textGap = inline ? 'mt-1' : clsx(children && 'mt-2');

  return (
    <div>
      {inline ? (
        <label className="flex items-center justify-between gap-4">
          <Text as="span" variant={settingTitle}>
            {title}
          </Text>
          {children}
        </label>
      ) : (
        <>
          <Text variant={settingTitle} className="block mb-2">
            {title}
          </Text>
          {children}
        </>
      )}
      {description && (
        <Text variant={TextVariants.small} className={textGap}>
          {description}
        </Text>
      )}
      {status && (
        <Text variant={TextVariants.small} className={description ? 'mt-1' : textGap}>
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
