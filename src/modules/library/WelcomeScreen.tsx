import { useState } from 'react';
import { useBloc } from '@blac/react';
import { Folder, RefreshCw, Settings } from 'lucide-react';
import { Button } from '../../primitives/Button';
import { SettingsBloc } from '../../blocs/app/SettingsBloc';

const SPLASH_IMAGES: Record<string, string> = {
  dark: '/splash-dark.jpg',
  light: '/splash-light.jpg',
  grey: '/splash-grey.jpg',
  green: '/splash-green.jpg',
  blue: '/splash-blue.jpg',
  sepia: '/splash-sepia.jpg',
  snow: '/splash-snow.jpg',
  arctic: '/splash-arctic.jpg',
};

export function WelcomeScreen() {
  const [settings] = useBloc(SettingsBloc);
  const [showSettings, setShowSettings] = useState(false);

  const lastRootPath = settings.settings.lastRootPath;
  const hasLastPath = !!lastRootPath;
  const theme = settings.settings.theme || 'dark';
  const splashImage = SPLASH_IMAGES[theme] || SPLASH_IMAGES.dark;

  const handleOpenFolder = async () => {
    // TODO: Wire up with TauriService
    // const tauri = borrow(TauriService);
    // const path = await tauri.openFolderDialog();
    // if (path) {
    //   borrow(LibraryBloc).openFolder(path, true);
    // }
  };

  const handleContinueSession = () => {
    if (lastRootPath) {
      // TODO: Wire up with LibraryBloc
      // borrow(LibraryBloc).openFolder(lastRootPath, true);
    }
  };

  if (showSettings) {
    return (
      <div className="h-full w-full flex bg-bg-secondary">
        <div className="w-1/2 hidden md:block relative">
          <img
            src={splashImage}
            alt="Splash screen background"
            className="absolute inset-0 w-full h-full object-cover"
          />
        </div>
        <div className="w-full md:w-1/2 flex flex-col p-8 lg:p-16">
          <div className="flex items-center gap-4 mb-8">
            <button
              onClick={() => setShowSettings(false)}
              className="p-2 rounded-md hover:bg-surface text-text-secondary hover:text-text-primary"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </button>
            <h2 className="text-2xl font-bold text-text-primary">Settings</h2>
          </div>
          <div className="flex-1 overflow-y-auto">
            <p className="text-text-secondary">
              Settings panel coming soon...
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full flex bg-bg-secondary overflow-hidden">
      <div className="w-1/2 hidden md:block relative">
        <img
          src={splashImage}
          alt="Splash screen background"
          className="absolute inset-0 w-full h-full object-cover"
        />
      </div>
      <div className="w-full md:w-1/2 flex flex-col p-8 lg:p-16 relative">
        <div className="my-auto text-left">
          <h1 className="text-5xl font-bold text-text-primary text-shadow-shiny mb-4">
            RapidRAW
          </h1>
          <p className="text-text-secondary mb-10 max-w-md">
            {hasLastPath ? (
              <>
                Welcome back!
                <br />
                Continue where you left off or start a new session.
              </>
            ) : (
              'A blazingly fast, GPU-accelerated RAW image editor. Open a folder to begin.'
            )}
          </p>
          <div className="flex flex-col w-full max-w-xs gap-4">
            {hasLastPath && (
              <Button
                variant="primary"
                size="lg"
                className="w-full justify-start h-11"
                onClick={handleContinueSession}
              >
                <RefreshCw size={20} className="mr-2" />
                Continue Session
              </Button>
            )}
            <div className="flex items-center gap-2">
              <Button
                variant={hasLastPath ? 'surface' : 'primary'}
                size="lg"
                className="flex-grow justify-start h-11"
                onClick={handleOpenFolder}
              >
                <Folder size={20} className="mr-2" />
                {hasLastPath ? 'Change Folder' : 'Open Folder'}
              </Button>
              <Button
                variant="ghost"
                size="lg"
                className="px-3 h-11"
                onClick={() => setShowSettings(true)}
                title="Settings"
              >
                <Settings size={20} />
              </Button>
            </div>
          </div>
        </div>

        <div className="absolute bottom-8 left-8 lg:left-16 right-8 lg:right-16">
          <p className="text-xs text-text-secondary">
            Tip: Press{' '}
            <kbd className="px-1.5 py-0.5 bg-surface rounded text-text-primary">
              Cmd+O
            </kbd>{' '}
            to quickly open a folder
          </p>
        </div>
      </div>
    </div>
  );
}
