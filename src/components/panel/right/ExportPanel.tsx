import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { save, open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { FileInput, CheckCircle, XCircle, Loader, Ban, ChevronDown, ChevronRight, Settings, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import debounce from 'lodash.debounce';
import Switch from '../../ui/Switch';
import Button from '../../ui/Button';
import Dropdown from '../../ui/Dropdown';
import Slider from '../../ui/Slider';
import ImagePicker from '../../ui/ImagePicker';
import {
  ExportPreset,
  ExportSettings,
  FileFormat,
  FILE_FORMATS,
  FILENAME_VARIABLES,
  Status,
  ExportState,
  FileFormats,
  WatermarkAnchor,
} from '../../ui/ExportImportProperties';
import { Invokes, SelectedImage, AppSettings } from '../../ui/AppProperties';
import ExportPresetsList from '../../ui/ExportPresetsList';
import { useExportSettings } from '../../../hooks/useExportSettings';
import { useOsPlatform } from '../../../hooks/useOsPlatform';
import Text from '../../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../../types/typography';
import { useShallow } from 'zustand/react/shallow';
import { useEditorStore } from '../../../store/useEditorStore';

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

interface SectionProps {
  children: any;
  title: string;
}

function Section({ title, children }: SectionProps) {
  return (
    <div>
      <Text variant={TextVariants.heading} className="mb-2">
        {title}
      </Text>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

interface HdrFieldProps {
  label: string;
  help: string;
  children: any;
}

// A labelled HDR control with a one-line, plain-language explanation underneath so a
// non-expert understands what each option does without needing to hover.
function HdrField({ label, help, children }: HdrFieldProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Text color={TextColors.secondary}>{label}</Text>
        {children}
      </div>
      <Text as="p" variant={TextVariants.small} color={TextColors.secondary} className="opacity-70 leading-snug">
        {help}
      </Text>
    </div>
  );
}

function WatermarkPreview({
  anchor,
  scale,
  spacing,
  opacity,
  watermarkPath,
  imageAspectRatio,
  watermarkImageAspectRatio,
}: {
  anchor: WatermarkAnchor;
  scale: number;
  spacing: number;
  opacity: number;
  watermarkPath: string | null;
  imageAspectRatio: number;
  watermarkImageAspectRatio: number;
}) {
  const { t } = useTranslation();

  const getPositionStyles = () => {
    const minDimPercent = imageAspectRatio > 1 ? 100 / imageAspectRatio : 100;
    const watermarkSizePercent = minDimPercent * (scale / 100);
    const spacingPercent = minDimPercent * (spacing / 100);

    const styles: React.CSSProperties = {
      width: `${watermarkSizePercent}%`,
      opacity: opacity / 100,
      position: 'absolute',
    };

    const spacingString = `${spacingPercent}%`;

    switch (anchor) {
      case WatermarkAnchor.TopLeft:
        styles.top = spacingString;
        styles.left = spacingString;
        break;
      case WatermarkAnchor.TopCenter:
        styles.top = spacingString;
        styles.left = '50%';
        styles.transform = 'translateX(-50%)';
        break;
      case WatermarkAnchor.TopRight:
        styles.top = spacingString;
        styles.right = spacingString;
        break;
      case WatermarkAnchor.CenterLeft:
        styles.top = '50%';
        styles.left = spacingString;
        styles.transform = 'translateY(-50%)';
        break;
      case WatermarkAnchor.Center:
        styles.top = '50%';
        styles.left = '50%';
        styles.transform = 'translate(-50%, -50%)';
        break;
      case WatermarkAnchor.CenterRight:
        styles.top = '50%';
        styles.right = spacingString;
        styles.transform = 'translateY(-50%)';
        break;
      case WatermarkAnchor.BottomLeft:
        styles.bottom = spacingString;
        styles.left = spacingString;
        break;
      case WatermarkAnchor.BottomCenter:
        styles.bottom = spacingString;
        styles.left = '50%';
        styles.transform = 'translateX(-50%)';
        break;
      case WatermarkAnchor.BottomRight:
        styles.bottom = spacingString;
        styles.right = spacingString;
        break;
    }
    return styles;
  };

  return (
    <div
      className="w-full bg-surface rounded-md relative overflow-hidden border border-surface"
      style={{ aspectRatio: imageAspectRatio }}
    >
      <div className="absolute inset-0 flex items-center justify-center">
        <Text variant={TextVariants.label}>{t('export.watermark.previewText')}</Text>
      </div>
      {watermarkPath && (
        <div style={getPositionStyles()}>
          <div
            className="w-full bg-accent/50 border-2 border-dashed border-accent rounded-xs flex items-center justify-center"
            style={{ aspectRatio: watermarkImageAspectRatio }}
          >
            <span className="text-white text-[8px] font-bold">{t('export.watermark.logoText')}</span>
          </div>
        </div>
      )}
    </div>
  );
}

const formatBytes = (bytes: number, t: any, decimals = 2) => {
  if (!+bytes) return `0 ${t('export.bytes.bytes')}`;
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = [
    t('export.bytes.bytes'),
    t('export.bytes.kb'),
    t('export.bytes.mb'),
    t('export.bytes.gb'),
    t('export.bytes.tb'),
  ];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

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

  const {
    fileFormat,
    setFileFormat,
    jpegQuality,
    setJpegQuality,
    enableResize,
    setEnableResize,
    resizeMode,
    setResizeMode,
    resizeValue,
    setResizeValue,
    dontEnlarge,
    setDontEnlarge,
    keepMetadata,
    setKeepMetadata,
    preserveTimestamps,
    setPreserveTimestamps,
    stripGps,
    setStripGps,
    exportMasks,
    setExportMasks,
    filenameTemplate,
    setFilenameTemplate,
    enableWatermark,
    setEnableWatermark,
    watermarkPath,
    setWatermarkPath,
    watermarkAnchor,
    setWatermarkAnchor,
    watermarkScale,
    setWatermarkScale,
    watermarkSpacing,
    setWatermarkSpacing,
    watermarkOpacity,
    setWatermarkOpacity,
    preserveFolders,
    setPreserveFolders,
    bitDepth,
    setBitDepth,
    transferFunction,
    setTransferFunction,
    primaries,
    setPrimaries,
    matrix,
    setMatrix,
    chromaSubsampling,
    setChromaSubsampling,
    range,
    setRange,
    referenceWhiteNits,
    setReferenceWhiteNits,
    hlgPeakRatio,
    setHlgPeakRatio,
    masteringMetadata,
    setMasteringMetadata,
    handleApplyPreset,
    currentSettingsObject,
  } = useExportSettings();

  const { adjustments } = useEditorStore(
    useShallow((state) => ({
      adjustments: state.adjustments,
    })),
  );

  const [isAdvancedExpanded, setIsAdvancedExpanded] = useState(false);
  const initDone = useRef(false);

  useEffect(() => {
    if (initDone.current || appSettings === null || !isVisible) return;
    initDone.current = true;
    const lastUsed = appSettings.exportPresets?.find((p) => p.id === '__last_used__');
    if (lastUsed) {
      handleApplyPreset(lastUsed);
    }
  }, [appSettings, handleApplyPreset, isVisible]);

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

  const [estimatedSize, setEstimatedSize] = useState<number | null>(null);
  const [isEstimating, setIsEstimating] = useState<boolean>(false);
  const [watermarkImageAspectRatio, setWatermarkImageAspectRatio] = useState(1);
  const [imageAspectRatio, setImageAspectRatio] = useState(16 / 9);
  const filenameInputRef = useRef<HTMLInputElement>(null);
  const osPlatform = useOsPlatform();
  const isAndroid = osPlatform === 'android';

  const { status, progress, errorMessage } = exportState;
  const isExporting = status === Status.Exporting;
  const isLibraryContext = !!onClose;

  const pathsToExport = isLibraryContext
    ? multiSelectedPaths
    : multiSelectedPaths.length > 0
      ? multiSelectedPaths
      : selectedImage
        ? [selectedImage.path]
        : [];
  const numImages = pathsToExport.length;

  useEffect(() => {
    const fetchDims = async () => {
      if (!enableWatermark || numImages === 0 || !isVisible) return;
      if (!isLibraryContext && selectedImage && selectedImage.width && selectedImage.height) {
        setImageAspectRatio(selectedImage.width / selectedImage.height);
        return;
      }
      try {
        const dims: any = await invoke('get_image_dimensions', { path: pathsToExport[0] });
        if (dims.width > 0 && dims.height > 0) setImageAspectRatio(dims.width / dims.height);
      } catch {
        setImageAspectRatio(3 / 2);
      }
    };
    fetchDims();
  }, [pathsToExport, isLibraryContext, selectedImage, enableWatermark, numImages, isVisible]);

  useEffect(() => {
    const fetchWatermarkDimensions = async () => {
      if (!watermarkPath) {
        setWatermarkImageAspectRatio(1);
        return;
      }
      try {
        const dimensions: { width: number; height: number } = await invoke('get_image_dimensions', {
          path: watermarkPath,
        });
        setWatermarkImageAspectRatio(dimensions.height > 0 ? dimensions.width / dimensions.height : 1);
      } catch (error) {
        setWatermarkImageAspectRatio(1);
      }
    };
    fetchWatermarkDimensions();
  }, [watermarkPath]);

  const anchorOptions = useMemo(
    () => [
      { label: t('export.watermark.anchors.topLeft'), value: WatermarkAnchor.TopLeft },
      { label: t('export.watermark.anchors.topCenter'), value: WatermarkAnchor.TopCenter },
      { label: t('export.watermark.anchors.topRight'), value: WatermarkAnchor.TopRight },
      { label: t('export.watermark.anchors.centerLeft'), value: WatermarkAnchor.CenterLeft },
      { label: t('export.watermark.anchors.center'), value: WatermarkAnchor.Center },
      { label: t('export.watermark.anchors.centerRight'), value: WatermarkAnchor.CenterRight },
      { label: t('export.watermark.anchors.bottomLeft'), value: WatermarkAnchor.BottomLeft },
      { label: t('export.watermark.anchors.bottomCenter'), value: WatermarkAnchor.BottomCenter },
      { label: t('export.watermark.anchors.bottomRight'), value: WatermarkAnchor.BottomRight },
    ],
    [t],
  );

  // HDR fields shared by the estimate and export settings objects (kept in one place, DRY).
  // Keys + value spellings must match the backend serde contract exactly.
  const hdrSettings = useMemo(
    () => ({
      bitDepth,
      transferFunction,
      primaries,
      matrix,
      chromaSubsampling,
      range,
      referenceWhiteNits,
      hlgPeakRatio,
      masteringMetadata,
    }),
    [
      bitDepth,
      transferFunction,
      primaries,
      matrix,
      chromaSubsampling,
      range,
      referenceWhiteNits,
      hlgPeakRatio,
      masteringMetadata,
    ],
  );

  // Friendly color profiles for AVIF/JXL. Each bundles the low-level HDR fields so a
  // non-expert can pick one option instead of reasoning about color science. "custom"
  // is a sentinel that reveals the Advanced controls without changing any field.
  const colorProfiles = useMemo(
    () => ({
      sdr: { bitDepth: 8, transferFunction: 'srgb', primaries: 'srgb', matrix: 'ycbcr', chromaSubsampling: '420' },
      hdr10: {
        bitDepth: 10,
        transferFunction: 'pq',
        primaries: 'bt2020',
        matrix: 'ycbcr',
        chromaSubsampling: '420',
        range: 'full',
      },
      hlg: {
        bitDepth: 10,
        transferFunction: 'hlg',
        primaries: 'bt2020',
        matrix: 'ycbcr',
        chromaSubsampling: '420',
        range: 'full',
      },
      maxQuality: {
        bitDepth: 12,
        transferFunction: 'pq',
        primaries: 'bt2020',
        matrix: 'ycbcr',
        chromaSubsampling: '444',
        range: 'full',
      },
      archival: {
        bitDepth: 12,
        transferFunction: 'pq',
        primaries: 'bt2020',
        matrix: 'identity',
        chromaSubsampling: '444',
        range: 'full',
      },
    }),
    [],
  );

  // The profile that exactly matches the current field bundle, otherwise 'custom'.
  const activeColorProfile = useMemo(() => {
    if (bitDepth === 8) return 'sdr';
    const match = (Object.keys(colorProfiles) as Array<keyof typeof colorProfiles>).find((key) => {
      if (key === 'sdr') return false;
      const p = colorProfiles[key];
      return (
        p.bitDepth === bitDepth &&
        p.transferFunction === transferFunction &&
        p.primaries === primaries &&
        p.matrix === matrix &&
        // chroma is forced to 4:4:4 when matrix is RGB, so ignore it in that case.
        (matrix === 'identity' || p.chromaSubsampling === chromaSubsampling) &&
        p.range === range
      );
    });
    return match ?? 'custom';
  }, [bitDepth, transferFunction, primaries, matrix, chromaSubsampling, range, colorProfiles]);

  const [forceAdvancedColor, setForceAdvancedColor] = useState(false);
  const showAdvancedColor = activeColorProfile === 'custom' || forceAdvancedColor;

  const applyColorProfile = useCallback(
    (key: string) => {
      if (key === 'custom') {
        setForceAdvancedColor(true);
        return;
      }
      const p = colorProfiles[key as keyof typeof colorProfiles];
      if (!p) return;
      setBitDepth(p.bitDepth);
      setTransferFunction(p.transferFunction);
      setPrimaries(p.primaries);
      setMatrix(p.matrix);
      setChromaSubsampling(p.chromaSubsampling);
      if ('range' in p && p.range) setRange(p.range);
      setForceAdvancedColor(false);
    },
    [colorProfiles, setBitDepth, setTransferFunction, setPrimaries, setMatrix, setChromaSubsampling, setRange],
  );

  // Switching SDR -> HDR in the Advanced controls promotes the SDR-only fields to the
  // compatible HDR defaults (PQ / Rec.2020 / YCbCr / 4:2:0) so the output is valid HDR.
  const handleBitDepthChange = useCallback(
    (depth: number) => {
      setBitDepth(depth);
      if (depth > 8 && transferFunction === 'srgb') {
        setTransferFunction('pq');
        setPrimaries('bt2020');
        setMatrix('ycbcr');
        setChromaSubsampling('420');
        setRange('full');
      }
    },
    [transferFunction, setBitDepth, setTransferFunction, setPrimaries, setMatrix, setChromaSubsampling, setRange],
  );

  const handleMatrixChange = useCallback(
    (value: string) => {
      setMatrix(value);
      // RGB (identity) cannot subsample chroma; force full 4:4:4 to keep the output valid.
      if (value === 'identity') {
        setChromaSubsampling('444');
      }
    },
    [setMatrix, setChromaSubsampling],
  );

  const colorProfileOptions = useMemo(
    () => [
      { label: t('export.file.profiles.sdr'), value: 'sdr' },
      { label: t('export.file.profiles.hdr10'), value: 'hdr10' },
      { label: t('export.file.profiles.hlg'), value: 'hlg' },
      { label: t('export.file.profiles.maxQuality'), value: 'maxQuality' },
      { label: t('export.file.profiles.archival'), value: 'archival' },
      { label: t('export.file.profiles.custom'), value: 'custom' },
    ],
    [t],
  );

  const bitDepthOptions = useMemo(
    () => [
      { label: t('export.file.bitDepth8'), value: '8' },
      { label: t('export.file.bitDepth10'), value: '10' },
      { label: t('export.file.bitDepth12'), value: '12' },
    ],
    [t],
  );

  const matrixOptions = useMemo(
    () => [
      { label: t('export.file.colorEncodingYcbcr'), value: 'ycbcr' },
      { label: t('export.file.colorEncodingRgb'), value: 'identity' },
    ],
    [t],
  );

  const chromaOptions = useMemo(
    () => [
      { label: t('export.file.chroma420'), value: '420' },
      { label: t('export.file.chroma422'), value: '422' },
      { label: t('export.file.chroma444'), value: '444' },
    ],
    [t],
  );

  const rangeOptions = useMemo(
    () => [
      { label: t('export.file.rangeFull'), value: 'full' },
      { label: t('export.file.rangeLimited'), value: 'limited' },
    ],
    [t],
  );

  const gamutOptions = useMemo(
    () => [
      { label: t('export.file.gamutSrgb'), value: 'srgb' },
      { label: t('export.file.gamutDisplayP3'), value: 'displayp3' },
      { label: t('export.file.gamutBt2020'), value: 'bt2020' },
    ],
    [t],
  );

  const transferOptions = useMemo(
    () => [
      { label: 'PQ (ST.2084)', value: 'pq' },
      { label: 'HLG', value: 'hlg' },
    ],
    [],
  );

  const debouncedEstimateSize = useMemo(
    () =>
      debounce(async (paths, currentAdj, currentPath, exportSettings, format) => {
        if (paths.length === 0 || !isVisible) {
          setEstimatedSize(null);
          return;
        }
        setIsEstimating(true);
        try {
          const size: number = await invoke(Invokes.EstimateExportSizes, {
            paths,
            exportSettings,
            outputFormat: format,
            currentEditPath: currentPath || null,
            currentEditAdjustments: currentAdj || null,
          });
          setEstimatedSize(size);
        } catch (err) {
          setEstimatedSize(null);
        } finally {
          setIsEstimating(false);
        }
      }, 500),
    [isVisible],
  );

  useEffect(() => {
    const exportSettings: ExportSettings = {
      filenameTemplate,
      jpegQuality,
      keepMetadata,
      preserveTimestamps,
      preserveFolders,
      resize: enableResize ? { mode: resizeMode, value: resizeValue, dontEnlarge } : null,
      stripGps,
      exportMasks: !isLibraryContext ? exportMasks : undefined,
      watermark:
        enableWatermark && watermarkPath
          ? {
              path: watermarkPath,
              anchor: watermarkAnchor,
              scale: watermarkScale,
              spacing: watermarkSpacing,
              opacity: watermarkOpacity,
            }
          : null,
      ...hdrSettings,
    };
    const format = FILE_FORMATS.find((f: FileFormat) => f.id === fileFormat)?.extensions[0] || 'jpeg';
    debouncedEstimateSize(pathsToExport, adjustments, selectedImage?.path, exportSettings, format);
    return () => debouncedEstimateSize.cancel();
  }, [
    pathsToExport,
    adjustments,
    selectedImage?.path,
    fileFormat,
    jpegQuality,
    enableResize,
    resizeMode,
    resizeValue,
    dontEnlarge,
    keepMetadata,
    preserveTimestamps,
    stripGps,
    filenameTemplate,
    enableWatermark,
    watermarkPath,
    watermarkAnchor,
    watermarkScale,
    watermarkSpacing,
    watermarkOpacity,
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

  const handleExport = async () => {
    if (numImages === 0 || isExporting) return;

    let finalFilenameTemplate = filenameTemplate;
    if (
      numImages > 1 &&
      !filenameTemplate.includes('{sequence}') &&
      !filenameTemplate.includes('{original_filename}')
    ) {
      finalFilenameTemplate = `${filenameTemplate}_{sequence}`;
      setFilenameTemplate(finalFilenameTemplate);
    }

    const exportSettings: ExportSettings = {
      filenameTemplate: finalFilenameTemplate,
      jpegQuality,
      keepMetadata,
      preserveTimestamps,
      preserveFolders,
      resize: enableResize ? { mode: resizeMode, value: resizeValue, dontEnlarge } : null,
      stripGps,
      exportMasks: !isLibraryContext ? exportMasks : undefined,
      watermark:
        enableWatermark && watermarkPath
          ? {
              path: watermarkPath,
              anchor: watermarkAnchor,
              scale: watermarkScale,
              spacing: watermarkSpacing,
              opacity: watermarkOpacity,
            }
          : null,
      ...hdrSettings,
    };

    const lastExportPath = appSettings?.exportPresets?.find((p) => p.id === '__last_used__')?.lastExportPath;

    try {
      const selectedFormat: any = FILE_FORMATS.find((f) => f.id === fileFormat);

      let outputFolderOrFile = '';
      if (numImages === 1) {
        const originalFilename = pathsToExport[0].split(/[\\/]/).pop() || '';
        const stem = originalFilename.substring(0, originalFilename.lastIndexOf('.')) || originalFilename;
        const suggestedName = finalFilenameTemplate.replace('{original_filename}', stem);
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
          const dir =
            numImages === 1
              ? outputFolderOrFile.substring(
                  0,
                  Math.max(outputFolderOrFile.lastIndexOf('/'), outputFolderOrFile.lastIndexOf('\\')),
                )
              : outputFolderOrFile;
          if (dir) saveLastUsedPreset(dir);
        }

        setExportState({ status: Status.Exporting, progress: { current: 0, total: numImages }, errorMessage: '' });
        await invoke(Invokes.ExportImages, {
          paths: pathsToExport,
          outputFolderOrFile: outputFolderOrFile,
          isExplicitFilePath: numImages === 1,
          baseOriginFolders: rootPaths,
          exportSettings,
          outputFormat: selectedFormat.extensions[0],
          currentEditPath: selectedImage?.path || null,
          currentEditAdjustments: adjustments || null,
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
    try {
      await invoke(Invokes.CancelExport);
    } catch (error) {
      console.error('Failed to cancel:', error);
    }
  };

  const canExport = numImages > 0;
  const isLut = fileFormat === FileFormats.Cube;
  const itemLabel = isLut ? t('export.labels.lut') : t('export.labels.image');
  const itemLabelPlural = isLut ? t('export.labels.lut_plural') : t('export.labels.image_plural');

  return (
    <div className={onClose ? 'h-full bg-bg-secondary rounded-lg flex flex-col' : 'flex flex-col h-full'}>
      <div className="p-4 flex justify-between items-center shrink-0 border-b border-surface">
        <Text variant={TextVariants.title}>{t('export.title')}</Text>
        {onClose && (
          <button
            onClick={onClose}
            className="p-1 rounded-md text-text-secondary hover:bg-surface hover:text-text-primary"
          >
            <X size={20} />
          </button>
        )}
      </div>
      <div className="grow overflow-y-auto p-4 space-y-8">
        {canExport ? (
          <>
            <ExportPresetsList
              appSettings={appSettings}
              onSettingsChange={onSettingsChange}
              currentSettings={currentSettingsObject}
              onApplyPreset={handleApplyPreset}
            />

            <Section title={t('export.sections.fileSettings')}>
              <div className="grid grid-cols-3 gap-2">
                {FILE_FORMATS.map((format: FileFormat) => (
                  <button
                    className={`px-2 py-1.5 rounded-md transition-colors ${fileFormat === format.id ? 'bg-accent' : 'bg-surface hover:bg-card-active'} disabled:opacity-50`}
                    disabled={isExporting}
                    key={format.id}
                    onClick={() => setFileFormat(format.id)}
                  >
                    <Text color={fileFormat === format.id ? TextColors.button : TextColors.secondary}>
                      {format.name}
                    </Text>
                  </button>
                ))}
              </div>
              {[FileFormats.Jpeg, FileFormats.Webp, FileFormats.Jxl].includes(fileFormat as FileFormats) && (
                <div className={isExporting ? 'opacity-50 pointer-events-none' : ''}>
                  <Slider
                    defaultValue={90}
                    label={
                      fileFormat === FileFormats.Jxl && jpegQuality === 100
                        ? t('export.file.qualityLossless')
                        : t('export.file.quality')
                    }
                    max={100}
                    min={1}
                    onChange={(e) => setJpegQuality(parseInt(e.target.value))}
                    step={1}
                    value={jpegQuality}
                    fillOrigin="min"
                  />
                </div>
              )}
              {[FileFormats.Avif, FileFormats.Jxl].includes(fileFormat as FileFormats) && (
                <div className={`mt-3 space-y-3 ${isExporting ? 'opacity-50 pointer-events-none' : ''}`}>
                  {/* Tier 1: a single friendly "Color profile" picker that bundles the HDR fields. */}
                  <HdrField label={t('export.file.colorProfile')} help={t('export.file.colorProfileHint')}>
                    <Dropdown
                      options={colorProfileOptions}
                      value={activeColorProfile}
                      onChange={applyColorProfile}
                      disabled={isExporting}
                      className="w-56"
                    />
                  </HdrField>

                  {/* An explicit Advanced toggle so users on a preset can still fine-tune. */}
                  {activeColorProfile !== 'custom' && bitDepth > 8 && (
                    <Switch
                      label={t('export.file.advancedToggle')}
                      checked={forceAdvancedColor}
                      onChange={setForceAdvancedColor}
                      disabled={isExporting}
                      trackClassName="bg-surface"
                    />
                  )}

                  {/* Tier 2: Advanced controls, each with plain-language help. */}
                  {showAdvancedColor && (
                    <div className="space-y-3 pl-2 border-l-2 border-surface">
                      <HdrField label={t('export.file.bitDepth')} help={t('export.file.bitDepthHelp')}>
                        <Dropdown
                          options={bitDepthOptions}
                          value={String(bitDepth)}
                          onChange={(v: string) => handleBitDepthChange(parseInt(v, 10))}
                          disabled={isExporting}
                          className="w-56"
                        />
                      </HdrField>

                      {bitDepth > 8 && (
                        <>
                          <HdrField label={t('export.file.transfer')} help={t('export.file.hdrHint')}>
                            <Dropdown
                              options={transferOptions}
                              value={transferFunction === 'srgb' ? 'pq' : transferFunction}
                              onChange={setTransferFunction}
                              disabled={isExporting}
                              className="w-56"
                            />
                          </HdrField>

                          {transferFunction === 'hlg' && (
                            <HdrField label={t('export.file.hlgPeakRatio')} help={t('export.file.hlgPeakRatioHelp')}>
                              <div className="w-56">
                                <Slider
                                  label=""
                                  min={2}
                                  max={20}
                                  step={1}
                                  value={hlgPeakRatio}
                                  onChange={(e) => setHlgPeakRatio(parseInt(String(e.target.value), 10))}
                                  defaultValue={12}
                                  fillOrigin="min"
                                />
                              </div>
                            </HdrField>
                          )}

                          <HdrField label={t('export.file.colorGamut')} help={t('export.file.colorGamutHelp')}>
                            <Dropdown
                              options={gamutOptions}
                              value={primaries}
                              onChange={setPrimaries}
                              disabled={isExporting}
                              className="w-56"
                            />
                          </HdrField>

                          <HdrField label={t('export.file.colorEncoding')} help={t('export.file.colorEncodingHelp')}>
                            <Dropdown
                              options={matrixOptions}
                              value={matrix}
                              onChange={handleMatrixChange}
                              disabled={isExporting}
                              className="w-56"
                            />
                          </HdrField>

                          {/* Chroma detail only applies to YCbCr; RGB forces full 4:4:4. */}
                          {matrix === 'ycbcr' && (
                            <HdrField label={t('export.file.chromaDetail')} help={t('export.file.chromaDetailHelp')}>
                              <Dropdown
                                options={chromaOptions}
                                value={chromaSubsampling}
                                onChange={setChromaSubsampling}
                                disabled={isExporting}
                                className="w-56"
                              />
                            </HdrField>
                          )}

                          <HdrField label={t('export.file.signalRange')} help={t('export.file.signalRangeHelp')}>
                            <Dropdown
                              options={rangeOptions}
                              value={range}
                              onChange={setRange}
                              disabled={isExporting}
                              className="w-56"
                            />
                          </HdrField>

                          <HdrField label={t('export.file.referenceWhite')} help={t('export.file.referenceWhiteHelp')}>
                            <div className="w-56">
                              <Slider
                                label=""
                                min={100}
                                max={300}
                                step={1}
                                value={referenceWhiteNits}
                                onChange={(e) => setReferenceWhiteNits(parseInt(String(e.target.value), 10))}
                                defaultValue={203}
                                fillOrigin="min"
                                suffix="nits"
                              />
                            </div>
                          </HdrField>

                          <Switch
                            label={t('export.file.masteringMetadata')}
                            checked={masteringMetadata}
                            onChange={setMasteringMetadata}
                            disabled={isExporting}
                            tooltip={t('export.file.masteringMetadataHelp')}
                            trackClassName="bg-surface"
                          />
                          <Text
                            as="p"
                            variant={TextVariants.small}
                            color={TextColors.secondary}
                            className="opacity-70 leading-snug -mt-1"
                          >
                            {t('export.file.masteringMetadataHelp')}
                          </Text>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </Section>

            {(numImages > 1 || onClose) && (
              <Section title={t('export.sections.fileNaming')}>
                <input
                  className="w-full bg-surface border border-surface rounded-md p-2 text-sm text-text-primary focus:ring-accent focus:border-accent"
                  disabled={isExporting}
                  onChange={(e) => setFilenameTemplate(e.target.value)}
                  ref={filenameInputRef}
                  type="text"
                  value={filenameTemplate}
                />
                <div className="flex flex-wrap gap-2 mt-2">
                  {FILENAME_VARIABLES.map((variable: string) => (
                    <button
                      className="px-2 py-1 bg-surface text-text-secondary text-xs rounded-md hover:bg-card-active transition-colors disabled:opacity-50"
                      disabled={isExporting}
                      key={variable}
                      onClick={() => handleVariableClick(variable)}
                    >
                      {variable}
                    </button>
                  ))}
                </div>
              </Section>
            )}

            {fileFormat !== FileFormats.Cube && (
              <>
                <Section title={t('export.sections.imageSizing')}>
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
                </Section>

                {fileFormat == FileFormats.Jpeg && (
                  <Section title={t('export.sections.metadata')}>
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
                  </Section>
                )}

                <Section title={t('export.sections.watermark')}>
                  <Switch
                    label={t('export.watermark.addWatermark')}
                    checked={enableWatermark}
                    onChange={setEnableWatermark}
                    disabled={isExporting}
                    trackClassName="bg-surface"
                  />
                  {enableWatermark && (
                    <div className="space-y-4 pl-2 border-l-2 border-surface">
                      <ImagePicker
                        label={t('export.watermark.watermarkImage')}
                        imageName={watermarkPath ? watermarkPath.split(/[\\/]/).pop() || null : null}
                        onImageSelect={setWatermarkPath}
                        onClear={() => setWatermarkPath(null)}
                      />
                      {watermarkPath && (
                        <>
                          <Dropdown
                            options={anchorOptions}
                            value={watermarkAnchor}
                            onChange={(val) => setWatermarkAnchor(val as WatermarkAnchor)}
                            disabled={isExporting}
                            className="w-full"
                          />
                          <div>
                            <Slider
                              label={t('export.watermark.scale')}
                              min={1}
                              max={50}
                              step={1}
                              value={watermarkScale}
                              onChange={(e) => setWatermarkScale(parseInt(e.target.value))}
                              disabled={isExporting}
                              defaultValue={10}
                            />
                            <Slider
                              label={t('export.watermark.spacing')}
                              min={0}
                              max={25}
                              step={1}
                              value={watermarkSpacing}
                              onChange={(e) => setWatermarkSpacing(parseInt(e.target.value))}
                              disabled={isExporting}
                              defaultValue={5}
                            />
                            <Slider
                              label={t('export.watermark.opacity')}
                              min={0}
                              max={100}
                              step={1}
                              value={watermarkOpacity}
                              onChange={(e) => setWatermarkOpacity(parseInt(e.target.value))}
                              disabled={isExporting}
                              defaultValue={75}
                            />
                          </div>
                          <WatermarkPreview
                            imageAspectRatio={imageAspectRatio}
                            watermarkImageAspectRatio={watermarkImageAspectRatio}
                            watermarkPath={watermarkPath}
                            anchor={watermarkAnchor as WatermarkAnchor}
                            scale={watermarkScale}
                            spacing={watermarkSpacing}
                            opacity={watermarkOpacity}
                          />
                        </>
                      )}
                    </div>
                  )}
                </Section>
              </>
            )}

            <div>
              <Text variant={TextVariants.heading} className="mb-2">
                {t('export.sections.advanced')}
              </Text>
              <div className="bg-surface rounded-xl overflow-hidden">
                <button
                  onClick={() => setIsAdvancedExpanded(!isAdvancedExpanded)}
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
                        <Switch
                          label={t('export.advanced.preserveFolders')}
                          checked={preserveFolders}
                          onChange={setPreserveFolders}
                          disabled={isExporting}
                          trackClassName="bg-surface"
                        />
                        {fileFormat !== FileFormats.Cube && (
                          <>
                            <Switch
                              checked={preserveTimestamps}
                              disabled={isExporting}
                              label={t('export.advanced.preserveTimestamps')}
                              onChange={setPreserveTimestamps}
                              trackClassName="bg-surface"
                            />
                            {!isLibraryContext && (
                              <Switch
                                label={t('export.advanced.exportMasks')}
                                checked={exportMasks}
                                onChange={setExportMasks}
                                disabled={isExporting}
                                trackClassName="bg-surface"
                              />
                            )}
                          </>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </>
        ) : (
          <Text
            variant={TextVariants.heading}
            color={TextColors.secondary}
            weight={TextWeights.normal}
            className="text-center mt-4"
          >
            {isLibraryContext ? t('export.status.noImagesSelected') : t('export.status.noImageSelected')}
          </Text>
        )}
      </div>

      <div className="p-4 border-t border-surface shrink-0 space-y-2">
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
        <Button
          className={`group rounded-md h-11 w-full flex items-center text-md font-bold! justify-center ${
            status === Status.Exporting
              ? 'bg-red-600/80 hover:bg-red-600 text-white'
              : status === Status.Success
                ? 'bg-green-500/70 text-white shadow-none'
                : status === Status.Error
                  ? 'bg-red-500/20 text-red-400 shadow-none'
                  : status === Status.Cancelled
                    ? 'bg-yellow-500/20 text-yellow-400 shadow-none'
                    : ''
          }`}
          disabled={status === Status.Exporting ? false : !canExport}
          onClick={status === Status.Exporting ? handleCancel : handleExport}
          size="lg"
        >
          {status === Status.Exporting ? (
            <>
              <span className="flex items-center group-hover:hidden">
                <Loader size={18} className="animate-spin mr-2" />
                {progress.total > 1
                  ? t('export.status.exportingProgress', { current: progress.current, total: progress.total })
                  : t('export.status.exporting')}
              </span>
              <span className="hidden items-center group-hover:flex">
                <Ban size={18} className="mr-2" />
                {t('export.status.cancelExport')}
              </span>
            </>
          ) : status === Status.Success ? (
            <>
              <CheckCircle size={18} className="mr-2" /> {t('export.status.success')}
            </>
          ) : status === Status.Error ? (
            <>
              <XCircle size={18} className="mr-2" /> {errorMessage || t('export.status.failed')}
            </>
          ) : status === Status.Cancelled ? (
            <>
              <Ban size={18} className="mr-2" /> {t('export.status.cancelled')}
            </>
          ) : (
            <>
              <FileInput size={18} className="mr-2" />{' '}
              {numImages > 1
                ? t('export.status.exportMultiple', { count: numImages, label: itemLabelPlural })
                : t('export.status.exportSingle', { label: itemLabel })}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
