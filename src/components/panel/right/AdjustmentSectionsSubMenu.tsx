import { useEffect, useMemo, useRef, useState } from 'react';
import { Reorder, useDragControls } from 'framer-motion';
import { Eye, EyeOff, GripVertical, RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import { useShallow } from 'zustand/react/shallow';
import { AppSettings } from '../../ui/AppProperties';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { ADJUSTMENT_SECTIONS, getAdjustmentSectionOrder } from '../../../utils/adjustments';

interface SectionRowProps {
  isHidden: boolean;
  isToggleDisabled: boolean;
  onDragEnd(): void;
  onToggle(): void;
  section: string;
}

function SectionRow({ isHidden, isToggleDisabled, onDragEnd, onToggle, section }: SectionRowProps) {
  const { t } = useTranslation();
  const dragControls = useDragControls();

  return (
    <Reorder.Item
      as="div"
      className="flex items-center gap-2 pl-2 pr-1 rounded-md bg-surface hover:bg-bg-primary transition-colors"
      dragControls={dragControls}
      dragListener={false}
      onDragEnd={onDragEnd}
      value={section}
    >
      <div
        className="flex items-center gap-2 grow min-w-0 py-2 cursor-grab active:cursor-grabbing touch-none select-none"
        onPointerDown={(e) => dragControls.start(e)}
      >
        <GripVertical size={16} className="shrink-0 text-text-secondary" />
        <span className={clsx('text-sm truncate', isHidden ? 'text-text-secondary' : 'text-text-primary')}>
          {t(`editor.adjustments.sections.${section}` as ParseKeys)}
        </span>
      </div>
      <button
        className="p-1 rounded-full text-text-secondary hover:text-text-primary hover:bg-card-active disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        disabled={isToggleDisabled}
        onClick={onToggle}
        data-tooltip={
          isHidden ? t('editor.adjustments.tooltips.showInPanel') : t('editor.adjustments.tooltips.hideFromPanel')
        }
      >
        {isHidden ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
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
  const [order, setOrder] = useState(savedOrder);
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

  const handleReset = () => {
    updateSettings({ adjustmentSectionOrder: [], hiddenAdjustmentSections: [] });
  };

  const visibleCount = order.filter((section) => !hiddenSections.includes(section)).length;
  const isDefaultLayout = hiddenSections.length === 0 && savedOrder.join() === Object.keys(ADJUSTMENT_SECTIONS).join();

  return (
    <div
      className="bg-surface/95 p-2 w-56 flex flex-col rounded-lg"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Reorder.Group as="div" axis="y" className="flex flex-col" onReorder={handleReorder} values={order}>
        {order.map((section) => {
          const isHidden = hiddenSections.includes(section);
          return (
            <SectionRow
              isHidden={isHidden}
              isToggleDisabled={!isHidden && visibleCount <= 1}
              key={section}
              onDragEnd={handleDragEnd}
              onToggle={() => handleToggleSection(section)}
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
