import { useState, useCallback, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { useDroppable, useDndMonitor } from '@dnd-kit/core';
import { DEFAULT_PANEL_SECTION_HEIGHT, SwitcherPlacement, useUIStore } from '../../store/useUIStore';
import { Panel, PanelRegion } from '../ui/AppProperties';
import PanelSwitcher from './PanelSwitcher';

const COLLAPSE_THRESHOLD = 200;

interface SidePanelAreaProps {
  side: 'left' | 'right';
  width: number;
  topRegion: PanelRegion;
  bottomRegion: PanelRegion;
  renderPanel: (panel: Panel) => React.ReactNode;
  onWidthChange: (e: React.PointerEvent<HTMLDivElement>) => void;
  onWidthReset: () => void;
  isResizing: boolean;
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
  side: 'left' | 'right';
  renderPanel: (panel: Panel) => React.ReactNode;
  width: number;
  isInstantTransition: boolean;
  isResizing: boolean;
}) {
  const panelLayout = useUIStore((s) => s.panelLayout);
  const activePanels = useUIStore((s) => s.activePanels);
  const setActivePanel = useUIStore((s) => s.setActivePanel);

  const placement = useUIStore((s) => s.panelSwitcherPlacement[region]);
  const setPanelSwitcherPlacement = useUIStore((s) => s.setPanelSwitcherPlacement);

  const [hoverPlacement, setHoverPlacement] = useState<SwitcherPlacement | null>(null);
  const hoverPlacementRef = useRef<SwitcherPlacement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const panelsInRegion = panelLayout[region];
  const activePanel = activePanels[region] ?? (panelsInRegion.length > 0 ? panelsInRegion[0] : null);

  const { setNodeRef, isOver, active } = useDroppable({
    id: `layout-region-${region}`,
    data: { type: 'layout-region', region },
  });

  const isLayoutDrag = active?.data?.current?.type === 'layout-tab';
  const isActualOver = isOver && isLayoutDrag;

  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node);
      containerRef.current = node;
    },
    [setNodeRef],
  );

  useDndMonitor({
    onDragMove(event) {
      if (event.active.data.current?.type !== 'layout-tab') return;

      if (event.over?.id !== `layout-region-${region}` || !containerRef.current) {
        if (hoverPlacementRef.current !== null) {
          hoverPlacementRef.current = null;
          setHoverPlacement(null);
        }
        return;
      }

      const rect = containerRef.current.getBoundingClientRect();
      const activeRect = event.active.rect.current.translated;
      if (!activeRect) return;

      const x = activeRect.left + activeRect.width / 2 - rect.left;
      const y = activeRect.top + activeRect.height / 2 - rect.top;

      let intendedPlacement: SwitcherPlacement = 'bottom';
      if (side === 'left') {
        const isTopLeft = y < (-rect.height / rect.width) * x + rect.height;
        intendedPlacement = isTopLeft ? 'left' : 'bottom';
      } else {
        const isTopRight = y < (rect.height / rect.width) * x;
        intendedPlacement = isTopRight ? 'right' : 'bottom';
      }

      if (hoverPlacementRef.current !== intendedPlacement) {
        hoverPlacementRef.current = intendedPlacement;
        setHoverPlacement(intendedPlacement);
      }
    },
    onDragEnd(event) {
      if (event.over?.id === `layout-region-${region}` && hoverPlacementRef.current) {
        setPanelSwitcherPlacement(region, hoverPlacementRef.current);
      }
      hoverPlacementRef.current = null;
      setHoverPlacement(null);
    },
  });

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
      ref={setRefs}
      className={clsx(
        'flex h-full w-full bg-bg-secondary rounded-lg overflow-hidden border transition-colors shadow-xs relative',
        isFlexRow ? 'flex-row' : 'flex-col',
        isActualOver && !hoverPlacement ? 'border-accent' : 'border-surface',
      )}
    >
      <AnimatePresence>
        {isActualOver && !hoverPlacement && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 z-40 bg-accent/10 backdrop-blur-sm pointer-events-none rounded-lg"
          />
        )}

        {isActualOver && hoverPlacement && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 z-50 pointer-events-none rounded-lg overflow-hidden"
          >
            <div
              className={clsx(
                'absolute inset-0 bg-accent/10 transition-all duration-200',
                hoverPlacement === 'bottom' && 'border-b-4 border-accent',
                hoverPlacement === 'right' && 'border-r-4 border-accent',
                hoverPlacement === 'left' && 'border-l-4 border-accent',
                hoverPlacement === 'top' && 'border-t-4 border-accent',
              )}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <div
        className={clsx(
          'flex flex-1 w-full h-full min-w-0 min-h-0 overflow-hidden transition-opacity duration-300 ease-in-out',
          isFlexRow ? 'flex-row' : 'flex-col',
          isCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100 pointer-events-auto',
        )}
      >
        {showSwitcherFirst && <PanelSwitcher region={region} side={side} placement={placement} />}

        <div className="flex-1 overflow-hidden relative min-w-0" onPointerDownCapture={handleContentInteraction}>
          <AnimatePresence mode="wait">
            {activePanel && (
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
            )}
          </AnimatePresence>
        </div>

        {!showSwitcherFirst && <PanelSwitcher region={region} side={side} placement={placement} />}
      </div>
    </div>
  );
}

