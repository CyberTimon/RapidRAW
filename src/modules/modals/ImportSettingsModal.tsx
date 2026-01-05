import { useEffect, useRef, useState, useCallback } from 'react';
import { useBloc } from '@blac/react';
import { Modal } from '../../primitives/Modal';
import { Button } from '../../primitives/Button';
import { Switch } from '../../primitives/Switch';
import { ModalBloc } from '../../blocs/app/ModalBloc';

const FILENAME_VARIABLES = [
  '{original_filename}',
  '{sequence}',
  '{YYYY}',
  '{MM}',
  '{DD}',
  '{hh}',
  '{mm}',
];

export interface ImportSettings {
  filenameTemplate: string;
  organizeByDate: boolean;
  dateFolderFormat: string;
  deleteAfterImport: boolean;
}

export function ImportSettingsModal() {
  const [state, modalBloc] = useBloc(ModalBloc);
  const isOpen = state.openModals.includes('import-settings');
  const data = state.modalData['import-settings'] as { fileCount: number; onImport: (settings: ImportSettings) => void } | undefined;

  const [filenameTemplate, setFilenameTemplate] = useState('{original_filename}');
  const [organizeByDate, setOrganizeByDate] = useState(false);
  const [dateFolderFormat, setDateFolderFormat] = useState('YYYY/MM-DD');
  const [deleteAfterImport, setDeleteAfterImport] = useState(false);
  const filenameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setFilenameTemplate('{original_filename}');
      setOrganizeByDate(false);
      setDateFolderFormat('YYYY/MM-DD');
      setDeleteAfterImport(false);
      setTimeout(() => filenameInputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const handleImport = useCallback(() => {
    if (!data) return;

    let finalFilenameTemplate = filenameTemplate;
    if (
      data.fileCount > 1 &&
      !filenameTemplate.includes('{sequence}') &&
      !filenameTemplate.includes('{original_filename}')
    ) {
      finalFilenameTemplate = `${filenameTemplate}_{sequence}`;
    }

    data.onImport({
      filenameTemplate: finalFilenameTemplate,
      organizeByDate,
      dateFolderFormat,
      deleteAfterImport,
    });
    modalBloc.close('import-settings');
  }, [data, filenameTemplate, organizeByDate, dateFolderFormat, deleteAfterImport, modalBloc]);

  const handleClose = () => {
    modalBloc.close('import-settings');
  };

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleImport();
      }
    },
    [handleImport]
  );

  const handleVariableClick = (variable: string) => {
    if (!filenameInputRef.current) return;

    const input = filenameInputRef.current;
    const start = input.selectionStart || 0;
    const end = input.selectionEnd || 0;
    const currentValue = input.value;
    const newValue = currentValue.substring(0, start) + variable + currentValue.substring(end);
    setFilenameTemplate(newValue);

    setTimeout(() => {
      input.focus();
      const newCursorPos = start + variable.length;
      input.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  };

  if (!isOpen || !data) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Import Settings"
      size="md"
    >
      <div className="space-y-6" onKeyDown={handleKeyDown}>
        <div>
          <label className="block font-semibold text-text-primary mb-2 text-sm">
            File Naming
          </label>
          <input
            ref={filenameInputRef}
            type="text"
            value={filenameTemplate}
            onChange={(e) => setFilenameTemplate(e.target.value)}
            className="w-full px-3 py-2 bg-bg-primary border border-border-color rounded-md text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
          />
          <div className="flex flex-wrap gap-2 mt-2">
            {FILENAME_VARIABLES.map((variable) => (
              <button
                key={variable}
                onClick={() => handleVariableClick(variable)}
                className="px-2 py-1 bg-surface text-text-secondary text-xs rounded-md hover:bg-bg-tertiary"
              >
                {variable}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block font-semibold text-text-primary mb-2 text-sm">
            Folder Organization
          </label>
          <Switch
            label="Organize into subfolders by date"
            checked={organizeByDate}
            onChange={setOrganizeByDate}
          />
          {organizeByDate && (
            <div className="mt-3">
              <label className="text-xs text-text-secondary block mb-1">Date Format</label>
              <input
                type="text"
                value={dateFolderFormat}
                onChange={(e) => setDateFolderFormat(e.target.value)}
                placeholder="e.g., YYYY/MM-DD"
                className="w-full px-3 py-2 bg-bg-primary border border-border-color rounded-md text-text-primary text-xs focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
              />
            </div>
          )}
        </div>

        <div>
          <label className="block font-semibold text-text-primary mb-2 text-sm">
            Source Files
          </label>
          <Switch
            label="Delete originals after successful import"
            checked={deleteAfterImport}
            onChange={setDeleteAfterImport}
          />
          {deleteAfterImport && (
            <p className="text-xs text-text-secondary mt-1">
              Files will be moved to the system trash.
            </p>
          )}
        </div>
      </div>

      <div className="flex justify-end gap-3 mt-8">
        <Button variant="ghost" onClick={handleClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleImport}>
          Start Import
        </Button>
      </div>
    </Modal>
  );
}
