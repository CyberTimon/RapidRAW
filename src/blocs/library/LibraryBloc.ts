import { Blac, Cubit } from '@blac/core';
import type { ImageFile } from '../../types/library';
import { TauriService } from '../services/TauriService';

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
      const tauri = Blac.getBloc(TauriService);
      const images = this.state.viewMode === 'recursive'
        ? await tauri.listImagesRecursive(path)
        : await tauri.listImagesInDir(path);

      this.patch({
        currentFolderPath: path,
        rootPath: isNewRoot ? path : this.state.rootPath,
        images,
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
