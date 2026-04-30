import { memo, useState, useEffect, useRef, useMemo } from 'react';
import { Eye, EyeOff, ArrowLeft, Maximize, Loader2, Undo, Redo, Waves } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import { SelectedImage } from '../../ui/AppProperties';
import { IconAperture, IconCalendar, IconClock, IconFocalLength, IconIso, IconShutter } from './ExifIcons';
import Text from '../../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../../types/typography';

interface EditorToolbarProps {
  canRedo: boolean;
  canUndo: boolean;
  isAndroid: boolean;
  isLoading: boolean;
  onBackToLibrary(): void;
  onRedo(): void;
  onToggleFullScreen(): void;
  onToggleShowOriginal(): void;
  onUndo(): void;
  selectedImage: SelectedImage;
  showOriginal: boolean;
  showDateView: boolean;
  onToggleDateView(): void;
  adjustmentsHistory: any[];
  adjustmentsHistoryIndex: number;
  goToAdjustmentsHistoryIndex(index: number): void;
}

const EditorToolbar = memo(
  ({
    canRedo,
    canUndo,
    isAndroid,
    isLoading,
    onBackToLibrary,
    onRedo,
    onToggleFullScreen,
    onToggleShowOriginal,
    onUndo,
    selectedImage,
    showOriginal,
    showDateView,
    onToggleDateView,
    adjustmentsHistory,
    adjustmentsHistoryIndex,
    goToAdjustmentsHistoryIndex,
  }: EditorToolbarProps) => {
    const isAnyLoading = isLoading;
    const [isLoaderVisible, setIsLoaderVisible] = useState(false);
    const [disableLoaderTransition, setDisableLoaderTransition] = useState(false);
    const hideTimeoutRef = useRef<number | null>(null);
    const prevIsLoadingRef = useRef(isLoading);
    const [isVcHovered, setIsVcHovered] = useState(false);
    const [isInfoHovered, setIsInfoHovered] = useState(false);
    const [isHistoryVisible, setIsHistoryVisible] = useState(false);
    const historyContainerRef = useRef<HTMLDivElement>(null);
    const historyButtonRef = useRef<HTMLDivElement>(null);

    const showResolution = !isAndroid && selectedImage.width > 0 && selectedImage.height > 0;
    const [displayedResolution, setDisplayedResolution] = useState('');

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

    useEffect(() => {
      if (showResolution) {
        setDisplayedResolution(` - ${selectedImage.width} × ${selectedImage.height}`);
      }
    }, [showResolution, selectedImage.width, selectedImage.height]);

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
      if (!isHistoryVisible) return;
      const handleClickOutside = (e: MouseEvent) => {
        if (
          historyContainerRef.current &&
          !historyContainerRef.current.contains(e.target as Node) &&
          historyButtonRef.current &&
          !historyButtonRef.current.contains(e.target as Node)
        ) {
          setIsHistoryVisible(false);
        }
      };
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isHistoryVisible]);

    const prevNamesRef = useRef<string[]>(['Initial State']);

    const historyNames = useMemo(() => {
      if (!adjustmentsHistory || adjustmentsHistory.length === 0) return [];

      const formatKey = (k: string) => {
        const special: Record<string, string> = {
          aiPatches: 'AI Patches',
          aspectRatio: 'Aspect Ratio',
          flipHorizontal: 'Flip Horizontal',
          flipVertical: 'Flip Vertical',
          orientationSteps: 'Rotation',
          lutPath: 'LUT',
          lutIntensity: 'LUT Intensity',
          lutData: 'LUT Data',
          lutName: 'LUT Name',
          lutSize: 'LUT Size',
          chromaticAberrationBlueYellow: 'Chromatic Aberration Blue/Yellow',
          chromaticAberrationRedCyan: 'Chromatic Aberration Red/Cyan',
          centré: 'Centré',
          lumaNoiseReduction: 'Luma Noise Reduction',
          colorNoiseReduction: 'Color Noise Reduction',
          lensMaker: 'Lens Maker',
          lensModel: 'Lens Model',
          lensDistortionAmount: 'Lens Distortion',
          lensVignetteAmount: 'Lens Vignette',
          lensTcaAmount: 'Lens TCA',
          lensDistortionEnabled: 'Enable Lens Distortion',
          lensTcaEnabled: 'Enable Lens TCA',
          lensVignetteEnabled: 'Enable Lens Vignette',
          transformDistortion: 'Transform Distortion',
          transformVertical: 'Transform Vertical',
          transformHorizontal: 'Transform Horizontal',
          transformRotate: 'Transform Rotate',
          transformAspect: 'Transform Aspect',
          transformScale: 'Transform Scale',
          transformXOffset: 'Transform X Offset',
          transformYOffset: 'Transform Y Offset',
          colorGrading: 'Color Grading',
          colorCalibration: 'Color Calibration',
          toneMapper: 'Tone Mapper',
          showClipping: 'Show Clipping',
          sectionVisibility: 'Section Visibility',
          flareAmount: 'Flare Amount',
          glowAmount: 'Glow Amount',
          halationAmount: 'Halation Amount',
          grainAmount: 'Grain Amount',
          grainRoughness: 'Grain Roughness',
          grainSize: 'Grain Size',
          vignetteAmount: 'Vignette Amount',
          vignetteFeather: 'Vignette Feather',
          vignetteMidpoint: 'Vignette Midpoint',
          vignetteRoundness: 'Vignette Roundness',
          dehaze: 'Dehaze',
          exposure: 'Exposure',
          blacks: 'Blacks',
          whites: 'Whites',
          shadows: 'Shadows',
          highlights: 'Highlights',
          contrast: 'Contrast',
          brightness: 'Brightness',
          clarity: 'Clarity',
          structure: 'Structure',
          sharpness: 'Sharpness',
          saturation: 'Saturation',
          temperature: 'Temperature',
          tint: 'Tint',
          vibrance: 'Vibrance',
          hsl: 'HSL',
          curves: 'Curves',
          crop: 'Crop',
          masks: 'Masks',
          rating: 'Rating',
        };
        if (special[k]) return special[k];
        return k.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase());
      };

      const cachedNames = prevNamesRef.current;
      const newNames = [...cachedNames];

      if (newNames.length > adjustmentsHistory.length) {
        newNames.length = adjustmentsHistory.length;
      }

      for (let i = newNames.length; i < adjustmentsHistory.length; i++) {
        if (i === 0) {
          newNames[i] = 'Initial State';
          continue;
        }

        const curr = adjustmentsHistory[i];
        const prev = adjustmentsHistory[i - 1];
        const changed: string[] = [];

        for (const key of Object.keys(curr)) {
          if (prev[key] === curr[key]) continue;

          if (key === 'masks') {
            const prevMasks = prev.masks || [];
            const currMasks = curr.masks || [];

            if (currMasks.length > prevMasks.length) changed.push('Added Mask');
            else if (currMasks.length < prevMasks.length) changed.push('Deleted Mask');
            else {
              currMasks.forEach((cMask: any) => {
                const pMask = prevMasks.find((m: any) => m.id === cMask.id);
                if (pMask) {
                  if (pMask.opacity !== cMask.opacity) changed.push('Mask Opacity');
                  if (pMask.invert !== cMask.invert) changed.push('Mask Invert');
                  if (pMask.visible !== cMask.visible) changed.push('Mask Visibility');
                  if (pMask.subMasks !== cMask.subMasks) changed.push('Mask Area / Brush');

                  if (pMask.adjustments !== cMask.adjustments) {
                    for (const adjKey of Object.keys(cMask.adjustments || {})) {
                      if (pMask.adjustments[adjKey] !== cMask.adjustments[adjKey]) {
                        changed.push(`Mask ${formatKey(adjKey)}`);
                      }
                    }
                  }
                }
              });
            }
          } else if (key === 'aiPatches') {
            const prevPatches = prev.aiPatches || [];
            const currPatches = curr.aiPatches || [];

            if (currPatches.length > prevPatches.length) changed.push('Added AI Patch');
            else if (currPatches.length < prevPatches.length) changed.push('Deleted AI Patch');
            else {
              currPatches.forEach((cPatch: any) => {
                const pPatch = prevPatches.find((p: any) => p.id === cPatch.id);
                if (pPatch) {
                  if (pPatch.visible !== cPatch.visible) changed.push('AI Patch Visibility');
                  if (pPatch.subMasks !== cPatch.subMasks) changed.push('AI Patch Area');
                  if (pPatch.patchData !== cPatch.patchData || pPatch.prompt !== cPatch.prompt) {
                    changed.push('AI Generation');
                  }
                }
              });
            }
          } else {
            changed.push(formatKey(key));
          }
        }

        const uniqueChanged = Array.from(new Set(changed));

        if (uniqueChanged.length === 0) newNames[i] = 'Adjustment';
        else if (uniqueChanged.length > 2) newNames[i] = `${uniqueChanged.slice(0, 2).join(', ')}...`;
        else newNames[i] = uniqueChanged.join(', ');
      }

      prevNamesRef.current = newNames;
      return newNames;
    }, [adjustmentsHistory]);

    useEffect(() => {
      if (isHistoryVisible && historyContainerRef.current) {
        const timer = setTimeout(() => {
          const activeEl = historyContainerRef.current?.querySelector('[data-active="true"]');
          if (activeEl) {
            activeEl.scrollIntoView({ block: 'nearest', behavior: 'auto' });
          }
        }, 10);
        return () => clearTimeout(timer);
      }
    }, [isHistoryVisible, adjustmentsHistoryIndex]);

    const handleButtonKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'Tab') return;
      e.currentTarget.blur();
    };

    const isExpanded = isInfoHovered && (hasExif || isLoading);

    return (
      <div className="relative shrink-0 flex items-center justify-between px-4 h-14 gap-4 z-40">
        <div className="flex items-center gap-2 shrink-0 z-40">
          <button
            className="bg-surface text-text-primary p-2 rounded-full hover:bg-card-active transition-colors shrink-0"
            onClick={onBackToLibrary}
            onKeyDown={handleButtonKeyDown}
            data-tooltip="Back to Library"
          >
            <ArrowLeft size={20} />
          </button>

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
          </div>
        </div>

        <div className="flex-1 flex justify-center min-w-0 relative h-full">
          <div
            className={clsx(
              'bg-surface flex flex-col items-center overflow-hidden transition-all duration-200 ease-out pt-2',
              isExpanded
                ? 'h-18 px-8 rounded-2xl absolute min-w-[340px] whitespace-nowrap shadow-2xl shadow-black/50'
                : 'h-9 px-4 rounded-[18px] absolute min-w-0 w-auto max-w-full shadow-none',
            )}
            onMouseEnter={() => setIsInfoHovered(true)}
            onMouseLeave={() => setIsInfoHovered(false)}
            style={{
              top: '10px',
              transform: 'translateX(-50%)',
              left: '50%',
              zIndex: isExpanded ? 50 : 0,
            }}
          >
            <div className="flex items-center justify-center max-w-full h-5 shrink-0">
              <Text
                as="span"
                variant={TextVariants.small}
                color={TextColors.primary}
                weight={TextWeights.medium}
                className="truncate min-w-0 shrink"
              >
                {baseName}
              </Text>

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
                  <span>VC</span>
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

              <div
                className={clsx(
                  'overflow-hidden shrink-0',
                  isLoaderVisible ? 'max-w-4 opacity-100 ml-2' : 'max-w-0 opacity-0 ml-0',
                  disableLoaderTransition ? 'transition-none' : 'transition-all duration-300',
                )}
              >
                <Loader2 size={12} className="text-text-secondary animate-spin" />
              </div>
            </div>

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
                  <div className="flex items-center gap-1.5" data-tooltip="Shutter Speed">
                    <Text as="span">
                      <IconShutter />
                    </Text>
                    <Text as="span" variant={TextVariants.small} color={TextColors.primary} weight={TextWeights.medium}>
                      {exifData.shutter}
                    </Text>
                  </div>
                )}
                {exifData.fNumber && (
                  <div className="flex items-center gap-1.5" data-tooltip="Aperture">
                    <Text as="span">
                      <IconAperture />
                    </Text>
                    <Text as="span" variant={TextVariants.small} color={TextColors.primary} weight={TextWeights.medium}>
                      {exifData.fNumber}
                    </Text>
                  </div>
                )}
                {exifData.iso && (
                  <div className="flex items-center gap-1.5" data-tooltip="ISO">
                    <Text as="span">
                      <IconIso />
                    </Text>
                    <Text as="span" variant={TextVariants.small} color={TextColors.primary} weight={TextWeights.medium}>
                      {exifData.iso}
                    </Text>
                  </div>
                )}
                {exifData.focal && (
                  <div className="flex items-center gap-1.5" data-tooltip="Focal Length">
                    <Text as="span">
                      <IconFocalLength />
                    </Text>
                    <Text as="span" variant={TextVariants.small} color={TextColors.primary} weight={TextWeights.medium}>
                      {String(exifData.focal).endsWith('mm') ? exifData.focal : `${exifData.focal}mm`}
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

        <div className="flex items-center gap-2 shrink-0 z-40">
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
              data-tooltip="Undo (Ctrl+Z) or History (Right-click)"
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
              data-tooltip="Redo (Ctrl+Y) or History (Right-click)"
            >
              <Redo size={20} />
            </button>

            <AnimatePresence>
              {isHistoryVisible && adjustmentsHistory && adjustmentsHistory.length > 1 && (
                <motion.div
                  ref={historyContainerRef}
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.15, ease: 'easeOut' }}
                  className="absolute top-full right-0 mt-3 w-56 max-h-80 bg-surface/90 backdrop-blur-md border border-text-secondary/10 shadow-xl rounded-lg overflow-y-auto custom-scrollbar z-50 flex flex-col py-1.5 px-0.5"
                >
                  {historyNames.map((name, i) => {
                    const isCurrent = i === adjustmentsHistoryIndex;
                    const isFuture = i > adjustmentsHistoryIndex;

                    const textColor = isCurrent
                      ? TextColors.button
                      : isFuture
                        ? TextColors.secondary
                        : TextColors.primary;
                    const textWeight = isCurrent ? TextWeights.medium : TextWeights.normal;

                    return (
                      <button
                        key={i}
                        data-active={isCurrent}
                        onClick={() => goToAdjustmentsHistoryIndex(i)}
                        onKeyDown={handleButtonKeyDown}
                        className={clsx(
                          'text-left px-3 py-2 transition-colors mx-1 my-0.5 rounded-md',
                          isCurrent
                            ? 'bg-accent'
                            : isFuture
                              ? 'opacity-50 hover:bg-bg-primary hover:opacity-100'
                              : 'hover:bg-bg-primary',
                        )}
                      >
                        <div className="flex justify-between items-center gap-2">
                          <Text as="span" color={textColor} weight={textWeight} className="truncate">
                            {name}
                          </Text>
                          <Text
                            as="span"
                            variant={TextVariants.small}
                            color={textColor}
                            weight={textWeight}
                            className="opacity-50 shrink-0"
                          >
                            {i === 0 ? '' : i}
                          </Text>
                        </div>
                      </button>
                    );
                  })}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <button
            className={clsx(
              'p-2 rounded-full transition-colors',
              showOriginal
                ? 'bg-accent text-button-text hover:bg-accent/90 hover:text-button-text'
                : 'bg-surface hover:bg-card-active text-text-primary',
            )}
            onClick={onToggleShowOriginal}
            onKeyDown={handleButtonKeyDown}
            data-tooltip={showOriginal ? 'Show Edited (B)' : 'Show Original (B)'}
          >
            {showOriginal ? <EyeOff size={20} /> : <Eye size={20} />}
          </button>
          <button
            className="bg-surface text-text-primary p-2 rounded-full hover:bg-card-active transition-colors disabled:opacity-50 disabled:cursor-not-allowed relative"
            onClick={onToggleFullScreen}
            onKeyDown={handleButtonKeyDown}
            data-tooltip="Toggle Fullscreen (F)"
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
