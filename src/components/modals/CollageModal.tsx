import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle, XCircle, Loader2, Save, Crop, Proportions, LayoutTemplate, Shuffle, RectangleHorizontal, RectangleVertical, Palette } from 'lucide-react';
import { ImageFile, Invokes } from '../ui/AppProperties';
import Button from '../ui/Button';
import Slider from '../ui/Slider';
import Switch from '../ui/Switch';
import clsx from 'clsx';
import { LAYOUTS, type Layout, type LayoutDefinition } from '../../utils/CollageVariants';

interface CollageModalProps {
  isOpen: boolean;
  onClose(): void;
  onSave(base64Data: string, firstPath: string): Promise<string>;
  sourceImages: ImageFile[];
  thumbnails: Record<string, string>;
}

interface LoadedImage {
  path: string;
  url: string;
  width: number;
  height: number;
}

interface ImageState {
  offsetX: number;
  offsetY: number;
  scale: number;
}

interface AspectRatioPreset {
  name: string;
  value: number | null;
}

const ASPECT_RATIO_PRESETS: AspectRatioPreset[] = [
  { name: '1:1', value: 1 },
  { name: '5:4', value: 5 / 4 },
  { name: '4:3', value: 4 / 3 },
  { name: '3:2', value: 3 / 2 },
  { name: '16:9', value: 16 / 9 },
];

const DEFAULT_EXPORT_WIDTH = 3000;
const INITIAL_SPACING = 10;
const INITIAL_BORDER_RADIUS = 8;

