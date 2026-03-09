import { useState, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, ChevronDown, ChevronRight, Plus, Star, Tag, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import { SelectedImage, AppSettings, Invokes } from '../../ui/AppProperties';
import { COLOR_LABELS, Color } from '../../../utils/adjustments';

interface CameraSetting {
  format?(value: number): void;
  label: string;
}

interface CameraSettings {
  [index: string]: CameraSetting;
  ExposureTime: CameraSetting;
  FNumber: CameraSetting;
  FocalLengthIn35mmFilm: CameraSetting;
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
  rating: number;
  tags: string[];
  onRate(rating: number, paths?: string[]): void;
  onSetColorLabel(color: string | null, paths?: string[]): void;
  onTagsChanged(changedPaths: string[], newTags: { tag: string; isUser: boolean }[]): void;
  appSettings: AppSettings | null;
}

const USER_TAG_PREFIX = 'user:';

function formatExifTag(str: string) {
  if (!str) {
    return '';
  }
  return str.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
}

function parseDms(dmsString: string) {
  if (!dmsString) {
    return null;
  }
  const parts = dmsString.match(/(\d+\.?\d*)\s+deg\s+(\d+\.?\d*)\s+min\s+(\d+\.?\d*)\s+sec/);
  if (!parts) {
    return null;
  }
  const degrees = parseFloat(parts[1]);
  const minutes = parseFloat(parts[2]);
  const seconds = parseFloat(parts[3]);
  return degrees + minutes / 60 + seconds / 3600;
}

function MetadataItem({ label, value }: MetaDataItemProps) {
  return (
    <div className="grid grid-cols-3 gap-2 text-xs py-1.5 px-2 rounded odd:bg-bg-primary">
      <p className="font-semibold text-text-primary col-span-1 break-words">{label}</p>
      <p className="text-text-secondary col-span-2 break-words truncate" data-tooltip={String(value)}>
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
    format: (value: number) => `${value}`,
    label: 'Shutter Speed',
  },
  PhotographicSensitivity: {
    label: 'ISO',
  },
  FocalLengthIn35mmFilm: {
    format: (value: number) => (String(value).endsWith('mm') ? value : `${value} mm`),
    label: 'Focal Length',
  },
  LensModel: {
    format: (value: number) => String(value).replace(/"/g, ''),
    label: 'Lens',
  },
};

const KEY_SETTINGS_ORDER: Array<string> = [
  'FNumber',
  'ExposureTime',
  'PhotographicSensitivity',
  'FocalLengthIn35mmFilm',
  'LensModel',
];

export default function MetadataPanel({
  selectedImage,
  rating,
  tags,
  onRate,
  onSetColorLabel,
  onTagsChanged,
  appSettings,
}: MetaDataPanelProps) {
  const [isOrganizationExpanded, setIsOrganizationExpanded] = useState(false);
  const [tagInputValue, setTagInputValue] = useState('');
  const [isTagInputFocused, setIsTagInputFocused] = useState(false);

  const { keyCameraSettings, gpsData, otherExifEntries } = useMemo(() => {
    const exif = selectedImage?.exif || {};

    const keyCameraSettings = KEY_SETTINGS_ORDER.map((key) => {
      const value = exif[key];
      if (value === undefined || value === null) {
        return null;
      }
      const config = KEY_CAMERA_SETTINGS_MAP[key];
      const formattedValue = config.format ? config.format(value) : value;
      return {
        key: key,
        label: config.label,
        value: formattedValue,
      };
    }).filter(Boolean);

    const latStr = exif.GPSLatitude;
    const latRef = exif.GPSLatitudeRef;
    const lonStr = exif.GPSLongitude;
    const lonRef = exif.GPSLongitudeRef;

    const gpsData: GPSData = { lat: null, lon: null, altitude: exif.GPSAltitude || null };
    if (latStr && latRef && lonStr && lonRef) {
      const parsedLat = parseDms(latStr);
      const parsedLon = parseDms(lonStr);
      if (parsedLat !== null && parsedLon !== null) {
        gpsData.lat = latRef.toUpperCase() === 'S' ? -parsedLat : parsedLat;
        gpsData.lon = lonRef.toUpperCase() === 'W' ? -parsedLon : parsedLon;
      }
    }

    const otherExifEntries = Object.entries(exif).sort(([keyA], [keyB]) => keyA.localeCompare(keyB));

    return { keyCameraSettings, gpsData, otherExifEntries };
  }, [selectedImage?.exif]);

  const currentColor = useMemo(() => {
    return tags.find((tag: string) => tag.startsWith('color:'))?.substring(6) || null;
  }, [tags]);

  const currentTags = useMemo(() => {
    return tags
      .filter((t) => !t.startsWith('color:'))
      .map((t) => ({
        tag: t.startsWith(USER_TAG_PREFIX) ? t.substring(USER_TAG_PREFIX.length) : t,
        isUser: t.startsWith(USER_TAG_PREFIX),
      }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
  }, [tags]);

  const hasGps = gpsData.lat !== null && gpsData.lon !== null;

  const handleAddTag = async (tagToAdd: string) => {
    const newTagValue = tagToAdd.trim().toLowerCase();
    if (newTagValue && !currentTags.some((t) => t.tag === newTagValue)) {
      try {
        const prefixedTag = `${USER_TAG_PREFIX}${newTagValue}`;
        await invoke(Invokes.AddTagForPaths, { paths: [selectedImage.path], tag: prefixedTag });

        const newTags = [...currentTags, { tag: newTagValue, isUser: true }];
        onTagsChanged([selectedImage.path], newTags);
        setTagInputValue('');
      } catch (err) {
        console.error(`Failed to add tag: ${err}`);
      }
    }
  };

  const handleRemoveTag = async (tagToRemove: { tag: string; isUser: boolean }) => {
    try {
      const prefixedTag = tagToRemove.isUser ? `${USER_TAG_PREFIX}${tagToRemove.tag}` : tagToRemove.tag;
      await invoke(Invokes.RemoveTagForPaths, { paths: [selectedImage.path], tag: prefixedTag });

      const newTags = currentTags.filter((t) => t.tag !== tagToRemove.tag);
      onTagsChanged([selectedImage.path], newTags);
    } catch (err) {
      console.error(`Failed to remove tag: ${err}`);
    }
  };

  const handleTagInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddTag(tagInputValue);
    }
    e.stopPropagation();
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 flex justify-between items-center flex-shrink-0 border-b border-surface">
        <h2 className="text-xl font-bold text-primary text-shadow-shiny">Metadata</h2>
      </div>
      <div className="flex-grow overflow-y-auto p-4 text-text-secondary custom-scrollbar">
        {selectedImage ? (
          <div className="flex flex-col gap-6">
            <div>
              <h3 className="text-base font-bold text-text-primary mb-2 border-b border-surface pb-1">
                Image Properties
              </h3>
              <div className="flex flex-col gap-1">
                <MetadataItem label="Filename" value={selectedImage.path.split(/[\\/]/).pop()} />
                <MetadataItem label="Dimensions" value={`${selectedImage.width} x ${selectedImage.height}`} />
                <MetadataItem label="Capture Date" value={selectedImage.exif?.DateTimeOriginal || '-'} />
              </div>

              <div className="mt-3 bg-surface rounded-md border border-bg-primary overflow-hidden">
                <button
                  onClick={() => setIsOrganizationExpanded(!isOrganizationExpanded)}
                  className="w-full flex items-center justify-between p-3 text-xs font-semibold text-text-primary hover:bg-surface/50 transition-colors"
                >
                  <span className="flex items-center gap-2">
                    <Tag size={14} /> Organization
                  </span>
                  {isOrganizationExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>

                <AnimatePresence initial={false}>
                  {isOrganizationExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
                      className="overflow-hidden"
                    >
                      <div className="p-3 pt-0 border-t border-surface/50 flex flex-col gap-3">
                        <div className="mt-3">
                          <span className="text-xs text-text-tertiary uppercase tracking-wider font-bold mb-1 block">
                            Rating
                          </span>
                          <div className="flex items-center gap-1">
                            {[1, 2, 3, 4, 5].map((star) => (
                              <button
                                key={star}
                                onClick={() => onRate(star, [selectedImage.path])}
                                className="focus:outline-none transition-transform active:scale-95 hover:scale-110"
                              >
                                <Star
                                  size={20}
                                  className={clsx(
                                    'transition-colors duration-200',
                                    star <= rating
                                      ? 'fill-accent text-accent'
                                      : 'fill-transparent text-text-tertiary hover:text-text-secondary',
                                  )}
                                />
                              </button>
                            ))}
                          </div>
                        </div>
                        <div>
                          <span className="text-xs text-text-tertiary uppercase tracking-wider font-bold mb-2 mt-1 block">
                            Color Label
                          </span>
                          <div className="flex flex-wrap gap-2">
                            <button
                              onClick={() => onSetColorLabel(null, [selectedImage.path])}
                              className={clsx(
                                'w-5 h-5 rounded-full border border-text-tertiary/30 flex items-center justify-center transition-all hover:scale-110',
                                currentColor === null
                                  ? 'ring-2 ring-text-secondary ring-offset-1 ring-offset-bg-primary'
                                  : 'opacity-50 hover:opacity-100',
                              )}
                              data-tooltip="None"
                            >
                              <X size={12} className="text-text-tertiary" />
                            </button>
                            {COLOR_LABELS.map((color: Color) => (
                              <button
                                key={color.name}
                                onClick={() => onSetColorLabel(color.name, [selectedImage.path])}
                                className={clsx(
                                  'w-5 h-5 rounded-full transition-all hover:scale-110',
                                  currentColor === color.name
                                    ? 'ring-2 ring-white ring-offset-1 ring-offset-bg-primary'
                                    : 'hover:ring-2 hover:ring-white/20',
                                )}
                                style={{ backgroundColor: color.color }}
                                data-tooltip={color.name}
                              >
                                {currentColor === color.name && <Check size={12} className="text-black/50 mx-auto" />}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div>
                          <span className="text-xs text-text-tertiary uppercase tracking-wider font-bold mb-2 mt-1  block">
                            Tags
                          </span>
                          <div className="flex flex-wrap gap-1.5 mb-2">
                            <AnimatePresence>
                              {currentTags.length > 0 ? (
                                currentTags.map((tagItem) => (
                                  <motion.div
                                    key={tagItem.tag}
                                    layout
                                    initial={{ opacity: 0, scale: 0.8 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.8 }}
                                    className="flex items-center gap-1 bg-bg-primary text-text-primary text-xs font-medium px-2 py-1 rounded-md group cursor-pointer border border-surface hover:border-text-tertiary/50 transition-colors"
                                    onClick={() => handleRemoveTag(tagItem)}
                                  >
                                    <span>{tagItem.tag}</span>
                                    <X size={10} className="opacity-50 group-hover:opacity-100" />
                                  </motion.div>
                                ))
                              ) : (
                                <span className="text-xs text-text-tertiary italic">No tags</span>
                              )}
                            </AnimatePresence>
                          </div>

                          <div
                            className={clsx(
                              'flex items-center bg-surface border rounded-md px-2 py-1 transition-colors',
                              isTagInputFocused ? 'border-accent' : 'border-border-color',
                            )}
                          >
                            <input
                              type="text"
                              value={tagInputValue}
                              onChange={(e) => setTagInputValue(e.target.value)}
                              onKeyDown={handleTagInputKeyDown}
                              onFocus={() => setIsTagInputFocused(true)}
                              onBlur={() => setIsTagInputFocused(false)}
                              placeholder="Add tag..."
                              className="bg-transparent border-none outline-none text-xs w-full text-text-primary placeholder-text-tertiary"
                            />
                            <button
                              onClick={() => handleAddTag(tagInputValue)}
                              disabled={!tagInputValue.trim()}
                              className="text-text-secondary hover:text-accent disabled:opacity-30 transition-colors"
                            >
                              <Plus size={14} />
                            </button>
                          </div>
                          {appSettings?.taggingShortcuts && appSettings.taggingShortcuts.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {appSettings.taggingShortcuts.map((shortcut) => (
                                <button
                                  key={shortcut}
                                  onClick={() => handleAddTag(shortcut)}
                                  className="text-xs font-medium bg-bg-secondary hover:bg-card-active text-text-secondary px-1.5 py-0.5 rounded border border-transparent hover:border-border-color transition-all"
                                >
                                  {shortcut}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
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
                      data-tooltip="Click to open map in a new tab"
                    ></a>
                  </div>
                  <div className="flex flex-col gap-1">
                    <MetadataItem label="Latitude" value={gpsData.lat?.toFixed(6)} />
                    <MetadataItem label="Longitude" value={gpsData.lon?.toFixed(6)} />
                    {gpsData.altitude && <MetadataItem label="Altitude" value={gpsData.altitude} />}
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
                    <MetadataItem key={tag} label={formatExifTag(tag)} value={value} />
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