function SplitOverlayDropzone({
  region,
  side,
  isTop,
}: {
  region: PanelRegion;
  side: 'left' | 'right';
  isTop: boolean;
}) {
  const { t } = useTranslation();
  const setPanelSwitcherPlacement = useUIStore((s) => s.setPanelSwitcherPlacement);

  const [hoverPlacement, setHoverPlacement] = useState<SwitcherPlacement | null>(null);
  const hoverPlacementRef = useRef<SwitcherPlacement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const { setNodeRef, isOver, active } = useDroppable({
    id: `layout-region-${region}`,
    data: { type: 'layout-region', region },
  });

  const isLayoutDrag = active?.data?.current?.type === 'layout-tab';
  const isActualOver = isOver && isLayoutDrag;

  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node);
      containerRef.current = node;
    },
    [setNodeRef],
  );

  useDndMonitor({
    onDragMove(event) {
      if (event.active.data.current?.type !== 'layout-tab') return;

      if (event.over?.id !== `layout-region-${region}` || !containerRef.current) {
        if (hoverPlacementRef.current !== null) {
          hoverPlacementRef.current = null;
          setHoverPlacement(null);
        }
        return;
      }

      const rect = containerRef.current.getBoundingClientRect();
      const activeRect = event.active.rect.current.translated;
      if (!activeRect) return;

      const x = activeRect.left + activeRect.width / 2 - rect.left;
      const y = activeRect.top + activeRect.height / 2 - rect.top;

      let intendedPlacement: SwitcherPlacement = 'bottom';
      if (side === 'left') {
        const isTopLeft = y < (-rect.height / rect.width) * x + rect.height;
        intendedPlacement = isTopLeft ? 'left' : 'bottom';
      } else {
        const isTopRight = y < (rect.height / rect.width) * x;
        intendedPlacement = isTopRight ? 'right' : 'bottom';
      }

      if (hoverPlacementRef.current !== intendedPlacement) {
        hoverPlacementRef.current = intendedPlacement;
        setHoverPlacement(intendedPlacement);
      }
    },
    onDragEnd(event) {
      if (event.over?.id === `layout-region-${region}` && hoverPlacementRef.current) {
        setPanelSwitcherPlacement(region, hoverPlacementRef.current);
      }
      hoverPlacementRef.current = null;
      setHoverPlacement(null);
    },
  });

  return (
    <motion.div
      ref={setRefs}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className={clsx(
        'absolute inset-x-0 h-1/2 z-30 border-2 flex items-center justify-center transition-all duration-200 backdrop-blur-sm overflow-hidden',
        isTop ? 'top-0 rounded-t-lg' : 'bottom-0 rounded-b-lg',
        isActualOver
          ? 'scale-[0.98] text-accent font-semibold border-transparent'
          : 'border-dashed border-accent/40 bg-bg-secondary/60 text-text-secondary',
      )}
    >
      <AnimatePresence>
        {isActualOver && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className={clsx(
              'absolute inset-0 z-0 pointer-events-none overflow-hidden',
              isTop ? 'rounded-t-lg' : 'rounded-b-lg',
            )}
          >
            <div
              className={clsx(
                'absolute inset-0 bg-accent/20 transition-all duration-200',
                hoverPlacement === 'bottom' && 'border-b-4 border-accent',
                hoverPlacement === 'right' && 'border-r-4 border-accent',
                hoverPlacement === 'left' && 'border-l-4 border-accent',
                hoverPlacement === 'top' && 'border-t-4 border-accent',
              )}
            />
          </motion.div>
        )}
      </AnimatePresence>
      <span className="text-xs uppercase tracking-wider relative z-10 pointer-events-none">
        {t('editor.layout.split')}
      </span>
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
}: SidePanelAreaProps) {
  const panelLayout = useUIStore((s) => s.panelLayout);
  const isFullScreen = useUIStore((s) => s.isFullScreen);
  const isInstantTransition = useUIStore((s) => s.isInstantTransition);
  const activeLayoutDragItem = useUIStore((s) => s.activeLayoutDragItem);
  const isDraggingLayout = !!activeLayoutDragItem;

  const topPlacement = useUIStore((s) => s.panelSwitcherPlacement[topRegion]);
  const bottomPlacement = useUIStore((s) => s.panelSwitcherPlacement[bottomRegion]);

  const topHeight = useUIStore((s) => (side === 'left' ? s.leftTopHeight : s.rightTopHeight));
  const setUI = useUIStore((s) => s.setUI);

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

  const topPanels = panelLayout[topRegion];
  const bottomPanels = panelLayout[bottomRegion];

  const hasTop = topPanels.length > 0;
  const hasBottom = bottomPanels.length > 0;

  if (!hasTop && !hasBottom && !isDraggingLayout) return null;

  const canSplitTop =
    topPanels.length > 1 || (activeLayoutDragItem !== null && !topPanels.includes(activeLayoutDragItem));
  const canSplitBottom =
    bottomPanels.length > 1 || (activeLayoutDragItem !== null && !bottomPanels.includes(activeLayoutDragItem));

  const topSplitIsTop = topPlacement === 'bottom';
  const bottomSplitIsTop = bottomPlacement !== 'top';

  const isCollapsed = width < COLLAPSE_THRESHOLD;
  const shouldAnimateWidth = !isInstantTransition && (!isResizing || isCollapsed);

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
            <RegionDroppableContainer
              region={topRegion}
              side={side}
              renderPanel={renderPanel}
              width={width}
              isInstantTransition={isInstantTransition}
              isResizing={isResizing}
            />

            <AnimatePresence>
              {!hasBottom && isDraggingLayout && canSplitTop && (
                <SplitOverlayDropzone region={bottomRegion} side={side} isTop={topSplitIsTop} />
              )}
            </AnimatePresence>
          </div>
        )}

        {hasTop && hasBottom && (
          <div
            className="shrink-0 h-2 cursor-row-resize z-20"
            onPointerDown={handleVerticalResize}
            onDoubleClick={handleVerticalResizeReset}
          />
        )}

        {hasBottom && (
          <div className="flex-1 overflow-hidden relative">
            <AnimatePresence>
              {!hasTop && isDraggingLayout && canSplitBottom && (
                <SplitOverlayDropzone region={topRegion} side={side} isTop={bottomSplitIsTop} />
              )}
            </AnimatePresence>

            <RegionDroppableContainer
              region={bottomRegion}
              side={side}
              renderPanel={renderPanel}
              width={width}
              isInstantTransition={isInstantTransition}
              isResizing={isResizing}
            />
          </div>
        )}

        {!hasTop && !hasBottom && isDraggingLayout && (
          <div className="flex-1 relative overflow-hidden">
            <RegionDroppableContainer
              region={topRegion}
              side={side}
              renderPanel={renderPanel}
              width={width}
              isInstantTransition={isInstantTransition}
              isResizing={isResizing}
            />
          </div>
        )}
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
