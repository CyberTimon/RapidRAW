import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle,
  Cylinder,
  Globe,
  Images,
  Layers,
  Loader2,
  LucideIcon,
  Map as MapIcon,
  RefreshCw,
  Save,
  Square,
  SquaresUnite,
  TriangleAlert,
  WandSparkles,
  XCircle,
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import Button from '../ui/Button';
import Slider from '../ui/Slider';
import Switch from '../ui/Switch';
import Text from '../ui/Text';
import { TextColors, TextVariants } from '../../types/typography';
import {
  FocusStackSettings,
  MergeKind,
  MergeSettings,
  PanoramaProjectionMode,
  PanoramaSettings,
} from '../../types/library';
import { MergeModalState } from '../../store/useUIStore';

const SETTINGS_COMMIT_DELAY_MS = 250;

const TOOL_ICONS: Record<MergeKind, { icon: LucideIcon; overlayIcon?: LucideIcon }> = {
  panorama: { icon: SquaresUnite },
  hdr: { icon: Images },
  focusStack: { icon: Layers, overlayIcon: MapIcon },
};

interface ToolText {
  description: string;
  failed: string;
  overlay?: string;
  processing: string;
  savedSuccess: string;
  title: string;
}

function useToolText(kind: MergeKind, count: number): ToolText {
  const { t } = useTranslation();
  switch (kind) {
    case 'hdr':
      return {
        description: count ? t('modals.hdr.descriptionWithCount', { count }) : t('modals.hdr.description'),
        failed: t('modals.hdr.failed'),
        processing: t('modals.hdr.processing'),
        savedSuccess: t('modals.hdr.savedSuccess'),
        title: t('modals.hdr.title'),
      };
    case 'focusStack':
      return {
        description: count
          ? t('modals.focusStack.descriptionWithCount', { count })
          : t('modals.focusStack.description'),
        failed: t('modals.focusStack.failed'),
        overlay: t('modals.focusStack.depthMap'),
        processing: t('modals.focusStack.processing'),
        savedSuccess: t('modals.focusStack.savedSuccess'),
        title: t('modals.focusStack.title'),
      };
    default:
      return {
        description: count ? t('modals.panorama.descriptionWithCount', { count }) : t('modals.panorama.description'),
        failed: t('modals.panorama.failed'),
        processing: t('modals.panorama.processing'),
        savedSuccess: t('modals.panorama.savedSuccess'),
        title: t('modals.panorama.title'),
      };
  }
}

const PROJECTION_OPTIONS = [
  { value: 'auto', label: 'modals.panorama.projectionAuto', icon: WandSparkles },
  { value: 'spherical', label: 'modals.panorama.projectionSpherical', icon: Globe },
  { value: 'cylindrical', label: 'modals.panorama.projectionCylindrical', icon: Cylinder },
  { value: 'perspective', label: 'modals.panorama.projectionPerspective', icon: Square },
] as const;

const METHOD_OPTIONS = [
  { value: 'detail', label: 'modals.focusStack.methodDetail' },
  { value: 'smooth', label: 'modals.focusStack.methodSmooth' },
] as const;

interface SegmentedOption<T extends string> {
  icon?: LucideIcon;
  label: string;
  value: T;
}

interface SegmentedProps<T extends string> {
  onChange(value: T): void;
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
}

function Segmented<T extends string>({ onChange, options, value }: SegmentedProps<T>) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {options.map(({ value: optionValue, label, icon: Icon }) => (
        <button
          key={optionValue}
          onClick={() => onChange(optionValue)}
          className={clsx(
            'flex items-center justify-center gap-1.5 px-2 py-1.5 text-sm rounded-md transition-colors',
            value === optionValue ? 'bg-accent text-button-text' : 'bg-bg-primary hover:bg-card-active',
          )}
        >
          {Icon && <Icon size={14} />}
          {label}
        </button>
      ))}
    </div>
  );
}

interface MergeModalProps {
  loadingImageUrl: string | null;
  onClose(): void;
  onOpenFile(path: string): void;
  onSave(): Promise<string>;
  onSettingsChange(settings: MergeSettings): void;
  onStart(): void;
  state: MergeModalState;
}

