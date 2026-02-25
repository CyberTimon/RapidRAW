import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, FC } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import { Option as AppOption, OPTION_SEPARATOR } from '../components/ui/AppProperties';
import clsx from 'clsx';

interface ContextMenuProviderProps {
  children: any;
}

interface Option extends AppOption {
  customComponent?: FC<any>;
  customProps?: any;
}

interface MenuItemProps {
  hideContextMenu(): void;
  path: number[];
  option: Option;
}

interface SubMenuProps {
  cancelCloseSubmenu(): void;
  closeSubmenu(path: number[]): void;
  hideContextMenu(): void;
  options: Array<Option>;
  parentRef: any;
  parentPath: number[];
}

const ContextMenuContext = createContext('dark');

export const useContextMenu = (): any => {
  return useContext(ContextMenuContext);
};

function SubMenu({ cancelCloseSubmenu, closeSubmenu, hideContextMenu, options, parentRef, parentPath }: SubMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<any>({ opacity: 0 });
  const [safeAreaPath, setSafeAreaPath] = useState<string | null>(null);

  const customOption = options.length === 1 && options[0].customComponent ? options[0] : null;
  const CustomComponent = customOption?.customComponent;

  useLayoutEffect(() => {
    if (parentRef?.current && menuRef?.current) {
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

      const isRightSide = left >= parentRect.right - 10;
      let path = '';

      if (isRightSide) {
        path = `
          M ${parentRect.right} ${parentRect.top} 
          L ${left} ${top} 
          L ${left} ${top + subMenuHeight} 
          L ${parentRect.right} ${parentRect.bottom} 
          Z
        `;
      } else {
        path = `
          M ${parentRect.left} ${parentRect.top} 
          L ${left + subMenuWidth} ${top} 
          L ${left + subMenuWidth} ${top + subMenuHeight} 
          L ${parentRect.left} ${parentRect.bottom} 
          Z
        `;
      }
      setSafeAreaPath(path);
    }
  }, [parentRef, options]);

  const menuMarkup = (
    <>
      {safeAreaPath && (
        <svg
          className="fixed top-0 left-0 w-full h-full pointer-events-none z-[100]"
          style={{ width: '100vw', height: '100vh' }}
        >
          <path
            d={safeAreaPath}
            fill="transparent"
            className="pointer-events-auto cursor-default"
            onMouseEnter={cancelCloseSubmenu}
          />
        </svg>
      )}

      <motion.div
        animate={{ opacity: 1, scale: 1 }}
        className="fixed z-[101]"
        exit={{ opacity: 0, scale: 0.95 }}
        initial={{ opacity: 0, scale: 0.95 }}
        onContextMenu={(e: any) => e.preventDefault()}
        onMouseEnter={cancelCloseSubmenu}
        onMouseLeave={() => closeSubmenu(parentPath)}
        ref={menuRef}
        style={style}
        transition={{ duration: 0.1, ease: 'easeOut' }}
      >
        <div
          className={clsx('backdrop-blur-md rounded-lg shadow-xl', !CustomComponent && 'bg-surface/90 p-2 w-56')}
          role="menu"
        >
          {CustomComponent && customOption ? (
            <CustomComponent {...customOption.customProps} hideContextMenu={hideContextMenu} />
          ) : (
            options.map((option: any, index: number) => (
              <MenuItem hideContextMenu={hideContextMenu} key={index} option={option} path={[...parentPath, index]} />
            ))
          )}
        </div>
      </motion.div>
    </>
  );

  return createPortal(menuMarkup, document.body);
}

