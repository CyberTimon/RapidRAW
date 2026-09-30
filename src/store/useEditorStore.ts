import { create } from 'zustand';
import { resetPreviewAssetRevisions } from '../utils/previewPipeline';
import { AdjustmentSection, Adjustments, INITIAL_ADJUSTMENTS, MaskContainer } from '../utils/adjustments';
import { SelectedImage, WaveformData, BrushSettings } from '../components/ui/AppProperties';
import { ChannelConfig } from '../components/adjustments/Curves';
import { ImageDimensions } from '../hooks/useImageRenderSize';
import { ToolType } from '../components/panel/right/Masks';
import { OverlayMode } from '../components/panel/right/CropPanel';

export interface InteractivePatch {
  url: string;
  normX: number;
  normY: number;
  normW: number;
  normH: number;
}

export interface BaseRenderSize extends ImageDimensions {
  containerHeight: number;
  containerWidth: number;
  offsetX: number;
  offsetY: number;
}

export interface EditorState {
  // Core Image & Adjustments
  selectedImage: SelectedImage | null;
  imageSession: number;
  backendGeneration: number | null;
  adjustments: Adjustments;
  previewOverride: Adjustments | null;

  // History State
  history: Adjustments[];
  historyIndex: number;

  // Previews & Overlays
  finalPreviewUrl: string | null;
  comparisonPreviewUrl: string | null;
  uncroppedAdjustedPreviewUrl: string | null;
  interactivePatch: InteractivePatch | null;
  showOriginal: boolean;
  /** Clipping warnings in the editor preview; a view aid, never saved with the edit. */
  showClipping: boolean;
  /** Before/after split view: the unedited photo left of the divider. */
  splitCompare: boolean;
  /** Divider position as a fraction of the image width. */
  splitComparePosition: number;
  splitComparisonUrl: string | null;

  // Analytics
  histogram: ChannelConfig | null;
  waveform: WaveformData | null;
  isWaveformVisible: boolean;
  activeWaveformChannel: string;
  waveformHeight: number;

  // Interaction State
  isSliderDragging: boolean;
  zoom: number;
  displaySize: ImageDimensions;
  previewSize: ImageDimensions;
  baseRenderSize: BaseRenderSize;
  originalSize: ImageDimensions;

  // Tools State
  isRotationActive: boolean;
  overlayMode: OverlayMode;
  overlayRotation: number;
  isStraightenActive: boolean;
  isWbPickerActive: boolean;
  isGuidedPerspectiveActive: boolean;
  liveRotation: number | null;
  brushSettings: BrushSettings | null;

  // Masks & AI
  activeMaskContainerId: string | null;
  activeMaskId: string | null;
  activeAiPatchContainerId: string | null;
  activeAiSubMaskId: string | null;
  activeLocalEditKind: 'adjustment' | 'repair' | null;
  isMaskControlHovered: boolean;
  showPatchMarkers: boolean;
  isGeneratingAiMask: boolean;
  isGeneratingAi: boolean;
  isAIConnectorConnected: boolean;
  hasRenderedFirstFrame: boolean;
  patchesSentToBackend: Set<string>;

  // Clipboard
  copiedSectionAdjustments: { section: AdjustmentSection; values: Partial<Adjustments> } | null;
  copiedMask: MaskContainer | null;
  copiedAdjustments: Partial<Adjustments> | null;

  // Actions
  setEditor: (updater: Partial<EditorState> | ((state: EditorState) => Partial<EditorState>)) => void;
  pushHistory: (newAdjustments: Adjustments) => void;
  undo: () => void;
  redo: () => void;
  resetHistory: (initialState: Adjustments) => void;
  goToHistoryIndex: (index: number) => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  selectedImage: null,
  imageSession: 0,
  backendGeneration: null,
  adjustments: INITIAL_ADJUSTMENTS,
  previewOverride: null,
  history: [INITIAL_ADJUSTMENTS],
  historyIndex: 0,

  finalPreviewUrl: null,
  comparisonPreviewUrl: null,
  uncroppedAdjustedPreviewUrl: null,
  showOriginal: false,
  showClipping: false,
  splitCompare: false,
  splitComparePosition: 0.5,
  splitComparisonUrl: null,
  histogram: null,
  waveform: null,
  isWaveformVisible: false,
  activeWaveformChannel: 'luma',
  waveformHeight: 220,

