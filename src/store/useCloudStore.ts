import { create } from 'zustand';
import type { Clerk } from '@clerk/clerk-js';
import { initClerk } from 'tauri-plugin-clerk';
import { fetch } from '@tauri-apps/plugin-http';
import { platform } from '@tauri-apps/plugin-os';

export const CLOUD_API_BASE_URL = 'https://www.getrapidraw.com/api';

export interface CloudUsage {
  requests: number;
  limit: number;
  month: string;
}

type AuthStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'unsupported';

interface CloudStoreState {
  authStatus: AuthStatus;
  clerk: Clerk | null;
  user: Clerk['user'] | null;
  initAuth: () => Promise<void>;
  getToken: () => Promise<string | null>;
  signOut: () => Promise<void>;

  cloudUsage: CloudUsage | null;
  isLoading: boolean;
  error: string | null;
  fetchUsage: () => Promise<void>;
  setCloudUsage: (usage: CloudUsage | null) => void;
}

export const useCloudStore = create<CloudStoreState>((set, get) => ({
  authStatus: 'idle',
  clerk: null,
  user: null,

  initAuth: async () => {
    const { authStatus } = get();
    if (authStatus === 'loading' || authStatus === 'ready' || authStatus === 'unsupported') return;

    let os = '';
    try {
      os = platform();
    } catch (_error) {
      os = '';
    }
    if (os === 'android' || os === 'ios') {
      set({ authStatus: 'unsupported' });
      return;
    }

    set({ authStatus: 'loading' });
    try {
      const clerk = await initClerk({
        routerPush: () => {},
        routerReplace: () => {},
      });
      clerk.addListener(({ user }) => {
        set({ user: user ?? null });
        if (!user) set({ cloudUsage: null });
      });
      set({ clerk, user: clerk.user ?? null, authStatus: 'ready' });
    } catch (e) {
      console.error('Clerk init failed:', e);
      set({ authStatus: 'unavailable' });
    }
  },

  getToken: async () => (await get().clerk?.session?.getToken()) ?? null,

  signOut: async () => {
    await get().clerk?.signOut();
  },

  cloudUsage: null,
  isLoading: false,
  error: null,

  fetchUsage: async () => {
    try {
      set({ isLoading: true, error: null });
      const token = await get().getToken();
      if (!token) {
        set({ isLoading: false });
        return;
      }

      const res = await fetch(`${CLOUD_API_BASE_URL}/usage`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        throw new Error(`Failed to fetch usage: ${res.statusText}`);
      }

      const data: CloudUsage = await res.json();
      set({ cloudUsage: data, isLoading: false });
    } catch (err: any) {
      console.error('Failed to fetch cloud usage:', err);
      set({ error: err.message || 'Error fetching usage', isLoading: false });
    }
  },

  setCloudUsage: (cloudUsage) => set({ cloudUsage }),
}));
