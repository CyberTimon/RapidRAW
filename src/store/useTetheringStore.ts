import { create } from 'zustand';

export interface CameraSetting {
  name: string;
  current_value: string;
  choices: string[];
}

interface TetheringState {
  cameras: string[];
  isConnected: boolean;
  isDetecting: boolean;
  isCapturing: boolean;
  autoOpenCaptured: boolean;
  settings: Record<string, CameraSetting>;
  lastCapturedPath: string | null;
  showGhostImage: boolean;
  liveViewRotation: number;
  liveViewFlipped: boolean;

  setTethering: (updater: Partial<TetheringState> | ((state: TetheringState) => Partial<TetheringState>)) => void;
}

export const useTetheringStore = create<TetheringState>((set) => ({
  cameras: [],
  isConnected: false,
  isDetecting: false,
  isCapturing: false,
  autoOpenCaptured: true,
  settings: {},
  lastCapturedPath: null,
  showGhostImage: false,
  liveViewRotation: 0,
  liveViewFlipped: false,

  setTethering: (updater) => set((state) => (typeof updater === 'function' ? updater(state) : updater)),
}));
