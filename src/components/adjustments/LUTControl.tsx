import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, FolderOpen, ImageOff, RefreshCw, Search, Star, Upload, X, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { useContextMenu } from '../../context/ContextMenuContext';
import { toast } from 'react-toastify';
import Slider from '../ui/Slider';
import { useEditorStore } from '../../store/useEditorStore';
import { useSettingsStore } from '../../store/useSettingsStore';

interface LutEntry {
  name: string;
  path: string;
  isBuiltIn: boolean;
  folder?: string | null;
}

interface LutPreview {
  path: string;
  thumb: string | null;
}

interface LUTControlProps {
  lutPath: string | null;
  lutName: string | null;
  lutIntensity: number;
  onLutSelect: (path: string, isBuiltIn: boolean) => void;
  onLutHover?: (path: string | null, isBuiltIn?: boolean) => void;
  onIntensityChange: (intensity: number) => void;
  onClear: () => void;
  onDragStateChange?: (isDragging: boolean) => void;
}

const PREVIEW_SIZE = 112;
const SUPPORTED_EXTENSIONS = ['cube', '3dl', 'png', 'jpg', 'jpeg', 'tiff'];
const FAVORITES_KEY = 'rapidraw.lut.favorites';
const RECENT_KEY = 'rapidraw.lut.recent';
const MAX_RECENT = 6;
const MAX_PREVIEW_IMAGE_CACHE = 8;

const readStringList = (key: string): string[] => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
};

