import { useCallback, useRef } from 'react';
import { borrow } from '@blac/core';
import { useBloc } from '@blac/react';
import { EditorBloc } from '../../blocs/editor/EditorBloc.js';
import { AdjustmentsBloc } from '../../blocs/editor/AdjustmentsBloc.js';
import { ExportBloc, FILE_FORMATS, FILENAME_VARIABLES, RESIZE_MODE_OPTIONS } from '../../blocs/editor/ExportBloc.js';
import { SelectionBloc } from '../../blocs/library/SelectionBloc.js';
import { TauriService } from '../../blocs/services/TauriService.js';
import { CollapsibleSection } from '../../primitives/CollapsibleSection.js';
import { Slider } from '../../primitives/Slider.js';
import { Dropdown } from '../../primitives/Dropdown.js';

function formatBytes(bytes: number, decimals = 2): string {
  if (!bytes) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

interface SwitchRowProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

function SwitchRow({ label, checked, onChange, disabled }: SwitchRowProps) {
  return (
    <label className={`flex items-center justify-between py-1 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <span className="text-sm text-text-secondary">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`relative w-10 h-5 rounded-full transition-colors ${
          checked ? 'bg-accent' : 'bg-surface'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </label>
  );
}

export function ExportPanel() {
  const [editor] = useBloc(EditorBloc);
  const [exportBloc, exportBlocRef] = useBloc(ExportBloc);
  const [selection] = useBloc(SelectionBloc);
  const filenameInputRef = useRef<HTMLInputElement>(null);

  const { selectedImage } = editor;
  const { settings, status, progress, estimatedSize, isEstimating, resizeMode, resizeValue, dontEnlarge, stripGps, filenameTemplate } = exportBloc;
  const isExporting = status === 'exporting';

  const selectedPaths = selection.selectedPaths;
  const pathsToExport = selectedPaths.length > 0 ? selectedPaths : selectedImage ? [selectedImage.path] : [];
  const numImages = pathsToExport.length;
  const isBatchMode = numImages > 1;
  const canExport = numImages > 0;

  const handleVariableClick = useCallback((variable: string) => {
    const input = filenameInputRef.current;
    if (!input) return;

    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? 0;
    const currentValue = input.value;
    const newValue = currentValue.substring(0, start) + variable + currentValue.substring(end);
    
    exportBlocRef.setFilenameTemplate(newValue);
    
    setTimeout(() => {
      input.focus();
      const newPos = start + variable.length;
      input.setSelectionRange(newPos, newPos);
    }, 0);
  }, [exportBlocRef]);

  const handleExport = useCallback(async () => {
    if (!canExport || isExporting) return;
    exportBlocRef.startExport(numImages);

    try {
      const tauri = borrow(TauriService);
      const adjustmentsBloc = borrow(AdjustmentsBloc);

      if (numImages === 1 && selectedImage) {
        await tauri.exportImage(selectedImage.path, settings, adjustmentsBloc.current);
      } else if (settings.outputFolder) {
        await tauri.exportImages(pathsToExport, settings, settings.outputFolder);
      }
      exportBlocRef.completeExport();
    } catch (error) {
      exportBlocRef.setError(error instanceof Error ? error.message : String(error));
    }
  }, [canExport, isExporting, numImages, selectedImage, pathsToExport, settings, exportBlocRef]);

  const handleCancel = useCallback(() => {
    exportBlocRef.cancelExport();
  }, [exportBlocRef]);

  const resizeModeOptions = RESIZE_MODE_OPTIONS.map((opt) => ({
    value: opt.value,
    label: opt.label,
  }));

  if (!canExport) {
    return (
      <div className="flex flex-col h-full">
        <div className="p-4 flex justify-between items-center flex-shrink-0 border-b border-surface">
          <h2 className="text-lg font-bold text-text-primary">Export</h2>
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-sm text-text-secondary text-center">No images selected for export</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 flex justify-between items-center flex-shrink-0 border-b border-surface">
        <h2 className="text-lg font-bold text-text-primary">
          Export {numImages > 1 ? `(${numImages})` : ''}
        </h2>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-4">
          <CollapsibleSection title="File Format">
            <div className="grid grid-cols-4 gap-2">
              {FILE_FORMATS.map((format) => (
                <button
                  key={format.id}
                  disabled={isExporting}
                  onClick={() => exportBlocRef.setFormat(format.id as 'jpeg' | 'png' | 'tiff' | 'webp')}
                  className={`px-2 py-1.5 text-sm rounded-md transition-colors ${
                    settings.format === format.id
                      ? 'bg-accent text-black font-medium'
                      : 'bg-surface hover:bg-surface-secondary text-text-secondary'
                  } disabled:opacity-50`}
                >
                  {format.name}
                </button>
              ))}
            </div>
            {settings.format === 'jpeg' && (
              <div className="mt-3">
                <Slider
                  label="Quality"
                  value={settings.quality}
                  min={1}
                  max={100}
                  step={1}
                  onChange={(value) => exportBlocRef.setQuality(value)}
                  disabled={isExporting}
                />
              </div>
            )}
          </CollapsibleSection>

          {isBatchMode && (
            <CollapsibleSection title="File Naming">
              <input
                ref={filenameInputRef}
                type="text"
                value={filenameTemplate}
                onChange={(e) => exportBlocRef.setFilenameTemplate(e.target.value)}
                disabled={isExporting}
                className="w-full bg-bg-primary border border-surface rounded-md px-3 py-2 text-sm text-text-primary focus:ring-1 focus:ring-accent focus:border-accent disabled:opacity-50"
              />
              <div className="flex flex-wrap gap-1 mt-2">
                {FILENAME_VARIABLES.map((variable) => (
                  <button
                    key={variable}
                    onClick={() => handleVariableClick(variable)}
                    disabled={isExporting}
                    className="px-2 py-1 bg-surface text-text-secondary text-xs rounded hover:bg-surface-secondary disabled:opacity-50"
                  >
                    {variable}
                  </button>
                ))}
              </div>
            </CollapsibleSection>
          )}

          <CollapsibleSection title="Image Sizing">
            <SwitchRow
              label="Resize to Fit"
              checked={settings.resizeEnabled}
              onChange={(v) => exportBlocRef.setResizeEnabled(v)}
              disabled={isExporting}
            />
            {settings.resizeEnabled && (
              <div className="mt-3 pl-3 border-l-2 border-surface space-y-3">
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <Dropdown
                      options={resizeModeOptions}
                      value={resizeMode}
                      onChange={(v) => exportBlocRef.setResizeMode(v as typeof resizeMode)}
                      disabled={isExporting}
                    />
                  </div>
                  <input
                    type="number"
                    value={resizeValue}
                    onChange={(e) => exportBlocRef.setResizeValue(parseInt(e.target.value) || 1)}
                    disabled={isExporting}
                    min={1}
                    className="w-20 bg-bg-primary border border-surface rounded-md px-2 py-1.5 text-sm text-text-primary text-center focus:ring-1 focus:ring-accent disabled:opacity-50"
                  />
                  <span className="text-xs text-text-secondary">px</span>
                </div>
                <SwitchRow
                  label="Don't Enlarge"
                  checked={dontEnlarge}
                  onChange={(v) => exportBlocRef.setDontEnlarge(v)}
                  disabled={isExporting}
                />
              </div>
            )}
          </CollapsibleSection>

          <CollapsibleSection title="Metadata">
            <SwitchRow
              label="Preserve Original Metadata"
              checked={settings.preserveMetadata}
              onChange={(v) => exportBlocRef.setPreserveMetadata(v)}
              disabled={isExporting}
            />
            {settings.preserveMetadata && (
              <div className="mt-2 pl-3 border-l-2 border-surface">
                <SwitchRow
                  label="Remove GPS Data"
                  checked={stripGps}
                  onChange={(v) => exportBlocRef.setStripGps(v)}
                  disabled={isExporting}
                />
              </div>
            )}
          </CollapsibleSection>

          <CollapsibleSection title="Color Space">
            <div className="grid grid-cols-3 gap-2">
              {(['srgb', 'adobe-rgb', 'prophoto-rgb'] as const).map((cs) => (
                <button
                  key={cs}
                  disabled={isExporting}
                  onClick={() => exportBlocRef.setColorSpace(cs)}
                  className={`px-2 py-1.5 text-xs rounded-md transition-colors ${
                    settings.colorSpace === cs
                      ? 'bg-accent text-black font-medium'
                      : 'bg-surface hover:bg-surface-secondary text-text-secondary'
                  } disabled:opacity-50`}
                >
                  {cs === 'srgb' ? 'sRGB' : cs === 'adobe-rgb' ? 'Adobe RGB' : 'ProPhoto'}
                </button>
              ))}
            </div>
          </CollapsibleSection>
        </div>
      </div>

      <div className="p-4 border-t border-surface flex-shrink-0 space-y-3">
        <div className="text-center text-xs text-text-secondary h-4">
          {isEstimating ? (
            <span className="italic">Estimating size...</span>
          ) : estimatedSize !== null ? (
            <span>Estimated file size: ~{formatBytes(estimatedSize)}</span>
          ) : null}
        </div>

        {isExporting ? (
          <button
            onClick={handleCancel}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-red-600/80 text-white font-bold rounded-lg hover:bg-red-600"
          >
            Cancel Export
          </button>
        ) : (
          <button
            onClick={handleExport}
            disabled={!canExport}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-accent text-black font-bold rounded-lg hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Export {numImages > 1 ? `${numImages} Images` : 'Image'}
          </button>
        )}

        {status === 'exporting' && (
          <div className="flex items-center gap-2 text-accent text-sm justify-center">
            <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full" style={{ animation: 'spin 1s linear infinite' }} />
            <span>Exporting... ({progress.current}/{progress.total})</span>
          </div>
        )}
        {status === 'completed' && (
          <div className="flex items-center gap-2 text-green-400 text-sm justify-center">
            <span>Export successful!</span>
          </div>
        )}
        {status === 'error' && (
          <div className="flex items-center gap-2 text-red-400 text-sm justify-center text-center">
            <span>{progress.error || 'Export failed'}</span>
          </div>
        )}
        {status === 'cancelled' && (
          <div className="flex items-center gap-2 text-yellow-400 text-sm justify-center">
            <span>Export cancelled</span>
          </div>
        )}
      </div>
    </div>
  );
}
