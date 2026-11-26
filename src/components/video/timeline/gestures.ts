import { useCallback, useEffect, useRef } from 'react';
import type { FocusEvent, KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { DRAG_THRESHOLD } from './layout';

export const dragStarted = (drag: { startX: number; moved: boolean }, clientX: number) => {
  if (!drag.moved && Math.abs(clientX - drag.startX) < DRAG_THRESHOLD) return false;
  drag.moved = true;
  return true;
};

export interface PointerDrag {
  move(event: PointerEvent): void;
  end(event: PointerEvent): void;
  cancel(): void;
}

export const usePointerDrag = (drag: PointerDrag) => {
  const latest = useRef(drag);
  latest.current = drag;
  const release = useRef<(() => void) | null>(null);
  useEffect(() => () => release.current?.(), []);
  return useCallback((event: ReactPointerEvent) => {
    release.current?.();
    const target = event.currentTarget;
    const { pointerId } = event;
    target.setPointerCapture(pointerId);
    const own = (handler: (event: PointerEvent) => void) => (event: Event) => {
      if ((event as PointerEvent).pointerId === pointerId) handler(event as PointerEvent);
    };
    const cancel = () => {
      stop();
      latest.current.cancel();
    };
    const listeners: Array<[string, EventListener]> = [
      ['pointermove', own((event) => ((event.buttons & 1) === 0 ? cancel() : latest.current.move(event)))],
      [
        'pointerup',
        own((event) => {
          stop();
          latest.current.end(event);
        }),
      ],
      ['pointercancel', own(cancel)],
      [
        'keydown',
        (event) => {
          if ((event as globalThis.KeyboardEvent).code !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          cancel();
        },
      ],
    ];
    function stop() {
      release.current = null;
      listeners.forEach(([type, listener]) => window.removeEventListener(type, listener, true));
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    }
    listeners.forEach(([type, listener]) => window.addEventListener(type, listener, true));
    release.current = stop;
  }, []);
};

type TextField = HTMLInputElement | HTMLTextAreaElement;

export const useInlineEdit = () => {
  const cancelled = useRef(false);
  return (finish: (value: string | null) => void, multiline = false) => ({
    autoFocus: true,
    onPointerDown: (event: ReactPointerEvent) => event.stopPropagation(),
    onBlur: (event: FocusEvent<TextField>) => {
      const value = cancelled.current ? null : event.currentTarget.value;
      cancelled.current = false;
      finish(value);
    },
    onKeyDown: (event: KeyboardEvent<TextField>) => {
      event.stopPropagation();
      if (event.key === 'Enter' && !(multiline && event.shiftKey)) {
        event.preventDefault();
        event.currentTarget.blur();
      }
      if (event.key === 'Escape') {
        cancelled.current = true;
        event.currentTarget.blur();
      }
    },
  });
};