const writeStringList = (key: string, values: string[]) => {
  try {
    localStorage.setItem(key, JSON.stringify(values));
  } catch {
    // Persistence is optional; the in-memory list still works.
  }
};

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
  const [search, setSearch] = useState('');
  const [previews, setPreviews] = useState<Record<string, string | null>>({});
  const [visiblePaths, setVisiblePaths] = useState<Set<string>>(new Set());
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set(readStringList(FAVORITES_KEY)));
  const [recent, setRecent] = useState<string[]>(() => readStringList(RECENT_KEY).slice(0, MAX_RECENT));
  const previewCache = useRef<Map<string, Map<string, string | null>>>(new Map());
  const expandedRef = useRef<HTMLDivElement>(null);

  const toggleFavorite = (path: string) => {
    setFavorites((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      writeStringList(FAVORITES_KEY, Array.from(next));
      return next;
    });
  };

  const rememberRecent = (path: string) => {
    setRecent((previous) => {
      const next = [path, ...previous.filter((item) => item !== path)].slice(0, MAX_RECENT);
      writeStringList(RECENT_KEY, next);
      return next;
    });
  };

  const handleContextMenu = (event: React.MouseEvent, entry: LutEntry) => {
    if (entry.isBuiltIn) return;

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
            toast.error(String(err));
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

  const filteredEntries = useMemo(() => {
    const tokens = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return entries;
    return entries.filter((entry) => {
      const name = entry.name.toLowerCase();
      return tokens.every((token) => name.includes(token));
    });
  }, [entries, search]);

  useEffect(() => {
    setPreviews({});
    setVisiblePaths(new Set());
  }, [selectedImagePath]);

  useEffect(() => {
    setVisiblePaths(new Set());
  }, [filteredEntries]);

  useEffect(() => {
    if (!isExpanded) return;
    const container = expandedRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (observed) => {
        const paths = observed
          .filter((entry) => entry.isIntersecting)
          .map((entry) => (entry.target as HTMLElement).dataset.lutPath)
          .filter((path): path is string => Boolean(path));
        if (paths.length === 0) return;
        setVisiblePaths((previous) => {
          let changed = false;
          const next = new Set(previous);
          paths.forEach((path) => {
            if (!next.has(path)) {
              next.add(path);
              changed = true;
            }
          });
          return changed ? next : previous;
        });
      },
      { rootMargin: '120px' },
    );

    container.querySelectorAll<HTMLElement>('[data-lut-path]').forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [isExpanded, filteredEntries, favorites, recent]);

  const visibleEntries = useMemo(
    () => filteredEntries.filter((entry) => visiblePaths.has(entry.path)),
    [filteredEntries, visiblePaths],
  );

  useEffect(() => {
    if (!isExpanded || !selectedImagePath || !isImageReady || visibleEntries.length === 0) {
      return;
    }

    const imageCache = previewCache.current.get(selectedImagePath);
    const cached: Record<string, string | null> = {};
    const missing: LutEntry[] = [];
    visibleEntries.forEach((entry) => {
      if (imageCache?.has(entry.path)) {
        cached[entry.path] = imageCache.get(entry.path) ?? null;
      } else {
        missing.push(entry);
      }
    });
    if (Object.keys(cached).length > 0) {
      setPreviews((previous) => ({ ...previous, ...cached }));
    }
    if (missing.length === 0) return;

    let isActive = true;
    const timer = window.setTimeout(() => {
      invoke<LutPreview[]>('generate_lut_previews', {
        luts: missing.map((entry) => ({ path: entry.path, isBuiltIn: entry.isBuiltIn })),
        size: PREVIEW_SIZE,
      })
        .then((results) => {
          if (!isActive) return;
          const map = new Map<string, string | null>(imageCache ?? []);
          results.forEach((result) => map.set(result.path, result.thumb));
          previewCache.current.set(selectedImagePath, map);
          if (previewCache.current.size > MAX_PREVIEW_IMAGE_CACHE) {
            const oldest = previewCache.current.keys().next().value;
            if (oldest && oldest !== selectedImagePath) previewCache.current.delete(oldest);
          }
          setPreviews((previous) => {
            const next = { ...previous };
            results.forEach((result) => {
              next[result.path] = result.thumb;
            });
            return next;
          });
        })
        .catch((err) => console.error('Failed to generate LUT previews:', err));
    }, 120);

    return () => {
      isActive = false;
      window.clearTimeout(timer);
    };
  }, [isExpanded, selectedImagePath, isImageReady, visibleEntries]);

  const handleImport = async (targetFolder?: string | null) => {
    try {
      const { osPlatform } = useSettingsStore.getState();
      const isAndroid = osPlatform === 'android';

      const selected = await open({
        multiple: true,
        filters: isAndroid
          ? []
          : [
              {
                name: t('ui.lut.filterLabel'),
                extensions: [...SUPPORTED_EXTENSIONS, ...SUPPORTED_EXTENSIONS.map((ext) => ext.toUpperCase())],
              },
            ],
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
          }),
        );
        const allowedExtensions = new Set(SUPPORTED_EXTENSIONS);
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

      const list = await invoke<LutEntry[]>('import_luts', {
        sourcePaths: validPaths,
        folder: targetFolder ?? null,
      });
      previewCache.current.clear();
      setEntries(list);
      setPreviews({});
      setVisiblePaths(new Set());
    } catch (err) {
      console.error('Failed to import LUTs:', err);
      toast.error(t('ui.lut.importFailed'));
    }
  };

  const handleOpenLutFolder = async () => {
    try {
      await invoke('open_luts_folder');
    } catch (err) {
      console.error('Failed to open LUT folder:', err);
      toast.error(String(err));
    }
  };

  const handleRefresh = async () => {
    previewCache.current.clear();
    setPreviews({});
    setVisiblePaths(new Set());
    await refreshList();
  };

  const handleSwatchClick = (entry: LutEntry) => {
    onLutHover?.(null);
    if (entry.path === lutPath) {
      onClear();
    } else {
      rememberRecent(entry.path);
      onLutSelect(entry.path, entry.isBuiltIn);
    }
  };

  const favoriteLuts = filteredEntries.filter((entry) => favorites.has(entry.path));
  const favoritePaths = new Set(favoriteLuts.map((entry) => entry.path));
  const filteredPaths = new Set(filteredEntries.map((entry) => entry.path));
  const recentLuts = recent
    .map((path) => entries.find((entry) => entry.path === path))
    .filter((entry): entry is LutEntry => entry !== undefined)
    .filter((entry) => filteredPaths.has(entry.path) && !favoritePaths.has(entry.path));
  const pinnedPaths = new Set([...favoriteLuts, ...recentLuts].map((entry) => entry.path));

  const builtInLuts = filteredEntries.filter((entry) => entry.isBuiltIn && !pinnedPaths.has(entry.path));
  const customLuts = filteredEntries.filter((entry) => !entry.isBuiltIn && !pinnedPaths.has(entry.path));
  const customFolders = (() => {
    const groups = new Map<string, LutEntry[]>();
    customLuts.forEach((entry) => {
      const key = entry.folder?.trim() || '';
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    });
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  })();

  const hasCustomLuts = entries.some((entry) => !entry.isBuiltIn);

  const renderSwatch = (entry: LutEntry) => {
    const thumb = previews[entry.path];
    const isSelected = entry.path === lutPath;
    const isFavorite = favorites.has(entry.path);
    return (
      <div key={entry.path} data-lut-path={entry.path} className="relative group">
        <button
          onMouseEnter={() => onLutHover?.(entry.path, entry.isBuiltIn)}
          onMouseLeave={() => onLutHover?.(null)}
          onClick={() => handleSwatchClick(entry)}
          onContextMenu={entry.isBuiltIn ? undefined : (e) => handleContextMenu(e, entry)}
          className={`w-full flex flex-col rounded-md overflow-hidden bg-bg-tertiary border-2 transition-colors text-left ${
            isSelected ? 'border-accent' : 'border-transparent hover:border-surface'
          }`}
          data-tooltip={entry.name}
        >
          <div className="relative aspect-square w-full">
            {thumb === undefined ? (
              <div className="w-full h-full bg-surface" />
            ) : thumb ? (
              <img src={thumb} alt={entry.name} className="w-full h-full object-cover" draggable={false} />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-text-secondary">
                <ImageOff size={18} />
              </div>
            )}
          </div>
          <span className="w-full px-1.5 py-1 text-[10px] leading-3 text-text-secondary truncate">{entry.name}</span>
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            toggleFavorite(entry.path);
          }}
          className={clsx(
            'absolute top-1 right-1 z-10 p-1 rounded-full bg-black/45 hover:bg-black/70 transition-opacity',
            isFavorite ? 'opacity-100' : 'opacity-70 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100',
          )}
          data-tooltip={isFavorite ? t('ui.lut.removeFavorite') : t('ui.lut.addFavorite')}
          aria-label={isFavorite ? t('ui.lut.removeFavorite') : t('ui.lut.addFavorite')}
        >
          <Star size={11} className={isFavorite ? 'fill-amber-400 text-amber-400' : 'text-white/85'} />
        </button>
      </div>
    );
  };

  const renderCustomGroup = (folder: string, groupEntries: LutEntry[], allowImport: boolean) => (
    <div key={folder || '__root'}>
      {(folder || customFolders.length > 1) && (
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] font-medium uppercase tracking-wider text-text-secondary/80">
            {folder || t('ui.lut.uncategorized')}
          </span>
          {allowImport && (
            <button
              onClick={() => handleImport(folder)}
              className="text-[10px] text-text-secondary hover:text-accent flex items-center gap-1 transition-colors"
              data-tooltip={t('ui.lut.importToFolder')}
            >
              <Upload size={10} />
              {t('ui.lut.import')}
            </button>
          )}
        </div>
      )}
      <div className="grid grid-cols-3 gap-2">{groupEntries.map(renderSwatch)}</div>
    </div>
  );

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
        {lutName && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="mt-3">
              <Slider
                label={t('ui.lut.intensity')}
                min={0}
                max={100}
                step={1}
                value={lutIntensity}
                defaultValue={100}
                onChange={(e) => onIntensityChange(Number(e.target.value))}
                onDragStateChange={onDragStateChange}
                fillOrigin="min"
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div
              ref={expandedRef}
              className={`${lutName ? '' : 'mt-3'} pb-1 space-y-4`}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                if (search) {
                  event.stopPropagation();
                  setSearch('');
                } else {
                  setIsExpanded(false);
                }
              }}
            >
              {(entries.length > 4 || search) && (
                <div className="relative">
                  <Search
                    size={14}
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none"
                  />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t('ui.lut.search')}
                    className="w-full bg-bg-tertiary text-text-primary text-xs rounded-md pl-8 pr-7 py-1.5 placeholder:text-text-secondary/70 focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                  {search && (
                    <button
                      onClick={() => setSearch('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary transition-colors"
                      data-tooltip={t('ui.lut.clearSearch')}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              )}

              {search && (
                <div className="px-1 text-[10px] text-text-secondary/80">
                  {t('ui.lut.resultCount', { count: filteredEntries.length })}
                </div>
              )}

              {entries.length > 0 && filteredEntries.length === 0 ? (
                <div className="py-6 text-center text-xs text-text-secondary">{t('ui.lut.noResults')}</div>
              ) : (
                <>
                  {favoriteLuts.length > 0 && (
                    <div>
                      <span className="text-sm font-medium text-text-secondary select-none block mb-2">
                        {t('ui.lut.favorites')}
                      </span>
                      <div className="grid grid-cols-3 gap-2">{favoriteLuts.map(renderSwatch)}</div>
                    </div>
                  )}

                  {recentLuts.length > 0 && (
                    <div>
                      <span className="text-sm font-medium text-text-secondary select-none block mb-2">
                        {t('ui.lut.recent')}
                      </span>
                      <div className="grid grid-cols-3 gap-2">{recentLuts.map(renderSwatch)}</div>
                    </div>
                  )}

                  {builtInLuts.length > 0 && (
                    <div>
                      <span className="text-sm font-medium text-text-secondary select-none block mb-2">
                        {t('ui.lut.filmEmulations')}
                      </span>
                      <div className="grid grid-cols-3 gap-2">{builtInLuts.map(renderSwatch)}</div>
                    </div>
                  )}

                  {!search && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-medium text-text-secondary select-none">
                          {t('ui.lut.customLuts')}
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={handleOpenLutFolder}
                            className="text-text-secondary hover:text-accent transition-colors"
                            data-tooltip={t('ui.lut.openFolder')}
                            aria-label={t('ui.lut.openFolder')}
                          >
                            <FolderOpen size={12} />
                          </button>
                          <button
                            onClick={handleRefresh}
                            className="text-text-secondary hover:text-accent transition-colors"
                            data-tooltip={t('ui.lut.refresh')}
                            aria-label={t('ui.lut.refresh')}
                          >
                            <RefreshCw size={12} />
                          </button>
                          {hasCustomLuts && (
                            <button
                              onClick={() => handleImport()}
                              className="text-xs text-text-secondary hover:text-accent flex items-center gap-1 transition-colors"
                              data-tooltip={t('ui.lut.import')}
                            >
                              <Upload size={12} />
                              {t('ui.lut.import')}
                            </button>
                          )}
                        </div>
                      </div>

                      {!hasCustomLuts ? (
                        <button
                          onClick={() => handleImport()}
                          className="w-full flex items-center justify-center gap-1.5 py-4 rounded-md bg-bg-tertiary hover:bg-surface border-2 border-dashed border-text-secondary/20 hover:border-text-secondary/40 text-sm text-text-primary transition-colors cursor-pointer"
                        >
                          <Upload size={16} />
                          {t('ui.lut.import')}
                        </button>
                      ) : (
                        <div className="space-y-3">
                          {customFolders.map(([folder, folderEntries]) =>
                            renderCustomGroup(folder, folderEntries, true),
                          )}

                          <div className="grid grid-cols-3 gap-2">
                            <button
                              onClick={() => handleImport()}
                              className="flex flex-col items-center justify-center gap-1.5 rounded-md bg-bg-tertiary border-2 border-dashed border-text-secondary/25 hover:border-accent text-text-secondary hover:text-text-primary transition-all duration-150 cursor-pointer aspect-square"
                              data-tooltip={t('ui.lut.import')}
                            >
                              <Upload size={18} />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {search && customLuts.length > 0 && (
                    <div>
                      <span className="text-sm font-medium text-text-secondary select-none block mb-2">
                        {t('ui.lut.customLuts')}
                      </span>
                      <div className="space-y-3">
                        {customFolders.map(([folder, folderEntries]) =>
                          renderCustomGroup(folder, folderEntries, false),
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
