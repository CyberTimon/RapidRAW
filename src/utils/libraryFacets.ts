import { ImageFile, LibraryFacetFilter } from '../components/ui/AppProperties';

export const GEO_EXIF_KEYS = {
  admin1: 'RapidRawGeoAdmin1',
  admin2: 'RapidRawGeoAdmin2',
  countryCode: 'RapidRawGeoCountryCode',
  name: 'RapidRawGeoName',
} as const;

export interface FacetChild {
  count: number;
  name: string;
}

export interface EquipmentFacetGroup {
  children: FacetChild[];
  count: number;
  make: string;
}

export interface LocationFacetGroup {
  admin1: string;
  children: FacetChild[];
  count: number;
  countryCode: string;
}

export interface GeoCoordinateRequest {
  latitude: number;
  longitude: number;
  path: string;
}

export interface GeoLocationResult {
  admin1: string;
  admin2: string;
  countryCode: string;
  name: string;
  path: string;
}

const getExifValue = (image: ImageFile, key: string): string => String(image.exif?.[key] ?? '').trim();

const sortChildren = (children: FacetChild[]) =>
  children.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

export function buildEquipmentFacetGroups(imageList: ImageFile[], kind: 'camera' | 'lens'): EquipmentFacetGroup[] {
  const makeKey = kind === 'camera' ? 'Make' : 'LensMake';
  const modelKey = kind === 'camera' ? 'Model' : 'LensModel';
  const groups = new Map<string, Map<string, number>>();

  for (const image of imageList) {
    const make = getExifValue(image, makeKey).toLocaleUpperCase('en-US');
    const model = getExifValue(image, modelKey);
    if (!make || !model) continue;

    const models = groups.get(make) ?? new Map<string, number>();
    models.set(model, (models.get(model) ?? 0) + 1);
    groups.set(make, models);
  }

  return Array.from(groups.entries())
    .map(([make, models]) => {
      const children = sortChildren(Array.from(models.entries()).map(([name, count]) => ({ name, count })));
      return {
        make,
        children,
        count: children.reduce((sum, child) => sum + child.count, 0),
      };
    })
    .sort((a, b) => a.make.localeCompare(b.make, undefined, { sensitivity: 'base' }));
}

export function buildLocationFacetGroups(imageList: ImageFile[]): LocationFacetGroup[] {
  const groups = new Map<string, { admin1: string; countryCode: string; names: Map<string, number> }>();

  for (const image of imageList) {
    const admin1 = getExifValue(image, GEO_EXIF_KEYS.admin1);
    const name = getExifValue(image, GEO_EXIF_KEYS.name);
    const countryCode = getExifValue(image, GEO_EXIF_KEYS.countryCode).toLocaleUpperCase('en-US');
    if (!admin1 || !name) continue;

    const key = `${countryCode}\u0000${admin1}`;
    const group = groups.get(key) ?? { admin1, countryCode, names: new Map<string, number>() };
    group.names.set(name, (group.names.get(name) ?? 0) + 1);
    groups.set(key, group);
  }

  return Array.from(groups.values())
    .map(({ admin1, countryCode, names }) => {
      const children = sortChildren(Array.from(names.entries()).map(([name, count]) => ({ name, count })));
      return {
        admin1,
        countryCode,
        children,
        count: children.reduce((sum, child) => sum + child.count, 0),
      };
    })
    .sort((a, b) => {
      const regionComparison = a.admin1.localeCompare(b.admin1, undefined, { sensitivity: 'base' });
      return regionComparison || a.countryCode.localeCompare(b.countryCode);
    });
}

function parseGpsCoordinate(value: string): number | null {
  const dms = value.match(/([-+]?\d+(?:\.\d+)?)\s+deg\s+(\d+(?:\.\d+)?)\s+min\s+(\d+(?:\.\d+)?)\s+sec/i);
  if (dms) {
    const degrees = Number(dms[1]);
    const minutes = Number(dms[2]);
    const seconds = Number(dms[3]);
    if ([degrees, minutes, seconds].every(Number.isFinite)) {
      const sign = degrees < 0 ? -1 : 1;
      return sign * (Math.abs(degrees) + minutes / 60 + seconds / 3600);
    }
  }

  const decimal = Number(value.trim());
  return Number.isFinite(decimal) ? decimal : null;
}

export function getGeoCoordinateRequest(image: ImageFile): GeoCoordinateRequest | null {
  if (!image.exif || getExifValue(image, GEO_EXIF_KEYS.name)) return null;

  const rawLatitude = getExifValue(image, 'GPSLatitude');
  const rawLongitude = getExifValue(image, 'GPSLongitude');
  if (!rawLatitude || !rawLongitude) return null;

  let latitude = parseGpsCoordinate(rawLatitude);
  let longitude = parseGpsCoordinate(rawLongitude);
  if (latitude === null || longitude === null) return null;

  const latitudeRef = getExifValue(image, 'GPSLatitudeRef').toLocaleUpperCase('en-US');
  const longitudeRef = getExifValue(image, 'GPSLongitudeRef').toLocaleUpperCase('en-US');
  if (latitudeRef === 'S') latitude = -Math.abs(latitude);
  if (latitudeRef === 'N') latitude = Math.abs(latitude);
  if (longitudeRef === 'W') longitude = -Math.abs(longitude);
  if (longitudeRef === 'E') longitude = Math.abs(longitude);

  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { path: image.path, latitude, longitude };
}

export function matchesLibraryFacet(image: ImageFile, facet: LibraryFacetFilter | null | undefined): boolean {
  if (!facet) return true;

  if (facet.kind === 'location') {
    const admin1 = getExifValue(image, GEO_EXIF_KEYS.admin1);
    const name = getExifValue(image, GEO_EXIF_KEYS.name);
    const countryCode = getExifValue(image, GEO_EXIF_KEYS.countryCode);
    if (admin1 !== facet.primary) return false;
    if (facet.countryCode && countryCode.toLocaleUpperCase('en-US') !== facet.countryCode.toLocaleUpperCase('en-US')) {
      return false;
    }
    return !facet.secondary || name === facet.secondary;
  }

  const makeKey = facet.kind === 'camera' ? 'Make' : 'LensMake';
  const modelKey = facet.kind === 'camera' ? 'Model' : 'LensModel';
  const make = getExifValue(image, makeKey);
  const model = getExifValue(image, modelKey);
  if (make.localeCompare(facet.primary, undefined, { sensitivity: 'accent' }) !== 0) return false;
  return !facet.secondary || model === facet.secondary;
}
