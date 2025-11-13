import React, { useMemo } from 'react';
import { SelectedImage } from '../../ui/AppProperties';

interface CameraSetting {
  label: string;
}

interface CameraSettings {
  [index: string]: CameraSetting;
  ExposureTime: CameraSetting;
  FNumber: CameraSetting;
  FocalLength: CameraSetting;
  LensModel: CameraSetting;
  PhotographicSensitivity: CameraSetting;
}

interface GPSData {
  altitude: number | null;
  lat: number | null;
  lon: number | null;
}

interface MetaDataItemProps {
  label: string;
  value: any;
}

interface MetaDataPanelProps {
  selectedImage: SelectedImage;
}

function formatExifTag(str: string) {
  if (!str) {
    return '';
  }
  return str.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
}

// Parse rational value (e.g., "1/500" or "28/1")
function parseRational(value: string): number | null {
  if (!value || typeof value !== 'string') return null;
  const parts = value.split('/');
  if (parts.length !== 2) return null;
  const numerator = parseFloat(parts[0]);
  const denominator = parseFloat(parts[1]);
  if (isNaN(numerator) || isNaN(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

// Format exposure time (shutter speed)
function formatExposureTime(value: string): string {
  const rational = parseRational(value);
  if (rational === null) return value;

  if (rational >= 1) {
    return `${rational.toFixed(1)}s`;
  } else {
    const parts = value.split('/');
    if (parts[0] === '1') {
      return `1/${parts[1]}s`;
    }
    return `1/${Math.round(1 / rational)}s`;
  }
}

// Format F-number (aperture)
function formatFNumber(value: string): string {
  const rational = parseRational(value);
  if (rational === null) return value;
  return `f/${rational.toFixed(1)}`;
}

// Format focal length
function formatFocalLength(value: string): string {
  const rational = parseRational(value);
  if (rational === null) return value;
  return `${rational.toFixed(0)} mm`;
}

// Decode EXIF enum values
function decodeExifEnum(tag: string, value: string): string {
  const numValue = parseInt(value, 10);
  if (isNaN(numValue)) return value;

  switch (tag) {
    case 'ExposureProgram':
      const exposurePrograms: { [key: number]: string } = {
        0: 'Not Defined',
        1: 'Manual',
        2: 'Program AE',
        3: 'Aperture Priority',
        4: 'Shutter Priority',
        5: 'Creative Program',
        6: 'Action Program',
        7: 'Portrait Mode',
        8: 'Landscape Mode',
      };
      return exposurePrograms[numValue] || `Unknown (${value})`;

    case 'MeteringMode':
      const meteringModes: { [key: number]: string } = {
        0: 'Unknown',
        1: 'Average',
        2: 'Center-weighted Average',
        3: 'Spot',
        4: 'Multi-spot',
        5: 'Multi-segment',
        6: 'Partial',
        255: 'Other',
      };
      return meteringModes[numValue] || `Unknown (${value})`;

    case 'LightSource':
      const lightSources: { [key: number]: string } = {
        0: 'Unknown',
        1: 'Daylight',
        2: 'Fluorescent',
        3: 'Tungsten',
        4: 'Flash',
        9: 'Fine Weather',
        10: 'Cloudy',
        11: 'Shade',
        17: 'Standard Light A',
        18: 'Standard Light B',
        19: 'Standard Light C',
        20: 'D55',
        21: 'D65',
        22: 'D75',
        23: 'D50',
        24: 'ISO Studio Tungsten',
        255: 'Other',
      };
      return lightSources[numValue] || `Unknown (${value})`;

    case 'Flash':
      if (numValue === 0) return 'No Flash';
      const parts: string[] = [];
      if (numValue & 0x01) parts.push('Fired');
      if (numValue & 0x40) parts.push('Red-eye reduction');
      return parts.length > 0 ? parts.join(', ') : `Flash (${value})`;

    case 'WhiteBalance':
      return numValue === 0 ? 'Auto' : numValue === 1 ? 'Manual' : `Unknown (${value})`;

    case 'ExposureMode':
      const exposureModes: { [key: number]: string } = {
        0: 'Auto',
        1: 'Manual',
        2: 'Auto Bracket',
      };
      return exposureModes[numValue] || `Unknown (${value})`;

    case 'SceneCaptureType':
      const sceneTypes: { [key: number]: string } = {
        0: 'Standard',
        1: 'Landscape',
        2: 'Portrait',
        3: 'Night Scene',
      };
      return sceneTypes[numValue] || `Unknown (${value})`;

    case 'SubjectDistanceRange':
      const distanceRanges: { [key: number]: string } = {
        0: 'Unknown',
        1: 'Macro',
        2: 'Close View',
        3: 'Distant View',
      };
      return distanceRanges[numValue] || `Unknown (${value})`;

    case 'ColorSpace':
      return numValue === 1 ? 'sRGB' : numValue === 65535 ? 'Uncalibrated' : `Unknown (${value})`;

    case 'GPSAltitudeRef':
      return numValue === 0 ? 'Above Sea Level' : 'Below Sea Level';

    default:
      return value;
  }
}

// Format EXIF value based on tag
function formatExifValue(tag: string, value: any): string {
  if (value === null || value === undefined) return '';
  const strValue = String(value);

  switch (tag) {
    case 'ExposureTime':
      return formatExposureTime(strValue);
    case 'FNumber':
      return formatFNumber(strValue);
    case 'FocalLength':
      return formatFocalLength(strValue);
    case 'ExposureProgram':
    case 'MeteringMode':
    case 'LightSource':
    case 'Flash':
    case 'WhiteBalance':
    case 'ExposureMode':
    case 'SceneCaptureType':
    case 'SubjectDistanceRange':
    case 'ColorSpace':
    case 'GPSAltitudeRef':
      return decodeExifEnum(tag, strValue);
    case 'GPSAltitude':
      const altitude = parseRational(strValue);
      return altitude !== null ? `${altitude.toFixed(2)} m` : strValue;
    case 'SubjectDistance':
      const distance = parseRational(strValue);
      return distance !== null ? `${distance.toFixed(2)} m` : strValue;
    default:
      // For other rational values, just convert to decimal
      if (strValue.includes('/')) {
        const rational = parseRational(strValue);
        if (rational !== null) {
          return rational.toFixed(2);
        }
      }
      return strValue;
  }
}

function parseDms(dmsString: string) {
  if (!dmsString) {
    return null;
  }

  // Try rawler format: "35.69277 deg 24.37944 min 23.84 sec"
  let parts = dmsString.match(/(\d+\.?\d*)\s+deg\s+(\d+\.?\d*)\s+min\s+(\d+\.?\d*)\s+sec/);
  if (parts) {
    const degrees = parseFloat(parts[1]);
    const minutes = parseFloat(parts[2]);
    const seconds = parseFloat(parts[3]);
    return degrees + minutes / 60 + seconds / 3600;
  }

  // Try kamadak-exif format with symbols: "35°41'21.95\""
  parts = dmsString.match(/(\d+\.?\d*)°\s*(\d+\.?\d*)'\s*(\d+\.?\d*)"?/);
  if (parts) {
    const degrees = parseFloat(parts[1]);
    const minutes = parseFloat(parts[2]);
    const seconds = parseFloat(parts[3]);
    return degrees + minutes / 60 + seconds / 3600;
  }

  // Try comma-separated format: "35, 41, 21.95"
  parts = dmsString.match(/(\d+\.?\d*),\s*(\d+\.?\d*),\s*(\d+\.?\d*)/);
  if (parts) {
    const degrees = parseFloat(parts[1]);
    const minutes = parseFloat(parts[2]);
    const seconds = parseFloat(parts[3]);
    return degrees + minutes / 60 + seconds / 3600;
  }

  // If none of the formats match, try parsing as a decimal number
  const decimal = parseFloat(dmsString);
  if (!isNaN(decimal)) {
    return decimal;
  }

  return null;
}

function MetadataItem({ label, value }: MetaDataItemProps) {
  return (
    <div className="grid grid-cols-3 gap-2 text-xs py-1.5 px-2 rounded odd:bg-bg-primary">
      <p className="font-semibold text-text-primary col-span-1 break-words">{label}</p>
      <p className="text-text-secondary col-span-2 break-words truncate" title={String(value)}>
        {String(value)}
      </p>
    </div>
  );
}

const KEY_CAMERA_SETTINGS_MAP: CameraSettings = {
  FNumber: {
    format: (value: number) => `${value}`,
    label: 'Aperture',
  },
  ExposureTime: {
    label: 'Shutter Speed',
  },
  PhotographicSensitivity: {
    label: 'ISO',
  },
  FocalLength: {
    label: 'Focal Distance',
  },
  LensModel: {
    label: 'Lens',
  },
};

const KEY_SETTINGS_ORDER: Array<string> = [
  'FNumber',
  'ExposureTime',
  'PhotographicSensitivity',
  'FocalLength',
  'LensModel',
];

export default function MetadataPanel({ selectedImage }: MetaDataPanelProps) {
  const { keyCameraSettings, gpsData, otherExifEntries } = useMemo(() => {
    const exif = selectedImage?.exif || {};

    const keyCameraSettings = KEY_SETTINGS_ORDER.map((key) => {
      const value = exif[key];
      if (value === undefined || value === null) {
        return null;
      }
      const config = KEY_CAMERA_SETTINGS_MAP[key];
      const formattedValue = formatExifValue(key, value);
      return {
        key: key,
        label: config.label,
        value: formattedValue,
      };
    }).filter(Boolean);

    const gpsKeys = [
      'GPSLatitude',
      'GPSLatitudeRef',
      'GPSLongitude',
      'GPSLongitudeRef',
      'GPSAltitude',
      'GPSAltitudeRef',
    ];
    const latStr = exif.GPSLatitude;
    const latRef = exif.GPSLatitudeRef;
    const lonStr = exif.GPSLongitude;
    const lonRef = exif.GPSLongitudeRef;

    // Parse GPS altitude from various formats
    let altitude: number | null = null;
    if (exif.GPSAltitude) {
      const altStr = String(exif.GPSAltitude);

      // Try parsing as rational (rawler format: "123/1")
      const altRational = parseRational(altStr);
      if (altRational !== null) {
        // Apply altitude reference (0 = above sea level, 1 = below sea level)
        const altRef = exif.GPSAltitudeRef ? parseInt(String(exif.GPSAltitudeRef), 10) : 0;
        altitude = altRef === 1 ? -altRational : altRational;
      } else {
        // Try parsing as formatted string (kamadak-exif format: "123.45 m" or "123.45")
        const match = altStr.match(/(-?\d+\.?\d*)\s*m?/);
        if (match) {
          altitude = parseFloat(match[1]);
        }
      }
    }

    let gpsData: GPSData = { lat: null, lon: null, altitude };
    if (latStr && latRef && lonStr && lonRef) {
      const parsedLat = parseDms(latStr);
      const parsedLon = parseDms(lonStr);
      if (parsedLat !== null && parsedLon !== null) {
        gpsData.lat = latRef.toUpperCase() === 'S' ? -parsedLat : parsedLat;
        gpsData.lon = lonRef.toUpperCase() === 'W' ? -parsedLon : parsedLon;
      }
    }

    const otherExifEntries = Object.entries(exif)
      .filter(
        ([key]) => !KEY_SETTINGS_ORDER.includes(key) && !gpsKeys.includes(key),
      )
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB));

    return { keyCameraSettings, gpsData, otherExifEntries };
  }, [selectedImage?.exif]);

  const hasGps = gpsData.lat !== null && gpsData.lon !== null;

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 flex justify-between items-center flex-shrink-0 border-b border-surface">
        <h2 className="text-xl font-bold text-primary text-shadow-shiny">Metadata</h2>
      </div>
      <div className="flex-grow overflow-y-auto p-4 text-text-secondary">
        {selectedImage ? (
          <div className="flex flex-col gap-6">
            <div>
              <h3 className="text-base font-bold text-text-primary mb-2 border-b border-surface pb-1">
                File Properties
              </h3>
              <div className="flex flex-col gap-1">
                <MetadataItem label="Filename" value={selectedImage.path.split(/[\\/]/).pop()} />
                <MetadataItem label="Dimensions" value={`${selectedImage.width} x ${selectedImage.height}`} />
              </div>
            </div>

            {keyCameraSettings.length > 0 && (
              <div>
                <h3 className="text-base font-bold text-text-primary mb-2 border-b border-surface pb-1">
                  Key Camera Settings
                </h3>
                <div className="flex flex-col gap-1">
                  {keyCameraSettings.map((item: any) => (
                    <MetadataItem key={item.key} label={item.label} value={item.value} />
                  ))}
                </div>
              </div>
            )}

            {hasGps && gpsData?.lat && gpsData?.lon && (
              <div>
                <h3 className="text-base font-bold text-text-primary mb-2 border-b border-surface pb-1">
                  GPS Location
                </h3>
                <div className="flex flex-col gap-2">
                  <div className="relative rounded-md overflow-hidden border border-surface">
                    <iframe
                      className="pointer-events-none"
                      frameBorder="0"
                      height="180"
                      loading="lazy"
                      marginHeight={0}
                      marginWidth={0}
                      scrolling="no"
                      src={`https://www.openstreetmap.org/export/embed.html?bbox=${gpsData.lon - 0.01}%2C${
                        gpsData.lat - 0.01
                      }%2C${gpsData.lon + 0.01}%2C${gpsData.lat + 0.01}&layer=mapnik&marker=${gpsData.lat}%2C${
                        gpsData.lon
                      }`}
                      width="100%"
                    ></iframe>
                    <a
                      className="absolute inset-0 cursor-pointer"
                      href={`https://www.openstreetmap.org/?mlat=${gpsData.lat}&mlon=${gpsData.lon}#map=15/${gpsData.lat}/${gpsData.lon}`}
                      rel="noopener noreferrer"
                      target="_blank"
                      title="Click to open map in a new tab"
                    ></a>
                  </div>
                  <div className="flex flex-col gap-1">
                    <MetadataItem label="Latitude" value={gpsData.lat?.toFixed(6)} />
                    <MetadataItem label="Longitude" value={gpsData.lon?.toFixed(6)} />
                    {gpsData.altitude !== null && <MetadataItem label="Altitude" value={`${gpsData.altitude.toFixed(2)} m`} />}
                  </div>
                </div>
              </div>
            )}

            {otherExifEntries.length > 0 && (
              <div>
                <h3 className="text-base font-bold text-text-primary mb-2 border-b border-surface pb-1">
                  All EXIF Data
                </h3>
                <div className="flex flex-col gap-1">
                  {otherExifEntries.map(([tag, value]) => (
                    <MetadataItem key={tag} label={formatExifTag(tag)} value={formatExifValue(tag, value)} />
                  ))}
                </div>
              </div>
            )}

            {Object.keys(selectedImage.exif || {}).length === 0 && (
              <p className="text-xs text-center text-text-secondary mt-4">No EXIF data found in this file.</p>
            )}
          </div>
        ) : (
          <p className="text-center">No image selected.</p>
        )}
      </div>
    </div>
  );
}
