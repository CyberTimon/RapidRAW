import { useBloc, useBlocActions } from '@blac/react';
import { useEffect } from 'react';
import { AppBloc } from './blocs/app/AppBloc';
import { KeyboardService } from './blocs/services/KeyboardService';
import { TauriService } from './blocs/services/TauriService';
import { ExploreView } from './views/ExploreView/ExploreView';
import { EditView } from './views/EditView/EditView';
import { CommunityView } from './views/CommunityView/CommunityView';
import { ContextMenuProvider } from './context/ContextMenuContext';
import { TitleBar } from './modules/window/TitleBar';

import { ModalRenderer } from './modules/modals/ModalRenderer';
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts';
import { useTauriEvents } from './hooks/useTauriEvents';

function AppContent() {
  const [appState, appBloc] = useBloc(AppBloc);

  useGlobalShortcuts();

  useEffect(() => {
    appBloc.initialize();
  }, [appBloc]);

  if (!appState.isInitialized) {
    return (
      <div className="h-full flex items-center justify-center bg-bg-primary">
        <div className="text-text-secondary">Loading...</div>
      </div>
    );
  }

  if (appState.error) {
    return (
      <div className="h-full flex items-center justify-center bg-bg-primary">
        <div className="text-center">
          <div className="text-red-500 mb-2">Error</div>
          <div className="text-text-secondary">{appState.error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-hidden bg-bg-primary text-text-primary">
      {appState.activeView === 'explore' && <ExploreView />}
      {appState.activeView === 'edit' && <EditView />}
      {appState.activeView === 'community' && <CommunityView />}
    </div>
  );
}

export default function App() {
  const keyboardService = useBlocActions(KeyboardService);
  const tauriService = useBlocActions(TauriService);

  useTauriEvents();

  useEffect(() => {
    keyboardService.initialize();
    return () => keyboardService.cleanup();
  }, [keyboardService]);

  useEffect(() => {
    return () => tauriService.cleanup();
  }, [tauriService]);

  return (
    <ContextMenuProvider>
      <div className="h-screen w-screen flex flex-col overflow-hidden">
        <TitleBar />
        <div className="flex-1 overflow-hidden">
          <AppContent />
        </div>
        <ModalRenderer />
      </div>
    </ContextMenuProvider>
  );
}
