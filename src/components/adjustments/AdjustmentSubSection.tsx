import { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { useShallow } from 'zustand/react/shallow';
import Text from '../ui/Text';
import VisibilityToggle from '../ui/VisibilityToggle';
import { TextVariants } from '../../types/typography';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useCollapsibleHeight } from '../../hooks/useCollapsibleHeight';
import { ADJUSTMENT_SECTION_TOOLS, getAdjustmentSectionToolIds, withAdjustmentLayout } from '../../utils/adjustments';

interface AdjustmentSubSectionProps {
  actions?: ReactNode;
  children: ReactNode;
  id: string;
  isContentVisible?: boolean;
  onToggleVisibility?: () => void;
  order: number;
  title: string;
}

export default function AdjustmentSubSection({
  actions,
  children,
  id,
  isContentVisible = true,
  onToggleVisibility,
  order,
  title,
}: AdjustmentSubSectionProps) {
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
    const siblingTools = appSettings.enableToolFocusMode
      ? (Object.keys(ADJUSTMENT_SECTION_TOOLS)
          .map(getAdjustmentSectionToolIds)
          .find((tools) => tools.includes(id)) ?? [])
      : [];
    handleSettingsChange(
      withAdjustmentLayout(appSettings, {
        collapsedTools: isCollapsed
          ? [...new Set([...collapsedTools, ...siblingTools])].filter((tool) => tool !== id)
          : [...collapsedTools, id],
      }),
    );
  };

  return (
    <div className="p-1 bg-bg-tertiary rounded-md" style={{ order }}>
      <div className="group/tool flex items-center gap-2 cursor-pointer select-none" onClick={handleToggle}>
        <Text variant={TextVariants.heading} className={clsx(!onToggleVisibility && 'grow')}>
          {title}
        </Text>
        {onToggleVisibility && (
          <div className="grow flex items-center">
            <VisibilityToggle
              className={clsx(
                isContentVisible &&
                  'opacity-0 pointer-events-none group-hover/tool:opacity-100 group-hover/tool:pointer-events-auto',
              )}
              isVisible={isContentVisible}
              onToggle={onToggleVisibility}
            />
          </div>
        )}
        {actions && <div onClick={(e) => e.stopPropagation()}>{actions}</div>}
        <ChevronDown
          className={clsx('text-text-secondary transition-transform duration-300', !isCollapsed && 'rotate-180')}
          size={16}
        />
      </div>
      <div ref={wrapperRef} className="overflow-hidden transition-all duration-300 ease-in-out">
        <div
          className={clsx(
            'pt-2 transition-opacity duration-300',
            !isContentVisible && 'opacity-30 pointer-events-none',
          )}
          ref={contentRef}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
