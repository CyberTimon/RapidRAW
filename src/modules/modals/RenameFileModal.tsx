import { useEffect, useRef, useState } from 'react';
import { useBloc } from '@blac/react';
import { Modal } from '../../primitives/Modal';
import { Button } from '../../primitives/Button';
import { ModalBloc } from '../../blocs/app/ModalBloc';

export function RenameFileModal() {
  const [state, modalBloc] = useBloc(ModalBloc);
  const isOpen = state.openModals.includes('rename-file');
  const data = state.modalData['rename-file'];
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen && data?.currentName) {
      const nameWithoutExt = data.currentName.replace(/\.[^/.]+$/, '');
      setValue(nameWithoutExt);
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 50);
    }
  }, [isOpen, data?.currentName]);

  if (!isOpen || !data) return null;

  const extension = data.currentName.match(/\.[^/.]+$/)?.[0] || '';

  const handleConfirm = () => {
    const trimmedValue = value.trim();
    if (!trimmedValue) {
      setError('Name cannot be empty');
      return;
    }
    if (trimmedValue.includes('/') || trimmedValue.includes('\\')) {
      setError('Name cannot contain slashes');
      return;
    }
    const newName = trimmedValue + extension;
    data.onRename(newName);
    modalBloc.close('rename-file');
    setValue('');
    setError('');
  };

  const handleClose = () => {
    modalBloc.close('rename-file');
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
      title="Rename File"
      size="sm"
    >
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-2">
            New filename
          </label>
          <div className="flex items-center">
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError('');
              }}
              onKeyDown={handleKeyDown}
              className="flex-1 px-3 py-2 bg-bg-primary border border-border-color rounded-l-md text-text-primary placeholder-text-secondary focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
              placeholder="Enter filename"
            />
            <span className="px-3 py-2 bg-surface border border-l-0 border-border-color rounded-r-md text-text-secondary text-sm">
              {extension}
            </span>
          </div>
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
