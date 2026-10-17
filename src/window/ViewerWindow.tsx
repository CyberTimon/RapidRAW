import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Invokes } from '../components/ui/AppProperties';

interface ViewerInfo {
  native: boolean;
  background: [number, number, number, number];
}

const toCssColor = ([r, g, b]: ViewerInfo['background']) =>
  `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;

const toggleFullscreen = async () => {
  const appWindow = getCurrentWindow();
  await appWindow.setFullscreen(!(await appWindow.isFullscreen()));
};

export default function ViewerWindow() {
  const [info, setInfo] = useState<ViewerInfo | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);

  useEffect(() => {
    let isActive = true;

    const refresh = async () => {
      const nextInfo = await invoke<ViewerInfo>(Invokes.GetViewerInfo);
      if (!isActive) return;
      setInfo(nextInfo);
      if (nextInfo.native) return;

      const frame = await invoke<ArrayBuffer>(Invokes.GetViewerFrame);
      if (!isActive || frame.byteLength === 0) return;
      const url = URL.createObjectURL(new Blob([frame], { type: 'image/jpeg' }));
      setFrameUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return url;
      });
    };

    const unlisten = listen('viewer-updated', () => {
      refresh().catch(console.error);
    });
    unlisten.then(() => refresh()).catch(console.error);

    return () => {
      isActive = false;
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'F11') {
        event.preventDefault();
        toggleFullscreen().catch(console.error);
      } else if (event.key === 'Escape') {
        getCurrentWindow().setFullscreen(false).catch(console.error);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const isJpegMode = info !== null && !info.native;

  return (
    <div
      className="h-screen w-screen select-none overflow-hidden"
      onContextMenu={(event) => event.preventDefault()}
      onDoubleClick={() => toggleFullscreen().catch(console.error)}
      style={{ backgroundColor: isJpegMode ? toCssColor(info.background) : 'transparent' }}
    >
      {isJpegMode && frameUrl && (
        <img alt="" className="h-full w-full object-contain" draggable={false} src={frameUrl} />
      )}
    </div>
  );
}
