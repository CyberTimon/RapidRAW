import { Cubit } from '@blac/core';
import type { ExifData } from '../../types/library.js';

interface GPSData {
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
}

interface KeyCameraSetting {
  key: string;
  label: string;
  value: string;
}

interface MetadataState {
  exif: ExifData | null;
  keyCameraSettings: KeyCameraSetting[];
  gpsData: GPSData;
  otherExifEntries: [string, unknown][];
  isLoading: boolean;
  error: string | null;
}

const KEY_SETTINGS_MAP: Record<string, { label: string; format?: (value: unknown) => string }> = {
  FNumber: {
    label: 'Aperture',
    format: (value) => `f/${value}`,
  },
  ExposureTime: {
    label: 'Shutter Speed',
    format: (value) => String(value),
  },
  ISO: {
    label: 'ISO',
    format: (value) => String(value),
  },
  FocalLength: {
    label: 'Focal Length',
    format: (value) => {
      const str = String(value);
      return str.endsWith('mm') ? str : `${value}mm`;
    },
  },
  LensModel: {
    label: 'Lens',
    format: (value) => String(value).replace(/"/g, ''),
  },
};

const KEY_SETTINGS_ORDER = ['FNumber', 'ExposureTime', 'ISO', 'FocalLength', 'LensModel'];

const GPS_KEYS = [
  'GPSLatitude',
  'GPSLatitudeRef',
  'GPSLongitude',
  'GPSLongitudeRef',
  'GPSAltitude',
  'GPSAltitudeRef',
];

function _parseDmsString(dmsString: string): number | null {
  if (!dmsString) return null;
  const parts = dmsString.match(/(\d+\.?\d*)\s+deg\s+(\d+\.?\d*)\s+min\s+(\d+\.?\d*)\s+sec/);
  if (!parts) return null;
  const degrees = parseFloat(parts[1]);
  const minutes = parseFloat(parts[2]);
  const seconds = parseFloat(parts[3]);
  return degrees + minutes / 60 + seconds / 3600;
}

export class MetadataBloc extends Cubit<MetadataState> {
  constructor() {
    super({
      exif: null,
      keyCameraSettings: [],
      gpsData: { latitude: null, longitude: null, altitude: null },
      otherExifEntries: [],
      isLoading: false,
      error: null,
    });
  }

  setExif = (exif: ExifData | null) => {
    if (!exif) {
      this.emit({
        exif: null,
        keyCameraSettings: [],
        gpsData: { latitude: null, longitude: null, altitude: null },
        otherExifEntries: [],
        isLoading: false,
        error: null,
      });
      return;
    }

    const keyCameraSettings = this.extractKeyCameraSettings(exif);
    const gpsData = this.extractGpsData(exif);
    const otherExifEntries = this.extractOtherEntries(exif);

    this.emit({
      exif,
      keyCameraSettings,
      gpsData,
      otherExifEntries,
      isLoading: false,
      error: null,
    });
  };

  private extractKeyCameraSettings = (exif: ExifData): KeyCameraSetting[] => {
    const settings: KeyCameraSetting[] = [];

    for (const key of KEY_SETTINGS_ORDER) {
      const value = exif[key as keyof ExifData];
      if (value === undefined || value === null) continue;

      const config = KEY_SETTINGS_MAP[key];
      if (!config) continue;

      const formattedValue = config.format ? config.format(value) : String(value);
      settings.push({
        key,
        label: config.label,
        value: formattedValue,
      });
    }

    return settings;
  };

  private extractGpsData = (exif: ExifData): GPSData => {
    const data: GPSData = {
      latitude: null,
      longitude: null,
      altitude: exif.GPSAltitude ?? null,
    };

    if (exif.GPSLatitude !== undefined && exif.GPSLongitude !== undefined) {
      if (typeof exif.GPSLatitude === 'number') {
        data.latitude = exif.GPSLatitude;
        data.longitude = exif.GPSLongitude ?? null;
      }
    }

    return data;
  };

  private extractOtherEntries = (exif: ExifData): [string, unknown][] => {
    return Object.entries(exif)
      .filter(([key]) => !KEY_SETTINGS_ORDER.includes(key) && !GPS_KEYS.includes(key))
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB));
  };

  setLoading = (isLoading: boolean) => {
    this.patch({ isLoading });
  };

  setError = (error: string | null) => {
    this.patch({ error, isLoading: false });
  };

  clearMetadata = () => {
    this.emit({
      exif: null,
      keyCameraSettings: [],
      gpsData: { latitude: null, longitude: null, altitude: null },
      otherExifEntries: [],
      isLoading: false,
      error: null,
    });
  };

  get hasExif(): boolean {
    return this.state.exif !== null && Object.keys(this.state.exif).length > 0;
  }

  get hasGps(): boolean {
    const { gpsData } = this.state;
    return gpsData.latitude !== null && gpsData.longitude !== null;
  }

  get hasKeyCameraSettings(): boolean {
    return this.state.keyCameraSettings.length > 0;
  }
}
