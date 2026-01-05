import { useEffect, useRef, useState } from 'react';
import { useBloc } from '@blac/react';
import { Modal } from '../../primitives/Modal';
import { Button } from '../../primitives/Button';
import { ModalBloc } from '../../blocs/app/ModalBloc';

export function RenameFolderModal() {
  const [state, modalBloc] = useBloc(ModalBloc);
  const isOpen = state.openModals.includes('rename-folder');
  const data = state.modalData['rename-folder'];
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen && data?.currentName) {
      setValue(data.currentName);
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 50);
    }
  }, [isOpen, data?.currentName]);

  if (!isOpen || !data) return null;

  const handleConfirm = () => {
    const trimmedValue = value.trim();
    if (!trimmedValue) {
      setError('Folder name cannot be empty');
      return;
    }
    if (trimmedValue.includes('/') || trimmedValue.includes('\\')) {
      setError('Folder name cannot contain slashes');
      return;
    }
    if (trimmedValue.startsWith('.')) {
      setError('Folder name cannot start with a dot');
      return;
    }
    data.onRename(trimmedValue);
    modalBloc.close('rename-folder');
    setValue('');
    setError('');
  };

  const handleClose = () => {
    modalBloc.close('rename-folder');
    setValue('');
    setError('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleConfirm();
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Rename Folder"
      size="sm"
    >
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-2">
            New name
          </label>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError('');
            }}
            onKeyDown={handleKeyDown}
            className="w-full px-3 py-2 bg-bg-primary border border-border-color rounded-md text-text-primary placeholder-text-secondary focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
            placeholder="Enter folder name"
          />
          {error && <p className="text-sm text-red-400 mt-2">{error}</p>}
        </div>
      </div>
      <div className="flex justify-end gap-3 mt-6">
        <Button variant="ghost" onClick={handleClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleConfirm}>
          Rename
        </Button>
      </div>
    </Modal>
  );
}
