# Layout System Specification

This document details the configuration-driven layout system for RapidRAW. The layout system provides structure and positioning without containing business logic.

## Core Concepts

### 1. Layouts vs Modules

- **Layouts**: Pure structure components - handle sizing, positioning, resizing
- **Modules**: Content components - connect to Blocs, render UI

Layouts know nothing about:
- Business logic
- State management
- What modules contain

Modules know nothing about:
- Their position in the layout
- Adjacent panels
- Container sizing

### 2. Configuration-Driven

Layouts are defined by configuration objects, not hardcoded JSX. This allows:
- User customization of panel sizes
- Saving/restoring layout preferences
- Different layouts for different views
- Runtime layout modifications

---

## Type Definitions

```typescript
// types/layout.ts

/**
 * Available layout types
 */
export type LayoutType = 'split' | 'stack' | 'tabs' | 'grid' | 'float';

/**
 * Base configuration for all layouts
 */
export interface BaseLayoutConfig {
  type: LayoutType;
  id?: string;
}

/**
 * Split layout - resizable horizontal or vertical panes
 */
export interface SplitLayoutConfig extends BaseLayoutConfig {
  type: 'split';
  direction: 'horizontal' | 'vertical';
  panels: PanelConfig[];
}

/**
 * Stack layout - vertical arrangement of fixed/flex elements
 */
export interface StackLayoutConfig extends BaseLayoutConfig {
  type: 'stack';
  direction?: 'vertical' | 'horizontal';
  gap?: number;
  children: (PanelConfig | LayoutConfig)[];
}

/**
 * Tabs layout - tabbed panel container
 */
export interface TabsLayoutConfig extends BaseLayoutConfig {
  type: 'tabs';
  position?: 'top' | 'bottom' | 'left' | 'right';
  tabs: TabConfig[];
  activeTab?: string;
}

/**
 * Grid layout - CSS grid-based arrangement
 */
export interface GridLayoutConfig extends BaseLayoutConfig {
  type: 'grid';
  columns: number | string; // number or CSS grid-template-columns
  rows?: number | string;
  gap?: number;
  items: GridItemConfig[];
}

/**
 * Float layout - floating/overlay panels
 */
export interface FloatLayoutConfig extends BaseLayoutConfig {
  type: 'float';
  children: FloatPanelConfig[];
}

/**
 * Panel configuration
 */
export interface PanelConfig {
  id: string;
  
  // Sizing
  size?: number;           // Fixed size in pixels
  minSize?: number;
  maxSize?: number;
  flex?: number;           // Flex grow factor (1 = fill available space)
  
  // Visibility
  visible?: boolean;       // Default: true
  collapsible?: boolean;   // Can be collapsed
  collapsed?: boolean;     // Initial collapsed state
  
  // Content
  modules?: string[];      // Module IDs to render
  layout?: LayoutConfig;   // Nested layout
  
  // Behavior
  resizable?: boolean;     // Default: true for split panels
  closable?: boolean;      // Can be closed by user
}

/**
 * Tab configuration
 */
export interface TabConfig {
  id: string;
  label: string;
  icon?: string;           // Lucide icon name
  modules?: string[];
  layout?: LayoutConfig;
  closable?: boolean;
}

/**
 * Grid item configuration
 */
export interface GridItemConfig {
  id: string;
  column?: number | string;  // Grid column (1-based) or span
  row?: number | string;     // Grid row (1-based) or span
  modules?: string[];
  layout?: LayoutConfig;
}

/**
 * Float panel configuration
 */
export interface FloatPanelConfig {
  id: string;
  position: {
    top?: number | string;
    right?: number | string;
    bottom?: number | string;
    left?: number | string;
  };
  size?: {
    width?: number | string;
    height?: number | string;
  };
  modules?: string[];
  draggable?: boolean;
  resizable?: boolean;
}

/**
 * Union type for all layout configs
 */
export type LayoutConfig = 
  | SplitLayoutConfig 
  | StackLayoutConfig 
  | TabsLayoutConfig 
  | GridLayoutConfig
  | FloatLayoutConfig;
```

---

## Layout Components

