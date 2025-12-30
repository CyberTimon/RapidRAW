import { Cubit } from '@blac/core';
import debounce from 'lodash.debounce';
import { invoke } from '@tauri-apps/api/core';
import { Invokes, SelectedImage, Panel } from '../components/ui/AppProperties';
import { Adjustments, INITIAL_ADJUSTMENTS } from '../utils/adjustments';
import { ImageDimensions } from '../hooks/useImageRenderSize';

export interface EditorState {
  selectedImage: SelectedImage | null;
  adjustments: Adjustments;
  history: Adjustments[];
  historyIndex: number;
  zoom: number;
  pan: { x: number; y: number };
  initialFitScale: number | null;
  displaySize: ImageDimensions;
  previewSize: ImageDimensions;
  baseRenderSize: ImageDimensions;
  originalSize: ImageDimensions;
  showOriginal: boolean;
  isFullScreen: boolean;
  isFullScreenLoading: boolean;
  isAdjusting: boolean;
  isLoadingFullRes: boolean;
  isFullResolution: boolean;
  copiedAdjustments: Adjustments | null;
  activeRightPanel: Panel | null;
  renderedRightPanel: Panel | null;
  isStraightenActive: boolean;
  isWbPickerActive: boolean;
  finalPreviewUrl: string | null;
  uncroppedAdjustedPreviewUrl: string | null;
  fullScreenUrl: string | null;
  fullResolutionUrl: string | null;
  transformedOriginalUrl: string | null;
  error: string | null;
}

const defaultState: EditorState = {
  selectedImage: null,
  adjustments: INITIAL_ADJUSTMENTS,
  history: [INITIAL_ADJUSTMENTS],
  historyIndex: 0,
  zoom: 1,
  pan: { x: 0, y: 0 },
  initialFitScale: null,
  displaySize: { width: 0, height: 0 },
  previewSize: { width: 0, height: 0 },
  baseRenderSize: { width: 0, height: 0 },
  originalSize: { width: 0, height: 0 },
  showOriginal: false,
  isFullScreen: false,
  isFullScreenLoading: false,
  isAdjusting: false,
  isLoadingFullRes: false,
  isFullResolution: false,
  copiedAdjustments: null,
  activeRightPanel: Panel.Adjustments,
  renderedRightPanel: Panel.Adjustments,
  isStraightenActive: false,
  isWbPickerActive: false,
  finalPreviewUrl: null,
  uncroppedAdjustedPreviewUrl: null,
  fullScreenUrl: null,
  fullResolutionUrl: null,
  transformedOriginalUrl: null,
  error: null,
};

export class EditorCubit extends Cubit<EditorState> {
  private debouncedSaveMetadata: ReturnType<typeof debounce>;

  constructor() {
    super(defaultState);

    this.debouncedSaveMetadata = debounce(this.saveMetadata, 500);
  }

  // Computed getters
  get canUndo(): boolean {
    return this.state.historyIndex > 0;
  }

  get canRedo(): boolean {
    return this.state.historyIndex < this.state.history.length - 1;
  }

  get currentAdjustments(): Adjustments {
    return this.state.history[this.state.historyIndex];
  }

  get hasSelectedImage(): boolean {
    return this.state.selectedImage !== null;
  }

  get isImageReady(): boolean {
    return this.state.selectedImage?.isReady ?? false;
  }

  // Selected image management
  setSelectedImage = (image: SelectedImage | null) => {
    if (image) {
      this.emit({
        ...defaultState,
        selectedImage: image,
        adjustments: INITIAL_ADJUSTMENTS,
        history: [INITIAL_ADJUSTMENTS],
        historyIndex: 0,
        activeRightPanel: this.state.activeRightPanel,
        renderedRightPanel: this.state.renderedRightPanel,
      });
    } else {
      this.patch({ selectedImage: null });
    }
  };

