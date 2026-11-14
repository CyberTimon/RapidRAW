import { useState, useCallback, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { useDroppable, useDndMonitor } from '@dnd-kit/core';
import {
  DEFAULT_PANEL_SECTION_HEIGHT,
  getRegionActivePanel,
  getReopenedPanelWidth,
  SwitcherPlacement,
  useUIStore,
} from '../../store/useUIStore';
import { Panel, PanelRegion } from '../../types/ui';
import { getDropPlacement, LayoutDropData, LayoutSide, SPLIT_BAND_RATIO, SplitSlot } from '../../utils/layoutDrop';
import PanelSwitcher, { MobilePanelSwitcher, PANEL_ICONS } from './PanelSwitcher';

const COLLAPSE_THRESHOLD = 200;

const SWITCHER_BAR: Record<SwitcherPlacement, string> = {
  top: 'inset-x-0 top-0 h-1',
  bottom: 'inset-x-0 bottom-0 h-1',
  left: 'inset-y-0 left-0 w-1',
  right: 'inset-y-0 right-0 w-1',
};

interface SidePanelAreaProps {
  side: LayoutSide;
  width: number;
  topRegion: PanelRegion;
  bottomRegion: PanelRegion;
  renderPanel: (panel: Panel) => React.ReactNode;
  onWidthChange: (e: React.PointerEvent<HTMLDivElement>) => void;
  onWidthReset: () => void;
  isResizing: boolean;
  showAdditionalTabs?: boolean;
}

function useLayoutDropTarget(id: string, data: LayoutDropData) {
  const { setNodeRef, isOver, active } = useDroppable({ id, data });
  const [placement, setPlacement] = useState<SwitcherPlacement | null>(null);

  useDndMonitor({
    onDragMove({ active: dragged, over }) {
      const next =
        over?.id === id && dragged.data.current?.type === 'layout-tab'
          ? getDropPlacement(data.side, over.rect, dragged.rect.current.translated)
          : null;
      setPlacement((prev) => (prev === next ? prev : next));
    },
    onDragEnd: () => setPlacement(null),
    onDragCancel: () => setPlacement(null),
  });

  return { setNodeRef, isOver: isOver && active?.data.current?.type === 'layout-tab', placement };
}

function DropHighlight({
  placement,
  className,
  children,
}: {
  placement: SwitcherPlacement | null;
  className: string;
  children?: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className={clsx(
        'absolute pointer-events-none overflow-hidden rounded-lg border-2 border-accent bg-accent/10',
        className,
      )}
    >
      {placement && <div className={clsx('absolute bg-accent', SWITCHER_BAR[placement])} />}
      {children}
    </motion.div>
  );
}

function RegionDroppableContainer({
  region,
  side,
  renderPanel,
  width,
  isInstantTransition,
  isResizing,
}: {
  region: PanelRegion;
  side: LayoutSide;
  renderPanel: (panel: Panel) => React.ReactNode;
  width: number;
  isInstantTransition: boolean;
  isResizing: boolean;
}) {
  const activePanel = useUIStore((s) => getRegionActivePanel(s, region));
  const storedPanel = useUIStore((s) => s.activePanels[region] ?? s.panelLayout[region][0] ?? null);
  const setActivePanel = useUIStore((s) => s.setActivePanel);
  const placement = useUIStore((s) => s.panelSwitcherPlacement[region]);
  const DisabledIcon = storedPanel ? PANEL_ICONS[storedPanel] : null;

  const {
    setNodeRef,
    isOver,
    placement: dropPlacement,
  } = useLayoutDropTarget(`layout-region-${region}`, { type: 'layout-region', side, region });

  const handleContentInteraction = () => {
    if (activePanel) {
      setActivePanel(region, activePanel);
    }
  };

  const isFlexRow = placement === 'left' || placement === 'right';
  const showSwitcherFirst = placement === 'left' || placement === 'top';
  const isCollapsed = width < COLLAPSE_THRESHOLD;

  return (
    <div
      ref={setNodeRef}
      className={clsx(
        'flex h-full w-full bg-bg-secondary rounded-lg overflow-hidden border border-surface shadow-xs relative',
        isFlexRow ? 'flex-row' : 'flex-col',
      )}
    >
      <AnimatePresence>
        {isOver && <DropHighlight placement={dropPlacement} className="inset-0 z-40" />}
      </AnimatePresence>

      <div
        className={clsx(
          'flex flex-1 w-full h-full min-w-0 min-h-0 overflow-hidden transition-opacity duration-300 ease-in-out',
          isFlexRow ? 'flex-row' : 'flex-col',
          isCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100 pointer-events-auto',
        )}
      >
        {showSwitcherFirst && <PanelSwitcher region={region} side={side} placement={placement} />}

        <div
          className="flex-1 overflow-hidden relative min-w-0"
          data-panel={activePanel ?? undefined}
          data-panel-region={region}
          onPointerDownCapture={handleContentInteraction}
        >
          <AnimatePresence mode="wait">
            {activePanel ? (
              <motion.div
                key={activePanel}
                className="absolute inset-0 overflow-y-auto custom-scrollbar"
                initial={isInstantTransition || isResizing ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                {renderPanel(activePanel)}
              </motion.div>
            ) : (
              DisabledIcon && (
                <motion.div
                  key="disabled"
                  className="absolute inset-0 flex items-center justify-center text-text-secondary"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 0.2 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.3 }}
                >
                  <DisabledIcon size={32} />
                </motion.div>
              )
            )}
          </AnimatePresence>
        </div>

        {!showSwitcherFirst && <PanelSwitcher region={region} side={side} placement={placement} />}
      </div>
    </div>
  );
}

