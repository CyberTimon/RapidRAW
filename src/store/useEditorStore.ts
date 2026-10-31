import { RefObject } from 'react';
import { create } from 'zustand';
import {
  Adjustments,
  INITIAL_ADJUSTMENTS,
  MaskContainer,
  AiPatch,
  CropGeometry,
  pickCropGeometry,
} from '../utils/adjustments';
import { SelectedImage, WaveformData, BrushSettings, CompareView } from '../components/ui/AppProperties';
import type { CurveInputHistogram, HistogramData } from '../types/analytics';
import { ImageDimensions } from '../hooks/useImageRenderSize';
import { ToolType } from '../components/panel/right/Masks';
import { OverlayMode } from '../components/panel/right/CropPanel';
import { describeHistoryChange } from '../utils/editHistory';
import { HslMixerProperty } from '../utils/hslMixer';
import type { SpeedEditTarget } from '../components/ui/Slider';

export type CenterMarker = 'vignette' | 'centre';

interface InteractivePatch {
  url: string;
  normX: number;
  normY: number;
  normW: number;
  normH: number;
}

interface BaseRenderSize extends ImageDimensions {
  containerHeight: number;
  containerWidth: number;
  offsetX: number;
  offsetY: number;
}

interface EditorState {
  // Core Image & Adjustments
  selectedImage: SelectedImage | null;
  adjustments: Adjustments;
  previewOverride: Adjustments | null;

  // History State
  history: Adjustments[];
  historyLabels: string[];
  historyIndex: number;

  // Previews & Overlays
  finalPreviewUrl: string | null;
  uncroppedAdjustedPreviewUrl: string | null;
  interactivePatch: InteractivePatch | null;
  showOriginal: boolean;
  compareView: CompareView;
  splitPosition: number;
  originalPreview: { path: string; url: string | null } | null;

  // Analytics
  histogram: HistogramData | null;
  curveInputHistogram: CurveInputHistogram | null;
  maskCurveInputHistogram: CurveInputHistogram | null;
  waveform: WaveformData | null;
  isWaveformVisible: boolean;
  activeWaveformChannel: string;
  waveformHeight: number;

  // Interaction State
  isSliderDragging: boolean;
  speedEditTarget: RefObject<SpeedEditTarget | null> | null;
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
  isAutoStraightening: boolean;
  isWbPickerActive: boolean;
  isRelightPickerActive: boolean;
  activeRelightLightId: string | null;
  activeCenterMarker: CenterMarker | null;
  mixerPickerProperty: HslMixerProperty | null;
  isGuidedPerspectiveActive: boolean;
  liveRotation: number | null;
  cropSessionSnapshot: { path: string | null; geometry: CropGeometry } | null;
  brushSettings: BrushSettings | null;

  // Masks & AI
  activeMaskContainerId: string | null;
  activeMaskId: string | null;
  activeAiPatchContainerId: string | null;
  activeAiSubMaskId: string | null;
  isMaskControlHovered: boolean;
  isGeneratingAiMask: boolean;
  isGeneratingAi: boolean;
  aiDenoiseProgress: Record<string, number>;
  isAIConnectorConnected: boolean;
  hasRenderedFirstFrame: boolean;
  patchesSentToBackend: Set<string>;

  // Clipboard
  copiedSectionAdjustments: any | null;
  copiedMask: MaskContainer | null;
  copiedAdjustments: Adjustments | null;

  // Actions
  setEditor: (updater: Partial<EditorState> | ((state: EditorState) => Partial<EditorState>)) => void;
  pushHistory: (newAdjustments: Adjustments, label?: string) => void;
  undo: () => void;
  redo: () => void;
  resetHistory: (initialState: Adjustments) => void;
  goToHistoryIndex: (index: number) => void;
}

type CanvasToolState = Pick<
  EditorState,
  'isWbPickerActive' | 'isRelightPickerActive' | 'activeCenterMarker' | 'mixerPickerProperty'
>;

