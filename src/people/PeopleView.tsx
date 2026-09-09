import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../store/useUIStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { loadPersonBucket, restoreLibraryAfterPeople } from './navigation';
import { peopleInvoke, usePeopleStore, clearFaceThumbnails } from './store';
import PeopleGrid from './PeopleGrid';
import PeopleReview from './PeopleReview';
import MatchReview from './MatchReview';
import PeopleExport from './PeopleExport';
import { peopleShortcutScope } from './shortcutScope';
import { usePersonShortcuts } from './usePersonShortcuts';
import { ArrowLeft } from 'lucide-react';
export default function PeopleView() {
  const { t } = useTranslation();
  const people = usePeopleStore((s) => s.people);
  const suggestions = usePeopleStore((s) => s.suggestions);
  const canUndo = usePeopleStore((s) => s.canUndo);
  const featuresAvailable = usePeopleStore((s) => s.featuresAvailable);
  const [matches, setMatches] = useState(false);
  const [exporting, setExporting] = useState(false);
  const busy = usePeopleStore((s) => s.progress?.running || s.mutating);
  const [mergeTarget, setMergeTarget] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [review, setReview] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [editingShortcuts, setEditingShortcuts] = useState(false);
  const currentFolderPath = useLibraryStore((state) => state.currentFolderPath);
  const activeAlbumId = useLibraryStore((state) => state.activeAlbumId);
  const shortcutScope = peopleShortcutScope(currentFolderPath, activeAlbumId);
  const shortcuts = usePersonShortcuts(shortcutScope);
  useEffect(() => {
    setSelected((selected) => selected.filter((id) => people.some((p) => p.id === id)));
  }, [people]);
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
      await usePeopleStore
        .getState()
        .mutate({ type: 'merge', ids: selected, target: selected.includes(mergeTarget) ? mergeTarget : selected[0] });
      setSelected([]);
    } catch {
      /* The store exposes the error. */
    }
  };
  const mergeInto = async (target: string, ids: string[]) => {
    const sources = ids.filter((id) => id !== target);
    if (!sources.length || busy) return;
    try {
      await usePeopleStore.getState().mutate({ type: 'merge', ids: [target, ...sources], target });
      setSelected([]);
      await shortcuts.refresh();
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
  const command = async (name: string) => {
    setLoading(true);
    try {
      await peopleInvoke(name);
      await usePeopleStore.getState().refresh();
    } catch (error) {
      usePeopleStore.setState({ error: String(error) });
    } finally {
      setLoading(false);
    }
  };
  if (matches) return <MatchReview onClose={() => setMatches(false)} />;
  if (review) return <PeopleReview id={review === 'ignored' ? null : review} onClose={() => setReview(null)} />;
  return (
    <section className="flex-1 min-h-0 overflow-auto p-3">
      <div className="flex flex-wrap gap-2 mb-3 text-sm">
        <button
          className="p-2 hover:bg-surface rounded-md flex items-center gap-1.5"
          onClick={() => {
            restoreLibraryAfterPeople();
            useUIStore.getState().setUI({ activeView: 'library' });
          }}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          {t('library.header.title')}
        </button>
        {featuresAvailable && (
          <button
            disabled={busy || loading || !people.length}
            className="p-2 hover:bg-surface rounded-md"
            onClick={() => void command('organize')}
          >
            {t('people.organize')}
          </button>
        )}
        {!!suggestions.length && (
          <button className="p-2 hover:bg-surface rounded-md" onClick={() => setMatches(true)}>
            {t('people.reviewMatches', { count: suggestions.length })}
          </button>
        )}
        {canUndo && (
          <button
            disabled={busy || loading}
            className="p-2 hover:bg-surface rounded-md"
            onClick={() => void command('undo')}
          >
            {t('people.undo')}
          </button>
        )}
        {featuresAvailable && !!selected.length && (
          <button disabled={busy} className="p-2 hover:bg-surface rounded-md" onClick={() => setExporting(!exporting)}>
            {t('people.export')}
          </button>
        )}
        {featuresAvailable && !!people.length && (
          <button className="p-2 hover:bg-surface rounded-md" onClick={() => setEditingShortcuts((value) => !value)}>
            {t('people.shortcuts')}
          </button>
        )}
        {selected.length > 1 && (
          <select
            aria-label={t('people.keepPerson')}
            className="bg-surface rounded-md p-2"
            value={selected.includes(mergeTarget) ? mergeTarget : selected[0]}
            onChange={(e) => setMergeTarget(e.target.value)}
          >
            {people
              .filter((p) => selected.includes(p.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || t('people.unnamed')}
                </option>
              ))}
          </select>
        )}
        {selected.length > 1 && (
          <button disabled={busy} className="p-2 hover:bg-surface rounded-md" onClick={() => void merge()}>
            {t('people.merge')}
          </button>
        )}
        <button className="p-2 hover:bg-surface rounded-md" onClick={() => setReview('ignored')}>
          {t('people.ignoredFaces')}
        </button>
        {people.length > 0 && (
          <button disabled={busy} className="p-2 hover:bg-surface rounded-md ml-auto" onClick={() => setClearing(true)}>
            {t('people.clear')}
          </button>
        )}
      </div>
      {people.length > 1 && <p className="mb-2 text-xs text-text-secondary">{t('people.dragToMerge')}</p>}
      {editingShortcuts && <p className="mb-2 text-xs text-text-secondary">{t('people.shortcutHelp')}</p>}
      {exporting && <PeopleExport ids={selected} onClose={() => setExporting(false)} />}
      {!people.length && <p className="p-2 text-sm text-text-secondary">{t('people.empty')}</p>}
      <PeopleGrid
        people={people}
        selected={selected}
        disabled={!!busy || loading}
        onToggle={(id) => setSelected((ids) => (ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id]))}
        onOpen={(id) => void open(id)}
        onReview={setReview}
        onMerge={(target, ids) => void mergeInto(target, ids)}
        shortcutScope={shortcutScope}
        shortcuts={shortcuts.byPerson}
        editingShortcuts={editingShortcuts}
        onShortcutsChanged={shortcuts.refresh}
      />
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
