import { SortDirection, type ImageFile } from '../components/ui/AppProperties';

export const naturalNameCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;

function compareImageNames(a: ImageFile, b: ImageFile) {
  const name = (path: string) => path.split(/[\\/]/).pop() || path;
  return naturalNameCompare(name(a.path), name(b.path)) || naturalNameCompare(a.path, b.path) ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

// EXIF dates have no timezone unless the camera supplies one. Use a stable
// wall-clock timeline instead of the computer's local timezone/DST rules.
function captureTime(image: ImageFile): number | null {
  const raw = image.exif?.DateTimeOriginal;
  if (!raw) return null;
  const normalized = raw.trim().replace(/^"|"$/g, '').replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
  const value = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`);
  return Number.isFinite(value) ? value : null;
}

export const parseShutter = (val: string | undefined): number => {
  if (!val) return 0;
  const cleanVal = val.replace(/s/i, '').trim();
  const parts = cleanVal.split('/');
  if (parts.length === 2) {
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    return den !== 0 ? num / den : 0;
  }
  const numVal = parseFloat(cleanVal);
  return isNaN(numVal) ? 0 : numVal;
};

export const parseAperture = (val: string | undefined): number => {
  if (!val) return 0;
  const match = val.match(/(\d+(\.\d+)?)/);
  const numVal = match ? parseFloat(match[0]) : 0;
  return isNaN(numVal) ? 0 : numVal;
};

export const parseFocalLength = (val: string | undefined): number => {
  if (!val) return 0;
  const match = val.match(/(\d+(\.\d+)?)/);
  if (!match) return 0;
  const numVal = parseFloat(match[0]);
  return isNaN(numVal) ? 0 : numVal;
};

export function createLibraryComparator(sortCriteria: { key: string; order: string }, imageRatings: Record<string, number>) {
  return (a: ImageFile, b: ImageFile) => {
    const { key, order } = sortCriteria;
    let comparison = 0;

    switch (key) {
      case 'date_taken': {
        const dateA = captureTime(a);
        const dateB = captureTime(b);
        if (dateA === null || dateB === null) {
          if (dateA !== dateB) return dateA === null ? 1 : -1;
        } else comparison = dateA - dateB;
        break;
      }
      case 'iso': {
        const isoA = parseInt(a.exif?.PhotographicSensitivity || a.exif?.ISOSpeedRatings || '0', 10) || 0;
        const isoB = parseInt(b.exif?.PhotographicSensitivity || b.exif?.ISOSpeedRatings || '0', 10) || 0;
        comparison = isoA - isoB;
        break;
      }
      case 'shutter_speed': {
        comparison = parseShutter(a.exif?.ExposureTime) - parseShutter(b.exif?.ExposureTime);
        break;
      }
      case 'aperture': {
        comparison = parseAperture(a.exif?.FNumber) - parseAperture(b.exif?.FNumber);
        break;
      }
      case 'focal_length': {
        comparison = parseFocalLength(a.exif?.FocalLength) - parseFocalLength(b.exif?.FocalLength);
        break;
      }
      case 'date':
        comparison = a.modified - b.modified;
        break;
      case 'rating':
        comparison = (imageRatings[a.path] || 0) - (imageRatings[b.path] || 0);
        break;
      case 'edited':
        comparison = a.is_edited === b.is_edited ? 0 : a.is_edited ? 1 : -1;
        break;
      default:
        comparison = compareImageNames(a, b);
    }

    if (comparison === 0) comparison = compareImageNames(a, b);

    return order === SortDirection.Ascending ? comparison : -comparison;
  };
}
