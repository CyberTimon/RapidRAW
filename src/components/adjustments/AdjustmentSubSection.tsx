import { ReactNode, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { useShallow } from 'zustand/react/shallow';
import Text from '../ui/Text';
import VisibilityToggle, { HIDDEN_CONTENT_CLASS } from '../ui/VisibilityToggle';
import { TextVariants } from '../../types/typography';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useCollapsibleHeight } from '../../hooks/useCollapsibleHeight';
import { useToolVisibility } from '../../context/ToolVisibilityContext';
import { withToolCollapsed } from '../../utils/adjustments';

interface AdjustmentSubSectionProps {
  actions?: ReactNode;
  children: ReactNode | ((expanded: boolean) => ReactNode);
  initiallyCollapsed?: boolean;
  id: string;
  order: number;
  title: string;
}

export default function AdjustmentSubSection({
  actions,
  children,
  id,
  order,
  title,
  initiallyCollapsed = false,
}: AdjustmentSubSectionProps) {
  const visibility = useToolVisibility(id);
  const { appSettings, handleSettingsChange } = useSettingsStore(
    useShallow((state) => ({
      appSettings: state.appSettings,
      handleSettingsChange: state.handleSettingsChange,
    })),
  );

  const collapsedTools = appSettings?.adjustmentLayout?.collapsedTools ?? [];
  // Expensive, opt-in tools should not start analyzing images just because
  // their parent section was opened. Treat the first explicit expansion as
  // the activation point; other tools keep their existing saved behavior.
  const [hasBeenExpanded, setHasBeenExpanded] = useState(false);
  const isCollapsed = collapsedTools.includes(id) || (initiallyCollapsed && !hasBeenExpanded);
  const { contentRef, wrapperRef } = useCollapsibleHeight(!isCollapsed);

  const handleToggle = () => {
    if (!appSettings) {
      return;
    }
    if (initiallyCollapsed && isCollapsed) setHasBeenExpanded(true);
    handleSettingsChange(withToolCollapsed(appSettings, id, !isCollapsed));
  };

  return (
    <div className="p-1 bg-bg-tertiary rounded-md" style={{ order }}>
      <div className="group/visibility flex items-center gap-2 cursor-pointer select-none" onClick={handleToggle}>
        <Text variant={TextVariants.heading} className={clsx(!visibility && 'grow')}>
          {title}
        </Text>
        {visibility && (
          <div className="grow flex items-center">
            <VisibilityToggle isVisible={visibility.isVisible} onToggle={visibility.toggle} revealOnHover />
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
          className={clsx('pt-2 transition-opacity duration-300', visibility?.isDimmed && HIDDEN_CONTENT_CLASS)}
          ref={contentRef}
        >
          {typeof children === 'function' ? children(!isCollapsed) : children}
        </div>
      </div>
    </div>
  );
}
