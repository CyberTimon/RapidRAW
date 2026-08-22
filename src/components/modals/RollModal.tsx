import { useEffect, useState } from 'react';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';
import { Roll } from '../ui/AppProperties';

interface RollModalProps {
  isOpen: boolean;
  roll: Roll | null;
  onClose(): void;
  onSave(details: Omit<Roll, 'id' | 'images'>): void;
}

export default function RollModal({ isOpen, roll, onClose, onSave }: RollModalProps) {
  const [camera, setCamera] = useState('');
  const [filmStock, setFilmStock] = useState('');
  const [loadedOn, setLoadedOn] = useState('');
  const [finishedOn, setFinishedOn] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setCamera(roll?.camera ?? '');
    setFilmStock(roll?.filmStock ?? '');
    setLoadedOn(roll?.loadedOn ?? new Date().toISOString().slice(0, 10));
    setFinishedOn(roll?.finishedOn ?? '');
  }, [isOpen, roll]);

  if (!isOpen) return null;

  const save = () => {
    if (!camera.trim() || !filmStock.trim() || !loadedOn) return;
    onSave({
      camera: camera.trim(),
      filmStock: filmStock.trim(),
      loadedOn,
      finishedOn: finishedOn || undefined,
    });
    onClose();
  };

  const inputClass =
    'w-full bg-bg-primary text-text-primary border border-border rounded-md px-3 py-2 focus:outline-hidden focus:ring-2 focus:ring-accent';

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50 bg-black/30 backdrop-blur-xs"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div className="bg-surface rounded-lg shadow-xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <Text variant={TextVariants.title} className="mb-4">
          {roll ? 'Edit roll' : 'New roll'}
        </Text>
        <div className="grid gap-4">
          <label className="text-sm text-text-secondary">
            Camera
            <input
              autoFocus
              className={`${inputClass} mt-1`}
              value={camera}
              onChange={(e) => setCamera(e.target.value)}
              placeholder="e.g. Nikon F3"
            />
          </label>
          <label className="text-sm text-text-secondary">
            Film stock
            <input
              className={`${inputClass} mt-1`}
              value={filmStock}
              onChange={(e) => setFilmStock(e.target.value)}
              placeholder="e.g. Kodak Portra 400"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm text-text-secondary">
              Loaded on
              <input
                className={`${inputClass} mt-1`}
                type="date"
                value={loadedOn}
                onChange={(e) => setLoadedOn(e.target.value)}
              />
            </label>
            <label className="text-sm text-text-secondary">
              Finished on
              <input
                className={`${inputClass} mt-1`}
                type="date"
                min={loadedOn}
                value={finishedOn}
                onChange={(e) => setFinishedOn(e.target.value)}
              />
            </label>
          </div>
        </div>
        <div className="flex justify-end gap-3 mt-5">
          <button className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface" onClick={onClose}>
            Cancel
          </button>
          <button
            className="px-4 py-2 rounded-md bg-accent text-button-text font-semibold hover:bg-accent-hover disabled:bg-gray-500 disabled:text-white"
            disabled={!camera.trim() || !filmStock.trim() || !loadedOn || (!!finishedOn && finishedOn < loadedOn)}
            onClick={save}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