  updateSelectedImage = (updates: Partial<SelectedImage>) => {
    if (!this.state.selectedImage) return;
    this.update((state) => ({
      ...state,
      selectedImage: { ...state.selectedImage!, ...updates },
    }));
  };

  // Adjustments management with history
  setAdjustments = (updates: Partial<Adjustments> | ((prev: Adjustments) => Adjustments)) => {
    this.update((state) => {
      const currentAdj = state.adjustments;
      const newAdjustments = typeof updates === 'function'
        ? updates(currentAdj)
        : { ...currentAdj, ...updates };

      // Check if actually changed
      if (JSON.stringify(newAdjustments) === JSON.stringify(currentAdj)) {
        return state;
      }

      // Trim history and add new state
      const newHistory = state.history.slice(0, state.historyIndex + 1);
      newHistory.push(newAdjustments);

      return {
        ...state,
        adjustments: newAdjustments,
        history: newHistory,
        historyIndex: newHistory.length - 1,
      };
    });

    this.debouncedSaveMetadata();
  };

  // Set adjustments without adding to history (for initial load)
  setAdjustmentsWithoutHistory = (adjustments: Adjustments) => {
    this.patch({
      adjustments,
      history: [adjustments],
      historyIndex: 0,
    });
  };

  undo = () => {
    if (!this.canUndo) return;
    this.update((state) => {
      const newIndex = state.historyIndex - 1;
      return {
        ...state,
        historyIndex: newIndex,
        adjustments: state.history[newIndex],
      };
    });
    this.debouncedSaveMetadata();
  };

  redo = () => {
    if (!this.canRedo) return;
    this.update((state) => {
      const newIndex = state.historyIndex + 1;
      return {
        ...state,
        historyIndex: newIndex,
        adjustments: state.history[newIndex],
      };
    });
    this.debouncedSaveMetadata();
  };

  resetHistory = (adjustments: Adjustments = INITIAL_ADJUSTMENTS) => {
    this.patch({
      adjustments,
      history: [adjustments],
      historyIndex: 0,
    });
  };

  private saveMetadata = async () => {
    if (!this.state.selectedImage?.path) return;

    try {
      await invoke(Invokes.SaveMetadataAndUpdateThumbnail, {
        path: this.state.selectedImage.path,
        adjustments: this.state.adjustments,
        rating: this.state.adjustments.rating,
        tags: null,
      });
    } catch (error) {
      console.error('Failed to save metadata:', error);
    }
  };

  // Zoom and pan
  setZoom = (zoom: number) => {
    this.patch({ zoom: Math.max(0.1, Math.min(32, zoom)) });
  };

  setPan = (pan: { x: number; y: number }) => {
    this.patch({ pan });
  };

  resetZoom = () => {
    this.patch({ zoom: 1, pan: { x: 0, y: 0 } });
  };

  zoomIn = () => {
    this.setZoom(this.state.zoom * 1.25);
  };

  zoomOut = () => {
    this.setZoom(this.state.zoom / 1.25);
  };

  fitToScreen = () => {
    if (this.state.initialFitScale) {
      this.patch({ zoom: this.state.initialFitScale, pan: { x: 0, y: 0 } });
    }
  };

  setInitialFitScale = (scale: number) => {
    this.patch({ initialFitScale: scale });
  };

  // Display sizes
  setDisplaySize = (size: ImageDimensions & { scale?: number }) => {
    this.update((state) => {
      const updates: Partial<EditorState> = {
        displaySize: { width: size.width, height: size.height },
      };

      if (size.scale) {
        updates.baseRenderSize = {
          width: size.width / size.scale,
          height: size.height / size.scale,
        };
      }

      return { ...state, ...updates };
    });
  };

  setPreviewSize = (size: ImageDimensions) => {
    this.patch({ previewSize: size });
  };

  setOriginalSize = (size: ImageDimensions) => {
    this.patch({ originalSize: size });
  };

