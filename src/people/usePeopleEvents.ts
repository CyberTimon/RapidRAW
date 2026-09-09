import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { peopleInvoke, usePeopleStore, clearFaceThumbnails } from './store';
import type { PeopleScanProgress } from './types';

// Subscribe once for the entire library surface, including People and its review view.
export function usePeopleEvents() {
  useEffect(() => {
    let alive = true;
    let refreshing = false;
    let pending = false;
    const refresh = async () => {
      if (!alive) return;
      if (refreshing) {
        pending = true;
        return;
      }
      refreshing = true;
      do {
        pending = false;
        await usePeopleStore.getState().refresh();
      } while (alive && pending);
      refreshing = false;
    };
    const applyProgress = (progress: PeopleScanProgress) => {
      if (!alive) return;
      if (!progress.running && usePeopleStore.getState().progress?.running) {
        clearFaceThumbnails();
        usePeopleStore.setState({ thumbnailVersion: usePeopleStore.getState().thumbnailVersion + 1 });
      }
      usePeopleStore.setState({ progress, error: progress.error });
    };
    const reconcile = () => {
      void peopleInvoke<PeopleScanProgress>('status')
        .then(applyProgress)
        .catch((error) => {
          if (alive) usePeopleStore.setState({ error: String(error) });
        });
      void refresh();
    };
    const listeners = [
      'people-scan-progress',
      'people-scan-complete',
      'people-scan-failed',
      'people-scan-cancelled',
    ].map((event) => listen<PeopleScanProgress>(event, ({ payload }) => applyProgress(payload)));
    listeners.push(
      listen('people-index-updated', () => {
        void refresh();
      }),
    );
    window.addEventListener('focus', reconcile);
    document.addEventListener('visibilitychange', reconcile);
    void Promise.all(listeners)
      .then(reconcile)
      .catch((error) => {
        if (alive) usePeopleStore.setState({ error: String(error) });
      });
    return () => {
      alive = false;
      window.removeEventListener('focus', reconcile);
      document.removeEventListener('visibilitychange', reconcile);
      listeners.forEach((listener) => {
        void listener.then((unlisten) => unlisten()).catch(() => {});
      });
    };
  }, []);
}
