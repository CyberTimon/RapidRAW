import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle,
  XCircle,
  Loader2,
  Save,
  RefreshCw,
  Layers,
  WandSparkles,
  Globe,
  Cylinder,
  Square,
  TriangleAlert,
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import Button from '../ui/Button';
import Slider from '../ui/Slider';
import Switch from '../ui/Switch';
import Text from '../ui/Text';
import { TextColors, TextVariants } from '../../types/typography';
import { PanoramaPreviewInfo, PanoramaProjectionMode, PanoramaSettings } from '../../types/library';

const SETTINGS_COMMIT_DELAY_MS = 250;

const PROJECTION_OPTIONS = [
  { value: 'auto', label: 'modals.panorama.projectionAuto', icon: WandSparkles },
  { value: 'spherical', label: 'modals.panorama.projectionSpherical', icon: Globe },
  { value: 'cylindrical', label: 'modals.panorama.projectionCylindrical', icon: Cylinder },
  { value: 'perspective', label: 'modals.panorama.projectionPerspective', icon: Square },
] as const;

interface PanoramaModalProps {
  error: string | null;
  finalImageBase64: string | null;
  imageCount?: number;
  isOpen: boolean;
  isProcessing: boolean;
  isUpdatingPreview: boolean;
  loadingImageUrl?: string | null;
  onClose(): void;
  onOpenFile(path: string): void;
  onSave(): Promise<string>;
  onSettingsChange(settings: PanoramaSettings): void;
  onStitch(): void;
  previewInfo: PanoramaPreviewInfo | null;
  progressMessage: string | null;
  settings: PanoramaSettings;
}

