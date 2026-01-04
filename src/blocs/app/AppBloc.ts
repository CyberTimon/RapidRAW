import { Cubit } from '@blac/core';

export type ViewId = 'explore' | 'edit' | 'community';

interface AppState {
  activeView: ViewId;
  isWindowFullScreen: boolean;
  isInitialized: boolean;
  error: string | null;
}

export class AppBloc extends Cubit<AppState> {
  constructor() {
    super({
      activeView: 'explore',
      isWindowFullScreen: false,
      isInitialized: false,
      error: null,
    });
  }

  setActiveView = (view: ViewId) => {
    this.patch({ activeView: view });
  };

  navigateToEditor = () => this.setActiveView('edit');
  navigateToLibrary = () => this.setActiveView('explore');
  navigateToCommunity = () => this.setActiveView('community');

  setWindowFullScreen = (isFullScreen: boolean) => {
    this.patch({ isWindowFullScreen: isFullScreen });
  };

  initialize = async () => {
    try {
      // TODO: Load settings from SettingsBloc once implemented
      this.patch({ isInitialized: true });
    } catch (error) {
      this.patch({ error: `Initialization failed: ${error}` });
    }
  };

  setError = (error: string | null) => {
    this.patch({ error });
  };

  clearError = () => this.setError(null);
}
