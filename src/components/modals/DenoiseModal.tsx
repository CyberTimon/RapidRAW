import { useState, useEffect, useCallback, useRef } from 'react';
import { CheckCircle, XCircle, Loader2, Save, RefreshCw, ZoomIn, ZoomOut, Move, Grip } from 'lucide-react';
import { motion } from 'framer-motion';
import Button from '../ui/Button';
import Dropdown from '../ui/Dropdown';
import Slider from '../ui/Slider';
import Text from '../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';

interface DenoiseModalProps {
  isOpen: boolean;
  onClose(): void;
  onDenoise(intensity: number, method: 'ai' | 'bm3d'): void;
  onSave(): Promise<string>;
  onOpenFile(path: string): void;
  error: string | null;
  previewBase64: string | null;
  originalBase64: string | null;
  isProcessing: boolean;
  progressMessage: string | null;
  aiModelDownloadStatus: string | null;
  isRaw: boolean;
  loadingImageUrl?: string | null;
}

const methodOptions: Array<{ label: string; value: 'ai' | 'bm3d' }> = [
  { label: 'NIND (AI - Best for RAW)', value: 'ai' },
  { label: 'BM3D (Traditional - All formats)', value: 'bm3d' },
];

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

    const newPanX = mouseX - mouseFromCenterX * scaleRatio;
    const newPanY = mouseY - mouseFromCenterY * scaleRatio;

    setZoom(newZoom);
    setPan({ x: newPanX, y: newPanY });
  };

  const imageTransformStyle = {
    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
    transition: isDragging || isResizingSlider ? 'none' : 'transform 0.1s ease-out',
    transformOrigin: 'center center',
  };

  return (
    <div className="flex flex-col h-full bg-[#111] rounded-lg overflow-hidden border border-surface">
      <div className="h-9 bg-bg-primary border-b border-surface flex items-center justify-between px-3">
        <Text as="div" variant={TextVariants.small} className="flex items-center gap-2">
          <Move size={14} /> <span>Pan & Zoom enabled</span>
        </Text>
        <Text as="div" variant={TextVariants.small} className="flex items-center gap-2">
          <button onClick={() => setZoom((z) => Math.max(0.5, z - 0.5))} className="hover:text-text-primary">
            <ZoomOut size={16} />
          </button>
          <span className="w-10 text-center">{(zoom * 100).toFixed(0)}%</span>
          <button onClick={() => setZoom((z) => Math.min(4, z + 0.5))} className="hover:text-text-primary">
            <ZoomIn size={16} />
          </button>
          <button
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
              setSliderPosition(50);
            }}
            className="ml-2 text-accent hover:underline"
          >
            Reset
          </button>
        </Text>
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
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 bg-white rounded-full shadow-lg flex items-center justify-center gap-0.5">
            <div className="w-0.5 h-3 bg-black/40 rounded-full"></div>
            <div className="w-0.5 h-3 bg-black/40 rounded-full"></div>
          </div>
        </div>

        <Text
          as="div"
          variant={TextVariants.small}
          color={TextColors.white}
          weight={TextWeights.medium}
          className="absolute top-3 left-3 bg-black/60 backdrop-blur-xs px-2.5 py-1 rounded-md pointer-events-none z-0"
        >
          Original
        </Text>
        <Text
          as="div"
          variant={TextVariants.small}
          color={TextColors.button}
          weight={TextWeights.medium}
          className="absolute top-3 right-3 bg-accent/90 backdrop-blur-xs px-2.5 py-1 rounded-md pointer-events-none z-0"
        >
          Denoised
        </Text>
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
  aiModelDownloadStatus,
  isRaw,
  loadingImageUrl,
}: DenoiseModalProps) {
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);
  const [intensity, setIntensity] = useState<number>(15);
  const [method, setMethod] = useState<'ai' | 'bm3d'>('ai');
  const [isSaving, setIsSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);

  const mouseDownTarget = useRef<EventTarget | null>(null);

  const currentStatusText = aiModelDownloadStatus?.includes('NIND')
    ? `Downloading ${aiModelDownloadStatus}...`
    : progressMessage || 'Initializing...';

  useEffect(() => {
    if (isOpen) {
      setMethod(isRaw ? 'ai' : 'bm3d');
      setIntensity(isRaw ? 50 : 15);
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
  }, [isOpen, isRaw]);

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
    onDenoise(intensity / 100, method);
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
        <div className="flex flex-col items-center justify-center py-10 h-[460px]">
          <div className="flex items-center justify-center mb-6">
            <XCircle className="w-12 h-12 text-red-500" />
          </div>
          <Text variant={TextVariants.title} className="mb-2 text-center">
            Processing Failed
          </Text>
          <Text className="text-center p-4 rounded-lg bg-bg-primary max-w-md mt-2 leading-relaxed">
            {String(error)}
          </Text>
        </div>
      );
    }

    if (previewBase64 && originalBase64 && !isProcessing) {
      return (
        <div className="w-full h-[500px]">
          <ImageCompare original={originalBase64} denoised={previewBase64} />
          {savedPath && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
              <Text
                as="div"
                variant={TextVariants.heading}
                color={TextColors.success}
                className="flex items-center justify-center gap-2 mt-4"
              >
                <CheckCircle className="w-5 h-5" />
                <span>Image Saved Successfully!</span>
              </Text>
            </motion.div>
          )}
        </div>
      );
    }

    if (isProcessing) {
      return (
        <div className="flex h-[460px] overflow-hidden rounded-lg border border-surface">
          <div className="w-2/5 relative overflow-hidden shrink-0 bg-[#0a0a0a] flex items-center justify-center">
            {loadingImageUrl ? (
              <img src={loadingImageUrl} alt="Selected preview" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full bg-surface/50" />
            )}
          </div>
          <div className="flex-1 flex flex-col items-center justify-center px-12 bg-bg-primary">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1, duration: 0.4 }}
              className="flex flex-col items-center w-full"
            >
              <Text variant={TextVariants.title} className="mb-2 text-center">
                Denoising in Progress
              </Text>
              <Text className="text-center font-mono h-6 flex justify-center items-center">{currentStatusText}</Text>

              <div className="mt-8 w-64 relative">
                <div className="h-1 bg-surface rounded-full overflow-hidden relative w-full shadow-xs">
                  <motion.div
                    className="absolute inset-y-0 w-[80%] bg-linear-to-r from-transparent via-accent to-transparent mix-blend-screen"
                    style={{ filter: 'blur(3px)' }}
                    animate={{ x: ['-150%', '150%'] }}
                    transition={{ repeat: Infinity, duration: 1.5, ease: [0.4, 0, 0.2, 1] }}
                  />
                  <motion.div
                    className="absolute inset-y-0 w-[40%] bg-linear-to-r from-transparent via-white/90 to-transparent"
                    style={{ filter: 'blur(1px)' }}
                    animate={{ x: ['-250%', '250%'] }}
                    transition={{ repeat: Infinity, duration: 1.5, ease: [0.4, 0, 0.2, 1] }}
                  />
                </div>
              </div>

              <Text
                variant={TextVariants.small}
                data-tooltip="NIND Denoise does not yet support GPU acceleration due to dependency limitations."
                className="mt-6 text-center max-w-xs opacity-60"
              >
                This may take a few minutes depending on image size and selected method.
              </Text>
            </motion.div>
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center justify-center h-[460px]">
        <div className="flex items-center justify-center mb-6">
          <Grip className="w-12 h-12 text-accent" />
        </div>
        <Text variant={TextVariants.title} className="mb-3 text-center">
          Denoise Image
        </Text>
        <Text className="text-center max-w-md leading-relaxed text-text-secondary">
          Remove noise from your image using AI-powered or traditional denoising.
        </Text>
      </div>
    );
  };

  const renderButtons = () => {
    if (error) {
      return (
        <Button onClick={handleClose} className="w-full">
          Close
        </Button>
      );
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
      <div className={`w-full flex items-center gap-4 ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
        <div className="flex-1 flex items-center gap-6">
          <div className="flex flex-col gap-1 w-[280px] mt-2 shrink-0">
            <Text variant={TextVariants.body} weight={TextWeights.medium}>
              Method
            </Text>
            <Dropdown
              options={methodOptions}
              value={method}
              onChange={(val) => {
                setMethod(val);
                setIntensity(val === 'ai' ? 50 : 15);
              }}
            />
          </div>
          <div className="flex-1 max-w-[280px]">
            <Slider
              label={method === 'ai' ? 'Quality / Tile Size' : 'Strength'}
              value={intensity}
              min={0}
              max={100}
              step={1}
              defaultValue={method === 'ai' ? 50 : 15}
              onChange={(e) => setIntensity(Number(e.target.value))}
              trackClassName="bg-bg-secondary"
            />
          </div>
        </div>

        <div className="h-10 w-px bg-surface shrink-0" />

        <div className="flex gap-2 shrink-0">
          <button
            onClick={handleClose}
            className="px-4 py-2 rounded-md text-text-secondary hover:bg-card-active transition-colors text-sm"
          >
            {previewBase64 ? 'Close' : 'Cancel'}
          </button>

          <Button onClick={handleRunDenoise} disabled={isProcessing} variant={previewBase64 ? 'secondary' : 'primary'}>
            {isProcessing ? (
              <Loader2 className="animate-spin mr-2" size={16} />
            ) : previewBase64 ? (
              <RefreshCw className="mr-2" size={16} />
            ) : (
              <Grip className="mr-2" size={16} />
            )}
            {previewBase64 ? 'Retry' : 'Start'}
          </Button>

          {previewBase64 && (
            <Button onClick={handleSave} disabled={isSaving || isProcessing}>
              {isSaving ? <Loader2 className="animate-spin mr-2" size={16} /> : <Save className="mr-2" size={16} />}
              Save
            </Button>
          )}
        </div>
      </div>
    );
  };

  if (!isMounted) return null;

  return (
    <div
      className={`fixed inset-0 flex items-center justify-center z-50 bg-black/40 backdrop-blur-xs transition-opacity duration-300 ease-in-out ${
        show ? 'opacity-100' : 'opacity-0'
      }`}
      onMouseDown={handleBackdropMouseDown}
      onClick={handleBackdropClick}
    >
      <div
        className={`bg-surface rounded-xl shadow-2xl p-6 w-full max-w-4xl transform transition-all duration-300 ease-out ${
          show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4'
        }`}
      >
        <div className="flex flex-col">
          {renderContent()}
          <div className={`mt-4 flex justify-end gap-3 ${savedPath ? '' : 'pt-4 border-t border-surface/50'}`}>
            {renderButtons()}
          </div>
        </div>
      </div>
    </div>
  );
}
