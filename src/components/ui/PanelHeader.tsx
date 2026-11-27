import { ReactNode } from 'react';
import Text from './Text';
import { TextVariants } from '../../types/typography';

interface PanelHeaderProps {
  title: ReactNode;
  chip?: ReactNode;
  children?: ReactNode;
}

export default function PanelHeader({ title, chip, children }: PanelHeaderProps) {
  return (
    <div className="box-content h-8.5 p-3 flex items-center gap-2 shrink-0 border-b border-surface">
      {typeof title === 'string' ? (
        <Text variant={TextVariants.title} className="shrink-0 whitespace-nowrap">
          {title}
        </Text>
      ) : (
        title
      )}
      {chip !== undefined && (
        <div className="@container flex-1 min-w-0 flex items-center justify-end pl-0.5">{chip}</div>
      )}
      {children && <div className="ml-auto flex items-center gap-1 shrink-0">{children}</div>}
    </div>
  );
}
