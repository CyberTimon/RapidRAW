import { Cubit } from '@blac/core';
import debounce from 'lodash.debounce';
import { invoke } from '@tauri-apps/api/core';
import { Invokes, SelectedImage, Panel, WaveformData } from '../components/ui/AppProperties';
import { Adjustments, INITIAL_ADJUSTMENTS } from '../utils/adjustments';
import { ImageDimensions } from '../hooks/useImageRenderSize';
import { ChannelConfig } from '../components/adjustments/Curves';

export interface CollapsibleSectionsState {
  basic: boolean;
  color: boolean;
  curves: boolean;
  details: boolean;
  effects: boolean;
}

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
  isViewLoading: boolean;
  copiedAdjustments: Adjustments | null;
  copiedSectionAdjustments: any;
  activeRightPanel: Panel | null;
  renderedRightPanel: Panel | null;
  isStraightenActive: boolean;
  isWbPickerActive: boolean;
  finalPreviewUrl: string | null;
  uncroppedAdjustedPreviewUrl: string | null;
  fullScreenUrl: string | null;
  fullResolutionUrl: string | null;
  transformedOriginalUrl: string | null;
  histogram: ChannelConfig | null;
  waveform: WaveformData | null;
  isWaveformVisible: boolean;
  collapsibleSectionsState: CollapsibleSectionsState;
  error: string | null;
  libraryActivePath: string | null;
  libraryActiveAdjustments: Adjustments;
}

const defaultCollapsibleSections: CollapsibleSectionsState = {
  basic: true,
  color: false,
  curves: true,
  details: false,
  effects: false,
};

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
  isViewLoading: false,
  copiedAdjustments: null,
  copiedSectionAdjustments: null,
  activeRightPanel: Panel.Adjustments,
  renderedRightPanel: Panel.Adjustments,
  isStraightenActive: false,
  isWbPickerActive: false,
  finalPreviewUrl: null,
  uncroppedAdjustedPreviewUrl: null,
  fullScreenUrl: null,
  fullResolutionUrl: null,
  transformedOriginalUrl: null,
  histogram: null,
  waveform: null,
  isWaveformVisible: false,
  collapsibleSectionsState: defaultCollapsibleSections,
  error: null,
  libraryActivePath: null,
  libraryActiveAdjustments: INITIAL_ADJUSTMENTS,
};

export class EditorCubit extends Cubit<EditorState> {
  private debouncedSaveMetadata: ReturnType<typeof debounce>;
  private debouncedSetHistory: ReturnType<typeof debounce>;

