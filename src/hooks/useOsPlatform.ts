import { useMemo } from 'react';
import { platform } from '@tauri-apps/plugin-os';

export function useOsPlatform() {
  return useMemo(() => {
    try {
      return platform();
    } catch (_error) {
      return '';
    }
  }, []);
}
