import type { ColumnWidths } from '../components/panel/MainLibrary';

// Keep the existing stored width units compatible, but never compress columns
// to percentages of the viewport. Header and rows share these pixel widths.
export const COLUMN_UNIT = 12;
export const MIN_COLUMN_WIDTHS: ColumnWidths = {
  thumbnail: 64, name: 280, date: 180, rating: 96, color: 112,
  shutter: 112, aperture: 112, iso: 88, focal: 128,
};
export function getLibraryColumnWidths(stored: ColumnWidths): ColumnWidths {
  return Object.fromEntries(Object.entries(MIN_COLUMN_WIDTHS).map(([key, minimum]) => {
    const value = stored[key as keyof ColumnWidths];
    return [key, Math.max(minimum, Number.isFinite(value) ? value * COLUMN_UNIT : minimum)];
  })) as unknown as ColumnWidths;
}
export function libraryTableWidth(widths: ColumnWidths, metadata: boolean): number {
  return widths.thumbnail + widths.name + widths.date + widths.rating + widths.color +
    (metadata ? widths.shutter + widths.aperture + widths.iso + widths.focal : 0);
}
