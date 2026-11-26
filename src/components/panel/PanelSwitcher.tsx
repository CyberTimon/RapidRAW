import { memo, useState, useRef, useCallback } from 'react';
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
  Camera,
  Folder as FolderIcon,
  Film,
  Blend,
  Captions,
  Clapperboard,
  SquareMousePointer,
  SlidersVertical,
  type LucideIcon,
} from 'lucide-react';
import { Panel, PanelRegion } from '../../types/ui';
import { getRegionActivePanel, isPanelAvailable, SwitcherPlacement, useUIStore } from '../../store/useUIStore';
import type { ParseKeys } from 'i18next';
import { useShortcut } from '../../hooks/useShortcuts';
import type { ShortcutAction } from '../../utils/keyboardUtils';

export const PANEL_ICONS: Record<Panel, LucideIcon> = {
  [Panel.Metadata]: Info,
  [Panel.Adjustments]: SlidersHorizontal,
  [Panel.Crop]: Crop,
  [Panel.Masks]: Layers,
  [Panel.Ai]: Paintbrush,
  [Panel.Presets]: SwatchBook,
  [Panel.Export]: FileInput,
  [Panel.FolderTree]: FolderIcon,
  [Panel.Tethering]: Camera,
  [Panel.Filmstrip]: Film,
  [Panel.MediaPool]: Clapperboard,
  [Panel.Inspector]: SquareMousePointer,
  [Panel.Effects]: Blend,
  [Panel.Captions]: Captions,
  [Panel.Mixer]: SlidersVertical,
};

const PANEL_TITLES: Record<Panel, ParseKeys> = {
  [Panel.Metadata]: 'editor.metadata.title',
  [Panel.Adjustments]: 'editor.adjustments.title',
  [Panel.Crop]: 'editor.crop.title',
  [Panel.Masks]: 'editor.masks.maskingTitle',
  [Panel.Ai]: 'editor.ai.inpaintingTitle',
  [Panel.Presets]: 'editor.presets.title',
  [Panel.Export]: 'export.title',
  [Panel.FolderTree]: 'library.folders.sourcesTitle',
  [Panel.Tethering]: 'tethering.title',
  [Panel.Filmstrip]: 'editor.switcher.tooltips.filmstrip',
  [Panel.MediaPool]: 'editor.switcher.tooltips.mediaPool',
  [Panel.Inspector]: 'video.inspector.title',
  [Panel.Effects]: 'video.effectsPanel.title',
  [Panel.Captions]: 'video.captions.title',
  [Panel.Mixer]: 'video.mixer.title',
};

const PANEL_SHORTCUTS: Partial<Record<Panel, ShortcutAction>> = {
  [Panel.Metadata]: 'toggle_metadata',
  [Panel.Adjustments]: 'toggle_adjustments',
  [Panel.Crop]: 'toggle_crop_panel',
  [Panel.Masks]: 'toggle_masks',
  [Panel.Ai]: 'toggle_ai',
  [Panel.Presets]: 'toggle_presets',
  [Panel.Export]: 'toggle_export',
  [Panel.FolderTree]: 'toggle_folder_tree',
  [Panel.MediaPool]: 'video_panel_project',
  [Panel.Inspector]: 'video_panel_inspector',
  [Panel.Effects]: 'video_panel_effects',
  [Panel.Captions]: 'video_panel_captions',
  [Panel.Mixer]: 'video_panel_mixer',
};

interface PanelTabButtonProps {
  panel: Panel;
  isActive: boolean;
  indicatorId: string;
  onClick: () => void;
  isDraggable?: boolean;
  isDisabled?: boolean;
  isCompact?: boolean;
  dragId?: string;
  shortcut?: ShortcutAction;
}

export const PanelTabButton = memo(function PanelTabButton({
  panel,
  isActive,
  indicatorId,
  onClick,
  isDraggable = true,
  isDisabled = false,
  isCompact = false,
  dragId = `layout-tab-${panel}`,
  shortcut: action = PANEL_SHORTCUTS[panel],
}: PanelTabButtonProps) {
  const { t } = useTranslation();
  const isInstantTransition = useUIStore((s) => s.isInstantTransition);
  const shortcut = useShortcut(isDisabled ? null : action);
  const Icon = PANEL_ICONS[panel];

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: dragId,
    data: { type: 'layout-tab', panel },
    disabled: !isDraggable || isDisabled,
  });

  return (
    <button
      data-layout-tab
      data-tab-id={dragId}
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={clsx(
        'relative rounded-md transition-[color,background-color,opacity] duration-300 shrink-0',
        isCompact ? 'p-1.5' : 'p-2',
        isDisabled
          ? 'text-text-secondary opacity-30 cursor-default'
          : clsx(
              isDraggable && 'cursor-grab active:cursor-grabbing',
              isActive ? 'text-text-primary' : 'text-text-secondary hover:bg-surface hover:text-text-primary',
            ),
        isDragging && 'opacity-30',
      )}
      onClick={isDisabled ? undefined : onClick}
      data-tooltip={t(PANEL_TITLES[panel])}
      {...shortcut}
      style={{ touchAction: 'none' }}
    >
      {isActive && (
        <motion.div
          layoutId={indicatorId}
          className="absolute inset-0 bg-surface rounded-md"
          transition={isInstantTransition ? { duration: 0 } : { type: 'spring', bounce: 0.2, duration: 0.4 }}
        />
      )}
      <Icon size={isCompact ? 18 : 20} className="relative z-10 pointer-events-none" />
    </button>
  );
});

function PanelTab({ panel, region, side }: { panel: Panel; region: PanelRegion; side: 'left' | 'right' }) {
  const isActive = useUIStore((s) => getRegionActivePanel(s, region) === panel);
  const isDisabled = useUIStore((s) => !isPanelAvailable(s, panel));
  const setActivePanel = useUIStore((s) => s.setActivePanel);
  const setUI = useUIStore((s) => s.setUI);

  const handleClick = () => {
    const { leftPanelWidth, rightPanelWidth } = useUIStore.getState();
    setActivePanel(region, panel);
    if (side === 'left' && leftPanelWidth < 200) {
      setUI({ leftPanelWidth: 350 });
    }
    if (side === 'right' && rightPanelWidth < 200) {
      setUI({ rightPanelWidth: 350 });
    }
  };

  return (
    <PanelTabButton
      panel={panel}
      isActive={isActive}
      indicatorId={`active-indicator-${region}`}
      onClick={handleClick}
      isDisabled={isDisabled}
    />
  );
}

function PanelSwitcher({
  region,
  side,
  placement,
}: {
  region: PanelRegion;
  side: 'left' | 'right';
  placement: SwitcherPlacement;
}) {
  const panels = useUIStore((s) => s.panelLayout[region]);
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

      let style: any;
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

export default memo(PanelSwitcher);

export function MobilePanelSwitcher({
  activePanel,
  onPanelSelect,
  placement = 'bottom',
}: {
  activePanel: Panel | null;
  onPanelSelect: (id: Panel) => void;
  placement?: 'bottom' | 'right';
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

  const isVertical = placement === 'right';

  return (
    <div
      className={clsx(
        'flex items-center p-1.5 gap-1 shrink-0 custom-scrollbar',
        isVertical
          ? 'flex-col overflow-y-auto h-full border-l border-surface'
          : 'flex-row overflow-x-auto w-full border-t border-surface',
      )}
    >
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
