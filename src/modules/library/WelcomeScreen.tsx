import { useState, useEffect } from 'react';
import { useBloc, useBlocActions } from '@blac/react';
import { Folder, RefreshCw, Settings } from 'lucide-react';
import { getVersion as tauriGetVersion } from '@tauri-apps/api/app';
import { open as tauriShellOpen } from '@tauri-apps/plugin-shell';
import { Button } from '../../primitives/Button';
import { SettingsBloc } from '../../blocs/app/SettingsBloc';
import { LibraryBloc } from '../../blocs/library/LibraryBloc';
import { FolderBloc } from '../../blocs/library/FolderBloc';
import { SettingsPanel } from '../settings/SettingsPanel';
import { openFolderDialog } from '../../services/fileDialogs';
import { isTauri, mockGetVersion, mockShellOpen } from '../../utils/tauriMock';

const getVersion = isTauri() ? tauriGetVersion : mockGetVersion;
const shellOpen = isTauri() ? tauriShellOpen : mockShellOpen;

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
  const [settings, settingsBloc] = useBloc(SettingsBloc);
  const libraryBloc = useBlocActions(LibraryBloc);
  const folderBloc = useBlocActions(FolderBloc);

  const [showSettings, setShowSettings] = useState(false);

  const [appVersion, setAppVersion] = useState('');
  const [latestVersion, setLatestVersion] = useState('');
  const [isUpdateAvailable, setIsUpdateAvailable] = useState(false);

  const lastRootPath = settings.settings.lastRootPath;
  const hasLastPath = !!lastRootPath;
  const theme = settings.settings.theme || 'dark';
  const splashImage = SPLASH_IMAGES[theme] || SPLASH_IMAGES.dark;

  useEffect(() => {
    const compareVersions = (v1: string, v2: string) => {
      const parts1 = v1.split('.').map(Number);
      const parts2 = v2.split('.').map(Number);
      for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 < p2) return -1;
        if (p1 > p2) return 1;
      }
      return 0;
    };

    const checkVersion = async () => {
      try {
        const currentVersion = await getVersion();
        setAppVersion(currentVersion);

        const response = await fetch(
          'https://api.github.com/repos/CyberTimon/RapidRAW/releases/latest'
        );
        const data = await response.json();
        const latestTag = data.tag_name;
        const latestVersionStr = latestTag.startsWith('v') ? latestTag.substring(1) : latestTag;
        setLatestVersion(latestVersionStr);

        if (compareVersions(currentVersion, latestVersionStr) < 0) {
          setIsUpdateAvailable(true);
        }
      } catch (error) {
        console.error('Failed to check version:', error);
      }
    };

    checkVersion();
  }, []);

  const handleOpenFolder = async () => {
    const path = await openFolderDialog();
    if (path) {
      libraryBloc.openFolder(path, true);
      folderBloc.loadTree(path);
      settingsBloc.updateSettings({ lastRootPath: path });
    }
  };

  const handleContinueSession = () => {
    if (lastRootPath) {
      libraryBloc.openFolder(lastRootPath, true);
      folderBloc.loadTree(lastRootPath);
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
        <div className="w-full md:w-1/2 flex flex-col overflow-hidden">
          <SettingsPanel onBack={() => setShowSettings(false)} />
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

        <div className="absolute bottom-8 left-8 lg:left-16 text-xs text-text-secondary space-y-1">
          <p>
            Images by{' '}
            <a
              href="https://instagram.com/timonkaech.photography"
              className="hover:underline"
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                e.preventDefault();
                shellOpen('https://instagram.com/timonkaech.photography');
              }}
            >
              Timon Käch
            </a>
          </p>
          {appVersion && (
            <div className="flex items-center space-x-2">
              <p>
                <span
                  className={`group transition-all duration-300 ease-in-out rounded-md py-1 ${
                    isUpdateAvailable
                      ? 'cursor-pointer border border-yellow-500 px-2 hover:bg-yellow-500/20'
                      : ''
                  }`}
                  onClick={() => {
                    if (isUpdateAvailable) {
                      shellOpen('https://github.com/CyberTimon/RapidRAW/releases/latest');
                    }
                  }}
                  title={
                    isUpdateAvailable
                      ? `Click to download version ${latestVersion}`
                      : `You are on the latest version`
                  }
                >
                  <span className={isUpdateAvailable ? 'group-hover:hidden' : ''}>
                    Version {appVersion}
                  </span>
                  {isUpdateAvailable && (
                    <span className="hidden group-hover:inline text-yellow-400">
                      New version available!
                    </span>
                  )}
                </span>
              </p>
              <span>-</span>
              <p>
                <a
                  href="https://ko-fi.com/cybertimon"
                  className="hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => {
                    e.preventDefault();
                    shellOpen('https://ko-fi.com/cybertimon');
                  }}
                >
                  Donate on Ko-Fi
                </a>
                <span className="mx-1">or</span>
                <a
                  href="https://github.com/CyberTimon/RapidRAW"
                  className="hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => {
                    e.preventDefault();
                    shellOpen('https://github.com/CyberTimon/RapidRAW');
                  }}
                >
                  Contribute on GitHub
                </a>
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
