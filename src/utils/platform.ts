import { platform } from '@tauri-apps/plugin-os';

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: {
    platform?: string;
  };
};

export function isAndroidClient(): boolean {
  try {
    return platform() === 'android';
  } catch (_error) {
    if (typeof navigator === 'undefined') {
      return false;
    }

    const nav = navigator as NavigatorWithUserAgentData;
    return /android/i.test(`${nav.userAgentData?.platform ?? ''} ${navigator.userAgent ?? ''}`);
  }
}