export default function PanoramaModal({
  error,
  finalImageBase64,
  imageCount,
  isOpen,
  isProcessing,
  isUpdatingPreview,
  loadingImageUrl,
  onClose,
  onOpenFile,
  onSave,
  onSettingsChange,
  onStitch,
  previewInfo,
  progressMessage,
  settings,
}: PanoramaModalProps) {
  const { t } = useTranslation();
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [draftSettings, setDraftSettings] = useState<PanoramaSettings>(settings);

  const mouseDownTarget = useRef<EventTarget | null>(null);
  const commitTimer = useRef<number | null>(null);
  const pendingSettings = useRef<PanoramaSettings | null>(null);

  useEffect(() => {
    setDraftSettings(settings);
  }, [settings]);

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

  useEffect(
    () => () => {
      if (commitTimer.current !== null) {
        window.clearTimeout(commitTimer.current);
      }
    },
    [],
  );

  const flushSettings = useCallback(() => {
    if (commitTimer.current !== null) {
      window.clearTimeout(commitTimer.current);
      commitTimer.current = null;
    }
    if (pendingSettings.current) {
      onSettingsChange(pendingSettings.current);
      pendingSettings.current = null;
    }
  }, [onSettingsChange]);

  const updateSettings = (patch: Partial<PanoramaSettings>) => {
    const next = { ...draftSettings, ...patch };
    setDraftSettings(next);
    pendingSettings.current = next;
    if (commitTimer.current !== null) {
      window.clearTimeout(commitTimer.current);
    }
    commitTimer.current = window.setTimeout(flushSettings, SETTINGS_COMMIT_DELAY_MS);
  };

  const handleClose = useCallback(() => {
    if (isSaving) return;
    if (commitTimer.current !== null) {
      window.clearTimeout(commitTimer.current);
      commitTimer.current = null;
    }
    pendingSettings.current = null;
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

  const handleSave = async () => {
    flushSettings();
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

  const projectionLabel = (value: PanoramaProjectionMode) =>
    t(PROJECTION_OPTIONS.find((option) => option.value === value)?.label ?? 'modals.panorama.projectionAuto');

  const renderProjectionNote = () => {
    if (!previewInfo || isUpdatingPreview) return null;
    if (draftSettings.projection === 'auto') {
      return t('modals.panorama.autoProjectionUsed', { projection: projectionLabel(previewInfo.projection) });
    }
    if (draftSettings.projection !== previewInfo.projection) {
      return t('modals.panorama.projectionFallback', {
        requested: projectionLabel(draftSettings.projection),
        projection: projectionLabel(previewInfo.projection),
      });
    }
    return null;
  };

  const renderOptions = () => {
    const note = renderProjectionNote();
    const disabled = isSaving;
    return (
      <div className={clsx('grid grid-cols-1 md:grid-cols-3 gap-6 mt-5', disabled && 'opacity-50 pointer-events-none')}>
        <div>
          <Text variant={TextVariants.heading} className="mb-2">
            {t('modals.panorama.projection')}
          </Text>
          <div className="grid grid-cols-2 gap-2">
            {PROJECTION_OPTIONS.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                onClick={() => updateSettings({ projection: value })}
                className={clsx(
                  'flex items-center justify-center gap-1.5 px-2 py-1.5 text-sm rounded-md transition-colors',
                  draftSettings.projection === value
                    ? 'bg-accent text-button-text'
                    : 'bg-bg-primary hover:bg-card-active',
                )}
              >
                <Icon size={14} />
                {t(label)}
              </button>
            ))}
          </div>
          <Text variant={TextVariants.small} className="mt-2 min-h-8">
            {note}
          </Text>
        </div>

        <div>
          <Slider
            label={t('modals.panorama.boundaryWarp')}
            min={0}
            max={100}
            step={1}
            defaultValue={0}
            value={draftSettings.boundaryWarp}
            onChange={(e) => updateSettings({ boundaryWarp: Number(e.target.value) })}
            fillOrigin="min"
          />
          <Text variant={TextVariants.small} className="mt-2">
            {t('modals.panorama.boundaryWarpHint')}
          </Text>
        </div>

        <div className="space-y-3">
          <Switch
            label={t('modals.panorama.autoCrop')}
            checked={draftSettings.autoCrop}
            onChange={(checked) => updateSettings({ autoCrop: checked })}
          />
          <Switch
            label={t('modals.panorama.exposureCompensation')}
            checked={draftSettings.exposureCompensation}
            onChange={(checked) => updateSettings({ exposureCompensation: checked })}
            tooltip={t('modals.panorama.exposureCompensationHint')}
          />
        </div>
      </div>
    );
  };

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
          <Text className="text-center p-4 rounded-lg bg-bg-primary max-w-md mt-2 leading-relaxed">
            {String(error)}
          </Text>
        </div>
      );
    }

    if (finalImageBase64 && !isProcessing) {
      return (
        <div className="w-full">
          <div className="relative w-full h-[360px] bg-[#111] rounded-lg overflow-hidden border border-surface flex items-center justify-center">
            <img src={finalImageBase64} alt="Stitched Panorama" className="max-w-full max-h-full object-contain" />
            <AnimatePresence>
              {isUpdatingPreview && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="absolute inset-0 flex items-center justify-center bg-black/30"
                >
                  <Loader2 className="w-8 h-8 animate-spin text-white" />
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {previewInfo && (
            <div className="flex flex-wrap items-center justify-between gap-2 mt-3">
              <Text variant={TextVariants.small}>
                {t('modals.panorama.outputInfo', {
                  images: previewInfo.imageCount,
                  width: previewInfo.width,
                  height: previewInfo.height,
                })}
              </Text>
              {previewInfo.excludedCount > 0 && (
                <Text
                  as="div"
                  variant={TextVariants.small}
                  color={TextColors.accent}
                  className="flex items-center gap-1.5"
                >
                  <TriangleAlert size={14} />
                  {t('modals.panorama.excludedImages', { count: previewInfo.excludedCount })}
                </Text>
              )}
            </div>
          )}

          {savedPath ? (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
              <Text
                as="div"
                variant={TextVariants.heading}
                color={TextColors.success}
                className="flex items-center justify-center gap-2 mt-4"
              >
                <CheckCircle className="w-5 h-5" />
                <span>{t('modals.panorama.savedSuccess')}</span>
              </Text>
            </motion.div>
          ) : (
            renderOptions()
          )}
        </div>
      );
    }

    if (isProcessing) {
      return (
        <div className="flex h-[460px] overflow-hidden rounded-lg border border-surface">
          <div className="w-2/5 relative overflow-hidden shrink-0 bg-[#0a0a0a] flex items-center justify-center">
            {loadingImageUrl ? (
              <img src={loadingImageUrl} alt="Source preview" className="w-full h-full object-cover" />
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
                {progressMessage || t('modals.panorama.initializing')}
              </Text>

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

              <Text variant={TextVariants.small} className="mt-6 text-center max-w-xs opacity-60">
                {t('modals.panorama.speedNotice')}
              </Text>
            </motion.div>
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center justify-center h-[460px]">
        <div className="flex items-center justify-center mb-6">
          <Layers className="w-12 h-12 text-accent" />
        </div>
        <Text variant={TextVariants.title} className="mb-3 text-center">
          {t('modals.panorama.title')}
        </Text>
        <Text className="text-center max-w-md leading-relaxed text-text-secondary">
          {imageCount ? t('modals.panorama.descCount', { count: imageCount }) : t('modals.panorama.descGeneric')}
        </Text>
      </div>
    );
  };

  const renderButtons = () => {
    if (error) {
      return (
        <Button onClick={handleClose} className="w-full">
          {t('modals.panorama.close')}
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
            {t('modals.panorama.close')}
          </button>
          <Button onClick={handleOpen}>{t('modals.panorama.openInEditor')}</Button>
        </>
      );
    }

    const disabled = isProcessing || isSaving;

    return (
      <div className={`w-full flex items-center justify-end gap-2 ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
        <button
          onClick={handleClose}
          className="px-4 py-2 rounded-md text-text-secondary hover:bg-card-active transition-colors text-sm"
        >
          {finalImageBase64 ? t('modals.panorama.close') : t('modals.panorama.cancel')}
        </button>

        <Button onClick={onStitch} disabled={isProcessing} variant={finalImageBase64 ? 'secondary' : 'primary'}>
          {isProcessing ? (
            <Loader2 className="animate-spin mr-2" size={16} />
          ) : finalImageBase64 ? (
            <RefreshCw className="mr-2" size={16} />
          ) : (
            <Layers className="mr-2" size={16} />
          )}
          {finalImageBase64 ? t('modals.panorama.retry') : t('modals.panorama.start')}
        </Button>

        {finalImageBase64 && (
          <Button onClick={handleSave} disabled={isSaving || isProcessing || isUpdatingPreview}>
            {isSaving ? <Loader2 className="animate-spin mr-2" size={16} /> : <Save className="mr-2" size={16} />}
            {isSaving ? t('modals.panorama.saving') : t('modals.panorama.save')}
          </Button>
        )}
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
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
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
