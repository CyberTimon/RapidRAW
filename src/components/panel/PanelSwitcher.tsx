import { useState, useRef, useCallback } from 'react';
import { motion, LayoutGroup, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { useDraggable, useDroppable, useDndMonitor } from '@dnd-kit/core';
import {
  SlidersHorizontal,
  Info,
  Crop,
  Layers,
  Paintbrush,
  SwatchBook,
  FileInput,
  Folder as FolderIcon,
  type LucideIcon,
} from 'lucide-react';
import { Panel, PanelRegion } from '../ui/AppProperties';
import { SwitcherPlacement, useUIStore } from '../../store/useUIStore';

export const PANEL_ICONS: Record<Panel, LucideIcon> = {
  [Panel.Metadata]: Info,
  [Panel.Adjustments]: SlidersHorizontal,
  [Panel.Crop]: Crop,
  [Panel.Masks]: Layers,
  [Panel.Ai]: Paintbrush,
  [Panel.Presets]: SwatchBook,
  [Panel.Export]: FileInput,
  [Panel.FolderTree]: FolderIcon,
};

const PANEL_TITLES: Record<Panel, string> = {
  [Panel.Metadata]: 'editor.switcher.tooltips.info',
  [Panel.Adjustments]: 'editor.switcher.tooltips.adjust',
  [Panel.Crop]: 'editor.switcher.tooltips.crop',
  [Panel.Masks]: 'editor.switcher.tooltips.masks',
  [Panel.Ai]: 'editor.switcher.tooltips.inpaint',
  [Panel.Presets]: 'editor.switcher.tooltips.presets',
  [Panel.Export]: 'editor.switcher.tooltips.export',
  [Panel.FolderTree]: 'library.folders.sourcesTitle',
};

function PanelTab({ panel, region, side }: { panel: Panel; region: PanelRegion; side: 'left' | 'right' }) {
  const { t } = useTranslation();
  const activePanels = useUIStore((s) => s.activePanels);
  const setActivePanel = useUIStore((s) => s.setActivePanel);
  const setUI = useUIStore((s) => s.setUI);
  const leftPanelWidth = useUIStore((s) => s.leftPanelWidth);
  const rightPanelWidth = useUIStore((s) => s.rightPanelWidth);
  const isInstantTransition = useUIStore((s) => s.isInstantTransition);

  const isActive = activePanels[region] === panel;
  const Icon = PANEL_ICONS[panel];

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `layout-tab-${panel}`,
    data: { type: 'layout-tab', panel },
  });

  const handleClick = () => {
    setActivePanel(region, panel);
    if (side === 'left' && leftPanelWidth < 200) {
      setUI({ leftPanelWidth: 320 });
    }
    if (side === 'right' && rightPanelWidth < 200) {
      setUI({ rightPanelWidth: 320 });
    }
  };

  return (
    <button
      data-layout-tab
      data-tab-id={`layout-tab-${panel}`}
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={clsx(
        'relative rounded-md transition-colors duration-200 p-2 shrink-0 cursor-grab active:cursor-grabbing',
        isActive ? 'text-text-primary' : 'text-text-secondary hover:bg-surface hover:text-text-primary',
        isDragging && 'opacity-30',
      )}
      onClick={handleClick}
      data-tooltip={t(PANEL_TITLES[panel])}
      style={{ touchAction: 'none' }}
    >
      {isActive && (
        <motion.div
          layoutId={`active-indicator-${region}`}
          className="absolute inset-0 bg-surface rounded-md"
          transition={isInstantTransition ? { duration: 0 } : { type: 'spring', bounce: 0.2, duration: 0.4 }}
        />
      )}
      <Icon size={20} className="relative z-10 pointer-events-none" />
    </button>
  );
}

