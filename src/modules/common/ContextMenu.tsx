import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useBloc } from '@blac/react';
import {
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  SubmenuTrigger,
  Popover,
  Separator,
  composeRenderProps,
  type MenuItemProps,
} from 'react-aria-components';
import { ChevronRight } from 'lucide-react';
import { tv } from 'tailwind-variants';
import {
  ContextMenuService,
  type MenuItem,
  type MenuItemDefinition,
} from '../../blocs/services/ContextMenuService';

const menuStyles = tv({
  base: [
    'bg-surface/95 backdrop-blur-sm rounded-lg shadow-xl',
    'p-1.5 min-w-[14rem] max-h-[calc(100vh-32px)] overflow-auto',
    'outline-none',
  ],
});

const menuItemStyles = tv({
  base: [
    'w-full text-left px-3 py-2 text-sm rounded',
    'flex items-center gap-3 justify-between',
    'cursor-default outline-none',
    'transition-colors',
  ],
  variants: {
    isFocused: {
      true: 'bg-surface-hover',
    },
    isDisabled: {
      true: 'text-text-secondary/50 cursor-not-allowed',
      false: 'text-text-primary',
    },
    isDestructive: {
      true: '',
    },
  },
  compoundVariants: [
    {
      isDestructive: true,
      isDisabled: false,
      className: 'text-red-400',
    },
    {
      isDestructive: true,
      isFocused: true,
      isDisabled: false,
      className: 'bg-red-500/20',
    },
  ],
});

function isSeparator(item: MenuItemDefinition): item is { type: 'separator'; id: string } {
  return item.type === 'separator';
}

interface ContextMenuItemProps extends Omit<MenuItemProps, 'children'> {
  item: MenuItem;
  onClose: () => void;
}

function ContextMenuItem({ item, onClose, ...props }: ContextMenuItemProps) {
  const Icon = item.icon;

  const handleAction = useCallback(() => {
    if (item.onClick) {
      item.onClick();
    }
    onClose();
  }, [item, onClose]);

  if (item.submenu && item.submenu.length > 0) {
    return (
      <SubmenuTrigger>
        <AriaMenuItem
          {...props}
          id={item.id}
          textValue={item.label}
          isDisabled={item.disabled}
          className={composeRenderProps(props.className, (className, { isFocused, isDisabled }) =>
            menuItemStyles({
              isFocused,
              isDisabled,
              isDestructive: item.destructive,
              className,
            })
          )}
        >
          <div className="flex items-center gap-3">
            {item.color && (
              <div
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ backgroundColor: item.color }}
              />
            )}
            {Icon && <Icon size={16} />}
            <span>{item.label}</span>
          </div>
          <div className="flex items-center gap-2">
            {item.shortcut && (
              <span className="text-xs text-text-secondary">{item.shortcut}</span>
            )}
            <ChevronRight size={16} />
          </div>
        </AriaMenuItem>
        <Popover offset={-4} crossOffset={0} className={menuStyles()}>
          <AriaMenu
            aria-label={`${item.label} submenu`}
            className="outline-none"
            onAction={(key) => {
              const subItem = findItemById(item.submenu!, String(key));
              if (subItem && !isSeparator(subItem) && subItem.onClick) {
                subItem.onClick();
              }
              onClose();
            }}
          >
            {item.submenu.map((subItem) =>
              isSeparator(subItem) ? (
                <Separator key={subItem.id} className="h-px bg-border-color/50 my-1 mx-2" />
              ) : (
                <ContextMenuItem key={subItem.id} item={subItem} onClose={onClose} />
              )
            )}
          </AriaMenu>
        </Popover>
      </SubmenuTrigger>
    );
  }

  return (
    <AriaMenuItem
      {...props}
      id={item.id}
      textValue={item.label}
      isDisabled={item.disabled}
      onAction={handleAction}
      className={composeRenderProps(props.className, (className, { isFocused, isDisabled }) =>
        menuItemStyles({
          isFocused,
          isDisabled,
          isDestructive: item.destructive,
          className,
        })
      )}
    >
      <div className="flex items-center gap-3">
        {item.color && (
          <div
            className="w-3 h-3 rounded-full flex-shrink-0"
            style={{ backgroundColor: item.color }}
          />
        )}
        {Icon && <Icon size={16} />}
        <span>{item.label}</span>
      </div>
      {item.shortcut && (
        <span className="text-xs text-text-secondary">{item.shortcut}</span>
      )}
    </AriaMenuItem>
  );
}

function findItemById(items: MenuItemDefinition[], id: string): MenuItemDefinition | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    if (!isSeparator(item) && item.submenu) {
      const found = findItemById(item.submenu, id);
      if (found) return found;
    }
  }
  return undefined;
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
      const menuElements = document.querySelectorAll('[data-context-menu]');
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

    const handleScroll = () => {
      handleClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('scroll', handleScroll, true);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [isVisible, handleClose]);

  if (!isVisible) return null;

  return createPortal(
    <div
      key={menuId}
      ref={menuRef}
      data-context-menu
      className="fixed z-50"
      style={{ top: position.y, left: position.x }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <AriaMenu
        aria-label="Context menu"
        className={menuStyles()}
        autoFocus="first"
        onClose={handleClose}
        onAction={(key) => {
          const item = findItemById(items, String(key));
          if (item && !isSeparator(item) && item.onClick) {
            item.onClick();
          }
          handleClose();
        }}
      >
        {items.map((item) =>
          isSeparator(item) ? (
            <Separator key={item.id} className="h-px bg-border-color/50 my-1 mx-2" />
          ) : (
            <ContextMenuItem key={item.id} item={item} onClose={handleClose} />
          )
        )}
      </AriaMenu>
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
