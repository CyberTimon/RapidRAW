import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLibraryStore } from '../store/useLibraryStore';
import { peopleInvoke, usePeopleStore, faceThumbnail } from './store';
import type { FaceRecord, PeopleMutation } from './types';
import FaceThumbnail from './FaceThumbnail';
import PersonPicker from './PersonPicker';
import PeopleExport from './PeopleExport';
import { FACE_DRAG, writeDraggedIds } from './drag';
import { peopleShortcutScope, usablePeopleShortcut } from './shortcutScope';
import { usePersonShortcuts } from './usePersonShortcuts';
import PersonShortcutButton from './PersonShortcutButton';
export default function PeopleReview({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const people = usePeopleStore((s) => s.people);
  const revision = usePeopleStore((s) => s.revision);
  const running = usePeopleStore((s) => s.progress?.running || s.mutating);
  const featuresAvailable = usePeopleStore((s) => s.featuresAvailable);
  const [faces, setFaces] = useState<FaceRecord[]>([]);
  const [name, setName] = useState(people.find((p) => p.id === id)?.name || '');
  const [selected, setSelected] = useState<string[]>([]);
  const [moving, setMoving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const currentFolderPath = useLibraryStore((state) => state.currentFolderPath);
  const activeAlbumId = useLibraryStore((state) => state.activeAlbumId);
  const shortcutScope = peopleShortcutScope(currentFolderPath, activeAlbumId);
  const shortcuts = usePersonShortcuts(shortcutScope);
  useEffect(() => {
    let alive = true;
    void peopleInvoke<FaceRecord[]>('faces', { id })
      .then((rows) => {
        if (alive) {
          setFaces(rows);
          setSelected((selected) => selected.filter((id) => rows.some((face) => face.id === id)));
          rows.slice(0, 8).forEach((face) => {
            void faceThumbnail(face.id).catch(() => {});
          });
        }
      })
      .catch((e) => usePeopleStore.setState({ error: String(e) }));
    return () => {
      alive = false;
    };
  }, [id, revision]);
  const mutate = useCallback(async (mutation: PeopleMutation) => {
    setBusy(true);
    try {
      await usePeopleStore.getState().mutate(mutation);
      setSelected([]);
      setMoving(false);
    } catch {
      /* The toolbar displays the store error. */
    } finally {
      setBusy(false);
    }
  }, []);
  const moveFaces = useCallback(
    (target: string | null, chosen = selected) => {
      if (chosen.length && !busy && !running && target !== id) {
        void mutate({ type: 'move', faces: chosen, target });
      }
    },
    [busy, id, mutate, running, selected],
  );
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const key = usablePeopleShortcut(event);
      if (!key) return;
      const target = shortcuts.byKey.get(key);
      if (target && selected.length && target !== id && !busy && !running) {
        event.preventDefault();
        moveFaces(target);
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [busy, id, moveFaces, running, selected.length, shortcuts.byKey]);
  return (
    <section className="p-3 overflow-auto flex-1 min-h-0">
      <button className="p-2 mb-2 hover:bg-surface rounded-md" onClick={onClose}>
        {t('people.back')}
      </button>
      {id && featuresAvailable && (
        <form
          className="flex items-center gap-2 mb-3"
          onSubmit={(e) => {
            e.preventDefault();
            void mutate({ type: 'rename', id, name });
          }}
        >
          <input
            className="bg-surface rounded-md p-2 text-sm"
            value={name}
            maxLength={120}
            aria-label={t('people.name')}
            placeholder={t('people.name')}
            onChange={(e) => setName(e.target.value)}
          />
          <button disabled={busy || running} className="p-2 text-sm">
            {t('people.save')}
          </button>
          <span className="ml-auto text-xs text-text-secondary">{t('people.shortcut')}</span>
          <PersonShortcutButton
            scope={shortcutScope}
            personId={id}
            shortcut={shortcuts.byPerson.get(id) || null}
            showUnassigned
            onChanged={shortcuts.refresh}
          />
        </form>
      )}
      <fieldset disabled={busy || running} className="flex flex-wrap gap-2 mb-3 text-sm disabled:opacity-50">
        <button disabled={!selected.length} className="p-2" onClick={() => setMoving(!moving)}>
          {t('people.move')}
        </button>
        <button
          disabled={!selected.length}
          className="p-2"
          onClick={() => void mutate({ type: 'ignore', faces: selected, ignored: true })}
        >
          {t('people.ignore')}
        </button>
        <button
          disabled={!selected.length}
          className="p-2"
          onClick={() => void mutate({ type: 'ignore', faces: selected, ignored: false })}
        >
          {t('people.restore')}
        </button>
        <button
          disabled={!id || selected.length !== 1}
          className="p-2"
          onClick={() => {
            if (id) void mutate({ type: 'representative', id, face: selected[0] });
          }}
        >
          {t('people.cover')}
        </button>
      </fieldset>
      {moving && (
        <PersonPicker
          exclude={id || ''}
          onClose={() => setMoving(false)}
          shortcuts={shortcuts.shortcuts}
          onChoose={(target) => {
            moveFaces(target);
          }}
          onDrop={moveFaces}
        />
      )}
      {id && featuresAvailable && (
        <button
          disabled={busy || running}
          className="p-2 text-sm mb-2 hover:bg-surface rounded-md"
          onClick={() => setExporting(!exporting)}
        >
          {t('people.export')}
        </button>
      )}
      {id && featuresAvailable && exporting && <PeopleExport ids={[id]} onClose={() => setExporting(false)} />}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-3">
        {faces.map((face) => (
          <label
            key={face.id}
            draggable={!busy && !running && !face.ignored}
            className={`max-w-40 cursor-grab active:cursor-grabbing ${face.ignored ? 'opacity-40' : ''}`}
            onDragStart={(event) => {
              const chosen = selected.includes(face.id) ? selected : [face.id];
              setSelected(chosen);
              setMoving(true);
              writeDraggedIds(event, FACE_DRAG, chosen);
            }}
          >
            <FaceThumbnail id={face.id} />
            <div className="flex items-center gap-1 mt-1 text-xs">
              <input
                type="checkbox"
                aria-label={t('people.select')}
                checked={selected.includes(face.id)}
                onChange={(e) =>
                  setSelected(e.target.checked ? [...selected, face.id] : selected.filter((v) => v !== face.id))
                }
              />
              <span className="truncate">{face.path.split(/[\\/]/).pop()}</span>
            </div>
          </label>
        ))}
      </div>
    </section>
  );
}
