import { useLayoutEffect, useRef } from 'react';

interface Layout {
  rows: { type: string; images?: { path: string }[] }[];
  rowHeight: number;
  headerHeight: number;
  OUTER_PADDING: number;
}

export function useLibraryScrollAnchor(
  element: HTMLElement | null | undefined,
  layout: Layout | null,
  folder: string | null,
) {
  const previous = useRef<{ layout: Layout; folder: string | null } | null>(null);
  useLayoutEffect(() => {
    const old = previous.current;
    previous.current = layout ? { layout, folder } : null;
    if (
      !element ||
      !layout ||
      !old ||
      old.folder !== folder ||
      old.layout.rowHeight !== layout.rowHeight ||
      element.scrollTop <= 0
    )
      return;
    let top = old.layout.OUTER_PADDING;
    let anchor: string | undefined;
    let offset = 0;
    for (const row of old.layout.rows) {
      const height = row.type === 'header' ? old.layout.headerHeight : old.layout.rowHeight;
      if (top + height > element.scrollTop && row.images?.length) {
        anchor = row.images[0].path;
        offset = element.scrollTop - top;
        break;
      }
      top += height;
    }
    if (!anchor) return;
    top = layout.OUTER_PADDING;
    for (const row of layout.rows) {
      if (row.images?.some((image) => image.path === anchor)) {
        element.scrollTop = Math.max(0, top + offset);
        break;
      }
      top += row.type === 'header' ? layout.headerHeight : layout.rowHeight;
    }
  }, [element, layout, folder]);
}
