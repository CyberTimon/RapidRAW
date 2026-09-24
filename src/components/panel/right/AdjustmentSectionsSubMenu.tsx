import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { DragControls, Reorder, useDragControls } from 'framer-motion';
import { ChevronDown, Eye, EyeOff, GripVertical, RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import { useShallow } from 'zustand/react/shallow';
import { AdjustmentLayout } from '../../ui/AppProperties';
import { useSettingsStore } from '../../../store/useSettingsStore';
import {
  ADJUSTMENT_SECTIONS,
  ADJUSTMENT_SECTION_TOOLS,
  AdjustmentSectionTool,
  getAdjustmentSectionOrder,
  getAdjustmentToolOrder,
  withAdjustmentLayout,
} from '../../../utils/adjustments';

interface DragHandleProps {
  dragControls: DragControls;
  isMuted: boolean;
  label: string;
}

interface VisibilityToggleProps {
  isDisabled?: boolean;
  isHidden: boolean;
  onToggle(): void;
}

interface ToolRowProps {
  isHidden: boolean;
  isSectionHidden: boolean;
  onDragEnd(): void;
  onToggle(): void;
  tool: AdjustmentSectionTool;
}

interface SectionRowProps {
  isExpanded: boolean;
  isHidden: boolean;
  isToggleDisabled: boolean;
  isToolHidden(tool: string): boolean;
  onDragEnd(): void;
  onReorderTools(order: string[]): void;
  onToggle(): void;
  onToggleExpanded(): void;
  onToggleTool(tool: string): void;
  section: string;
  toolOrder: string[];
}

const ALL_TOOLS = Object.values(ADJUSTMENT_SECTION_TOOLS).flat();
const TOOLS_BY_ID = Object.fromEntries(ALL_TOOLS.map((tool) => [tool.id, tool]));

const toggleId = (ids: string[], id: string) => (ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);

function useReorderableList(savedOrder: string[], onCommit: (order: string[]) => void) {
  const [order, setOrder] = useState(savedOrder);
  const orderRef = useRef(savedOrder);

  useEffect(() => {
    setOrder(savedOrder);
    orderRef.current = savedOrder;
  }, [savedOrder]);

  const handleReorder = (newOrder: string[]) => {
    orderRef.current = newOrder;
    setOrder(newOrder);
  };

  const handleDragEnd = () => {
    if (orderRef.current.join() !== savedOrder.join()) {
      onCommit(orderRef.current);
    }
  };

  return { handleDragEnd, handleReorder, order };
}

function DragHandle({ dragControls, isMuted, label }: DragHandleProps) {
  return (
    <div
      className="flex items-center gap-2 grow min-w-0 py-2 cursor-grab active:cursor-grabbing touch-none select-none"
      onPointerDown={(e) => dragControls.start(e)}
    >
      <GripVertical size={16} className="shrink-0 text-text-secondary" />
      <span className={clsx('text-sm truncate', isMuted ? 'text-text-secondary' : 'text-text-primary')}>{label}</span>
    </div>
  );
}

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

function ToolRow({ isHidden, isSectionHidden, onDragEnd, onToggle, tool }: ToolRowProps) {
  const { t } = useTranslation();
  const dragControls = useDragControls();

  return (
    <Reorder.Item
      as="div"
      className="flex items-center gap-1 pl-6 pr-1 rounded-md bg-surface hover:bg-bg-primary transition-colors"
      dragControls={dragControls}
      dragListener={false}
      layout="position"
      onDragEnd={onDragEnd}
      value={tool.id}
    >
      <DragHandle
        dragControls={dragControls}
        isMuted={isSectionHidden || isHidden}
        label={t(tool.label as ParseKeys)}
      />
      <VisibilityToggle isHidden={isHidden} onToggle={onToggle} />
    </Reorder.Item>
  );
}

function SectionRow({
  isExpanded,
  isHidden,
  isToggleDisabled,
  isToolHidden,
  onDragEnd,
  onReorderTools,
  onToggle,
  onToggleExpanded,
  onToggleTool,
  section,
  toolOrder,
}: SectionRowProps) {
  const { t } = useTranslation();
  const dragControls = useDragControls();
  const tools = useReorderableList(toolOrder, onReorderTools);

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
        <DragHandle
          dragControls={dragControls}
          isMuted={isHidden}
          label={t(`editor.adjustments.sections.${section}` as ParseKeys)}
        />
        {toolOrder.length > 0 && (
          <button
            className="p-1 rounded-full text-text-secondary hover:text-text-primary hover:bg-card-active transition-colors"
            onClick={onToggleExpanded}
          >
            <ChevronDown size={16} className={clsx('transition-transform duration-200', isExpanded && 'rotate-180')} />
          </button>
        )}
        <VisibilityToggle isDisabled={isToggleDisabled} isHidden={isHidden} onToggle={onToggle} />
      </div>
      {isExpanded && (
        <Reorder.Group as="div" axis="y" className="flex flex-col" onReorder={tools.handleReorder} values={tools.order}>
          {tools.order.map((tool) => (
            <ToolRow
              isHidden={isToolHidden(tool)}
              isSectionHidden={isHidden}
              key={tool}
              onDragEnd={tools.handleDragEnd}
              onToggle={() => onToggleTool(tool)}
              tool={TOOLS_BY_ID[tool]}
            />
          ))}
        </Reorder.Group>
      )}
    </Reorder.Item>
  );
}