export const canvasToolState = (activeTool: Partial<CanvasToolState> = {}): CanvasToolState => ({
  isWbPickerActive: false,
  isRelightPickerActive: false,
  activeCenterMarker: null,
  mixerPickerProperty: null,
  ...activeTool,
});

export const useEditorStore = create<EditorState>((set) => ({
  selectedImage: null,
  adjustments: INITIAL_ADJUSTMENTS,
  previewOverride: null,
  history: [INITIAL_ADJUSTMENTS],
  historyLabels: [''],
  historyIndex: 0,

  finalPreviewUrl: null,
  uncroppedAdjustedPreviewUrl: null,
  showOriginal: false,
  compareView: 'off',
  splitPosition: 0.5,
  originalPreview: null,
  histogram: null,
  curveInputHistogram: null,
  maskCurveInputHistogram: null,
  waveform: null,
  isWaveformVisible: false,
  activeWaveformChannel: 'luma',
  waveformHeight: 220,

  isSliderDragging: false,
  speedEditTarget: null,
  interactivePatch: null,
  activeMaskContainerId: null,
  activeMaskId: null,
  activeAiPatchContainerId: null,
  activeAiSubMaskId: null,

  zoom: 1,
  displaySize: { width: 0, height: 0 },
  previewSize: { width: 0, height: 0 },
  baseRenderSize: { width: 0, height: 0, offsetX: 0, offsetY: 0, containerWidth: 0, containerHeight: 0 },
  originalSize: { width: 0, height: 0 },

  isRotationActive: false,
  overlayMode: 'thirds',
  overlayRotation: 0,
  isStraightenActive: false,
  isAutoStraightening: false,
  isWbPickerActive: false,
  isRelightPickerActive: false,
  activeRelightLightId: null,
  activeCenterMarker: null,
  mixerPickerProperty: null,
  isGuidedPerspectiveActive: false,
  liveRotation: null,
  cropSessionSnapshot: null,

  copiedSectionAdjustments: null,
  copiedMask: null,
  brushSettings: { size: 50, feather: 50, tool: ToolType.Brush },
  copiedAdjustments: null,

  isGeneratingAiMask: false,
  isAIConnectorConnected: false,
  isGeneratingAi: false,
  aiDenoiseProgress: {},
  isMaskControlHovered: false,
  hasRenderedFirstFrame: false,
  patchesSentToBackend: new Set<string>(),

  setEditor: (updater) => set((state) => (typeof updater === 'function' ? updater(state) : updater)),

  pushHistory: (newAdj, label) =>
    set((state) => {
      const newHistory = state.history.slice(0, state.historyIndex + 1);
      const newLabels = state.historyLabels.slice(0, state.historyIndex + 1);
      newLabels.push(label || describeHistoryChange(state.history[state.historyIndex], newAdj));
      newHistory.push(newAdj);
      if (newHistory.length > 50) {
        newHistory.shift();
        newLabels.shift();
      }
      return { history: newHistory, historyLabels: newLabels, historyIndex: newHistory.length - 1 };
    }),

  undo: () =>
    set((state) => {
      if (state.historyIndex > 0) {
        const newIndex = state.historyIndex - 1;
        return { historyIndex: newIndex, adjustments: state.history[newIndex] };
      }
      return state;
    }),

  redo: () =>
    set((state) => {
      if (state.historyIndex < state.history.length - 1) {
        const newIndex = state.historyIndex + 1;
        return { historyIndex: newIndex, adjustments: state.history[newIndex] };
      }
      return state;
    }),

  resetHistory: (initialState) =>
    set((state) => ({
      history: [initialState],
      historyLabels: [''],
      historyIndex: 0,
      adjustments: initialState,
      ...(state.cropSessionSnapshot
        ? {
            cropSessionSnapshot: {
              path: state.selectedImage?.path ?? null,
              geometry: pickCropGeometry(initialState),
            },
          }
        : {}),
    })),

  goToHistoryIndex: (index) =>
    set((state) => {
      if (index >= 0 && index < state.history.length) {
        return { historyIndex: index, adjustments: state.history[index] };
      }
      return state;
    }),
}));
