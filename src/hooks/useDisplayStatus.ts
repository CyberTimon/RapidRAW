import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Invokes } from '../types/invokes';
import { useEditorStore } from '../store/useEditorStore';
import { useSettingsStore } from '../store/useSettingsStore';

export const DEFAULT_HDR_HEADROOM = 2;

export interface DisplayStatus {
  rendererActive: boolean;
  hdrSupported: boolean;
  hdrActive: boolean;
  colorManagement: 'none' | 'system' | 'profile';
  profileName: string | null;
  previewSpace: string;
}

export function useDisplayStatus(pollInterval?: number) {
  const [status, setStatus] = useState<DisplayStatus | null>(null);
  const displayRevision = useEditorStore((state) => state.displayRevision);
  const hdrDisplay = useSettingsStore((state) => state.appSettings?.hdrDisplay);
  const displayColorMode = useSettingsStore((state) => state.appSettings?.displayColorMode);
  const displayIccProfile = useSettingsStore((state) => state.appSettings?.displayIccProfile);
  const wideGamutPreview = useSettingsStore((state) => state.appSettings?.wideGamutPreview);

  useEffect(() => {
    let mounted = true;
    const refresh = () =>
      invoke<DisplayStatus>(Invokes.GetDisplayStatus)
        .then((next) => mounted && setStatus(next))
        .catch(() => mounted && setStatus(null));
    refresh();
    window.addEventListener('focus', refresh);
    const timer = pollInterval ? setInterval(refresh, pollInterval) : undefined;
    return () => {
      mounted = false;
      window.removeEventListener('focus', refresh);
      clearInterval(timer);
    };
  }, [displayRevision, hdrDisplay, displayColorMode, displayIccProfile, wideGamutPreview, pollInterval]);

  return status;
}
