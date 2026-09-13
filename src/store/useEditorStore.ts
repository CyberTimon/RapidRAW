import { protectAutoEdit } from '../auto/editSafety';
import { create } from 'zustand';
import { beginSession, recordGeometry, sameGeometry, cropGeometry, committedAdjustments } from '../crop/session';
import { Adjustments, INITIAL_ADJUSTMENTS } from '../utils/adjustments';
import { ToolType } from '../components/panel/right/Masks';
import { recordAdjustmentChange } from '../history/editorHistory';
import type { EditorState } from './editorStoreTypes';

export const useEditorStore = create<EditorState>((set) => ({
  selectedImage: null,
  adjustments: INITIAL_ADJUSTMENTS,
  previewOverride: null,
  cropSession: null,
  history: [INITIAL_ADJUSTMENTS],
  historyIndex: 0,

  finalPreviewUrl: null,
  uncroppedAdjustedPreviewUrl: null,
  showOriginal: false,
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
  hasRenderedFirstFrame: false,
  patchesSentToBackend: new Set<string>(),

  beginCrop: () =>
    set((state) => {
      if (!state.selectedImage || state.cropSession) return state;
      return {
        cropSession: beginSession(state.selectedImage.path, state.adjustments),
        showOriginal: false,
        previewOverride: null,
      };
    }),
  finishCrop: (accept) => {
    let transition: Parameters<typeof recordAdjustmentChange>[0] | null = null;
    set((state) => {
      const session = state.cropSession;
      if (!session) return state;
      const adjustments = accept
        ? protectAutoEdit({ ...state.adjustments, ...session.original }, state.adjustments, session.path)
        : { ...state.adjustments, ...session.original };
      const changed = accept && !sameGeometry(session.original, cropGeometry(adjustments));
      const history = changed
        ? [...state.history.slice(0, state.historyIndex + 1), adjustments].slice(-50)
        : state.history;
      if (changed) {
        const beforeIndex = state.historyIndex;
        const afterIndex = history.length - 1;
        transition = {
          path: session.path,
          before: state.history[beforeIndex],
          beforeIndex,
          after: adjustments,
          afterIndex,
          apply: (snapshot, index) => applyHistoryReplay(session.path, snapshot, index),
        };
      }
      return {
        adjustments,
        history,
        historyIndex: changed ? history.length - 1 : state.historyIndex,
        cropSession: null,
        liveRotation: null,
        isRotationActive: false,
        isStraightenActive: false,
        isGuidedPerspectiveActive: false,
      };
    });
    if (transition) recordAdjustmentChange(transition);
  },
  setEditor: (updater) =>
    set((state) => {
      const update = typeof updater === 'function' ? updater(state) : updater;
      if (update.adjustments && state.cropSession) {
        return { ...update, cropSession: recordGeometry(state.cropSession, update.adjustments) };
      }
      return update;
    }),

  pushHistory: (newAdj, recordGlobal = true) => {
    let transition: Parameters<typeof recordAdjustmentChange>[0] | null = null;
    set((state) => {
      const committed = committedAdjustments(newAdj, state.cropSession);
      if (JSON.stringify(state.history[state.historyIndex]) === JSON.stringify(committed)) return state;
      const newHistory = state.history.slice(0, state.historyIndex + 1);
      const beforeIndex = state.historyIndex;
      newHistory.push(committed);
      const shifted = newHistory.length > 50;
      if (shifted) newHistory.shift();
      const afterIndex = newHistory.length - 1;
      const path = state.selectedImage?.path;
      if (path) {
        transition = {
          path,
          before: state.history[beforeIndex],
          beforeIndex: shifted ? Math.max(0, beforeIndex - 1) : beforeIndex,
          after: committed,
          afterIndex,
          apply: (snapshot, index) => applyHistoryReplay(path, snapshot, index),
        };
      }
      return { history: newHistory, historyIndex: afterIndex };
    });
    if (transition && recordGlobal) recordAdjustmentChange(transition);
  },

  undo: () =>
    set((state) => {
      if (state.cropSession) {
        const session = state.cropSession;
        const index = Math.max(0, session.index - 1);
        return { cropSession: { ...session, index }, adjustments: { ...state.adjustments, ...session.history[index] } };
      }
      if (state.historyIndex > 0) {
        const newIndex = state.historyIndex - 1;
        return { historyIndex: newIndex, adjustments: state.history[newIndex] };
      }
      return state;
    }),

  redo: () =>
    set((state) => {
      if (state.cropSession) {
        const session = state.cropSession;
        const index = Math.min(session.history.length - 1, session.index + 1);
        return { cropSession: { ...session, index }, adjustments: { ...state.adjustments, ...session.history[index] } };
      }
      if (state.historyIndex < state.history.length - 1) {
        const newIndex = state.historyIndex + 1;
        return { historyIndex: newIndex, adjustments: state.history[newIndex] };
      }
      return state;
    }),

  resetHistory: (initialState) =>
    set({
      cropSession: null,
      history: [initialState],
      historyIndex: 0,
      adjustments: initialState,
    }),

  goToHistoryIndex: (index) => {
    let transition: Parameters<typeof recordAdjustmentChange>[0] | null = null;
    set((state) => {
      if (state.cropSession) {
        const session = state.cropSession;
        if (index < 0 || index >= session.history.length) return state;
        return { cropSession: { ...session, index }, adjustments: { ...state.adjustments, ...session.history[index] } };
      }
      if (index >= 0 && index < state.history.length) {
        const path = state.selectedImage?.path;
        if (path && index !== state.historyIndex) {
          transition = {
            path,
            before: state.history[state.historyIndex],
            beforeIndex: state.historyIndex,
            after: state.history[index],
            afterIndex: index,
            apply: (snapshot, preferredIndex) => applyHistoryReplay(path, snapshot, preferredIndex),
          };
        }
        return { historyIndex: index, adjustments: state.history[index] };
      }
      return state;
    });
    if (transition) recordAdjustmentChange(transition);
  },
}));

function applyHistoryReplay(path: string, adjustments: Adjustments, preferredIndex: number) {
  useEditorStore.setState((state) => {
    if (state.selectedImage?.path !== path) return state;
    if (JSON.stringify(state.history[preferredIndex]) === JSON.stringify(adjustments)) {
      return { adjustments, historyIndex: preferredIndex };
    }
    return { adjustments, history: [adjustments], historyIndex: 0 };
  });
}
