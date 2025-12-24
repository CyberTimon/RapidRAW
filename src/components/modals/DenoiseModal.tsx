import { useState, useEffect, useCallback, useRef } from 'react';
import { CheckCircle, XCircle, Loader2, Save, Grip, RefreshCw, ZoomIn, ZoomOut, Move } from 'lucide-react';
import Button from '../ui/Button';
import Slider from '../ui/Slider';

interface DenoiseModalProps {
  isOpen: boolean;
  onClose(): void;
  onDenoise(intensity: number): void;
  onSave(): Promise<string>;
  onOpenFile(path: string): void;
  error: string | null;
  previewBase64: string | null;
  originalBase64: string | null;
  isProcessing: boolean;
  progressMessage: string | null;
}

const ImageCompare = ({ original, denoised }: { original: string; denoised: string }) => {
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

    const newPanX = mouseX - (mouseFromCenterX * scaleRatio);
    const newPanY = mouseY - (mouseFromCenterY * scaleRatio);

    setZoom(newZoom);
    setPan({ x: newPanX, y: newPanY });
  };

  const imageTransformStyle = {
    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
    transition: isDragging || isResizingSlider ? 'none' : 'transform 0.1s ease-out',
    transformOrigin: 'center center'
  };

  return (
    <div className="flex flex-col h-full bg-[#1a1a1a] rounded-md overflow-hidden border border-surface">
      <div className="h-9 bg-bg-primary border-b border-surface flex items-center justify-between px-3">
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <Move size={14} /> <span>Pan & Zoom enabled</span>
        </div>
        <div className="flex items-center gap-2">
           <button onClick={() => setZoom(z => Math.max(0.5, z - 0.5))} className="hover:text-text-primary text-text-secondary"><ZoomOut size={16}/></button>
           <span className="text-xs w-10 text-center text-text-secondary">{(zoom * 100).toFixed(0)}%</span>
           <button onClick={() => setZoom(z => Math.min(4, z + 0.5))} className="hover:text-text-primary text-text-secondary"><ZoomIn size={16}/></button>
           <button onClick={() => { setZoom(1); setPan({x:0, y:0}); setSliderPosition(50); }} className="text-xs ml-2 text-accent hover:underline">Reset</button>
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
                <img
                    src={denoised}
                    alt="Denoised"
                    className="max-w-none shadow-xl"
                    style={{ height: 'auto' }}
                    draggable={false}
                />
            </div>
        </div>

        <div 
            className="absolute inset-0 flex items-center justify-center overflow-hidden pointer-events-none"
            style={{ clipPath: `inset(0 ${100 - sliderPosition}% 0 0)` }}
        >
            <div className="origin-center" style={imageTransformStyle}>
                <img
                    src={original}
                    alt="Original"
                    className="max-w-none shadow-xl"
                    style={{ height: 'auto' }}
                    draggable={false}
                />
            </div>
        </div>

        <div
            className="absolute top-0 bottom-0 w-0.5 bg-white cursor-col-resize z-10 shadow-[0_0_8px_rgba(0,0,0,0.8)]"
            style={{ left: `${sliderPosition}%` }}
            onMouseDown={handleSliderMouseDown}
        >
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-6 h-6 bg-white rounded-full shadow-md flex items-center justify-center">
                <div className="w-0.5 h-3 bg-black/50 mx-0.5"></div>
                <div className="w-0.5 h-3 bg-black/50 mx-0.5"></div>
            </div>
        </div>

        <div className="absolute top-3 left-3 bg-black/70 text-white text-[10px] px-2 py-1 rounded font-medium pointer-events-none z-0">Original</div>
        <div className="absolute top-3 right-3 bg-accent/90 text-button-text text-[10px] px-2 py-1 rounded font-medium pointer-events-none z-0">Denoised</div>
      </div>
    </div>
  );
};

