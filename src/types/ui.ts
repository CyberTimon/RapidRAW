import type { ShortcutAction } from '../utils/keyboardUtils';

export const GLOBAL_KEYS = [
  ' ',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'f',
  'b',
  'a',
  's',
  'd',
  'r',
  'm',
  'k',
  'p',
  'i',
  'e',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  'Enter',
];

export const OPTION_SEPARATOR = 'separator';

export enum Panel {
  Adjustments = 'adjustments',
  Ai = 'ai',
  Crop = 'crop',
  Export = 'export',
  Masks = 'masks',
  Metadata = 'metadata',
  Presets = 'presets',
  FolderTree = 'folderTree',
  Tethering = 'tethering',
  Filmstrip = 'filmstrip',
  MediaPool = 'mediaPool',
  Inspector = 'inspector',
  Effects = 'effects',
  Captions = 'captions',
  Mixer = 'mixer',
}

export type PanelRegion = 'leftTop' | 'leftBottom' | 'rightTop' | 'rightBottom';

export interface Option {
  color?: string;
  disabled?: boolean;
  icon?: any;
  isDestructive?: boolean;
  label?: string;
  onClick?(): void;
  onRightClick?(): void;
  shortcut?: ShortcutAction;
  submenu?: any;
  tooltip?: string;
  type?: string;
}

export enum Orientation {
  Horizontal = 'horizontal',
  Vertical = 'vertical',
}

export interface UiVisibility {
  filmstrip: boolean;
  leftPanel: boolean;
  rightPanel: boolean;
  quickFilter?: boolean;
  dockedQuickFilter?: boolean;
}

export interface CollapsibleSectionsState {
  basic: boolean;
  color: boolean;
  curves: boolean;
  details: boolean;
  effects: boolean;
}
