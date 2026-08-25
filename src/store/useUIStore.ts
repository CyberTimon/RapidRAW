import { create } from 'zustand';
import {
  ImageFile,
  Panel,
  UiVisibility,
  CullingSuggestions,
  PanelRegion,
  WorkspaceState,
} from '../components/ui/AppProperties';

export type SwitcherPlacement = 'bottom' | 'right' | 'left' | 'top';

export interface CollapsibleSectionsState {
  basic: boolean;
  color: boolean;
  curves: boolean;
  details: boolean;
  effects: boolean;
}

export interface ConfirmModalState {
  confirmText?: string;
  confirmVariant?: string;
  isOpen: boolean;
  message?: string;
  onConfirm?(): void;
  title?: string;
}

export interface CollageModalState {
  isOpen: boolean;
  sourceImages: Array<Pick<ImageFile, 'path'>>;
}

export interface PanoramaModalState {
  error: string | null;
  finalImageBase64: string | null;
  isOpen: boolean;
  isProcessing: boolean;
  progressMessage: string | null;
  stitchingSourcePaths: Array<string>;
}

export interface FocusStackModalState {
  error: string | null;
  finalImageBase64: string | null;
  depthMapBase64: string | null;
  isOpen: boolean;
  isProcessing: boolean;
  progressMessage: string | null;
  sourcePaths: Array<string>;
}

export interface HdrModalState {
  error: string | null;
  finalImageBase64: string | null;
  isOpen: boolean;
  isProcessing: boolean;
  progressMessage: string | null;
  stitchingSourcePaths: Array<string>;
}

export interface DenoiseModalState {
  isOpen: boolean;
  isProcessing: boolean;
  previewBase64: string | null;
  originalBase64?: string | null;
  error: string | null;
  targetPaths: string[];
  progressMessage: string | null;
  isRaw: boolean;
}

export interface NegativeConversionModalState {
  isOpen: boolean;
  targetPaths: Array<string>;
}

export interface CullingModalState {
  isOpen: boolean;
  suggestions: CullingSuggestions | null;
  progress: { current: number; total: number; stage: string } | null;
  error: string | null;
  pathsToCull: Array<string>;
}

export const ALL_PANELS: Panel[] = [
  Panel.Metadata,
  Panel.FolderTree,
  Panel.Export,
  Panel.Tethering,
  Panel.Adjustments,
  Panel.Crop,
  Panel.Masks,
  Panel.Ai,
  Panel.Presets,
];

export const DEFAULT_PANEL_DEFAULT_REGIONS: Record<Panel, PanelRegion> = {
  [Panel.Metadata]: 'leftTop',
  [Panel.FolderTree]: 'leftTop',
  [Panel.Export]: 'leftTop',
  [Panel.Tethering]: 'leftTop',
  [Panel.Adjustments]: 'rightTop',
  [Panel.Crop]: 'rightTop',
  [Panel.Masks]: 'rightTop',
  [Panel.Ai]: 'rightTop',
  [Panel.Presets]: 'rightTop',
};

export const DEFAULT_PANEL_WIDTH = 350;
export const DEFAULT_PANEL_SECTION_HEIGHT = 450;
export const DEFAULT_BOTTOM_PANEL_HEIGHT = 144;

