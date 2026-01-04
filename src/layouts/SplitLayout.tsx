import { useState, useCallback, useRef } from 'react';
import { Resizer } from '../primitives/Resizer';
import type { SplitLayoutConfig, PanelConfig } from '../types/layout';

interface SplitLayoutProps {
  config: SplitLayoutConfig;
  renderPanel: (panel: PanelConfig) => React.ReactNode;
  onPanelResize?: (panelId: string, newSize: number) => void;
}

export function SplitLayout({ config, renderPanel, onPanelResize }: SplitLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [panelSizes, setPanelSizes] = useState<Record<string, number>>(() => {
    const sizes: Record<string, number> = {};
    config.panels.forEach((panel) => {
      if (panel.size) sizes[panel.id] = panel.size;
    });
    return sizes;
  });

  const isVertical = config.direction === 'vertical';

  const handleResize = useCallback(
    (panelId: string, delta: number) => {
      const panel = config.panels.find((p) => p.id === panelId);
      if (!panel) return;

      const currentSize = panelSizes[panelId] || panel.size || 200;
      const newSize = Math.max(
        panel.minSize || 100,
        Math.min(panel.maxSize || Infinity, currentSize + delta)
      );

      setPanelSizes((prev) => ({ ...prev, [panelId]: newSize }));
      onPanelResize?.(panelId, newSize);
    },
    [config.panels, panelSizes, onPanelResize]
  );

  const visiblePanels = config.panels.filter((p) => p.visible !== false && !p.collapsed);

  return (
    <div
      ref={containerRef}
      className={`flex ${isVertical ? 'flex-col' : 'flex-row'} h-full w-full`}
    >
      {visiblePanels.map((panel, index) => {
        const size = panelSizes[panel.id] || panel.size;
        const isLast = index === visiblePanels.length - 1;
        const showResizer = !isLast && panel.resizable !== false;

        return (
          <div key={panel.id} className="contents">
            <div
              className="overflow-hidden"
              style={{
                [isVertical ? 'height' : 'width']: panel.flex ? undefined : size,
                [isVertical ? 'minHeight' : 'minWidth']: panel.minSize,
                [isVertical ? 'maxHeight' : 'maxWidth']: panel.maxSize,
                flex: panel.flex || 'none',
              }}
            >
              {renderPanel(panel)}
            </div>
            {showResizer && (
              <Resizer
                direction={isVertical ? 'horizontal' : 'vertical'}
                onResize={(delta) => handleResize(panel.id, delta)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