export default function MergeModal({
  loadingImageUrl,
  onClose,
  onOpenFile,
  onSave,
  onSettingsChange,
  onStart,
  state,
}: MergeModalProps) {
  const { t } = useTranslation();
  const { error, isOpen, isProcessing, isUpdatingPreview, kind, preview, progressMessage, settings, sourcePaths } =
    state;
  const tool = TOOL_ICONS[kind];
  const text = useToolText(kind, sourcePaths.length);
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [showOverlay, setShowOverlay] = useState(false);
  const [draftSettings, setDraftSettings] = useState<MergeSettings>(settings);

  const mouseDownTarget = useRef<EventTarget | null>(null);
  const commitTimer = useRef<number | null>(null);
  const pendingSettings = useRef<MergeSettings | null>(null);

  useEffect(() => {
    setDraftSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      const timer = setTimeout(() => setShow(true), 10);
      return () => clearTimeout(timer);
    }
    setShow(false);
    const timer = setTimeout(() => {
      setIsMounted(false);
      setSavedPath(null);
      setIsSaving(false);
      setShowOverlay(false);
    }, 300);
    return () => clearTimeout(timer);
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

  const updateSettings = (patch: Partial<MergeSettings>) => {
    const next = { ...draftSettings, ...patch } as MergeSettings;
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

  const renderAutoCrop = (autoCrop: boolean) => (
    <Switch
      label={t('modals.merge.autoCrop')}
      checked={autoCrop}
      onChange={(checked) => updateSettings({ autoCrop: checked })}
      tooltip={t('modals.merge.autoCropHint')}
    />
  );

  const renderPanoramaOptions = (panorama: PanoramaSettings) => {
    const projectionLabel = (value: PanoramaProjectionMode) =>
      t(PROJECTION_OPTIONS.find((option) => option.value === value)?.label ?? 'modals.panorama.projectionAuto');
    let note = null;
    if (preview?.projection && !isUpdatingPreview) {
      if (panorama.projection === 'auto') {
        note = t('modals.panorama.autoProjectionUsed', { projection: projectionLabel(preview.projection) });
      } else if (panorama.projection !== preview.projection) {
        note = t('modals.panorama.projectionFallback', {
          requested: projectionLabel(panorama.projection),
          projection: projectionLabel(preview.projection),
        });
      }
    }
    return (
      <>
        <div>
          <Text variant={TextVariants.heading} className="mb-2">
            {t('modals.panorama.projection')}
          </Text>
          <Segmented
            options={PROJECTION_OPTIONS.map((option) => ({ ...option, label: t(option.label) }))}
            value={panorama.projection}
            onChange={(projection) => updateSettings({ projection })}
          />
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
            value={panorama.boundaryWarp}
            onChange={(e) => updateSettings({ boundaryWarp: Number(e.target.value) })}
            fillOrigin="min"
          />
          <Text variant={TextVariants.small} className="mt-2">
            {t('modals.panorama.boundaryWarpHint')}
          </Text>
        </div>
        <div className="space-y-3">
          {renderAutoCrop(panorama.autoCrop)}
          <Switch
            label={t('modals.panorama.exposureCompensation')}
            checked={panorama.exposureCompensation}
            onChange={(exposureCompensation) => updateSettings({ exposureCompensation })}
            tooltip={t('modals.panorama.exposureCompensationHint')}
          />
        </div>
      </>
    );
  };

  const renderFocusStackOptions = (focusStack: FocusStackSettings) => (
    <>
      <div>
        <Text variant={TextVariants.heading} className="mb-2">
          {t('modals.focusStack.method')}
        </Text>
        <Segmented
          options={METHOD_OPTIONS.map((option) => ({ ...option, label: t(option.label) }))}
          value={focusStack.method}
          onChange={(method) => updateSettings({ method })}
        />
        <Text variant={TextVariants.small} className="mt-2">
          {t('modals.focusStack.methodHint')}
        </Text>
      </div>
      <div className="space-y-3">{renderAutoCrop(focusStack.autoCrop)}</div>
    </>
  );

  const renderOptions = () => (
    <div className={clsx('grid grid-cols-1 md:grid-cols-3 gap-6 mt-5', isSaving && 'opacity-50 pointer-events-none')}>
      {kind === 'panorama' && renderPanoramaOptions(draftSettings as PanoramaSettings)}
      {kind === 'hdr' && <div className="space-y-3">{renderAutoCrop(draftSettings.autoCrop)}</div>}
      {kind === 'focusStack' && renderFocusStackOptions(draftSettings as FocusStackSettings)}
    </div>
  );

  const renderOverlayToggle = () => {
    if (!preview?.overlayBase64 || !text.overlay || !tool.overlayIcon) return null;
    const OverlayIcon = tool.overlayIcon;
    const ToolIcon = tool.icon;
    return (
      <div
        className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-black/70 backdrop-blur-md p-1.5 rounded-full border border-white/10 shadow-xl z-20 opacity-0 group-hover:opacity-100 transition-opacity duration-200"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {[
          { active: !showOverlay, icon: ToolIcon, label: t('modals.merge.result'), value: false },
          { active: showOverlay, icon: OverlayIcon, label: text.overlay, value: true },
        ].map(({ active, icon: Icon, label, value }) => (
          <button
            key={label}
            type="button"
            onClick={() => setShowOverlay(value)}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors select-none',
              active ? 'bg-accent text-button-text' : 'text-white/60 hover:bg-white/10 hover:text-white',
            )}
          >
            <Icon size={14} />
            <span>{label}</span>
          </button>
        ))}
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
            {text.failed}
          </Text>
          <Text className="text-center p-4 rounded-lg bg-bg-primary max-w-md mt-2 leading-relaxed">
            {String(error)}
          </Text>
        </div>
      );
    }

    if (preview && !isProcessing) {
      const imageSrc = showOverlay && preview.overlayBase64 ? preview.overlayBase64 : preview.base64;
      return (
        <div className="w-full">
          <div className="group relative w-full h-[360px] bg-[#111] rounded-lg overflow-hidden border border-surface flex items-center justify-center select-none">
            <img src={imageSrc} alt={text.title} className="max-w-full max-h-full object-contain" draggable={false} />
            {renderOverlayToggle()}
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

          <div className="flex flex-wrap items-center justify-between gap-2 mt-3">
            <Text variant={TextVariants.small}>
              {isSaving && progressMessage
                ? progressMessage
                : t('modals.merge.outputInfo', {
                    images: preview.imageCount,
                    width: preview.width,
                    height: preview.height,
                  })}
            </Text>
            {(preview.excludedCount > 0 || preview.unalignedCount > 0) && (
              <Text
                as="div"
                variant={TextVariants.small}
                color={TextColors.accent}
                className="flex items-center gap-1.5"
              >
                <TriangleAlert size={14} />
                {preview.excludedCount > 0
                  ? t('modals.merge.excludedImages', { count: preview.excludedCount })
                  : t('modals.merge.unalignedImages', { count: preview.unalignedCount })}
              </Text>
            )}
          </div>

          {savedPath ? (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
              <Text
                as="div"
                variant={TextVariants.heading}
                color={TextColors.success}
                className="flex items-center justify-center gap-2 mt-4"
              >
                <CheckCircle className="w-5 h-5" />
                <span>{text.savedSuccess}</span>
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
                {text.processing}
              </Text>
              <Text className="text-center font-mono h-6 flex justify-center items-center">
                {progressMessage || t('modals.merge.initializing')}
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
                {t('modals.merge.speedNotice')}
              </Text>
            </motion.div>
          </div>
        </div>
      );
    }

    const ToolIcon = tool.icon;
    return (
      <div className="flex flex-col items-center justify-center h-[460px]">
        <div className="flex items-center justify-center mb-6">
          <ToolIcon className="w-12 h-12 text-accent" />
        </div>
        <Text variant={TextVariants.title} className="mb-3 text-center">
          {text.title}
        </Text>
        <Text className="text-center max-w-md leading-relaxed text-text-secondary">{text.description}</Text>
      </div>
    );
  };

  const renderButtons = () => {
    if (error) {
      return (
        <Button onClick={handleClose} className="w-full">
          {t('modals.merge.close')}
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
            {t('modals.merge.close')}
          </button>
          <Button onClick={handleOpen}>{t('modals.merge.openInEditor')}</Button>
        </>
      );
    }

    const disabled = isProcessing || isSaving;
    const ToolIcon = tool.icon;

    return (
      <div className={clsx('w-full flex items-center justify-end gap-2', disabled && 'opacity-50 pointer-events-none')}>
        <button
          onClick={handleClose}
          className="px-4 py-2 rounded-md text-text-secondary hover:bg-card-active transition-colors text-sm"
        >
          {preview ? t('modals.merge.close') : t('modals.merge.cancel')}
        </button>

        <Button onClick={onStart} disabled={isProcessing} variant={preview ? 'secondary' : 'primary'}>
          {isProcessing ? (
            <Loader2 className="animate-spin mr-2" size={16} />
          ) : preview ? (
            <RefreshCw className="mr-2" size={16} />
          ) : (
            <ToolIcon className="mr-2" size={16} />
          )}
          {preview ? t('modals.merge.retry') : t('modals.merge.start')}
        </Button>

        {preview && (
          <Button onClick={handleSave} disabled={isSaving || isProcessing || isUpdatingPreview}>
            {isSaving ? <Loader2 className="animate-spin mr-2" size={16} /> : <Save className="mr-2" size={16} />}
            {isSaving ? t('modals.merge.saving') : t('modals.merge.save')}
          </Button>
        )}
      </div>
    );
  };

  if (!isMounted) return null;

  return (
    <div
      className={clsx(
        'fixed inset-0 flex items-center justify-center z-50 bg-black/40 backdrop-blur-xs transition-opacity duration-300 ease-in-out',
        show ? 'opacity-100' : 'opacity-0',
      )}
      onMouseDown={handleBackdropMouseDown}
      onClick={handleBackdropClick}
    >
      <div
        className={clsx(
          'bg-surface rounded-xl shadow-2xl p-6 w-full max-w-4xl transform transition-all duration-300 ease-out',
          show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4',
        )}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col">
          {renderContent()}
          <div className={clsx('mt-4 flex justify-end gap-3', !savedPath && 'pt-4 border-t border-surface/50')}>
            {renderButtons()}
          </div>
        </div>
      </div>
    </div>
  );
}