export function reconcileWorkspace(
  savedWorkspace: WorkspaceState | undefined,
  isTetheringSupported: boolean,
): WorkspaceState {
  const allowedPanels = new Set(ALL_PANELS.filter((p) => p !== Panel.Tethering || isTetheringSupported));

  const defaultWorkspace: WorkspaceState = {
    leftPanelWidth: DEFAULT_PANEL_WIDTH,
    rightPanelWidth: DEFAULT_PANEL_WIDTH,
    leftTopHeight: DEFAULT_PANEL_SECTION_HEIGHT,
    rightTopHeight: DEFAULT_PANEL_SECTION_HEIGHT,
    panelLayout: {
      leftTop: [Panel.Metadata, Panel.FolderTree, Panel.Export, ...(isTetheringSupported ? [Panel.Tethering] : [])],
      leftBottom: [],
      rightTop: [Panel.Adjustments, Panel.Crop, Panel.Masks, Panel.Ai, Panel.Presets],
      rightBottom: [],
    },
    activePanels: {
      leftTop: Panel.FolderTree,
      leftBottom: null,
      rightTop: Panel.Adjustments,
      rightBottom: null,
    },
    panelSwitcherPlacement: {
      leftTop: 'bottom',
      leftBottom: 'bottom',
      rightTop: 'right',
      rightBottom: 'right',
    },
  };

  if (!savedWorkspace || !savedWorkspace.panelLayout) {
    return defaultWorkspace;
  }

  const seenPanels = new Set<Panel>();
  const sanitizedLayout: Record<PanelRegion, Panel[]> = {
    leftTop: [],
    leftBottom: [],
    rightTop: [],
    rightBottom: [],
  };

  (['leftTop', 'leftBottom', 'rightTop', 'rightBottom'] as PanelRegion[]).forEach((region) => {
    const list = savedWorkspace.panelLayout[region] || [];
    list.forEach((panel) => {
      if (allowedPanels.has(panel) && !seenPanels.has(panel)) {
        sanitizedLayout[region].push(panel);
        seenPanels.add(panel);
      }
    });
  });

  allowedPanels.forEach((panel) => {
    if (!seenPanels.has(panel)) {
      const targetRegion = DEFAULT_PANEL_DEFAULT_REGIONS[panel] || 'leftTop';
      sanitizedLayout[targetRegion].push(panel);
      seenPanels.add(panel);
    }
  });

  const sanitizedActive: Record<PanelRegion, Panel | null> = {
    leftTop: null,
    leftBottom: null,
    rightTop: null,
    rightBottom: null,
  };

  (['leftTop', 'leftBottom', 'rightTop', 'rightBottom'] as PanelRegion[]).forEach((region) => {
    const currentActive = savedWorkspace.activePanels?.[region];
    if (currentActive && sanitizedLayout[region].includes(currentActive)) {
      sanitizedActive[region] = currentActive;
    } else {
      sanitizedActive[region] = sanitizedLayout[region].length > 0 ? sanitizedLayout[region][0] : null;
    }
  });

  return {
    leftPanelWidth: savedWorkspace.leftPanelWidth || defaultWorkspace.leftPanelWidth,
    rightPanelWidth: savedWorkspace.rightPanelWidth || defaultWorkspace.rightPanelWidth,
    leftTopHeight: savedWorkspace.leftTopHeight || defaultWorkspace.leftTopHeight,
    rightTopHeight: savedWorkspace.rightTopHeight || defaultWorkspace.rightTopHeight,
    panelLayout: sanitizedLayout,
    activePanels: sanitizedActive,
    panelSwitcherPlacement: {
      ...defaultWorkspace.panelSwitcherPlacement,
      ...(savedWorkspace.panelSwitcherPlacement || {}),
    },
  };
}

interface UIState {
  activeView: string;
  isFullScreen: boolean;
  isWindowFullScreen: boolean;
  isInstantTransition: boolean;
  isLayoutReady: boolean;
  uiVisibility: UiVisibility;
  isLibraryExportPanelVisible: boolean;
  isSettingsOpen: boolean;

  leftPanelWidth: number;
  rightPanelWidth: number;
  bottomPanelHeight: number;
  leftTopHeight: number;
  rightTopHeight: number;
  compactEditorPanelHeightOverride: number | null;

  panelLayout: Record<PanelRegion, Panel[]>;
  activePanels: Record<PanelRegion, Panel | null>;
  activeLayoutDragItem: Panel | null;
  setLayoutDragItem: (panel: Panel | null) => void;
  movePanel: (panel: Panel, toRegion: PanelRegion) => void;
  movePanelToIndex: (panel: Panel, toRegion: PanelRegion, index: number) => void;
  setActivePanel: (region: PanelRegion, panel: Panel | null) => void;

  panelSwitcherPlacement: Record<PanelRegion, SwitcherPlacement>;
  setPanelSwitcherPlacement: (region: PanelRegion, placement: SwitcherPlacement) => void;

  activePanel: Panel | null;
  renderedPanel: Panel | null;
  slideDirection: number;
  collapsibleSectionsState: CollapsibleSectionsState;

  isCreateFolderModalOpen: boolean;
  isRenameFolderModalOpen: boolean;
  isRenameFileModalOpen: boolean;
  renameTargetPaths: Array<string>;
  isImportModalOpen: boolean;
  isCopyPasteSettingsModalOpen: boolean;
  importTargetFolder: string | null;
  importSourcePaths: Array<string>;
  folderActionTarget: string | null;

  isCreateAlbumModalOpen: boolean;
  isCreateAlbumGroupModalOpen: boolean;
  isRenameAlbumModalOpen: boolean;
  albumActionTarget: string | null;

  confirmModalState: ConfirmModalState;
  panoramaModalState: PanoramaModalState;
  focusStackModalState: FocusStackModalState;
  hdrModalState: HdrModalState;
  negativeModalState: NegativeConversionModalState;
  denoiseModalState: DenoiseModalState;
  cullingModalState: CullingModalState;
  collageModalState: CollageModalState;

