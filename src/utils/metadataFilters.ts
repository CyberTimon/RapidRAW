import { ImageFile, ImageFlag } from '../components/ui/AppProperties';
import { useSettingsStore } from '../store/useSettingsStore';

export const METADATA_FILTER_FIELDS = [
  'date',
  'camera',
  'lens',
  'iso',
  'aperture',
  'shutter',
  'focal',
  'edited',
  'rating',
  'flag',
  'color',
  'fileType',
] as const;

export type MetadataFilterField = (typeof METADATA_FILTER_FIELDS)[number];

export type MetadataFilterSelections = Partial<Record<MetadataFilterField, string[]>>;

export interface MetadataFilterBarSettings {
  expanded: boolean;
  columns: MetadataFilterField[];
}

export const DEFAULT_METADATA_FILTER_BAR: MetadataFilterBarSettings = {
  expanded: false,
  columns: ['date', 'camera', 'lens', 'edited'],
};

export const MAX_METADATA_FILTER_COLUMNS = 6;
export const UNKNOWN_VALUE = '__unknown__';

const EXIF_FIELDS = new Set<MetadataFilterField>(['date', 'camera', 'lens', 'iso', 'aperture', 'shutter', 'focal']);

export const isExifField = (field: MetadataFilterField) => EXIF_FIELDS.has(field);

export function normalizeFilterBarSettings(value: unknown): MetadataFilterBarSettings {
  const raw = (value ?? {}) as Partial<MetadataFilterBarSettings>;
  const columns = Array.isArray(raw.columns)
    ? raw.columns.filter(
        (c, i, arr): c is MetadataFilterField =>
          (METADATA_FILTER_FIELDS as readonly string[]).includes(c) && arr.indexOf(c) === i,
      )
    : DEFAULT_METADATA_FILTER_BAR.columns;
  return {
    expanded: typeof raw.expanded === 'boolean' ? raw.expanded : DEFAULT_METADATA_FILTER_BAR.expanded,
    columns: columns.slice(0, MAX_METADATA_FILTER_COLUMNS),
  };
}

export function updateMetadataFilterBar(next: Partial<MetadataFilterBarSettings>) {
  const { appSettings, handleSettingsChange } = useSettingsStore.getState();
  if (!appSettings) return;
  const current = normalizeFilterBarSettings(appSettings.metadataFilterBar);
  handleSettingsChange({ ...appSettings, metadataFilterBar: { ...current, ...next } });
}

export function toggleMetadataFilterBar() {
  const { appSettings } = useSettingsStore.getState();
  updateMetadataFilterBar({ expanded: !normalizeFilterBarSettings(appSettings?.metadataFilterBar).expanded });
}

export function hasActiveMetadataFilters(selections: MetadataFilterSelections): boolean {
  return Object.values(selections).some((values) => values && values.length > 0);
}

export function usesExifMetadataFilters(selections: MetadataFilterSelections): boolean {
  return Object.entries(selections).some(
    ([field, values]) => values && values.length > 0 && isExifField(field as MetadataFilterField),
  );
}

const firstNumber = (val: string | undefined): number | null => {
  const match = val?.match(/\d+(\.\d+)?/);
  return match ? parseFloat(match[0]) : null;
};

const formatNumber = (n: number) => String(Math.round(n * 10) / 10);

export function getMetadataFilterValue(
  field: MetadataFilterField,
  image: ImageFile,
  exif: Record<string, string> | undefined,
  rating: number,
): string {
  switch (field) {
    case 'date': {
      const match = exif?.DateTimeOriginal?.match(/^(\d{4})[-:](\d{2})[-:](\d{2})/);
      return match ? `${match[1]}-${match[2]}-${match[3]}` : UNKNOWN_VALUE;
    }
    case 'camera': {
      const make = (exif?.Make || '').trim();
      const model = (exif?.Model || '').trim();
      if (!model) return make || UNKNOWN_VALUE;
      if (!make || model.toLowerCase().startsWith(make.split(' ')[0].toLowerCase())) return model;
      return `${make} ${model}`;
    }
    case 'lens':
      return (exif?.LensModel || exif?.Lens || '').trim() || UNKNOWN_VALUE;
    case 'iso': {
      const iso = parseInt(exif?.PhotographicSensitivity || exif?.ISOSpeedRatings || '', 10);
      return iso > 0 ? String(iso) : UNKNOWN_VALUE;
    }
    case 'aperture': {
      const f = firstNumber(exif?.FNumber);
      return f ? `f/${formatNumber(f)}` : UNKNOWN_VALUE;
    }
    case 'shutter':
      return exif?.ExposureTime?.trim() || UNKNOWN_VALUE;
    case 'focal': {
      const mm = firstNumber(exif?.FocalLength);
      return mm ? `${formatNumber(mm)} mm` : UNKNOWN_VALUE;
    }
    case 'edited':
      return image.is_edited ? 'edited' : 'unedited';
    case 'rating':
      return String(rating || 0);
    case 'flag':
      return image.flag === ImageFlag.Pick ? 'pick' : image.flag === ImageFlag.Reject ? 'reject' : 'none';
    case 'color':
      return (image.tags || []).find((tag) => tag.startsWith('color:'))?.substring(6) || 'none';
    case 'fileType': {
      const name = image.path.split(/[\\/]/).pop() || '';
      const ext = name.includes('.') ? name.split('.').pop()?.split('?')[0] : '';
      return ext ? ext.toUpperCase() : UNKNOWN_VALUE;
    }
  }
}

const shutterSeconds = (val: string) => {
  const clean = val.replace(/s/i, '').trim();
  const [num, den] = clean.split('/').map(parseFloat);
  return den ? num / den : num || 0;
};

export function compareMetadataFilterValues(field: MetadataFilterField, a: string, b: string): number {
  if (a === UNKNOWN_VALUE) return 1;
  if (b === UNKNOWN_VALUE) return -1;
  switch (field) {
    case 'date':
      return b.localeCompare(a);
    case 'iso':
    case 'aperture':
    case 'focal':
      return (firstNumber(a) ?? 0) - (firstNumber(b) ?? 0);
    case 'shutter':
      return shutterSeconds(b) - shutterSeconds(a);
    case 'rating':
      return Number(b) - Number(a);
    default:
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  }
}

export function matchesMetadataFilters(
  image: ImageFile,
  selections: MetadataFilterSelections,
  exif: Record<string, string> | undefined,
  rating: number,
  skipField?: MetadataFilterField,
): boolean {
  for (const [field, values] of Object.entries(selections) as Array<[MetadataFilterField, string[] | undefined]>) {
    if (!values || values.length === 0 || field === skipField) continue;
    if (!values.includes(getMetadataFilterValue(field, image, exif, rating))) return false;
  }
  return true;
}