export default function PanelSwitcher({
  region,
  side,
  placement,
}: {
  region: PanelRegion;
  side: 'left' | 'right';
  placement: SwitcherPlacement;
}) {
  const panelLayout = useUIStore((s) => s.panelLayout);
  const panels = panelLayout[region];
  const movePanelToIndex = useUIStore((s) => s.movePanelToIndex);

  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [indicatorProps, setIndicatorProps] = useState<any>({});
  const containerRef = useRef<HTMLDivElement | null>(null);

  const { setNodeRef, isOver } = useDroppable({
    id: `layout-switcher-${region}`,
    data: { type: 'layout-switcher', region },
  });

  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node);
      containerRef.current = node;
    },
    [setNodeRef],
  );

  const isVertical = placement === 'left' || placement === 'right';

  useDndMonitor({
    onDragMove(event) {
      if (event.active.data.current?.type !== 'layout-tab') return;

      if (event.over?.id !== `layout-switcher-${region}` || !containerRef.current) {
        if (hoverIndex !== null) {
          setHoverIndex(null);
        }
        return;
      }

      const activeRect = event.active.rect.current.translated;
      if (!activeRect) return;

      const x = activeRect.left + activeRect.width / 2;
      const y = activeRect.top + activeRect.height / 2;

      const tabs = Array.from(containerRef.current.querySelectorAll('[data-layout-tab]')).filter(
        (tab) => tab.getAttribute('data-tab-id') !== event.active.id,
      ) as HTMLElement[];

      let insertIndex = tabs.length;
      for (let i = 0; i < tabs.length; i++) {
        const tabRect = tabs[i].getBoundingClientRect();
        if (isVertical) {
          if (y < tabRect.top + tabRect.height / 2) {
            insertIndex = i;
            break;
          }
        } else {
          if (x < tabRect.left + tabRect.width / 2) {
            insertIndex = i;
            break;
          }
        }
      }

      let style: any = {};
      if (tabs.length === 0) {
        style = isVertical ? { top: 4, left: 4, right: 4, height: 2 } : { left: 4, top: 4, bottom: 4, width: 2 };
      } else if (insertIndex < tabs.length) {
        const tab = tabs[insertIndex];
        if (isVertical) {
          style = { top: tab.offsetTop - 2, left: 4, right: 4, height: 2 };
        } else {
          style = { left: tab.offsetLeft - 2, top: 4, bottom: 4, width: 2 };
        }
      } else {
        const tab = tabs[tabs.length - 1];
        if (isVertical) {
          style = { top: tab.offsetTop + tab.offsetHeight + 2, left: 4, right: 4, height: 2 };
        } else {
          style = { left: tab.offsetLeft + tab.offsetWidth + 2, top: 4, bottom: 4, width: 2 };
        }
      }

      setIndicatorProps(style);
      setHoverIndex(insertIndex);
    },
    onDragEnd(event) {
      if (event.over?.id === `layout-switcher-${region}`) {
        const activePanel = event.active.data.current?.panel;
        if (activePanel && hoverIndex !== null) {
          movePanelToIndex(activePanel, region, hoverIndex);
        }
      }
      if (hoverIndex !== null) {
        setHoverIndex(null);
      }
    },
  });

  if (panels.length === 0) return null;

  return (
    <div
      ref={setRefs}
      className={clsx(
        'flex items-center p-1.5 gap-1 shrink-0 transition-colors z-10 custom-scrollbar relative',
        isVertical
          ? clsx(
              'flex-col overflow-y-auto h-full',
              placement === 'left' ? 'border-r border-surface' : 'border-l border-surface',
            )
          : clsx(
              'flex-row overflow-x-auto w-full',
              placement === 'top' ? 'border-b border-surface' : 'border-t border-surface',
            ),
      )}
    >
      <AnimatePresence>
        {isOver && hoverIndex !== null && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, ...indicatorProps }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="absolute bg-accent rounded-full pointer-events-none z-50"
          />
        )}
      </AnimatePresence>

      <LayoutGroup id={`switcher-${region}`}>
        {panels.map((id) => (
          <PanelTab key={id} panel={id} region={region} side={side} />
        ))}
      </LayoutGroup>
    </div>
  );
}

export function MobilePanelSwitcher({
  activePanel,
  onPanelSelect,
}: {
  activePanel: Panel | null;
  onPanelSelect: (id: Panel) => void;
}) {
  const MOBILE_PANELS = [
    Panel.Metadata,
    Panel.Adjustments,
    Panel.Crop,
    Panel.Masks,
    Panel.Ai,
    Panel.Presets,
    Panel.Export,
  ];

  return (
    <div className="flex items-center gap-2 p-2 overflow-x-auto border-t border-surface shrink-0 custom-scrollbar">
      {MOBILE_PANELS.map((id) => {
        const Icon = PANEL_ICONS[id];
        const isActive = activePanel === id;

        return (
          <button
            key={id}
            onClick={() => onPanelSelect(id)}
            className={clsx(
              'p-2 rounded-md shrink-0 transition-colors',
              isActive
                ? 'bg-surface text-text-primary'
                : 'text-text-secondary hover:bg-surface hover:text-text-primary',
            )}
          >
            <Icon size={20} />
          </button>
        );
      })}
    </div>
  );
}
