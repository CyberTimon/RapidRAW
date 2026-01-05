import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight } from 'lucide-react';
import { OPTION_SEPARATOR } from '../types/constants';

export interface MenuOption {
  label?: string;
  icon?: FC<{ size?: number }>;
  color?: string;
  onClick?: () => void;
  disabled?: boolean;
  isDestructive?: boolean;
  submenu?: MenuOption[];
  type?: typeof OPTION_SEPARATOR;
  customComponent?: FC<{ hideContextMenu: () => void } & Record<string, unknown>>;
  customProps?: Record<string, unknown>;
}

interface MenuState {
  isVisible: boolean;
  x: number;
  y: number;
  options: MenuOption[];
}

interface ContextMenuValue {
  menuState: MenuState;
  showContextMenu: (x: number, y: number, options: MenuOption[]) => void;
  hideContextMenu: () => void;
  activeSubmenu: number[] | null;
  openSubmenu: (path: number[] | null) => void;
  closeSubmenu: (path: number[]) => void;
  cancelCloseSubmenu: () => void;
  menuRef: React.RefObject<HTMLDivElement | null>;
  menuId: number;
}

const ContextMenuContext = createContext<ContextMenuValue | null>(null);

export function useContextMenu(): ContextMenuValue {
  const context = useContext(ContextMenuContext);
  if (!context) {
    throw new Error('useContextMenu must be used within a ContextMenuProvider');
  }
  return context;
}

interface MenuItemProps {
  option: MenuOption;
  path: number[];
  hideContextMenu: () => void;
}

interface SubMenuProps {
  options: MenuOption[];
  parentRef: React.RefObject<HTMLElement | null>;
  parentPath: number[];
  hideContextMenu: () => void;
  closeSubmenu: (path: number[]) => void;
  cancelCloseSubmenu: () => void;
}

function SubMenu({
  options,
  parentRef,
  parentPath,
  hideContextMenu,
  closeSubmenu,
  cancelCloseSubmenu,
}: SubMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ opacity: 0 });
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
  }, []);

  const customOption = options.length === 1 && options[0].customComponent ? options[0] : null;
  const CustomComponent = customOption?.customComponent;

  useLayoutEffect(() => {
    if (isClient && parentRef?.current && menuRef?.current) {
      const parentRect = parentRef.current.getBoundingClientRect();
      const menuEl = menuRef.current;

      const subMenuWidth = menuEl?.offsetWidth || 256;
      const subMenuHeight = menuEl?.offsetHeight || 100;

      if (subMenuWidth === 0 || subMenuHeight === 0) {
        return;
      }

      let top = parentRect.top;
      let left = parentRect.right - 4;

      if (left + subMenuWidth > window.innerWidth) {
        left = parentRect.left - subMenuWidth + 4;
      }
      if (left < 0) {
        left = 5;
      }

      if (top + subMenuHeight > window.innerHeight) {
        top = window.innerHeight - subMenuHeight - 5;
      }
      if (top < 0) {
        top = 5;
      }

      setStyle({ top: `${top}px`, left: `${left}px`, opacity: 1 });
    }
  }, [isClient, parentRef, options]);

  if (!isClient) {
    return null;
  }

  const menuMarkup = (
    <div
      className="fixed z-[51]"
      onContextMenu={(e) => e.preventDefault()}
      onMouseEnter={cancelCloseSubmenu}
      onMouseLeave={() => closeSubmenu(parentPath)}
      ref={menuRef}
      style={style}
    >
      <div
        className={`bg-surface/95 rounded-lg shadow-xl ${!CustomComponent ? 'p-2 w-56' : ''}`}
        role="menu"
      >
        {CustomComponent && customOption ? (
          <CustomComponent {...customOption.customProps} hideContextMenu={hideContextMenu} />
        ) : (
          options.map((option, index) => (
            <MenuItem
              hideContextMenu={hideContextMenu}
              key={index}
              option={option}
              path={[...parentPath, index]}
            />
          ))
        )}
      </div>
    </div>
  );

  return createPortal(menuMarkup, document.body);
}

