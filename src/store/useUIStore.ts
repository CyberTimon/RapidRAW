import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import i18n from 'i18next';
import { toast } from 'react-toastify';
import { Invokes } from '../types/invokes';
import { ImageFile, CullingSuggestions } from '../types/library';
import { Panel, UiVisibility, PanelRegion, CollapsibleSectionsState } from '../types/ui';
import { WorkspaceState } from '../types/settings';
import { useEditorStore } from './useEditorStore';
import { pickCropGeometry } from '../utils/adjustments';

export type SwitcherPlacement = 'bottom' | 'right' | 'left' | 'top';

export interface CropSectionsState {
  transform: boolean;
  lens: boolean;
}

interface ConfirmModalState {
  confirmText?: string;
  confirmVariant?: string;
  isOpen: boolean;
  message?: string;
  onConfirm?(): void;
  title?: string;
}

interface CollageModalState {
  isOpen: boolean;
  sourceImages: Array<Pick<ImageFile, 'path'>>;
}

interface PanoramaModalState {
  error: string | null;
  finalImageBase64: string | null;
  isOpen: boolean;
  isProcessing: boolean;
  progressMessage: string | null;
  stitchingSourcePaths: Array<string>;
}

interface FocusStackModalState {
  error: string | null;
  finalImageBase64: string | null;
  depthMapBase64: string | null;
  isOpen: boolean;
  isProcessing: boolean;
  progressMessage: string | null;
  sourcePaths: Array<string>;
}

interface HdrModalState {
  error: string | null;
  finalImageBase64: string | null;
  isOpen: boolean;
  isProcessing: boolean;
  progressMessage: string | null;
  stitchingSourcePaths: Array<string>;
}

interface CullingModalState {
  isOpen: boolean;
  suggestions: CullingSuggestions | null;
  progress: { current: number; total: number; stage: string } | null;
  error: string | null;
  pathsToCull: Array<string>;
}

