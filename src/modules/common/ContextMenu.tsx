import { useCallback, useEffect, useRef, useState, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useBloc } from '@blac/react';
import { ContextMenuService, type MenuItem, type MenuItemDefinition, type MenuSeparator } from '../../blocs/services/ContextMenuService';

function isSeparator(item: MenuItemDefinition): item is MenuSeparator {
  return item.type === 'separator';
}

interface SubMenuProps {
  items: MenuItemDefinition[];
  parentRef: React.RefObject<HTMLElement>;
  parentPath: number[];
  onClose: () => void;
}

function SubMenu({ items, parentRef, parentPath, onClose }: SubMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ opacity: 0 });
  const [, contextMenuBloc] = useBloc(ContextMenuService);

  useLayoutEffect(() => {
    if (!parentRef.current || !menuRef.current) return;

    const parentRect = parentRef.current.getBoundingClientRect();
    const menuEl = menuRef.current;
    const subMenuWidth = menuEl.offsetWidth || 224;
    const subMenuHeight = menuEl.offsetHeight || 100;

    let top = parentRect.top;
    let left = parentRect.right - 4;

    if (left + subMenuWidth > window.innerWidth) {
      left = parentRect.left - subMenuWidth + 4;
    }
    if (left < 0) left = 5;

    if (top + subMenuHeight > window.innerHeight) {
      top = window.innerHeight - subMenuHeight - 5;
    }
    if (top < 0) top = 5;

    setStyle({ top, left, opacity: 1 });
  }, [parentRef, items]);

  const firstItem = items[0];
  const customItem = items.length === 1 && firstItem && !isSeparator(firstItem) ? firstItem : null;

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[51]"
      style={style}
      onContextMenu={(e) => e.preventDefault()}
      onMouseEnter={() => contextMenuBloc.cancelSubmenuClose()}
      onMouseLeave={() => contextMenuBloc.closeSubmenu(parentPath)}
    >
      <div className="bg-surface/95 backdrop-blur-sm rounded-lg shadow-xl p-1.5 min-w-[14rem]" role="menu">
        {customItem && !isSeparator(customItem) ? (
          <MenuItemComponent
            item={customItem as MenuItem}
            path={[...parentPath, 0]}
            onClose={onClose}
          />
        ) : (
          items.map((item, index) => (
            <MenuItemComponent
              key={item.id}
              item={item}
              path={[...parentPath, index]}
              onClose={onClose}
            />
          ))
        )}
      </div>
    </div>,
    document.body
  );
}

interface MenuItemComponentProps {
  item: MenuItemDefinition;
  path: number[];
  onClose: () => void;
}

function MenuItemComponent({ item, path, onClose }: MenuItemComponentProps) {
  const itemRef = useRef<HTMLButtonElement>(null);
  const [, contextMenuBloc] = useBloc(ContextMenuService);

  if (item.type === 'separator') {
    return <div className="h-px bg-border-color/50 my-1 mx-2" />;
  }

  const menuItem = item as MenuItem;
  const isSubmenuOpen = menuItem.submenu && contextMenuBloc.isSubmenuOpen(path);

  const handleMouseEnter = () => {
    contextMenuBloc.cancelSubmenuClose();
    if (menuItem.disabled) {
      const parentPath = path.slice(0, -1);
      contextMenuBloc.openSubmenu(parentPath.length > 0 ? parentPath : []);
      return;
    }
    if (menuItem.submenu) {
      contextMenuBloc.openSubmenu(path);
    } else {
      const parentPath = path.slice(0, -1);
      contextMenuBloc.openSubmenu(parentPath.length > 0 ? parentPath : []);
    }
  };

  const handleMouseLeave = () => {
    if (menuItem.submenu && !menuItem.disabled) {
      contextMenuBloc.closeSubmenu(path);
    }
  };

  const handleClick = () => {
    if (menuItem.disabled || menuItem.submenu) return;
    menuItem.onClick?.();
    onClose();
  };

  const Icon = menuItem.icon;

  return (
    <div onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} className="relative">
      <button
        ref={itemRef}
        className={`
          w-full text-left px-3 py-2 text-sm rounded flex items-center gap-3 justify-between
          ${menuItem.destructive ? 'text-red-400 hover:bg-red-500/20' : 'text-text-primary hover:bg-surface-hover'}
          ${menuItem.disabled ? 'text-text-secondary/50 cursor-not-allowed hover:bg-transparent' : ''}
        `}
        disabled={menuItem.disabled}
        onClick={handleClick}
        role="menuitem"
      >
        <div className="flex items-center gap-3">
          {menuItem.color && (
            <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: menuItem.color }} />
          )}
          {Icon && <Icon size={16} />}
          <span>{menuItem.label}</span>
        </div>
        <div className="flex items-center gap-2">
          {menuItem.shortcut && (
            <span className="text-xs text-text-secondary">{menuItem.shortcut}</span>
          )}
          {menuItem.submenu && (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          )}
        </div>
      </button>

      {isSubmenuOpen && menuItem.submenu && (
        <SubMenu
          items={menuItem.submenu}
          parentRef={itemRef as React.RefObject<HTMLElement>}
          parentPath={path}
          onClose={onClose}
        />
      )}
    </div>
  );
}

export function ContextMenu() {
  const menuRef = useRef<HTMLDivElement>(null);
  const [state, contextMenuBloc] = useBloc(ContextMenuService);
  const { isVisible, position, items, menuId } = state;

  const handleClose = useCallback(() => {
    contextMenuBloc.hide();
  }, [contextMenuBloc]);

  useEffect(() => {
    if (!isVisible) return;

    const handleClickOutside = (event: MouseEvent) => {
      const menuElements = document.querySelectorAll('[role="menu"]');
      let isClickInside = false;
      menuElements.forEach((menuEl) => {
        if (menuEl.contains(event.target as Node)) {
          isClickInside = true;
        }
      });
      if (!isClickInside) {
        handleClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleClose();
      }
    };

    const handleScroll = () => {
      handleClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleScroll, true);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [isVisible, handleClose]);

  if (!isVisible) return null;

  return createPortal(
    <div
      key={menuId}
      ref={menuRef}
      className="fixed z-50"
      style={{ top: position.y, left: position.x }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="bg-surface/95 backdrop-blur-sm rounded-lg shadow-xl p-1.5 min-w-[16rem]" role="menu">
        {items.map((item, index) => (
          <MenuItemComponent
            key={item.id}
            item={item}
            path={[index]}
            onClose={handleClose}
          />
        ))}
      </div>
    </div>,
    document.body
  );
}

export function useContextMenu() {
  const [, contextMenuBloc] = useBloc(ContextMenuService);

  const showContextMenu = useCallback(
    (event: React.MouseEvent, items: MenuItemDefinition[]) => {
      event.preventDefault();
      event.stopPropagation();
      contextMenuBloc.show(event.clientX, event.clientY, items);
    },
    [contextMenuBloc]
  );

  return { showContextMenu, hideContextMenu: contextMenuBloc.hide };
}
