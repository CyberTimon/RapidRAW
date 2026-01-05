import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, Square, X, Maximize2 } from 'lucide-react';

interface TitleBarProps {
  title?: string;
  showControls?: boolean;
}

export function TitleBar({ title = 'RapidRAW', showControls = true }: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    setIsMac(navigator.platform.toLowerCase().includes('mac'));

    const checkMaximized = async () => {
      try {
        const window = getCurrentWindow();
        setIsMaximized(await window.isMaximized());
      } catch (e) {
        console.error('Failed to check maximized state:', e);
      }
    };

    checkMaximized();

    const unlisten = getCurrentWindow().onResized(async () => {
      try {
        const window = getCurrentWindow();
        setIsMaximized(await window.isMaximized());
      } catch (e) {
        console.error('Failed to update maximized state:', e);
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const handleMinimize = async () => {
    try {
      const window = getCurrentWindow();
      await window.minimize();
    } catch (e) {
      console.error('Failed to minimize:', e);
    }
  };

  const handleMaximize = async () => {
    try {
      const window = getCurrentWindow();
      await window.toggleMaximize();
    } catch (e) {
      console.error('Failed to toggle maximize:', e);
    }
  };

  const handleClose = async () => {
    try {
      const window = getCurrentWindow();
      await window.close();
    } catch (e) {
      console.error('Failed to close:', e);
    }
  };

  return (
    <div
      data-tauri-drag-region
      className="h-8 bg-bg-secondary flex items-center justify-between select-none border-b border-surface"
    >
      {isMac && <div className="w-20" />}

      <div
        data-tauri-drag-region
        className="flex-1 text-center text-sm text-text-secondary font-medium"
      >
        {title}
      </div>

      {showControls && !isMac && (
        <div className="flex items-center h-full">
          <button
            onClick={handleMinimize}
            className="h-full px-4 hover:bg-surface text-text-secondary hover:text-text-primary"
            title="Minimize"
          >
            <Minus size={14} />
          </button>
          <button
            onClick={handleMaximize}
            className="h-full px-4 hover:bg-surface text-text-secondary hover:text-text-primary"
            title={isMaximized ? 'Restore' : 'Maximize'}
          >
            {isMaximized ? <Square size={12} /> : <Maximize2 size={14} />}
          </button>
          <button
            onClick={handleClose}
            className="h-full px-4 hover:bg-red-600 text-text-secondary hover:text-white"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {isMac && <div className="w-12" />}
    </div>
  );
}
