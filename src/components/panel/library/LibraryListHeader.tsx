import { useEffect, useRef, type MouseEvent } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { ExifOverlay, SortDirection, type SortCriteria } from '../../ui/AppProperties';
import type { ColumnWidths } from '../MainLibrary';
import { COLUMN_UNIT, MIN_COLUMN_WIDTHS, getLibraryColumnWidths } from '../../../utils/libraryColumns';

type ColumnKey = keyof ColumnWidths;
interface Props {
  widths: ColumnWidths;
  setWidths: (update: (previous: ColumnWidths) => ColumnWidths) => void;
  sortCriteria: SortCriteria;
  onSortChange: (key: string) => void;
}

export default function LibraryListHeader({ widths, setWidths, sortCriteria, onSortChange }: Props) {
  const { t } = useTranslation();
  const metadata = useSettingsStore(s => s.appSettings?.exifOverlay !== ExifOverlay.Off && !!s.appSettings?.exifOverlay);
  const pixels = getLibraryColumnWidths(widths);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  function resize(event: MouseEvent, key: ColumnKey) {
    event.preventDefault();
    event.stopPropagation();
    cleanup.current?.();
    const startX = event.clientX;
    const initial = pixels[key];
    const move = (e: globalThis.MouseEvent) => {
      const width = Math.max(MIN_COLUMN_WIDTHS[key], initial + e.clientX - startX);
      setWidths(previous => ({ ...previous, [key]: width / COLUMN_UNIT }));
    };
    const stop = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', stop);
      cleanup.current = null;
    };
    cleanup.current = stop;
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', stop);
  }

  const columns: { key: ColumnKey; label: string; sort?: string }[] = [
    { key: 'thumbnail', label: '' },
    { key: 'name', label: t('library.grid.columns.name'), sort: 'name' },
    { key: 'date', label: t('library.grid.columns.modified'), sort: 'date' },
    { key: 'rating', label: t('library.grid.columns.rating'), sort: 'rating' },
    { key: 'color', label: t('library.grid.columns.label') },
    ...(metadata ? [
      { key: 'shutter' as const, label: t('library.grid.columns.shutter'), sort: 'shutter_speed' },
      { key: 'aperture' as const, label: t('library.grid.columns.aperture'), sort: 'aperture' },
      { key: 'iso' as const, label: t('library.grid.columns.iso'), sort: 'iso' },
      { key: 'focal' as const, label: t('library.grid.columns.focal'), sort: 'focal_length' },
    ] : []),
  ];
  return (
    <div className="flex h-9 shrink-0 items-center bg-bg-secondary/80">
      {columns.map(column => (
        <div key={column.key} style={{ width: pixels[column.key] }} className="relative h-full shrink-0 min-w-0">
          <button type="button" disabled={!column.sort} title={column.label}
            className="flex w-full h-full min-w-0 items-center gap-1 px-3 text-xs font-semibold text-text-secondary disabled:cursor-default hover:enabled:bg-bg-primary/50"
            onClick={event => { event.stopPropagation(); if (column.sort) onSortChange(column.sort); }}>
            <span className="truncate">{column.label}</span>
            {sortCriteria.key === column.sort && (sortCriteria.order === SortDirection.Ascending
              ? <ChevronUp size={12} className="shrink-0" /> : <ChevronDown size={12} className="shrink-0" />)}
          </button>
          <div className="absolute right-0 top-1 bottom-1 w-1 cursor-col-resize hover:bg-border-color"
            onClick={event => event.stopPropagation()} onMouseDown={event => resize(event, column.key)} />
        </div>
      ))}
    </div>
  );
}
