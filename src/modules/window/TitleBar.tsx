import { useBloc } from '@blac/react';
import { useEffect, useState } from 'react';
import { Minus, Square, X, Maximize2 } from 'lucide-react';
import { TauriService } from '../../blocs/services/TauriService';

interface TitleBarProps {
  title?: string;
  showControls?: boolean;
}

export function TitleBar({ title = 'RapidRAW', showControls = true }: TitleBarProps) {
  const [, tauriService] = useBloc(TauriService);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isMac, setIsMac] = useState(false);
  console.log('TitleBar rendered with title:', title);

  useEffect(() => {
    console.log('Determining OS platform...');
    setIsMac(navigator.platform.toLowerCase().includes('mac'));

    const checkMaximized = async () => {
      console.log('Checking if window is maximized...');
      const maximized = await tauriService.isWindowMaximized();
      setIsMaximized(maximized);
    };

    checkMaximized();

    let unlistenFn: (() => void) | null = null;
    tauriService
      .onWindowResized(async () => {
        const maximized = await tauriService.isWindowMaximized();
        setIsMaximized(maximized);
      })
      .then((unlisten) => {
        unlistenFn = unlisten;
      });

    return () => {
      unlistenFn?.();
    };
  }, [tauriService]);

  const handleMinimize = () => tauriService.minimizeWindow();
  const handleMaximize = () => tauriService.toggleMaximizeWindow();
  const handleClose = () => tauriService.closeWindow();

  return (
    <div
      data-tauri-drag-region
      className="h-8 bg-bg-secondary flex items-center justify-between select-none border-b border-surface"
    >
      {isMac && <div className="w-20" />}

      <div data-tauri-drag-region className="flex-1 text-center text-sm text-text-secondary font-medium">
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
