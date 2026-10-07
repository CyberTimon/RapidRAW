import { create } from 'zustand';
import { useSettingsStore } from '../../store/useSettingsStore';
import { getImmichApiKey, ImmichAlbum, ImmichTimelineMonth, listImmichAlbums, listImmichTimeline } from './immichApi';

interface ImmichState {
  isConfigured: boolean;
  albums: ImmichAlbum[];
  isLoading: boolean;
  error: string | null;
  timeline: ImmichTimelineMonth[];
  loadTimeline(): Promise<void>;
  refresh(): Promise<void>;
  loadAlbums(): Promise<void>;
}

export const useImmichStore = create<ImmichState>((set, get) => ({
  isConfigured: false,
  albums: [],
  isLoading: false,
  error: null,
  timeline: [],
  loadTimeline: async () => {
    try {
      set({ timeline: await listImmichTimeline() });
    } catch (err) {
      console.error('Failed to load the Immich timeline:', err);
    }
  },

  refresh: async () => {
    try {
      const serverUrl = useSettingsStore.getState().appSettings?.immich?.serverUrl ?? '';
      const { apiKey } = await getImmichApiKey();
      const isConfigured = !!serverUrl.trim() && !!apiKey.trim();
      set({ isConfigured, ...(isConfigured ? {} : { albums: [], error: null }) });
      if (isConfigured) await get().loadAlbums();
    } catch (err) {
      console.error('Failed to read Immich settings:', err);
    }
  },

  loadAlbums: async () => {
    set({ isLoading: true, error: null });
    try {
      set({ albums: await listImmichAlbums() });
    } catch (err) {
      set({ error: String(err) });
    } finally {
      set({ isLoading: false });
    }
  },
}));
