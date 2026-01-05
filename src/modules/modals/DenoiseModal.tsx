import { useState, useEffect, useCallback, useRef } from 'react';
import { useBloc } from '@blac/react';
import { CheckCircle, XCircle, Loader2, Save, ZoomIn, ZoomOut, Move } from 'lucide-react';
import { Modal } from '../../primitives/Modal';
import { Button } from '../../primitives/Button';
import { Slider } from '../../primitives/Slider';
import { ModalBloc } from '../../blocs/app/ModalBloc';

interface ImageCompareProps {
  original: string;
  denoised: string;
}

function ImageCompare({ original, denoised }: ImageCompareProps) {
  const [sliderPosition, setSliderPosition] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [isResizingSlider, setIsResizingSlider] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastMousePos = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (!isDragging && !isResizingSlider) return;

    const handleWindowMouseMove = (e: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      if (isResizingSlider) {
        const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        const percent = (x / rect.width) * 100;
        setSliderPosition(percent);
      } else if (isDragging) {
        const dx = e.clientX - lastMousePos.current.x;
        const dy = e.clientY - lastMousePos.current.y;
        setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
        lastMousePos.current = { x: e.clientX, y: e.clientY };
      }
    };

    const handleWindowMouseUp = () => {
      setIsDragging(false);
      setIsResizingSlider(false);
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [isDragging, isResizingSlider]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (isResizingSlider) return;
    e.preventDefault();
    setIsDragging(true);
    lastMousePos.current = { x: e.clientX, y: e.clientY };
  };

  const handleSliderMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setIsResizingSlider(true);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.stopPropagation();
    if (!containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left - rect.width / 2;
    const mouseY = e.clientY - rect.top - rect.height / 2;

    const delta = -e.deltaY * 0.001;
    const newZoom = Math.min(Math.max(0.5, zoom + delta), 4);

    const scaleRatio = newZoom / zoom;
    const mouseFromCenterX = mouseX - pan.x;
    const mouseFromCenterY = mouseY - pan.y;

    const newPanX = mouseX - mouseFromCenterX * scaleRatio;
    const newPanY = mouseY - mouseFromCenterY * scaleRatio;

    setZoom(newZoom);
    setPan({ x: newPanX, y: newPanY });
  };

  const imageTransformStyle = {
    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
    transformOrigin: 'center center',
  };

  return (
    <div className="flex flex-col h-full bg-bg-primary rounded-md overflow-hidden border border-surface">
      <div className="h-9 bg-bg-secondary border-b border-surface flex items-center justify-between px-3">
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <Move size={14} /> <span>Pan & Zoom enabled</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setZoom((z) => Math.max(0.5, z - 0.5))} className="hover:text-text-primary text-text-secondary">
            <ZoomOut size={16} />
          </button>
          <span className="text-xs w-10 text-center text-text-secondary">{(zoom * 100).toFixed(0)}%</span>
          <button onClick={() => setZoom((z) => Math.min(4, z + 0.5))} className="hover:text-text-primary text-text-secondary">
            <ZoomIn size={16} />
          </button>
          <button
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
              setSliderPosition(50);
            }}
            className="text-xs ml-2 text-accent hover:underline"
          >
            Reset
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="flex-1 relative overflow-hidden cursor-grab active:cursor-grabbing select-none"
        onMouseDown={handleMouseDown}
        onWheel={handleWheel}
      >
        <div className="absolute inset-0 flex items-center justify-center overflow-hidden pointer-events-none">
          <div className="origin-center" style={imageTransformStyle}>
            <img src={denoised} alt="Denoised" className="max-w-none shadow-xl" draggable={false} />
          </div>
        </div>

        <div
          className="absolute inset-0 flex items-center justify-center overflow-hidden pointer-events-none"
          style={{ clipPath: `inset(0 ${100 - sliderPosition}% 0 0)` }}
        >
          <div className="origin-center" style={imageTransformStyle}>
            <img src={original} alt="Original" className="max-w-none shadow-xl" draggable={false} />
          </div>
        </div>

        <div
          className="absolute top-0 bottom-0 w-0.5 bg-white cursor-col-resize z-10 shadow-[0_0_8px_rgba(0,0,0,0.8)]"
          style={{ left: `${sliderPosition}%` }}
          onMouseDown={handleSliderMouseDown}
        >
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-6 h-6 bg-white rounded-full shadow-md flex items-center justify-center">
            <div className="w-0.5 h-3 bg-black/50 mx-0.5" />
            <div className="w-0.5 h-3 bg-black/50 mx-0.5" />
          </div>
        </div>

        <div className="absolute top-3 left-3 bg-black/70 text-white text-[10px] px-2 py-1 rounded font-medium pointer-events-none z-0">
          Original
        </div>
        <div className="absolute top-3 right-3 bg-accent/90 text-button-text text-[10px] px-2 py-1 rounded font-medium pointer-events-none z-0">
          Denoised
        </div>
      </div>
    </div>
  );
}

