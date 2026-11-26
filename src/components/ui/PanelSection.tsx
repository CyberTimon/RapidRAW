import type { ReactNode } from 'react';
import Text from './Text';
import { TextVariants } from '../../types/typography';

interface PanelSectionProps {
  children: ReactNode;
  title: string;
}

export default function PanelSection({ title, children }: PanelSectionProps) {
  return (
    <div>
      <Text variant={TextVariants.heading} className="mb-2">
        {title}
      </Text>
      <div className="space-y-2">{children}</div>
    </div>
  );
}
