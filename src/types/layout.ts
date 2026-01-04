export type LayoutType = 'split' | 'stack' | 'tabs' | 'grid' | 'float';

export interface BaseLayoutConfig {
  type: LayoutType;
  id?: string;
}

export interface SplitLayoutConfig extends BaseLayoutConfig {
  type: 'split';
  direction: 'horizontal' | 'vertical';
  panels: PanelConfig[];
}

export interface StackLayoutConfig extends BaseLayoutConfig {
  type: 'stack';
  direction?: 'vertical' | 'horizontal';
  gap?: number;
  children: (PanelConfig | LayoutConfig)[];
}

export interface TabsLayoutConfig extends BaseLayoutConfig {
  type: 'tabs';
  position?: 'top' | 'bottom' | 'left' | 'right';
  tabs: TabConfig[];
  activeTab?: string;
}

export interface GridLayoutConfig extends BaseLayoutConfig {
  type: 'grid';
  columns: number | string;
  rows?: number | string;
  gap?: number;
  items: GridItemConfig[];
}

export interface FloatLayoutConfig extends BaseLayoutConfig {
  type: 'float';
  children: FloatPanelConfig[];
}

export interface PanelConfig {
  id: string;
  size?: number;
  minSize?: number;
  maxSize?: number;
  flex?: number;
  visible?: boolean;
  collapsible?: boolean;
  collapsed?: boolean;
  modules?: string[];
  layout?: LayoutConfig;
  resizable?: boolean;
  closable?: boolean;
}

export interface TabConfig {
  id: string;
  label: string;
  icon?: string;
  modules?: string[];
  layout?: LayoutConfig;
  closable?: boolean;
}

export interface GridItemConfig {
  id: string;
  column?: number | string;
  row?: number | string;
  modules?: string[];
  layout?: LayoutConfig;
}

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
  layout?: LayoutConfig;
  draggable?: boolean;
  resizable?: boolean;
  visible?: boolean;
}

export type LayoutConfig =
  | SplitLayoutConfig
  | StackLayoutConfig
  | TabsLayoutConfig
  | GridLayoutConfig
  | FloatLayoutConfig;