  constructor() {
    super(defaultState);

    this.debouncedSaveMetadata = debounce(this.saveMetadata, 300);
    this.debouncedSetHistory = debounce((newAdjustments: Adjustments) => {
      this.addToHistory(newAdjustments);
    }, 300);
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

  get geometricAdjustmentsKey(): string {
    const adj = this.state.adjustments;
    if (!adj) return '';
    const { crop, rotation, flipHorizontal, flipVertical, orientationSteps } = adj;
    return JSON.stringify({ crop, rotation, flipHorizontal, flipVertical, orientationSteps });
  }

  get visualAdjustmentsKey(): string {
    const adj = this.state.adjustments;
    if (!adj) return '';
    const { rating, sectionVisibility, ...visualAdjustments } = adj;
    return JSON.stringify(visualAdjustments);
  }

  // Selected image management
  setSelectedImage = (image: SelectedImage | null) => {
    if (image) {
      this.emit({
        ...this.state,
        selectedImage: image,
        adjustments: INITIAL_ADJUSTMENTS,
        history: [INITIAL_ADJUSTMENTS],
        historyIndex: 0,
        zoom: 1,
        pan: { x: 0, y: 0 },
        showOriginal: false,
        isViewLoading: true,
        finalPreviewUrl: null,
        uncroppedAdjustedPreviewUrl: null,
        fullScreenUrl: null,
        fullResolutionUrl: null,
        transformedOriginalUrl: null,
        histogram: null,
        error: null,
        libraryActivePath: null,
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
  private addToHistory = (newAdjustments: Adjustments) => {
    this.update((state) => {
      const newHistory = state.history.slice(0, state.historyIndex + 1);
      newHistory.push(newAdjustments);
      return {
        ...state,
        history: newHistory,
        historyIndex: newHistory.length - 1,
      };
    });
  };

  setAdjustments = (updates: Partial<Adjustments> | ((prev: Adjustments) => Adjustments)) => {
    this.update((state) => {
      const currentAdj = state.adjustments;
      const newAdjustments = typeof updates === 'function'
        ? updates(currentAdj)
        : { ...currentAdj, ...updates };

      return {
        ...state,
        adjustments: newAdjustments,
      };
    });

    // Debounced history update
    this.debouncedSetHistory(this.state.adjustments);
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

  // Set adjustments directly (bypassing debounce for immediate history update)
  setAdjustmentsImmediate = (adjustments: Adjustments) => {
    this.debouncedSetHistory.cancel();
    this.update((state) => {
      const newHistory = state.history.slice(0, state.historyIndex + 1);
      newHistory.push(adjustments);
      return {
        ...state,
        adjustments,
        history: newHistory,
        historyIndex: newHistory.length - 1,
      };
    });
    this.debouncedSaveMetadata();
  };

  undo = () => {
    if (!this.canUndo) return;
    this.debouncedSetHistory.cancel();
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
    this.debouncedSetHistory.cancel();
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
    this.debouncedSetHistory.cancel();
    this.patch({
      adjustments,
      history: [adjustments],
      historyIndex: 0,
    });
  };

  cancelPendingHistoryUpdate = () => {
    this.debouncedSetHistory.cancel();
  };

  private saveMetadata = async () => {
    if (!this.state.selectedImage?.path) return;

    try {
      await invoke(Invokes.SaveMetadataAndUpdateThumbnail, {
        path: this.state.selectedImage.path,
        adjustments: this.state.adjustments,
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

  setBaseRenderSize = (size: ImageDimensions) => {
    this.patch({ baseRenderSize: size });
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
    if (this.state.isFullScreen) {
      this.patch({ isFullScreen: false, fullScreenUrl: null });
    } else if (this.state.selectedImage) {
      this.patch({ isFullScreen: true });
    }
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

  setIsViewLoading = (loading: boolean) => {
    this.patch({ isViewLoading: loading });
  };

  // Copy/paste adjustments
  setCopiedAdjustments = (adjustments: Adjustments | null) => {
    this.patch({ copiedAdjustments: adjustments });
  };

  copyAdjustments = () => {
    this.patch({ copiedAdjustments: { ...this.state.adjustments } });
  };

  pasteAdjustments = (mode: 'merge' | 'replace' = 'merge', keys?: string[]) => {
    if (!this.state.copiedAdjustments) return;

    if (mode === 'replace') {
      this.setAdjustments(this.state.copiedAdjustments);
    } else {
      const toPaste = keys ?? Object.keys(this.state.copiedAdjustments);
      const updates: Partial<Adjustments> = {};
      for (const key of toPaste) {
        if (key in this.state.copiedAdjustments) {
          (updates as any)[key] = (this.state.copiedAdjustments as any)[key];
        }
      }
      this.setAdjustments(updates);
    }
  };

  clearCopiedAdjustments = () => {
    this.patch({ copiedAdjustments: null });
  };

  setCopiedSectionAdjustments = (adjustments: any) => {
    this.patch({ copiedSectionAdjustments: adjustments });
  };

  // Right panel
  setActiveRightPanel = (panel: Panel | null) => {
    if (panel === this.state.activeRightPanel) {
      this.patch({ activeRightPanel: null });
    } else {
      this.patch({ activeRightPanel: panel, renderedRightPanel: panel });
    }
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

  toggleWbPicker = () => {
    this.patch({ isWbPickerActive: !this.state.isWbPickerActive });
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

  // Histogram and waveform
  setHistogram = (histogram: ChannelConfig | null) => {
    this.patch({ histogram });
  };

  setWaveform = (waveform: WaveformData | null) => {
    this.patch({ waveform });
  };

  setIsWaveformVisible = (visible: boolean) => {
    this.patch({ isWaveformVisible: visible });
  };

  toggleWaveform = () => {
    this.patch({ isWaveformVisible: !this.state.isWaveformVisible });
  };

  // Collapsible sections
  setCollapsibleSectionsState = (state: CollapsibleSectionsState) => {
    this.patch({ collapsibleSectionsState: state });
  };

  updateCollapsibleSection = (section: keyof CollapsibleSectionsState, expanded: boolean) => {
    this.update((state) => ({
      ...state,
      collapsibleSectionsState: {
        ...state.collapsibleSectionsState,
        [section]: expanded,
      },
    }));
  };

  // Error
  setError = (error: string | null) => {
    this.patch({ error });
  };

  clearError = () => {
    this.patch({ error: null });
  };

  // Library active state (for when no image is open in editor)
  setLibraryActivePath = (path: string | null) => {
    this.patch({ libraryActivePath: path });
  };

  setLibraryActiveAdjustments = (adjustments: Adjustments | ((prev: Adjustments) => Adjustments)) => {
    this.update((state) => {
      const newAdjustments = typeof adjustments === 'function'
        ? adjustments(state.libraryActiveAdjustments)
        : adjustments;
      return { ...state, libraryActiveAdjustments: newAdjustments };
    });
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

    const lastActivePath = this.state.selectedImage?.path ?? null;

    this.emit({
      ...defaultState,
      activeRightPanel: this.state.activeRightPanel,
      renderedRightPanel: this.state.renderedRightPanel,
      collapsibleSectionsState: this.state.collapsibleSectionsState,
      copiedAdjustments: this.state.copiedAdjustments,
      copiedSectionAdjustments: this.state.copiedSectionAdjustments,
      libraryActivePath: lastActivePath,
    });
  };

  // Back to library handler
  backToLibrary = () => {
    const lastActivePath = this.state.selectedImage?.path ?? null;

    // Revoke blob URLs
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

    this.patch({
      selectedImage: null,
      finalPreviewUrl: null,
      uncroppedAdjustedPreviewUrl: null,
      fullScreenUrl: null,
      fullResolutionUrl: null,
      transformedOriginalUrl: null,
      histogram: null,
      waveform: null,
      isWaveformVisible: false,
      isWbPickerActive: false,
      libraryActivePath: lastActivePath,
    });
  };
}
