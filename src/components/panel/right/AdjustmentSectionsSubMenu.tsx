import { useEffect, useMemo, useRef, useState } from 'react';
import { Reorder, useDragControls } from 'framer-motion';
import { ChevronDown, Eye, EyeOff, GripVertical, RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import { useShallow } from 'zustand/react/shallow';
import { AppSettings } from '../../ui/AppProperties';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { ADJUSTMENT_SECTIONS, ADJUSTMENT_SECTION_TOOLS, getAdjustmentSectionOrder } from '../../../utils/adjustments';

interface VisibilityToggleProps {
  isDisabled?: boolean;
  isHidden: boolean;
  onToggle(): void;
}

interface SectionRowProps {
  isExpanded: boolean;
  isHidden: boolean;
  isToggleDisabled: boolean;
  isToolHidden(tool: string): boolean;
  onDragEnd(): void;
  onToggle(): void;
  onToggleExpanded(): void;
  onToggleTool(tool: string): void;
  section: string;
}

const ALL_TOOLS = Object.values(ADJUSTMENT_SECTION_TOOLS).flat();

function VisibilityToggle({ isDisabled, isHidden, onToggle }: VisibilityToggleProps) {
  const { t } = useTranslation();

  return (
    <button
      className="p-1 rounded-full text-text-secondary hover:text-text-primary hover:bg-card-active disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      disabled={isDisabled}
      onClick={onToggle}
      data-tooltip={
        isHidden ? t('editor.adjustments.tooltips.showInPanel') : t('editor.adjustments.tooltips.hideFromPanel')
      }
    >
      {isHidden ? <EyeOff size={16} /> : <Eye size={16} />}
    </button>
  );
}

function SectionRow({
  isExpanded,
  isHidden,
  isToggleDisabled,
  isToolHidden,
  onDragEnd,
  onToggle,
  onToggleExpanded,
  onToggleTool,
  section,
}: SectionRowProps) {
  const { t } = useTranslation();
  const dragControls = useDragControls();
  const tools = ADJUSTMENT_SECTION_TOOLS[section] ?? [];

  return (
    <Reorder.Item
      as="div"
      className="rounded-md bg-surface"
      dragControls={dragControls}
      dragListener={false}
      layout="position"
      onDragEnd={onDragEnd}
      value={section}
    >
      <div className="flex items-center gap-1 pl-2 pr-1 rounded-md hover:bg-bg-primary transition-colors">
        <div
          className="flex items-center gap-2 grow min-w-0 py-2 cursor-grab active:cursor-grabbing touch-none select-none"
          onPointerDown={(e) => dragControls.start(e)}
        >
          <GripVertical size={16} className="shrink-0 text-text-secondary" />
          <span className={clsx('text-sm truncate', isHidden ? 'text-text-secondary' : 'text-text-primary')}>
            {t(`editor.adjustments.sections.${section}` as ParseKeys)}
          </span>
        </div>
        {tools.length > 0 && (
          <button
            className="p-1 rounded-full text-text-secondary hover:text-text-primary hover:bg-card-active transition-colors"
            onClick={onToggleExpanded}
          >
            <ChevronDown size={16} className={clsx('transition-transform duration-200', isExpanded && 'rotate-180')} />
          </button>
        )}
        <VisibilityToggle isDisabled={isToggleDisabled} isHidden={isHidden} onToggle={onToggle} />
      </div>
      {isExpanded &&
        tools.map((tool) => (
          <div
            className="flex items-center gap-1 pl-8 pr-1 rounded-md hover:bg-bg-primary transition-colors"
            key={tool.id}
          >
            <span
              className={clsx(
                'grow min-w-0 py-2 text-sm truncate',
                isHidden || isToolHidden(tool.id) ? 'text-text-secondary' : 'text-text-primary',
              )}
            >
              {t(tool.label as ParseKeys)}
            </span>
            <VisibilityToggle isHidden={isToolHidden(tool.id)} onToggle={() => onToggleTool(tool.id)} />
          </div>
        ))}
    </Reorder.Item>
  );
}

export default function AdjustmentSectionsSubMenu() {
  const { t } = useTranslation();

  const { appSettings, handleSettingsChange } = useSettingsStore(
    useShallow((state) => ({
      appSettings: state.appSettings,
      handleSettingsChange: state.handleSettingsChange,
    })),
  );

  const savedOrder = useMemo(
    () => getAdjustmentSectionOrder(appSettings?.adjustmentSectionOrder),
    [appSettings?.adjustmentSectionOrder],
  );
  const hiddenSections = appSettings?.hiddenAdjustmentSections ?? [];
  const adjustmentVisibility = appSettings?.adjustmentVisibility ?? {};
  const [order, setOrder] = useState(savedOrder);
  const [expandedSection, setExpandedSection] = useState<string | null>(null);
  const orderRef = useRef(savedOrder);

  useEffect(() => {
    setOrder(savedOrder);
    orderRef.current = savedOrder;
  }, [savedOrder]);

  const updateSettings = (changes: Partial<AppSettings>) => {
    if (appSettings) {
      handleSettingsChange({ ...appSettings, ...changes });
    }
  };

  const handleReorder = (newOrder: string[]) => {
    orderRef.current = newOrder;
    setOrder(newOrder);
  };

  const handleDragEnd = () => {
    if (orderRef.current.join() !== savedOrder.join()) {
      updateSettings({ adjustmentSectionOrder: orderRef.current });
    }
  };

  const handleToggleSection = (section: string) => {
    updateSettings({
      hiddenAdjustmentSections: hiddenSections.includes(section)
        ? hiddenSections.filter((hiddenSection) => hiddenSection !== section)
        : [...hiddenSections, section],
    });
  };

  const isToolHidden = (tool: string) => adjustmentVisibility[tool] === false;

  const handleToggleTool = (tool: string) => {
    updateSettings({ adjustmentVisibility: { ...adjustmentVisibility, [tool]: isToolHidden(tool) } });
  };

  const handleReset = () => {
    updateSettings({
      adjustmentSectionOrder: [],
      adjustmentVisibility: Object.fromEntries(ALL_TOOLS.map((tool) => [tool.id, tool.isVisibleByDefault])),
      hiddenAdjustmentSections: [],
    });
  };

  const visibleCount = order.filter((section) => !hiddenSections.includes(section)).length;
  const isDefaultLayout =
    hiddenSections.length === 0 &&
    savedOrder.join() === Object.keys(ADJUSTMENT_SECTIONS).join() &&
    ALL_TOOLS.every((tool) => isToolHidden(tool.id) !== tool.isVisibleByDefault);

  return (
    <div
      className="bg-surface/95 p-2 w-60 flex flex-col rounded-lg"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Reorder.Group as="div" axis="y" className="flex flex-col" onReorder={handleReorder} values={order}>
        {order.map((section) => {
          const isHidden = hiddenSections.includes(section);
          return (
            <SectionRow
              isExpanded={expandedSection === section}
              isHidden={isHidden}
              isToggleDisabled={!isHidden && visibleCount <= 1}
              isToolHidden={isToolHidden}
              key={section}
              onDragEnd={handleDragEnd}
              onToggle={() => handleToggleSection(section)}
              onToggleExpanded={() => setExpandedSection(expandedSection === section ? null : section)}
              onToggleTool={handleToggleTool}
              section={section}
            />
          );
        })}
      </Reorder.Group>
      <div className="h-px bg-text-secondary/20 my-1 mx-2" />
      <button
        className="w-full text-left px-3 py-2 text-sm rounded-md flex items-center gap-3 transition-colors duration-150 text-text-primary hover:bg-bg-primary disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
        disabled={isDefaultLayout}
        onClick={handleReset}
        role="menuitem"
      >
        <RotateCcw size={16} />
        <span>{t('editor.adjustments.actions.resetPanelLayout')}</span>
      </button>
    </div>
  );
}
