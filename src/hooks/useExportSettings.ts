import { useState, useMemo, useCallback } from 'react';
import { ExportPreset, WatermarkAnchor } from '../components/ui/ExportImportProperties';

export function useExportSettings() {
  const [fileFormat, setFileFormat] = useState('jpeg');
  const [jpegQuality, setJpegQuality] = useState(90);
  const [enableResize, setEnableResize] = useState(false);
  const [resizeMode, setResizeMode] = useState('longEdge');
  const [resizeValue, setResizeValue] = useState(2048);
  const [dontEnlarge, setDontEnlarge] = useState(true);
  const [keepMetadata, setKeepMetadata] = useState(true);
  const [preserveTimestamps, setPreserveTimestamps] = useState(false);
  const [stripGps, setStripGps] = useState(true);
  const [exportMasks, setExportMasks] = useState(false);
  const [preserveFolders, setPreserveFolders] = useState(false);
  const [filenameTemplate, setFilenameTemplate] = useState('{original_filename}_edited');
  const [enableWatermark, setEnableWatermark] = useState(false);
  const [watermarkPath, setWatermarkPath] = useState<string | null>(null);
  const [watermarkAnchor, setWatermarkAnchor] = useState<WatermarkAnchor>(WatermarkAnchor.BottomRight);
  const [watermarkScale, setWatermarkScale] = useState(10);
  const [watermarkSpacing, setWatermarkSpacing] = useState(5);
  const [watermarkOpacity, setWatermarkOpacity] = useState(75);
  // HDR export (AVIF/JXL): bitDepth 8 = SDR; 10/12 = HDR. transferFunction 'srgb'|'pq'|'hlg'.
  const [bitDepth, setBitDepth] = useState(8);
  const [transferFunction, setTransferFunction] = useState('srgb');
  const [primaries, setPrimaries] = useState('srgb');
  // matrix 'identity'|'ycbcr'; subsampling '444'|'422'|'420'; range 'full'|'limited'.
  // User-facing HDR defaults favour compatibility (ycbcr/420); SDR output is unchanged because
  // these fields are only emitted/used when bitDepth > 8 and the format is AVIF/JXL.
  const [matrix, setMatrix] = useState('ycbcr');
  const [chromaSubsampling, setChromaSubsampling] = useState('420');
  const [range, setRange] = useState('full');
  const [referenceWhiteNits, setReferenceWhiteNits] = useState(203);
  const [hlgPeakRatio, setHlgPeakRatio] = useState(12);
  const [masteringMetadata, setMasteringMetadata] = useState(false);

  const handleApplyPreset = useCallback((preset: ExportPreset) => {
    setFileFormat(preset.fileFormat);
    setJpegQuality(preset.jpegQuality);
    setEnableResize(preset.enableResize);
    setResizeMode(preset.resizeMode);
    setResizeValue(preset.resizeValue);
    setDontEnlarge(preset.dontEnlarge);
    setKeepMetadata(preset.keepMetadata);
    setPreserveTimestamps(preset.preserveTimestamps ?? false);
    setStripGps(preset.stripGps);
    setExportMasks(preset.exportMasks ?? false);
    setPreserveFolders(preset.preserveFolders ?? false);
    setFilenameTemplate(preset.filenameTemplate);
    setEnableWatermark(preset.enableWatermark);
    setWatermarkPath(preset.watermarkPath);
    setWatermarkAnchor(preset.watermarkAnchor as WatermarkAnchor);
    setWatermarkScale(preset.watermarkScale);
    setWatermarkSpacing(preset.watermarkSpacing);
    setWatermarkOpacity(preset.watermarkOpacity);
    setBitDepth(preset.bitDepth ?? 8);
    setTransferFunction(preset.transferFunction ?? 'srgb');
    setPrimaries(preset.primaries ?? 'srgb');
    setMatrix(preset.matrix ?? 'ycbcr');
    setChromaSubsampling(preset.chromaSubsampling ?? '420');
    setRange(preset.range ?? 'full');
    setReferenceWhiteNits(preset.referenceWhiteNits ?? 203);
    setHlgPeakRatio(preset.hlgPeakRatio ?? 12);
    setMasteringMetadata(preset.masteringMetadata ?? false);
  }, []);

  const currentSettingsObject = useMemo(
    () => ({
      fileFormat,
      jpegQuality,
      enableResize,
      resizeMode,
      resizeValue,
      dontEnlarge,
      keepMetadata,
      preserveTimestamps,
      stripGps,
      exportMasks,
      preserveFolders,
      filenameTemplate,
      enableWatermark,
      watermarkPath,
      watermarkAnchor,
      watermarkScale,
      watermarkSpacing,
      watermarkOpacity,
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
      fileFormat,
      jpegQuality,
      enableResize,
      resizeMode,
      resizeValue,
      dontEnlarge,
      keepMetadata,
      preserveTimestamps,
      stripGps,
      exportMasks,
      preserveFolders,
      filenameTemplate,
      enableWatermark,
      watermarkPath,
      watermarkAnchor,
      watermarkScale,
      watermarkSpacing,
      watermarkOpacity,
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

  return {
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
    preserveFolders,
    setPreserveFolders,
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
  };
}
