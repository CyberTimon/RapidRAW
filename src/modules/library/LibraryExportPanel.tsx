import { useState, useCallback } from 'react';
import { Blac } from '@blac/core';
import { useBloc } from '@blac/react';
import { Save, X, Loader, CheckCircle, XCircle, Ban } from 'lucide-react';
import { SelectionBloc } from '../../blocs/library/SelectionBloc';
import { TauriService } from '../../blocs/services/TauriService';
import { Slider } from '../../primitives/Slider';
import { Switch } from '../../primitives/Switch';
import { Dropdown } from '../../primitives/Dropdown';
import { Button } from '../../primitives/Button';
import type { ExportSettings } from '../../types/editor';

type ExportFormat = 'jpeg' | 'png' | 'tiff' | 'webp';
type ResizeMode = 'longEdge' | 'shortEdge' | 'width' | 'height';
type ExportStatus = 'idle' | 'exporting' | 'success' | 'error' | 'cancelled';

const FILE_FORMATS: { value: ExportFormat; label: string }[] = [
  { value: 'jpeg', label: 'JPEG' },
  { value: 'png', label: 'PNG' },
  { value: 'tiff', label: 'TIFF' },
  { value: 'webp', label: 'WebP' },
];

const RESIZE_MODES: { value: ResizeMode; label: string }[] = [
  { value: 'longEdge', label: 'Long Edge' },
  { value: 'shortEdge', label: 'Short Edge' },
  { value: 'width', label: 'Width' },
  { value: 'height', label: 'Height' },
];

const FILENAME_VARIABLES = ['{original_filename}', '{sequence}', '{date}', '{time}'];

interface SectionProps {
  title: string;
  children: React.ReactNode;
}

function Section({ title, children }: SectionProps) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-text-primary mb-3 border-b border-surface pb-2">
        {title}
      </h3>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

interface LibraryExportPanelProps {
  onClose?: () => void;
}