export default function CollageModal({ isOpen, onClose, onSave, sourceImages }: CollageModalProps) {
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);

  const [availableLayouts, setAvailableLayouts] = useState<LayoutDefinition[]>([]);
  const [activeLayout, setActiveLayout] = useState<Layout | null>(null);
  const [activeAspectRatio, setActiveAspectRatio] = useState<AspectRatioPreset>(ASPECT_RATIO_PRESETS[0]);
  const [keepOriginalRatio, setKeepOriginalRatio] = useState(false);
  
  const [spacing, setSpacing] = useState(INITIAL_SPACING);
  const [borderRadius, setBorderRadius] = useState(INITIAL_BORDER_RADIUS);
  const [backgroundColor, setBackgroundColor] = useState('#FFFFFF');
  const [exportWidth, setExportWidth] = useState(DEFAULT_EXPORT_WIDTH);
  const [exportHeight, setExportHeight] = useState(Math.round(DEFAULT_EXPORT_WIDTH / (ASPECT_RATIO_PRESETS[0].value || 1)));

  const [loadedImages, setLoadedImages] = useState<LoadedImage[]>([]);
  const [imageStates, setImageStates] = useState<Record<string, ImageState>>({});
  
  const [panningImage, setPanningImage] = useState<{ index: number; startX: number; startY: number } | null>(null);
  const [thumbnailDrag, setThumbnailDrag] = useState<{ path: string; url: string; x: number; y: number } | null>(null);
  const [hoveredCellIndex, setHoveredCellIndex] = useState<number | null>(null);
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });

  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const imageElementsRef = useRef<Record<string, HTMLImageElement>>({});

  const resetImageOffsets = useCallback(() => {
    const initialStates: Record<string, ImageState> = {};
    loadedImages.forEach(img => {
      initialStates[img.path] = { offsetX: 0, offsetY: 0, scale: 1 };
    });
    setImageStates(initialStates);
  }, [loadedImages]);

  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      const timer = setTimeout(() => setShow(true), 10);
      return () => clearTimeout(timer);
    } else {
      setShow(false);
      const timer = setTimeout(() => {
        setIsMounted(false);
        setIsLoading(true);
        setIsSaving(false);
        setError(null);
        setSavedPath(null);
        setLoadedImages([]);
        setImageStates({});
        imageElementsRef.current = {};
        setActiveLayout(null);
        setActiveAspectRatio(ASPECT_RATIO_PRESETS[0]);
        setKeepOriginalRatio(false);
        setBackgroundColor('#FFFFFF');
        setSpacing(INITIAL_SPACING);
        setBorderRadius(INITIAL_BORDER_RADIUS);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || sourceImages.length === 0) return;

    const loadImages = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const imagePromises = sourceImages.map(async (imageFile) => {
          const metadata: any = await invoke(Invokes.LoadMetadata, { path: imageFile.path });
          const adjustments = metadata.adjustments && !metadata.adjustments.is_null ? metadata.adjustments : {};
          
          const imageData: Uint8Array = await invoke(Invokes.GeneratePreviewForPath, { path: imageFile.path, jsAdjustments: adjustments });
          const blob = new Blob([imageData], { type: 'image/jpeg' });
          const url = URL.createObjectURL(blob);
          
          return new Promise<LoadedImage>((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
              imageElementsRef.current[imageFile.path] = img;
              resolve({ path: imageFile.path, url, width: img.width, height: img.height });
            };
            img.onerror = () => reject(new Error(`Failed to load image: ${imageFile.path}`));
            img.src = url;
          });
        });

        const results = await Promise.all(imagePromises);
        if (results.length === 1) {
          const img = results[0];
          const ratio = img.width / img.height;
          setActiveAspectRatio({ name: 'Original', value: ratio });
          setExportHeight(Math.round(DEFAULT_EXPORT_WIDTH / ratio));
        }
        setLoadedImages(results);

        const initialStates: Record<string, ImageState> = {};
        results.forEach(img => {
          initialStates[img.path] = { offsetX: 0, offsetY: 0, scale: 1 };
        });
        setImageStates(initialStates);

      } catch (err: any) {
        console.error("Failed to load images:", err);
        setError(err.message || 'Could not load images.');
      } finally {
        setIsLoading(false);
      }
    };

    const timerId = setTimeout(loadImages, 300);
    return () => {
      clearTimeout(timerId);
      Object.values(imageElementsRef.current).forEach(img => URL.revokeObjectURL(img.src));
    };
  }, [isOpen, sourceImages]);

  useEffect(() => {
    if (loadedImages.length > 0) {
      const layoutsForCount = LAYOUTS[loadedImages.length] || [];
      setAvailableLayouts(layoutsForCount);
      if (activeLayout === null) {
        if (layoutsForCount.length > 0) {
            setActiveLayout(layoutsForCount[0].layout);
        } else if (loadedImages.length === 1) {
            setActiveLayout([{ x: 0, y: 0, width: 1, height: 1 }]);
        }
      }
    } else {
      setAvailableLayouts([]);
      setActiveLayout(null);
    }
  }, [loadedImages, activeLayout]);

  useLayoutEffect(() => {
    const container = previewContainerRef.current;
    if (!container) return;

    const updatePreviewSize = () => {
      const containerWidth = container.clientWidth;
      const containerHeight = container.clientHeight;
      if (containerWidth === 0 || containerHeight === 0) return;

      const ratio = activeAspectRatio.value || (16 / 9);
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

    if (!isLoading) updatePreviewSize();
    const resizeObserver = new ResizeObserver(updatePreviewSize);
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [activeAspectRatio, isLoading]);

  const drawCanvas = useCallback((canvas: HTMLCanvasElement | null, isExport: boolean = false) => {
    if (!canvas || !activeLayout || loadedImages.length === 0 || (previewSize.width === 0 && !isExport)) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let canvasWidth, canvasHeight, exportScale = 1;
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
      const cellFinalWidth = (x2 - x1) - (cell.x === 0 ? scaledSpacing : scaledSpacing / 2) - (cell.x + cell.width >= 1 ? scaledSpacing : scaledSpacing / 2);
      const cellFinalHeight = (y2 - y1) - (cell.y === 0 ? scaledSpacing : scaledSpacing / 2) - (cell.y + cell.height >= 1 ? scaledSpacing : scaledSpacing / 2);

      if (cellFinalWidth <= 0 || cellFinalHeight <= 0) return;

      ctx.save();
      ctx.beginPath();
      ctx.roundRect(cellFinalX, cellFinalY, cellFinalWidth, cellFinalHeight, scaledRadius);
      ctx.clip();

      const imageState = imageStates[image.path] || { offsetX: 0, offsetY: 0, scale: 1 };
      const currentScale = imageState.scale || 1;
      const imageRatio = img.width / img.height;
      const cellRatio = cellFinalWidth / cellFinalHeight;

      let drawWidth, drawHeight, drawX, drawY;

      if (keepOriginalRatio) {
        if (imageRatio > cellRatio) {
            drawWidth = cellFinalWidth;
            drawHeight = drawWidth / imageRatio;
            drawX = cellFinalX;
            drawY = cellFinalY + (cellFinalHeight - drawHeight) / 2;
        } else {
            drawHeight = cellFinalHeight;
            drawWidth = drawHeight * imageRatio;
            drawY = cellFinalY;
            drawX = cellFinalX + (cellFinalWidth - drawWidth) / 2;
        }
      } else {
        if (imageRatio > cellRatio) {
          drawHeight = cellFinalHeight * currentScale;
          drawWidth = drawHeight * imageRatio;
          drawX = cellFinalX + imageState.offsetX * exportScale;
          drawY = cellFinalY + imageState.offsetY * exportScale;
        } else {
          drawWidth = cellFinalWidth * currentScale;
          drawHeight = drawWidth / imageRatio;
          drawX = cellFinalX + imageState.offsetX * exportScale;
          drawY = cellFinalY + imageState.offsetY * exportScale;
        }
      }

      ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
      ctx.restore();
    });
  }, [activeLayout, loadedImages, imageStates, spacing, borderRadius, previewSize, exportWidth, exportHeight, backgroundColor, keepOriginalRatio]);

  useEffect(() => {
    drawCanvas(previewCanvasRef.current);
  }, [drawCanvas]);

  const handleAspectRatioChange = (preset: AspectRatioPreset) => {
    setActiveAspectRatio(preset);
    const ratio = preset.value;
    if (ratio) setExportHeight(Math.round(exportWidth / ratio));
    resetImageOffsets();
  };

  const handleOriginalAspectRatio = () => {
    if (loadedImages.length !== 1) return;
    const img = loadedImages[0];
    const ratio = img.width / img.height;
    
    setActiveAspectRatio({ name: 'Original', value: ratio });
    setExportHeight(Math.round(exportWidth / ratio));
    resetImageOffsets();
  };

  const handleOrientationToggle = () => {
    if (activeAspectRatio?.value && activeAspectRatio.value !== 1) {
      const newRatio = 1 / activeAspectRatio.value;
      setActiveAspectRatio(prev => ({ ...prev, value: newRatio }));
      setExportHeight(Math.round(exportWidth / newRatio));
      resetImageOffsets();
    }
  };

  const handleExportDimChange = (e: React.ChangeEvent<HTMLInputElement>, dimension: 'width' | 'height') => {
    const value = parseInt(e.target.value, 10) || 0;
    const ratio = activeAspectRatio.value;
    if (dimension === 'width') {
      setExportWidth(value);
      if (ratio) setExportHeight(Math.round(value / ratio));
    } else {
      setExportHeight(value);
      if (ratio) setExportWidth(Math.round(value * ratio));
    }
  };

  const handleShuffleImages = () => {
    setLoadedImages(prev => {
        const shuffled = [...prev];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    });
    resetImageOffsets();
  };

  const handleSave = async () => {
    if (isSaving || !activeLayout) return;
    setIsSaving(true);
    try {
      const offscreenCanvas = document.createElement('canvas');
      drawCanvas(offscreenCanvas, true);
      const base64Data = offscreenCanvas.toDataURL('image/png');
      const path = await onSave(base64Data, sourceImages[0].path);
      setSavedPath(path);
    } catch (err: any) {
      setError(err.message || 'Could not save the collage.');
    } finally {
      setIsSaving(false);
    }
  };

  const handlePanMouseDown = (e: React.MouseEvent<HTMLDivElement>, index: number) => {
    e.preventDefault(); 
    if (!activeLayout || keepOriginalRatio) return; 
    setPanningImage({ index, startX: e.clientX, startY: e.clientY });
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>, index: number) => {
    if (!activeLayout || keepOriginalRatio) return;
    e.preventDefault();

    const path = loadedImages[index].path;
    const currentState = imageStates[path] || { offsetX: 0, offsetY: 0, scale: 1 };
    
    const oldScale = currentState.scale || 1;
    const scaleStep = 0.05;
    let newScale = oldScale + (e.deltaY > 0 ? -scaleStep : scaleStep);
    newScale = Math.min(Math.max(1, newScale), 5); 

    const img = imageElementsRef.current[path];
    const cell = activeLayout[index];
    if (!img || !cell) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const scaleRatio = newScale / oldScale;
    let newOffsetX = mouseX - (mouseX - currentState.offsetX) * scaleRatio;
    let newOffsetY = mouseY - (mouseY - currentState.offsetY) * scaleRatio;

    const x1 = cell.x * previewSize.width;
    const y1 = cell.y * previewSize.height;
    const x2 = (cell.x + cell.width) * previewSize.width;
    const y2 = (cell.y + cell.height) * previewSize.height;
    const cellFinalWidth = (x2 - x1) - (cell.x === 0 ? spacing : spacing / 2) - (cell.x + cell.width >= 1 ? spacing : spacing / 2);
    const cellFinalHeight = (y2 - y1) - (cell.y === 0 ? spacing : spacing / 2) - (cell.y + cell.height >= 1 ? spacing : spacing / 2);

    const imageRatio = img.width / img.height;
    const cellRatio = cellFinalWidth / cellFinalHeight;

    let drawWidth, drawHeight;
    if (imageRatio > cellRatio) {
      drawHeight = cellFinalHeight * newScale;
      drawWidth = drawHeight * imageRatio;
    } else {
      drawWidth = cellFinalWidth * newScale;
      drawHeight = drawWidth / imageRatio;
    }

    const maxOffsetX = cellFinalWidth - drawWidth;
    const maxOffsetY = cellFinalHeight - drawHeight;
    newOffsetX = Math.min(0, Math.max(newOffsetX, maxOffsetX));
    newOffsetY = Math.min(0, Math.max(newOffsetY, maxOffsetY));

    setImageStates(prev => ({
      ...prev,
      [path]: { ...currentState, scale: newScale, offsetX: newOffsetX, offsetY: newOffsetY }
    }));
  };

  const handleThumbnailMouseDown = (e: React.MouseEvent<HTMLImageElement>, path: string, url: string) => {
    e.preventDefault();
    setThumbnailDrag({ path, url, x: e.clientX, y: e.clientY });
  };

  useEffect(() => {
    const handleWindowMouseMove = (e: MouseEvent) => {
      if (panningImage && activeLayout) {
        const imagePath = loadedImages[panningImage.index].path;
        const imageState = imageStates[imagePath];
        const img = imageElementsRef.current[imagePath];
        const cell = activeLayout[panningImage.index];

        const x1 = cell.x * previewSize.width;
        const y1 = cell.y * previewSize.height;
        const x2 = (cell.x + cell.width) * previewSize.width;
        const y2 = (cell.y + cell.height) * previewSize.height;
        const cellFinalWidth = (x2 - x1) - (cell.x === 0 ? spacing : spacing / 2) - (cell.x + cell.width >= 1 ? spacing : spacing / 2);
        const cellFinalHeight = (y2 - y1) - (cell.y === 0 ? spacing : spacing / 2) - (cell.y + cell.height >= 1 ? spacing : spacing / 2);

        const imageRatio = img.width / img.height;
        const cellRatio = cellFinalWidth / cellFinalHeight;
        const currentScale = imageState.scale || 1;

        const dx = e.clientX - panningImage.startX;
        const dy = e.clientY - panningImage.startY;

        let newOffsetX = imageState.offsetX;
        let newOffsetY = imageState.offsetY;

        let drawWidth, drawHeight;
        if (imageRatio > cellRatio) {
          drawHeight = cellFinalHeight * currentScale;
          drawWidth = drawHeight * imageRatio;
        } else {
          drawWidth = cellFinalWidth * currentScale;
          drawHeight = drawWidth / imageRatio;
        }

        newOffsetX = Math.max(cellFinalWidth - drawWidth, Math.min(0, imageState.offsetX + dx));
        newOffsetY = Math.max(cellFinalHeight - drawHeight, Math.min(0, imageState.offsetY + dy));

        setImageStates(prev => ({ ...prev, [imagePath]: { ...prev[imagePath], offsetX: newOffsetX, offsetY: newOffsetY } }));
        setPanningImage({ ...panningImage, startX: e.clientX, startY: e.clientY });
      }

      if (thumbnailDrag && activeLayout && previewContainerRef.current) {
         setThumbnailDrag(prev => prev ? ({ ...prev, x: e.clientX, y: e.clientY }) : null);

         const containerRect = previewContainerRef.current.getBoundingClientRect();
         if (e.clientX >= containerRect.left && e.clientX <= containerRect.right && 
             e.clientY >= containerRect.top && e.clientY <= containerRect.bottom) {
             
             const normX = (e.clientX - containerRect.left) / containerRect.width;
             const normY = (e.clientY - containerRect.top) / containerRect.height;

             const foundIndex = activeLayout.findIndex(cell => {
                return normX >= cell.x && normX <= (cell.x + cell.width) &&
                       normY >= cell.y && normY <= (cell.y + cell.height);
             });
             setHoveredCellIndex(foundIndex !== -1 ? foundIndex : null);
         } else {
             setHoveredCellIndex(null);
         }
      }
    };

    const handleWindowMouseUp = () => {
      if (panningImage) setPanningImage(null);

      if (thumbnailDrag) {
        if (hoveredCellIndex !== null) {
            setLoadedImages(currentImages => {
                const sourceIndex = currentImages.findIndex(img => img.path === thumbnailDrag.path);
                if (sourceIndex === -1 || sourceIndex === hoveredCellIndex) return currentImages;
                const newImages = [...currentImages];
                [newImages[sourceIndex], newImages[hoveredCellIndex]] = [newImages[hoveredCellIndex], newImages[sourceIndex]];
                
                setImageStates(prev => ({
                    ...prev,
                    [newImages[sourceIndex].path]: { offsetX: 0, offsetY: 0, scale: 1 },
                    [newImages[hoveredCellIndex].path]: { offsetX: 0, offsetY: 0, scale: 1 }
                }));
                return newImages;
            });
        }
        setThumbnailDrag(null);
        setHoveredCellIndex(null);
      }
    };

    if (panningImage || thumbnailDrag) {
      window.addEventListener('mousemove', handleWindowMouseMove);
      window.addEventListener('mouseup', handleWindowMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [panningImage, thumbnailDrag, activeLayout, previewSize, spacing, loadedImages, imageStates, hoveredCellIndex]);

  const renderControls = () => (
    <div className="w-80 flex-shrink-0 bg-bg-secondary p-4 flex flex-col gap-6 overflow-y-auto border-l border-surface h-full">
      {loadedImages.length > 1 && (
        <div>
          <h4 className="text-sm font-semibold mb-3 flex items-center justify-between">
            <span className="flex items-center gap-2"><LayoutTemplate size={16} /> Layout</span>
            <button onClick={handleShuffleImages} data-tooltip="Shuffle Images" className="p-1.5 rounded-md hover:bg-surface">
              <Shuffle size={16} />
            </button>
          </h4>
          <div className="grid grid-cols-3 gap-2">
            {availableLayouts.length > 0 ? availableLayouts.map((item, index) => (
              <button key={index} onClick={() => { setActiveLayout(item.layout); resetImageOffsets(); }} className={clsx('p-2 rounded-md bg-surface hover:bg-card-active', { 'ring-2 ring-accent': item.layout === activeLayout })}>
                <div className="w-full h-8">{item.icon}</div>
              </button>
            )) : null}
          </div>
        </div>
      )}

      <div>
        <h4 className="text-sm font-semibold mb-3 flex items-center justify-between">
          <span className="flex items-center gap-2"><Crop size={16} /> Aspect Ratio</span>
          <button
            className="p-1.5 rounded-md hover:bg-surface disabled:text-text-tertiary disabled:cursor-not-allowed"
            disabled={!activeAspectRatio.value || activeAspectRatio.value === 1}
            onClick={handleOrientationToggle}
          >
            {activeAspectRatio.value && activeAspectRatio.value < 1 ? <RectangleVertical size={16} /> : <RectangleHorizontal size={16} />}
          </button>
        </h4>
        <div className="grid grid-cols-3 gap-2 mb-4">
          {ASPECT_RATIO_PRESETS.map(preset => (
            <button key={preset.name} onClick={() => handleAspectRatioChange(preset)} className={clsx('px-2 py-1.5 text-sm rounded-md transition-colors', activeAspectRatio.name === preset.name ? 'bg-accent text-button-text' : 'bg-surface hover:bg-card-active')}>
              {preset.name}
            </button>
          ))}
          {loadedImages.length === 1 && (
            <button 
                onClick={handleOriginalAspectRatio} 
                className={clsx('px-2 py-1.5 text-sm rounded-md transition-colors', activeAspectRatio.name === 'Original' ? 'bg-accent text-button-text' : 'bg-surface hover:bg-card-active')}
            >
                Original
            </button>
          )}
        </div>
        
        <Switch 
            label="Keep Original Aspect Ratio" 
            checked={keepOriginalRatio} 
            onChange={setKeepOriginalRatio} 
        />
      </div>

      <div className="space-y-2">
        <Slider label="Spacing" min={0} max={50} step={1} defaultValue={INITIAL_SPACING} value={spacing} onChange={e => setSpacing(Number(e.target.value))} />
      </div>
      <div className="space-y-2">
        <Slider label="Border Radius" min={0} max={50} step={1} defaultValue={INITIAL_BORDER_RADIUS} value={borderRadius} onChange={e => setBorderRadius(Number(e.target.value))} />
      </div>

      <div>
        <h4 className="text-sm font-semibold mb-3 flex items-center gap-2"><Palette size={16} /> Background</h4>
        <div className="flex items-center gap-2 bg-surface p-2 rounded-md">
          <input type="color" value={backgroundColor} onChange={e => setBackgroundColor(e.target.value)} className="w-8 h-8 p-0 border-none rounded cursor-pointer bg-transparent" />
          <input type="text" value={backgroundColor} onChange={e => setBackgroundColor(e.target.value)} className="w-full bg-bg-primary text-center rounded-md p-1 border border-surface focus:border-accent focus:ring-accent" />
        </div>
      </div>

      <div>
        <h4 className="text-sm font-semibold mb-3 flex items-center gap-2"><Proportions size={16} /> Export Size (px)</h4>
        <div className="flex items-center gap-2">
          <input type="number" value={exportWidth} onChange={e => handleExportDimChange(e, 'width')} className="w-full bg-bg-primary text-center rounded-md p-1 border border-surface focus:border-accent focus:ring-accent" placeholder="W" />
          <span className="text-text-tertiary">×</span>
          <input type="number" value={exportHeight} onChange={e => handleExportDimChange(e, 'height')} className="w-full bg-bg-primary text-center rounded-md p-1 border border-surface focus:border-accent focus:ring-accent" placeholder="H" />
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
        <AnimatePresence>
            {thumbnailDrag && (
                <motion.div 
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1.1, opacity: 1 }}
                    exit={{ scale: 0.8, opacity: 0 }}
                    className="fixed pointer-events-none z-[9999] shadow-2xl rounded-lg overflow-hidden border-2 border-accent ring-4 ring-black/10"
                    style={{ 
                        left: thumbnailDrag.x, 
                        top: thumbnailDrag.y,
                        width: '80px',
                        height: '80px',
                        x: '-50%',
                        y: '-50%'
                    }}
                >
                    <img src={thumbnailDrag.url} className="w-full h-full object-cover" alt="" />
                </motion.div>
            )}
        </AnimatePresence>

        <div className="flex-grow flex flex-col min-w-0 h-full bg-bg-secondary">
            <div ref={previewContainerRef} className="flex-grow flex items-center justify-center p-4 relative min-h-0">
                {isLoading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/20 z-10">
                        <Loader2 className="w-12 h-12 text-accent animate-spin" />
                    </div>
                )}
                
                <div style={{ width: previewSize.width, height: previewSize.height }} className="relative">
                    <canvas ref={previewCanvasRef} className="block" />
                    
                    <div className="absolute inset-0 z-10">
                        {activeLayout && activeLayout.map((cell, index) => (
                            <div
                                key={index}
                                onMouseDown={(e) => handlePanMouseDown(e, index)}
                                onWheel={(e) => handleWheel(e, index)}
                                className={clsx(
                                    "absolute group",
                                    (panningImage?.index === index && !keepOriginalRatio) ? "cursor-grabbing" : (!keepOriginalRatio ? "cursor-grab" : "cursor-default")
                                )}
                                style={{
                                    left: `${cell.x * 100}%`,
                                    top: `${cell.y * 100}%`,
                                    width: `${cell.width * 100}%`,
                                    height: `${cell.height * 100}%`,
                                }}
                            >
                                <AnimatePresence>
                                    {thumbnailDrag && hoveredCellIndex === index && (
                                        <motion.div 
                                            initial={{ opacity: 0, scale: 0.95 }}
                                            animate={{ opacity: 1, scale: 1 }}
                                            exit={{ opacity: 0, scale: 0.95 }}
                                            transition={{ duration: 0.15 }}
                                            className="absolute bg-accent/30 border-2 border-accent backdrop-blur-[1px]"
                                            style={{
                                              top: cell.y === 0 ? spacing : spacing / 2,
                                              left: cell.x === 0 ? spacing : spacing / 2,
                                              right: (cell.x + cell.width) >= 0.99 ? spacing : spacing / 2,
                                              bottom: (cell.y + cell.height) >= 0.99 ? spacing : spacing / 2,
                                              borderRadius: borderRadius
                                            }}
                                        />
                                    )}
                                </AnimatePresence>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
            
            <div className="h-28 flex-shrink-0 border-t border-surface bg-bg-primary/50 flex items-center px-4 gap-3 overflow-x-auto z-20 select-none">
                {sourceImages.map((sourceImg, idx) => {
                    const loadedData = loadedImages.find(l => l.path === sourceImg.path);
                    if (!loadedData) return null;

                    return (
                        <motion.div
                            key={`${sourceImg.path}-${idx}`}
                            whileHover={{ scale: 1.05, y: -2 }}
                            whileTap={{ scale: 0.95 }}
                            className="relative"
                        >
                            <img 
                                src={loadedData.url} 
                                alt=""
                                onMouseDown={(e) => handleThumbnailMouseDown(e, sourceImg.path, loadedData.url)}
                                className="h-20 w-20 flex-shrink-0 object-cover rounded-md cursor-grab active:cursor-grabbing hover:ring-2 hover:ring-accent transition-all select-none shadow-sm"
                            />
                        </motion.div>
                    );
                })}
            </div>
        </div>
        {renderControls()}
      </div>
    );
  };

  if (!isMounted) return null;

  return (
    <div className={`fixed inset-0 flex items-center justify-center z-50 bg-black/50 backdrop-blur-sm transition-opacity duration-300 ${show ? 'opacity-100' : 'opacity-0'}`} onMouseDown={onClose}>
      <AnimatePresence>
        {show && (
          <motion.div
            className="bg-surface rounded-lg shadow-xl w-full max-w-6xl h-[90vh] flex flex-col overflow-hidden"
            onMouseDown={(e) => e.stopPropagation()}
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
          >
            <div className="flex-grow min-h-0 overflow-hidden">{renderContent()}</div>
            <div className="flex-shrink-0 p-4 flex justify-end gap-3 border-t border-surface bg-bg-secondary">
              <button onClick={onClose} className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors">{savedPath || error ? (savedPath ? 'Done' : 'Close') : 'Cancel'}</button>
              {!savedPath && !error && (
                <Button onClick={handleSave} disabled={isSaving || isLoading || !activeLayout}>
                  {isSaving ? <Loader2 className="animate-spin mr-2" /> : <Save size={16} className="mr-2" />}
                  {isSaving ? 'Saving...' : 'Save Collage'}
                </Button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}