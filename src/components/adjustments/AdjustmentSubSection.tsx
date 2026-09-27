import { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { useShallow } from 'zustand/react/shallow';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useCollapsibleHeight } from '../../hooks/useCollapsibleHeight';
import { withAdjustmentLayout } from '../../utils/adjustments';

interface AdjustmentSubSectionProps {
  actions?: ReactNode;
  children: ReactNode;
  id: string;
  order: number;
  title: string;
}

export default function AdjustmentSubSection({ actions, children, id, order, title }: AdjustmentSubSectionProps) {
  const { appSettings, handleSettingsChange } = useSettingsStore(
    useShallow((state) => ({
      appSettings: state.appSettings,
      handleSettingsChange: state.handleSettingsChange,
    })),
  );

  const collapsedTools = appSettings?.adjustmentLayout?.collapsedTools ?? [];
  const isCollapsed = collapsedTools.includes(id);
  const { contentRef, wrapperRef } = useCollapsibleHeight(!isCollapsed);

  const handleToggle = () => {
    if (!appSettings) {
      return;
    }
    handleSettingsChange(
      withAdjustmentLayout(appSettings, {
        collapsedTools: isCollapsed ? collapsedTools.filter((tool) => tool !== id) : [...collapsedTools, id],
      }),
    );
  };

  return (
    <div className="p-1 bg-bg-tertiary rounded-md" style={{ order }}>
      <div className="flex items-center gap-2 cursor-pointer select-none" onClick={handleToggle}>
        <Text variant={TextVariants.heading} className="grow">
          {title}
        </Text>
        {actions && <div onClick={(e) => e.stopPropagation()}>{actions}</div>}
        <ChevronDown
          className={clsx('text-text-secondary transition-transform duration-300', !isCollapsed && 'rotate-180')}
          size={16}
        />
      </div>
      <div ref={wrapperRef} className="overflow-hidden transition-all duration-300 ease-in-out">
        <div className="pt-2" ref={contentRef}>
          {children}
        </div>
      </div>
    </div>
  );
}
