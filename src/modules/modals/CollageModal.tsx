import { useState, useEffect, useCallback, useRef, useLayoutEffect, type ReactNode } from 'react';
import { useBloc } from '@blac/react';
import { CheckCircle, XCircle, Loader2, Save, LayoutTemplate, Shuffle, Palette } from 'lucide-react';
import { Modal } from '../../primitives/Modal';
import { Button } from '../../primitives/Button';
import { Slider } from '../../primitives/Slider';
import { ModalBloc } from '../../blocs/app/ModalBloc';
import type { ImageFile } from '../../types/library';

interface LayoutCell {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Layout = LayoutCell[];

interface LayoutDefinition {
  layout: Layout;
}

interface AspectRatioPreset {
  name: string;
  value: number;
}

const ASPECT_RATIO_PRESETS: AspectRatioPreset[] = [
  { name: '1:1', value: 1 },
  { name: '5:4', value: 5 / 4 },
  { name: '4:3', value: 4 / 3 },
  { name: '3:2', value: 3 / 2 },
  { name: '16:9', value: 16 / 9 },
];

const LAYOUTS: Record<number, LayoutDefinition[]> = {
  2: [
    { layout: [{ x: 0, y: 0, width: 0.5, height: 1 }, { x: 0.5, y: 0, width: 0.5, height: 1 }] },
    { layout: [{ x: 0, y: 0, width: 1, height: 0.5 }, { x: 0, y: 0.5, width: 1, height: 0.5 }] },
  ],
  3: [
    { layout: [{ x: 0, y: 0, width: 1/3, height: 1 }, { x: 1/3, y: 0, width: 1/3, height: 1 }, { x: 2/3, y: 0, width: 1/3, height: 1 }] },
    { layout: [{ x: 0, y: 0, width: 0.5, height: 1 }, { x: 0.5, y: 0, width: 0.5, height: 0.5 }, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }] },
  ],
  4: [
    { layout: [{ x: 0, y: 0, width: 0.5, height: 0.5 }, { x: 0.5, y: 0, width: 0.5, height: 0.5 }, { x: 0, y: 0.5, width: 0.5, height: 0.5 }, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }] },
  ],
};

const DEFAULT_EXPORT_WIDTH = 3000;
const INITIAL_SPACING = 10;
const INITIAL_BORDER_RADIUS = 8;

function LayoutIcon({ layout }: { layout: Layout }) {
  return (
    <svg viewBox="0 0 100 100" className="w-full h-full">
      {layout.map((cell, i) => (
        <rect
          key={i}
          x={cell.x * 100}
          y={cell.y * 100}
          width={cell.width * 100}
          height={cell.height * 100}
          fill="white"
          stroke="grey"
          strokeWidth="4"
        />
      ))}
    </svg>
  );
}

export interface CollageModalData {
  sourceImages: ImageFile[];
  thumbnails: Record<string, string>;
  onSave: (base64Data: string, firstPath: string) => Promise<string>;
  onLoadPreview: (path: string) => Promise<{ url: string; width: number; height: number }>;
}

interface LoadedImage {
  path: string;
  url: string;
  width: number;
  height: number;
}

