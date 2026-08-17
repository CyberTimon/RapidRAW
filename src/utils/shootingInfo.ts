export interface ShootingInfo {
  aperture: string | null;
  focalLength: string | null;
  hasAny: boolean;
  iso: string | null;
  shutter: string | null;
}

type ExifData = Record<string, string> | null | undefined;

function firstValue(exif: ExifData, keys: string[]): string | null {
  for (const key of keys) {
    const value = exif?.[key]?.trim();
    if (value) return value;
  }
  return null;
}

function formatAperture(value: string | null): string | null {
  if (!value) return null;
  return value.toLowerCase().startsWith('f') ? value : `f/${value}`;
}

function formatFocalLength(value: string | null): string | null {
  if (!value) return null;
  const withoutUnit = value.replace(/\s*mm$/i, '').trim();
  const numericValue = Number(withoutUnit);
  const displayValue = Number.isFinite(numericValue) ? Number(numericValue.toFixed(1)).toString() : withoutUnit;
  return `${displayValue} mm`;
}

function formatIso(value: string | null): string | null {
  if (!value) return null;
  return `ISO ${value.replace(/^iso\s*/i, '')}`;
}

function formatShutter(value: string | null): string | null {
  if (!value) return null;
  if (/\b(?:s|sec\.?|seconds?)$/i.test(value)) return value.replace(/\s*(?:sec\.?|seconds?)$/i, 's');
  return `${value}s`;
}

export function getShootingInfo(exif: ExifData): ShootingInfo {
  const aperture = formatAperture(firstValue(exif, ['FNumber', 'ApertureValue']));
  const focalLength = formatFocalLength(firstValue(exif, ['FocalLength', 'FocalLengthIn35mmFilm']));
  const iso = formatIso(firstValue(exif, ['PhotographicSensitivity', 'ISOSpeed', 'ISOSpeedRatings', 'ISO']));
  const shutter = formatShutter(firstValue(exif, ['ExposureTime']));

  return {
    aperture,
    focalLength,
    hasAny: Boolean(aperture || focalLength || iso || shutter),
    iso,
    shutter,
  };
}
