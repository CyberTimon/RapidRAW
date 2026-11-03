import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, XCircle, Loader2, RefreshCw, Save } from 'lucide-react';
import { motion } from 'framer-motion';
import type { PercentCrop } from 'react-image-crop';
import Button from '../ui/Button';
import LoadingCollage from '../ui/LoadingCollage';
import Text from '../ui/Text';
import PanoramaPreviewPane from './PanoramaPreviewPane';
import PanoramaSidebar from './PanoramaSidebar';
import { TextColors, TextVariants } from '../../types/typography';
import {
  PANORAMA_FULL_QUALITY,
  panoramaMessage,
  type PanoramaCropRect,
  type PanoramaMessage,
  type PanoramaPreview,
  type PanoramaProjection,
} from '../../utils/panorama';

interface PanoramaModalProps {
  error: PanoramaMessage | null;
  preview: PanoramaPreview | null;
  sourcePaths: string[];
  isOpen: boolean;
  isProcessing: boolean;
  loadingImageUrls: string[];
  onCancelSave(): void;
  onClose(): void;
  onOpenFile(path: string): void;
  onProjectionChange(projection: PanoramaProjection): void;
  onSave(crop: PanoramaCropRect, quality: number): Promise<string>;
  onStitch(): void;
  pendingProjection: PanoramaProjection | null;
  previewError: PanoramaMessage | null;
  progressMessage: PanoramaMessage | null;
  saveProgressMessage: PanoramaMessage | null;
  saveProgressPercent: number | null;
}

function cropToPercent(crop: PanoramaCropRect): PercentCrop {
  return {
    unit: '%',
    x: crop.x * 100,
    y: crop.y * 100,
    width: crop.width * 100,
    height: crop.height * 100,
  };
}

function percentToCrop(crop: PercentCrop): PanoramaCropRect {
  const x = crop.x / 100;
  const y = crop.y / 100;
  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
    width: Math.max(0.01, Math.min(1 - x, crop.width / 100)),
    height: Math.max(0.01, Math.min(1 - y, crop.height / 100)),
  };
}