function MenuItem({ option, path, hideContextMenu }: MenuItemProps) {
  const { activeSubmenu, openSubmenu, closeSubmenu, cancelCloseSubmenu } = useContextMenu();
  const itemRef = useRef<HTMLButtonElement>(null);

  const isSubmenuOpen =
    option.submenu &&
    activeSubmenu &&
    activeSubmenu.length >= path.length &&
    path.every((val, i) => val === activeSubmenu[i]);

  const handleMouseEnter = () => {
    cancelCloseSubmenu();
    if (option.disabled) {
      const parentPath = path.slice(0, -1);
      openSubmenu(parentPath.length > 0 ? parentPath : null);
      return;
    }
    if (option.submenu) {
      openSubmenu(path);
    } else {
      const parentPath = path.slice(0, -1);
      openSubmenu(parentPath.length > 0 ? parentPath : null);
    }
  };

  const handleMouseLeave = () => {
    if (option.submenu && !option.disabled) {
      closeSubmenu(path);
    }
  };

  if (option.type === OPTION_SEPARATOR) {
    return <div className="h-px bg-text-secondary/20 my-1 mx-2" />;
  }

  const Icon = option.icon;

  return (
    <div onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} className="relative">
      <button
        className={`
          w-full text-left px-3 py-2 text-sm rounded-md flex items-center gap-3 justify-between
          ${option.isDestructive ? 'text-red-400 hover:bg-red-500/20' : 'text-text-primary hover:bg-bg-primary'}
          ${option.disabled ? 'text-text-secondary bg-transparent cursor-not-allowed' : ''}
        `}
        disabled={option.disabled}
        onClick={() => {
          if (!option.disabled && !option.submenu && option.onClick) {
            option.onClick();
            hideContextMenu();
          }
        }}
        ref={itemRef}
        role="menuitem"
      >
        <div className="flex items-center gap-3">
          {option.color && (
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: option.color }} />
          )}
          {Icon && <Icon size={16} />}
          <span>{option.label}</span>
        </div>
        {option.submenu && <ChevronRight size={16} />}
      </button>

      {isSubmenuOpen && (
        <SubMenu
          cancelCloseSubmenu={cancelCloseSubmenu}
          closeSubmenu={closeSubmenu}
          hideContextMenu={hideContextMenu}
          options={option.submenu!}
          parentRef={itemRef}
          parentPath={path}
        />
      )}
    </div>
  );
}

function ContextMenu() {
  const { menuState, hideContextMenu, menuRef } = useContextMenu();
  const { isVisible, x, y, options } = menuState;

  if (!isVisible) {
    return null;
  }

  return (
    <div
      className="fixed z-50"
      onContextMenu={(e) => e.preventDefault()}
      ref={menuRef}
      style={{ top: y, left: x }}
    >
      <div className="bg-surface/95 rounded-lg shadow-xl p-2 w-64" role="menu">
        {options.map((option, index) => (
          <MenuItem
            hideContextMenu={hideContextMenu}
            key={index}
            option={option}
            path={[index]}
          />
        ))}
      </div>
    </div>
  );
}

interface ContextMenuProviderProps {
  children: ReactNode;
}

export function ContextMenuProvider({ children }: ContextMenuProviderProps) {
  const [menuState, setMenuState] = useState<MenuState>({
    isVisible: false,
    x: 0,
    y: 0,
    options: [],
  });
  const [activeSubmenu, setActiveSubmenu] = useState<number[] | null>(null);
  const [menuId, setMenuId] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showContextMenu = useCallback((x: number, y: number, options: MenuOption[]) => {
    const menuWidth = 256;
    const menuHeight =
      options.reduce((acc, opt) => acc + (opt.type === OPTION_SEPARATOR ? 9 : 40), 0) + 16;
    const adjustedX = x + menuWidth > window.innerWidth ? window.innerWidth - menuWidth - 10 : x;
    const adjustedY = y + menuHeight > window.innerHeight ? window.innerHeight - menuHeight - 10 : y;

    setMenuState({ isVisible: true, x: adjustedX, y: adjustedY, options });
    setMenuId((id) => id + 1);
    setActiveSubmenu(null);
  }, []);

  const hideContextMenu = useCallback(() => {
    setMenuState((prev) => ({ ...prev, isVisible: false }));
    setActiveSubmenu(null);
  }, []);

  const openSubmenu = useCallback((path: number[] | null) => {
    if (submenuTimeoutRef.current) {
      clearTimeout(submenuTimeoutRef.current);
    }
    setActiveSubmenu(path);
  }, []);

  const closeSubmenu = useCallback((path: number[]) => {
    submenuTimeoutRef.current = setTimeout(() => {
      setActiveSubmenu((currentActivePath) => {
        if (currentActivePath && currentActivePath.join('-').startsWith(path.join('-'))) {
          const parentPath = path.slice(0, -1);
          return parentPath.length > 0 ? parentPath : null;
        }
        return currentActivePath;
      });
    }, 200);
  }, []);

  const cancelCloseSubmenu = useCallback(() => {
    if (submenuTimeoutRef.current) {
      clearTimeout(submenuTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const menuElements = document.querySelectorAll('[role="menu"]');
      let isClickInside = false;
      menuElements.forEach((menuEl) => {
        if (menuEl.contains(event.target as Node)) {
          isClickInside = true;
        }
      });

      if (!isClickInside) {
        hideContextMenu();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        hideContextMenu();
      }
    };

    if (menuState.isVisible) {
      document.addEventListener('mousedown', handleClickOutside);
      window.addEventListener('scroll', hideContextMenu, true);
      document.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('scroll', hideContextMenu, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuState.isVisible, hideContextMenu]);

  const value: ContextMenuValue = {
    menuState,
    showContextMenu,
    hideContextMenu,
    activeSubmenu,
    openSubmenu,
    closeSubmenu,
    cancelCloseSubmenu,
    menuRef,
    menuId,
  };

  return (
    <ContextMenuContext.Provider value={value}>
      {children}
      <ContextMenu />
    </ContextMenuContext.Provider>
  );
}
