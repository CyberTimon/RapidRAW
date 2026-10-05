import { create } from 'zustand';

export const CLOUD_API_BASE_URL = 'http://127.0.0.1:5000';

export interface CloudUsage {
  requests: number;
  limit: number;
  month: string;
}

interface CloudStoreState {
  cloudUsage: CloudUsage | null;
  isLoading: boolean;
  error: string | null;
  fetchUsage: (getToken: () => Promise<string | null>) => Promise<void>;
  setCloudUsage: (usage: CloudUsage | null) => void;
}

export const useCloudStore = create<CloudStoreState>((set) => ({
  cloudUsage: null,
  isLoading: false,
  error: null,

  fetchUsage: async (getToken) => {
    try {
      set({ isLoading: true, error: null });
      const token = await getToken();
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
      set({ error: err.message || 'Error fetching usage', isLoading: false });
    }
  },

  setCloudUsage: (cloudUsage) => set({ cloudUsage }),
}));
