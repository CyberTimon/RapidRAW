import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePeopleStore } from './store';
import FaceThumbnail from './FaceThumbnail';
import type { PersonShortcut } from './types';
import { FACE_DRAG, readDraggedIds } from './drag';

export default function PersonPicker({
  exclude,
  onChoose,
  onClose,
  shortcuts,
  onDrop,
}: {
  exclude: string;
  onChoose: (id: string | null) => void;
  onClose: () => void;
  shortcuts: PersonShortcut[];
  onDrop: (id: string | null, faces: string[]) => void;
}) {
  const { t } = useTranslation();
  const people = usePeopleStore((s) => s.people);
  const [query, setQuery] = useState('');
  const shortcutByPerson = useMemo(() => new Map(shortcuts.map((item) => [item.personId, item.shortcut])), [shortcuts]);
  const matches = useMemo(
    () =>
      people.filter(
        (p) =>
          p.id !== exclude && (p.name || t('people.unnamed')).toLocaleLowerCase().includes(query.toLocaleLowerCase()),
      ),
    [people, exclude, query, t],
  );
  return (
    <div className="bg-bg-secondary rounded-md p-2 max-w-md" role="region" aria-label={t('people.move')}>
      <div className="flex gap-2">
        <input
          autoFocus
          className="bg-surface rounded-md p-2 text-sm flex-1 min-w-0"
          aria-label={t('people.search')}
          placeholder={t('people.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="p-2 text-sm" onClick={onClose}>
          {t('people.cancel')}
        </button>
      </div>
      <button
        className="p-2 text-sm"
        onClick={() => onChoose(null)}
        onDragOver={(event) => event.dataTransfer.types.includes(FACE_DRAG) && event.preventDefault()}
        onDrop={(event) => onDrop(null, readDraggedIds(event, FACE_DRAG))}
      >
        {t('people.newPerson')}
      </button>
      <div className="max-h-64 overflow-auto">
        {matches.map((p) => (
          <div
            key={p.id}
            className="flex items-center gap-2 p-2 w-full text-left hover:bg-surface rounded-md"
            onDragOver={(event) => event.dataTransfer.types.includes(FACE_DRAG) && event.preventDefault()}
            onDrop={(event) => onDrop(p.id, readDraggedIds(event, FACE_DRAG))}
          >
            <span className="w-10 shrink-0">
              <FaceThumbnail id={p.representativeFace} />
            </span>
            <button className="text-sm truncate flex-1 text-left p-2" onClick={() => onChoose(p.id)}>
              {p.name || t('people.unnamed')}
            </button>
            <span className="text-xs text-text-secondary ml-auto">{p.photoCount}</span>
            {shortcutByPerson.get(p.id) && (
              <kbd className="min-w-6 text-center text-xs rounded bg-surface px-1 py-0.5">
                {shortcutByPerson.get(p.id)?.toLocaleUpperCase()}
              </kbd>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
