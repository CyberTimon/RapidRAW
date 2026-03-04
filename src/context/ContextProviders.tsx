import { createContext, PropsWithChildren, useContext, useRef, useState } from 'react';
import { ContextMenuProvider } from './ContextMenuContext';
import { ClerkProvider } from '@clerk/clerk-react';
import { CLERK_PUBLISHABLE_KEY } from '../utils/constants';
import {
  AppSettings,
  BrushSettings,
  FilterCriteria,
  ImageFile,
  LibraryViewMode,
  Panel,
  Progress,
  RawStatus,
  SortCriteria,
  SortDirection,
  SupportedTypes,
  Theme,
  ThumbnailAspectRatio,
  ThumbnailSize,
  UiVisibility,
  WaveformData,
} from '../components/ui/AppProperties';
import { useSelectedImage } from './state/SelectedImageContext';
import { Adjustments, INITIAL_ADJUSTMENTS, MaskContainer } from '../utils/adjustments';
import { ChannelConfig } from '../components/adjustments/Curves';
import { DEFAULT_THEME_ID } from '../utils/themes';
import { ImageDimensions } from '../hooks/useImageRenderSize';
import { OverlayMode } from '../components/panel/right/CropPanel';
import {
  CollageModalState,
  CollapsibleSectionsState,
  ConfirmModalState,
  CullingModalState,
  DenoiseModalState,
  HdrModalState,
  NegativeConversionModalState,
  PanoramaModalState,
  SearchCriteria,
} from '../App';
import { ToolType } from '../components/panel/right/Masks';
import { useHistoryState } from '../hooks/useHistoryState';

export function ContextProviders({ children }: PropsWithChildren) {
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY}>
      <AppStateContextProvider>
        <ContextMenuProvider>{children}</ContextMenuProvider>
      </AppStateContextProvider>
    </ClerkProvider>
  );
}

const AppStateContext = createContext<ReturnType<typeof createAppStateContext> | null>(null);

function AppStateContextProvider({ children }: PropsWithChildren) {
  return <AppStateContext.Provider value={createAppStateContext()}>{children}</AppStateContext.Provider>;
}

export function useAppState() {
  const ctx = useContext(AppStateContext);

  if (!ctx) {
    throw new Error(`${useAppState.name} must be used within a ${AppStateContextProvider.name}`);
  }

  return ctx;
}

