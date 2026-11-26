import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

const POPOVER_GAP = 8;
const POPOVER_MARGIN = 8;

const HIDDEN: CSSProperties = { visibility: 'hidden' };

export function usePopover(isOpen: boolean, close: () => void, width: number) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<CSSProperties>(HIDDEN);
  const [room, setRoom] = useState(0);

  useEffect(() => {
    if (!isOpen) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Element;
      if (target.closest?.('[data-dropdown-menu]')) return;
      if (!anchorRef.current?.contains(target) && !popoverRef.current?.contains(target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopImmediatePropagation();
      close();
    };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', escape, true);
    };
  }, [isOpen, close]);

  useLayoutEffect(() => {
    if (!isOpen) {
      setPlacement(HIDDEN);
      setRoom(0);
      return;
    }
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const height = popoverRef.current?.offsetHeight ?? 0;
      const left = Math.max(POPOVER_MARGIN, Math.min(anchor.right - width, window.innerWidth - width - POPOVER_MARGIN));
      const spaceBelow = window.innerHeight - POPOVER_MARGIN - anchor.bottom - POPOVER_GAP;
      const spaceAbove = anchor.top - POPOVER_GAP - POPOVER_MARGIN;
      const below = height <= spaceBelow;
      const above = !below && height <= spaceAbove;
      setRoom(above ? spaceAbove : spaceBelow);
      setPlacement(
        above
          ? { left, bottom: window.innerHeight - anchor.top + POPOVER_GAP }
          : { left, top: anchor.bottom + POPOVER_GAP },
      );
    };
    place();
    const observer = new ResizeObserver(place);
    if (popoverRef.current) observer.observe(popoverRef.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [isOpen, width]);

  return { anchorRef, popoverRef, placement, room };
}
