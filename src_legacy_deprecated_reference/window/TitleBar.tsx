import { useCallback, useState, useEffect } from 'react';
import { platform } from '@tauri-apps/plugin-os';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, Square, X } from 'lucide-react';

export default function TitleBar() {
  const [osPlatform, setOsPlatform] = useState('');

  useEffect(() => {
    const getPlatform = async () => {
      try {
        const p = platform();
        setOsPlatform(p);
      } catch (error) {
        console.error('Failed to get platform:', error);
        setOsPlatform('windows');
      }
    };
    getPlatform();
  }, []);

  const appWindow = getCurrentWindow();
  const handleMinimize = () => appWindow.minimize();
  const handleClose = () => appWindow.close();

  const handleMaximize = useCallback(async () => {
    switch (osPlatform) {
      case 'macos': {
        const isFullscreen = await appWindow.isFullscreen();
        appWindow.setFullscreen(!isFullscreen);
        break;
      }
      default:
        appWindow.toggleMaximize();
        break;
    }
  }, [osPlatform, appWindow]);

  const isMac = osPlatform === 'macos';
  const isWindows = osPlatform === 'windows';

  if (!osPlatform) {
    return <div className="h-10 fixed top-0 left-0 right-0 z-50" data-tauri-drag-region />;
  }

  return (
    <div
      className="h-10 bg-bg-secondary border-white/5 flex justify-between items-center select-none fixed top-0 left-0 right-0 z-50"
      data-tauri-drag-region
    >
      <div className="flex items-center h-full">
        {isMac && (
          <div className="flex items-center h-full px-4 space-x-2">
            <button
              aria-label="Close window"
              className="w-3 h-3 rounded-full bg-red-500 hover:bg-red-600 transition-colors duration-150"
              onClick={handleClose}
            />
            <button
              aria-label="Minimize window"
              className="w-3 h-3 rounded-full bg-yellow-500 hover:bg-yellow-600 transition-colors duration-150"
              onClick={handleMinimize}
            />
            <button
              aria-label="Maximize window"
              className="w-3 h-3 rounded-full bg-green-500 hover:bg-green-600 transition-colors duration-150"
              onClick={handleMaximize}
            />
          </div>
        )}
        <div data-tauri-drag-region className={`flex items-center h-full ${isMac ? '' : 'px-4'}`}>
          <p className="text-sm font-semibold text-text-secondary">RapidRAW</p>
        </div>
      </div>
      <div className="flex items-center h-full">
        {isWindows && (
          <>
            <button
              aria-label="Minimize window"
              className="p-2 h-full inline-flex justify-center items-center hover:bg-white/10 transition-colors duration-150"
              onClick={handleMinimize}
            >
              <Minus size={16} className="text-text-secondary" />
            </button>
            <button
              aria-label="Maximize window"
              className="p-2 h-full inline-flex justify-center items-center hover:bg-white/10 transition-colors duration-150"
              onClick={handleMaximize}
            >
              <Square size={14} className="text-text-secondary" />
            </button>
            <button
              aria-label="Close window"
              className="p-2 h-full inline-flex justify-center items-center hover:bg-red-500/80 transition-colors duration-150"
              onClick={handleClose}
            >
              <X size={16} className="text-text-secondary hover:text-white" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