  isSliderDragging: false,
  interactivePatch: null,
  activeMaskContainerId: null,
  activeMaskId: null,
  activeAiPatchContainerId: null,
  activeAiSubMaskId: null,
  activeLocalEditKind: null,

  zoom: 1,
  displaySize: { width: 0, height: 0 },
  previewSize: { width: 0, height: 0 },
  baseRenderSize: { width: 0, height: 0, offsetX: 0, offsetY: 0, containerWidth: 0, containerHeight: 0 },
  originalSize: { width: 0, height: 0 },

  isRotationActive: false,
  overlayMode: 'thirds',
  overlayRotation: 0,
  isStraightenActive: false,
  isWbPickerActive: false,
  isGuidedPerspectiveActive: false,
  liveRotation: null,

  copiedSectionAdjustments: null,
  copiedMask: null,
  brushSettings: { size: 50, feather: 50, tool: ToolType.Brush },
  copiedAdjustments: null,

  isGeneratingAiMask: false,
  isAIConnectorConnected: false,
  isGeneratingAi: false,
  isMaskControlHovered: false,
  showPatchMarkers: true,
  hasRenderedFirstFrame: false,
  patchesSentToBackend: new Set<string>(),

  setEditor: (updater) =>
    set((state) => {
      let next = typeof updater === 'function' ? updater(state) : updater;
      const switchingImage = 'selectedImage' in next && next.selectedImage?.path !== state.selectedImage?.path;
      const leavingComparison = state.showOriginal && next.showOriginal === false;
      const replacingComparison =
        'comparisonPreviewUrl' in next && next.comparisonPreviewUrl !== state.comparisonPreviewUrl;
      if (state.comparisonPreviewUrl && (switchingImage || leavingComparison || replacingComparison)) {
        const oldUrl = state.comparisonPreviewUrl;
        if (oldUrl.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(oldUrl), 500);
      }
      const leavingSplit = state.splitCompare && next.splitCompare === false;
      const replacingSplit = 'splitComparisonUrl' in next && next.splitComparisonUrl !== state.splitComparisonUrl;
      if (state.splitComparisonUrl && (switchingImage || leavingSplit || replacingSplit)) {
        const oldUrl = state.splitComparisonUrl;
        setTimeout(() => URL.revokeObjectURL(oldUrl), 500);
        if (leavingSplit && !replacingSplit) next = { ...next, splitComparisonUrl: null };
      }
      if (switchingImage) {
        resetPreviewAssetRevisions();
        if (state.interactivePatch?.url) URL.revokeObjectURL(state.interactivePatch.url);
        return {
          finalPreviewUrl: null,
          comparisonPreviewUrl: null,
          splitComparisonUrl: null,
          uncroppedAdjustedPreviewUrl: null,
          histogram: null,
          waveform: null,
          ...next,
          imageSession: state.imageSession + 1,
          backendGeneration: null,
          hasRenderedFirstFrame: false,
          interactivePatch: null,
          isSliderDragging: false,
          patchesSentToBackend: new Set<string>(),
        };
      }
      if (leavingComparison) return { comparisonPreviewUrl: null, ...next };
      return next;
    }),

  pushHistory: (newAdj) =>
    set((state) => {
      const newHistory = state.history.slice(0, state.historyIndex + 1);
      newHistory.push(newAdj);
      if (newHistory.length > 50) newHistory.shift();
      return { history: newHistory, historyIndex: newHistory.length - 1 };
    }),

  undo: () =>
    set((state) => {
      if (state.historyIndex > 0) {
        const newIndex = state.historyIndex - 1;
        return {
          historyIndex: newIndex,
          adjustments: { ...state.history[newIndex], inpaintHistory: state.adjustments.inpaintHistory },
        };
      }
      return state;
    }),

  redo: () =>
    set((state) => {
      if (state.historyIndex < state.history.length - 1) {
        const newIndex = state.historyIndex + 1;
        return {
          historyIndex: newIndex,
          adjustments: { ...state.history[newIndex], inpaintHistory: state.adjustments.inpaintHistory },
        };
      }
      return state;
    }),

  resetHistory: (initialState) =>
    set({
      history: [initialState],
      historyIndex: 0,
      adjustments: initialState,
    }),

  goToHistoryIndex: (index) =>
    set((state) => {
      if (index >= 0 && index < state.history.length) {
        return {
          historyIndex: index,
          adjustments: { ...state.history[index], inpaintHistory: state.adjustments.inpaintHistory },
        };
      }
      return state;
    }),
}));