### SplitLayout

Resizable split panes with drag handles.

```typescript
// layouts/SplitLayout.tsx
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
    config.panels.forEach(panel => {
      if (panel.size) sizes[panel.id] = panel.size;
    });
    return sizes;
  });

  const isVertical = config.direction === 'vertical';

  const handleResize = useCallback((panelId: string, delta: number) => {
    const panel = config.panels.find(p => p.id === panelId);
    if (!panel) return;

    const currentSize = panelSizes[panelId] || panel.size || 200;
    const newSize = Math.max(
      panel.minSize || 100,
      Math.min(panel.maxSize || Infinity, currentSize + delta)
    );

    setPanelSizes(prev => ({ ...prev, [panelId]: newSize }));
    onPanelResize?.(panelId, newSize);
  }, [config.panels, panelSizes, onPanelResize]);

  const visiblePanels = config.panels.filter(p => p.visible !== false && !p.collapsed);

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
```

### StackLayout

Vertical or horizontal stack of elements.

```typescript
// layouts/StackLayout.tsx
import type { StackLayoutConfig, PanelConfig, LayoutConfig } from '../types/layout';

interface StackLayoutProps {
  config: StackLayoutConfig;
  renderPanel: (panel: PanelConfig) => React.ReactNode;
  renderLayout: (layout: LayoutConfig) => React.ReactNode;
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
        const isPanel = 'modules' in child || 'id' in child;
        const panel = child as PanelConfig;
        const layout = child as LayoutConfig;

        if (panel.visible === false) return null;

        const style: React.CSSProperties = {};
        
        if (isPanel && panel.size) {
          style[isVertical ? 'height' : 'width'] = panel.size;
          style.flexShrink = 0;
        } else if (isPanel && panel.flex) {
          style.flex = panel.flex;
        }

        return (
          <div key={panel.id || `layout-${index}`} style={style}>
            {isPanel ? renderPanel(panel) : renderLayout(layout)}
          </div>
        );
      })}
    </div>
  );
}
```

### TabsLayout

Tabbed panel container.

```typescript
// layouts/TabsLayout.tsx
import { useState } from 'react';
import type { TabsLayoutConfig, TabConfig } from '../types/layout';
import { Button } from '../primitives/Button';
import * as Icons from 'lucide-react';

interface TabsLayoutProps {
  config: TabsLayoutConfig;
  renderTab: (tab: TabConfig) => React.ReactNode;
  onTabChange?: (tabId: string) => void;
  onTabClose?: (tabId: string) => void;
}

export function TabsLayout({ config, renderTab, onTabChange, onTabClose }: TabsLayoutProps) {
  const [activeTab, setActiveTab] = useState(config.activeTab || config.tabs[0]?.id);
  const position = config.position || 'top';

  const handleTabClick = (tabId: string) => {
    setActiveTab(tabId);
    onTabChange?.(tabId);
  };

  const isVertical = position === 'left' || position === 'right';
  const tabsFirst = position === 'top' || position === 'left';

  const tabsContent = (
    <div className={`flex ${isVertical ? 'flex-col' : 'flex-row'} bg-bg-secondary border-border-color ${
      position === 'top' ? 'border-b' : 
      position === 'bottom' ? 'border-t' : 
      position === 'left' ? 'border-r' : 'border-l'
    }`}>
      {config.tabs.map(tab => {
        const isActive = tab.id === activeTab;
        const IconComponent = tab.icon ? (Icons as any)[tab.icon] : null;

        return (
          <button
            key={tab.id}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              isActive 
                ? 'bg-bg-primary text-text-primary border-accent' 
                : 'text-text-secondary hover:text-text-primary hover:bg-surface'
            } ${
              isVertical ? '' : `border-b-2 ${isActive ? '' : 'border-transparent'}`
            }`}
            onClick={() => handleTabClick(tab.id)}
          >
            <span className="flex items-center gap-2">
              {IconComponent && <IconComponent size={16} />}
              {tab.label}
            </span>
          </button>
        );
      })}
    </div>
  );

  const activeTabConfig = config.tabs.find(t => t.id === activeTab);
  const panelContent = activeTabConfig ? (
    <div className="flex-1 overflow-hidden">
      {renderTab(activeTabConfig)}
    </div>
  ) : null;

  return (
    <div className={`flex ${isVertical ? 'flex-row' : 'flex-col'} h-full w-full`}>
      {tabsFirst ? (
        <>
          {tabsContent}
          {panelContent}
        </>
      ) : (
        <>
          {panelContent}
          {tabsContent}
        </>
      )}
    </div>
  );
}
```

### GridLayout

CSS Grid-based layout.

```typescript
// layouts/GridLayout.tsx
import type { GridLayoutConfig, GridItemConfig } from '../types/layout';

