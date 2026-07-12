import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ImageOff, Upload, X, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { useContextMenu } from '../../context/ContextMenuContext';
import { toast } from 'react-toastify';
import Slider from './Slider';
import { useEditorStore } from '../../store/useEditorStore';
import { useSettingsStore } from '../../store/useSettingsStore';

interface LutEntry {
  name: string;
  path: string;
}

interface LutPreview {
  path: string;
  thumb: string | null;
}

interface LUTControlProps {
  lutPath: string | null;
  lutName: string | null;
  lutIntensity: number;
  onLutSelect: (path: string) => void;
  onLutHover?: (path: string | null) => void;
  onIntensityChange: (intensity: number) => void;
  onClear: () => void;
  onDragStateChange?: (isDragging: boolean) => void;
}

const PREVIEW_SIZE = 112;

export default function LUTControl({
  lutPath,
  lutName,
  lutIntensity,
  onLutSelect,
  onLutHover,
  onIntensityChange,
  onClear,
  onDragStateChange,
}: LUTControlProps) {
  const { t } = useTranslation();
  const { showContextMenu } = useContextMenu();
  const selectedImagePath = useEditorStore((state) => state.selectedImage?.path ?? null);
  const isImageReady = useEditorStore((state) => state.selectedImage?.isReady ?? false);

  const [isExpanded, setIsExpanded] = useState(false);
  const [entries, setEntries] = useState<LutEntry[]>([]);
  const [previews, setPreviews] = useState<Record<string, string | null>>({});
  const [isLoadingPreviews, setIsLoadingPreviews] = useState(false);
  const previewCache = useRef<Map<string, Record<string, string | null>>>(new Map());

  const handleContextMenu = (event: React.MouseEvent, entry: LutEntry) => {
    event.preventDefault();
    event.stopPropagation();

    showContextMenu(event.clientX, event.clientY, [
      {
        label: t('ui.lut.removeLut'),
        icon: Trash2,
        isDestructive: true,
        onClick: async () => {
          try {
            const updatedList = await invoke<LutEntry[]>('remove_lut', { path: entry.path });
            setEntries(updatedList);
            setPreviews((prev) => {
              const next = { ...prev };
              delete next[entry.path];
              return next;
            });
            previewCache.current.clear();
            if (entry.path === lutPath) {
              onClear();
            }
          } catch (err) {
            console.error('Failed to remove LUT:', err);
          }
        },
      },
    ]);
  };

  const refreshList = useCallback(async () => {
    try {
      const list = await invoke<LutEntry[]>('list_luts');
      setEntries(list);
    } catch (err) {
      console.error('Failed to list LUTs:', err);
    }
  }, []);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  useEffect(() => {
    if (!isExpanded || !selectedImagePath || !isImageReady || entries.length === 0) {
      return;
    }
    const cacheKey = `${selectedImagePath}|${entries.map((entry) => entry.path).join(',')}`;
    const cached = previewCache.current.get(cacheKey);
    if (cached) {
      setPreviews(cached);
      return;
    }

    let isActive = true;
    setIsLoadingPreviews(true);
    invoke<LutPreview[]>('generate_lut_previews', {
      lutPaths: entries.map((entry) => entry.path),
      size: PREVIEW_SIZE,
    })
      .then((results) => {
        if (!isActive) return;
        const map: Record<string, string | null> = {};
        results.forEach((result) => {
          map[result.path] = result.thumb;
        });
        previewCache.current.set(cacheKey, map);
        setPreviews(map);
      })
      .catch((err) => console.error('Failed to generate LUT previews:', err))
      .finally(() => {
        if (isActive) setIsLoadingPreviews(false);
      });
    return () => {
      isActive = false;
    };
  }, [isExpanded, selectedImagePath, isImageReady, entries]);

  const handleImport = async () => {
    try {
      const { osPlatform } = useSettingsStore.getState();
      const isAndroid = osPlatform === 'android';

      const selected = await open({
        multiple: true,
        filters: isAndroid ? [] : [{ name: t('ui.lut.filterLabel'), extensions: ['cube', '3dl', 'CUBE', '3DL'] }],
      });
      const sourcePaths = Array.isArray(selected) ? selected : selected ? [selected] : [];
      if (sourcePaths.length === 0) return;

      let validPaths = sourcePaths;
      if (isAndroid) {
        const resolvedNames = await Promise.all(
          sourcePaths.map(async (path) => {
            try {
              return await invoke<string>('resolve_android_content_uri_name', { uriStr: path });
            } catch (e) {
              console.error('Failed to resolve Android URI:', e);
              return path;
            }
          })
        );
        const allowedExtensions = new Set(['cube', '3dl']);
        validPaths = sourcePaths.filter((_, index) => {
          const resolvedName = resolvedNames[index];
          const ext = resolvedName.split('.').pop()?.toLowerCase() || '';
          if (!allowedExtensions.has(ext)) {
            console.warn(`Skipping unsupported file: ${resolvedName}`);
            return false;
          }
          return true;
        });
        if (validPaths.length === 0) {
          toast.error(t('ui.lut.importFailed'));
          return;
        }
      }

      const list = await invoke<LutEntry[]>('import_luts', { sourcePaths: validPaths });
      previewCache.current.clear();
      setEntries(list);
      setPreviews({});
    } catch (err) {
      console.error('Failed to import LUTs:', err);
      toast.error(t('ui.lut.importFailed'));
    }
  };

  const handleSwatchClick = (path: string) => {
    onLutHover?.(null);
    if (path === lutPath) {
      onClear();
    } else {
      onLutSelect(path);
    }
  };

  return (
    <div className="mb-2">
      <div className="flex justify-between items-center">
        <span className="text-sm font-medium text-text-secondary select-none">{t('ui.lut.label')}</span>
        <div className="flex items-center gap-1">
          {lutName && (
            <button
              onClick={onClear}
              className="flex items-center justify-center p-0.5 rounded-full bg-bg-tertiary hover:bg-surface text-text-secondary hover:text-text-primary transition-colors"
              data-tooltip={t('ui.lut.clearLut')}
            >
              <X size={14} />
            </button>
          )}
          <button
            onClick={() => setIsExpanded((value) => !value)}
            className="flex items-center gap-1 text-sm text-text-secondary select-none cursor-pointer hover:text-accent transition-colors"
            data-tooltip={lutName || t('ui.lut.selectLutFile')}
          >
            <span className="truncate max-w-35 text-right">{lutName || t('ui.lut.select')}</span>
            <ChevronDown size={16} className={`transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="mt-2 pb-1">
              {entries.length === 0 ? (
                <button
                  onClick={handleImport}
                  className="w-full flex items-center justify-center gap-1.5 py-4 rounded-md bg-bg-tertiary hover:bg-surface border-2 border-dashed border-text-secondary/20 hover:border-text-secondary/40 text-sm text-text-primary transition-colors"
                >
                  <Upload size={16} />
                  {t('ui.lut.import')}
                </button>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  {entries.map((entry) => {
                    const thumb = previews[entry.path];
                    const isSelected = entry.path === lutPath;
                    return (
                      <button
                        key={entry.path}
                        onMouseEnter={() => onLutHover?.(entry.path)}
                        onMouseLeave={() => onLutHover?.(null)}
                        onClick={() => handleSwatchClick(entry.path)}
                        onContextMenu={(e) => handleContextMenu(e, entry)}
                        className={`relative aspect-square rounded-md overflow-hidden bg-bg-tertiary border-2 transition-colors ${
                          isSelected ? 'border-accent' : 'border-transparent hover:border-surface'
                        }`}
                        data-tooltip={entry.name}
                      >
                        {isLoadingPreviews && thumb === undefined ? (
                          <div className="w-full h-full animate-pulse bg-surface" />
                        ) : thumb ? (
                          <img src={thumb} alt={entry.name} className="w-full h-full object-cover" draggable={false} />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-text-secondary">
                            <ImageOff size={18} />
                          </div>
                        )}
                        <span className="absolute inset-x-0 bottom-0 px-1 py-0.5 text-[10px] text-white bg-black/50 truncate text-left">
                          {entry.name}
                        </span>
                      </button>
                    );
                  })}
                  <button
                    onClick={handleImport}
                    className="aspect-square rounded-md bg-bg-tertiary border-2 border-text-secondary/25 hover:border-accent flex items-center justify-center text-text-secondary hover:text-text-primary transition-all duration-150"
                    data-tooltip={t('ui.lut.import')}
                  >
                    <Upload size={20} />
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {lutName && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="mt-2">
              <Slider
                label={t('ui.lut.intensity')}
                min={0}
                max={100}
                step={1}
                value={lutIntensity}
                defaultValue={100}
                onChange={(e) => onIntensityChange(parseInt(e.target.value, 10))}
                onDragStateChange={onDragStateChange}
                fillOrigin="min"
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