export default function PanoramaModal({
  error,
  preview,
  sourcePaths,
  isOpen,
  isProcessing,
  loadingImageUrls,
  onCancelSave,
  onClose,
  onOpenFile,
  onProjectionChange,
  onSave,
  onStitch,
  pendingProjection,
  previewError,
  progressMessage,
  saveProgressMessage,
  saveProgressPercent,
}: PanoramaModalProps) {
  const { t } = useTranslation();
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [crop, setCrop] = useState<PercentCrop | null>(null);
  const [quality, setQuality] = useState(PANORAMA_FULL_QUALITY);
  const startedRef = useRef(false);
  const mouseDownTarget = useRef<EventTarget | null>(null);

  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      const timer = setTimeout(() => setShow(true), 10);
      return () => clearTimeout(timer);
    }
    setShow(false);
    setSavedPath(null);
    setIsSaving(false);
    setQuality(PANORAMA_FULL_QUALITY);
    startedRef.current = false;
    const timer = setTimeout(() => setIsMounted(false), 300);
    return () => clearTimeout(timer);
  }, [isOpen]);

  useEffect(() => {
    setCrop(preview ? cropToPercent(preview.crop) : null);
  }, [preview]);

  useEffect(() => {
    if (!isOpen || sourcePaths.length < 2 || startedRef.current) return;
    startedRef.current = true;
    onStitch();
  }, [isOpen, sourcePaths.join('\n')]);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleBackdropMouseDown = (e: React.MouseEvent) => {
    mouseDownTarget.current = e.target;
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && mouseDownTarget.current === e.currentTarget) {
      handleClose();
    }
    mouseDownTarget.current = null;
  };

  const handleSave = async () => {
    if (!crop) return;
    setIsSaving(true);
    try {
      const path = await onSave(percentToCrop(crop), quality);
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

  const showingPreview = Boolean(preview && crop) && !isProcessing;
  const showSaveProgress = isSaving || saveProgressPercent != null;
  const percent = Math.round(saveProgressPercent ?? 0);

  const renderContent = () => {
    if (error) {
      return (
        <div className="flex flex-col items-center justify-center py-10 h-[460px]">
          <div className="flex items-center justify-center mb-6">
            <XCircle className="w-12 h-12 text-red-500" />
          </div>
          <Text variant={TextVariants.title} className="mb-2 text-center">
            {t('modals.panorama.failed')}
          </Text>
          <Text className="text-left p-4 rounded-lg bg-bg-primary max-w-2xl mt-2 leading-relaxed whitespace-pre-wrap font-mono text-xs max-h-[320px] overflow-y-auto">
            {panoramaMessage(t, error)}
          </Text>
        </div>
      );
    }
    if (preview && crop && !isProcessing) {
      return (
        <div className="flex min-h-0 flex-1 gap-6">
          <PanoramaPreviewPane
            crop={crop}
            onCropChange={setCrop}
            preview={preview}
            progressMessage={progressMessage}
            reprojecting={Boolean(pendingProjection)}
          />
          <PanoramaSidebar
            disabled={isSaving}
            onProjectionChange={onProjectionChange}
            onQualityChange={setQuality}
            pendingProjection={pendingProjection}
            preview={preview}
            quality={quality}
          />
        </div>
      );
    }
    if (isProcessing) {
      return (
        <div className="flex h-[460px] overflow-hidden rounded-lg border border-surface">
          <div className="w-2/5 relative overflow-hidden shrink-0 bg-[#0a0a0a]">
            {loadingImageUrls.length > 0 ? (
              <LoadingCollage urls={loadingImageUrls} />
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
                {t('modals.panorama.stitchingProgress')}
              </Text>
              <Text className="text-center font-mono h-6 flex justify-center items-center">
                {panoramaMessage(t, progressMessage) || t('modals.panorama.initializing')}
              </Text>
              <div className="mt-8 w-64 relative">
                <div className="h-1 bg-surface rounded-full overflow-hidden relative w-full shadow-xs">
                  <motion.div
                    className="absolute inset-y-0 w-[80%] bg-linear-to-r from-transparent via-accent to-transparent mix-blend-screen"
                    style={{ filter: 'blur(3px)' }}
                    animate={{ x: ['-150%', '150%'] }}
                    transition={{ repeat: Infinity, duration: 1.5, ease: [0.4, 0, 0.2, 1] }}
                  />
                </div>
              </div>
              <Text variant={TextVariants.small} className="mt-6 text-center max-w-xs opacity-60">
                {t('modals.panorama.speedNotice')}
              </Text>
            </motion.div>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center justify-center py-10 h-[460px]">
        <Text variant={TextVariants.small} className="text-text-secondary">
          {t('modals.panorama.initializing')}
        </Text>
      </div>
    );
  };

  const renderStatus = () => {
    if (savedPath) {
      return (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
          <Text as="div" variant={TextVariants.heading} color={TextColors.success} className="flex items-center gap-2">
            <CheckCircle className="w-5 h-5" />
            <span>{t('modals.panorama.savedSuccess')}</span>
          </Text>
        </motion.div>
      );
    }
    if (showSaveProgress) {
      return (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 text-xs text-text-secondary">
            <span className="truncate font-mono">
              {panoramaMessage(t, saveProgressMessage) || t('modals.panorama.savingProgress', { percent })}
            </span>
            <span className="shrink-0 tabular-nums">{percent}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-bg-primary overflow-hidden">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-200 ease-out"
              style={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
            />
          </div>
        </div>
      );
    }
    if (previewError) {
      return (
        <Text variant={TextVariants.small} color={TextColors.error} className="whitespace-pre-line">
          {panoramaMessage(t, previewError)}
        </Text>
      );
    }
    return null;
  };

  const renderTextButton = (label: string, onClick: () => void) => (
    <button
      onClick={onClick}
      className="px-4 py-2 rounded-md text-text-secondary hover:bg-card-active transition-colors text-sm"
    >
      {label}
    </button>
  );

  const renderButtons = () => {
    if (error) {
      return (
        <>
          {renderTextButton(t('modals.panorama.close'), handleClose)}
          <Button onClick={onStitch}>
            <RefreshCw className="mr-2" size={16} />
            {t('modals.panorama.retry')}
          </Button>
        </>
      );
    }
    if (savedPath) {
      return (
        <>
          {renderTextButton(t('modals.panorama.close'), handleClose)}
          <Button onClick={handleOpen}>{t('modals.panorama.openInEditor')}</Button>
        </>
      );
    }
    if (showingPreview) {
      return (
        <>
          {isSaving
            ? renderTextButton(t('modals.panorama.cancel'), onCancelSave)
            : renderTextButton(t('modals.panorama.close'), handleClose)}
          <Button onClick={handleSave} disabled={isSaving || Boolean(pendingProjection)}>
            {isSaving ? <Loader2 className="animate-spin mr-2" size={16} /> : <Save className="mr-2" size={16} />}
            {t('modals.panorama.save')}
          </Button>
        </>
      );
    }
    return renderTextButton(t('modals.panorama.cancel'), handleClose);
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
        className={`bg-surface rounded-xl shadow-2xl p-6 flex flex-col transform transition-all duration-300 ease-out ${
          showingPreview ? 'w-[90vw] h-[85vh]' : 'w-full max-w-5xl'
        } ${show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4'}`}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {renderContent()}
        <div className="mt-4 flex items-center gap-4 pt-4 border-t border-surface/50">
          <div className="min-w-0 flex-1">{renderStatus()}</div>
          <div className="flex shrink-0 items-center gap-2">{renderButtons()}</div>
        </div>
      </div>
    </div>
  );
}