function AdjustmentSectionsSubMenu() {
  const { t } = useTranslation();

  const { appSettings, handleSettingsChange } = useSettingsStore(
    useShallow((state) => ({
      appSettings: state.appSettings,
      handleSettingsChange: state.handleSettingsChange,
    })),
  );

  const layout = appSettings?.adjustmentLayout;
  const savedOrder = useMemo(() => getAdjustmentSectionOrder(layout?.sectionOrder), [layout?.sectionOrder]);
  const savedToolOrder = useMemo(
    () =>
      Object.fromEntries(
        Object.keys(ADJUSTMENT_SECTIONS).map((section) => [
          section,
          getAdjustmentToolOrder(section, layout?.toolOrder),
        ]),
      ),
    [layout?.toolOrder],
  );
  const hiddenSections = layout?.hiddenSections ?? [];
  const hiddenTools = layout?.hiddenTools ?? [];
  const [expandedSection, setExpandedSection] = useState<string | null>(null);

  const updateLayout = (changes: Partial<AdjustmentLayout>) => {
    if (appSettings) {
      handleSettingsChange(withAdjustmentLayout(appSettings, changes));
    }
  };

  const sections = useReorderableList(savedOrder, (order) => updateLayout({ sectionOrder: order }));

  const handleToggleSection = (section: string) => {
    updateLayout({ hiddenSections: toggleId(hiddenSections, section) });
  };

  const isToolHidden = (tool: string) => hiddenTools.includes(tool);

  const handleToggleTool = (tool: string) => {
    updateLayout({ hiddenTools: toggleId(hiddenTools, tool) });
  };

  const handleReorderTools = (section: string, order: string[]) => {
    updateLayout({ toolOrder: { ...layout?.toolOrder, [section]: order } });
  };

  const handleReset = () => {
    updateLayout({ hiddenSections: [], hiddenTools: [], sectionOrder: [], toolOrder: {} });
  };

  const visibleCount = sections.order.filter((section) => !hiddenSections.includes(section)).length;
  const isDefaultLayout =
    hiddenSections.length === 0 &&
    savedOrder.join() === Object.keys(ADJUSTMENT_SECTIONS).join() &&
    Object.entries(savedToolOrder).every(
      ([section, order]) => order.join() === getAdjustmentToolOrder(section).join(),
    ) &&
    hiddenTools.length === 0;

  return (
    <div
      className="bg-surface/95 p-2 w-64 flex flex-col rounded-lg"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Reorder.Group
        as="div"
        axis="y"
        className="flex flex-col"
        onReorder={sections.handleReorder}
        values={sections.order}
      >
        {sections.order.map((section) => {
          const isHidden = hiddenSections.includes(section);
          return (
            <SectionRow
              isExpanded={expandedSection === section}
              isHidden={isHidden}
              isToggleDisabled={!isHidden && visibleCount <= 1}
              isToolHidden={isToolHidden}
              key={section}
              onDragEnd={sections.handleDragEnd}
              onReorderTools={(order) => handleReorderTools(section, order)}
              onToggle={() => handleToggleSection(section)}
              onToggleExpanded={() => setExpandedSection(expandedSection === section ? null : section)}
              onToggleTool={handleToggleTool}
              section={section}
              toolOrder={savedToolOrder[section]}
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

export default memo(AdjustmentSectionsSubMenu);
