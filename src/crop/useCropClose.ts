import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEditorStore } from '../store/useEditorStore';
import { finishCropSession } from './lifecycle';
import { debouncedSave, debouncedSetHistory } from '../hooks/useEditorActions';

export function useCropClose() {
  useEffect(() => {
    let disposed = false,
      closing = false;
    let unlisten: (() => void) | undefined;
    const appWindow = getCurrentWindow();
    void appWindow
      .onCloseRequested(async (event) => {
        if (closing) return;
        if (!useEditorStore.getState().cropSession) return;
        event.preventDefault();
        const saved = await finishCropSession();
        debouncedSetHistory.flush();
        if (saved === false) return;
        if ((await debouncedSave.flush()) === false) return;
        closing = true;
        await appWindow.close();
      })
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch(console.error);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