  setUI: (updater: Partial<UIState> | ((state: UIState) => Partial<UIState>)) => void;
  setPanel: (panel: Panel | null) => void;
  customEscapeHandler: (() => void) | null;
  setCustomEscapeHandler: (handler: (() => void) | null) => void;
  searchFocusRequest: number;
  requestSearchFocus: () => void;
  resetWorkspaceLayout: (isTetheringSupported?: boolean) => WorkspaceState;
}

export const useUIStore = create<UIState>((set, get) => ({
  activeView: 'library',
  isFullScreen: false,
  isWindowFullScreen: false,
  isInstantTransition: false,
  isLayoutReady: false,
  uiVisibility: { filmstrip: true, leftPanel: true, rightPanel: true },
  isLibraryExportPanelVisible: false,
  isSettingsOpen: false,

  leftPanelWidth: DEFAULT_PANEL_WIDTH,
  rightPanelWidth: DEFAULT_PANEL_WIDTH,
  bottomPanelHeight: DEFAULT_BOTTOM_PANEL_HEIGHT,
  leftTopHeight: DEFAULT_PANEL_SECTION_HEIGHT,
  rightTopHeight: DEFAULT_PANEL_SECTION_HEIGHT,
  compactEditorPanelHeightOverride: null,

  panelLayout: {
    leftTop: [Panel.Metadata, Panel.FolderTree, Panel.Export],
    leftBottom: [],
    rightTop: [Panel.Adjustments, Panel.Crop, Panel.Masks, Panel.Ai, Panel.Presets],
    rightBottom: [],
  },
  activePanels: {
    leftTop: Panel.FolderTree,
    leftBottom: null,
    rightTop: Panel.Adjustments,
    rightBottom: null,
  },
  activeLayoutDragItem: null,

  panelSwitcherPlacement: {
    leftTop: 'bottom',
    leftBottom: 'bottom',
    rightTop: 'right',
    rightBottom: 'right',
  },
  setPanelSwitcherPlacement: (region, placement) =>
    set((state) => ({
      panelSwitcherPlacement: { ...state.panelSwitcherPlacement, [region]: placement },
    })),

  activePanel: Panel.Adjustments,
  renderedPanel: Panel.Adjustments,
  slideDirection: 1,
  collapsibleSectionsState: { basic: true, color: false, curves: true, details: false, effects: false },

  isCreateFolderModalOpen: false,
  isRenameFolderModalOpen: false,
  isRenameFileModalOpen: false,
  renameTargetPaths: [],
  isImportModalOpen: false,
  isCopyPasteSettingsModalOpen: false,
  importTargetFolder: null,
  importSourcePaths: [],
  folderActionTarget: null,
  isCreateAlbumModalOpen: false,
  isCreateAlbumGroupModalOpen: false,
  isRenameAlbumModalOpen: false,
  albumActionTarget: null,

  confirmModalState: { isOpen: false },
  panoramaModalState: {
    error: null,
    finalImageBase64: null,
    isOpen: false,
    isProcessing: false,
    progressMessage: '',
    stitchingSourcePaths: [],
  },
  focusStackModalState: {
    error: null,
    finalImageBase64: null,
    depthMapBase64: null,
    isOpen: false,
    isProcessing: false,
    progressMessage: '',
    sourcePaths: [],
  },
  hdrModalState: {
    error: null,
    finalImageBase64: null,
    isOpen: false,
    isProcessing: false,
    progressMessage: '',
    stitchingSourcePaths: [],
  },
  negativeModalState: { isOpen: false, targetPaths: [] },
  denoiseModalState: {
    isOpen: false,
    isProcessing: false,
    previewBase64: null,
    error: null,
    targetPaths: [],
    progressMessage: null,
    isRaw: false,
  },
  cullingModalState: { isOpen: false, suggestions: null, progress: null, error: null, pathsToCull: [] },
  collageModalState: { isOpen: false, sourceImages: [] },

  setUI: (updater) => set((state) => (typeof updater === 'function' ? updater(state) : updater)),

  setLayoutDragItem: (panel) => set({ activeLayoutDragItem: panel }),

  movePanel: (panel, toRegion) =>
    set((state) => {
      const layout = {
        leftTop: [...state.panelLayout.leftTop],
        leftBottom: [...state.panelLayout.leftBottom],
        rightTop: [...state.panelLayout.rightTop],
        rightBottom: [...state.panelLayout.rightBottom],
      };
      const active = { ...state.activePanels };

      let fromRegion: PanelRegion | null = null;
      (Object.keys(layout) as PanelRegion[]).forEach((r) => {
        if (layout[r].includes(panel)) {
          fromRegion = r;
          layout[r] = layout[r].filter((p) => p !== panel);
        }
      });

      if (!layout[toRegion].includes(panel)) layout[toRegion].push(panel);

      if (fromRegion && active[fromRegion] === panel) {
        active[fromRegion] = layout[fromRegion].length > 0 ? layout[fromRegion][0] : null;
      }

      active[toRegion] = panel;

      return {
        panelLayout: layout,
        activePanels: active,
        activeLayoutDragItem: null,
        activePanel: panel,
        renderedPanel: panel,
      };
    }),

  movePanelToIndex: (panel, toRegion, index) =>
    set((state) => {
      const layout = {
        leftTop: [...state.panelLayout.leftTop],
        leftBottom: [...state.panelLayout.leftBottom],
        rightTop: [...state.panelLayout.rightTop],
        rightBottom: [...state.panelLayout.rightBottom],
      };
      const active = { ...state.activePanels };

      let fromRegion: PanelRegion | null = null;
      (Object.keys(layout) as PanelRegion[]).forEach((r) => {
        if (layout[r].includes(panel)) {
          fromRegion = r;
          layout[r] = layout[r].filter((p) => p !== panel);
        }
      });

      const clampedIndex = Math.max(0, Math.min(index, layout[toRegion].length));
      layout[toRegion].splice(clampedIndex, 0, panel);

      if (fromRegion && active[fromRegion] === panel) {
        active[fromRegion] = layout[fromRegion].length > 0 ? layout[fromRegion][0] : null;
      }
      active[toRegion] = panel;

      return {
        panelLayout: layout,
        activePanels: active,
        activeLayoutDragItem: null,
        activePanel: panel,
        renderedPanel: panel,
      };
    }),

  setActivePanel: (region, panel) =>
    set((state) => {
      if (!panel) return state;
      const updates: Partial<UIState> = {
        activePanels: { ...state.activePanels, [region]: panel },
        activePanel: panel,
        renderedPanel: panel,
      };

      const isLeft = region === 'leftTop' || region === 'leftBottom';
      const isRight = region === 'rightTop' || region === 'rightBottom';

      if (isLeft && !state.uiVisibility.leftPanel) {
        updates.uiVisibility = { ...state.uiVisibility, leftPanel: true };
        if (state.leftPanelWidth < DEFAULT_PANEL_WIDTH) {
          updates.leftPanelWidth = DEFAULT_PANEL_WIDTH;
        }
      }

      if (isRight && !state.uiVisibility.rightPanel) {
        updates.uiVisibility = { ...state.uiVisibility, rightPanel: true };
        if (state.rightPanelWidth < DEFAULT_PANEL_WIDTH) {
          updates.rightPanelWidth = DEFAULT_PANEL_WIDTH;
        }
      }

      return updates;
    }),

  setPanel: (panelId) => {
    const state = get();
    if (!panelId) return;

    let targetRegion: PanelRegion | null = null;
    for (const region of Object.keys(state.panelLayout) as PanelRegion[]) {
      if (state.panelLayout[region].includes(panelId)) {
        targetRegion = region;
        break;
      }
    }
    if (targetRegion) state.setActivePanel(targetRegion, panelId);
  },

  resetWorkspaceLayout: (isTetheringSupported = false) => {
    const defaultWorkspace = reconcileWorkspace(undefined, isTetheringSupported);
    set({
      leftPanelWidth: defaultWorkspace.leftPanelWidth,
      rightPanelWidth: defaultWorkspace.rightPanelWidth,
      leftTopHeight: defaultWorkspace.leftTopHeight,
      rightTopHeight: defaultWorkspace.rightTopHeight,
      panelLayout: defaultWorkspace.panelLayout,
      activePanels: defaultWorkspace.activePanels,
      panelSwitcherPlacement: defaultWorkspace.panelSwitcherPlacement,
      uiVisibility: { filmstrip: true, leftPanel: true, rightPanel: true },
      activePanel: defaultWorkspace.activePanels.rightTop || null,
      renderedPanel: defaultWorkspace.activePanels.rightTop || null,
    });
    return defaultWorkspace;
  },

  customEscapeHandler: null,
  setCustomEscapeHandler: (handler) => set({ customEscapeHandler: handler }),
  searchFocusRequest: 0,
  requestSearchFocus: () => set((state) => ({ searchFocusRequest: state.searchFocusRequest + 1 })),
}));
