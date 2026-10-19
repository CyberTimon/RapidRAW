import { useMemo } from 'react';
import { type Platform, platform } from '@tauri-apps/plugin-os';

export type PlatformInfo = {
  osPlatform: Platform;
  isMac: boolean;
  isLinux: boolean;
  isWindows: boolean;
  isMobile: boolean;
};

export function useOsPlatform() {
  return useMemo(() => {
    const osPlatform = platform();
    return {
      osPlatform,
      isMac: osPlatform === 'macos',
      isLinux: osPlatform === 'linux',
      isWindows: osPlatform === 'windows',
      isAndroid: osPlatform === 'android',
      isMobile: osPlatform === 'android',
    };
  }, []);
}