export function LibraryExportPanel({ onClose }: LibraryExportPanelProps) {
  const [selection] = useBloc(SelectionBloc);

  const [fileFormat, setFileFormat] = useState<ExportFormat>('jpeg');
  const [jpegQuality, setJpegQuality] = useState(90);
  const [enableResize, setEnableResize] = useState(false);
  const [resizeMode, setResizeMode] = useState<ResizeMode>('longEdge');
  const [resizeValue, setResizeValue] = useState(2048);
  const [dontEnlarge, setDontEnlarge] = useState(true);
  const [keepMetadata, setKeepMetadata] = useState(true);
  const [stripGps, setStripGps] = useState(true);
  const [filenameTemplate, setFilenameTemplate] = useState('{original_filename}_edited');

  const [exportStatus, setExportStatus] = useState<ExportStatus>('idle');
  const [exportProgress, setExportProgress] = useState({ current: 0, total: 0 });
  const [errorMessage, setErrorMessage] = useState('');

  const numImages = selection.selectedPaths.length;
  const isExporting = exportStatus === 'exporting';
  const canExport = numImages > 0;

  const handleVariableClick = (variable: string) => {
    setFilenameTemplate((prev) => prev + variable);
  };

  const handleExport = useCallback(async () => {
    if (!canExport || isExporting) return;

    setExportStatus('exporting');
    setExportProgress({ current: 0, total: numImages });
    setErrorMessage('');

    try {
      const tauri = Blac.getBloc(TauriService);
      const outputFolder = await tauri.openFolderDialog();
      
      if (!outputFolder) {
        setExportStatus('cancelled');
        return;
      }

      const exportSettings: ExportSettings = {
        format: fileFormat,
        quality: jpegQuality,
        resizeEnabled: enableResize,
        resizeWidth: enableResize ? resizeValue : undefined,
        resizeMode: 'fit',
        colorSpace: 'srgb',
        bitDepth: 8,
        preserveMetadata: keepMetadata,
        watermarkEnabled: false,
        namingPattern: filenameTemplate,
      };

      await tauri.exportImages(selection.selectedPaths, exportSettings, outputFolder);
      setExportStatus('success');
    } catch (error) {
      setExportStatus('error');
      setErrorMessage(error instanceof Error ? error.message : 'Export failed');
    }
  }, [canExport, isExporting, numImages, fileFormat, jpegQuality, enableResize, resizeValue, keepMetadata, filenameTemplate, selection.selectedPaths]);

  const handleCancel = useCallback(() => {
    setExportStatus('cancelled');
  }, []);

  return (
    <div className="h-full bg-bg-secondary flex flex-col">
      <div className="p-4 flex justify-between items-center flex-shrink-0 border-b border-surface">
        <h2 className="text-lg font-bold text-text-primary text-shadow-shiny">
          Export {numImages > 1 ? `(${numImages})` : ''}
        </h2>
        {onClose && (
          <button
            onClick={onClose}
            className="p-1 rounded-md text-text-secondary hover:bg-surface hover:text-text-primary"
          >
            <X size={20} />
          </button>
        )}
      </div>

      <div className="flex-grow overflow-y-auto p-4 text-text-secondary space-y-6">
        {canExport ? (
          <>
            <Section title="File Settings">
              <div className="grid grid-cols-2 gap-2">
                {FILE_FORMATS.map((format) => (
                  <button
                    key={format.value}
                    className={`px-2 py-1.5 text-sm rounded-md ${
                      fileFormat === format.value
                        ? 'bg-accent text-button-text'
                        : 'bg-surface hover:bg-card-active'
                    } disabled:opacity-50`}
                    disabled={isExporting}
                    onClick={() => setFileFormat(format.value)}
                  >
                    {format.label}
                  </button>
                ))}
              </div>
              {fileFormat === 'jpeg' && (
                <div className={isExporting ? 'opacity-50 pointer-events-none' : ''}>
                  <Slider
                    label="Quality"
                    value={jpegQuality}
                    min={1}
                    max={100}
                    step={1}
                    defaultValue={90}
                    onChange={setJpegQuality}
                  />
                </div>
              )}
            </Section>

            <Section title="File Naming">
              <input
                type="text"
                className="w-full bg-bg-primary border border-surface rounded-md p-2 text-sm text-text-primary focus:outline-none focus:border-accent"
                disabled={isExporting}
                value={filenameTemplate}
                onChange={(e) => setFilenameTemplate(e.target.value)}
              />
              <div className="flex flex-wrap gap-2 mt-2">
                {FILENAME_VARIABLES.map((variable) => (
                  <button
                    key={variable}
                    className="px-2 py-1 bg-surface text-text-secondary text-xs rounded-md hover:bg-card-active disabled:opacity-50"
                    disabled={isExporting}
                    onClick={() => handleVariableClick(variable)}
                  >
                    {variable}
                  </button>
                ))}
              </div>
            </Section>

            <Section title="Image Sizing">
              <Switch
                label="Resize to Fit"
                checked={enableResize}
                onChange={setEnableResize}
                disabled={isExporting}
              />
              {enableResize && (
                <div className="space-y-4 pl-2 border-l-2 border-surface">
                  <div className="flex items-center gap-2">
                    <div className={`flex-1 ${isExporting ? 'opacity-50 pointer-events-none' : ''}`}>
                      <Dropdown
                        options={RESIZE_MODES}
                        value={resizeMode}
                        onChange={(v) => setResizeMode(v as ResizeMode)}
                      />
                    </div>
                    <input
                      type="number"
                      className="w-20 bg-bg-primary text-center rounded-md p-2 border border-surface focus:border-accent text-sm"
                      disabled={isExporting}
                      min={1}
                      value={resizeValue}
                      onChange={(e) => setResizeValue(parseInt(e.target.value) || 0)}
                    />
                    <span className="text-sm">px</span>
                  </div>
                  <Switch
                    label="Don't Enlarge"
                    checked={dontEnlarge}
                    onChange={setDontEnlarge}
                    disabled={isExporting}
                  />
                </div>
              )}
            </Section>

            <Section title="Metadata">
              <Switch
                label="Keep Original Metadata"
                checked={keepMetadata}
                onChange={setKeepMetadata}
                disabled={isExporting}
              />
              {keepMetadata && (
                <div className="pl-2 border-l-2 border-surface">
                  <Switch
                    label="Remove GPS Data"
                    checked={stripGps}
                    onChange={setStripGps}
                    disabled={isExporting}
                  />
                </div>
              )}
            </Section>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <svg
              className="w-12 h-12 text-text-secondary mb-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
            <p className="text-text-secondary text-sm">No images selected</p>
            <p className="text-text-secondary text-xs mt-1">
              Select images in the gallery to export
            </p>
          </div>
        )}
      </div>

      <div className="p-4 border-t border-surface flex-shrink-0 space-y-3">
        {isExporting ? (
          <Button
            variant="destructive"
            className="w-full"
            onClick={handleCancel}
          >
            <Ban size={18} />
            Cancel Export
          </Button>
        ) : (
          <Button
            variant="primary"
            className="w-full"
            disabled={!canExport}
            onClick={handleExport}
          >
            <Save size={18} />
            Export {numImages > 1 ? `${numImages} Images` : numImages === 1 ? 'Image' : ''}
          </Button>
        )}

        {exportStatus === 'exporting' && (
          <div className="flex items-center gap-2 text-accent text-sm justify-center">
            <Loader size={16} className="animate-spin" />
            <span>{`Exporting... (${exportProgress.current}/${exportProgress.total})`}</span>
          </div>
        )}
        {exportStatus === 'success' && (
          <div className="flex items-center gap-2 text-green-400 text-sm justify-center">
            <CheckCircle size={16} />
            <span>Export successful!</span>
          </div>
        )}
        {exportStatus === 'error' && (
          <div className="flex items-center gap-2 text-red-400 text-sm justify-center text-center">
            <XCircle size={16} />
            <span>{errorMessage}</span>
          </div>
        )}
        {exportStatus === 'cancelled' && (
          <div className="flex items-center gap-2 text-yellow-400 text-sm justify-center">
            <Ban size={16} />
            <span>Export cancelled.</span>
          </div>
        )}
      </div>
    </div>
  );
}