export interface DenoiseModalData {
  onDenoise: (intensity: number) => void;
  onSave: () => Promise<string>;
  onOpenFile: (path: string) => void;
  error: string | null;
  previewBase64: string | null;
  originalBase64: string | null;
  isProcessing: boolean;
  progressMessage: string | null;
}

export function DenoiseModal() {
  const [state, modalBloc] = useBloc(ModalBloc);
  const isOpen = state.openModals.includes('denoise');
  const data = state.modalData['denoise'] as DenoiseModalData | undefined;

  const [intensity, setIntensity] = useState(50);
  const [isSaving, setIsSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setIntensity(50);
      setSavedPath(null);
      setIsSaving(false);
    }
  }, [isOpen]);

  const handleClose = useCallback(() => {
    if (isSaving) return;
    modalBloc.close('denoise');
  }, [modalBloc, isSaving]);

  const handleRunDenoise = () => {
    if (!data) return;
    setSavedPath(null);
    data.onDenoise(intensity / 100);
  };

  const handleSave = async () => {
    if (!data) return;
    setIsSaving(true);
    try {
      const path = await data.onSave();
      setSavedPath(path);
    } catch (e) {
      console.error(e);
    } finally {
      setIsSaving(false);
    }
  };

  const handleOpen = () => {
    if (savedPath && data) {
      data.onOpenFile(savedPath);
      handleClose();
    }
  };

  if (!isOpen || !data) return null;

  const renderContent = () => {
    if (data.error) {
      return (
        <div className="flex flex-col items-center justify-center py-10 h-[400px]">
          <XCircle className="w-16 h-16 text-red-500 mb-4" />
          <h3 className="text-lg font-semibold text-text-primary mb-2 text-center">Processing Failed</h3>
          <p className="text-sm text-text-secondary text-center p-2 rounded-md max-w-md">{String(data.error)}</p>
        </div>
      );
    }

    if (data.previewBase64 && data.originalBase64 && !data.isProcessing) {
      return (
        <div className="w-full h-[500px]">
          <ImageCompare original={data.originalBase64} denoised={data.previewBase64} />
          {savedPath && (
            <div className="flex items-center justify-center gap-2 mt-4 text-green-500">
              <CheckCircle className="w-5 h-5" />
              <span className="font-medium">Image Saved Successfully!</span>
            </div>
          )}
        </div>
      );
    }

    if (data.isProcessing) {
      return (
        <div className="flex flex-col items-center justify-center py-12 h-[400px]">
          <Loader2 className="w-16 h-16 text-accent animate-spin mb-4" />
          <h3 className="text-lg font-semibold text-text-primary mb-2 text-center">Denoising Image</h3>
          <p className="text-sm text-text-secondary text-center h-6 font-mono w-64 flex justify-center items-center">
            {data.progressMessage || 'Initializing...'}
          </p>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center justify-center h-[400px] text-text-secondary">
        <h3 className="text-lg font-semibold text-text-primary mb-2 text-center">Denoise Image</h3>
        <p className="text-sm text-center max-w-sm">
          Adjust the intensity slider below and click Start to preview the results.
        </p>
      </div>
    );
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Denoise Image" size="lg">
      {renderContent()}

      <div className="mt-4 pt-4 border-t border-surface">
        {data.error ? (
          <div className="flex justify-end">
            <Button onClick={handleClose}>Close</Button>
          </div>
        ) : savedPath ? (
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={handleClose}>
              Close
            </Button>
            <Button onClick={handleOpen}>Open in Editor</Button>
          </div>
        ) : (
          <div className="flex items-center gap-4">
            <div className={`flex-1 ${data.isProcessing || isSaving ? 'opacity-50 pointer-events-none' : ''}`}>
              <Slider label="Strength" value={intensity} min={0} max={100} step={1} onChange={(v) => setIntensity(v)} />
            </div>

            <div className="h-8 w-px bg-surface mx-2" />

            <div className="flex gap-2">
              <Button variant="ghost" onClick={handleClose}>
                {data.previewBase64 ? 'Close' : 'Cancel'}
              </Button>

              <Button
                onClick={handleRunDenoise}
                disabled={data.isProcessing}
                variant={data.previewBase64 ? 'surface' : 'primary'}
              >
                {data.isProcessing && <Loader2 className="animate-spin mr-2" size={16} />}
                {data.previewBase64 ? 'Retry' : 'Start'}
              </Button>

              {data.previewBase64 && (
                <Button onClick={handleSave} disabled={isSaving || data.isProcessing}>
                  {isSaving ? <Loader2 className="animate-spin mr-2" size={16} /> : <Save className="mr-2" size={16} />}
                  Save Image
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
