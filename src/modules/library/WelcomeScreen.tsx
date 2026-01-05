import { useBloc } from '@blac/react';
import { Button } from '../../primitives/Button';
import { SettingsBloc } from '../../blocs/app/SettingsBloc';

export function WelcomeScreen() {
  const [settings] = useBloc(SettingsBloc);
  const lastRootPath = settings.settings.lastRootPath;
  const pinnedFolders = settings.settings.pinnedFolders;

  const handleOpenFolder = async () => {
    // TODO: Wire up with TauriService
    // const tauri = borrow(TauriService);
    // const path = await tauri.openFolderDialog();
    // if (path) {
    //   borrow(LibraryBloc).openFolder(path, true);
    // }
  };

  const handleOpenRecent = (_path: string) => {
    // TODO: Wire up with LibraryBloc
    // borrow(LibraryBloc).openFolder(path, true);
  };

  return (
    <div className="h-full w-full flex flex-col items-center justify-center p-8 bg-bg-primary">
      <div className="max-w-md w-full text-center space-y-8">
        <div className="space-y-2">
          <h1 className="text-4xl font-bold text-text-primary">RapidRAW</h1>
          <p className="text-text-secondary">
            Fast, powerful RAW photo editing for photographers
          </p>
        </div>

        <div className="space-y-4">
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            onClick={handleOpenFolder}
          >
            <svg
              className="w-5 h-5 mr-2"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
              />
            </svg>
            Open Folder
          </Button>

          {lastRootPath && (
            <Button
              variant="secondary"
              size="lg"
              className="w-full"
              onClick={() => handleOpenRecent(lastRootPath)}
            >
              <svg
                className="w-5 h-5 mr-2"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              Open Recent
            </Button>
          )}
        </div>

        {pinnedFolders.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-text-secondary uppercase tracking-wide">
              Pinned Folders
            </h3>
            <div className="space-y-2">
              {pinnedFolders.map((path) => (
                <button
                  key={path}
                  className="w-full px-4 py-3 text-left rounded-lg bg-surface hover:bg-surface/80 transition-colors group"
                  onClick={() => handleOpenRecent(path)}
                >
                  <div className="flex items-center gap-3">
                    <svg
                      className="w-5 h-5 text-text-secondary group-hover:text-accent"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                      />
                    </svg>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary truncate">
                        {path.split(/[\\/]/).pop()}
                      </p>
                      <p className="text-xs text-text-secondary truncate">{path}</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="pt-8 border-t border-border-color">
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
