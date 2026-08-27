import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { open } from '@tauri-apps/plugin-dialog';
import {
  Sparkles,
  X,
  Loader2,
  AlertCircle,
  ShieldCheck,
  Moon,
  FolderOpen,
  Plus,
} from 'lucide-react';
import { useUIStore } from '../../../store/useUIStore';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { useProductivityActions } from '../../../hooks/useProductivityActions';
import Text from '../../ui/Text';
import { TextVariants, TextWeights } from '../../../types/typography';

export default function NightSkyDropzone() {
  const { t } = useTranslation();
  const nightSkyState = useUIStore((s) => s.nightSkyState);
  const setUI = useUIStore((s) => s.setUI);
  const { handleProcessNightSkySession } = useProductivityActions();

  const multiSelectedPaths = useLibraryStore((s) => s.multiSelectedPaths);
  const libraryActivePath = useLibraryStore((s) => s.libraryActivePath);

  const selectedLibraryPaths = React.useMemo(() => {
    if (multiSelectedPaths && multiSelectedPaths.length > 0) return multiSelectedPaths;
    if (libraryActivePath) return [libraryActivePath];
    return [];
  }, [multiSelectedPaths, libraryActivePath]);

  const [isDragOver, setIsDragOver] = useState(false);

  const targetPaths = nightSkyState.targetPaths;
  const isProcessing = nightSkyState.isProcessing;
  const progressMessage = nightSkyState.progressMessage;
  const error = nightSkyState.error;

  const addPaths = useCallback(
    (newPaths: string[]) => {
      const existingSet = new Set(targetPaths);
      const filtered = newPaths.filter((p) => typeof p === 'string' && p.trim().length > 0 && !existingSet.has(p));
      if (filtered.length > 0) {
        setUI((state) => ({
          nightSkyState: {
            ...state.nightSkyState,
            targetPaths: [...state.nightSkyState.targetPaths, ...filtered],
            error: null,
          },
        }));
      }
    },
    [targetPaths, setUI],
  );

  const removePath = useCallback(
    (pathToRemove: string) => {
      setUI((state) => ({
        nightSkyState: {
          ...state.nightSkyState,
          targetPaths: state.nightSkyState.targetPaths.filter((p) => p !== pathToRemove),
        },
      }));
    },
    [setUI],
  );

  const clearAll = useCallback(() => {
    setUI((state) => ({
      nightSkyState: {
        ...state.nightSkyState,
        targetPaths: [],
        error: null,
        progressMessage: null,
      },
    }));
  }, [setUI]);

  const handleBrowseFiles = async () => {
    try {
      const selected = await open({
        multiple: true,
        filters: [
          {
            name: 'RAW & Image Files',
            extensions: [
              'arw',
              'cr2',
              'cr3',
              'nef',
              'dng',
              'raf',
              'orf',
              'rw2',
              'pef',
              'jpg',
              'jpeg',
              'png',
              'tiff',
              'tif',
            ],
          },
        ],
      });

      if (selected) {
        const paths = Array.isArray(selected) ? selected : [selected];
        addPaths(paths);
      }
    } catch (err) {
      console.error('Failed to open file dialog:', err);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (!isDragOver) setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    // 1. Try internal JSON payloads from library drag
    for (const key of ['application/x-rapidraw-images', 'application/json', 'text/plain']) {
      const data = e.dataTransfer.getData(key);
      if (data) {
        try {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed) && parsed.length > 0) {
            addPaths(parsed);
            return;
          }
        } catch {
          if (data.includes('\\') || data.includes('/')) {
            addPaths([data]);
            return;
          }
        }
      }
    }

    // 2. Try native OS files dropped from Windows Explorer
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const droppedPaths: string[] = [];
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        const file = e.dataTransfer.files[i] as any;
        const filePath = file.path || file.name;
        if (filePath) droppedPaths.push(filePath);
      }
      if (droppedPaths.length > 0) {
        addPaths(droppedPaths);
        return;
      }
    }

    // 3. Fallback to active library selection
    const multi = useLibraryStore.getState().multiSelectedPaths;
    if (multi && multi.length > 0) {
      addPaths(multi);
    }
  };

  const handleProcess = () => {
    if (targetPaths.length < 2) return;
    handleProcessNightSkySession(targetPaths, {
      freezeGround: nightSkyState.freezeGround,
      removeLightPollution: nightSkyState.removeLightPollution,
      sigmaClip: nightSkyState.sigmaClip,
    });
  };

  return (
    <div className="flex flex-col gap-2 p-2 bg-surface/40 rounded-lg border border-surface text-sm my-1">
      {/* Dropzone container */}
      <div
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={clsx(
          'relative flex flex-col items-center justify-center p-3 rounded-lg border-2 border-dashed transition-all duration-200 cursor-pointer text-center',
          isDragOver
            ? 'border-accent bg-accent/15 scale-[0.99]'
            : 'border-accent/40 bg-bg-secondary/70 hover:border-accent/70 hover:bg-bg-secondary',
        )}
        onClick={handleBrowseFiles}
      >
        <div className="p-2 rounded-full bg-accent/15 text-accent mb-1.5 pointer-events-none">
          <Moon size={20} className="animate-pulse" />
        </div>

        <Text variant={TextVariants.small} weight={TextWeights.semibold} className="text-text-primary pointer-events-none">
          {t('astro.dropzone.title', 'Drop Night RAWs Here')}
        </Text>
        <Text variant={TextVariants.small} className="text-text-secondary text-[11px] mt-0.5 pointer-events-none">
          {t('astro.dropzone.subtitle', 'From Library or Windows Explorer')}
        </Text>

        <div className="flex items-center gap-2 mt-2">
          <button
            type="button"
            className="flex items-center gap-1 text-[11px] font-medium text-accent hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              handleBrowseFiles();
            }}
          >
            <FolderOpen size={13} />
            <span>{t('astro.dropzone.browse', 'Browse files...')}</span>
          </button>
        </div>
      </div>

      {/* 1-Click Button to Add Selected Library Photos */}
      {selectedLibraryPaths.length > 0 && (
        <button
          type="button"
          onClick={() => addPaths(selectedLibraryPaths)}
          disabled={isProcessing}
          className="flex items-center justify-center gap-1.5 py-1.5 px-2.5 rounded bg-accent/15 hover:bg-accent/25 text-accent text-xs font-medium transition-colors border border-accent/30"
        >
          <Plus size={13} />
          <span>Add Selected Library Photos ({selectedLibraryPaths.length})</span>
        </button>
      )}

      {/* Target Files List */}
      {targetPaths.length > 0 && (
        <div className="flex flex-col gap-1.5 bg-bg-primary/50 p-2 rounded-md border border-surface/60">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-text-primary flex items-center gap-1">
              <Sparkles size={12} className="text-accent" />
              <span>
                {targetPaths.length} {t('astro.framesSelected', 'frames queued')}
              </span>
            </span>
            <button
              onClick={clearAll}
              disabled={isProcessing}
              className="text-[10px] text-text-secondary hover:text-red-400 transition-colors disabled:opacity-40"
            >
              {t('astro.clearAll', 'Clear all')}
            </button>
          </div>

          <div className="max-h-28 overflow-y-auto flex flex-col gap-1 pr-1 custom-scrollbar">
            {targetPaths.map((p) => {
              const fileName = p.split(/[\\/]/).pop() || p;
              return (
                <div
                  key={p}
                  className="flex items-center justify-between bg-surface/60 hover:bg-surface px-2 py-1 rounded text-[11px] group"
                >
                  <span className="truncate flex-1 text-text-primary pr-2" title={p}>
                    {fileName}
                  </span>
                  {!isProcessing && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removePath(p);
                      }}
                      className="text-text-secondary hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Smart Auto Options */}
      <div className="flex flex-col gap-1 pt-1">
        <label className="flex items-center gap-2 cursor-pointer select-none text-[12px] text-text-primary">
          <input
            type="checkbox"
            checked={nightSkyState.freezeGround}
            disabled={isProcessing}
            onChange={(e) =>
              setUI((s) => ({
                nightSkyState: { ...s.nightSkyState, freezeGround: e.target.checked },
              }))
            }
            className="rounded border-surface text-accent focus:ring-accent accent-accent h-3.5 w-3.5"
          />
          <span className="flex items-center gap-1">
            <ShieldCheck size={13} className="text-accent" />
            <span>{t('astro.options.freezeGround', 'Freeze Landscape Ground')}</span>
          </span>
        </label>

        <label className="flex items-center gap-2 cursor-pointer select-none text-[12px] text-text-primary">
          <input
            type="checkbox"
            checked={nightSkyState.removeLightPollution}
            disabled={isProcessing}
            onChange={(e) =>
              setUI((s) => ({
                nightSkyState: { ...s.nightSkyState, removeLightPollution: e.target.checked },
              }))
            }
            className="rounded border-surface text-accent focus:ring-accent accent-accent h-3.5 w-3.5"
          />
          <span>{t('astro.options.removeLightPollution', 'Remove Light-Pollution Glow')}</span>
        </label>
      </div>

      {/* Error display */}
      {error && (
        <div className="flex items-start gap-1.5 p-2 bg-red-950/40 border border-red-800/60 rounded text-[11px] text-red-300">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Progress status */}
      {isProcessing && (
        <div className="flex flex-col gap-1.5 p-2 bg-accent/10 border border-accent/30 rounded">
          <div className="flex items-center gap-2 text-accent text-[12px] font-medium">
            <Loader2 size={14} className="animate-spin" />
            <span className="truncate">{progressMessage || t('astro.processing', 'Processing night session...')}</span>
          </div>
          <div className="w-full bg-surface/80 rounded-full h-1.5 overflow-hidden">
            <div className="bg-accent h-full w-full animate-pulse" />
          </div>
        </div>
      )}

      {/* Action Button */}
      <button
        onClick={handleProcess}
        disabled={targetPaths.length < 2 || isProcessing}
        className={clsx(
          'w-full flex items-center justify-center gap-2 py-2 px-3 rounded-md font-medium text-xs shadow-sm transition-all duration-200 select-none mt-1',
          targetPaths.length >= 2 && !isProcessing
            ? 'bg-accent text-white hover:brightness-110 active:scale-[0.98]'
            : 'bg-surface text-text-secondary opacity-50 cursor-not-allowed',
        )}
      >
        {isProcessing ? (
          <>
            <Loader2 size={14} className="animate-spin" />
            <span>{t('astro.stacking', 'Stacking & Blending...')}</span>
          </>
        ) : (
          <>
            <Sparkles size={14} />
            <span>{t('astro.autoProcessBtn', 'Auto Process Milky Way ✨')}</span>
          </>
        )}
      </button>

      {targetPaths.length === 1 && (
        <span className="text-[10px] text-text-secondary text-center">
          {t('astro.needMoreFrames', 'Add at least 1 more frame to stack (2+ required)')}
        </span>
      )}
    </div>
  );
}