function createAppStateContext() {
  const refs = {
    dragIdleTimer: useRef<ReturnType<typeof setTimeout> | null>(null),
    isInitialThemeMount: useRef(true),
    fullResCacheKeyRef: useRef<string | null>(null),
    patchesSentToBackend: useRef<Set<string>>(new Set()),
    transformWrapperRef: useRef<any>(null),
    isProgrammaticZoom: useRef(false),
    isInitialMount: useRef(true),
    preloadedDataRef: useRef<{
      tree?: Promise<any>;
      images?: Promise<ImageFile[]>;
      rootPath?: string;
      currentPath?: string;
    }>({}),
    previewJobIdRef: useRef<number>(0),
    latestRenderedJobIdRef: useRef<number>(0),
  };

  const state = {
    ...useSelectedImage(),
    history: useHistoryState(INITIAL_ADJUSTMENTS),
    ...useContextState<AppSettings>()('appSettings'),
    ...useContextState<string | null>()('rootPath'),
    ...useContextState<string>()('activeView', 'library'),
    ...useContextState<boolean>()('isWindowFullScreen', false),
    ...useContextState<boolean>()('isLayoutReady', false),
    ...useContextState<string>()('currentFolderPath'),
    ...useContextState<Set<string>>()('expandedFolders', new Set()),
    ...useContextState<any>()('folderTree'),
    ...useContextState<any[]>()('pinnedFolderTrees', []),
    ...useContextState<Array<ImageFile>>()('imageList', []),
    ...useContextState<Record<string, number>>()('imageRatings', {}),
    ...useContextState<SortCriteria>()('sortCriteria', { key: 'name', order: SortDirection.Ascending }),
    ...useContextState<FilterCriteria>()('filterCriteria', {
      colors: [],
      rating: 0,
      rawStatus: RawStatus.All,
    }),
    ...useContextState<SupportedTypes | null>()('supportedTypes'),
    ...useContextState<Array<string>>()('multiSelectedPaths', []),
    ...useContextState<string | null>()('libraryActivePath'),
    ...useContextState<Adjustments>()('libraryActiveAdjustments', INITIAL_ADJUSTMENTS),
    ...useContextState<string | null>()('finalPreviewUrl'),
    ...useContextState<string | null>()('uncroppedAdjustedPreviewUrl'),
    ...useContextState<Adjustments>()('adjustments', INITIAL_ADJUSTMENTS),
    ...useContextState<boolean>()('showOriginal', false),
    ...useContextState<boolean>()('isTreeLoading', false),
    ...useContextState<boolean>()('isViewLoading', false),
    ...useContextState<string | null>()('initialFileToOpen'),
    ...useContextState<string | null>()('error'),
    ...useContextState<ChannelConfig | null>()('histogram'),
    ...useContextState<WaveformData | null>()('waveform'),
    ...useContextState<boolean>()('isWaveformVisible', false),
    ...useContextState<UiVisibility>()('uiVisibility', {
      folderTree: true,
      filmstrip: true,
    }),
    ...useContextState<boolean>()('isSliderDragging', false),
    ...useContextState<boolean>()('isFullScreen', false),
    ...useContextState<boolean>()('isHighResNeeded', false),
    ...useContextState<boolean>()('isAnimatingTheme', false),
    ...useContextState<Theme>()('theme', DEFAULT_THEME_ID),
    ...useContextState<any>()('adaptivePalette'),
    ...useContextState<Panel | null>()('activeRightPanel', Panel.Adjustments),
    ...useContextState<number>()('slideDirection', 1),
    ...useContextState<string | null>()('activeMaskContainerId'),
    ...useContextState<string | null>()('activeMaskId'),
    ...useContextState<string | null>()('activeAiPatchContainerId'),
    ...useContextState<string | null>()('activeAiSubMaskId'),
    ...useContextState<number>()('zoom', 1),
    ...useContextState<ImageDimensions>()('displaySize', { width: 0, height: 0 }),
    ...useContextState<ImageDimensions>()('previewSize', { width: 0, height: 0 }),
    ...useContextState<ImageDimensions>()('baseRenderSize', { width: 0, height: 0 }),
    ...useContextState<ImageDimensions>()('originalSize', { width: 0, height: 0 }),
    ...useContextState<boolean>()('isLoadingFullRes', false),
    ...useContextState<boolean>()('isRotationActive', false),
    ...useContextState<OverlayMode>()('overlayMode', 'thirds'),
    ...useContextState<number>()('overlayRotation', 0),
    ...useContextState<string | null>()('transformedOriginalUrl'),
    ...useContextState<number | null>()('initialFitScale'),
    ...useContextState<CollapsibleSectionsState>()('collapsibleSectionsState', {
      basic: true,
      color: false,
      curves: true,
      details: false,
      effects: false,
    }),
    ...useContextState<boolean>()('isLibraryExportPanelVisible', false),
    ...useContextState<LibraryViewMode>()('libraryViewMode', LibraryViewMode.Flat),
    ...useContextState<number>()('leftPanelWidth', 256),
    ...useContextState<number>()('rightPanelWidth', 320),
    ...useContextState<number>()('bottomPanelHeight', 144),
    ...useContextState<string | null>()('activeTreeSection', 'current'),
    ...useContextState<boolean>()('isResizing', false),
    ...useContextState<ThumbnailSize>()('thumbnailSize', ThumbnailSize.Medium),
    ...useContextState<ThumbnailAspectRatio>()('thumbnailAspectRatio', ThumbnailAspectRatio.Cover),
    ...useContextState<Adjustments | null>()('copiedAdjustments', null),
    ...useContextState<boolean>()('isStraightenActive', false),
    ...useContextState<boolean>()('isWbPickerActive', false),
    ...useContextState<Array<string>>()('copiedFilePaths', []),
    ...useContextState<string | null>()('aiModelDownloadStatus'),
    ...useContextState<Adjustments | null>()('copiedSectionAdjustments'),
    ...useContextState<MaskContainer | null>()('copiedMask'),
    ...useContextState<boolean>()('isCopied', false),
    ...useContextState<boolean>()('isPasted', false),
    ...useContextState<boolean>()('isIndexing', false),
    ...useContextState<Progress>()('indexingProgress', { current: 0, total: 0 }),
    ...useContextState<SearchCriteria>()('searchCriteria', {
      tags: [],
      text: '',
      mode: 'OR',
    }),
    ...useContextState<BrushSettings | null>()('brushSettings', {
      size: 50,
      feather: 50,
      tool: ToolType.Brush,
    }),
    ...useContextState<boolean>()('isCreateFolderModalOpen', false),
    ...useContextState<boolean>()('isRenameFolderModalOpen', false),
    ...useContextState<boolean>()('isRenameFileModalOpen', false),
    ...useContextState<Array<string>>()('renameTargetPaths', []),
    ...useContextState<boolean>()('isImportModalOpen', false),
    ...useContextState<boolean>()('isCopyPasteSettingsModalOpen', false),
    ...useContextState<string | null>()('importTargetFolder'),
    ...useContextState<Array<string>>()('importSourcePaths', []),
    ...useContextState<string | null>()('folderActionTarget'),
    ...useContextState<ConfirmModalState>()('confirmModalState', { isOpen: false }),
    ...useContextState<PanoramaModalState>()('panoramaModalState', {
      error: null,
      finalImageBase64: null,
      isOpen: false,
      progressMessage: '',
      stitchingSourcePaths: [],
    }),
    ...useContextState<HdrModalState>()('hdrModalState', {
      error: null,
      finalImageBase64: null,
      isOpen: false,
      progressMessage: '',
      stitchingSourcePaths: [],
    }),
    ...useContextState<NegativeConversionModalState>()('negativeModalState', {
      isOpen: false,
      targetPath: null,
    }),
    ...useContextState<DenoiseModalState>()('denoiseModalState', {
      isOpen: false,
      isProcessing: false,
      previewBase64: null,
      error: null,
      targetPath: null,
      progressMessage: null,
    }),
    ...useContextState<CullingModalState>()('cullingModalState', {
      isOpen: false,
      suggestions: null,
      progress: null,
      error: null,
      pathsToCull: [],
    }),
    ...useContextState<CollageModalState>()('collageModalState', {
      isOpen: false,
      sourceImages: [],
    }),
    ...useContextState<null>()('customEscapeHandler'),
    ...useContextState<boolean>()('isGeneratingAiMask', false),
    ...useContextState<boolean>()('isAIConnectorConnected', false),
    ...useContextState<boolean>()('isGeneratingAi', false),
    ...useContextState<boolean>()('isMaskControlHovered', false),
    ...useContextState<number>()('libraryScrollTop', 0),
    ...useContextState<Record<string, string>>()('thumbnails', {}),
  };

  const dependants = {
    ...useContextState<Panel | null>()('renderedRightPanel', state.activeRightPanel),
    currentFolderPathRef: useRef<string>(state.currentFolderPath),
  };

  return {
    ...refs,
    ...state,
    ...dependants,
  };
}

type ContextStateObj<ValueName extends string, T> = {
  [K in ValueName]: T;
} & {
  [K in `set${Capitalize<ValueName>}`]: React.Dispatch<React.SetStateAction<T>>;
};

function useContextState<T>() {
  function inner<ValueName extends string>(valueName: ValueName, defaultValue: T): ContextStateObj<ValueName, T>;
  function inner<ValueName extends string>(valueName: ValueName): ContextStateObj<ValueName, T | null>;

  function inner<ValueName extends string>(valueName: ValueName, defaultValue?: T) {
    const [value, setter] = useState<T | null>(defaultValue === undefined ? null : defaultValue);

    const setterName = 'set' + valueName.charAt(0).toUpperCase() + valueName.slice(1);

    return { [valueName]: value, [setterName]: setter } as ContextStateObj<ValueName, typeof value>;
  }

  return inner;
}
