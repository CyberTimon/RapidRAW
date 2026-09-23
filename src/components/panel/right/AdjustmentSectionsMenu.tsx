import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, Reorder, useDragControls } from 'framer-motion';
import { Eye, EyeOff, GripVertical, LayoutList, RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import { useShallow } from 'zustand/react/shallow';
import Text from '../../ui/Text';
import { AppSettings } from '../../ui/AppProperties';
import { TextVariants, TextWeights } from '../../../types/typography';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { ADJUSTMENT_SECTIONS, getAdjustmentSectionOrder } from '../../../utils/adjustments';

interface SectionRowProps {
  isHidden: boolean;
  isToggleDisabled: boolean;
  onDragEnd(): void;
  onToggle(): void;
  section: string;
}

interface AdjustmentSectionsMenuProps {
  isOpen: boolean;
  onOpenChange(isOpen: boolean): void;
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

export default function AdjustmentSectionsMenu({ isOpen, onOpenChange }: AdjustmentSectionsMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onOpenChange]);

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
    <div className="flex" ref={menuRef}>
      <button
        className={clsx(
          'p-2 rounded-full transition-colors',
          isOpen ? 'bg-surface hover:bg-card-active' : 'hover:bg-surface',
        )}
        onClick={() => onOpenChange(!isOpen)}
        data-tooltip={t('editor.adjustments.actions.customizePanels')}
      >
        <LayoutList size={18} />
      </button>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.1, ease: 'easeOut' }}
            className="absolute right-3 top-full mt-1 z-50 w-64 max-w-[calc(100%-1.5rem)] origin-top-right"
          >
            <div
              className="bg-surface/95 backdrop-blur-md rounded-lg shadow-xl p-2 border border-border-color/50 flex flex-col"
              role="menu"
            >
              <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-3 py-2 uppercase">
                {t('editor.adjustments.actions.customizePanels')}
              </Text>
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
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