interface GridLayoutProps {
  config: GridLayoutConfig;
  renderItem: (item: GridItemConfig) => React.ReactNode;
}

export function GridLayout({ config, renderItem }: GridLayoutProps) {
  const columns = typeof config.columns === 'number' 
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
      {config.items.map(item => (
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
```

---

## View Configurations

### Explore View Layout

```typescript
// config/layouts/explore.ts
import type { LayoutConfig } from '../../types/layout';

export const exploreLayout: LayoutConfig = {
  type: 'split',
  direction: 'horizontal',
  panels: [
    {
      id: 'left-sidebar',
      size: 256,
      minSize: 200,
      maxSize: 400,
      collapsible: true,
      modules: ['folder-tree'],
    },
    {
      id: 'main-content',
      flex: 1,
      layout: {
        type: 'stack',
        direction: 'vertical',
        children: [
          {
            id: 'toolbar',
            size: 80,
            modules: ['gallery-controls'],
          },
          {
            id: 'gallery',
            flex: 1,
            modules: ['gallery-grid'],
          },
        ],
      },
    },
    {
      id: 'right-sidebar',
      size: 320,
      minSize: 280,
      maxSize: 500,
      collapsible: true,
      visible: false,
      modules: ['metadata-panel'],
    },
  ],
};
```

### Edit View Layout

```typescript
// config/layouts/edit.ts
import type { LayoutConfig } from '../../types/layout';

export const editLayout: LayoutConfig = {
  type: 'split',
  direction: 'horizontal',
  panels: [
    {
      id: 'editor-main',
      flex: 1,
      layout: {
        type: 'stack',
        direction: 'vertical',
        children: [
          {
            id: 'editor-canvas',
            flex: 1,
            modules: ['image-preview', 'editor-toolbar'],
          },
          {
            id: 'filmstrip',
            size: 120,
            minSize: 80,
            maxSize: 200,
            collapsible: true,
            modules: ['filmstrip'],
          },
        ],
      },
    },
    {
      id: 'right-panel',
      size: 340,
      minSize: 300,
      maxSize: 500,
      collapsible: true,
      layout: {
        type: 'stack',
        direction: 'vertical',
        children: [
          {
            id: 'panel-tabs',
            size: 48,
            modules: ['panel-switcher'],
          },
          {
            id: 'active-panel',
            flex: 1,
            modules: ['adjustments-panel'], // Dynamic based on active tab
          },
          {
            id: 'metadata-bar',
            size: 60,
            collapsible: true,
            modules: ['rating-control', 'color-label'],
          },
        ],
      },
    },
  ],
};
```

### Edit View with Histogram Overlay

```typescript
// config/layouts/edit-with-histogram.ts
import type { LayoutConfig } from '../../types/layout';

export const editWithHistogramLayout: LayoutConfig = {
  type: 'float',
  children: [
    {
      id: 'main-layout',
      position: { top: 0, left: 0, right: 0, bottom: 0 },
      layout: editLayout,
    },
    {
      id: 'histogram-overlay',
      position: { top: 16, left: 16 },
      size: { width: 200, height: 120 },
      modules: ['image-histogram'],
      draggable: true,
    },
    {
      id: 'waveform-overlay',
      position: { top: 16, left: 232 },
      size: { width: 200, height: 120 },
      modules: ['image-waveform'],
      draggable: true,
      visible: false,
    },
  ],
};
```

---

## Layout Renderer

The main component that renders layouts recursively.

```typescript
// layouts/LayoutRenderer.tsx
import { Suspense } from 'react';
import type { LayoutConfig, PanelConfig, TabConfig, GridItemConfig } from '../types/layout';
import { SplitLayout } from './SplitLayout';
import { StackLayout } from './StackLayout';
import { TabsLayout } from './TabsLayout';
import { GridLayout } from './GridLayout';
import { FloatLayout } from './FloatLayout';
import { ModuleRenderer } from './ModuleRenderer';
import { LoadingSpinner } from '../modules/common/LoadingSpinner';

interface LayoutRendererProps {
  config: LayoutConfig;
  onLayoutChange?: (config: LayoutConfig) => void;
}

export function LayoutRenderer({ config, onLayoutChange }: LayoutRendererProps) {
  const renderModules = (modules: string[] | undefined) => {
    if (!modules || modules.length === 0) return null;
    
    return (
      <div className="h-full w-full">
        {modules.map(moduleId => (
          <Suspense key={moduleId} fallback={<LoadingSpinner />}>
            <ModuleRenderer moduleId={moduleId} />
          </Suspense>
        ))}
      </div>
    );
  };

  const renderPanel = (panel: PanelConfig): React.ReactNode => {
    if (panel.layout) {
      return <LayoutRenderer config={panel.layout} onLayoutChange={onLayoutChange} />;
    }
    return renderModules(panel.modules);
  };

  const renderLayout = (layout: LayoutConfig): React.ReactNode => {
    return <LayoutRenderer config={layout} onLayoutChange={onLayoutChange} />;
  };

  const renderTab = (tab: TabConfig): React.ReactNode => {
    if (tab.layout) {
      return <LayoutRenderer config={tab.layout} onLayoutChange={onLayoutChange} />;
    }
    return renderModules(tab.modules);
  };

  const renderItem = (item: GridItemConfig): React.ReactNode => {
    if (item.layout) {
      return <LayoutRenderer config={item.layout} onLayoutChange={onLayoutChange} />;
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
            // Update config and notify parent
            const newConfig = { ...config };
            const panel = newConfig.panels.find(p => p.id === panelId);
            if (panel) panel.size = newSize;
            onLayoutChange?.(newConfig);
          }}
        />
      );

    case 'stack':
      return (
        <StackLayout
          config={config}
          renderPanel={renderPanel}
          renderLayout={renderLayout}
        />
      );

    case 'tabs':
      return (
        <TabsLayout
          config={config}
          renderTab={renderTab}
          onTabChange={(tabId) => {
            const newConfig = { ...config, activeTab: tabId };
            onLayoutChange?.(newConfig);
          }}
        />
      );

    case 'grid':
      return (
        <GridLayout
          config={config}
          renderItem={renderItem}
        />
      );

    case 'float':
      return (
        <FloatLayout
          config={config}
          renderPanel={renderPanel}
        />
      );

    default:
      return null;
  }
}
```

### ModuleRenderer

Renders individual modules from the registry.

```typescript
// layouts/ModuleRenderer.tsx
import { moduleRegistry, ModuleId } from '../modules/registry';

interface ModuleRendererProps {
  moduleId: string;
}

export function ModuleRenderer({ moduleId }: ModuleRendererProps) {
  const Module = moduleRegistry[moduleId as ModuleId];
  
  if (!Module) {
    console.warn(`Module "${moduleId}" not found in registry`);
    return (
      <div className="h-full w-full flex items-center justify-center text-text-secondary">
        Module not found: {moduleId}
      </div>
    );
  }

  return <Module />;
}
```

---

## Layout Bloc

State management for layout configuration.

```typescript
// blocs/app/LayoutBloc.ts
import { Cubit, blac, borrow } from '@blac/core';
import type { LayoutConfig } from '../../types/layout';
import { exploreLayout } from '../../config/layouts/explore';
import { editLayout } from '../../config/layouts/edit';
import { SettingsBloc } from './SettingsBloc';

type ViewId = 'explore' | 'edit' | 'community';

interface LayoutState {
  layouts: Record<ViewId, LayoutConfig>;
  panelSizes: Record<string, number>;
  collapsedPanels: Set<string>;
}

const DEFAULT_LAYOUTS: Record<ViewId, LayoutConfig> = {
  explore: exploreLayout,
  edit: editLayout,
  community: { type: 'stack', children: [{ id: 'community', flex: 1, modules: ['community-page'] }] },
};

@blac({ keepAlive: true })
export class LayoutBloc extends Cubit<LayoutState> {
  constructor() {
    super({
      layouts: { ...DEFAULT_LAYOUTS },
      panelSizes: {},
      collapsedPanels: new Set(),
    });
  }

  getLayout = (viewId: ViewId): LayoutConfig => {
    return this.state.layouts[viewId] || DEFAULT_LAYOUTS[viewId];
  };

  updateLayout = (viewId: ViewId, config: LayoutConfig) => {
    this.update(state => ({
      ...state,
      layouts: { ...state.layouts, [viewId]: config },
    }));
    this.persistLayouts();
  };

  setPanelSize = (panelId: string, size: number) => {
    this.update(state => ({
      ...state,
      panelSizes: { ...state.panelSizes, [panelId]: size },
    }));
    this.persistLayouts();
  };

  togglePanelCollapse = (panelId: string) => {
    this.update(state => {
      const newCollapsed = new Set(state.collapsedPanels);
      if (newCollapsed.has(panelId)) {
        newCollapsed.delete(panelId);
      } else {
        newCollapsed.add(panelId);
      }
      return { ...state, collapsedPanels: newCollapsed };
    });
    this.persistLayouts();
  };

  isPanelCollapsed = (panelId: string): boolean => {
    return this.state.collapsedPanels.has(panelId);
  };

  resetLayout = (viewId: ViewId) => {
    this.update(state => ({
      ...state,
      layouts: { ...state.layouts, [viewId]: DEFAULT_LAYOUTS[viewId] },
    }));
    this.persistLayouts();
  };

  resetAllLayouts = () => {
    this.emit({
      layouts: { ...DEFAULT_LAYOUTS },
      panelSizes: {},
      collapsedPanels: new Set(),
    });
    this.persistLayouts();
  };

  private persistLayouts = () => {
    // Save to settings
    borrow(SettingsBloc).updateSettings({
      layoutConfig: {
        layouts: this.state.layouts,
        panelSizes: this.state.panelSizes,
        collapsedPanels: Array.from(this.state.collapsedPanels),
      },
    });
  };

  loadFromSettings = () => {
    const settings = borrow(SettingsBloc);
    const layoutConfig = settings.state.settings.layoutConfig;
    if (layoutConfig) {
      this.emit({
        layouts: layoutConfig.layouts || DEFAULT_LAYOUTS,
        panelSizes: layoutConfig.panelSizes || {},
        collapsedPanels: new Set(layoutConfig.collapsedPanels || []),
      });
    }
  };
}
```

---

## View Components

Views compose layouts with the appropriate configuration.

```typescript
// views/ExploreView/ExploreView.tsx
import { useBloc } from '@blac/react';
import { LayoutBloc } from '../../blocs/app/LayoutBloc';
import { LibraryBloc } from '../../blocs/library/LibraryBloc';
import { LayoutRenderer } from '../../layouts/LayoutRenderer';
import { WelcomeScreen } from '../../modules/library/WelcomeScreen';

export function ExploreView() {
  const [layout, layoutBloc] = useBloc(LayoutBloc);
  const [library] = useBloc(LibraryBloc);

  // Show welcome screen if no folder is open
  if (!library.rootPath) {
    return <WelcomeScreen />;
  }

  const config = layout.getLayout('explore');

  return (
    <div className="h-full w-full bg-bg-primary">
      <LayoutRenderer
        config={config}
        onLayoutChange={(newConfig) => layoutBloc.updateLayout('explore', newConfig)}
      />
    </div>
  );
}
```

```typescript
// views/EditView/EditView.tsx
import { useBloc } from '@blac/react';
import { LayoutBloc } from '../../blocs/app/LayoutBloc';
import { EditorBloc } from '../../blocs/editor/EditorBloc';
import { LayoutRenderer } from '../../layouts/LayoutRenderer';

export function EditView() {
  const [layout, layoutBloc] = useBloc(LayoutBloc);
  const [editor] = useBloc(EditorBloc);

  if (!editor.selectedImage) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-bg-primary">
        <p className="text-text-secondary">No image selected</p>
      </div>
    );
  }

  const config = layout.getLayout('edit');

  return (
    <div className="h-full w-full bg-bg-primary">
      <LayoutRenderer
        config={config}
        onLayoutChange={(newConfig) => layoutBloc.updateLayout('edit', newConfig)}
      />
    </div>
  );
}
```

---

## Keyboard Shortcuts for Layout

```typescript
// config/shortcuts/layout.ts
import { borrow } from '@blac/core';
import { KeyboardService } from '../../blocs/services/KeyboardService';
import { LayoutBloc } from '../../blocs/app/LayoutBloc';
import { UIBloc } from '../../blocs/app/UIBloc';
import { AppBloc } from '../../blocs/app/AppBloc';

