import { useState, useEffect, useCallback, useRef } from 'react';
import { FILENAME_VARIABLES } from '../ui/ExportImportProperties';

interface RenameFileModalProps {
  filesToRename: Array<string>;
  isOpen: boolean;
  onClose(): void;
  onSave(template: any): void;
}

export default function RenameFileModal({ filesToRename, isOpen, onClose, onSave }: RenameFileModalProps) {
  const [nameTemplate, setNameTemplate] = useState('');
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const fileCount = filesToRename.length;
  const isSingleFile = fileCount === 1;

  useEffect(() => {
    if (isOpen) {
      if (isSingleFile && filesToRename[0]) {
        const fileName = filesToRename[0].split(/[\\/]/).pop();
        const nameWithoutExt = fileName?.substring(0, fileName.lastIndexOf('.'));
        if (nameWithoutExt) {
          setNameTemplate(nameWithoutExt);
        }
      } else {
        setNameTemplate('{original_filename}');
      }
      setIsMounted(true);
      const timer = setTimeout(() => setShow(true), 10);
      return () => clearTimeout(timer);
    } else {
      setShow(false);
      const timer = setTimeout(() => {
        setIsMounted(false);
        setNameTemplate('');
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen, filesToRename, isSingleFile]);

  const handleSave = useCallback(() => {
    if (nameTemplate.trim()) {
      let finalTemplate = nameTemplate.trim();
      if (!isSingleFile && !finalTemplate.includes('{sequence}') && !finalTemplate.includes('{original_filename}')) {
        finalTemplate = `${finalTemplate}_{sequence}`;
      }
      onSave(finalTemplate);
    }
    onClose();
  }, [nameTemplate, onSave, onClose, isSingleFile]);

  const handleKeyDown = useCallback(
    (e: any) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSave();
      } else if (e.key === 'Escape') {
        onClose();
      }
    },
    [handleSave, onClose],
  );

  const handleVariableClick = (variable: string) => {
    if (!nameInputRef.current) {
      return;
    }
    const input = nameInputRef.current;
    const start = input?.selectionStart || 0;
    const end = input?.selectionEnd || 0;
    const currentValue = input.value;
    const newValue = currentValue.substring(0, start) + variable + currentValue.substring(end);
    setNameTemplate(newValue);
    setTimeout(() => {
      input.focus();
      const newCursorPos = start + variable.length;
      input.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  };

  if (!isMounted) {
    return null;
  }

  return (
    <div
      aria-modal="true"
      className={`fixed inset-0 flex items-center justify-center z-50 bg-black/30 backdrop-blur-sm transition-opacity duration-300 ease-in-out ${
        show ? 'opacity-100' : 'opacity-0'
      }`}
      onClick={onClose}
      role="dialog"
    >
      <div
        className={`bg-surface rounded-lg shadow-xl p-6 w-full max-w-lg transform transition-all duration-300 ease-out ${
          show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4'
        }`}
        onClick={(e: any) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <h3 className="text-lg font-semibold text-text-primary mb-6">
          {isSingleFile ? 'Rename Image' : `Rename ${fileCount} Images`}
        </h3>

        <div className="space-y-6 text-sm">
          <div>
            <label className="font-semibold text-text-primary block mb-2">
              {isSingleFile ? 'New Name' : 'File Naming Template'}
            </label>
            <input
              autoFocus
              className="w-full bg-bg-primary border border-surface rounded-md p-2 text-sm text-text-primary focus:ring-accent focus:border-accent"
              onChange={(e: any) => setNameTemplate(e.target.value)}
              ref={nameInputRef}
              type="text"
              value={nameTemplate}
            />
            {!isSingleFile && (
              <div className="flex flex-wrap gap-2 mt-2">
                {FILENAME_VARIABLES.map((variable: string) => (
                  <button
                    className="px-2 py-1 bg-surface text-text-secondary text-xs rounded-md hover:bg-card-active transition-colors"
                    key={variable}
                    onClick={() => handleVariableClick(variable)}
                  >
                    {variable}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-8">
          <button
            className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="px-4 py-2 rounded-md bg-accent shadow-shiny text-button-text font-semibold hover:bg-accent-hover disabled:bg-gray-500 disabled:text-white disabled:cursor-not-allowed transition-colors"
            disabled={!nameTemplate.trim()}
            onClick={handleSave}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
