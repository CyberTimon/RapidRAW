import { RefObject } from 'react';
import { create } from 'zustand';
import debounce from 'lodash.debounce';
import { Adjustments, INITIAL_ADJUSTMENTS, MaskContainer, CropGeometry, pickCropGeometry } from '../utils/adjustments';
import {
  SelectedImage,
  WaveformData,
  BrushSettings,
  ChannelConfig,
  OverlayMode,
  type SpeedEditTarget,
  type ImageDefaults,
} from '../types/editor';
import { CompareView } from '../types/settings';
import { ImageDimensions } from '../hooks/useImageRenderSize';
import { ToolType } from '../types/masks';
import { describeHistoryChange, isSameValue } from '../utils/editHistory';
import { HslMixerProperty } from '../utils/hslMixer';
import { getCroppedDimensions } from '../utils/cropUtils';
import { getDevicePixelRatio } from '../utils/displayScale';

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

export type WgpuPhase = 'hidden' | 'arming' | 'live';

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
  histogram: ChannelConfig | null;
  waveform: WaveformData | null;
  isWaveformVisible: boolean;
  scopeWhite: number;
  displayRevision: number;
  activeWaveformChannel: string;
  waveformHeight: number;

  // Interaction State
  isSliderDragging: boolean;
  speedEditTarget: RefObject<SpeedEditTarget | null> | null;
  isSpeedEditActive: boolean;
  zoom: number;
  displaySize: ImageDimensions;
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
  aiUpscaleProgress: Record<string, number>;
  isAIConnectorConnected: boolean;
  wgpuPhase: WgpuPhase;
  patchesSentToBackend: Set<string>;

  // Clipboard
  copiedSectionAdjustments: any | null;
  copiedMask: MaskContainer | null;
  copiedAdjustments: Adjustments | null;
  copiedAdjustmentsDefaults: Adjustments | null;
  imageDefaults: ImageDefaults | null;

  // Actions
  setEditor: (updater: Partial<EditorState> | ((state: EditorState) => Partial<EditorState>)) => void;
  pushHistory: (newAdjustments: Adjustments, label?: string) => void;
  undo: () => void;
  redo: () => void;
  resetHistory: (initialState: Adjustments, path?: string | null) => void;
  stashHistory: () => void;
  goToHistoryIndex: (index: number) => void;
}

export const getZoomContentSize = (state: Pick<EditorState, 'originalSize' | 'adjustments'>): ImageDimensions =>
  getCroppedDimensions(
    state.originalSize.width,
    state.originalSize.height,
    state.adjustments.orientationSteps || 0,
    state.adjustments.crop,
  );

export const getZoomPercent = (state: Pick<EditorState, 'originalSize' | 'adjustments' | 'displaySize'>): number => {
  const contentWidth = getZoomContentSize(state).width;
  return contentWidth > 0 && state.displaySize.width > 0
    ? (state.displaySize.width * getDevicePixelRatio()) / contentWidth
    : 1.0;
};

type StoredHistory = Pick<EditorState, 'history' | 'historyLabels' | 'historyIndex'>;

const MAX_STORED_HISTORIES = 20;
const storedHistories = new Map<string, StoredHistory>();
let historyPath: string | null = null;

const restoreStoredHistory = (path: string, initialState: Adjustments): StoredHistory | null => {
  const stored = storedHistories.get(path);
  if (!stored || !isSameValue(stored.history[stored.historyIndex], initialState)) return null;
  storedHistories.delete(path);
  const history = [...stored.history];
  history[stored.historyIndex] = initialState;
  return { ...stored, history };
};

export const debouncedSetHistory = debounce((newAdj: Adjustments, label?: string) => {
  useEditorStore.getState().pushHistory(newAdj, label);
}, 500);

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

export const useEditorStore = create<EditorState>((set, get) => ({
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
  waveform: null,
  isWaveformVisible: false,
  scopeWhite: 1,
  displayRevision: 0,
  activeWaveformChannel: 'luma',
  waveformHeight: 220,

  isSliderDragging: false,
  speedEditTarget: null,
  isSpeedEditActive: false,
  interactivePatch: null,
  activeMaskContainerId: null,
  activeMaskId: null,
  activeAiPatchContainerId: null,
  activeAiSubMaskId: null,

  zoom: 1,
  displaySize: { width: 0, height: 0 },
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
  brushSettings: { size: 100, feather: 50, tool: ToolType.Brush },
  copiedAdjustments: null,
  copiedAdjustmentsDefaults: null,
  imageDefaults: null,

  isGeneratingAiMask: false,
  isAIConnectorConnected: false,
  isGeneratingAi: false,
  aiDenoiseProgress: {},
  aiUpscaleProgress: {},
  isMaskControlHovered: false,
  wgpuPhase: 'hidden',
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

  undo: () => {
    debouncedSetHistory.flush();
    set((state) => {
      if (state.historyIndex > 0) {
        const newIndex = state.historyIndex - 1;
        return { historyIndex: newIndex, adjustments: state.history[newIndex] };
      }
      return state;
    });
  },

  redo: () => {
    debouncedSetHistory.flush();
    set((state) => {
      if (state.historyIndex < state.history.length - 1) {
        const newIndex = state.historyIndex + 1;
        return { historyIndex: newIndex, adjustments: state.history[newIndex] };
      }
      return state;
    });
  },

  resetHistory: (initialState, path) => {
    if (path !== undefined) historyPath = path;
    const restored = path ? restoreStoredHistory(path, initialState) : null;
    set((state) => ({
      ...(restored ?? { history: [initialState], historyLabels: [''], historyIndex: 0 }),
      adjustments: initialState,
      ...(state.cropSessionSnapshot
        ? {
            cropSessionSnapshot: {
              path: state.selectedImage?.path ?? null,
              geometry: pickCropGeometry(initialState),
            },
          }
        : {}),
    }));
  },

  stashHistory: () => {
    debouncedSetHistory.flush();
    if (!historyPath) return;
    const { history, historyLabels, historyIndex } = get();
    storedHistories.delete(historyPath);
    if (history.length > 1) {
      storedHistories.set(historyPath, { history, historyLabels, historyIndex });
      if (storedHistories.size > MAX_STORED_HISTORIES) {
        storedHistories.delete(storedHistories.keys().next().value!);
      }
    }
    historyPath = null;
  },

  goToHistoryIndex: (index) => {
    debouncedSetHistory.flush();
    set((state) => {
      if (index >= 0 && index < state.history.length) {
        return { historyIndex: index, adjustments: state.history[index] };
      }
      return state;
    });
  },
}));

export const cancelCanvasTool = (): boolean => {
  const state = useEditorStore.getState();
  const isActive =
    state.isWbPickerActive ||
    state.isRelightPickerActive ||
    state.activeCenterMarker !== null ||
    state.mixerPickerProperty !== null ||
    state.isStraightenActive;
  if (isActive) state.setEditor({ ...canvasToolState(), isStraightenActive: false });
  return isActive;
};
