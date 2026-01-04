import { useState, useEffect, useRef, useMemo } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { Save, CheckCircle, XCircle, Loader, X, Ban } from 'lucide-react';
import debounce from 'lodash.debounce';
import Switch from '../../ui/Switch';
import Dropdown from '../../ui/Dropdown';
import Slider from '../../ui/Slider';
import ImagePicker from '../../ui/ImagePicker';
import {
  FileFormat,
  FILE_FORMATS,
  FILENAME_VARIABLES,
  Status,
  ExportSettings,
  ExportState,
  FileFormats,
  WatermarkAnchor,
} from './ExportImportProperties';
import { Invokes, ImageFile } from '../../ui/AppProperties';

interface LibraryExportPanelProps {
  exportState: ExportState;
  isVisible: boolean;
  multiSelectedPaths: Array<string>;
  onClose(): void;
  setExportState(state: any): void;
  imageList: ImageFile[];
}

interface SectionProps {
  children: any;
  title: string;
}

function Section({ title, children }: SectionProps) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-text-primary mb-3 border-b border-surface pb-2">{title}</h3>
      <div className="space-y-4">{children}</div>
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
      className="w-full bg-bg-primary rounded-md relative overflow-hidden border border-surface"
      style={{ aspectRatio: imageAspectRatio }}
    >
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-text-tertiary text-sm">Preview</span>
      </div>
      {watermarkPath && (
        <div style={getPositionStyles()}>
          <div
            className="w-full bg-accent/50 border-2 border-dashed border-accent rounded-sm flex items-center justify-center"
            style={{ aspectRatio: watermarkImageAspectRatio }}
          >
            <span className="text-white text-[8px] font-bold">Logo</span>
          </div>
        </div>
      )}
    </div>
  );
}

