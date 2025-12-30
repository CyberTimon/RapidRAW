import { Cubit } from '@blac/core';
import { ImageFile, CullingSuggestions } from '../components/ui/AppProperties';

export interface ConfirmModalState {
  isOpen: boolean;
  title?: string;
  message?: string;
  confirmText?: string;
  confirmVariant?: 'default' | 'destructive';
  onConfirm?: () => void;
}

export interface CreateFolderModalState {
  isOpen: boolean;
  parentPath?: string;
}

export interface RenameFolderModalState {
  isOpen: boolean;
  path?: string;
  currentName?: string;
}

export interface RenameFileModalState {
  isOpen: boolean;
  paths?: string[];
}

export interface ImportModalState {
  isOpen: boolean;
  targetFolder?: string;
  sourcePaths?: string[];
}

export interface PanoramaModalState {
  isOpen: boolean;
  stitchingSourcePaths: string[];
  progressMessage: string | null;
  finalImageBase64: string | null;
  error: string | null;
}

export interface DenoiseModalState {
  isOpen: boolean;
  isProcessing: boolean;
  targetPath: string | null;
  previewBase64: string | null;
  originalBase64: string | null;
  progressMessage: string | null;
  error: string | null;
}

export interface CullingModalState {
  isOpen: boolean;
  pathsToCull: string[];
  suggestions: CullingSuggestions | null;
  progress: { current: number; total: number; stage: string } | null;
  error: string | null;
}

export interface CollageModalState {
  isOpen: boolean;
  sourceImages: ImageFile[];
}

export interface CopyPasteSettingsModalState {
  isOpen: boolean;
}

export interface ModalsState {
  confirm: ConfirmModalState;
  createFolder: CreateFolderModalState;
  renameFolder: RenameFolderModalState;
  renameFile: RenameFileModalState;
  import: ImportModalState;
  panorama: PanoramaModalState;
  denoise: DenoiseModalState;
  culling: CullingModalState;
  collage: CollageModalState;
  copyPasteSettings: CopyPasteSettingsModalState;
}

const defaultModalsState: ModalsState = {
  confirm: {
    isOpen: false,
    title: undefined,
    message: undefined,
    confirmText: undefined,
    confirmVariant: undefined,
    onConfirm: undefined,
  },
  createFolder: {
    isOpen: false,
    parentPath: undefined,
  },
  renameFolder: {
    isOpen: false,
    path: undefined,
    currentName: undefined,
  },
  renameFile: {
    isOpen: false,
    paths: undefined,
  },
  import: {
    isOpen: false,
    targetFolder: undefined,
    sourcePaths: undefined,
  },
  panorama: {
    isOpen: false,
    stitchingSourcePaths: [],
    progressMessage: null,
    finalImageBase64: null,
    error: null,
  },
  denoise: {
    isOpen: false,
    isProcessing: false,
    targetPath: null,
    previewBase64: null,
    originalBase64: null,
    progressMessage: null,
    error: null,
  },
  culling: {
    isOpen: false,
    pathsToCull: [],
    suggestions: null,
    progress: null,
    error: null,
  },
  collage: {
    isOpen: false,
    sourceImages: [],
  },
  copyPasteSettings: {
    isOpen: false,
  },
};

export class ModalsCubit extends Cubit<ModalsState> {
  constructor() {
    super(defaultModalsState);
  }

  // Confirm Modal
  openConfirm = (options: {
    title: string;
    message: string;
    confirmText?: string;
    confirmVariant?: 'default' | 'destructive';
    onConfirm: () => void;
  }) => {
    this.patch({
      confirm: {
        isOpen: true,
        title: options.title,
        message: options.message,
        confirmText: options.confirmText ?? 'Confirm',
        confirmVariant: options.confirmVariant ?? 'default',
        onConfirm: options.onConfirm,
      },
    });
  };

  closeConfirm = () => {
    this.patch({ confirm: { ...defaultModalsState.confirm } });
  };

  // Create Folder Modal
  openCreateFolder = (parentPath: string) => {
    this.patch({ createFolder: { isOpen: true, parentPath } });
  };

