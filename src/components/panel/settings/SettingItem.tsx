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
  stacked?: boolean;
  status?: string | null;
  statusAction?: { label: string; onClick(): void } | null;
  wide?: boolean;
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
  stacked,
  status,
  statusAction,
  wide,
}: SettingItemProps) {
  const heading = (
    <span className="block min-w-0">
      <Text as="span" variant={settingTitle} className="block">
        {label}
      </Text>
      {description && (
        <Text as="span" variant={TextVariants.small} className="block mt-0.5">
          {description}
        </Text>
      )}
    </span>
  );

  const fullWidth = !!(stacked && children);

  return (
    <div>
      {inline ? (
        <label className="flex items-center justify-between gap-6">
          {heading}
          {children}
        </label>
      ) : fullWidth || !children ? (
        <>
          <div className={clsx(fullWidth && 'mb-2.5')}>{heading}</div>
          {children}
        </>
      ) : (
        <div className="@container">
          <div className="flex flex-col gap-2.5 @xl:flex-row @xl:items-center @xl:justify-between @xl:gap-6">
            {heading}
            <div className={clsx('shrink-0 *:mb-0', wide ? '@xl:w-96' : '@xl:w-72')}>{children}</div>
          </div>
        </div>
      )}
      {status && (
        <Text variant={TextVariants.small} className={fullWidth ? 'mt-2' : 'mt-1'}>
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