function SplitDropZone({ side, region, slot }: { side: LayoutSide; region: PanelRegion; slot: SplitSlot }) {
  const { t } = useTranslation();
  const { setNodeRef, isOver, placement } = useLayoutDropTarget(`layout-split-${side}-${slot}`, {
    type: 'layout-split',
    side,
    region,
    slot,
  });
  const isTop = slot === 'top';

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="absolute inset-0 z-30 pointer-events-none"
    >
      <div
        ref={setNodeRef}
        className={clsx(
          'absolute inset-x-0 flex justify-center',
          isTop ? 'top-0 items-start pt-1' : 'bottom-0 items-end pb-1',
        )}
        style={{ height: `${SPLIT_BAND_RATIO * 100}%` }}
      >
        <div
          className={clsx(
            'h-1 w-10 rounded-full bg-accent/60 transition-opacity duration-150',
            isOver ? 'opacity-0' : 'opacity-100',
          )}
        />
      </div>

      <AnimatePresence>
        {isOver && (
          <DropHighlight
            placement={placement}
            className={clsx(
              'inset-x-0 h-1/2 backdrop-blur-sm flex items-center justify-center',
              isTop ? 'top-0' : 'bottom-0',
            )}
          >
            <span className="text-xs font-semibold uppercase tracking-wider text-accent">
              {t('editor.layout.split')}
            </span>
          </DropHighlight>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export default function SidePanelArea({
  side,
  width,
  topRegion,
  bottomRegion,
  renderPanel,
  onWidthChange,
  onWidthReset,
  isResizing,
  showAdditionalTabs = false,
}: SidePanelAreaProps) {
  const hasTop = useUIStore((s) => s.panelLayout[topRegion].length > 0);
  const hasBottom = useUIStore((s) => s.panelLayout[bottomRegion].length > 0);
  const canSplit = useUIStore(
    (s) =>
      hasTop !== hasBottom &&
      s.activeLayoutDragItem !== null &&
      s.panelLayout[hasTop ? topRegion : bottomRegion].some((panel) => panel !== s.activeLayoutDragItem),
  );
  const isFullScreen = useUIStore((s) => s.isFullScreen);
  const isInstantTransition = useUIStore((s) => s.isInstantTransition);
  const activeLayoutDragItem = useUIStore((s) => s.activeLayoutDragItem);
  const isDraggingLayout = !!activeLayoutDragItem;

  const topHeight = useUIStore((s) => (side === 'left' ? s.leftTopHeight : s.rightTopHeight));
  const setUI = useUIStore((s) => s.setUI);
  const activePanel = useUIStore((s) => s.activePanel);
  const setPanel = useUIStore((s) => s.setPanel);
  const colContainerRef = useRef<HTMLDivElement>(null);

  const handleVerticalResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const startY = e.clientY;
      const startHeight = topHeight;

      const doDrag = (moveEvent: PointerEvent) => {
        const containerHeight = colContainerRef.current?.clientHeight || window.innerHeight;
        const maxTopHeight = Math.max(250, containerHeight - 250);
        const newHeight = Math.max(250, Math.min(maxTopHeight, startHeight + (moveEvent.clientY - startY)));

        if (side === 'left') {
          setUI({ leftTopHeight: newHeight });
        } else {
          setUI({ rightTopHeight: newHeight });
        }
      };

      const stopDrag = () => {
        window.removeEventListener('pointermove', doDrag);
        window.removeEventListener('pointerup', stopDrag);
      };
      window.addEventListener('pointermove', doDrag);
      window.addEventListener('pointerup', stopDrag);
    },
    [topHeight, side, setUI],
  );

  const handleVerticalResizeReset = useCallback(() => {
    if (side === 'left') {
      setUI({ leftTopHeight: DEFAULT_PANEL_SECTION_HEIGHT });
    } else {
      setUI({ rightTopHeight: DEFAULT_PANEL_SECTION_HEIGHT });
    }
  }, [side, setUI]);

  if (!hasTop && !hasBottom && !isDraggingLayout) return null;

  const renderRegion = (region: PanelRegion) => (
    <RegionDroppableContainer
      region={region}
      side={side}
      renderPanel={renderPanel}
      width={width}
      isInstantTransition={isInstantTransition}
      isResizing={isResizing}
    />
  );

  const isCollapsed = width < COLLAPSE_THRESHOLD;
  const shouldAnimateWidth = !isInstantTransition && (!isResizing || isCollapsed);

  if (showAdditionalTabs) {
    return (
      <div
        className={clsx(
          'flex shrink-0 h-full relative overflow-hidden',
          isFullScreen ? 'w-0 opacity-0 pointer-events-none' : 'opacity-100',
          shouldAnimateWidth && 'transition-all duration-300 ease-in-out',
        )}
        style={{ width: isFullScreen ? 0 : width }}
      >
        <div
          className="shrink-0 w-2 my-auto h-full cursor-col-resize z-20"
          onPointerDown={onWidthChange}
          onDoubleClick={onWidthReset}
        />
        <div className="flex-1 min-w-0 min-h-0 flex bg-bg-secondary rounded-lg overflow-hidden border border-surface">
          <div
            className={clsx(
              'relative flex-1 min-w-0 min-h-0 transition-opacity duration-200',
              isCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100 pointer-events-auto',
            )}
          >
            {activePanel && (
              <div className="absolute inset-0 overflow-y-auto custom-scrollbar">{renderPanel(activePanel)}</div>
            )}
          </div>
          <MobilePanelSwitcher
            activePanel={activePanel}
            onPanelSelect={(id) => {
              setPanel(id);
              if (isCollapsed) {
                setUI((s) => ({
                  uiVisibility: { ...s.uiVisibility, rightPanel: true },
                  rightPanelWidth: getReopenedPanelWidth(s.rightPanelWidth),
                }));
              }
            }}
            placement="right"
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className={clsx(
        'flex shrink-0 h-full relative overflow-hidden',
        isFullScreen ? 'w-0 opacity-0 pointer-events-none' : 'opacity-100',
        shouldAnimateWidth && 'transition-all duration-300 ease-in-out',
      )}
      style={{ width: isFullScreen ? 0 : width }}
    >
      {side === 'right' && (
        <div
          className="shrink-0 w-2 my-auto h-full cursor-col-resize z-20"
          onPointerDown={onWidthChange}
          onDoubleClick={onWidthReset}
        />
      )}

      <div ref={colContainerRef} className="flex flex-col h-full w-full overflow-hidden relative">
        {hasTop && (
          <div
            className="flex-1 overflow-hidden relative"
            style={{ flex: hasBottom ? `0 0 ${topHeight}px` : '1 1 auto' }}
          >
            {renderRegion(topRegion)}
          </div>
        )}

        {hasTop && hasBottom && (
          <div
            className="shrink-0 h-2 cursor-row-resize z-20"
            onPointerDown={handleVerticalResize}
            onDoubleClick={handleVerticalResizeReset}
          />
        )}

        {hasBottom && <div className="flex-1 overflow-hidden relative">{renderRegion(bottomRegion)}</div>}

        {!hasTop && !hasBottom && <div className="flex-1 relative overflow-hidden">{renderRegion(topRegion)}</div>}

        <AnimatePresence>
          {canSplit && <SplitDropZone key="top" side={side} slot="top" region={topRegion} />}
          {canSplit && <SplitDropZone key="bottom" side={side} slot="bottom" region={bottomRegion} />}
        </AnimatePresence>
      </div>

      {side === 'left' && (
        <div
          className="shrink-0 w-2 my-auto h-full cursor-col-resize z-20"
          onPointerDown={onWidthChange}
          onDoubleClick={onWidthReset}
        />
      )}
    </div>
  );
}
