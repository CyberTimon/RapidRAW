import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePeopleStore } from './store';
import FaceThumbnail from './FaceThumbnail';

export default function MatchReview({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const people = usePeopleStore((s) => s.people);
  const suggestions = usePeopleStore((s) => s.suggestions);
  const running = usePeopleStore((s) => s.progress?.running || s.mutating);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const decide = async (a: string, b: string, same: boolean) => {
    setBusy(true);
    try {
      await usePeopleStore.getState().mutate(
        same
          ? {
              type: 'merge',
              ids: [a, b],
              target: targets[`${a}:${b}`] || (people.find((p) => p.id === b)?.name ? b : a),
            }
          : { type: 'reject', a, b },
      );
    } catch {
      /* Store exposes the error. */
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="p-3 flex-1 overflow-auto">
      <button className="p-2 mb-2" onClick={onClose}>
        {t('people.back')}
      </button>
      {!suggestions.length && <p className="text-sm text-text-secondary p-2">{t('people.noMatches')}</p>}
      {suggestions.map(({ a, b }) => {
        const left = people.find((p) => p.id === a),
          right = people.find((p) => p.id === b);
        if (!left || !right) return null;
        return (
          <div key={`${a}:${b}`} className="flex flex-wrap items-center gap-3 py-3">
            {[left, right].map((p) => (
              <div key={p.id} className="w-24">
                <FaceThumbnail id={p.representativeFace} />
                <p className="text-sm truncate mt-1">{p.name || t('people.unnamed')}</p>
              </div>
            ))}
            {left.name && right.name && (
              <select
                className="bg-surface rounded-md p-2 text-sm"
                aria-label={t('people.keepPerson')}
                value={targets[`${a}:${b}`] || b}
                onChange={(e) => setTargets({ ...targets, [`${a}:${b}`]: e.target.value })}
              >
                {[left, right].map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            <button
              disabled={busy || running}
              className="p-2 text-sm hover:bg-surface rounded-md"
              onClick={() => void decide(a, b, true)}
            >
              {t('people.samePerson')}
            </button>
            <button
              disabled={busy || running}
              className="p-2 text-sm hover:bg-surface rounded-md"
              onClick={() => void decide(a, b, false)}
            >
              {t('people.differentPeople')}
            </button>
          </div>
        );
      })}
    </section>
  );
}
