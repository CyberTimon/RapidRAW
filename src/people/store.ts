import { create } from 'zustand';
import { createThumbnailCache } from './thumbnailCache';
import { invoke } from '@tauri-apps/api/core';
import type { PeopleMutation, PeopleScanProgress, PersonSummary, MatchSuggestion } from './types';
let refreshSequence = 0;
interface PeopleStore {
  people: PersonSummary[];
  suggestions: MatchSuggestion[];
  canUndo: boolean;
  featuresAvailable: boolean;
  mutating: boolean;
  activePersonId: string | null;
  progress: PeopleScanProgress | null;
  error: string | null;
  revision: number;
  thumbnailVersion: number;
  refresh: () => Promise<void>;
  mutate: (mutation: PeopleMutation) => Promise<void>;
}
export const peopleInvoke = <T>(command: string, args?: Record<string, unknown>) =>
  invoke<T>(`plugin:people|${command}`, args);
export const usePeopleStore = create<PeopleStore>((set, get) => ({
  people: [],
  suggestions: [],
  canUndo: false,
  featuresAvailable: false,
  mutating: false,
  activePersonId: null,
  progress: null,
  error: null,
  revision: 0,
  thumbnailVersion: 0,
  refresh: async () => {
    const sequence = ++refreshSequence;
    try {
      const people = await peopleInvoke<PersonSummary[]>('list');
      let suggestions: MatchSuggestion[] = [];
      let canUndo = false;
      let featuresAvailable = true;
      try {
        [suggestions, canUndo] = await Promise.all([
          peopleInvoke<MatchSuggestion[]>('suggestions'),
          peopleInvoke<boolean>('can_undo'),
        ]);
      } catch {
        // Vite can hot-reload this frontend before the native development app
        // restarts with the matching People command registry. Keep the existing
        // albums usable until that restart completes.
        featuresAvailable = false;
      }
      if (sequence !== refreshSequence) return;
      set({ people, suggestions, canUndo, featuresAvailable, error: null, revision: get().revision + 1 });
    } catch (error) {
      if (sequence === refreshSequence) set({ error: String(error) });
    }
  },
  mutate: async (mutation) => {
    if (get().mutating) throw new Error('A correction is already running');
    set({ error: null, mutating: true });
    const previous = get().people;
    if (mutation.type === 'rename')
      set({ people: previous.map((p) => (p.id === mutation.id ? { ...p, name: mutation.name.trim() || null } : p)) });
    if (mutation.type === 'merge')
      set({ people: previous.filter((p) => !mutation.ids.includes(p.id) || p.id === mutation.target) });
    try {
      await peopleInvoke('mutate', { mutation });
      await get().refresh();
    } catch (error) {
      set({ people: previous, error: String(error) });
      throw error;
    } finally {
      set({ mutating: false });
    }
  },
}));
const thumbnails = createThumbnailCache((id) => peopleInvoke<string>('thumbnail', { id }));
export const faceThumbnail = (id: string) => thumbnails.get(id);
export const clearFaceThumbnails = () => thumbnails.clear();
