import { memo, useState, useEffect, useRef, useMemo } from 'react';
import {
  ArrowLeft,
  Columns2,
  Eye,
  EyeOff,
  Loader2,
  LucideIcon,
  Maximize,
  Redo,
  SquareSplitHorizontal,
  SquareSplitVertical,
  Undo,
} from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { CompareMode, GroupingMode } from '../../../types/settings';
import { SelectedImage } from '../../../types/editor';
import { ToolbarMenu, ToolbarMenuItem, useMenuDismiss } from './ToolbarMenu';
import { IconAperture, IconCalendar, IconClock, IconFocalLength, IconIso, IconShutter } from './ExifIcons';
import Text from '../../ui/Text';
import ViewerZoom from '../ViewerZoom';
import { JobsMenu } from '../library/JobsMenu';
import { TextColors, TextVariants, TextWeights } from '../../../types/typography';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { useCompareAvailable, useHistoryList, useVideoKind, useViewerHeader } from '../../../store/videoIntegration';
import { useDisplayStatus } from '../../../hooks/useDisplayStatus';
import { useShortcut, useShortcuts } from '../../../hooks/useShortcuts';
import { findGroupVariants, getVariantLabel } from '../../../utils/imageGrouping';
import { formatFocalLength } from '../../../utils/exif';

const COMPARE_MODES = [
  { mode: 'toggle', icon: Eye, label: 'editor.compare.toggle' },
  { mode: 'vertical', icon: SquareSplitHorizontal, label: 'editor.compare.vertical' },
  { mode: 'horizontal', icon: SquareSplitVertical, label: 'editor.compare.horizontal' },
  { mode: 'sideBySide', icon: Columns2, label: 'editor.compare.sideBySide' },
] as const satisfies ReadonlyArray<{ mode: CompareMode; icon: LucideIcon; label: string }>;

interface CompareButtonProps {
  compareMode: CompareMode;
  isComparing: boolean;
  onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>): void;
  onSelectMode(mode: CompareMode): void;
  onToggle(): void;
}

function HdrButton({ onKeyDown }: { onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>): void }) {
  const { t } = useTranslation();
  const isEnabled = useSettingsStore((state) => state.appSettings?.hdrDisplay ?? false);

  const handleToggle = () => {
    const { appSettings, handleSettingsChange } = useSettingsStore.getState();
    if (appSettings) {
      handleSettingsChange({ ...appSettings, hdrDisplay: !appSettings.hdrDisplay });
    }
  };

  return (
    <button
      className={clsx(
        'p-2 rounded-full transition-colors',
        isEnabled
          ? 'bg-accent text-button-text hover:bg-accent/90 hover:text-button-text'
          : 'bg-surface hover:bg-card-active text-text-primary',
      )}
      onClick={handleToggle}
      onKeyDown={onKeyDown}
      data-tooltip={t('editor.toolbar.tooltips.hdr')}
    >
      <div className="w-5 h-5 flex items-center justify-center text-[10px] font-bold leading-none tracking-tight">
        HDR
      </div>
    </button>
  );
}

function CompareButton({ compareMode, isComparing, onKeyDown, onSelectMode, onToggle }: CompareButtonProps) {
  const { t } = useTranslation();
  const shortcut = useShortcut('show_original');
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useMenuDismiss(containerRef, isMenuOpen, setIsMenuOpen);

  const ModeIcon =
    compareMode === 'toggle' && isComparing ? EyeOff : COMPARE_MODES.find((m) => m.mode === compareMode)!.icon;

  return (
    <div className="relative" ref={containerRef}>
      <button
        className={clsx(
          'p-2 rounded-full transition-colors',
          isComparing
            ? 'bg-accent text-button-text hover:bg-accent/90 hover:text-button-text'
            : 'bg-surface hover:bg-card-active text-text-primary',
        )}
        onClick={onToggle}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => {
          e.preventDefault();
          setIsMenuOpen((prev) => !prev);
        }}
        data-tooltip={t('editor.toolbar.tooltips.compare')}
        {...shortcut}
      >
        <ModeIcon size={20} />
      </button>

      <ToolbarMenu isOpen={isMenuOpen} title={t('editor.compare.title')}>
        {COMPARE_MODES.map(({ mode, icon, label }) => (
          <ToolbarMenuItem
            key={mode}
            icon={icon}
            isSelected={mode === compareMode}
            label={t(label)}
            onClick={() => {
              onSelectMode(mode);
              setIsMenuOpen(false);
            }}
            onKeyDown={onKeyDown}
          />
        ))}
      </ToolbarMenu>
    </div>
  );
}

