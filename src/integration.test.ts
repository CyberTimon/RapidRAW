import { describe, it, expect, beforeEach } from 'vitest';

// App blocs
import { AppBloc } from './blocs/app/AppBloc';
import { SettingsBloc } from './blocs/app/SettingsBloc';
import { UIBloc } from './blocs/app/UIBloc';
import { ModalBloc } from './blocs/app/ModalBloc';

// Library blocs
import { LibraryBloc } from './blocs/library/LibraryBloc';
import { FolderBloc } from './blocs/library/FolderBloc';
import { SelectionBloc } from './blocs/library/SelectionBloc';
import { ThumbnailBloc } from './blocs/library/ThumbnailBloc';
import { FilterBloc } from './blocs/library/FilterBloc';
import { SortBloc } from './blocs/library/SortBloc';
import { SearchBloc } from './blocs/library/SearchBloc';
import { RatingsBloc } from './blocs/library/RatingsBloc';

// Editor blocs
import { EditorBloc } from './blocs/editor/EditorBloc';
import { AdjustmentsBloc } from './blocs/editor/AdjustmentsBloc';
import { HistoryBloc } from './blocs/editor/HistoryBloc';
import { PreviewBloc } from './blocs/editor/PreviewBloc';
import { ZoomBloc } from './blocs/editor/ZoomBloc';
import { FullscreenBloc } from './blocs/editor/FullscreenBloc';
import { PanelBloc } from './blocs/editor/PanelBloc';
import { CropBloc } from './blocs/editor/CropBloc';
import { MasksBloc } from './blocs/editor/MasksBloc';
import { PresetsBloc } from './blocs/editor/PresetsBloc';
import { ExportBloc } from './blocs/editor/ExportBloc';
import { MetadataBloc } from './blocs/editor/MetadataBloc';
import { AIBloc } from './blocs/editor/AIBloc';

// Community bloc
import { CommunityBloc } from './blocs/community/CommunityBloc';

// Module registry functions
import { isModuleRegistered, getModule } from './modules/registry';

