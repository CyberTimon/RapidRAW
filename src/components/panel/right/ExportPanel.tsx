import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { save, open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { FileInput, ChevronDown, ChevronLeft, ChevronRight, Film, Settings } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import debounce from 'lodash.debounce';
import Switch from '../../ui/Switch';
import ExportButton from '../../ui/ExportButton';
import Dropdown from '../../ui/Dropdown';
import Slider from '../../ui/Slider';
import SegmentedControl from '../../ui/SegmentedControl';
import PanelSection from '../../ui/PanelSection';
import ColorField, { normalizeHexColor, useParsedTextField } from '../../ui/ColorField';
import ValidatedNumberInput from '../../ui/ValidatedNumberInput';
import {
  BorderBasis,
  ConflictAction,
  ExportPreset,
  ExportSettings,
  FileFormat,
  FILE_FORMATS,
  FILENAME_VARIABLES,
  Status,
  ExportState,
  FileFormats,
  MAX_EXPORT_DPI,
  TiffBitDepth,
  COLOR_SPACE_FILE_FORMATS,
  DEFAULT_HDR_HEADROOM,
  HDR_FILE_FORMATS,
  EXPORT_COLOR_SPACES,
  ExportColorSpace,
} from '../../../types/export';
import { Invokes } from '../../../types/invokes';
import { SelectedImage } from '../../../types/editor';
import { AppSettings } from '../../../types/settings';
import { Panel } from '../../../types/ui';
import ExportPresetsList from './ExportPresetsList';
import VideoExportSection from './VideoExportSection';
import WatermarkSection from './WatermarkSection';
import { useExportSettings } from '../../../hooks/useExportSettings';
import { useOsPlatform } from '../../../hooks/useOsPlatform';
import { useDisplayStatus } from '../../../hooks/useDisplayStatus';
import Text from '../../ui/Text';
import PanelHeader from '../../ui/PanelHeader';
import { TextColors, TextVariants, TextWeights } from '../../../types/typography';
import { useEditorStore } from '../../../store/useEditorStore';
import { useUIStore } from '../../../store/useUIStore';
import { isVideoPath, photoEditorImage, useVideoKind } from '../../../store/videoIntegration';
import { VideoExportTarget, isVideoExportBusy, useVideoExportStore } from '../../../store/videoExport';
import ImmichExportOptions, { useImmichExportAvailable, useImmichExportChoice } from '../../immich/ImmichExportOptions';
import { prepareImmichExport } from '../../../utils/immichApi';
import { formatBytes } from '../../../utils/formatBytes';
import { watermarkExportSettings } from '../../../utils/watermark';

interface ExportPanelProps {
  exportState: ExportState;
  multiSelectedPaths: Array<string>;
  selectedImage: SelectedImage | null;
  setExportState(state: any): void;
  appSettings: AppSettings | null;
  onSettingsChange: (settings: AppSettings) => void;
  rootPaths: string[];
  isVisible?: boolean;
  onClose?: () => void;
}

const MAX_PAD_RATIO = 1000;

function parseRatio(value: string): number | null {
  const parsed = Number(value.trim().replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_PAD_RATIO ? parsed : null;
}

const MAX_BORDER_PERCENT = 100;

function parsePercent(value: string): number | null {
  const parsed = Number(value.trim().replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_BORDER_PERCENT ? parsed : null;
}

function parseDpi(value: string): number | null {
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_EXPORT_DPI ? parsed : null;
}

export default function ExportPanel({
  exportState,
  multiSelectedPaths,
  selectedImage,
  setExportState,
  appSettings,
  onSettingsChange,
  rootPaths,
  isVisible = true,
  onClose,
}: ExportPanelProps) {
  const { t } = useTranslation();

  const resizeModeOptions = useMemo(
    () => [
      { label: t('export.resize.modes.longEdge'), value: 'longEdge' },
      { label: t('export.resize.modes.shortEdge'), value: 'shortEdge' },
      { label: t('export.resize.modes.width'), value: 'width' },
      { label: t('export.resize.modes.height'), value: 'height' },
    ],
    [t],
  );

  const borderBasisOptions = useMemo(
    () => [
      { label: t('export.border.bases.longEdge'), value: BorderBasis.LongEdge },
      { label: t('export.border.bases.shortEdge'), value: BorderBasis.ShortEdge },
      { label: t('export.border.bases.eachEdge'), value: BorderBasis.EachEdge },
    ],
    [t],
  );

  const tiffBitDepthOptions = useMemo(
    () => [
      { label: t('export.file.tiffBitDepth8'), value: '8' },
      { label: t('export.file.tiffBitDepth16'), value: '16' },
    ],
    [t],
  );

  const onConflictOptions = useMemo(
    () => [
      { label: t('export.conflict.createUnique'), value: ConflictAction.CreateUnique },
      { label: t('export.conflict.overwrite'), value: ConflictAction.Overwrite },
      { label: t('export.conflict.overwriteIfChanged'), value: ConflictAction.OverwriteIfChanged },
      { label: t('export.conflict.skip'), value: ConflictAction.Skip },
    ],
    [t],
  );

  const {
    restored,
    fileFormat,
    setFileFormat,
    jpegQuality,
    setJpegQuality,
    tiffBitDepth,
    setTiffBitDepth,
    colorSpace,
    setColorSpace,
    hdr,
    setHdr,
    hdrHeadroom,
    setHdrHeadroom,
    dpi,
    setDpi,
    enableResize,
    setEnableResize,
    resizeMode,
    setResizeMode,
    resizeValue,
    setResizeValue,
    dontEnlarge,
    setDontEnlarge,
    enablePad,
    setEnablePad,
    padRatioWidth,
    setPadRatioWidth,
    padRatioHeight,
    setPadRatioHeight,
    padColor,
    setPadColor,
    enableBorder,
    setEnableBorder,
    borderBasis,
    setBorderBasis,
    borderHorizontalPercent,
    setBorderHorizontalPercent,
    borderVerticalPercent,
    setBorderVerticalPercent,
    borderColor,
    setBorderColor,
    keepMetadata,
    setKeepMetadata,
    preserveTimestamps,
    setPreserveTimestamps,
    stripGps,
    setStripGps,
    exportMasks,
    setExportMasks,
    exportOriginal,
    setExportOriginal,
    originalCrop,
    setOriginalCrop,
    originalKeepExposure,
    setOriginalKeepExposure,
    filenameTemplate,
    setFilenameTemplate,
    watermark,
    preserveFolders,
    setPreserveFolders,
    handleApplyPreset,
    currentSettingsObject,
    destinationType,
    setDestinationType,
    subfolder,
    setSubfolder,
    onConflict,
    setOnConflict,
  } = useExportSettings();

  const adjustmentsRef = useRef(useEditorStore.getState().adjustments);

  const [isAdvancedExpanded, setIsAdvancedExpanded] = useState(false);
  const initDone = useRef(false);

  useEffect(() => {
    if (initDone.current || restored || appSettings === null || !isVisible) return;
    initDone.current = true;
    const lastUsed = appSettings.exportPresets?.find((p) => p.id === '__last_used__');
    if (lastUsed) {
      handleApplyPreset(lastUsed);
    }
  }, [appSettings, handleApplyPreset, isVisible, restored]);

  const saveLastUsedPreset = useCallback(
    (exportPath: string) => {
      if (!appSettings) return;
      const lastUsedPreset: ExportPreset = {
        ...currentSettingsObject,
        id: '__last_used__',
        name: '__last_used__',
        lastExportPath: exportPath,
      };
      const updatedPresets = [
        ...(appSettings.exportPresets ?? []).filter((p) => p.id !== '__last_used__'),
        lastUsedPreset,
      ];
      onSettingsChange({ ...appSettings, exportPresets: updatedPresets });
    },
    [appSettings, currentSettingsObject, onSettingsChange],
  );

  const padRatioWidthField = useParsedTextField(padRatioWidth, setPadRatioWidth, parseRatio);
  const padRatioHeightField = useParsedTextField(padRatioHeight, setPadRatioHeight, parseRatio);
  const padColorField = useParsedTextField(padColor, setPadColor, normalizeHexColor);

  const padRatioWidthValue = padRatioWidthField.parsed;
  const padRatioHeightValue = padRatioHeightField.parsed;
  const isPadValid = !enablePad || (padRatioWidthValue !== null && padRatioHeightValue !== null);
  const padSettings =
    enablePad && padRatioWidthValue !== null && padRatioHeightValue !== null
      ? { ratioWidth: padRatioWidthValue, ratioHeight: padRatioHeightValue, color: padColor }
      : null;

  const dpiField = useParsedTextField(dpi, setDpi, parseDpi);

  const borderHorizontalField = useParsedTextField(borderHorizontalPercent, setBorderHorizontalPercent, parsePercent);
  const borderVerticalField = useParsedTextField(borderVerticalPercent, setBorderVerticalPercent, parsePercent);
  const borderColorField = useParsedTextField(borderColor, setBorderColor, normalizeHexColor);

  const borderHorizontalValue = borderHorizontalField.parsed;
  const borderVerticalValue = borderVerticalField.parsed;
  const isBorderValid = !enableBorder || (borderHorizontalValue !== null && borderVerticalValue !== null);
  const borderSettings =
    enableBorder && borderHorizontalValue !== null && borderVerticalValue !== null
      ? {
          basis: borderBasis,
          horizontalPercent: borderHorizontalValue,
          verticalPercent: borderVerticalValue,
          color: borderColor,
        }
      : null;

  const [estimatedSize, setEstimatedSize] = useState<number | null>(null);
  const [isEstimating, setIsEstimating] = useState<boolean>(false);
  const estimateRequestIdRef = useRef(0);
  const filenameInputRef = useRef<HTMLInputElement>(null);
  const osPlatform = useOsPlatform();
  const displayStatus = useDisplayStatus();
  const hdrPreviewHint = !displayStatus
    ? null
    : !displayStatus.hdrActive
      ? t('export.file.hdrNoPreview')
      : !appSettings?.hdrDisplay
        ? t('export.file.hdrPreviewOff')
        : null;
  const isAndroid = osPlatform === 'android';
  const canExportToImmich = useImmichExportAvailable() && !isAndroid;
  const destination = destinationType === 'immich' && !canExportToImmich ? 'customFolder' : destinationType;
  const immichExport = useImmichExportChoice();
  const activePanels = useUIStore((state) => state.activePanels);
  const isPanelReallyActive = Object.values(activePanels).includes(Panel.Export);

  const { status, progress, errorMessage, exportedCount, skippedCount } = exportState;
  const isExporting = [Status.Exporting, Status.Cancelling].includes(status);
  const isLibraryContext = !!onClose;

  const selectionPaths = useMemo(() => {
    return isLibraryContext
      ? multiSelectedPaths
      : multiSelectedPaths.length > 0
        ? multiSelectedPaths
        : selectedImage
          ? [selectedImage.path]
          : [];
  }, [isLibraryContext, multiSelectedPaths, selectedImage?.path]);

  const isEditorView = useUIStore((state) => state.activeView === 'editor');
  const isVideoProject = useVideoKind() === 'project' && isEditorView;
  const isVideoExporting = useVideoExportStore((state) => isVideoExportBusy(state.status));
  const [videoChoice, setVideoChoice] = useState<Array<string> | null>(null);
  const videoPaths = useMemo(() => selectionPaths.filter(isVideoPath), [selectionPaths]);

  const videoTarget = useMemo<VideoExportTarget | null>(() => {
    if (isVideoProject) return { kind: 'project' };
    const onlyVideos = videoPaths.length === selectionPaths.length;
    return videoPaths.length > 0 && (onlyVideos || videoChoice === selectionPaths)
      ? { kind: 'videos', paths: videoPaths }
      : null;
  }, [isVideoProject, videoPaths, selectionPaths, videoChoice]);

  const pathsToExport = useMemo(
    () => (videoTarget ? [] : selectionPaths.filter((path) => !videoPaths.includes(path))),
    [videoTarget, selectionPaths, videoPaths],
  );

  const numImages = pathsToExport.length;

  const debouncedEstimateSize = useMemo(
    () =>
      debounce(async (requestId, paths, currentAdj, currentPath, exportSettings, format) => {
        if (paths.length === 0 || !isVisible) {
          setEstimatedSize(null);
          setIsEstimating(false);
          return;
        }
        setIsEstimating(true);
        try {
          const size: number | null = await invoke(Invokes.EstimateExportSizes, {
            paths,
            exportSettings,
            outputFormat: format,
            currentEditPath: currentPath || null,
            currentEditAdjustments: currentAdj || null,
          });
          if (requestId !== estimateRequestIdRef.current || size === null) return;
          setEstimatedSize(size);
          setIsEstimating(false);
        } catch {
          if (requestId !== estimateRequestIdRef.current) return;
          setEstimatedSize(null);
          setIsEstimating(false);
        }
      }, 500),
    [isVisible],
  );

  useEffect(() => {
    if (!isPanelReallyActive) return;

    const exportSettings: ExportSettings = {
      filenameTemplate,
      jpegQuality,
      tiffBitDepth,
      colorSpace,
      hdr,
      hdrHeadroom,
      keepMetadata,
      preserveTimestamps,
      preserveFolders,
      destinationType: destination,
      subfolder,
      resize: enableResize ? { mode: resizeMode, value: resizeValue, dontEnlarge } : null,
      border: borderSettings,
      pad: padSettings,
      stripGps,
      exportMasks: exportMasks,
      watermark: watermarkExportSettings(watermark),
    };
    const format = FILE_FORMATS.find((f: FileFormat) => f.id === fileFormat)?.extensions[0] || 'jpeg';
    const runEstimate = () =>
      debouncedEstimateSize(
        ++estimateRequestIdRef.current,
        pathsToExport,
        adjustmentsRef.current,
        photoEditorImage()?.path,
        exportSettings,
        format,
      );

    runEstimate();

    let { adjustments: prevAdjustments, originalSize: prevOriginalSize } = useEditorStore.getState();
    const unsubscribe = useEditorStore.subscribe((state) => {
      if (state.adjustments === prevAdjustments && state.originalSize === prevOriginalSize) return;
      prevAdjustments = state.adjustments;
      prevOriginalSize = state.originalSize;
      adjustmentsRef.current = state.adjustments;
      runEstimate();
    });

    return () => {
      unsubscribe();
      debouncedEstimateSize.cancel();
    };
  }, [
    isPanelReallyActive,
    pathsToExport,
    selectedImage?.path,
    fileFormat,
    jpegQuality,
    tiffBitDepth,
    colorSpace,
    hdr,
    hdrHeadroom,
    enableResize,
    resizeMode,
    resizeValue,
    dontEnlarge,
    enablePad,
    padRatioWidthField.text,
    padRatioHeightField.text,
    padColor,
    enableBorder,
    borderBasis,
    borderHorizontalField.text,
    borderVerticalField.text,
    borderColor,
    keepMetadata,
    preserveTimestamps,
    stripGps,
    filenameTemplate,
    watermark,
    debouncedEstimateSize,
    exportMasks,
    preserveFolders,
    isLibraryContext,
  ]);

  const handleVariableClick = (variable: string) => {
    if (!filenameInputRef.current) return;
    const input: HTMLInputElement = filenameInputRef.current;
    const start = Number(input.selectionStart);
    const end = Number(input.selectionEnd);
    const currentValue = input.value;
    const newValue = currentValue.substring(0, start) + variable + currentValue.substring(end);
    setFilenameTemplate(newValue);
    setTimeout(() => {
      input.focus();
      input.setSelectionRange(start + variable.length, start + variable.length);
    }, 0);
  };

  const renderOutputSections = (target: string, disabled: boolean, source: 'photos' | VideoExportTarget['kind']) => (
    <>
      {(source !== 'project' || canExportToImmich) && (
        <PanelSection title={t('export.sections.destination')}>
          <div className="space-y-3">
            <Dropdown
              options={[
                { label: t('export.destination.customFolder'), value: 'customFolder' },
                ...(source !== 'project'
                  ? [{ label: t('export.destination.originalFolder'), value: 'originalFolder' }]
                  : []),
                ...(canExportToImmich ? [{ label: t('immich.export.destination'), value: 'immich' }] : []),
              ]}
              value={target || 'customFolder'}
              onChange={(val) => setDestinationType(val as string)}
              disabled={disabled}
              className="w-full"
            />

            {target === 'immich' && <ImmichExportOptions disabled={disabled} showOriginal={source === 'photos'} />}

            {target === 'originalFolder' && (
              <div className="flex items-center gap-3 pl-2 border-l-2 border-surface">
                <Text variant={TextVariants.label} className="whitespace-nowrap min-w-[70px]">
                  {t('export.destination.subfolder')}
                </Text>
                <input
                  className="w-full bg-surface border border-transparent rounded-md px-3 py-2 text-sm text-text-primary focus:outline-hidden truncate"
                  disabled={disabled}
                  onChange={(e) => setSubfolder(e.target.value)}
                  type="text"
                  value={subfolder || ''}
                  placeholder={t('export.destination.subfolderPlaceholder')}
                />
              </div>
            )}
          </div>
        </PanelSection>
      )}

      {source !== 'project' && (
        <PanelSection title={t('export.sections.fileNaming')}>
          <input
            className="w-full bg-surface border border-surface rounded-md p-2 text-sm text-text-primary focus:ring-accent focus:border-accent"
            disabled={disabled}
            onChange={(e) => setFilenameTemplate(e.target.value)}
            ref={filenameInputRef}
            type="text"
            value={filenameTemplate}
          />
          <div className="flex flex-wrap gap-2 mt-2">
            {FILENAME_VARIABLES.map((variable: string) => (
              <button
                className="px-2 py-1 bg-surface text-text-secondary text-xs rounded-md hover:bg-card-active transition-colors disabled:opacity-50"
                disabled={disabled}
                key={variable}
                onClick={() => handleVariableClick(variable)}
              >
                {variable}
              </button>
            ))}
          </div>
        </PanelSection>
      )}
    </>
  );

  const handleExport = async () => {
    if (numImages === 0 || isExporting) return;

    const exportSettings: ExportSettings = {
      filenameTemplate,
      jpegQuality,
      tiffBitDepth,
      colorSpace,
      hdr,
      hdrHeadroom,
      keepMetadata,
      preserveTimestamps,
      preserveFolders,
      destinationType: destination,
      subfolder,
      onConflict: isAndroid ? ConflictAction.CreateUnique : onConflict,
      resize: enableResize ? { mode: resizeMode, value: resizeValue, dontEnlarge } : null,
      border: borderSettings,
      pad: padSettings,
      stripGps,
      exportMasks: exportMasks,
      exportOriginal: exportOriginal ? { crop: originalCrop, keepExposure: originalKeepExposure } : null,
      watermark: watermarkExportSettings(watermark),
      dpi,
    };

    const lastExportPath = appSettings?.exportPresets?.find((p) => p.id === '__last_used__')?.lastExportPath;

    try {
      const selectedFormat: any = FILE_FORMATS.find((f) => f.id === fileFormat);

      let outputFolderOrFile = '';
      const isOriginalFolder = destination === 'originalFolder';
      const isImmich = destination === 'immich';
      const shouldChooseOutputFile = numImages === 1 && !preserveFolders && !isOriginalFolder && !isImmich;

      if (isImmich) {
        exportSettings.preserveFolders = false;
        exportSettings.exportOriginal = null;
        exportSettings.exportMasks = false;
        exportSettings.onConflict = ConflictAction.CreateUnique;
        outputFolderOrFile = await prepareImmichExport(immichExport.album, immichExport.withOriginal);
      } else if (isOriginalFolder) {
        outputFolderOrFile = 'originalFolderDummy';
      } else if (shouldChooseOutputFile) {
        exportSettings.onConflict = ConflictAction.Overwrite;
        const suggestedName = await invoke<string>(Invokes.ResolveExportFileStem, {
          path: pathsToExport[0],
          filenameTemplate,
        });
        const outputFileName = `${suggestedName}.${selectedFormat.extensions[0]}`;

        outputFolderOrFile = isAndroid
          ? outputFileName
          : ((await save({
              title: t('export.dialog.saveEditedImageTitle'),
              defaultPath: lastExportPath ? `${lastExportPath}/${outputFileName}` : outputFileName,
              filters: [
                { name: selectedFormat.name, extensions: selectedFormat.extensions },
                ...FILE_FORMATS.filter((f: FileFormat) => f.id !== fileFormat).map((f: FileFormat) => ({
                  name: f.name,
                  extensions: f.extensions,
                })),
              ],
            })) as string);
      } else {
        outputFolderOrFile = isAndroid
          ? ''
          : ((await open({
              title: t('export.dialog.selectFolderTitle', { count: numImages }),
              directory: true,
              defaultPath: lastExportPath ?? undefined,
            })) as string);
      }

      if (isAndroid || outputFolderOrFile) {
        if (!isAndroid) {
          if (isOriginalFolder || isImmich) {
            saveLastUsedPreset(lastExportPath || '');
          } else {
            const dir = shouldChooseOutputFile
              ? outputFolderOrFile.substring(
                  0,
                  Math.max(outputFolderOrFile.lastIndexOf('/'), outputFolderOrFile.lastIndexOf('\\')),
                )
              : outputFolderOrFile;
            if (dir) saveLastUsedPreset(dir);
          }
        }

        setExportState({
          destination: isOriginalFolder || isImmich || isAndroid ? null : outputFolderOrFile,
          isOriginalFolder,
          errorMessage: '',
          progress: { current: 0, total: numImages },
          status: Status.Exporting,
          exportedCount: undefined,
          skippedCount: undefined,
        });
        await invoke(Invokes.ExportImages, {
          paths: pathsToExport,
          outputFolderOrFile: outputFolderOrFile,
          isExplicitFilePath: shouldChooseOutputFile,
          baseOriginFolders: rootPaths,
          exportSettings,
          outputFormat: selectedFormat.extensions[0],
          currentEditPath: photoEditorImage()?.path || null,
          currentEditAdjustments: adjustmentsRef.current || null,
        });
      }
    } catch (error) {
      setExportState({
        errorMessage: typeof error === 'string' ? error : t('export.status.failed'),
        progress,
        status: Status.Error,
      });
    }
  };

  const handleCancel = async () => {
    setExportState((current: ExportState) =>
      current.status === Status.Exporting ? { status: Status.Cancelling } : {},
    );
    try {
      await invoke(Invokes.CancelExport);
    } catch (error) {
      console.error('Failed to cancel:', error);
      setExportState((current: ExportState) =>
        current.status === Status.Cancelling ? { status: Status.Exporting } : {},
      );
    }
  };

  const canExport = numImages > 0 && isPadValid && isBorderValid;
  const isLut = fileFormat === FileFormats.Cube;
  const itemLabel = isLut ? t('export.labels.lut') : t('export.labels.image');
  const itemLabelPlural = isLut ? t('export.labels.lut_plural') : t('export.labels.image_plural');
  const panelClassName = onClose ? 'h-full bg-bg-secondary rounded-lg flex flex-col' : 'flex flex-col h-full';
  const panelHeader = <PanelHeader title={t('export.title')} />;

  if (videoTarget) {
    const lastExportPath = appSettings?.exportPresets?.find((p) => p.id === '__last_used__')?.lastExportPath ?? null;
    const videoDestination =
      destination === 'immich' || (destination === 'originalFolder' && videoTarget.kind === 'videos')
        ? destination
        : 'customFolder';
    return (
      <div className={panelClassName}>
        {panelHeader}
        <VideoExportSection
          target={videoTarget}
          output={{
            destination: videoDestination,
            subfolder: subfolder || '',
            filenameTemplate,
            lastExportPath,
            immichAlbum: immichExport.album,
          }}
          onExportStarted={(folder) => saveLastUsedPreset(folder ?? lastExportPath ?? '')}
          notice={
            videoTarget.kind === 'videos' &&
            videoPaths.length < selectionPaths.length && (
              <button
                className="flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
                disabled={isVideoExporting}
                onClick={() => setVideoChoice(null)}
              >
                <ChevronLeft size={16} />
                {t('video.export.backToPhotos')}
              </button>
            )
          }
        >
          {renderOutputSections(videoDestination, isVideoExporting, videoTarget.kind)}
        </VideoExportSection>
      </div>
    );
  }

  return (
    <div className={panelClassName}>
      {panelHeader}
      <div className="grow overflow-y-auto p-3 space-y-8">
        {numImages > 0 ? (
          <>
            {videoPaths.length > 0 && (
              <div className="flex items-center gap-3 p-3 rounded-md bg-surface">
                <Film size={16} className="shrink-0 text-text-secondary" />
                <Text variant={TextVariants.small} className="flex-1 min-w-0">
                  {t('video.export.mixedNote', { count: videoPaths.length })}
                </Text>
                <button
                  className="shrink-0 px-2 py-1 rounded-md text-xs font-medium bg-bg-secondary text-text-primary hover:bg-card-active transition-colors"
                  onClick={() => setVideoChoice(selectionPaths)}
                >
                  {t('video.export.exportVideos')}
                </button>
              </div>
            )}
            <div className={isExporting ? 'opacity-50 pointer-events-none' : ''}>
              <ExportPresetsList
                appSettings={appSettings}
                onSettingsChange={onSettingsChange}
                currentSettings={currentSettingsObject}
                onApplyPreset={handleApplyPreset}
              />
            </div>

            <PanelSection title={t('export.sections.fileSettings')}>
              <SegmentedControl<string>
                options={FILE_FORMATS.map((format: FileFormat) => ({ id: format.id, label: format.name }))}
                value={fileFormat}
                onChange={setFileFormat}
                disabled={isExporting}
              />
              {[FileFormats.Jpeg, FileFormats.Webp, FileFormats.Jxl].includes(fileFormat as FileFormats) && (
                <div className={isExporting ? 'opacity-50 pointer-events-none' : ''}>
                  <Slider
                    defaultValue={90}
                    label={
                      fileFormat === FileFormats.Jxl && jpegQuality === 100 && !hdr
                        ? t('export.file.qualityLossless')
                        : t('export.file.quality')
                    }
                    max={100}
                    min={1}
                    onChange={(e) => setJpegQuality(Number(e.target.value))}
                    step={1}
                    value={jpegQuality}
                    fillOrigin="min"
                  />
                </div>
              )}
              {fileFormat === FileFormats.Tiff && (
                <div className={isExporting ? 'opacity-50 pointer-events-none' : ''}>
                  <Text variant={TextVariants.label} className="mb-1">
                    {t('export.file.tiffBitDepth')}
                  </Text>
                  <Dropdown
                    options={tiffBitDepthOptions}
                    value={String(tiffBitDepth)}
                    onChange={(value) => setTiffBitDepth(Number(value) as TiffBitDepth)}
                    disabled={isExporting}
                    className="w-full"
                  />
                </div>
              )}
            </PanelSection>

            {renderOutputSections(destination, isExporting, 'photos')}

            {fileFormat !== FileFormats.Cube && (
              <>
                <PanelSection title={t('export.sections.imageSizing')}>
                  <Switch
                    label={t('export.border.addBorder')}
                    checked={enableBorder}
                    onChange={setEnableBorder}
                    disabled={isExporting}
                    trackClassName="bg-surface"
                  />
                  {enableBorder && (
                    <div className="space-y-4 pl-2 border-l-2 border-surface">
                      <div>
                        <Text variant={TextVariants.label} className="mb-2 block">
                          {t('export.border.basis')}
                        </Text>
                        <Dropdown
                          options={borderBasisOptions}
                          value={borderBasis}
                          onChange={setBorderBasis}
                          disabled={isExporting}
                          className="w-full"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <Text variant={TextVariants.label} className="flex-1">
                          {t('export.border.leftRight')}
                        </Text>
                        <ValidatedNumberInput
                          ariaLabel={t('export.border.leftRight')}
                          disabled={isExporting}
                          field={borderHorizontalField}
                          max={MAX_BORDER_PERCENT}
                        />
                        <Text variant={TextVariants.label}>{t('export.border.percent')}</Text>
                      </div>
                      <div className="flex items-center gap-2">
                        <Text variant={TextVariants.label} className="flex-1">
                          {t('export.border.topBottom')}
                        </Text>
                        <ValidatedNumberInput
                          ariaLabel={t('export.border.topBottom')}
                          disabled={isExporting}
                          field={borderVerticalField}
                          max={MAX_BORDER_PERCENT}
                        />
                        <Text variant={TextVariants.label}>{t('export.border.percent')}</Text>
                      </div>
                      {!isBorderValid && (
                        <Text variant={TextVariants.label} className="text-red-500">
                          {t('export.border.invalidPercent')}
                        </Text>
                      )}
                      <ColorField
                        color={borderColor}
                        disabled={isExporting}
                        field={borderColorField}
                        label={t('export.border.color')}
                        onColorChange={setBorderColor}
                      />
                    </div>
                  )}
                  <Switch
                    label={t('export.pad.padToAspectRatio')}
                    checked={enablePad}
                    onChange={setEnablePad}
                    disabled={isExporting}
                    trackClassName="bg-surface"
                  />
                  {enablePad && (
                    <div className="space-y-4 pl-2 border-l-2 border-surface">
                      <div className="flex items-center gap-2">
                        <Text variant={TextVariants.label} className="flex-1">
                          {t('export.pad.aspectRatio')}
                        </Text>
                        <ValidatedNumberInput
                          ariaLabel={t('export.pad.ratioWidth')}
                          disabled={isExporting}
                          field={padRatioWidthField}
                        />
                        <Text variant={TextVariants.label}>:</Text>
                        <ValidatedNumberInput
                          ariaLabel={t('export.pad.ratioHeight')}
                          disabled={isExporting}
                          field={padRatioHeightField}
                        />
                      </div>
                      {!isPadValid && (
                        <Text variant={TextVariants.label} className="text-red-500">
                          {t('export.pad.invalidRatio')}
                        </Text>
                      )}
                      <ColorField
                        color={padColor}
                        disabled={isExporting}
                        field={padColorField}
                        label={t('export.pad.backgroundColor')}
                        onColorChange={setPadColor}
                      />
                    </div>
                  )}
                  <Switch
                    label={t('export.resize.resizeToFit')}
                    checked={enableResize}
                    onChange={setEnableResize}
                    disabled={isExporting}
                    trackClassName="bg-surface"
                  />
                  {enableResize && (
                    <div className="space-y-4 pl-2 border-l-2 border-surface">
                      <div className="flex items-center gap-2">
                        <Dropdown
                          options={resizeModeOptions}
                          value={resizeMode}
                          onChange={setResizeMode}
                          disabled={isExporting}
                          className="w-full"
                        />
                        <input
                          className="w-24 bg-surface text-center rounded-md p-2 border border-surface focus:border-accent focus:ring-accent text-text-secondary focus:text-text-primary"
                          disabled={isExporting}
                          min="1"
                          onChange={(e) => setResizeValue(parseInt(e?.target?.value))}
                          type="number"
                          value={resizeValue}
                        />
                        <Text variant={TextVariants.label}>{t('export.resize.pixels')}</Text>
                      </div>
                      <Switch
                        checked={dontEnlarge}
                        disabled={isExporting}
                        label={t('export.resize.dontEnlarge')}
                        onChange={setDontEnlarge}
                        trackClassName="bg-surface"
                      />
                    </div>
                  )}
                </PanelSection>

                {[FileFormats.Jpeg, FileFormats.Png, FileFormats.Tiff, FileFormats.Webp, FileFormats.Jxl].includes(
                  fileFormat as FileFormats,
                ) && (
                  <PanelSection title={t('export.sections.metadata')}>
                    <Switch
                      checked={keepMetadata}
                      disabled={isExporting}
                      label={t('export.metadata.saveWithMetadata')}
                      onChange={setKeepMetadata}
                      trackClassName="bg-surface"
                    />
                    {keepMetadata && (
                      <div className="pl-2 border-l-2 border-surface">
                        <Switch
                          label={t('export.metadata.removeGps')}
                          checked={stripGps}
                          onChange={setStripGps}
                          disabled={isExporting}
                          trackClassName="bg-surface"
                        />
                      </div>
                    )}
                  </PanelSection>
                )}

                <WatermarkSection
                  disabled={isExporting}
                  layout={{ border: borderSettings, pad: padSettings }}
                  previewPaths={isEditorView ? null : pathsToExport}
                />
              </>
            )}

            <div>
              <Text variant={TextVariants.heading} className="mb-2">
                {t('export.sections.advanced')}
              </Text>
              <div className="bg-surface rounded-xl overflow-hidden">
                <button
                  onClick={() => setIsAdvancedExpanded(!isAdvancedExpanded)}
                  disabled={isExporting}
                  className="w-full flex items-center justify-between p-3.5 hover:bg-card-active transition-colors"
                >
                  <Text
                    as="span"
                    variant={TextVariants.label}
                    color={TextColors.primary}
                    className="flex items-center gap-2"
                  >
                    <Settings size={16} /> {t('export.advanced.title')}
                  </Text>
                  <Text color={TextColors.secondary}>
                    {isAdvancedExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </Text>
                </button>
                <AnimatePresence initial={false}>
                  {isAdvancedExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
                      className="overflow-hidden"
                    >
                      <div className="px-4 pb-4 pt-2 border-t border-surface/50 flex flex-col gap-4">
                        {HDR_FILE_FORMATS.includes(fileFormat) && (
                          <Switch
                            label={t('export.file.hdr')}
                            tooltip={t(
                              fileFormat === FileFormats.Jpeg ? 'export.file.hdrJpegHint' : 'export.file.hdrJxlHint',
                            )}
                            checked={hdr}
                            onChange={setHdr}
                            disabled={isExporting}
                          />
                        )}
                        {HDR_FILE_FORMATS.includes(fileFormat) && hdr && (
                          <div className="pl-2 border-l-2 border-card-active">
                            <Slider
                              label={
                                <span
                                  data-tooltip={[t('export.file.hdrHeadroomHint'), hdrPreviewHint]
                                    .filter(Boolean)
                                    .join(' ')}
                                >
                                  {t('export.file.hdrHeadroom')}
                                </span>
                              }
                              min={1}
                              max={4}
                              step={0.1}
                              value={hdrHeadroom}
                              defaultValue={DEFAULT_HDR_HEADROOM}
                              onChange={(e) => setHdrHeadroom(Number(e.target.value))}
                              fillOrigin="min"
                              suffix=" EV"
                              disabled={isExporting}
                            />
                          </div>
                        )}
                        {COLOR_SPACE_FILE_FORMATS.includes(fileFormat) && !(hdr && fileFormat === FileFormats.Jxl) && (
                          <div className={isExporting ? 'opacity-50 pointer-events-none' : ''}>
                            <Text variant={TextVariants.label} className="mb-1">
                              {t('export.file.colorSpace')}
                            </Text>
                            <Dropdown
                              options={EXPORT_COLOR_SPACES}
                              value={colorSpace}
                              onChange={(value) => setColorSpace(value as ExportColorSpace)}
                              disabled={isExporting}
                              className="w-full"
                            />
                          </div>
                        )}
                        {!isAndroid && destination !== 'immich' && (
                          <div className={isExporting ? 'opacity-50 pointer-events-none' : ''}>
                            <Text variant={TextVariants.label} className="mb-1">
                              {t('export.conflict.label')}
                            </Text>
                            <Dropdown
                              options={onConflictOptions}
                              value={onConflict}
                              onChange={(value) => setOnConflict(value as ConflictAction)}
                              disabled={isExporting}
                              className="w-full"
                            />
                          </div>
                        )}
                        {destination !== 'immich' && destination !== 'originalFolder' && (
                          <Switch
                            label={t('export.advanced.preserveFolders')}
                            checked={preserveFolders}
                            onChange={setPreserveFolders}
                            disabled={isExporting}
                          />
                        )}
                        {fileFormat !== FileFormats.Cube && (
                          <Switch
                            checked={preserveTimestamps}
                            disabled={isExporting}
                            label={t('export.advanced.preserveTimestamps')}
                            onChange={setPreserveTimestamps}
                          />
                        )}
                        {fileFormat !== FileFormats.Cube && destination !== 'immich' && (
                          <>
                            <Switch
                              label={t('export.advanced.exportOriginal')}
                              checked={exportOriginal}
                              onChange={setExportOriginal}
                              disabled={isExporting}
                            />
                            {exportOriginal && (
                              <div className="pl-2 border-l-2 border-card-active flex flex-col gap-4">
                                <Switch
                                  label={t('export.advanced.originalCrop')}
                                  checked={originalCrop}
                                  onChange={setOriginalCrop}
                                  disabled={isExporting}
                                />
                                <Switch
                                  label={t('export.advanced.originalKeepExposure')}
                                  checked={originalKeepExposure}
                                  onChange={setOriginalKeepExposure}
                                  disabled={isExporting}
                                />
                              </div>
                            )}
                          </>
                        )}
                        {fileFormat !== FileFormats.Cube && destination !== 'immich' && (
                          <Switch
                            label={t('export.advanced.exportMasks')}
                            checked={exportMasks}
                            onChange={setExportMasks}
                            disabled={isExporting}
                          />
                        )}
                        {[FileFormats.Jpeg, FileFormats.Png, FileFormats.Tiff].includes(fileFormat as FileFormats) && (
                          <div className="flex items-center gap-2">
                            <Text variant={TextVariants.label} className="flex-1">
                              {t('export.file.resolution')}
                            </Text>
                            <ValidatedNumberInput
                              ariaLabel={t('export.file.resolution')}
                              background="bg-bg-secondary"
                              disabled={isExporting}
                              field={dpiField}
                              max={MAX_EXPORT_DPI}
                            />
                            <Text variant={TextVariants.label}>{t('export.file.dpi')}</Text>
                          </div>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full">
            <Text
              variant={TextVariants.heading}
              color={TextColors.secondary}
              weight={TextWeights.normal}
              className="text-center"
            >
              {isLibraryContext ? t('export.status.noImagesSelected') : t('export.status.noImageSelected')}
            </Text>
          </div>
        )}
      </div>

      <div className="p-3 border-t border-surface shrink-0 space-y-2">
        <Text as="div" variant={TextVariants.small} color={TextColors.primary} className="text-center">
          {isEstimating ? (
            <span className="italic">{t('export.status.estimatingSize')}</span>
          ) : estimatedSize !== null ? (
            <span>
              {numImages > 1
                ? t('export.status.estimatedTotalSize', { size: formatBytes(estimatedSize, t) }) ||
                  t('export.status.estimatedSize', { size: formatBytes(estimatedSize, t) })
                : t('export.status.estimatedSize', { size: formatBytes(estimatedSize, t) })}
              {numImages > 1 && ` (~${formatBytes(estimatedSize / numImages, t)})`}
            </span>
          ) : null}
        </Text>
        <ExportButton
          status={status}
          progress={isExporting && progress.total > 1 ? (progress.current ?? 0) / progress.total : null}
          canExport={canExport}
          icon={FileInput}
          label={
            numImages > 1
              ? t('export.status.exportMultiple', { count: numImages, label: itemLabelPlural })
              : t('export.status.exportSingle', { label: itemLabel })
          }
          progressLabel={
            progress.total > 1
              ? t('export.status.exportingProgress', { current: progress.current, total: progress.total })
              : t('export.status.exporting')
          }
          successLabel={
            !skippedCount
              ? undefined
              : exportedCount
                ? t('export.status.successWithSkipped', { exported: exportedCount, skipped: skippedCount })
                : t('export.status.allSkipped')
          }
          errorLabel={errorMessage || undefined}
          warning={!!skippedCount && !exportedCount}
          onExport={handleExport}
          onCancel={handleCancel}
        />
      </div>
    </div>
  );
}
