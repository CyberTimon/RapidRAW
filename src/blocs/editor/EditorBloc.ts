import { Cubit, borrow } from '@blac/core';
import type { SelectedImage, LoadImageResult } from '../../types/editor.js';
import type { ExifData } from '../../types/library.js';
import { TauriService } from '../services/TauriService';

interface EditorState {
  selectedImage: SelectedImage | null;
  isLoading: boolean;
  error: string | null;
  showOriginal: boolean;
  compareMode: 'none' | 'split' | 'side-by-side';
  splitPosition: number;
}

export class EditorBloc extends Cubit<EditorState> {
  constructor() {
    super({
      selectedImage: null,
      isLoading: false,
      error: null,
      showOriginal: false,
      compareMode: 'none',
      splitPosition: 50,
    });
  }

  loadImage = async (path: string) => {
    this.patch({ isLoading: true, error: null });

    try {
      const tauri = borrow(TauriService);
      const result: LoadImageResult = await tauri.loadImage(path);

      const selectedImage: SelectedImage = {
        path,
        width: result.width,
        height: result.height,
        isRaw: result.is_raw,
        isReady: false,
        exif: result.exif,
        metadata: result.metadata,
      };

      this.patch({
        selectedImage,
        isLoading: false,
      });
    } catch (error) {
      this.patch({
        error: `Failed to load image: ${error}`,
        isLoading: false,
      });
    }
  };

  setImageReady = (originalUrl?: string) => {
    if (!this.state.selectedImage) return;

    this.patch({
      selectedImage: {
        ...this.state.selectedImage,
        isReady: true,
        originalUrl,
      },
    });
  };

  setThumbnailUrl = (thumbnailUrl: string) => {
    if (!this.state.selectedImage) return;

    this.patch({
      selectedImage: {
        ...this.state.selectedImage,
        thumbnailUrl,
      },
    });
  };

  updateExif = (exif: ExifData) => {
    if (!this.state.selectedImage) return;

    this.patch({
      selectedImage: {
        ...this.state.selectedImage,
        exif,
      },
    });
  };

  toggleShowOriginal = () => {
    this.patch({ showOriginal: !this.state.showOriginal });
  };

  setShowOriginal = (show: boolean) => {
    this.patch({ showOriginal: show });
  };

  setCompareMode = (mode: 'none' | 'split' | 'side-by-side') => {
    this.patch({ compareMode: mode });
  };

  setSplitPosition = (position: number) => {
    this.patch({ splitPosition: Math.max(0, Math.min(100, position)) });
  };

  closeImage = () => {
    this.emit({
      selectedImage: null,
      isLoading: false,
      error: null,
      showOriginal: false,
      compareMode: 'none',
      splitPosition: 50,
    });
  };

  clearError = () => {
    this.patch({ error: null });
  };

  get hasImage(): boolean {
    return this.state.selectedImage !== null;
  }

  get isReady(): boolean {
    return this.state.selectedImage?.isReady ?? false;
  }

  get imagePath(): string | null {
    return this.state.selectedImage?.path ?? null;
  }

  get imageSize(): { width: number; height: number } | null {
    if (!this.state.selectedImage) return null;
    return {
      width: this.state.selectedImage.width,
      height: this.state.selectedImage.height,
    };
  }
}
