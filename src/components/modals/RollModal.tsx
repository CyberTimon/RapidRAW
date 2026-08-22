import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';
import type { Roll } from '../ui/AppProperties';
import { getLocalDateString, type RollDetails } from '../../utils/collections';

interface RollModalProps {
  isOpen: boolean;
  roll: Roll | null;
  onClose(): void;
  onSave(details: RollDetails): void;
}

export default function RollModal({ isOpen, roll, onClose, onSave }: RollModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [camera, setCamera] = useState('');
  const [filmStock, setFilmStock] = useState('');
  const [loadedOn, setLoadedOn] = useState('');
  const [finishedOn, setFinishedOn] = useState('');
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setName(roll?.name ?? '');
      setCamera(roll?.camera ?? '');
      setFilmStock(roll?.filmStock ?? '');
      setLoadedOn(roll?.loadedOn ?? getLocalDateString());
      setFinishedOn(roll?.finishedOn ?? '');
      setIsMounted(true);
      const timer = setTimeout(() => setShow(true), 10);
      return () => clearTimeout(timer);
    }

    setShow(false);
    const timer = setTimeout(() => setIsMounted(false), 300);
    return () => clearTimeout(timer);
  }, [isOpen, roll]);

  const isValid = !!camera.trim() && !!filmStock.trim() && !!loadedOn && (!finishedOn || finishedOn >= loadedOn);

  const handleSave = useCallback(() => {
    if (!isValid) return;
    onSave({
      name: name.trim() || undefined,
      camera: camera.trim(),
      filmStock: filmStock.trim(),
      loadedOn,
      finishedOn: finishedOn || undefined,
    });
    onClose();
  }, [camera, filmStock, finishedOn, isValid, loadedOn, name, onClose, onSave]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        handleSave();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    },
    [handleSave, onClose],
  );

  if (!isMounted) return null;

  const inputClass =
    'w-full bg-bg-primary text-text-primary border border-border rounded-md px-3 py-2 focus:outline-hidden focus:ring-2 focus:ring-accent';

  return (
    <div
      aria-modal="true"
      className={`fixed inset-0 flex items-center justify-center z-50 bg-black/30 backdrop-blur-xs transition-opacity duration-300 ease-in-out ${show ? 'opacity-100' : 'opacity-0'}`}
      onClick={onClose}
      role="dialog"
    >
      <div
        className={`bg-surface rounded-lg shadow-xl p-6 w-full max-w-md transform transition-all duration-300 ease-out ${show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4'}`}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <Text variant={TextVariants.title} className="mb-4">
          {t(roll ? 'modals.roll.editTitle' : 'modals.roll.newTitle')}
        </Text>
        <div className="grid gap-4">
          <label className="text-sm text-text-secondary" htmlFor="roll-name">
            {t('modals.roll.name')}
            <input
              autoFocus
              className={`${inputClass} mt-1`}
              id="roll-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('modals.roll.namePlaceholder')}
            />
          </label>
          <label className="text-sm text-text-secondary" htmlFor="roll-camera">
            {t('modals.roll.camera')}
            <input
              className={`${inputClass} mt-1`}
              id="roll-camera"
              value={camera}
              onChange={(event) => setCamera(event.target.value)}
              placeholder={t('modals.roll.cameraPlaceholder')}
            />
          </label>
          <label className="text-sm text-text-secondary" htmlFor="roll-film-stock">
            {t('modals.roll.filmStock')}
            <input
              className={`${inputClass} mt-1`}
              id="roll-film-stock"
              value={filmStock}
              onChange={(event) => setFilmStock(event.target.value)}
              placeholder={t('modals.roll.filmStockPlaceholder')}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm text-text-secondary" htmlFor="roll-loaded-on">
              {t('modals.roll.loadedOn')}
              <input
                className={`${inputClass} mt-1`}
                id="roll-loaded-on"
                type="date"
                value={loadedOn}
                onChange={(event) => setLoadedOn(event.target.value)}
              />
            </label>
            <label className="text-sm text-text-secondary" htmlFor="roll-finished-on">
              {t('modals.roll.finishedOn')}
              <input
                className={`${inputClass} mt-1`}
                id="roll-finished-on"
                type="date"
                min={loadedOn}
                value={finishedOn}
                onChange={(event) => setFinishedOn(event.target.value)}
              />
            </label>
          </div>
        </div>
        <div className="flex justify-end gap-3 mt-5">
          <button
            className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors"
            onClick={onClose}
          >
            {t('modals.createFolder.cancel')}
          </button>
          <button
            className="px-4 py-2 rounded-md bg-accent text-button-text font-semibold hover:bg-accent-hover disabled:bg-gray-500 disabled:text-white disabled:cursor-not-allowed transition-colors"
            disabled={!isValid}
            onClick={handleSave}
          >
            {t('modals.renameFolder.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
