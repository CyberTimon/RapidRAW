import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../store/useUIStore';
import { loadPersonBucket } from './navigation';
import { peopleInvoke, usePeopleStore, clearFaceThumbnails } from './store';
import FaceThumbnail from './FaceThumbnail';
import PeopleReview from './PeopleReview';
export default function PeopleView() {
  const { t } = useTranslation();
  const people = usePeopleStore((s) => s.people);
  const busy = usePeopleStore((s) => s.progress?.running);
  const [selected, setSelected] = useState<string[]>([]);
  const [review, setReview] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [loading, setLoading] = useState(false);
  const open = async (id: string) => {
    setLoading(true);
    try {
      await loadPersonBucket(id);
      useUIStore.getState().setUI({ activeView: 'library' });
    } catch (e) {
      usePeopleStore.setState({ error: String(e) });
    } finally {
      setLoading(false);
    }
  };
  const merge = async () => {
    try {
      await usePeopleStore.getState().mutate({ type: 'merge', ids: selected, target: selected[0] });
      setSelected([]);
    } catch {
      /* The store exposes the error. */
    }
  };
  const clear = async () => {
    try {
      await peopleInvoke('clear');
      clearFaceThumbnails();
      usePeopleStore.setState({ activePersonId: null });
      await usePeopleStore.getState().refresh();
      setSelected([]);
      setClearing(false);
    } catch (e) {
      usePeopleStore.setState({ error: String(e) });
    }
  };
  if (review) return <PeopleReview id={review} onClose={() => setReview(null)} />;
  return (
    <section className="flex-1 min-h-0 overflow-auto p-3">
      <div className="flex gap-2 mb-3 text-sm">
        <button
          className="p-2 hover:bg-surface rounded-md"
          onClick={() => useUIStore.getState().setUI({ activeView: 'library' })}
        >
          {t('people.back')}
        </button>
        {selected.length > 1 && (
          <button disabled={busy} className="p-2 hover:bg-surface rounded-md" onClick={() => void merge()}>
            {t('people.merge')}
          </button>
        )}
        {people.length > 0 && (
          <button disabled={busy} className="p-2 hover:bg-surface rounded-md ml-auto" onClick={() => setClearing(true)}>
            {t('people.clear')}
          </button>
        )}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-3">
        {people.map((person) => (
          <div key={person.id} className="min-w-0 max-w-44">
            <button
              className="w-full"
              disabled={loading}
              onClick={() => void open(person.id)}
              aria-label={person.name || t('people.unnamed')}
            >
              <FaceThumbnail id={person.representativeFace} />
            </button>
            <div className="flex items-center gap-1 mt-1">
              <input
                type="checkbox"
                aria-label={t('people.select')}
                checked={selected.includes(person.id)}
                onChange={(e) =>
                  setSelected(e.target.checked ? [...selected, person.id] : selected.filter((id) => id !== person.id))
                }
              />
              <button className="text-sm truncate text-left flex-1" onClick={() => setReview(person.id)}>
                {person.name || t('people.unnamed')}
              </button>
              <span className="text-xs text-text-secondary">{person.photoCount}</span>
            </div>
          </div>
        ))}
      </div>
      {clearing && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="people-clear-title"
            className="bg-bg-secondary p-5 rounded-lg max-w-sm"
          >
            <p id="people-clear-title" className="mb-4">
              {t('people.clearConfirm')}
            </p>
            <button autoFocus className="p-2 hover:bg-surface" onClick={() => setClearing(false)}>
              {t('people.cancel')}
            </button>
            <button className="p-2 text-red-600 dark:text-red-400" onClick={() => void clear()}>
              {t('people.clear')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