const ALL_PANELS: Panel[] = [
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

const PANEL_REGIONS: PanelRegion[] = ['leftTop', 'leftBottom', 'rightTop', 'rightBottom'];

const SIBLING_REGION: Record<PanelRegion, PanelRegion> = {
  leftTop: 'leftBottom',
  leftBottom: 'leftTop',
  rightTop: 'rightBottom',
  rightBottom: 'rightTop',
};

const DEFAULT_PANEL_DEFAULT_REGIONS: Partial<Record<Panel, PanelRegion>> = {
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
export const DEFAULT_FILMSTRIP_COLUMNS = 2;
export const MAX_FILMSTRIP_COLUMNS = 6;
const MIN_REOPENED_PANEL_WIDTH = 250;

export const getReopenedPanelWidth = (width: number) =>
  width < MIN_REOPENED_PANEL_WIDTH ? DEFAULT_PANEL_WIDTH : width;

export function reconcileWorkspace(
  savedWorkspace: WorkspaceState | undefined,
  isTetheringSupported: boolean,
): WorkspaceState {
  const defaultPlacedPanels = ALL_PANELS.filter((p) => p !== Panel.Tethering || isTetheringSupported);
  const allowedPanels = new Set([...defaultPlacedPanels, Panel.Filmstrip]);

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
    filmstripColumns: DEFAULT_FILMSTRIP_COLUMNS,
    filmstripShowFileInfo: false,
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

  PANEL_REGIONS.forEach((region) => {
    const list = savedWorkspace.panelLayout[region] || [];
    list.forEach((panel) => {
      if (allowedPanels.has(panel) && !seenPanels.has(panel)) {
        sanitizedLayout[region].push(panel);
        seenPanels.add(panel);
      }
    });
  });

  defaultPlacedPanels.forEach((panel) => {
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

  PANEL_REGIONS.forEach((region) => {
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
    filmstripColumns: Math.min(
      MAX_FILMSTRIP_COLUMNS,
      Math.max(1, savedWorkspace.filmstripColumns || DEFAULT_FILMSTRIP_COLUMNS),
    ),
    filmstripShowFileInfo: savedWorkspace.filmstripShowFileInfo ?? false,
  };
}

export const isPanelVisible = (state: UIState, panel: Panel) =>
  (Object.keys(state.activePanels) as PanelRegion[]).some(
    (region) =>
      state.activePanels[region] === panel &&
      state.uiVisibility[region.startsWith('left') ? 'leftPanel' : 'rightPanel'],
  );

export const isFilmstripDocked = (state: UIState) =>
  PANEL_REGIONS.some((region) => state.panelLayout[region].includes(Panel.Filmstrip));

export const isPanelAvailable = (state: UIState, panel: Panel) =>
  panel !== Panel.Filmstrip || state.activeView === 'editor';

export const getRegionActivePanel = (state: UIState, region: PanelRegion) => {
  const panels = state.panelLayout[region];
  const active = state.activePanels[region];
  const index = active ? panels.indexOf(active) : -1;
  if (active && index >= 0 && isPanelAvailable(state, active)) return active;
  const candidates = index < 0 ? panels : [...panels.slice(index + 1), ...panels.slice(0, index).reverse()];
  return candidates.find((panel) => isPanelAvailable(state, panel)) ?? null;
};

const removePanelFromLayout = (state: UIState, panel: Panel) => {
  const layout = Object.fromEntries(
    PANEL_REGIONS.map((region) => [region, state.panelLayout[region].filter((p) => p !== panel)]),
  ) as Record<PanelRegion, Panel[]>;
  const active = { ...state.activePanels };
  const fromRegion = PANEL_REGIONS.find((region) => state.panelLayout[region].includes(panel));
  let revealedPanel: Panel | null = null;
  if (fromRegion && active[fromRegion] === panel) {
    const original = state.panelLayout[fromRegion];
    const index = original.indexOf(panel);
    revealedPanel = original[index + 1] ?? original[index - 1] ?? null;
    active[fromRegion] = revealedPanel;
  }
  return { layout, active, fromRegion, revealedPanel };
};

const resolveGlobalPanel = (current: Panel | null, displaced: Panel | null, panel: Panel) => {
  if (panel !== Panel.Filmstrip) return panel;
  return displaced === current ? null : current;
};

interface PlacePanelOptions {
  index?: number;
  split?: boolean;
  placement?: SwitcherPlacement | null;
}

const placePanel = (
  state: UIState,
  panel: Panel,
  region: PanelRegion,
  { index = Number.MAX_SAFE_INTEGER, split = false, placement = null }: PlacePanelOptions,
) => {
  const { layout, active, fromRegion, revealedPanel } = removePanelFromLayout(state, panel);
  const placements = { ...state.panelSwitcherPlacement };

  const sibling = SIBLING_REGION[region];
  if (split && layout[region].length > 0 && layout[sibling].length === 0) {
    [layout[region], layout[sibling]] = [layout[sibling], layout[region]];
    [active[region], active[sibling]] = [active[sibling], active[region]];
    [placements[region], placements[sibling]] = [placements[sibling], placements[region]];
  }

  const displacedPanel = active[region];
  layout[region].splice(Math.max(0, Math.min(index, layout[region].length)), 0, panel);
  active[region] = panel;
  if (placement) placements[region] = placement;

  const globalPanel =
    resolveGlobalPanel(state.activePanel, displacedPanel, panel) ?? (fromRegion !== region ? revealedPanel : null);
  return {
    panelLayout: layout,
    activePanels: active,
    panelSwitcherPlacement: placements,
    activeLayoutDragItem: null,
    activePanel: globalPanel,
    renderedPanel: globalPanel,
  };
};

export interface UIState {
  activeView: string;
  isFullScreen: boolean;
  isWindowFullScreen: boolean;
  isViewerOpen: boolean;
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
  filmstripColumns: number;
  filmstripShowFileInfo: boolean;
  compactEditorPanelHeightOverride: number | null;

  panelLayout: Record<PanelRegion, Panel[]>;
  activePanels: Record<PanelRegion, Panel | null>;
  activeLayoutDragItem: Panel | null;
  setLayoutDragItem: (panel: Panel | null) => void;
  dropPanel: (
    panel: Panel,
    target: { region: PanelRegion; split: boolean; placement: SwitcherPlacement | null },
  ) => void;
  movePanelToIndex: (panel: Panel, toRegion: PanelRegion, index: number) => void;
  dockFilmstripToBottom: () => void;
  setActivePanel: (region: PanelRegion, panel: Panel | null) => void;

  panelSwitcherPlacement: Record<PanelRegion, SwitcherPlacement>;

  activePanel: Panel | null;
  renderedPanel: Panel | null;
  slideDirection: number;
  collapsibleSectionsState: CollapsibleSectionsState;
  isColorGradingExpanded: boolean;
  isColorMixerExpanded: boolean;
  cropSectionsState: CropSectionsState;

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
  cullingModalState: CullingModalState;
  collageModalState: CollageModalState;

  setUI: (updater: Partial<UIState> | ((state: UIState) => Partial<UIState>)) => void;
  setPanel: (panel: Panel | null) => void;
  customEscapeHandler: (() => void) | null;
  setCustomEscapeHandler: (handler: (() => void) | null) => void;
  imageSelectHandler: ((path: string, openInEditor?: boolean) => void) | null;
  setImageSelectHandler: (handler: ((path: string, openInEditor?: boolean) => void) | null) => void;
  searchFocusRequest: number;
  requestSearchFocus: () => void;
  toggleFullScreen: () => void;
  toggleViewerWindow: () => void;
  resetWorkspaceLayout: (isTetheringSupported?: boolean) => WorkspaceState;
}

export const useUIStore = create<UIState>((set, get) => ({
  activeView: 'library',
  isFullScreen: false,
  isWindowFullScreen: false,
  isViewerOpen: false,
  isInstantTransition: false,
  isLayoutReady: false,
  uiVisibility: { filmstrip: true, leftPanel: true, rightPanel: true, quickFilter: false },
  isLibraryExportPanelVisible: false,
  isSettingsOpen: false,

  leftPanelWidth: DEFAULT_PANEL_WIDTH,
  rightPanelWidth: DEFAULT_PANEL_WIDTH,
  bottomPanelHeight: DEFAULT_BOTTOM_PANEL_HEIGHT,
  leftTopHeight: DEFAULT_PANEL_SECTION_HEIGHT,
  rightTopHeight: DEFAULT_PANEL_SECTION_HEIGHT,
  filmstripColumns: DEFAULT_FILMSTRIP_COLUMNS,
  filmstripShowFileInfo: false,
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

  activePanel: Panel.Adjustments,
  renderedPanel: Panel.Adjustments,
  slideDirection: 1,
  collapsibleSectionsState: { basic: true, color: false, curves: true, details: false, effects: false },
  isColorGradingExpanded: false,
  isColorMixerExpanded: false,
  cropSectionsState: { transform: false, lens: false },

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
  cullingModalState: { isOpen: false, suggestions: null, progress: null, error: null, pathsToCull: [] },
  collageModalState: { isOpen: false, sourceImages: [] },

  setUI: (updater) => set((state) => (typeof updater === 'function' ? updater(state) : updater)),

  setLayoutDragItem: (panel) => set({ activeLayoutDragItem: panel }),

  dropPanel: (panel, { region, split, placement }) =>
    set((state) => {
      const currentIndex = state.panelLayout[region].indexOf(panel);
      return placePanel(state, panel, region, {
        index: !split && currentIndex >= 0 ? currentIndex : undefined,
        split,
        placement,
      });
    }),

  movePanelToIndex: (panel, toRegion, index) => set((state) => placePanel(state, panel, toRegion, { index })),

  dockFilmstripToBottom: () =>
    set((state) => {
      const { layout, active, revealedPanel } = removePanelFromLayout(state, Panel.Filmstrip);
      const globalPanel = state.activePanel ?? revealedPanel;
      return {
        panelLayout: layout,
        activePanels: active,
        activeLayoutDragItem: null,
        activePanel: globalPanel,
        renderedPanel: globalPanel,
        uiVisibility: { ...state.uiVisibility, filmstrip: true },
      };
    }),

  setActivePanel: (region, panel) =>
    set((state) => {
      if (!panel) return state;
      const globalPanel = resolveGlobalPanel(state.activePanel, state.activePanels[region], panel);
      const updates: Partial<UIState> = {
        activePanels: { ...state.activePanels, [region]: panel },
        activePanel: globalPanel,
        renderedPanel: globalPanel,
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

  toggleFullScreen: () => {
    const { isFullScreen } = get();
    const { zoom, selectedImage } = useEditorStore.getState();

    const isNotFitToScreen = Math.abs(zoom - 1) > 0.01;
    set({ isInstantTransition: isNotFitToScreen });

    if (isFullScreen) {
      set({ isFullScreen: false });
    } else {
      if (!selectedImage) return;
      set({ isFullScreen: true });
    }

    if (isNotFitToScreen) {
      setTimeout(() => set({ isInstantTransition: false }), 100);
    }
  },

  toggleViewerWindow: () => {
    if (get().isViewerOpen) {
      set({ isViewerOpen: false });
      invoke(Invokes.CloseViewerWindow).catch(console.error);
      return;
    }
    invoke(Invokes.OpenViewerWindow, { title: i18n.t('editor.viewer.windowTitle') })
      .then(() => set({ isViewerOpen: true }))
      .catch((err) => toast.error(i18n.t('editor.viewer.openFailed', { error: String(err) })));
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
      filmstripColumns: defaultWorkspace.filmstripColumns,
      filmstripShowFileInfo: defaultWorkspace.filmstripShowFileInfo,
      uiVisibility: { filmstrip: true, leftPanel: true, rightPanel: true, quickFilter: false },
      activePanel: defaultWorkspace.activePanels.rightTop || null,
      renderedPanel: defaultWorkspace.activePanels.rightTop || null,
    });
    return defaultWorkspace;
  },

  customEscapeHandler: null,
  setCustomEscapeHandler: (handler) => set({ customEscapeHandler: handler }),
  imageSelectHandler: null,
  setImageSelectHandler: (handler) => set({ imageSelectHandler: handler }),
  searchFocusRequest: 0,
  requestSearchFocus: () => set((state) => ({ searchFocusRequest: state.searchFocusRequest + 1 })),
}));

useUIStore.subscribe((state, prev) => {
  if (state.activePanel === prev.activePanel) return;
  const { selectedImage, adjustments, setEditor } = useEditorStore.getState();
  if (state.activePanel === Panel.Crop) {
    setEditor({
      cropSessionSnapshot: { path: selectedImage?.path ?? null, geometry: pickCropGeometry(adjustments) },
    });
  } else if (prev.activePanel === Panel.Crop) {
    setEditor({ cropSessionSnapshot: null });
  }
});
