import { Cubit } from '@blac/core';
import type { ComponentType } from 'react';

export const MENU_SEPARATOR = 'separator';

export interface MenuItemBase {
  type?: 'item' | 'separator';
  id: string;
}

export interface MenuSeparator extends MenuItemBase {
  type: 'separator';
}

export interface MenuItem extends MenuItemBase {
  type?: 'item';
  label: string;
  icon?: ComponentType<{ size?: number }>;
  shortcut?: string;
  disabled?: boolean;
  destructive?: boolean;
  color?: string;
  onClick?: () => void;
  submenu?: MenuItemDefinition[];
}

export type MenuItemDefinition = MenuItem | MenuSeparator;

export interface MenuPosition {
  x: number;
  y: number;
}

interface ContextMenuState {
  isVisible: boolean;
  position: MenuPosition;
  items: MenuItemDefinition[];
  activeSubmenuPath: number[];
  menuId: number;
}

export class ContextMenuService extends Cubit<ContextMenuState> {
  private submenuCloseTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super({
      isVisible: false,
      position: { x: 0, y: 0 },
      items: [],
      activeSubmenuPath: [],
      menuId: 0,
    });
  }

  show = (x: number, y: number, items: MenuItemDefinition[]) => {
    const adjustedPosition = this.calculatePosition(x, y, items);

    this.emit({
      isVisible: true,
      position: adjustedPosition,
      items,
      activeSubmenuPath: [],
      menuId: this.state.menuId + 1,
    });
  };

  hide = () => {
    this.clearSubmenuTimeout();
    this.patch({
      isVisible: false,
      activeSubmenuPath: [],
    });
  };

  openSubmenu = (path: number[]) => {
    this.clearSubmenuTimeout();
    this.patch({ activeSubmenuPath: path });
  };

  closeSubmenu = (path: number[]) => {
    this.clearSubmenuTimeout();
    this.submenuCloseTimeout = setTimeout(() => {
      const currentPath = this.state.activeSubmenuPath;
      if (currentPath.join('-').startsWith(path.join('-'))) {
        const parentPath = path.slice(0, -1);
        this.patch({ activeSubmenuPath: parentPath });
      }
    }, 200);
  };

  cancelSubmenuClose = () => {
    this.clearSubmenuTimeout();
  };

  isSubmenuOpen = (path: number[]): boolean => {
    const active = this.state.activeSubmenuPath;
    return active.length >= path.length && path.every((val, i) => val === active[i]);
  };

  private clearSubmenuTimeout = () => {
    if (this.submenuCloseTimeout) {
      clearTimeout(this.submenuCloseTimeout);
      this.submenuCloseTimeout = null;
    }
  };

  private calculatePosition = (
    x: number,
    y: number,
    items: MenuItemDefinition[]
  ): MenuPosition => {
    const menuWidth = 256;
    const itemHeight = 36;
    const separatorHeight = 9;
    const padding = 16;

    const menuHeight = items.reduce((acc, item) => {
      return acc + (item.type === 'separator' ? separatorHeight : itemHeight);
    }, padding);

    let adjustedX = x;
    let adjustedY = y;

    if (typeof window !== 'undefined') {
      if (x + menuWidth > window.innerWidth) {
        adjustedX = window.innerWidth - menuWidth - 10;
      }
      if (adjustedX < 0) {
        adjustedX = 10;
      }

      if (y + menuHeight > window.innerHeight) {
        adjustedY = window.innerHeight - menuHeight - 10;
      }
      if (adjustedY < 0) {
        adjustedY = 10;
      }
    }

    return { x: adjustedX, y: adjustedY };
  };

  static createSeparator = (): MenuSeparator => ({
    type: 'separator',
    id: `sep-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  });

  static createItem = (
    label: string,
    onClick: () => void,
    options?: Partial<Omit<MenuItem, 'label' | 'onClick' | 'type' | 'id'>>
  ): MenuItem => ({
    type: 'item',
    id: `item-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    label,
    onClick,
    ...options,
  });
}
