import { Cubit } from '@blac/core';
import type { ImageFile } from '../../types/library';

interface LibraryState {
  rootPath: string | null;
  currentFolderPath: string | null;
  images: ImageFile[];
  viewMode: 'flat' | 'recursive';
  isLoading: boolean;
  error: string | null;
}

export class LibraryBloc extends Cubit<LibraryState> {
  constructor() {
    super({
      rootPath: null,
      currentFolderPath: null,
      images: [],
      viewMode: 'flat',
      isLoading: false,
      error: null,
    });
  }

  openFolder = async (path: string, isNewRoot = false) => {
    this.patch({ isLoading: true, error: null });

    try {
      // TODO: Wire up with TauriService and other blocs
      // const tauri = borrow(TauriService);
      // const images = await tauri.listImagesInDir(path);

      this.patch({
        currentFolderPath: path,
        rootPath: isNewRoot ? path : this.state.rootPath,
        images: [], // Will be populated by Tauri
        isLoading: false,
      });
    } catch (error) {
      this.patch({
        error: `Failed to load folder: ${error}`,
        isLoading: false,
      });
    }
  };

  setImages = (images: ImageFile[]) => {
    this.patch({ images });
  };

  refresh = async () => {
    if (!this.state.currentFolderPath) return;
    await this.openFolder(this.state.currentFolderPath);
  };

  setViewMode = (mode: 'flat' | 'recursive') => {
    this.patch({ viewMode: mode });
  };

  updateImage = (path: string, updates: Partial<ImageFile>) => {
    this.emit({
      ...this.state,
      images: this.state.images.map((img) =>
        img.path === path ? { ...img, ...updates } : img
      ),
    });
  };

  goHome = () => {
    this.emit({
      rootPath: null,
      currentFolderPath: null,
      images: [],
      viewMode: 'flat',
      isLoading: false,
      error: null,
    });
  };

  get hasFolder(): boolean {
    return this.state.rootPath !== null;
  }

  get imageCount(): number {
    return this.state.images.length;
  }
}
