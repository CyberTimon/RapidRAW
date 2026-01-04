import type { StackLayoutConfig, PanelConfig, LayoutConfig } from '../types/layout';

interface StackLayoutProps {
  config: StackLayoutConfig;
  renderPanel: (panel: PanelConfig) => React.ReactNode;
  renderLayout: (layout: LayoutConfig) => React.ReactNode;
}

function isPanelConfig(child: PanelConfig | LayoutConfig): child is PanelConfig {
  return 'id' in child && typeof (child as PanelConfig).id === 'string';
}

export function StackLayout({ config, renderPanel, renderLayout }: StackLayoutProps) {
  const isVertical = config.direction !== 'horizontal';
  const gap = config.gap ?? 0;

  return (
    <div
      className={`flex ${isVertical ? 'flex-col' : 'flex-row'} h-full w-full`}
      style={{ gap }}
    >
      {config.children.map((child, index) => {
        if (isPanelConfig(child)) {
          const panel = child;

          if (panel.visible === false) return null;

          const style: React.CSSProperties = {};

          if (panel.size) {
            style[isVertical ? 'height' : 'width'] = panel.size;
            style.flexShrink = 0;
          } else if (panel.flex) {
            style.flex = panel.flex;
          }

          return (
            <div key={panel.id} style={style} className="overflow-hidden">
              {renderPanel(panel)}
            </div>
          );
        } else {
          const layout = child as LayoutConfig;
          return (
            <div key={`layout-${index}`} className="flex-1 overflow-hidden">
              {renderLayout(layout)}
            </div>
          );
        }
      })}
    </div>
  );
}
