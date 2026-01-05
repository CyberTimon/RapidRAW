import { useEffect, useRef, useState } from 'react';
import { useBloc } from '@blac/react';
import { Modal } from '../../primitives/Modal';
import { Button } from '../../primitives/Button';
import { ModalBloc } from '../../blocs/app/ModalBloc';

export function AddPresetModal() {
  const [state, modalBloc] = useBloc(ModalBloc);
  const isOpen = state.openModals.includes('add-preset');
  const data = state.modalData['add-preset'];
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen) {
      setValue('');
      setError('');
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    }
  }, [isOpen]);

  if (!isOpen || !data) return null;

  const handleConfirm = () => {
    const trimmedValue = value.trim();
    if (!trimmedValue) {
      setError('Preset name cannot be empty');
      return;
    }
    data.onConfirm(trimmedValue);
    modalBloc.close('add-preset');
    setValue('');
    setError('');
  };

  const handleClose = () => {
    modalBloc.close('add-preset');
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
      title="Save as Preset"
      size="sm"
    >
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          Save the current adjustments as a preset for quick application to other images.
        </p>
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-2">
            Preset name
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
            placeholder="Enter preset name"
          />
          {error && <p className="text-sm text-red-400 mt-2">{error}</p>}
        </div>
      </div>
      <div className="flex justify-end gap-3 mt-6">
        <Button variant="ghost" onClick={handleClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleConfirm}>
          Save Preset
        </Button>
      </div>
    </Modal>
  );
}
