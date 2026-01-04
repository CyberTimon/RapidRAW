import { useBloc } from '@blac/react';
import { LayoutRenderer } from '../../layouts/LayoutRenderer.js';
import { exploreLayout } from '../../config/layouts/explore.js';
import { LibraryBloc } from '../../blocs/library/LibraryBloc.js';
import { WelcomeScreen } from '../../modules/library/WelcomeScreen.js';
import { renderModule } from '../../modules/registry.js';

export function ExploreView() {
  const [library] = useBloc(LibraryBloc);

  if (!library.rootPath) {
    return (
      <div className="h-full w-full bg-bg-primary">
        <WelcomeScreen />
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-bg-primary">
      <LayoutRenderer config={exploreLayout} moduleRenderer={renderModule} />
    </div>
  );
}
