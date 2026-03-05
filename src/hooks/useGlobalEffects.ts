import { useEffect } from 'react';
import { useAppState } from '../context/ContextProviders';
import { toast } from 'react-toastify';
import {
  FilterCriteria,
  ImageFile,
  Invokes,
  LibraryViewMode,
  Panel,
  RawStatus,
  SelectedImage,
  Theme,
} from '../components/ui/AppProperties';
import { invoke } from '@tauri-apps/api/core';
import { useHandlers } from './useHandlers';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { setTheme } from '@tauri-apps/api/app';
import {
  Adjustments,
  COPYABLE_ADJUSTMENT_KEYS,
  INITIAL_ADJUSTMENTS,
  normalizeLoadedAdjustments,
} from '../utils/adjustments';
import { DEFAULT_THEME_ID, ThemeProps, THEMES } from '../utils/themes';
import { generatePaletteFromImage } from '../utils/palette';
import { DEBUG } from '../utils/constants';
import { ExportState, Status, ImportState, IMPORT_TIMEOUT } from '../components/ui/ExportImportProperties';
import { PanoramaModalState, HdrModalState } from '../App';
import { getParentDir } from '../utils/helpers';

export function useGlobalEffects() {
  const {
    currentFolderPath,
    preloadedDataRef,
    imageList,
    rootPath,
    folderTree,
    currentFolderPathRef,
    isCopied,
    setIsCopied,
    isPasted,
    setIsPasted,
    error,
    setError,
    setAdjustments: setLiveAdjustments,
    history,
    activeRightPanel,
    activeMaskContainerId,
    activeAiPatchContainerId,
    setIsMaskControlHovered,
    setTransformedOriginalUrl,
    geometricAdjustmentsKey,
    selectedImage,
    showOriginal,
    transformedOriginalUrl,
    adjustments,
    setShowOriginal,
    libraryViewMode,
    setIsAIConnectorConnected,
    setIsWindowFullScreen,
    setAppSettings,
    setSortCriteria,
    setFilterCriteria,
    setUiVisibility,
    setLibraryViewMode,
    setThumbnailSize,
    setThumbnailAspectRatio,
    setActiveTreeSection,
    setPinnedFolderTrees,
    isInitialMount,
    appSettings,
    uiVisibility,
    thumbnailSize,
    thumbnailAspectRatio,
    setSupportedTypes,
    sortCriteria,
    filterCriteria,
    finalPreviewUrl,
    setAdaptivePalette,
    theme,
    adaptivePalette,
    isInitialThemeMount,
    setIsAnimatingTheme,
    expandedFolders,
    isFullScreen,
    isHighResNeeded,
    fullResCacheKeyRef,
    visualAdjustmentsKey,
    setIsLoadingFullRes,
    setUncroppedAdjustedPreviewUrl,
    setDenoiseModalState,
    setImportState,
    setExportState,
    setImageList,
    setIndexingProgress,
    setIsIndexing,
    setAiModelDownloadStatus,
    setImageRatings,
    setThumbnails,
    setWaveform,
    setInitialFileToOpen,
    setHistogram,
    exportState,
    importState,
    libraryActivePath,
    setLibraryActiveAdjustments,
    setPanoramaModalState,
    setHdrModalState,
    setCullingModalState,
    dragIdleTimer,
    isSliderDragging,
    setIsLayoutReady,
    initialFileToOpen,
    setRootPath,
    isViewLoading,
    isWaveformVisible,
    waveform,
    setSelectedImage,
    setOriginalSize,
    setPreviewSize,
    setIsViewLoading,
  } = useAppState();

  const { state: historyAdjustments, resetHistory: resetAdjustmentsHistory } = history;

  const {
    refreshImageList,
    generateUncroppedPreview,
    handleSettingsChange,
    requestFullResolution,
    refreshAllFolderTrees,
    handleSelectSubfolder,
    applyAdjustments,
    debouncedSave,
    handleImageSelect,
  } = useHandlers();

  useEffect(() => {
    if (selectedImage && !selectedImage.isReady && selectedImage.path) {
      let isEffectActive = true;

      const loadMetadataEarly = async () => {
        try {
          const metadata: any = await invoke(Invokes.LoadMetadata, { path: selectedImage.path });
          if (!isEffectActive) return;

          let initialAdjusts;
          if (metadata.adjustments && !metadata.adjustments.is_null) {
            initialAdjusts = normalizeLoadedAdjustments(metadata.adjustments);
          } else {
            initialAdjusts = { ...INITIAL_ADJUSTMENTS };
          }

          setLiveAdjustments(initialAdjusts);
          resetAdjustmentsHistory(initialAdjusts);
        } catch (err) {
          console.error('Failed to load metadata early:', err);
        }
      };

      loadMetadataEarly();

      const loadFullImageData = async () => {
        try {
          const loadImageResult: any = await invoke(Invokes.LoadImage, { path: selectedImage.path });
          if (!isEffectActive) {
            return;
          }

          const { width, height } = loadImageResult;
          setOriginalSize({ width, height });

          if (appSettings?.editorPreviewResolution) {
            const maxSize = appSettings.editorPreviewResolution;
            const aspectRatio = width / height;

            if (width > height) {
              const pWidth = Math.min(width, maxSize);
              const pHeight = Math.round(pWidth / aspectRatio);
              setPreviewSize({ width: pWidth, height: pHeight });
            } else {
              const pHeight = Math.min(height, maxSize);
              const pWidth = Math.round(pHeight * aspectRatio);
              setPreviewSize({ width: pWidth, height: pHeight });
            }
          } else {
            setPreviewSize({ width: 0, height: 0 });
          }

          fullResCacheKeyRef.current = null;

          setSelectedImage((currentSelected: SelectedImage | null) => {
            if (currentSelected && currentSelected.path === selectedImage.path) {
              return {
                ...currentSelected,
                exif: loadImageResult.exif,
                height: loadImageResult.height,
                isRaw: loadImageResult.is_raw,
                isReady: true,
                metadata: loadImageResult.metadata,
                originalUrl: null,
                width: loadImageResult.width,
              };
            }
            return currentSelected;
          });

          setLiveAdjustments((prev: Adjustments) => {
            if (!prev.aspectRatio && !prev.crop) {
              return { ...prev, aspectRatio: loadImageResult.width / loadImageResult.height };
            }
            return prev;
          });
        } catch (err) {
          if (isEffectActive) {
            console.error('Failed to load image:', err);
            setError(`Failed to load image: ${err}`);
            setSelectedImage(null);
          }
        } finally {
          if (isEffectActive) {
            setIsViewLoading(false);
          }
        }
      };
      loadFullImageData();
      return () => {
        isEffectActive = false;
      };
    }
  }, [selectedImage?.path, selectedImage?.isReady, resetAdjustmentsHistory, appSettings?.editorPreviewResolution]);

  useEffect(() => {
    const invokeWaveForm = async () => {
      const waveForm: any = await invoke(Invokes.GenerateWaveform).catch((err) =>
        console.error('Failed to generate waveform:', err),
      );
      if (waveForm) {
        setWaveform(waveForm);
      }
    };

    if (isWaveformVisible && selectedImage?.isReady && !waveform) {
      invokeWaveForm();
    }
  }, [isWaveformVisible, selectedImage?.isReady, waveform]);

  useEffect(() => {
    if (!initialFileToOpen || !appSettings) {
      return;
    }
    const parentDir = getParentDir(initialFileToOpen);
    if (currentFolderPath !== parentDir) {
      setRootPath(parentDir);
      handleSelectSubfolder(parentDir, true);
      return;
    }
    const isImageInList = imageList.some((image) => image.path === initialFileToOpen);
    if (isImageInList) {
      handleImageSelect(initialFileToOpen);
      setInitialFileToOpen(null);
    } else if (!isViewLoading) {
      console.warn(`'open-with-file' target ${initialFileToOpen} not found in its directory after loading. Aborting.`);
      setInitialFileToOpen(null);
    }
  }, [
    initialFileToOpen,
    appSettings,
    currentFolderPath,
    imageList,
    isViewLoading,
    handleSelectSubfolder,
    handleImageSelect,
  ]);

  useEffect(() => {
    if (!rootPath) {
      setIsLayoutReady(false);
      return;
    }

    const timer = setTimeout(() => {
      setIsLayoutReady(true);
    }, 100);

    return () => clearTimeout(timer);
  }, [rootPath]);

  useEffect(() => {
    if (!selectedImage?.isReady) return;

    if (dragIdleTimer.current) {
      clearTimeout(dragIdleTimer.current);
    }

    if (isSliderDragging) {
      if (appSettings?.enableLivePreviews !== false) {
        applyAdjustments(adjustments, true);
      }

      dragIdleTimer.current = setTimeout(() => {
        applyAdjustments(adjustments, false);
      }, 150);
    } else {
      applyAdjustments(adjustments, false);
      debouncedSave(selectedImage.path, adjustments);
    }

    return () => {
      if (dragIdleTimer.current) clearTimeout(dragIdleTimer.current);
    };
  }, [
    adjustments,
    selectedImage?.path,
    selectedImage?.isReady,
    isSliderDragging,
    applyAdjustments,
    debouncedSave,
    appSettings?.enableLivePreviews,
  ]);

  useEffect(() => {
    let isEffectActive = true;

    const unlistenStart = listen('culling-start', (event: any) => {
      if (isEffectActive) {
        setCullingModalState({
          isOpen: true,
          progress: { current: 0, total: event.payload, stage: 'Initializing...' },
          suggestions: null,
          error: null,
        });
      }
    });

    const unlistenProgress = listen('culling-progress', (event: any) => {
      if (isEffectActive) {
        setCullingModalState((prev) => ({ ...prev, progress: event.payload }));
      }
    });

    const unlistenComplete = listen('culling-complete', (event: any) => {
      if (isEffectActive) {
        setCullingModalState((prev) => ({ ...prev, progress: null, suggestions: event.payload }));
      }
    });

    const unlistenError = listen('culling-error', (event: any) => {
      if (isEffectActive) {
        setCullingModalState((prev) => ({ ...prev, progress: null, error: String(event.payload) }));
      }
    });

    return () => {
      isEffectActive = false;
      unlistenStart.then((f) => f());
      unlistenProgress.then((f) => f());
      unlistenComplete.then((f) => f());
      unlistenError.then((f) => f());
    };
  }, []);

  useEffect(() => {
    let isEffectActive = true;

    const unlistenProgress = listen('panorama-progress', (event: any) => {
      if (isEffectActive) {
        setPanoramaModalState((prev: PanoramaModalState) => ({
          ...prev,
          error: null,
          finalImageBase64: null,
          isOpen: true,
          progressMessage: event.payload,
        }));
      }
    });

    const unlistenComplete = listen('panorama-complete', (event: any) => {
      if (isEffectActive) {
        const { base64 } = event.payload;
        setPanoramaModalState((prev: PanoramaModalState) => ({
          ...prev,
          error: null,
          finalImageBase64: base64,
          progressMessage: 'Panorama Ready',
        }));
      }
    });

    const unlistenError = listen('panorama-error', (event: any) => {
      if (isEffectActive) {
        setPanoramaModalState((prev: PanoramaModalState) => ({
          ...prev,
          error: String(event.payload),
          finalImageBase64: null,
          progressMessage: 'An error occurred.',
        }));
      }
    });

    return () => {
      isEffectActive = false;
      unlistenProgress.then((f: any) => f());
      unlistenComplete.then((f: any) => f());
      unlistenError.then((f: any) => f());
    };
  }, []);

  useEffect(() => {
    let isEffectActive = true;

    const unlistenProgress = listen('hdr-progress', (event: any) => {
      if (isEffectActive) {
        setHdrModalState((prev: HdrModalState) => ({
          ...prev,
          error: null,
          finalImageBase64: null,
          isOpen: true,
          progressMessage: event.payload,
        }));
      }
    });

    const unlistenComplete = listen('hdr-complete', (event: any) => {
      if (isEffectActive) {
        const { base64 } = event.payload;
        setHdrModalState((prev: HdrModalState) => ({
          ...prev,
          error: null,
          finalImageBase64: base64,
          progressMessage: 'Hdr Ready',
        }));
      }
    });

    const unlistenError = listen('hdr-error', (event: any) => {
      if (isEffectActive) {
        setHdrModalState((prev: HdrModalState) => ({
          ...prev,
          error: String(event.payload),
          finalImageBase64: null,
          progressMessage: 'An error occurred.',
        }));
      }
    });

    return () => {
      isEffectActive = false;
      unlistenProgress.then((f: any) => f());
      unlistenComplete.then((f: any) => f());
      unlistenError.then((f: any) => f());
    };
  }, []);

  useEffect(() => {
    if (libraryActivePath) {
      invoke(Invokes.LoadMetadata, { path: libraryActivePath })
        .then((metadata: any) => {
          if (metadata.adjustments && !metadata.adjustments.is_null) {
            const normalized: Adjustments = normalizeLoadedAdjustments(metadata.adjustments);
            setLibraryActiveAdjustments(normalized);
          } else {
            setLibraryActiveAdjustments(INITIAL_ADJUSTMENTS);
          }
        })
        .catch((err) => {
          console.error('Failed to load metadata for library active image', err);
          setLibraryActiveAdjustments(INITIAL_ADJUSTMENTS);
        });
    } else {
      setLibraryActiveAdjustments(INITIAL_ADJUSTMENTS);
    }
  }, [libraryActivePath]);

  useEffect(() => {
    if ([Status.Success, Status.Error].includes(importState.status)) {
      const timer = setTimeout(() => {
        setImportState({ status: Status.Idle, progress: { current: 0, total: 0 }, path: '', errorMessage: '' });
      }, IMPORT_TIMEOUT);

      return () => clearTimeout(timer);
    }
  }, [importState.status]);

  useEffect(() => {
    if ([Status.Success, Status.Error, Status.Cancelled].includes(exportState.status)) {
      const timeoutDuration = exportState.status === Status.Success ? 5000 : 3000;

      const timer = setTimeout(() => {
        setExportState({ status: Status.Idle, progress: { current: 0, total: 0 }, errorMessage: '' });
      }, timeoutDuration);
      return () => clearTimeout(timer);
    }
  }, [exportState.status]);

  useEffect(() => {
    let isEffectActive = true;
    const listeners = [
      listen('preview-update-uncropped', (event: any) => {
        if (isEffectActive) {
          setUncroppedAdjustedPreviewUrl(event.payload);
        }
      }),
      listen('histogram-update', (event: any) => {
        if (isEffectActive) {
          setHistogram(event.payload);
        }
      }),
      listen('open-with-file', (event: any) => {
        if (isEffectActive) {
          setInitialFileToOpen(event.payload as string);
        }
      }),
      listen('waveform-update', (event: any) => {
        if (isEffectActive) {
          setWaveform(event.payload);
        }
      }),
      listen('thumbnail-generated', (event: any) => {
        if (isEffectActive) {
          const { path, data, rating } = event.payload;
          if (data) {
            setThumbnails((prev) => ({ ...prev, [path]: data }));
          }
          if (rating !== undefined) {
            setImageRatings((prev) => ({ ...prev, [path]: rating }));
          }
        }
      }),
      listen('ai-model-download-start', (event: any) => {
        if (isEffectActive) {
          setAiModelDownloadStatus(event.payload);
        }
      }),
      listen('ai-model-download-finish', () => {
        if (isEffectActive) {
          setAiModelDownloadStatus(null);
        }
      }),
      listen('indexing-started', () => {
        if (isEffectActive) {
          setIsIndexing(true);
          setIndexingProgress({ current: 0, total: 0 });
        }
      }),
      listen('indexing-progress', (event: any) => {
        if (isEffectActive) {
          setIndexingProgress(event.payload);
        }
      }),
      listen('indexing-finished', () => {
        if (isEffectActive) {
          setIsIndexing(false);
          setIndexingProgress({ current: 0, total: 0 });
          if (currentFolderPathRef.current) {
            const refreshImageList = async () => {
              try {
                const list: ImageFile[] = await invoke(Invokes.ListImagesInDir, { path: currentFolderPathRef.current });
                if (Array.isArray(list)) {
                  setImageList(list);
                }
              } catch (err) {
                console.error('Failed to refresh after indexing:', err);
              }
            };
            refreshImageList();
          }
        }
      }),
      listen('batch-export-progress', (event: any) => {
        if (isEffectActive) {
          setExportState((prev: ExportState) => ({ ...prev, progress: event.payload }));
        }
      }),
      listen('export-complete', () => {
        if (isEffectActive) {
          setExportState((prev: ExportState) => ({ ...prev, status: Status.Success }));
        }
      }),
      listen('export-error', (event) => {
        if (isEffectActive) {
          setExportState((prev: ExportState) => ({
            ...prev,
            status: Status.Error,
            errorMessage: typeof event.payload === 'string' ? event.payload : 'An unknown export error occurred.',
          }));
        }
      }),
      listen('export-cancelled', () => {
        if (isEffectActive) {
          setExportState((prev: ExportState) => ({ ...prev, status: Status.Cancelled }));
        }
      }),
      listen('import-start', (event: any) => {
        if (isEffectActive) {
          setImportState({
            errorMessage: '',
            path: '',
            progress: { current: 0, total: event.payload.total },
            status: Status.Importing,
          });
        }
      }),
      listen('import-progress', (event: any) => {
        if (isEffectActive) {
          setImportState((prev: ImportState) => ({
            ...prev,
            path: event.payload.path,
            progress: { current: event.payload.current, total: event.payload.total },
          }));
        }
      }),
      listen('import-complete', () => {
        if (isEffectActive) {
          setImportState((prev: ImportState) => ({ ...prev, status: Status.Success }));
          refreshAllFolderTrees();
          if (currentFolderPathRef.current) {
            handleSelectSubfolder(currentFolderPathRef.current, false);
          }
        }
      }),
      listen('import-error', (event) => {
        if (isEffectActive) {
          setImportState((prev: ImportState) => ({
            ...prev,
            errorMessage: typeof event.payload === 'string' ? event.payload : 'An unknown import error occurred.',
            status: Status.Error,
          }));
        }
      }),
      listen('denoise-progress', (event: any) => {
        if (isEffectActive) {
          setDenoiseModalState((prev) => ({ ...prev, progressMessage: event.payload as string }));
        }
      }),
      listen('denoise-complete', (event: any) => {
        if (isEffectActive) {
          const payload = event.payload;
          const isObject = typeof payload === 'object' && payload !== null;

          setDenoiseModalState((prev) => ({
            ...prev,
            isProcessing: false,
            previewBase64: isObject ? payload.denoised : payload,
            originalBase64: isObject ? payload.original : null,
            progressMessage: null,
          }));
        }
      }),
      listen('denoise-error', (event: any) => {
        if (isEffectActive) {
          setDenoiseModalState((prev) => ({
            ...prev,
            isProcessing: false,
            error: String(event.payload),
            progressMessage: null,
          }));
        }
      }),
    ];
    return () => {
      isEffectActive = false;
      listeners.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, [refreshAllFolderTrees, handleSelectSubfolder]);

  useEffect(() => {
    if ((isFullScreen || isHighResNeeded) && selectedImage?.isReady) {
      if (fullResCacheKeyRef.current !== visualAdjustmentsKey) {
        setIsLoadingFullRes(true);
        requestFullResolution(adjustments, visualAdjustmentsKey);
      }
    } else if (!isFullScreen && !isHighResNeeded) {
      if (requestFullResolution.cancel) {
        requestFullResolution.cancel();
      }
      setIsLoadingFullRes(false);
    }
  }, [adjustments, isFullScreen, isHighResNeeded, selectedImage?.isReady, requestFullResolution, visualAdjustmentsKey]);

  useEffect(() => {
    const handleGlobalContextMenu = (event: any) => {
      if (!DEBUG) event.preventDefault();
    };
    window.addEventListener('contextmenu', handleGlobalContextMenu);
    return () => window.removeEventListener('contextmenu', handleGlobalContextMenu);
  }, []);

  useEffect(() => {
    if (isInitialMount.current || !appSettings || !rootPath) {
      return;
    }

    const newFolderState = {
      currentFolderPath,
      expandedFolders: Array.from(expandedFolders),
    };

    if (JSON.stringify(appSettings.lastFolderState) === JSON.stringify(newFolderState)) {
      return;
    }

    handleSettingsChange({ ...appSettings, lastFolderState: newFolderState });
  }, [currentFolderPath, expandedFolders, rootPath, appSettings, handleSettingsChange]);

  useEffect(() => {
    if (isInitialThemeMount.current) {
      isInitialThemeMount.current = false;
      return;
    }

    setIsAnimatingTheme(true);
    const timer = setTimeout(() => setIsAnimatingTheme(false), 500);

    return () => clearTimeout(timer);
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement;
    const currentThemeId = theme || DEFAULT_THEME_ID;

    const baseTheme =
      THEMES.find((t: ThemeProps) => t.id === currentThemeId) ||
      THEMES.find((t: ThemeProps) => t.id === DEFAULT_THEME_ID);
    if (!baseTheme) {
      return;
    }

    let finalCssVariables: any = { ...baseTheme.cssVariables };
    const effectThemeForWindow = baseTheme.id;

    if (adaptivePalette) {
      finalCssVariables = { ...finalCssVariables, ...adaptivePalette };
    }

    Object.entries(finalCssVariables).forEach(([key, value]) => {
      root.style.setProperty(key, value as string);
    });

    const isLight = [Theme.Light, Theme.Snow, Theme.Arctic].includes(effectThemeForWindow);
    invoke(Invokes.UpdateWindowEffect, { theme: isLight ? Theme.Light : Theme.Dark });
  }, [theme, adaptivePalette]);

  useEffect(() => {
    if (appSettings?.adaptiveEditorTheme && selectedImage && finalPreviewUrl) {
      generatePaletteFromImage(finalPreviewUrl)
        .then(setAdaptivePalette)
        .catch((_err) => {
          const darkTheme = THEMES.find((t) => t.id === Theme.Dark);
          setAdaptivePalette(darkTheme ? darkTheme.cssVariables : null);
        });
    } else if (!appSettings?.adaptiveEditorTheme || !selectedImage) {
      setAdaptivePalette(null);
    }
  }, [appSettings?.adaptiveEditorTheme, selectedImage, finalPreviewUrl]);

  useEffect(() => {
    if (isInitialMount.current || !appSettings) {
      return;
    }
    if (JSON.stringify(appSettings.filterCriteria) !== JSON.stringify(filterCriteria)) {
      handleSettingsChange({ ...appSettings, filterCriteria });
    }
  }, [filterCriteria, appSettings, handleSettingsChange]);

  useEffect(() => {
    if (isInitialMount.current || !appSettings) {
      return;
    }
    if (JSON.stringify(appSettings.sortCriteria) !== JSON.stringify(sortCriteria)) {
      handleSettingsChange({ ...appSettings, sortCriteria });
    }
  }, [sortCriteria, appSettings, handleSettingsChange]);

  useEffect(() => {
    invoke(Invokes.GetSupportedFileTypes)
      .then((types: any) => setSupportedTypes(types))
      .catch((err) => console.error('Failed to load supported file types:', err));
  }, []);

  useEffect(() => {
    if (isInitialMount.current || !appSettings) {
      return;
    }
    if (appSettings.libraryViewMode !== libraryViewMode) {
      handleSettingsChange({ ...appSettings, libraryViewMode });
    }
  }, [libraryViewMode, appSettings, handleSettingsChange]);

  useEffect(() => {
    if (isInitialMount.current || !appSettings) {
      return;
    }
    if (appSettings.thumbnailAspectRatio !== thumbnailAspectRatio) {
      handleSettingsChange({ ...appSettings, thumbnailAspectRatio });
    }
  }, [thumbnailAspectRatio, appSettings, handleSettingsChange]);

  useEffect(() => {
    if (isInitialMount.current || !appSettings) {
      return;
    }
    if (appSettings.thumbnailSize !== thumbnailSize) {
      handleSettingsChange({ ...appSettings, thumbnailSize });
    }
  }, [thumbnailSize, appSettings, handleSettingsChange]);

  useEffect(() => {
    if (isInitialMount.current || !appSettings) {
      return;
    }
    if (JSON.stringify(appSettings.uiVisibility) !== JSON.stringify(uiVisibility)) {
      handleSettingsChange({ ...appSettings, uiVisibility });
    }
  }, [uiVisibility, appSettings, handleSettingsChange]);

  useEffect(() => {
    invoke(Invokes.LoadSettings)
      .then(async (settings: any) => {
        if (
          !settings.copyPasteSettings ||
          !settings.copyPasteSettings.includedAdjustments ||
          settings.copyPasteSettings.includedAdjustments.length === 0
        ) {
          settings.copyPasteSettings = {
            mode: 'merge',
            includedAdjustments: COPYABLE_ADJUSTMENT_KEYS,
          };
        }
        setAppSettings(settings);
        if (settings?.sortCriteria) setSortCriteria(settings.sortCriteria);
        if (settings?.filterCriteria) {
          setFilterCriteria((prev: FilterCriteria) => ({
            ...prev,
            ...settings.filterCriteria,
            rawStatus: settings.filterCriteria.rawStatus || RawStatus.All,
            colors: settings.filterCriteria.colors || [],
          }));
        }
        if (settings?.theme) {
          setTheme(settings.theme);
        }
        if (settings?.uiVisibility) {
          setUiVisibility((prev) => ({ ...prev, ...settings.uiVisibility }));
        }
        if (settings?.libraryViewMode) {
          setLibraryViewMode(settings.libraryViewMode);
        }
        if (settings?.thumbnailSize) {
          setThumbnailSize(settings.thumbnailSize);
        }
        if (settings?.thumbnailAspectRatio) {
          setThumbnailAspectRatio(settings.thumbnailAspectRatio);
        }
        if (settings?.activeTreeSection) {
          setActiveTreeSection(settings.activeTreeSection);
        }
        if (settings?.pinnedFolders && settings.pinnedFolders.length > 0) {
          try {
            const trees = await invoke(Invokes.GetPinnedFolderTrees, { paths: settings.pinnedFolders });
            setPinnedFolderTrees(trees);
          } catch (err) {
            console.error('Failed to load pinned folder trees:', err);
          }
        }

        if (settings.lastRootPath) {
          const root = settings.lastRootPath;
          const currentPath = settings.lastFolderState?.currentFolderPath || root;

          const command =
            settings.libraryViewMode === LibraryViewMode.Recursive
              ? Invokes.ListImagesRecursive
              : Invokes.ListImagesInDir;

          preloadedDataRef.current = {
            rootPath: root,
            currentPath: currentPath,
            tree: invoke(Invokes.GetFolderTree, { path: root }),
            images: invoke(command, { path: currentPath }),
          };
        }

        invoke('frontend_ready').catch((e) => console.error('Failed to notify backend of readiness:', e));
      })
      .catch((err) => {
        console.error('Failed to load settings:', err);
        setAppSettings({ lastRootPath: null, theme: DEFAULT_THEME_ID });
      })
      .finally(() => {
        isInitialMount.current = false;
      });
  }, []);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    const checkFullscreen = async () => {
      setIsWindowFullScreen(await appWindow.isFullscreen());
    };
    checkFullscreen();

    const unlistenPromise = appWindow.onResized(checkFullscreen);

    return () => {
      unlistenPromise.then((unlisten: any) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (activeRightPanel === Panel.Crop && selectedImage?.isReady) {
      generateUncroppedPreview(adjustments);
    }
  }, [adjustments, activeRightPanel, selectedImage?.isReady, generateUncroppedPreview]);

  useEffect(() => {
    const unlisten = listen('ai-connector-status-update', (event: any) => {
      setIsAIConnectorConnected(event.payload.connected);
    });
    invoke(Invokes.CheckAIConnectorStatus);
    const interval = setInterval(() => invoke(Invokes.CheckAIConnectorStatus), 10000);
    return () => {
      clearInterval(interval);
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (currentFolderPath) {
      refreshImageList();
    }
  }, [libraryViewMode]);

  useEffect(() => {
    if (currentFolderPath) {
      preloadedDataRef.current = {
        ...preloadedDataRef.current,
        currentPath: currentFolderPath,
        images: Promise.resolve(imageList),
      };
    }
  }, [currentFolderPath, imageList]);

  useEffect(() => {
    if (rootPath && folderTree) {
      preloadedDataRef.current = {
        ...preloadedDataRef.current,
        rootPath: rootPath,
        tree: Promise.resolve(folderTree),
      };
    }
  }, [rootPath, folderTree]);

  useEffect(() => {
    currentFolderPathRef.current = currentFolderPath;
  }, [currentFolderPath]);

  useEffect(() => {
    if (!isCopied) {
      return;
    }
    const timer = setTimeout(() => setIsCopied(false), 1000);
    return () => clearTimeout(timer);
  }, [isCopied]);

  useEffect(() => {
    if (!isPasted) {
      return;
    }
    const timer = setTimeout(() => setIsPasted(false), 1000);
    return () => clearTimeout(timer);
  }, [isPasted]);

  useEffect(() => {
    if (error) {
      toast.error(error);
      setError(null);
    }
  }, [error]);

  useEffect(() => {
    setLiveAdjustments(historyAdjustments);
  }, [historyAdjustments]);

  useEffect(() => {
    if (
      (activeRightPanel !== Panel.Masks || !activeMaskContainerId) &&
      (activeRightPanel !== Panel.Ai || !activeAiPatchContainerId)
    ) {
      setIsMaskControlHovered(false);
    }
  }, [activeRightPanel, activeMaskContainerId, activeAiPatchContainerId]);

  useEffect(() => {
    setTransformedOriginalUrl(null);
  }, [geometricAdjustmentsKey, selectedImage?.path]);

  useEffect(() => {
    let isEffectActive = true;

    const generate = async () => {
      if (showOriginal && selectedImage?.path && !transformedOriginalUrl) {
        try {
          const base64Data: string = await invoke('generate_original_transformed_preview', {
            jsAdjustments: adjustments,
          });
          if (isEffectActive) {
            setTransformedOriginalUrl(base64Data);
          }
        } catch (e) {
          if (isEffectActive) {
            console.error('Failed to generate original preview:', e);
            setError('Failed to show original image.');
            setShowOriginal(false);
          }
        }
      }
    };

    generate();

    return () => {
      isEffectActive = false;
    };
  }, [showOriginal, selectedImage?.path, adjustments, transformedOriginalUrl]);
}
