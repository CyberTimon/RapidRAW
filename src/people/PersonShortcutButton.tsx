import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { peopleInvoke, usePeopleStore } from './store';

export default function PersonShortcutButton({
  scope,
  personId,
  shortcut,
  showUnassigned,
  onChanged,
}: {
  scope: string;
  personId: string;
  shortcut: string | null;
  showUnassigned: boolean;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);
  const save = async (value: string | null) => {
    setBusy(true);
    try {
      await peopleInvoke('set_shortcut', { scope, personId, shortcut: value });
      await onChanged();
      setEditing(false);
    } catch (error) {
      usePeopleStore.setState({ error: String(error) });
    } finally {
      setBusy(false);
    }
  };
  if (editing) {
    return (
      <input
        ref={input}
        className="w-8 h-8 rounded-md bg-surface text-center text-sm"
        aria-label={t('people.pressShortcut')}
        maxLength={1}
        onBlur={() => setEditing(false)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') setEditing(false);
          else if (event.key === 'Backspace' || event.key === 'Delete') void save(null);
          else if (/^[a-z0-9]$/i.test(event.key)) void save(event.key.toLocaleLowerCase());
        }}
      />
    );
  }
  if (!shortcut && !showUnassigned) return null;
  return (
    <button
      disabled={busy}
      className="min-w-8 h-8 px-2 rounded-md bg-surface text-xs"
      title={t('people.assignShortcut')}
      aria-label={t('people.assignShortcut')}
      onClick={() => setEditing(true)}
    >
      {shortcut?.toLocaleUpperCase() || '+'}
    </button>
  );
}
