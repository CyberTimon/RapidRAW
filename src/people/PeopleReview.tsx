import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { peopleInvoke, usePeopleStore } from './store';
import type { FaceRecord, PeopleMutation } from './types';
import FaceThumbnail from './FaceThumbnail';
export default function PeopleReview({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const people = usePeopleStore((s) => s.people);
  const revision = usePeopleStore((s) => s.revision);
  const running = usePeopleStore((s) => s.progress?.running);
  const [faces, setFaces] = useState<FaceRecord[]>([]);
  const [name, setName] = useState(people.find((p) => p.id === id)?.name || '');
  const [selected, setSelected] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void peopleInvoke<FaceRecord[]>('faces', { id })
      .then((rows) => {
        if (alive) setFaces(rows);
      })
      .catch((e) => usePeopleStore.setState({ error: String(e) }));
    return () => {
      alive = false;
    };
  }, [id, revision]);
  const mutate = async (mutation: PeopleMutation) => {
    setBusy(true);
    try {
      await usePeopleStore.getState().mutate(mutation);
      setSelected([]);
    } catch {
      /* The toolbar displays the store error. */
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="p-3 overflow-auto flex-1 min-h-0">
      <button className="p-2 mb-2 hover:bg-surface rounded-md" onClick={onClose}>
        {t('people.back')}
      </button>
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
      </form>
      <fieldset disabled={busy || running} className="flex flex-wrap gap-2 mb-3 text-sm disabled:opacity-50">
        <select
          className="bg-surface rounded-md p-2"
          aria-label={t('people.move')}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          <option value="">{t('people.newPerson')}</option>
          {people
            .filter((p) => p.id !== id)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || t('people.unnamed')}
              </option>
            ))}
        </select>
        <button
          disabled={!selected.length}
          className="p-2"
          onClick={() => void mutate({ type: 'move', faces: selected, target: target || null })}
        >
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
          disabled={selected.length !== 1}
          className="p-2"
          onClick={() => void mutate({ type: 'representative', id, face: selected[0] })}
        >
          {t('people.cover')}
        </button>
      </fieldset>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-3">
        {faces.map((face) => (
          <label key={face.id} className={`max-w-40 ${face.ignored ? 'opacity-40' : ''}`}>
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
