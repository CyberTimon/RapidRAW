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

      // Mock waveform data - 256x256 grid
      const width = 256;
      const height = 256;
      const size = width * height;

      const generateWaveformChannel = () => {
        const data = new Array(size).fill(0);
        for (let x = 0; x < width; x++) {
          const baseIntensity = Math.sin(x / width * Math.PI) * 200;
          const spread = 30 + Math.random() * 20;
          for (let i = 0; i < 100; i++) {
            const y = Math.floor(height - baseIntensity - (Math.random() - 0.5) * spread * 2);
            if (y >= 0 && y < height) {
              const idx = y * width + x;
              data[idx] = (data[idx] || 0) + Math.random() * 10;
            }
          }
        }
        return data;
      };

      const generateLuma = (r: number[], g: number[], b: number[]) => {
        return r.map((_, i) => r[i] * 0.299 + g[i] * 0.587 + b[i] * 0.114);
      };

      const red = generateWaveformChannel();
      const green = generateWaveformChannel();
      const blue = generateWaveformChannel();
      const luma = generateLuma(red, green, blue);

      this.patch({
        waveformData: { width, height, red, green, blue, luma },
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
