import { useCallback, type MouseEvent } from 'react';
import { useContextMenu, type MenuOption } from '../context/ContextMenuContext';

type OptionsOrFactory = MenuOption[] | (() => MenuOption[]);

export function useContextMenuTrigger(optionsOrFactory: OptionsOrFactory) {
  const { showContextMenu } = useContextMenu();

  const handleContextMenu = useCallback(
    (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();

      const options =
        typeof optionsOrFactory === 'function' ? optionsOrFactory() : optionsOrFactory;

      showContextMenu(event.clientX, event.clientY, options);
    },
    [showContextMenu, optionsOrFactory]
  );

  return { onContextMenu: handleContextMenu };
}
