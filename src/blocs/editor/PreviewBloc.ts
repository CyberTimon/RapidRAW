import { Cubit } from '@blac/core';
import type { HistogramData, WaveformData } from '../../types/editor.js';

interface PreviewState {
  previewUrl: string | null;
  originalUrl: string | null;
  histogramData: HistogramData | null;
  waveformData: WaveformData | null;
  isGenerating: boolean;
  isHistogramLoading: boolean;
  isWaveformLoading: boolean;
  renderQuality: 'preview' | 'full';
  lastRenderTime: number | null;
  error: string | null;
}

export class PreviewBloc extends Cubit<PreviewState> {
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceMs = 100;

  constructor() {
    super({
      previewUrl: null,
      originalUrl: null,
      histogramData: null,
      waveformData: null,
      isGenerating: false,
      isHistogramLoading: false,
      isWaveformLoading: false,
      renderQuality: 'preview',
      lastRenderTime: null,
      error: null,
    });
  }

  setPreviewUrl = (url: string | null) => {
    this.patch({ previewUrl: url });
  };

  setOriginalUrl = (url: string | null) => {
    this.patch({ originalUrl: url });
  };

  requestPreview = (immediate = false) => {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (immediate) {
      this.generatePreview();
    } else {
      this.debounceTimer = setTimeout(() => {
        this.generatePreview();
        this.debounceTimer = null;
      }, this.debounceMs);
    }
  };

  private generatePreview = async () => {
    this.patch({ isGenerating: true, error: null });

    try {
      // TODO: Wire up with TauriService
      // const tauri = borrow(TauriService);
      // const adjustments = borrow(AdjustmentsBloc).current;
      // const path = borrow(EditorBloc).imagePath;
      // const previewUrl = await tauri.generatePreview(path, adjustments, this.state.renderQuality);

      const startTime = Date.now();

      // Mock preview generation
      await new Promise((resolve) => setTimeout(resolve, 50));

      this.patch({
        isGenerating: false,
        lastRenderTime: Date.now() - startTime,
      });
    } catch (error) {
      this.patch({
        isGenerating: false,
        error: `Preview generation failed: ${error}`,
      });
    }
  };

  requestHistogram = async () => {
    this.patch({ isHistogramLoading: true });

    try {
      // TODO: Wire up with TauriService
      // const tauri = borrow(TauriService);
      // const path = borrow(EditorBloc).imagePath;
      // const adjustments = borrow(AdjustmentsBloc).current;
      // const histogramData = await tauri.generateHistogram(path, adjustments);

      // Mock histogram data
      const mockChannel = {
        data: new Array(256).fill(0).map(() => Math.random() * 100),
        min: 0,
        max: 255,
        mean: 128,
      };

      this.patch({
        histogramData: {
          red: { ...mockChannel },
          green: { ...mockChannel },
          blue: { ...mockChannel },
          luminance: { ...mockChannel },
        },
        isHistogramLoading: false,
      });
    } catch {
      this.patch({ isHistogramLoading: false });
    }
  };

  requestWaveform = async () => {
    this.patch({ isWaveformLoading: true });

    try {
      // TODO: Wire up with TauriService
      // const tauri = borrow(TauriService);
      // const waveformData = await tauri.generateWaveform();

      this.patch({
        waveformData: null, // Will be populated by actual call
        isWaveformLoading: false,
      });
    } catch {
      this.patch({ isWaveformLoading: false });
    }
  };

  setHistogram = (data: HistogramData) => {
    this.patch({ histogramData: data });
  };

  setWaveform = (data: WaveformData) => {
    this.patch({ waveformData: data });
  };

  setRenderQuality = (quality: 'preview' | 'full') => {
    this.patch({ renderQuality: quality });
    this.requestPreview(true);
  };

  setDebounceMs = (ms: number) => {
    this.debounceMs = Math.max(0, ms);
  };

  clearPreview = () => {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.emit({
      previewUrl: null,
      originalUrl: null,
      histogramData: null,
      waveformData: null,
      isGenerating: false,
      isHistogramLoading: false,
      isWaveformLoading: false,
      renderQuality: 'preview',
      lastRenderTime: null,
      error: null,
    });
  };

  clearError = () => {
    this.patch({ error: null });
  };

  get hasPreview(): boolean {
    return this.state.previewUrl !== null;
  }

  get hasHistogram(): boolean {
    return this.state.histogramData !== null;
  }

  get hasWaveform(): boolean {
    return this.state.waveformData !== null;
  }

  get isLoading(): boolean {
    return (
      this.state.isGenerating ||
      this.state.isHistogramLoading ||
      this.state.isWaveformLoading
    );
  }
}