function MenuItem({ option, path, hideContextMenu }: MenuItemProps) {
  const { activeSubmenu, openSubmenu, closeSubmenu, cancelCloseSubmenu } = useContextMenu();
  const itemRef = useRef(null);
  const hoverTimeoutRef = useRef<any>(null);

  const isSubmenuOpen =
    option.submenu &&
    activeSubmenu &&
    activeSubmenu.length >= path.length &&
    path.every((val, i) => val === activeSubmenu[i]);

  const handleMouseEnter = () => {
    cancelCloseSubmenu();
    hoverTimeoutRef.current = setTimeout(() => {
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
    }, 150);
  };

  const handleMouseLeave = () => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
    }

    if (option.submenu && !option.disabled) {
      closeSubmenu(path);
    }
  };

  if (option.type === OPTION_SEPARATOR) {
    return <div className="h-px bg-text-secondary/20 my-1 mx-2" />;
  }

  return (
    <div onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} className="relative">
      <button
        className={`
          w-full text-left px-3 py-2 text-sm rounded-md flex items-center gap-3 justify-between
          transition-colors duration-150
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
          {option.color && <div className="w-3 h-3 rounded-full" style={{ backgroundColor: option.color }}></div>}
          {option.icon && <option.icon size={16} />}
          <span>{option.label}</span>
        </div>
        {option.submenu && <ChevronRight size={16} />}
      </button>

      <AnimatePresence>
        {isSubmenuOpen && (
          <SubMenu
            cancelCloseSubmenu={cancelCloseSubmenu}
            closeSubmenu={closeSubmenu}
            hideContextMenu={hideContextMenu}
            options={option.submenu}
            parentRef={itemRef}
            parentPath={path}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function ContextMenu() {
  const { menuState, hideContextMenu, menuRef, menuId } = useContextMenu();
  const { isVisible, x, y, options } = menuState;

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          animate={{ opacity: 1, scale: 1 }}
          className="fixed z-50"
          exit={{ opacity: 0, scale: 0.95 }}
          initial={{ opacity: 0, scale: 0.95 }}
          key={menuId}
          onContextMenu={(e: any) => e.preventDefault()}
          ref={menuRef}
          style={{ top: y, left: x }}
          transition={{ duration: 0.1, ease: 'easeOut' }}
        >
          <div className="bg-surface/90 backdrop-blur-md rounded-lg shadow-xl p-2 w-64" role="menu">
            {options.map((option: any, index: number) => (
              <MenuItem
                hideContextMenu={hideContextMenu}
                key={index}
                option={option}
                path={[index]}
              />
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function ContextMenuProvider({ children }: ContextMenuProviderProps) {
  const [menuState, setMenuState] = useState<any>({ isVisible: false, x: 0, y: 0, options: [] });
  const [activeSubmenu, setActiveSubmenu] = useState<number[] | null>(null);
  const [menuId, setMenuId] = useState<number>(0);
  const menuRef = useRef<any>(null);
  const submenuTimeoutRef = useRef<any>(null);

  const showContextMenu = useCallback((x: number, y: number, options: Array<Option>) => {
    const menuWidth = 256;
    const menuHeight =
      options.reduce((acc: number, opt: Option) => acc + (opt.type === OPTION_SEPARATOR ? 9 : 40), 0) + 16;
    const adjustedX = x + menuWidth > window.innerWidth ? window.innerWidth - menuWidth - 10 : x;
    const adjustedY = y + menuHeight > window.innerHeight ? window.innerHeight - menuHeight - 10 : y;

    setMenuState({ isVisible: true, x: adjustedX, y: adjustedY, options });
    setMenuId((id) => id + 1);
    setActiveSubmenu(null);
  }, []);

  const hideContextMenu = useCallback(() => {
    setMenuState((prev: any) => ({ ...prev, isVisible: false }));
    setActiveSubmenu(null);
  }, []);

  const openSubmenu = useCallback((path: number[] | null) => {
    clearTimeout(submenuTimeoutRef.current);
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
    clearTimeout(submenuTimeoutRef.current);
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: any) => {
      const menuElements = document.querySelectorAll('[role="menu"]');
      let isClickInside = false;
      menuElements.forEach((menuEl) => {
        if (menuEl.contains(event.target)) {
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

  const value: any = {
    activeSubmenu,
    cancelCloseSubmenu,
    closeSubmenu,
    hideContextMenu,
    menuId,
    menuRef,
    menuState,
    openSubmenu,
    showContextMenu,
  };

  return (
    <ContextMenuContext.Provider value={value}>
      {children}
      <ContextMenu />
    </ContextMenuContext.Provider>
  );
}