  closeCreateFolder = () => {
    this.patch({ createFolder: { ...defaultModalsState.createFolder } });
  };

  // Rename Folder Modal
  openRenameFolder = (path: string, currentName: string) => {
    this.patch({ renameFolder: { isOpen: true, path, currentName } });
  };

  closeRenameFolder = () => {
    this.patch({ renameFolder: { ...defaultModalsState.renameFolder } });
  };

  // Rename File Modal
  openRenameFile = (paths: string[]) => {
    this.patch({ renameFile: { isOpen: true, paths } });
  };

  closeRenameFile = () => {
    this.patch({ renameFile: { ...defaultModalsState.renameFile } });
  };

  // Import Modal
  openImport = (targetFolder: string, sourcePaths: string[]) => {
    this.patch({ import: { isOpen: true, targetFolder, sourcePaths } });
  };

  closeImport = () => {
    this.patch({ import: { ...defaultModalsState.import } });
  };

  // Panorama Modal
  openPanorama = (paths: string[]) => {
    this.patch({
      panorama: {
        isOpen: true,
        stitchingSourcePaths: paths,
        progressMessage: null,
        finalImageBase64: null,
        error: null,
      },
    });
  };

  updatePanoramaProgress = (message: string) => {
    this.update((state) => ({
      ...state,
      panorama: { ...state.panorama, progressMessage: message },
    }));
  };

  setPanoramaResult = (base64: string) => {
    this.update((state) => ({
      ...state,
      panorama: {
        ...state.panorama,
        finalImageBase64: base64,
        progressMessage: null,
      },
    }));
  };

  setPanoramaError = (error: string) => {
    this.update((state) => ({
      ...state,
      panorama: {
        ...state.panorama,
        error,
        progressMessage: null,
      },
    }));
  };

  closePanorama = () => {
    this.patch({ panorama: { ...defaultModalsState.panorama } });
  };

  // Denoise Modal
  openDenoise = (targetPath: string) => {
    this.patch({
      denoise: {
        isOpen: true,
        isProcessing: false,
        targetPath,
        previewBase64: null,
        originalBase64: null,
        progressMessage: null,
        error: null,
      },
    });
  };

  updateDenoiseState = (updates: Partial<DenoiseModalState>) => {
    this.update((state) => ({
      ...state,
      denoise: { ...state.denoise, ...updates },
    }));
  };

  closeDenoise = () => {
    this.patch({ denoise: { ...defaultModalsState.denoise } });
  };

  // Culling Modal
  openCulling = (paths: string[]) => {
    this.patch({
      culling: {
        isOpen: true,
        pathsToCull: paths,
        suggestions: null,
        progress: null,
        error: null,
      },
    });
  };

  updateCullingProgress = (current: number, total: number, stage: string) => {
    this.update((state) => ({
      ...state,
      culling: {
        ...state.culling,
        progress: { current, total, stage },
      },
    }));
  };

  setCullingSuggestions = (suggestions: CullingSuggestions) => {
    this.update((state) => ({
      ...state,
      culling: {
        ...state.culling,
        suggestions,
        progress: null,
      },
    }));
  };

  setCullingError = (error: string) => {
    this.update((state) => ({
      ...state,
      culling: {
        ...state.culling,
        error,
        progress: null,
      },
    }));
  };

  closeCulling = () => {
    this.patch({ culling: { ...defaultModalsState.culling } });
  };

  // Collage Modal
  openCollage = (images: ImageFile[]) => {
    this.patch({ collage: { isOpen: true, sourceImages: images } });
  };

  closeCollage = () => {
    this.patch({ collage: { ...defaultModalsState.collage } });
  };

  // Copy/Paste Settings Modal
  openCopyPasteSettings = () => {
    this.patch({ copyPasteSettings: { isOpen: true } });
  };

  closeCopyPasteSettings = () => {
    this.patch({ copyPasteSettings: { isOpen: false } });
  };

  // Close all modals
  closeAll = () => {
    this.emit(defaultModalsState);
  };
}