export function registerLayoutShortcuts() {
  const keyboard = borrow(KeyboardService);

  // Toggle panels
  keyboard.registerShortcut({
    key: '[',
    handler: () => borrow(UIBloc).toggleLeftSidebar(),
    context: 'global',
  });

  keyboard.registerShortcut({
    key: ']',
    handler: () => borrow(UIBloc).toggleRightPanel(),
    context: 'global',
  });

  keyboard.registerShortcut({
    key: '\\',
    ctrl: true,
    handler: () => borrow(UIBloc).toggleBottomPanel(),
    context: 'edit',
  });

  // Reset layout
  keyboard.registerShortcut({
    key: 'r',
    ctrl: true,
    shift: true,
    handler: () => {
      const app = borrow(AppBloc);
      borrow(LayoutBloc).resetLayout(app.state.activeView);
    },
    context: 'global',
  });
}
```

---

## Resizer Primitive

The draggable resize handle used by SplitLayout.

```typescript
// primitives/Resizer.tsx
import { useRef, useCallback, useEffect } from 'react';

interface ResizerProps {
  direction: 'horizontal' | 'vertical';
  onResize: (delta: number) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
}

export function Resizer({ direction, onResize, onResizeStart, onResizeEnd }: ResizerProps) {
  const isDragging = useRef(false);
  const lastPosition = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    lastPosition.current = direction === 'horizontal' ? e.clientY : e.clientX;
    onResizeStart?.();
    document.body.style.cursor = direction === 'horizontal' ? 'row-resize' : 'col-resize';
  }, [direction, onResizeStart]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      
      const currentPosition = direction === 'horizontal' ? e.clientY : e.clientX;
      const delta = currentPosition - lastPosition.current;
      lastPosition.current = currentPosition;
      
      onResize(delta);
    };

    const handleMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false;
        onResizeEnd?.();
        document.body.style.cursor = '';
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [direction, onResize, onResizeEnd]);

  const isHorizontal = direction === 'horizontal';

  return (
    <div
      className={`
        ${isHorizontal ? 'h-1 w-full cursor-row-resize' : 'w-1 h-full cursor-col-resize'}
        bg-border-color hover:bg-accent transition-colors
        flex-shrink-0
      `}
      onMouseDown={handleMouseDown}
    >
      <div
        className={`
          ${isHorizontal ? 'h-full w-8 mx-auto' : 'w-full h-8 my-auto'}
          hover:bg-accent/20
        `}
      />
    </div>
  );
}
```

---

## Summary

The layout system provides:

1. **Type-safe configuration** - Full TypeScript types for all layout options
2. **Composable layouts** - Layouts can be nested arbitrarily deep
3. **User customization** - Panel sizes and visibility are persisted
4. **Separation of concerns** - Layouts handle structure, modules handle content
5. **Dynamic rendering** - Modules are lazy-loaded from a registry
6. **State management** - Layout state lives in `LayoutBloc`, synced to settings

This system allows the UI to be rearranged, customized, and extended without modifying component code - just update the configuration objects.