const formatBytes = (bytes: number, decimals = 2) => {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

const resizeModeOptions = [
  { label: 'Long Edge', value: 'longEdge' },
  { label: 'Short Edge', value: 'shortEdge' },
  { label: 'Width', value: 'width' },
  { label: 'Height', value: 'height' },
];

export default function LibraryExportPanel({
  exportState,
  isVisible,
  multiSelectedPaths,
  onClose,
  setExportState,
  imageList,
}: LibraryExportPanelProps) {
  const [fileFormat, setFileFormat] = useState('jpeg');
  const [jpegQuality, setJpegQuality] = useState(90);
  const [enableResize, setEnableResize] = useState(false);
  const [resizeMode, setResizeMode] = useState('longEdge');
  const [resizeValue, setResizeValue] = useState(2048);
  const [dontEnlarge, setDontEnlarge] = useState(true);
  const [keepMetadata, setKeepMetadata] = useState(true);
  const [stripGps, setStripGps] = useState(true);
  const [filenameTemplate, setFilenameTemplate] = useState('{original_filename}_edited');
  const [estimatedSize, setEstimatedSize] = useState<number | null>(null);
  const [isEstimating, setIsEstimating] = useState<boolean>(false);
  const [enableWatermark, setEnableWatermark] = useState<boolean>(false);
  const [watermarkPath, setWatermarkPath] = useState<string | null>(null);
  const [watermarkAnchor, setWatermarkAnchor] = useState<WatermarkAnchor>(WatermarkAnchor.BottomRight);
  const [watermarkScale, setWatermarkScale] = useState<number>(10);
  const [watermarkSpacing, setWatermarkSpacing] = useState<number>(5);
  const [watermarkOpacity, setWatermarkOpacity] = useState<number>(75);
  const [watermarkImageAspectRatio, setWatermarkImageAspectRatio] = useState(1);
  const filenameInputRef = useRef<HTMLInputElement>(null);

  const { status, progress, errorMessage } = exportState;
  const isExporting = status === Status.Exporting;

  const numImages = multiSelectedPaths.length;
  const [imageAspectRatio, setImageAspectRatio] = useState(3 / 2);

  useEffect(() => {
    if (!enableWatermark) {
      return;
    }

    if (multiSelectedPaths.length > 0) {
      const firstPath = multiSelectedPaths[0];
      const image = imageList.find((img) => img.path === firstPath);

      if (image && image.width > 0 && image.height > 0) {
        setImageAspectRatio(image.width / image.height);
      } else {
        console.warn(`Dimensions for ${firstPath} not found in imageList, using default aspect ratio for preview.`);
        setImageAspectRatio(3 / 2);
      }
    } else {
      setImageAspectRatio(16 / 9);
    }
  }, [multiSelectedPaths, imageList, enableWatermark]);

  useEffect(() => {
    const fetchWatermarkDimensions = async () => {
      if (watermarkPath) {
        try {
          const dimensions: { width: number; height: number } = await invoke('get_image_dimensions', {
            path: watermarkPath,
          });
          if (dimensions.height > 0) {
            setWatermarkImageAspectRatio(dimensions.width / dimensions.height);
          } else {
            setWatermarkImageAspectRatio(1);
          }
        } catch (error) {
          console.error('Failed to get watermark dimensions:', error);
          setWatermarkImageAspectRatio(1);
        }
      } else {
        setWatermarkImageAspectRatio(1);
      }
    };
    fetchWatermarkDimensions();
  }, [watermarkPath]);

  const anchorOptions = [
    { label: 'Top Left', value: WatermarkAnchor.TopLeft },
    { label: 'Top Center', value: WatermarkAnchor.TopCenter },
    { label: 'Top Right', value: WatermarkAnchor.TopRight },
    { label: 'Center Left', value: WatermarkAnchor.CenterLeft },
    { label: 'Center', value: WatermarkAnchor.Center },
    { label: 'Center Right', value: WatermarkAnchor.CenterRight },
    { label: 'Bottom Left', value: WatermarkAnchor.BottomLeft },
    { label: 'Bottom Center', value: WatermarkAnchor.BottomCenter },
    { label: 'Bottom Right', value: WatermarkAnchor.BottomRight },
  ];

  const debouncedEstimateSize = useMemo(
    () =>
      debounce(async (paths, exportSettings, format) => {
        setIsEstimating(true);
        try {
          const size: number = await invoke(Invokes.EstimateBatchExportSize, {
            paths,
            exportSettings,
            outputFormat: format,
          });
          setEstimatedSize(size);
        } catch (err) {
          console.error('Failed to estimate batch export size:', err);
          setEstimatedSize(null);
        } finally {
          setIsEstimating(false);
        }
      }, 500),
    [],
  );

  useEffect(() => {
    if (!isVisible || multiSelectedPaths.length === 0) {
      setEstimatedSize(null);
      debouncedEstimateSize.cancel();
      return;
    }

    const exportSettings: ExportSettings = {
      filenameTemplate,
      jpegQuality,
      keepMetadata,
      resize: enableResize ? { mode: resizeMode, value: resizeValue, dontEnlarge } : null,
      stripGps,
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
    };
    const format = FILE_FORMATS.find((f: FileFormat) => f.id === fileFormat)?.extensions[0] || 'jpeg';
    debouncedEstimateSize(multiSelectedPaths, exportSettings, format);

    return () => debouncedEstimateSize.cancel();
  }, [
    isVisible,
    multiSelectedPaths,
    fileFormat,
    jpegQuality,
    enableResize,
    resizeMode,
    resizeValue,
    dontEnlarge,
    keepMetadata,
    stripGps,
    filenameTemplate,
    enableWatermark,
    watermarkPath,
    watermarkAnchor,
    watermarkScale,
    watermarkSpacing,
    watermarkOpacity,
    debouncedEstimateSize,
  ]);

  const handleVariableClick = (variable: string) => {
    if (!filenameInputRef.current) {
      return;
    }

    const input = filenameInputRef.current;
    const start = Number(input.selectionStart);
    const end = Number(input.selectionEnd);
    const currentValue = input.value;

    const newValue = currentValue.substring(0, start) + variable + currentValue.substring(end);
    setFilenameTemplate(newValue);

    setTimeout(() => {
      input.focus();
      const newCursorPos = start + variable.length;
      input.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  };

  const handleExport = async () => {
    if (numImages === 0 || isExporting) {
      return;
    }

    setExportState({ status: Status.Exporting, progress: { current: 0, total: numImages }, errorMessage: '' });

    let finalFilenameTemplate = filenameTemplate;
    if (numImages > 1 && !filenameTemplate.includes('{sequence}') && !filenameTemplate.includes('{original_filename}')) {
      finalFilenameTemplate = `${filenameTemplate}_{sequence}`;
      setFilenameTemplate(finalFilenameTemplate);
    }

    const exportSettings: ExportSettings = {
      filenameTemplate: finalFilenameTemplate,
      jpegQuality: jpegQuality,
      keepMetadata,
      resize: enableResize ? { mode: resizeMode, value: resizeValue, dontEnlarge } : null,
      stripGps,
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
    };

    try {
      const outputFolder = await open({
        directory: true,
        title: `Select Folder to Export ${numImages} Image(s)`,
      });

      if (outputFolder) {
        await invoke(Invokes.BatchExportImages, {
          exportSettings,
          outputFolder,
          outputFormat: FILE_FORMATS.find((f: FileFormat) => f.id === fileFormat)?.extensions[0],
          paths: multiSelectedPaths,
        });
      } else {
        setExportState((prev: ExportState) => ({ ...prev, status: Status.Idle }));
      }
    } catch (error) {
      console.error('Error exporting images:', error);
      setExportState({
        errorMessage: typeof error === 'string' ? error : 'Failed to start export.',
        progress,
        status: Status.Error,
      });
    }
  };

  const handleCancel = async () => {
    try {
      await invoke(Invokes.CancelExport);
    } catch (error) {
      console.error('Failed to send cancel request:', error);
    }
  };

  const canExport = numImages > 0;

  return (
    <div className="h-full bg-bg-secondary rounded-lg flex flex-col">
      <div className="p-4 flex justify-between items-center flex-shrink-0 border-b border-surface">
        <h2 className="text-xl font-bold text-primary text-shadow-shiny">
          Export {numImages > 1 ? `(${numImages})` : ''}
        </h2>
        <button
          onClick={onClose}
          className="p-1 rounded-md text-text-secondary hover:bg-surface hover:text-text-primary"
        >
          <X size={20} />
        </button>
      </div>
      <div className="flex-grow overflow-y-auto p-4 text-text-secondary space-y-6">
        {canExport ? (
          <>
            <Section title="File Settings">
              <div className="grid grid-cols-3 gap-2">
                {FILE_FORMATS.map((format: FileFormat) => (
                  <button
                    className={`px-2 py-1.5 text-sm rounded-md transition-colors ${
                      fileFormat === format.id ? 'bg-accent text-button-text' : 'bg-surface hover:bg-card-active'
                    } disabled:opacity-50`}
                    disabled={isExporting}
                    key={format.id}
                    onClick={() => setFileFormat(format.id)}
                  >
                    {format.name}
                  </button>
                ))}
              </div>
              {fileFormat === FileFormats.Jpeg && (
                <div className={isExporting ? 'opacity-50 pointer-events-none' : ''}>
                  <Slider
                    defaultValue={90}
                    label="Quality"
                    max={100}
                    min={1}
                    onChange={(e) => setJpegQuality(parseInt(e.target.value))}
                    step={1}
                    value={jpegQuality}
                  />
                </div>
              )}
            </Section>

            <Section title="File Naming">
              <input
                className="w-full bg-bg-primary border border-surface rounded-md p-2 text-sm text-text-primary focus:ring-accent focus:border-accent"
                disabled={isExporting}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFilenameTemplate(e.target.value)}
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

            <Section title="Image Sizing">
              <Switch label="Resize to Fit" checked={enableResize} onChange={setEnableResize} disabled={isExporting} />
              {enableResize && (
                <div className="space-y-4 pl-2 border-l-2 border-surface">
                  <div className="flex items-center gap-2">
                    <div className={`w-full ${isExporting ? 'opacity-50 pointer-events-none' : ''}`}>
                      <Dropdown options={resizeModeOptions} value={resizeMode} onChange={setResizeMode} />
                    </div>
                    <input
                      className="w-24 bg-bg-primary text-center rounded-md p-2 border border-surface focus:border-accent focus:ring-accent"
                      disabled={isExporting}
                      min="1"
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setResizeValue(parseInt(e?.target?.value))}
                      type="number"
                      value={resizeValue}
                    />
                    <span className="text-sm">pixels</span>
                  </div>
                  <Switch
                    checked={dontEnlarge}
                    disabled={isExporting}
                    label="Don't Enlarge"
                    onChange={setDontEnlarge}
                  />
                </div>
              )}
            </Section>

            <Section title="Metadata">
              <Switch
                checked={keepMetadata}
                disabled={isExporting}
                label="Keep Original Metadata"
                onChange={setKeepMetadata}
              />
              {keepMetadata && (
                <div className="pl-2 border-l-2 border-surface">
                  <Switch label="Remove GPS Data" checked={stripGps} onChange={setStripGps} disabled={isExporting} />
                </div>
              )}
            </Section>

            <Section title="Watermark">
              <Switch
                label="Add Watermark"
                checked={enableWatermark}
                onChange={setEnableWatermark}
                disabled={isExporting}
              />
              {enableWatermark && (
                <div className="space-y-4 pl-2 border-l-2 border-surface">
                  <ImagePicker
                    label="Watermark Image"
                    imageName={watermarkPath ? watermarkPath.split(/[\\/]/).pop() || null : null}
                    onImageSelect={setWatermarkPath}
                    onClear={() => setWatermarkPath(null)}
                  />
                  {watermarkPath && (
                    <>
                      <div className={`w-full ${isExporting ? 'opacity-50 pointer-events-none' : ''}`}>
                        <Dropdown options={anchorOptions} value={watermarkAnchor} onChange={setWatermarkAnchor} />
                      </div>
                      <Slider
                        label="Scale"
                        min={1}
                        max={50}
                        step={1}
                        value={watermarkScale}
                        onChange={(e) => setWatermarkScale(parseInt(e.target.value))}
                        disabled={isExporting}
                        defaultValue={10}
                      />
                      <Slider
                        label="Spacing"
                        min={0}
                        max={25}
                        step={1}
                        value={watermarkSpacing}
                        onChange={(e) => setWatermarkSpacing(parseInt(e.target.value))}
                        disabled={isExporting}
                        defaultValue={5}
                      />
                      <Slider
                        label="Opacity"
                        min={0}
                        max={100}
                        step={1}
                        value={watermarkOpacity}
                        onChange={(e) => setWatermarkOpacity(parseInt(e.target.value))}
                        disabled={isExporting}
                        defaultValue={75}
                      />
                      <WatermarkPreview
                        imageAspectRatio={imageAspectRatio}
                        watermarkImageAspectRatio={watermarkImageAspectRatio}
                        watermarkPath={watermarkPath}
                        anchor={watermarkAnchor}
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
        ) : (
          <p className="text-center text-text-tertiary mt-4">No images selected.</p>
        )}
      </div>

      <div className="p-4 border-t border-surface flex-shrink-0 space-y-3">
        <div className="text-center text-xs text-text-tertiary h-4">
          {isEstimating ? (
            <span className="italic">Estimating size...</span>
          ) : estimatedSize !== null ? (
            <span>
              Estimated total size: ~{formatBytes(estimatedSize)}
              {numImages > 1 && ` (${formatBytes(estimatedSize / numImages)} avg)`}
            </span>
          ) : null}
        </div>
        {isExporting ? (
          <button
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-red-600/80 text-white font-bold rounded-lg hover:bg-red-600 transition-all"
            onClick={handleCancel}
          >
            <Ban size={18} />
            Cancel Export
          </button>
        ) : (
          <button
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-accent text-button-text font-bold rounded-lg hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            disabled={!canExport || isExporting}
            onClick={handleExport}
          >
            <Save size={18} />
            Export {numImages > 1 ? `${numImages} Images` : 'Image'}
          </button>
        )}

        {status === Status.Exporting && (
          <div className="flex items-center gap-2 text-accent mt-3 text-sm justify-center">
            <Loader size={16} className="animate-spin" />
            <span>{`Exporting... (${progress.current}/${progress.total})`}</span>
          </div>
        )}
        {status === Status.Success && (
          <div className="flex items-center gap-2 text-green-400 mt-3 text-sm justify-center">
            <CheckCircle size={16} />
            <span>Export successful!</span>
          </div>
        )}
        {status === Status.Error && (
          <div className="flex items-center gap-2 text-red-400 mt-3 text-sm justify-center text-center">
            <XCircle size={16} />
            <span>{errorMessage}</span>
          </div>
        )}
        {status === Status.Cancelled && (
          <div className="flex items-center gap-2 text-yellow-400 mt-3 text-sm justify-center">
            <Ban size={16} />
            <span>Export cancelled.</span>
          </div>
        )}
      </div>
    </div>
  );
}