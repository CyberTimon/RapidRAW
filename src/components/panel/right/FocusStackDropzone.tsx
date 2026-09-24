import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { open } from '@tauri-apps/plugin-dialog';
import {
  Layers,
  X,
  Loader2,
  AlertCircle,
  FolderOpen,
  Plus,
  Zap,
} from 'lucide-react';
import { useUIStore } from '../../../store/useUIStore';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { useProductivityActions } from '../../../hooks/useProductivityActions';
import Text from '../../ui/Text';
import { TextVariants, TextWeights } from '../../../types/typography';

export default function FocusStackDropzone() {
  const { t } = useTranslation();
  const focusStackModalState = useUIStore((s) => s.focusStackModalState);
  const setUI = useUIStore((s) => s.setUI);
  const { handleStartFocusStack } = useProductivityActions();

  const multiSelectedPaths = useLibraryStore((s) => s.multiSelectedPaths);
  const libraryActivePath = useLibraryStore((s) => s.libraryActivePath);

  const selectedLibraryPaths = React.useMemo(() => {
    if (multiSelectedPaths && multiSelectedPaths.length > 0) return multiSelectedPaths;
    if (libraryActivePath) return [libraryActivePath];
    return [];
  }, [multiSelectedPaths, libraryActivePath]);

  const [isDragOver, setIsDragOver] = useState(false);
  const [localPaths, setLocalPaths] = useState<string[]>([]);

  const isProcessing = focusStackModalState.isProcessing;
  const progressMessage = focusStackModalState.progressMessage;
  const error = focusStackModalState.error;

  const addPaths = useCallback(
    (newPaths: string[]) => {
      const existingSet = new Set(localPaths);
      const filtered = newPaths.filter((p) => typeof p === 'string' && p.trim().length > 0 && !existingSet.has(p));
      if (filtered.length > 0) {
        setLocalPaths((prev) => [...prev, ...filtered]);
      }
    },
    [localPaths],
  );

  const removePath = useCallback((pathToRemove: string) => {
    setLocalPaths((prev) => prev.filter((p) => p !== pathToRemove));
  }, []);

  const clearAll = useCallback(() => {
    setLocalPaths([]);
  }, []);

  const handleBrowseFiles = async () => {
    try {
      const selected = await open({
        multiple: true,
        filters: [
          {
            name: 'RAW & Image Files',
            extensions: [
              'arw', 'cr2', 'cr3', 'nef', 'dng', 'raf', 'orf', 'rw2', 'pef',
              'jpg', 'jpeg', 'tif', 'tiff', 'png',
            ],
          },
        ],
      });
      if (selected) {
        const paths = Array.isArray(selected) ? selected : [selected];
        addPaths(paths);
      }
    } catch (err) {
      console.error('Failed to open file picker for focus stack:', err);
    }
  };

  const handleAddSelectedFromLibrary = () => {
    if (selectedLibraryPaths.length > 0) {
      addPaths(selectedLibraryPaths);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    try {
      const customData = e.dataTransfer.getData('application/json');
      if (customData) {
        const parsed = JSON.parse(customData);
        if (Array.isArray(parsed)) {
          addPaths(parsed);
          return;
        }
      }
    } catch {
      // Fallback
    }

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const filePaths: string[] = [];
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        const file = e.dataTransfer.files[i];
        if ((file as any).path) {
          filePaths.push((file as any).path);
        }
      }
      if (filePaths.length > 0) {
        addPaths(filePaths);
      }
    }
  };

  const handleProcess = () => {
    if (localPaths.length < 2) return;
    setUI((state) => ({
      focusStackModalState: {
        ...state.focusStackModalState,
        isOpen: true,
        isProcessing: true,
        targetPaths: localPaths,
        error: null,
      },
    }));
    handleStartFocusStack(localPaths);
  };

  return (
    <div className="flex flex-col gap-3 p-3 bg-surface/50 rounded-xl border border-border-color/30">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
            <Layers size={16} />
          </div>
          <div>
            <Text variant={TextVariants.small} weight={TextWeights.semibold}>
              Focus Stacker
            </Text>
            <div className="text-[10px] text-text-secondary">Laplacian Pyramid Depth Fusion</div>
          </div>
        </div>
        {localPaths.length > 0 && (
          <button
            onClick={clearAll}
            disabled={isProcessing}
            className="text-[11px] text-text-secondary hover:text-red-400 transition-colors"
          >
            Clear ({localPaths.length})
          </button>
        )}
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        className={clsx(
          'flex flex-col items-center justify-center p-3 rounded-lg border-2 border-dashed transition-all',
          isDragOver
            ? 'border-indigo-500 bg-indigo-500/10 scale-[1.01]'
            : 'border-border-color/40 bg-card/40 hover:border-indigo-500/40',
        )}
      >
        <div className="flex items-center gap-2 mb-2">
          <button
            type="button"
            onClick={handleBrowseFiles}
            disabled={isProcessing}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface text-xs font-medium text-text-primary hover:bg-card-active border border-border-color/60 transition-colors cursor-pointer"
          >
            <FolderOpen size={13} />
            <span>Browse Files</span>
          </button>
          {selectedLibraryPaths.length > 0 && (
            <button
              type="button"
              onClick={handleAddSelectedFromLibrary}
              disabled={isProcessing}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-indigo-500/20 text-indigo-300 text-xs font-medium hover:bg-indigo-500/30 border border-indigo-500/30 transition-colors cursor-pointer"
            >
              <Plus size={13} />
              <span>Add Selected ({selectedLibraryPaths.length})</span>
            </button>
          )}
        </div>
        <span className="text-[10px] text-text-secondary text-center">
          Drop 2+ depth-bracket frames (RAW/TIFF/JPEG)
        </span>
      </div>

      {localPaths.length > 0 && (
        <div className="flex flex-col gap-1 max-h-28 overflow-y-auto pr-1">
          {localPaths.map((p, idx) => {
            const fileName = p.split(/[\\/]/).pop() || p;
            return (
              <div
                key={p}
                className="flex items-center justify-between px-2 py-1 rounded bg-surface/70 text-xs text-text-primary border border-border-color/20"
              >
                <div className="flex items-center gap-1.5 truncate">
                  <span className="text-[10px] font-mono text-text-secondary">{idx + 1}.</span>
                  <span className="truncate">{fileName}</span>
                </div>
                <button
                  type="button"
                  onClick={() => removePath(p)}
                  disabled={isProcessing}
                  className="text-text-secondary hover:text-red-400 p-0.5"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-1.5 p-2 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
          <AlertCircle size={14} className="shrink-0" />
          <span className="truncate">{error}</span>
        </div>
      )}

      <button
        type="button"
        disabled={localPaths.length < 2 || isProcessing}
        onClick={handleProcess}
        className={clsx(
          'flex items-center justify-center gap-2 w-full py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer shadow-md',
          localPaths.length >= 2 && !isProcessing
            ? 'bg-indigo-600 hover:bg-indigo-500 text-white active:scale-[0.99]'
            : 'bg-surface text-text-secondary opacity-50 cursor-not-allowed border border-border-color/30',
        )}
      >
        {isProcessing ? (
          <>
            <Loader2 size={14} className="animate-spin" />
            <span>{progressMessage || 'Focus Stacking...'}</span>
          </>
        ) : (
          <>
            <Zap size={14} />
            <span>Stack Depth Planes ({localPaths.length} frames)</span>
          </>
        )}
      </button>
    </div>
  );
}