export default function DenoiseModal({
  isOpen,
  onClose,
  onDenoise,
  onSave,
  onOpenFile,
  error,
  previewBase64,
  originalBase64,
  isProcessing,
  progressMessage,
}: DenoiseModalProps) {
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);
  // Initializing at 50 (0-100 range) instead of 0.5 so the Slider displays integer percentages
  const [intensity, setIntensity] = useState<number>(50);
  const [isSaving, setIsSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  
  const mouseDownTarget = useRef<EventTarget | null>(null);

  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      const timer = setTimeout(() => setShow(true), 10);
      return () => clearTimeout(timer);
    } else {
      setShow(false);
      const timer = setTimeout(() => {
        setIsMounted(false);
        setSavedPath(null);
        setIsSaving(false);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  const handleClose = useCallback(() => {
    if (isSaving) return;
    onClose();
  }, [onClose, isSaving]);

  const handleBackdropMouseDown = (e: React.MouseEvent) => {
    mouseDownTarget.current = e.target;
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && mouseDownTarget.current === e.currentTarget) {
        handleClose();
    }
    mouseDownTarget.current = null;
  };

  const handleRunDenoise = () => {
    setSavedPath(null);
    // Convert 0-100 back to 0-1 for the processing function
    onDenoise(intensity / 100);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const path = await onSave();
      setSavedPath(path);
    } catch (e) {
      console.error(e);
    } finally {
      setIsSaving(false);
    }
  };

  const handleOpen = () => {
    if (savedPath) {
      onOpenFile(savedPath);
      handleClose();
    }
  };

  const renderContent = () => {
    if (error) {
      return (
        <div className="flex flex-col items-center justify-center py-10 h-[400px]">
          <XCircle className="w-16 h-16 text-red-500 mb-4" />
          <h3 className="text-lg font-semibold text-text-primary mb-2 text-center">Processing Failed</h3>
          <p className="text-sm text-text-secondary text-center p-2 rounded-md max-w-md">
            {String(error)}
          </p>
        </div>
      );
    }

    if (previewBase64 && originalBase64 && !isProcessing) {
      return (
        <div className="w-full h-[500px]">
          <ImageCompare original={originalBase64} denoised={previewBase64} />
          {savedPath && (
            <div className="flex items-center justify-center gap-2 mt-4 text-green-500 animate-in fade-in slide-in-from-bottom-2">
              <CheckCircle className="w-5 h-5" />
              <span className="font-medium">Image Saved Successfully!</span>
            </div>
          )}
        </div>
      );
    }

    if (isProcessing) {
      return (
        <div className="flex flex-col items-center justify-center py-12 h-[400px]">
          <Loader2 className="w-16 h-16 text-accent animate-spin mb-4" />
          <h3 className="text-lg font-semibold text-text-primary mb-2 text-center">Denoising Image</h3>
          <p className="text-sm text-text-secondary text-center h-6 font-mono w-64 flex justify-center items-center">
            {progressMessage || 'Initializing...'}
          </p>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center justify-center h-[400px] text-text-secondary">
        <Grip className="w-16 h-16 mb-4" />
        <h3 className="text-lg font-semibold text-text-primary mb-2 text-center">Denoise Image</h3>
        <p className="text-sm text-center max-w-sm">
          Adjust the intensity slider below and click Start to preview the results.
        </p>
      </div>
    );
  };

  const renderButtons = () => {
    if (error) {
        return <Button onClick={handleClose} className="w-full">Close</Button>;
    }

    if (savedPath) {
      return (
        <>
          <button
            onClick={handleClose}
            className="px-4 py-2 rounded-md text-text-secondary hover:bg-card-active transition-colors"
          >
            Close
          </button>
          <Button onClick={handleOpen}>Open in Editor</Button>
        </>
      );
    }

    const disabled = isProcessing || isSaving;

    return (
      <div className="w-full flex items-center gap-4">
        <div className={`flex-1 ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
            <Slider
                label="Strength"
                value={intensity}
                min={0}
                max={100}
                step={1}
                defaultValue={50}
                onChange={(e) => setIntensity(Number(e.target.value))}
                trackClassName="bg-bg-secondary"
            />
        </div>
        
        <div className="h-8 w-px bg-surface mx-2" />

        <div className="flex gap-2">
            <button
            onClick={handleClose}
            className="px-4 py-2 rounded-md text-text-secondary hover:bg-card-active transition-colors text-sm"
            >
            {previewBase64 ? 'Close' : 'Cancel'}
            </button>
            
            <Button 
                onClick={handleRunDenoise} 
                disabled={isProcessing} 
                variant={previewBase64 ? 'secondary' : 'primary'}
            >
                {isProcessing ? <Loader2 className="animate-spin mr-2" size={16} /> : previewBase64 ? <RefreshCw className="mr-2" size={16} /> : <Grip className="mr-2" size={16} />}
                {previewBase64 ? 'Retry' : 'Start'}
            </Button>

            {previewBase64 && (
                <Button onClick={handleSave} disabled={isSaving || isProcessing}>
                    {isSaving ? <Loader2 className="animate-spin mr-2" size={16} /> : <Save className="mr-2" size={16} />}
                    Save Image
                </Button>
            )}
        </div>
      </div>
    );
  };

  if (!isMounted) return null;

  return (
    <div
      className={`fixed inset-0 flex items-center justify-center z-50 bg-black/30 backdrop-blur-sm transition-opacity duration-300 ease-in-out ${
        show ? 'opacity-100' : 'opacity-0'
      }`}
      onMouseDown={handleBackdropMouseDown}
      onClick={handleBackdropClick}
    >
      <div
        className={`bg-surface rounded-lg shadow-xl p-6 w-full max-w-4xl transform transition-all duration-300 ease-out ${
          show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4'
        }`}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()} 
      >
        <div className="flex flex-col">
          {renderContent()}
          
          {!savedPath && <div className="mt-4 pt-4 flex justify-end gap-3">{renderButtons()}</div>}
          {savedPath && <div className="mt-4 flex justify-end gap-3">{renderButtons()}</div>}
        </div>
      </div>
    </div>
  );
}