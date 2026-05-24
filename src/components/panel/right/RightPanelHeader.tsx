import { type ReactNode } from 'react';
import clsx, { type ClassValue } from 'clsx';
import Text from '../../ui/Text';
import { UiMode } from '../../ui/AppProperties';
import { TextVariants } from '../../../types/typography';
import { useSettingsStore } from '../../../store/useSettingsStore';

interface RightPanelHeaderProps {
  children?: ReactNode | ((isCompact: boolean) => ReactNode);
  title: string;
}

export const rightPanelHeaderActionClassName = (isCompact: boolean, ...className: ClassValue[]) =>
  clsx(isCompact ? 'p-1' : 'p-2', 'transition-colors', className);

export default function RightPanelHeader({ children, title }: RightPanelHeaderProps) {
  const isCompact = useSettingsStore((state) => state.appSettings?.uiMode === UiMode.Compact);

  return (
    <div
      className={clsx(
        'flex justify-between items-center shrink-0 border-b border-surface',
        isCompact ? 'px-3 py-2' : 'p-4',
      )}
    >
      <Text variant={TextVariants.title}>{title}</Text>
      {typeof children === 'function' ? children(isCompact) : children}
    </div>
  );
}