  // View state
  setShowOriginal = (show: boolean) => {
    this.patch({ showOriginal: show });
  };

  toggleShowOriginal = () => {
    this.patch({ showOriginal: !this.state.showOriginal });
  };

  setIsFullScreen = (isFullScreen: boolean) => {
    this.patch({ isFullScreen });
  };

  toggleFullScreen = () => {
    this.patch({ isFullScreen: !this.state.isFullScreen });
  };

  setIsFullScreenLoading = (loading: boolean) => {
    this.patch({ isFullScreenLoading: loading });
  };

  setIsAdjusting = (isAdjusting: boolean) => {
    this.patch({ isAdjusting });
  };

  setIsLoadingFullRes = (loading: boolean) => {
    this.patch({ isLoadingFullRes: loading });
  };

  setIsFullResolution = (isFullRes: boolean) => {
    this.patch({ isFullResolution: isFullRes });
  };

  // Copy/paste adjustments
  copyAdjustments = () => {
    this.patch({ copiedAdjustments: { ...this.state.adjustments } });
  };

  pasteAdjustments = (mode: 'merge' | 'replace' = 'merge', keys?: string[]) => {
    if (!this.state.copiedAdjustments) return;

    if (mode === 'replace') {
      this.setAdjustments(this.state.copiedAdjustments);
    } else {
      // Merge mode - only paste specified keys or all copyable keys
      const toPaste = keys ?? Object.keys(this.state.copiedAdjustments);
      const updates: Partial<Adjustments> = {};
      for (const key of toPaste) {
        if (key in this.state.copiedAdjustments) {
          updates[key] = this.state.copiedAdjustments[key];
        }
      }
      this.setAdjustments(updates);
    }
  };

  clearCopiedAdjustments = () => {
    this.patch({ copiedAdjustments: null });
  };

  // Right panel
  setActiveRightPanel = (panel: Panel | null) => {
    this.patch({ activeRightPanel: panel });
  };

  setRenderedRightPanel = (panel: Panel | null) => {
    this.patch({ renderedRightPanel: panel });
  };

  // Tools
  setIsStraightenActive = (active: boolean) => {
    this.patch({ isStraightenActive: active });
  };

  setIsWbPickerActive = (active: boolean) => {
    this.patch({ isWbPickerActive: active });
  };

  // Preview URLs
  setFinalPreviewUrl = (url: string | null) => {
    this.patch({ finalPreviewUrl: url });
  };

  setUncroppedAdjustedPreviewUrl = (url: string | null) => {
    this.patch({ uncroppedAdjustedPreviewUrl: url });
  };

  setFullScreenUrl = (url: string | null) => {
    this.patch({ fullScreenUrl: url });
  };

  setFullResolutionUrl = (url: string | null) => {
    this.patch({ fullResolutionUrl: url });
  };

  setTransformedOriginalUrl = (url: string | null) => {
    this.patch({ transformedOriginalUrl: url });
  };

  // Error
  setError = (error: string | null) => {
    this.patch({ error });
  };

  clearError = () => {
    this.patch({ error: null });
  };

  // Reset editor
  resetEditor = () => {
    this.emit(defaultState);
  };

  // Clear image (go back to library)
  clearSelectedImage = () => {
    // Revoke blob URLs before clearing
    if (this.state.finalPreviewUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(this.state.finalPreviewUrl);
    }
    if (this.state.uncroppedAdjustedPreviewUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(this.state.uncroppedAdjustedPreviewUrl);
    }
    if (this.state.fullScreenUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(this.state.fullScreenUrl);
    }
    if (this.state.fullResolutionUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(this.state.fullResolutionUrl);
    }
    if (this.state.transformedOriginalUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(this.state.transformedOriginalUrl);
    }

    this.emit({
      ...defaultState,
      activeRightPanel: this.state.activeRightPanel,
      renderedRightPanel: this.state.renderedRightPanel,
    });
  };
}
