import { type MouseEvent, type PointerEvent, useCallback, useRef } from 'react';

// macOS turns ctrl+click into a right-click, so ctrl-drag gestures would also open a context menu.
// Pass onCtrlClick to run the ctrl+click action on that press instead; a click that may follow is skipped.
export function useCtrlClickMenuGuard(onCtrlClick?: (e: MouseEvent) => void) {
  const isCtrlPressRef = useRef(false);
  const skipClickRef = useRef(false);
  const onCtrlClickRef = useRef(onCtrlClick);
  onCtrlClickRef.current = onCtrlClick;

  const onPointerDownCapture = useCallback((e: PointerEvent) => {
    isCtrlPressRef.current = e.button === 0 && e.ctrlKey;
    skipClickRef.current = false;
  }, []);

  const onContextMenuCapture = useCallback((e: MouseEvent) => {
    // Also require ctrl on the menu event itself, so a keyboard-opened menu after a plain ctrl+click isn't swallowed.
    if (!isCtrlPressRef.current || !e.ctrlKey) return;
    isCtrlPressRef.current = false;
    e.preventDefault();
    e.stopPropagation();
    if (onCtrlClickRef.current) {
      onCtrlClickRef.current(e);
      skipClickRef.current = true;
    }
  }, []);

  const onClickCapture = useCallback((e: MouseEvent) => {
    if (!skipClickRef.current) return;
    skipClickRef.current = false;
    e.stopPropagation();
  }, []);

  return { onPointerDownCapture, onContextMenuCapture, onClickCapture };
}