describe('Integration Tests', () => {
  describe('Bloc Instantiation', () => {
    it('should instantiate all app blocs without errors', () => {
      expect(() => new AppBloc()).not.toThrow();
      expect(() => new SettingsBloc()).not.toThrow();
      expect(() => new UIBloc()).not.toThrow();
      expect(() => new ModalBloc()).not.toThrow();
    });

    it('should instantiate all library blocs without errors', () => {
      expect(() => new LibraryBloc()).not.toThrow();
      expect(() => new FolderBloc()).not.toThrow();
      expect(() => new SelectionBloc()).not.toThrow();
      expect(() => new ThumbnailBloc()).not.toThrow();
      expect(() => new FilterBloc()).not.toThrow();
      expect(() => new SortBloc()).not.toThrow();
      expect(() => new SearchBloc()).not.toThrow();
      expect(() => new RatingsBloc()).not.toThrow();
    });

    it('should instantiate all editor blocs without errors', () => {
      expect(() => new EditorBloc()).not.toThrow();
      expect(() => new AdjustmentsBloc()).not.toThrow();
      expect(() => new HistoryBloc()).not.toThrow();
      expect(() => new PreviewBloc()).not.toThrow();
      expect(() => new ZoomBloc()).not.toThrow();
      expect(() => new FullscreenBloc()).not.toThrow();
      expect(() => new PanelBloc()).not.toThrow();
      expect(() => new CropBloc()).not.toThrow();
      expect(() => new MasksBloc()).not.toThrow();
      expect(() => new PresetsBloc()).not.toThrow();
      expect(() => new ExportBloc()).not.toThrow();
      expect(() => new MetadataBloc()).not.toThrow();
      expect(() => new AIBloc()).not.toThrow();
    });

    it('should instantiate community bloc without errors', () => {
      expect(() => new CommunityBloc()).not.toThrow();
    });
  });

  describe('Bloc Default States', () => {
    it('AppBloc should have correct default state', () => {
      const bloc = new AppBloc();
      expect(bloc.state.activeView).toBe('explore');
      expect(bloc.state.isInitialized).toBe(false);
      expect(bloc.state.isWindowFullScreen).toBe(false);
      expect(bloc.state.error).toBeNull();
    });

    it('LibraryBloc should have correct default state', () => {
      const bloc = new LibraryBloc();
      expect(bloc.state.rootPath).toBeNull();
      expect(bloc.state.images).toEqual([]);
      expect(bloc.state.isLoading).toBe(false);
    });

    it('EditorBloc should have correct default state', () => {
      const bloc = new EditorBloc();
      expect(bloc.state.selectedImage).toBeNull();
      expect(bloc.state.isLoading).toBe(false);
      expect(bloc.state.showOriginal).toBe(false);
    });

    it('SelectionBloc should have correct default state', () => {
      const bloc = new SelectionBloc();
      expect(bloc.state.selectedPaths).toEqual([]);
      expect(bloc.state.activePath).toBeNull();
      expect(bloc.state.anchorPath).toBeNull();
    });

    it('AdjustmentsBloc should have correct default state', () => {
      const bloc = new AdjustmentsBloc();
      expect(bloc.state.adjustments.exposure).toBe(0);
      expect(bloc.state.adjustments.contrast).toBe(0);
      expect(bloc.state.adjustments.highlights).toBe(0);
      expect(bloc.state.adjustments.shadows).toBe(0);
      expect(bloc.state.isDirty).toBe(false);
    });

    it('ZoomBloc should have correct default state', () => {
      const bloc = new ZoomBloc();
      expect(bloc.state.scale).toBe(1);
      expect(bloc.state.positionX).toBe(0);
      expect(bloc.state.positionY).toBe(0);
      expect(bloc.state.minScale).toBe(0.1);
      expect(bloc.state.maxScale).toBe(16);
    });

    it('HistoryBloc should have correct default state', () => {
      const bloc = new HistoryBloc();
      expect(bloc.state.entries).toEqual([]);
      expect(bloc.state.currentIndex).toBe(-1);
      expect(bloc.canUndo).toBe(false);
      expect(bloc.canRedo).toBe(false);
    });
  });

  describe('Inter-Bloc Communication Patterns', () => {
    let appBloc: AppBloc;
    let selectionBloc: SelectionBloc;
    let adjustmentsBloc: AdjustmentsBloc;
    let historyBloc: HistoryBloc;

    beforeEach(() => {
      appBloc = new AppBloc();
      selectionBloc = new SelectionBloc();
      adjustmentsBloc = new AdjustmentsBloc();
      historyBloc = new HistoryBloc();
    });

    it('should handle navigation flow from explore to edit', () => {
      expect(appBloc.state.activeView).toBe('explore');
      appBloc.navigateToEditor();
      expect(appBloc.state.activeView).toBe('edit');
    });

    it('should handle selection and navigation workflow', () => {
      selectionBloc.selectSingle('/path/to/image.cr2');
      expect(selectionBloc.state.selectedPaths).toContain('/path/to/image.cr2');

      appBloc.navigateToEditor();
      expect(appBloc.state.activeView).toBe('edit');
    });

    it('should track adjustments through history', () => {
      historyBloc.push('Initial', adjustmentsBloc.current);

      adjustmentsBloc.setExposure(0.5);
      historyBloc.push('Set exposure', adjustmentsBloc.current);

      expect(historyBloc.state.entries.length).toBe(2);
      expect(historyBloc.canUndo).toBe(true);
    });

    it('should handle multi-select workflow', () => {
      selectionBloc.selectSingle('/path/1.cr2');
      selectionBloc.toggleSelection('/path/2.cr2');
      selectionBloc.toggleSelection('/path/3.cr2');

      expect(selectionBloc.state.selectedPaths.length).toBe(3);
      expect(selectionBloc.isSelected('/path/2.cr2')).toBe(true);

      selectionBloc.toggleSelection('/path/2.cr2');
      expect(selectionBloc.state.selectedPaths.length).toBe(2);
      expect(selectionBloc.isSelected('/path/2.cr2')).toBe(false);
    });

    it('should handle undo/redo workflow', () => {
      historyBloc.push('Initial', adjustmentsBloc.current);

      adjustmentsBloc.setExposure(1);
      historyBloc.push('Exposure +1', adjustmentsBloc.current);

      adjustmentsBloc.setContrast(50);
      historyBloc.push('Contrast +50', adjustmentsBloc.current);

      expect(historyBloc.state.entries.length).toBe(3);
      expect(historyBloc.canUndo).toBe(true);
      expect(historyBloc.canRedo).toBe(false);

      const undoneState = historyBloc.undo();
      expect(undoneState).not.toBeNull();
      expect(historyBloc.canRedo).toBe(true);

      const redoneState = historyBloc.redo();
      expect(redoneState).not.toBeNull();
      expect(historyBloc.canRedo).toBe(false);
    });
  });

  describe('Module Registry', () => {
    const requiredModules = [
      'folder-tree',
      'gallery-grid',
      'gallery-controls',
      'filmstrip',
      'welcome-screen',
      'loading-spinner',
      'context-menu',
      'fullscreen-viewer',
      'image-preview',
      'editor-toolbar',
      'zoom-controls',
      'image-histogram',
      'image-waveform',
      'exposure-controls',
      'color-controls',
      'detail-controls',
      'effects-controls',
      'hsl-controls',
      'tone-curves',
      'lens-corrections',
      'adjustments-panel',
      'panel-switcher',
      'metadata-panel',
      'export-panel',
      'crop-panel',
      'masks-panel',
      'presets-panel',
      'ai-panel',
    ] as const;

    it.each(requiredModules)('should have module "%s" registered', (moduleId) => {
      expect(isModuleRegistered(moduleId)).toBe(true);
    });

    it('should return component for registered modules', () => {
      requiredModules.forEach((moduleId) => {
        const component = getModule(moduleId);
        expect(component).not.toBeNull();
      });
    });

    it('should return false for unknown modules', () => {
      expect(isModuleRegistered('unknown-module')).toBe(false);
    });
  });

  describe('Type Safety and Bounds', () => {
    it('ZoomBloc should respect zoom bounds', () => {
      const bloc = new ZoomBloc();

      bloc.setScale(1000);
      expect(bloc.state.scale).toBeLessThanOrEqual(bloc.state.maxScale);

      bloc.setScale(-10);
      expect(bloc.state.scale).toBeGreaterThanOrEqual(bloc.state.minScale);
    });

    it('HistoryBloc should respect max history length', () => {
      const bloc = new HistoryBloc(10);
      const adjustments = new AdjustmentsBloc().current;

      for (let i = 0; i < 20; i++) {
        bloc.push(`Entry ${i}`, adjustments);
      }

      expect(bloc.state.entries.length).toBeLessThanOrEqual(10);
    });

    it('AdjustmentsBloc rating should be clamped 0-5', () => {
      const bloc = new AdjustmentsBloc();

      bloc.setRating(10);
      expect(bloc.state.adjustments.rating).toBeLessThanOrEqual(5);

      bloc.setRating(-5);
      expect(bloc.state.adjustments.rating).toBeGreaterThanOrEqual(0);
    });
  });

  describe('State Immutability', () => {
    it('LibraryBloc should create new state on update', () => {
      const bloc = new LibraryBloc();
      const initialState = bloc.state;

      bloc.setViewMode('recursive');

      expect(bloc.state).not.toBe(initialState);
      expect(bloc.state.viewMode).toBe('recursive');
    });

    it('SelectionBloc should create new arrays on update', () => {
      const bloc = new SelectionBloc();

      bloc.selectSingle('/path/1.cr2');
      const afterFirstSelect = bloc.state.selectedPaths;

      bloc.toggleSelection('/path/2.cr2');

      expect(bloc.state.selectedPaths).not.toBe(afterFirstSelect);
    });

    it('AdjustmentsBloc should create new state on update', () => {
      const bloc = new AdjustmentsBloc();
      const initialState = bloc.state;
      const initialAdjustments = bloc.state.adjustments;

      bloc.setExposure(1);

      expect(bloc.state).not.toBe(initialState);
      expect(bloc.state.adjustments).not.toBe(initialAdjustments);
    });
  });

  describe('Reset and Clear Operations', () => {
    it('AdjustmentsBloc resetAll should restore defaults', () => {
      const bloc = new AdjustmentsBloc();
      const defaultExposure = bloc.state.adjustments.exposure;

      bloc.setExposure(2);
      bloc.setContrast(50);
      expect(bloc.state.adjustments.exposure).not.toBe(defaultExposure);

      bloc.resetAll();

      expect(bloc.state.adjustments.exposure).toBe(defaultExposure);
      expect(bloc.state.adjustments.contrast).toBe(0);
    });

    it('SelectionBloc clear should remove all selections', () => {
      const bloc = new SelectionBloc();

      bloc.selectSingle('/path/1.cr2');
      bloc.toggleSelection('/path/2.cr2');
      expect(bloc.state.selectedPaths.length).toBe(2);

      bloc.clearSelection();

      expect(bloc.state.selectedPaths.length).toBe(0);
    });

    it('HistoryBloc clear should reset history', () => {
      const bloc = new HistoryBloc();
      const adjustments = new AdjustmentsBloc().current;

      bloc.push('Entry 1', adjustments);
      bloc.push('Entry 2', adjustments);
      expect(bloc.state.entries.length).toBe(2);

      bloc.clear();

      expect(bloc.state.entries.length).toBe(0);
      expect(bloc.canUndo).toBe(false);
    });

    it('ZoomBloc reset should restore defaults', () => {
      const bloc = new ZoomBloc();

      bloc.setScale(5);
      bloc.setPosition(100, 200);

      bloc.reset();

      expect(bloc.state.scale).toBe(1);
      expect(bloc.state.positionX).toBe(0);
      expect(bloc.state.positionY).toBe(0);
    });
  });

  describe('Computed Properties', () => {
    it('SelectionBloc computed properties should work', () => {
      const bloc = new SelectionBloc();

      expect(bloc.hasSelection).toBe(false);
      expect(bloc.isSingleSelection).toBe(false);
      expect(bloc.selectionCount).toBe(0);

      bloc.selectSingle('/path/1.cr2');

      expect(bloc.hasSelection).toBe(true);
      expect(bloc.isSingleSelection).toBe(true);
      expect(bloc.selectionCount).toBe(1);

      bloc.toggleSelection('/path/2.cr2');

      expect(bloc.hasSelection).toBe(true);
      expect(bloc.isSingleSelection).toBe(false);
      expect(bloc.selectionCount).toBe(2);
    });

    it('ZoomBloc computed properties should work', () => {
      const bloc = new ZoomBloc();

      expect(bloc.zoomPercentage).toBe(100);
      expect(bloc.isActualSize).toBe(true);
      expect(bloc.canZoomIn).toBe(true);
      expect(bloc.canZoomOut).toBe(true);

      bloc.setScale(bloc.state.maxScale);
      expect(bloc.canZoomIn).toBe(false);

      bloc.setScale(bloc.state.minScale);
      expect(bloc.canZoomOut).toBe(false);
    });

    it('HistoryBloc computed properties should work', () => {
      const bloc = new HistoryBloc();
      const adjustments = new AdjustmentsBloc().current;

      expect(bloc.entryCount).toBe(0);
      expect(bloc.currentEntry).toBeNull();
      expect(bloc.undoLabel).toBeNull();

      bloc.push('First', adjustments);
      bloc.push('Second', adjustments);

      expect(bloc.entryCount).toBe(2);
      expect(bloc.currentEntry).not.toBeNull();
      expect(bloc.currentEntry?.label).toBe('Second');
      expect(bloc.undoLabel).toBe('Second');
    });

    it('LibraryBloc computed properties should work', () => {
      const bloc = new LibraryBloc();

      expect(bloc.hasFolder).toBe(false);
      expect(bloc.imageCount).toBe(0);
    });

    it('EditorBloc computed properties should work', () => {
      const bloc = new EditorBloc();

      expect(bloc.hasImage).toBe(false);
      expect(bloc.isReady).toBe(false);
      expect(bloc.imagePath).toBeNull();
      expect(bloc.imageSize).toBeNull();
    });
  });
});