interface EditorToolbarProps {
  canRedo: boolean;
  canUndo: boolean;
  isAndroid: boolean;
  isLoading: boolean;
  onBackToLibrary(): void;
  onImageSelect?(path: string, event?: any): void;
  onRedo(): void;
  onToggleFullScreen(): void;
  onToggleCompare(): void;
  onSelectCompareMode(mode: CompareMode): void;
  onUndo(): void;
  selectedImage: SelectedImage;
  isComparing: boolean;
  compareMode: CompareMode;
  showDateView: boolean;
  onToggleDateView(): void;
  onZoomChange(zoomValue: number, fitToWindow?: boolean): void;
}

const EditorToolbar = memo(
  ({
    canRedo,
    canUndo,
    isAndroid,
    isLoading,
    onBackToLibrary,
    onImageSelect,
    onRedo,
    onToggleFullScreen,
    onToggleCompare,
    onSelectCompareMode,
    onUndo,
    selectedImage,
    isComparing,
    compareMode,
    showDateView,
    onToggleDateView,
    onZoomChange,
  }: EditorToolbarProps) => {
    const { t } = useTranslation();
    const shortcut = useShortcuts();
    const canCompare = useCompareAvailable();
    const inVideo = useVideoKind() !== 'none';
    const isAnyLoading = isLoading;
    const [isLoaderVisible, setIsLoaderVisible] = useState(false);
    const [isLoaderMounted, setIsLoaderMounted] = useState(false);
    const [disableLoaderTransition, setDisableLoaderTransition] = useState(false);
    const hideTimeoutRef = useRef<number | null>(null);
    const prevIsLoadingRef = useRef(isLoading);
    const [isVcHovered, setIsVcHovered] = useState(false);
    const [isInfoHovered, setIsInfoHovered] = useState(false);
    const [isHistoryVisible, setIsHistoryVisible] = useState(false);
    const historyButtonRef = useRef<HTMLDivElement>(null);
    useMenuDismiss(historyButtonRef, isHistoryVisible, setIsHistoryVisible);
    const history = useHistoryList(isHistoryVisible);

    const [displayedResolution, setDisplayedResolution] = useState('');

    const imageList = useLibraryStore((s) => s.imageList);
    const groupingMode: GroupingMode = useSettingsStore((s) => s.appSettings?.grouping) ?? 'off';

    const variantOptions = useMemo(() => {
      if (groupingMode === 'off' || !onImageSelect) return [];
      const isVC = selectedImage.path.includes('?vc=');
      if (isVC) return [];
      const variants = findGroupVariants(imageList, selectedImage.group_id);
      if (variants.length < 2) return [];
      return variants.map((v) => ({ path: v.path, label: getVariantLabel(v.path) }));
    }, [groupingMode, selectedImage.path, imageList, onImageSelect]);

    const { baseName, isVirtualCopy, vcId, exifData, hasExif } = useMemo(() => {
      const path = selectedImage.path;
      const parts = path.split('?vc=');
      const fullFileName = parts[0].split(/[\\/]/).pop() || '';

      const exif = selectedImage.exif || {};

      let fNum = exif.FNumber;
      if (fNum) {
        const fStr = String(fNum);
        fNum = fStr.toLowerCase().startsWith('f') ? fStr : `f/${fStr}`;
      }

      let captureDate = null;
      let captureTime = null;

      if (exif.DateTimeOriginal) {
        const dateTimeParts = exif.DateTimeOriginal.split(' ');
        captureDate = dateTimeParts[0]?.replace(/:/g, '-') || null;
        if (dateTimeParts[1]) {
          const timeParts = dateTimeParts[1].split(':');
          captureTime = `${timeParts[0]}:${timeParts[1]}`;
        }
      }

      const data = {
        iso: exif.PhotographicSensitivity || exif.ISO,
        fNumber: fNum,
        shutter: exif.ExposureTime,
        focal: exif.FocalLengthIn35mmFilm,
        captureDate: captureDate,
        captureTime: captureTime,
      };

      const hasData = !!(data.iso || data.fNumber || data.shutter || data.focal || data.captureDate);

      return {
        baseName: fullFileName,
        isVirtualCopy: parts.length > 1,
        vcId: parts.length > 1 ? parts[1] : null,
        exifData: data,
        hasExif: hasData,
      };
    }, [selectedImage.path, selectedImage.exif]);

    const { title, details, inProject, unsaved } = useViewerHeader(baseName, selectedImage);
    const resolution = details.join(' · ');
    const showResolution = !isAndroid && details.length > 0;

    useEffect(() => {
      if (showResolution) {
        setDisplayedResolution(` - ${resolution}`);
      }
    }, [showResolution, resolution]);

    useEffect(() => {
      const wasLoadingResolution = prevIsLoadingRef.current && !isLoading;

      if (isAnyLoading) {
        if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
        setDisableLoaderTransition(false);
        setIsLoaderVisible(true);
      } else if (isLoaderVisible) {
        if (wasLoadingResolution) {
          setDisableLoaderTransition(true);
          setIsLoaderVisible(false);
        } else {
          setDisableLoaderTransition(false);
          hideTimeoutRef.current = window.setTimeout(() => {
            setIsLoaderVisible(false);
          }, 300);
        }
      }

      prevIsLoadingRef.current = isLoading;

      return () => {
        if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
      };
    }, [isAnyLoading, isLoading, isLoaderVisible]);

    useEffect(() => {
      if (isLoaderVisible) {
        setIsLoaderMounted(true);
      } else if (disableLoaderTransition) {
        setIsLoaderMounted(false);
      }
    }, [isLoaderVisible, disableLoaderTransition]);

    useEffect(() => {
      if (isHistoryVisible) {
        const timer = setTimeout(() => {
          const activeEl = historyButtonRef.current?.querySelector('[data-active="true"]');
          if (activeEl) {
            activeEl.scrollIntoView({ block: 'nearest', behavior: 'auto' });
          }
        }, 10);
        return () => clearTimeout(timer);
      }
    }, [isHistoryVisible, history.index]);

    const isHdrAvailable = useDisplayStatus()?.hdrActive ?? false;

    const handleButtonKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'Tab') return;
      e.currentTarget.blur();
    };

    const isExpanded = isInfoHovered && (hasExif || isLoading);

    const titleRow = (
      <div
        className={clsx(
          'flex items-center justify-center max-w-full h-5 shrink-0',
          inProject && 'flex-wrap overflow-hidden',
        )}
      >
        <div className="flex items-center min-w-0 h-5">
          <Text
            as="span"
            variant={TextVariants.small}
            color={TextColors.primary}
            weight={TextWeights.medium}
            className="truncate min-w-0 shrink"
          >
            {title}
          </Text>

          {unsaved && (
            <Text as="span" variant={TextVariants.small} color={TextColors.secondary} className="ml-2 shrink-0">
              {t('video.project.unsaved')}
            </Text>
          )}
        </div>

        {isVirtualCopy && (
          <Text
            as="div"
            variant={TextVariants.small}
            color={TextColors.accent}
            weight={TextWeights.bold}
            className="ml-2 shrink-0 bg-accent/20 px-2 py-0.5 rounded-full flex items-center overflow-hidden cursor-default"
            onMouseEnter={() => setIsVcHovered(true)}
            onMouseLeave={() => setIsVcHovered(false)}
          >
            <span>{t('editor.toolbar.vc')}</span>
            <div
              className={clsx(
                'transition-all duration-300 ease-out overflow-hidden whitespace-nowrap',
                isVcHovered ? 'max-w-20 opacity-100' : 'max-w-0 opacity-0',
              )}
            >
              <span>-{vcId}</span>
            </div>
          </Text>
        )}

        {variantOptions.length > 0 && (
          <div className="flex items-center ml-2 shrink-0 border border-text-secondary/20 rounded-full overflow-hidden">
            {variantOptions.map((v) => {
              const isActive = v.path === selectedImage.path;
              return (
                <button
                  key={v.path}
                  disabled={isActive}
                  className={clsx(
                    'px-2.5 py-1 text-[11px] font-medium transition-colors',
                    isActive ? 'bg-surface text-text-primary' : 'text-text-secondary hover:bg-surface/50',
                  )}
                  data-tooltip={t('editor.toolbar.switchToVariant', { label: v.label })}
                  onClick={(e) => onImageSelect?.(v.path, e)}
                  onKeyDown={handleButtonKeyDown}
                >
                  {v.label}
                </button>
              );
            })}
          </div>
        )}

        {inProject ? (
          showResolution &&
          details.map((detail, index) => (
            <Text
              key={index}
              as="span"
              variant={TextVariants.small}
              className={clsx('shrink-0 whitespace-nowrap leading-5', index === 0 ? 'ml-2' : 'ml-1')}
            >
              · {detail}
            </Text>
          ))
        ) : (
          <div
            className={clsx(
              'transition-all duration-300 ease-out overflow-hidden whitespace-nowrap shrink-0',
              showResolution ? 'max-w-40 opacity-100 ml-2' : 'max-w-0 opacity-0 ml-0',
            )}
          >
            <Text
              as="span"
              variant={TextVariants.small}
              className={clsx(
                'block transition-transform duration-200 delay-100',
                showResolution ? 'scale-100' : 'scale-95',
              )}
            >
              {displayedResolution}
            </Text>
          </div>
        )}

        <div
          className={clsx(
            'overflow-hidden shrink-0',
            isLoaderVisible ? 'max-w-4 opacity-100 ml-2' : 'max-w-0 opacity-0 ml-0',
            disableLoaderTransition ? 'transition-none' : 'transition-all duration-300',
          )}
          onTransitionEnd={(e) => {
            if (e.propertyName === 'opacity' && !isLoaderVisible) {
              setIsLoaderMounted(false);
            }
          }}
        >
          {isLoaderMounted && <Loader2 size={12} className="text-text-secondary animate-spin" />}
        </div>
      </div>
    );

    return (
      <div
        className={clsx(
          'relative shrink-0 px-3 h-12 gap-3 z-40',
          inProject
            ? '@container grid grid-cols-[1fr_minmax(0,auto)_1fr] items-center'
            : 'flex items-center justify-between',
        )}
      >
        <div className="flex items-center gap-2 shrink-0 z-40">
          <button
            className="bg-surface text-text-primary p-2 rounded-full hover:bg-card-active transition-colors shrink-0"
            onClick={onBackToLibrary}
            onKeyDown={handleButtonKeyDown}
            data-tooltip={t('editor.toolbar.tooltips.backToLibrary')}
            data-bench-id="back-to-library"
          >
            <ArrowLeft size={20} />
          </button>

          {!inProject && (
            <div className="hidden 2xl:flex items-center gap-2" aria-hidden="true">
              <div className="p-2 invisible pointer-events-none">
                <Undo size={20} />
              </div>
              <div className="p-2 invisible pointer-events-none">
                <Undo size={20} />
              </div>
              <div className="p-2 invisible pointer-events-none">
                <Undo size={20} />
              </div>
              <div className="p-2 invisible pointer-events-none">
                <Undo size={20} />
              </div>
              {isHdrAvailable && (
                <div className="p-2 invisible pointer-events-none">
                  <Undo size={20} />
                </div>
              )}
            </div>
          )}
        </div>

        <div className={clsx('min-w-0 relative h-full', !inProject && 'flex-1 flex justify-center')}>
          {inProject && (
            <div className="invisible h-0 px-4 overflow-hidden" aria-hidden="true">
              {titleRow}
            </div>
          )}
          <div
            className={clsx(
              'bg-surface flex flex-col items-center overflow-hidden transition-all duration-200 ease-out pt-2',
              isExpanded
                ? 'h-18 px-8 rounded-2xl absolute min-w-85 whitespace-nowrap shadow-2xl shadow-black/50'
                : clsx(
                    'h-9 px-4 rounded-[18px] absolute min-w-0 max-w-full shadow-none',
                    inProject ? 'w-max' : 'w-auto',
                  ),
            )}
            onMouseEnter={() => setIsInfoHovered(true)}
            onMouseLeave={() => setIsInfoHovered(false)}
            style={{
              top: '6px',
              transform: 'translateX(-50%)',
              left: '50%',
              zIndex: isExpanded ? 50 : 0,
            }}
          >
            {titleRow}

            <div
              className={clsx(
                'relative mt-2 w-full grow justify-center border-t border-text-secondary/10 pt-2 transition-opacity duration-200',
                isExpanded ? 'opacity-100 delay-75' : 'opacity-0 hidden',
                hasExif && 'cursor-pointer',
              )}
              onClick={() => hasExif && onToggleDateView()}
            >
              <div
                className={clsx(
                  'absolute inset-0 flex items-center justify-center gap-6 transition-opacity duration-200',
                  showDateView ? 'opacity-0 pointer-events-none' : 'opacity-100',
                )}
              >
                {exifData.shutter && (
                  <div className="flex items-center gap-1.5" data-tooltip={t('editor.toolbar.tooltips.shutterSpeed')}>
                    <Text as="span">
                      <IconShutter />
                    </Text>
                    <Text as="span" variant={TextVariants.small} color={TextColors.primary} weight={TextWeights.medium}>
                      {exifData.shutter}
                    </Text>
                  </div>
                )}
                {exifData.fNumber && (
                  <div className="flex items-center gap-1.5" data-tooltip={t('editor.toolbar.tooltips.aperture')}>
                    <Text as="span">
                      <IconAperture />
                    </Text>
                    <Text as="span" variant={TextVariants.small} color={TextColors.primary} weight={TextWeights.medium}>
                      {exifData.fNumber}
                    </Text>
                  </div>
                )}
                {exifData.iso && (
                  <div className="flex items-center gap-1.5" data-tooltip={t('editor.toolbar.tooltips.iso')}>
                    <Text as="span">
                      <IconIso />
                    </Text>
                    <Text as="span" variant={TextVariants.small} color={TextColors.primary} weight={TextWeights.medium}>
                      {exifData.iso}
                    </Text>
                  </div>
                )}
                {exifData.focal && (
                  <div className="flex items-center gap-1.5" data-tooltip={t('editor.toolbar.tooltips.focalLength')}>
                    <Text as="span">
                      <IconFocalLength />
                    </Text>
                    <Text as="span" variant={TextVariants.small} color={TextColors.primary} weight={TextWeights.medium}>
                      {formatFocalLength(exifData.focal)}
                    </Text>
                  </div>
                )}
              </div>

              <div
                className={clsx(
                  'absolute inset-0 flex items-center justify-center gap-6 transition-opacity duration-200',
                  showDateView ? 'opacity-100' : 'opacity-0 pointer-events-none',
                )}
              >
                {exifData.captureDate && (
                  <div className="flex items-center gap-2">
                    <Text as="span">
                      <IconCalendar />
                    </Text>
                    <Text as="span" variant={TextVariants.small} color={TextColors.primary} weight={TextWeights.medium}>
                      {exifData.captureDate}
                    </Text>
                  </div>
                )}
                {exifData.captureTime && (
                  <div className="flex items-center gap-2">
                    <Text as="span">
                      <IconClock />
                    </Text>
                    <Text as="span" variant={TextVariants.small} color={TextColors.primary} weight={TextWeights.medium}>
                      {exifData.captureTime}
                    </Text>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 shrink-0 z-40">
          {inVideo && <JobsMenu compact />}
          {inProject && !isAndroid && (
            <div className="h-9 px-3 rounded-full bg-surface flex items-center">
              <ViewerZoom
                fitContent
                trackClassName="bg-card-active"
                sliderClassName="@max-[46rem]:hidden"
                isLoading={isLoading}
                onZoomChange={onZoomChange}
              />
            </div>
          )}
          <div className="relative flex items-center gap-2" ref={historyButtonRef}>
            <button
              className="bg-surface text-text-primary p-2 rounded-full hover:bg-card-active transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={!canUndo}
              onClick={onUndo}
              onKeyDown={handleButtonKeyDown}
              onContextMenu={(e) => {
                e.preventDefault();
                setIsHistoryVisible((prev) => !prev);
              }}
              data-tooltip={t('editor.toolbar.tooltips.undo')}
              data-bench-id="undo"
              {...shortcut(['video_undo', 'undo'])}
            >
              <Undo size={20} />
            </button>
            <button
              className="bg-surface text-text-primary p-2 rounded-full hover:bg-card-active transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={!canRedo}
              onClick={onRedo}
              onKeyDown={handleButtonKeyDown}
              onContextMenu={(e) => {
                e.preventDefault();
                setIsHistoryVisible((prev) => !prev);
              }}
              data-tooltip={t('editor.toolbar.tooltips.redo')}
              {...shortcut(['video_redo', 'redo'])}
            >
              <Redo size={20} />
            </button>

            <ToolbarMenu
              className="w-96 max-w-[calc(100vw-1.5rem)]"
              isOpen={isHistoryVisible && history.labels.length > 1}
              title={t('editor.toolbar.history')}
            >
              {history.labels.map((label, i) => (
                <ToolbarMenuItem
                  key={i}
                  detail={i > 0 ? i : undefined}
                  isDimmed={i > history.index}
                  isSelected={i === history.index}
                  label={label || 'Initial State'}
                  onClick={() => history.goTo(i)}
                  onKeyDown={handleButtonKeyDown}
                  tooltip={label}
                  wrap
                />
              ))}
            </ToolbarMenu>
          </div>

          {canCompare && (
            <CompareButton
              compareMode={compareMode}
              isComparing={isComparing}
              onKeyDown={handleButtonKeyDown}
              onSelectMode={onSelectCompareMode}
              onToggle={onToggleCompare}
            />
          )}
          {isHdrAvailable && <HdrButton onKeyDown={handleButtonKeyDown} />}
          <button
            className="bg-surface text-text-primary p-2 rounded-full hover:bg-card-active transition-colors disabled:opacity-50 disabled:cursor-not-allowed relative"
            onClick={onToggleFullScreen}
            onKeyDown={handleButtonKeyDown}
            data-tooltip={t('editor.toolbar.tooltips.fullscreen')}
            {...shortcut('toggle_fullscreen')}
          >
            <div className="relative w-5 h-5 flex items-center justify-center">
              <Maximize size={20} />
            </div>
          </button>
        </div>
      </div>
    );
  },
);

export default EditorToolbar;
