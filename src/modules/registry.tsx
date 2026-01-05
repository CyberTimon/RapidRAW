import { lazy, ComponentType } from 'react';

export type ModuleId =
  | 'folder-tree'
  | 'gallery-grid'
  | 'gallery-controls'
  | 'filmstrip'
  | 'welcome-screen'
  | 'image-card'
  | 'loading-spinner'
  | 'context-menu'
  | 'bottom-bar'
  | 'library-export-panel'
  | 'fullscreen-viewer'
  | 'image-preview'
  | 'image-histogram'
  | 'image-waveform'
  | 'editor-toolbar'
  | 'zoom-controls'
  | 'exposure-controls'
  | 'color-controls'
  | 'tone-curves'
  | 'detail-controls'
  | 'effects-controls'
  | 'hsl-controls'
  | 'lens-corrections'
  | 'adjustments-panel'
  | 'crop-panel'
  | 'masks-panel'
  | 'presets-panel'
  | 'export-panel'
  | 'metadata-panel'
  | 'ai-panel'
  | 'panel-switcher'
  | 'settings-panel';

interface ModuleEntry {
  component: ComponentType;
  preload?: () => Promise<unknown>;
}

const moduleRegistry: Partial<Record<ModuleId, ModuleEntry>> = {
  'folder-tree': {
    component: lazy(() =>
      import('./library/FolderTree.js').then((m) => ({ default: m.FolderTree }))
    ),
  },
  'gallery-grid': {
    component: lazy(() =>
      import('./library/GalleryGrid.js').then((m) => ({ default: m.GalleryGrid }))
    ),
  },
  'gallery-controls': {
    component: lazy(() =>
      import('./library/GalleryControls.js').then((m) => ({ default: m.GalleryControls }))
    ),
  },
  filmstrip: {
    component: lazy(() =>
      import('./library/Filmstrip.js').then((m) => ({ default: m.Filmstrip }))
    ),
  },
  'welcome-screen': {
    component: lazy(() =>
      import('./library/WelcomeScreen.js').then((m) => ({ default: m.WelcomeScreen }))
    ),
  },
  'loading-spinner': {
    component: lazy(() =>
      import('./common/LoadingSpinner.js').then((m) => ({ default: m.LoadingSpinner }))
    ),
  },
  'context-menu': {
    component: lazy(() =>
      import('./common/ContextMenu.js').then((m) => ({ default: m.ContextMenu }))
    ),
  },
  'bottom-bar': {
    component: lazy(() =>
      import('./common/BottomBar.js').then((m) => ({ default: m.BottomBar }))
    ),
  },
  'library-export-panel': {
    component: lazy(() =>
      import('./library/LibraryExportPanel.js').then((m) => ({ default: m.LibraryExportPanel }))
    ),
  },
  'fullscreen-viewer': {
    component: lazy(() =>
      import('./editor/FullscreenViewer.js').then((m) => ({ default: m.FullscreenViewer }))
    ),
  },
  'image-preview': {
    component: lazy(() =>
      import('./editor/ImagePreview.js').then((m) => ({ default: m.ImagePreview }))
    ),
  },
  'editor-toolbar': {
    component: lazy(() =>
      import('./editor/EditorToolbar.js').then((m) => ({ default: m.EditorToolbar }))
    ),
  },
  'zoom-controls': {
    component: lazy(() =>
      import('./editor/ZoomControls.js').then((m) => ({ default: m.ZoomControls }))
    ),
  },
  'image-histogram': {
    component: lazy(() =>
      import('./editor/ImageHistogram.js').then((m) => ({ default: m.ImageHistogram }))
    ),
  },
  'image-waveform': {
    component: lazy(() =>
      import('./editor/ImageWaveform.js').then((m) => ({ default: m.ImageWaveform }))
    ),
  },
  'exposure-controls': {
    component: lazy(() =>
      import('./adjustments/ExposureControls.js').then((m) => ({ default: m.ExposureControls }))
    ),
  },
  'color-controls': {
    component: lazy(() =>
      import('./adjustments/ColorControls.js').then((m) => ({ default: m.ColorControls }))
    ),
  },
  'detail-controls': {
    component: lazy(() =>
      import('./adjustments/DetailControls.js').then((m) => ({ default: m.DetailControls }))
    ),
  },
  'effects-controls': {
    component: lazy(() =>
      import('./adjustments/EffectsControls.js').then((m) => ({ default: m.EffectsControls }))
    ),
  },
  'hsl-controls': {
    component: lazy(() =>
      import('./adjustments/HSLControls.js').then((m) => ({ default: m.HSLControls }))
    ),
  },
  'tone-curves': {
    component: lazy(() =>
      import('./adjustments/ToneCurves.js').then((m) => ({ default: m.ToneCurves }))
    ),
  },
  'lens-corrections': {
    component: lazy(() =>
      import('./adjustments/LensCorrections.js').then((m) => ({ default: m.LensCorrections }))
    ),
  },
  'adjustments-panel': {
    component: lazy(() =>
      import('./panels/AdjustmentsPanel.js').then((m) => ({ default: m.AdjustmentsPanel }))
    ),
  },
  'panel-switcher': {
    component: lazy(() =>
      import('./panels/PanelSwitcher.js').then((m) => ({ default: m.PanelSwitcher }))
    ),
  },
  'metadata-panel': {
    component: lazy(() =>
      import('./panels/MetadataPanel.js').then((m) => ({ default: m.MetadataPanel }))
    ),
  },
  'export-panel': {
    component: lazy(() =>
      import('./panels/ExportPanel.js').then((m) => ({ default: m.ExportPanel }))
    ),
  },
  'crop-panel': {
    component: lazy(() =>
      import('./panels/CropPanel.js').then((m) => ({ default: m.CropPanel }))
    ),
  },
  'masks-panel': {
    component: lazy(() =>
      import('./panels/MasksPanel.js').then((m) => ({ default: m.MasksPanel }))
    ),
  },
  'presets-panel': {
    component: lazy(() =>
      import('./panels/PresetsPanel.js').then((m) => ({ default: m.PresetsPanel }))
    ),
  },
  'ai-panel': {
    component: lazy(() =>
      import('./panels/AIPanel.js').then((m) => ({ default: m.AIPanel }))
    ),
  },
  'settings-panel': {
    component: lazy(() =>
      import('./settings/SettingsPanel.js').then((m) => ({ default: m.SettingsPanel }))
    ),
  },
};

export function getModule(moduleId: ModuleId): ComponentType | null {
  const entry = moduleRegistry[moduleId];
  return entry?.component || null;
}

export function isModuleRegistered(moduleId: string): moduleId is ModuleId {
  return moduleId in moduleRegistry;
}

export function preloadModule(moduleId: ModuleId): void {
  const entry = moduleRegistry[moduleId];
  if (entry?.preload) {
    entry.preload();
  }
}

export function preloadModules(moduleIds: ModuleId[]): void {
  moduleIds.forEach(preloadModule);
}

export function renderModule(moduleId: string): React.ReactNode {
  if (!isModuleRegistered(moduleId)) {
    return (
      <div className="h-full w-full flex items-center justify-center text-text-secondary text-sm">
        Unknown module: {moduleId}
      </div>
    );
  }

  const Component = getModule(moduleId);
  if (!Component) {
    return (
      <div className="h-full w-full flex items-center justify-center text-text-secondary text-sm">
        Module not implemented: {moduleId}
      </div>
    );
  }

  return <Component />;
}