export function CollageModal() {
  const [state, modalBloc] = useBloc(ModalBloc);
  const isOpen = state.openModals.includes('collage');
  const data = state.modalData['collage'] as CollageModalData | undefined;

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);

  const [availableLayouts, setAvailableLayouts] = useState<LayoutDefinition[]>([]);
  const [activeLayout, setActiveLayout] = useState<Layout | null>(null);
  const [activeAspectRatio, setActiveAspectRatio] = useState<AspectRatioPreset>(ASPECT_RATIO_PRESETS[0]);
  const [spacing, setSpacing] = useState(INITIAL_SPACING);
  const [borderRadius, setBorderRadius] = useState(INITIAL_BORDER_RADIUS);
  const [backgroundColor, setBackgroundColor] = useState('#FFFFFF');
  const [exportWidth, setExportWidth] = useState(DEFAULT_EXPORT_WIDTH);
  const [exportHeight, setExportHeight] = useState(DEFAULT_EXPORT_WIDTH);

  const [loadedImages, setLoadedImages] = useState<LoadedImage[]>([]);
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });

  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const imageElementsRef = useRef<Record<string, HTMLImageElement>>({});

  useEffect(() => {
    if (isOpen) {
      setIsLoading(true);
      setError(null);
      setSavedPath(null);
      setActiveLayout(null);
      setActiveAspectRatio(ASPECT_RATIO_PRESETS[0]);
      setBackgroundColor('#FFFFFF');
      setSpacing(INITIAL_SPACING);
      setBorderRadius(INITIAL_BORDER_RADIUS);
      setExportWidth(DEFAULT_EXPORT_WIDTH);
      setExportHeight(DEFAULT_EXPORT_WIDTH);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !data || data.sourceImages.length === 0) return;

    const loadImages = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const imagePromises = data.sourceImages.map(async (imageFile) => {
          const result = await data.onLoadPreview(imageFile.path);
          return { path: imageFile.path, ...result };
        });

        const results = await Promise.all(imagePromises);
        
        results.forEach((img) => {
          const imgEl = new Image();
          imgEl.src = img.url;
          imageElementsRef.current[img.path] = imgEl;
        });

        setLoadedImages(results);
      } catch (err: unknown) {
        console.error('Failed to load images for collage:', err);
        setError(err instanceof Error ? err.message : 'Could not load one or more images.');
      } finally {
        setIsLoading(false);
      }
    };

    const timerId = setTimeout(loadImages, 100);
    return () => clearTimeout(timerId);
  }, [isOpen, data]);

  useEffect(() => {
    if (loadedImages.length > 0) {
      const layoutsForCount = LAYOUTS[loadedImages.length] || [];
      setAvailableLayouts(layoutsForCount);
      if (activeLayout === null && layoutsForCount.length > 0) {
        setActiveLayout(layoutsForCount[0].layout);
      }
    }
  }, [loadedImages, activeLayout]);

  useLayoutEffect(() => {
    const container = previewContainerRef.current;
    if (!container || isLoading) return;

    const updatePreviewSize = () => {
      const containerWidth = container.clientWidth;
      const containerHeight = container.clientHeight;
      if (containerWidth === 0 || containerHeight === 0) return;

      const ratio = activeAspectRatio.value;
      let newWidth, newHeight;
      if (containerWidth / containerHeight > ratio) {
        newHeight = containerHeight;
        newWidth = containerHeight * ratio;
      } else {
        newWidth = containerWidth;
        newHeight = containerWidth / ratio;
      }
      setPreviewSize({ width: newWidth, height: newHeight });
    };

    updatePreviewSize();
    const resizeObserver = new ResizeObserver(updatePreviewSize);
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [activeAspectRatio, isLoading]);

  const drawCanvas = useCallback(
    (canvas: HTMLCanvasElement | null, isExport = false) => {
      if (!canvas || !activeLayout || loadedImages.length === 0 || (previewSize.width === 0 && !isExport)) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      let canvasWidth: number, canvasHeight: number, exportScale = 1;
      const dpr = isExport ? 1 : window.devicePixelRatio || 1;

      if (isExport) {
        canvasWidth = exportWidth;
        canvasHeight = exportHeight;
        if (previewSize.width > 0) {
          exportScale = exportWidth / previewSize.width;
        }
      } else {
        canvasWidth = previewSize.width;
        canvasHeight = previewSize.height;
      }

      canvas.width = canvasWidth * dpr;
      canvas.height = canvasHeight * dpr;
      canvas.style.width = `${canvasWidth}px`;
      canvas.style.height = `${canvasHeight}px`;

      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, canvasWidth, canvasHeight);
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);

      loadedImages.forEach((image, index) => {
        const cell = activeLayout[index];
        if (!cell) return;

        const img = imageElementsRef.current[image.path];
        if (!img) return;

        const scaledSpacing = spacing * exportScale;
        const scaledRadius = borderRadius * exportScale;

        const x1 = cell.x * canvasWidth;
        const y1 = cell.y * canvasHeight;
        const x2 = (cell.x + cell.width) * canvasWidth;
        const y2 = (cell.y + cell.height) * canvasHeight;

        const cellFinalX = x1 + (cell.x === 0 ? scaledSpacing : scaledSpacing / 2);
        const cellFinalY = y1 + (cell.y === 0 ? scaledSpacing : scaledSpacing / 2);
        const cellFinalWidth = x2 - x1 - (cell.x === 0 ? scaledSpacing : scaledSpacing / 2) - (cell.x + cell.width >= 1 ? scaledSpacing : scaledSpacing / 2);
        const cellFinalHeight = y2 - y1 - (cell.y === 0 ? scaledSpacing : scaledSpacing / 2) - (cell.y + cell.height >= 1 ? scaledSpacing : scaledSpacing / 2);

        ctx.save();
        ctx.beginPath();
        ctx.roundRect(cellFinalX, cellFinalY, cellFinalWidth, cellFinalHeight, scaledRadius);
        ctx.clip();

        const imageRatio = img.width / img.height;
        const cellRatio = cellFinalWidth / cellFinalHeight;

        let drawWidth: number, drawHeight: number, drawX: number, drawY: number;
        if (imageRatio > cellRatio) {
          drawHeight = cellFinalHeight;
          drawWidth = drawHeight * imageRatio;
          drawX = cellFinalX - (drawWidth - cellFinalWidth) / 2;
          drawY = cellFinalY;
        } else {
          drawWidth = cellFinalWidth;
          drawHeight = drawWidth / imageRatio;
          drawX = cellFinalX;
          drawY = cellFinalY - (drawHeight - cellFinalHeight) / 2;
        }

        ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
        ctx.restore();
      });
    },
    [activeLayout, loadedImages, spacing, borderRadius, previewSize, exportWidth, exportHeight, backgroundColor]
  );

  useEffect(() => {
    drawCanvas(previewCanvasRef.current);
  }, [drawCanvas]);

  const handleClose = () => modalBloc.close('collage');

  const handleAspectRatioChange = (preset: AspectRatioPreset) => {
    setActiveAspectRatio(preset);
    setExportHeight(Math.round(exportWidth / preset.value));
  };

  const handleShuffleImages = () => {
    setLoadedImages((prevImages) => {
      const shuffled = [...prevImages];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return shuffled;
    });
  };

  const handleSave = async () => {
    if (isSaving || !activeLayout || !data) return;
    setIsSaving(true);
    setError(null);
    try {
      const offscreenCanvas = document.createElement('canvas');
      drawCanvas(offscreenCanvas, true);
      const base64Data = offscreenCanvas.toDataURL('image/png');
      const path = await data.onSave(base64Data, data.sourceImages[0].path);
      setSavedPath(path);
    } catch (err: unknown) {
      console.error('Failed to save collage:', err);
      setError(err instanceof Error ? err.message : 'Could not save the collage.');
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen || !data) return null;

  const renderControls = () => (
    <div className="w-72 flex-shrink-0 bg-bg-secondary p-4 flex flex-col gap-4 overflow-y-auto border-l border-surface">
      <div>
        <h4 className="text-sm font-semibold mb-3 flex items-center justify-between">
          <span className="flex items-center gap-2"><LayoutTemplate size={16} /> Layout</span>
          {availableLayouts.length > 0 && (
            <button onClick={handleShuffleImages} title="Shuffle Images" className="p-1.5 rounded-md hover:bg-surface">
              <Shuffle size={16} />
            </button>
          )}
        </h4>
        <div className="grid grid-cols-3 gap-2">
          {availableLayouts.length > 0 ? (
            availableLayouts.map((item, index) => (
              <button
                key={index}
                onClick={() => setActiveLayout(item.layout)}
                className={`p-2 rounded-md bg-surface hover:bg-bg-tertiary ${item.layout === activeLayout ? 'ring-2 ring-accent' : ''}`}
              >
                <div className="w-full h-8"><LayoutIcon layout={item.layout} /></div>
              </button>
            ))
          ) : (
            <p className="text-xs text-text-tertiary col-span-3">No layouts for {data.sourceImages.length} images.</p>
          )}
        </div>
      </div>

      <div>
        <h4 className="text-sm font-semibold mb-3">Aspect Ratio</h4>
        <div className="grid grid-cols-3 gap-2">
          {ASPECT_RATIO_PRESETS.map((preset) => (
            <button
              key={preset.name}
              onClick={() => handleAspectRatioChange(preset)}
              className={`px-2 py-1.5 text-sm rounded-md ${
                activeAspectRatio.name === preset.name ? 'bg-accent text-button-text' : 'bg-surface hover:bg-bg-tertiary'
              }`}
            >
              {preset.name}
            </button>
          ))}
        </div>
      </div>

      <Slider label="Spacing" min={0} max={50} step={1} value={spacing} onChange={(v) => setSpacing(v)} />
      <Slider label="Border Radius" min={0} max={50} step={1} value={borderRadius} onChange={(v) => setBorderRadius(v)} />

      <div>
        <h4 className="text-sm font-semibold mb-3 flex items-center gap-2"><Palette size={16} /> Background</h4>
        <div className="flex items-center gap-2 bg-surface p-2 rounded-md">
          <input
            type="color"
            value={backgroundColor}
            onChange={(e) => setBackgroundColor(e.target.value)}
            className="w-8 h-8 p-0 border-none rounded cursor-pointer bg-transparent"
          />
          <input
            type="text"
            value={backgroundColor}
            onChange={(e) => setBackgroundColor(e.target.value)}
            className="w-full bg-bg-primary text-center rounded-md p-1 border border-surface focus:border-accent"
          />
        </div>
      </div>
    </div>
  );

  const renderContent = () => {
    if (savedPath) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-center">
          <CheckCircle className="w-16 h-16 text-green-500 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-text-primary mb-2">Collage Saved!</h3>
          <p className="text-sm text-text-secondary max-w-xs">Your collage has been saved successfully.</p>
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-center">
          <XCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-text-primary mb-2">An Error Occurred</h3>
          <p className="text-sm text-text-secondary max-w-xs">{error}</p>
        </div>
      );
    }

    return (
      <div className="flex flex-row h-full w-full">
        <div ref={previewContainerRef} className="flex-grow h-full flex items-center justify-center bg-bg-secondary p-4 relative min-w-0">
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/20 z-10">
              <Loader2 className="w-12 h-12 text-accent animate-spin" />
            </div>
          )}
          <canvas ref={previewCanvasRef} className="shadow-lg cursor-grab" />
        </div>
        {renderControls()}
      </div>
    );
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Create Collage" size="xl">
      <div className="h-[70vh]">{renderContent()}</div>
      <div className="flex justify-end gap-3 mt-4 pt-4 border-t border-surface">
        {savedPath || error ? (
          <Button onClick={handleClose}>{savedPath ? 'Done' : 'Close'}</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={handleClose}>Cancel</Button>
            <Button onClick={handleSave} disabled={isSaving || isLoading || !activeLayout}>
              {isSaving ? <Loader2 className="animate-spin mr-2" size={16} /> : <Save size={16} className="mr-2" />}
              {isSaving ? 'Saving...' : 'Save Collage'}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}
