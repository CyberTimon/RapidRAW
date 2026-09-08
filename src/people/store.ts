import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { PeopleMutation, PeopleScanProgress, PersonSummary } from './types';
interface PeopleStore {
  people: PersonSummary[];
  activePersonId: string | null;
  progress: PeopleScanProgress | null;
  error: string | null;
  revision: number;
  refresh: () => Promise<void>;
  mutate: (mutation: PeopleMutation) => Promise<void>;
}
export const peopleInvoke = <T>(command: string, args?: Record<string, unknown>) =>
  invoke<T>(`plugin:people|${command}`, args);
export const usePeopleStore = create<PeopleStore>((set, get) => ({
  people: [],
  activePersonId: null,
  progress: null,
  error: null,
  revision: 0,
  refresh: async () => {
    try {
      const people = await peopleInvoke<PersonSummary[]>('list');
      set({ people, revision: get().revision + 1 });
    } catch (error) {
      set({ error: String(error) });
    }
  },
  mutate: async (mutation) => {
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
    }
  },
}));
const thumbnails = new Map<string, Promise<string>>();
export function faceThumbnail(id: string) {
  let result = thumbnails.get(id);
  if (!result) {
    result = peopleInvoke<string>('thumbnail', { id }).catch((error) => {
      thumbnails.delete(id);
      throw error;
    });
    thumbnails.set(id, result);
    if (thumbnails.size > 128) thumbnails.delete(thumbnails.keys().next().value!);
  }
  return result;
}
export function clearFaceThumbnails() {
  thumbnails.clear();
}
