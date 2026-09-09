import { useCallback, useEffect, useMemo, useState } from 'react';
import { peopleInvoke, usePeopleStore } from './store';
import type { PersonShortcut } from './types';

export function usePersonShortcuts(scope: string) {
  const featuresAvailable = usePeopleStore((state) => state.featuresAvailable);
  const [shortcuts, setShortcuts] = useState<PersonShortcut[]>([]);
  const refresh = useCallback(async () => {
    if (!featuresAvailable) {
      setShortcuts([]);
      return;
    }
    try {
      setShortcuts(await peopleInvoke<PersonShortcut[]>('shortcuts', { scope }));
    } catch (error) {
      usePeopleStore.setState({ error: String(error) });
    }
  }, [featuresAvailable, scope]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const byPerson = useMemo(() => new Map(shortcuts.map((item) => [item.personId, item.shortcut])), [shortcuts]);
  const byKey = useMemo(() => new Map(shortcuts.map((item) => [item.shortcut, item.personId])), [shortcuts]);
  return { shortcuts, byPerson, byKey, refresh };
}
