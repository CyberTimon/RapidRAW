import { Suspense } from 'react';
import type { LayoutConfig, PanelConfig, TabConfig, GridItemConfig } from '../types/layout';
import { SplitLayout } from './SplitLayout';
import { StackLayout } from './StackLayout';

interface LayoutRendererProps {
  config: LayoutConfig;
  onLayoutChange?: (config: LayoutConfig) => void;
  moduleRenderer?: (moduleId: string) => React.ReactNode;
}

function LoadingSpinner() {
  return (
    <div className="h-full w-full flex items-center justify-center">
      <div className="animate-spin rounded-full h-6 w-6 border-2 border-accent border-t-transparent" />
    </div>
  );
}

export function LayoutRenderer({
  config,
  onLayoutChange,
  moduleRenderer,
}: LayoutRendererProps) {
  const renderModules = (modules: string[] | undefined) => {
    if (!modules || modules.length === 0) return null;

    return (
      <div className="h-full w-full">
        {modules.map((moduleId) => (
          <Suspense key={moduleId} fallback={<LoadingSpinner />}>
            {moduleRenderer ? (
              moduleRenderer(moduleId)
            ) : (
              <div className="h-full w-full flex items-center justify-center text-text-secondary">
                Module: {moduleId}
              </div>
            )}
          </Suspense>
        ))}
      </div>
    );
  };

  const renderPanel = (panel: PanelConfig): React.ReactNode => {
    if (panel.layout) {
      return (
        <LayoutRenderer
          config={panel.layout}
          onLayoutChange={onLayoutChange}
          moduleRenderer={moduleRenderer}
        />
      );
    }
    return renderModules(panel.modules);
  };

  const renderLayout = (layout: LayoutConfig): React.ReactNode => {
    return (
      <LayoutRenderer
        config={layout}
        onLayoutChange={onLayoutChange}
        moduleRenderer={moduleRenderer}
      />
    );
  };

  const renderTab = (tab: TabConfig): React.ReactNode => {
    if (tab.layout) {
      return (
        <LayoutRenderer
          config={tab.layout}
          onLayoutChange={onLayoutChange}
          moduleRenderer={moduleRenderer}
        />
      );
    }
    return renderModules(tab.modules);
  };

  const renderItem = (item: GridItemConfig): React.ReactNode => {
    if (item.layout) {
      return (
        <LayoutRenderer
          config={item.layout}
          onLayoutChange={onLayoutChange}
          moduleRenderer={moduleRenderer}
        />
      );
    }
    return renderModules(item.modules);
  };

  switch (config.type) {
    case 'split':
      return (
        <SplitLayout
          config={config}
          renderPanel={renderPanel}
          onPanelResize={(panelId, newSize) => {
            const newConfig = { ...config };
            const panel = newConfig.panels.find((p) => p.id === panelId);
            if (panel) panel.size = newSize;
            onLayoutChange?.(newConfig);
          }}
        />
      );

    case 'stack':
      return <StackLayout config={config} renderPanel={renderPanel} renderLayout={renderLayout} />;

    case 'tabs': {
      const activeTab = config.activeTab || config.tabs[0]?.id;
      const activeTabConfig = config.tabs.find((t) => t.id === activeTab);

      return (
        <div className="flex flex-col h-full w-full">
          <div className="flex border-b border-border-color bg-bg-secondary">
            {config.tabs.map((tab) => (
              <button
                key={tab.id}
                className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
                  tab.id === activeTab
                    ? 'border-accent text-accent'
                    : 'border-transparent text-text-secondary hover:text-text-primary hover:bg-surface'
                }`}
                onClick={() => {
                  const newConfig = { ...config, activeTab: tab.id };
                  onLayoutChange?.(newConfig);
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-hidden">
            {activeTabConfig && renderTab(activeTabConfig)}
          </div>
        </div>
      );
    }

    case 'grid': {
      const columns =
        typeof config.columns === 'number'
          ? `repeat(${config.columns}, 1fr)`
          : config.columns;

      const rows = config.rows
        ? typeof config.rows === 'number'
          ? `repeat(${config.rows}, 1fr)`
          : config.rows
        : undefined;

      return (
        <div
          className="h-full w-full"
          style={{
            display: 'grid',
            gridTemplateColumns: columns,
            gridTemplateRows: rows,
            gap: config.gap ?? 0,
          }}
        >
          {config.items.map((item) => (
            <div
              key={item.id}
              style={{
                gridColumn: item.column,
                gridRow: item.row,
              }}
            >
              {renderItem(item)}
            </div>
          ))}
        </div>
      );
    }

    case 'float':
      return (
        <div className="relative h-full w-full">
          {config.children.map((panel) => {
            if (panel.visible === false) return null;

            return (
              <div
                key={panel.id}
                className="absolute bg-bg-primary border border-border-color rounded-lg shadow-lg overflow-hidden"
                style={{
                  top: panel.position.top,
                  right: panel.position.right,
                  bottom: panel.position.bottom,
                  left: panel.position.left,
                  width: panel.size?.width,
                  height: panel.size?.height,
                }}
              >
                {renderModules(panel.modules)}
              </div>
            );
          })}
        </div>
      );

    default:
      return null;
  }
}
