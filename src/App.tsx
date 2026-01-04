import { useBloc } from '@blac/react';
import { useEffect } from 'react';
import { AppBloc } from './blocs/app/AppBloc';
import { ExploreView } from './views/ExploreView/ExploreView';
import { EditView } from './views/EditView/EditView';
import { CommunityView } from './views/CommunityView/CommunityView';

export default function App() {
  const [appState, appBloc] = useBloc(AppBloc);

  useEffect(() => {
    appBloc.initialize();
  }, [appBloc]);

  if (!appState.isInitialized) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-bg-primary">
        <div className="text-text-secondary">Loading...</div>
      </div>
    );
  }

  if (appState.error) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-bg-primary">
        <div className="text-center">
          <div className="text-red-500 mb-2">Error</div>
          <div className="text-text-secondary">{appState.error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-bg-primary text-text-primary">
      {appState.activeView === 'explore' && <ExploreView />}
      {appState.activeView === 'edit' && <EditView />}
      {appState.activeView === 'community' && <CommunityView />}
    </div>
  );
}
