import { describe, it, expect, beforeEach } from 'vitest';
import { AppBloc, ViewId } from './AppBloc';

describe('AppBloc', () => {
  let bloc: AppBloc;

  beforeEach(() => {
    bloc = new AppBloc();
  });

  describe('initial state', () => {
    it('should have explore as the default active view', () => {
      expect(bloc.state.activeView).toBe('explore');
    });

    it('should not be fullscreen by default', () => {
      expect(bloc.state.isWindowFullScreen).toBe(false);
    });

    it('should not be initialized by default', () => {
      expect(bloc.state.isInitialized).toBe(false);
    });

    it('should have no error by default', () => {
      expect(bloc.state.error).toBeNull();
    });
  });

  describe('setActiveView', () => {
    it.each<ViewId>(['explore', 'edit', 'community'])(
      'should set active view to %s',
      (view) => {
        bloc.setActiveView(view);
        expect(bloc.state.activeView).toBe(view);
      }
    );
  });

  describe('navigation methods', () => {
    it('navigateToEditor should set active view to edit', () => {
      bloc.navigateToEditor();
      expect(bloc.state.activeView).toBe('edit');
    });

    it('navigateToLibrary should set active view to explore', () => {
      bloc.setActiveView('edit');
      bloc.navigateToLibrary();
      expect(bloc.state.activeView).toBe('explore');
    });

    it('navigateToCommunity should set active view to community', () => {
      bloc.navigateToCommunity();
      expect(bloc.state.activeView).toBe('community');
    });
  });

  describe('setWindowFullScreen', () => {
    it('should set fullscreen to true', () => {
      bloc.setWindowFullScreen(true);
      expect(bloc.state.isWindowFullScreen).toBe(true);
    });

    it('should set fullscreen to false', () => {
      bloc.setWindowFullScreen(true);
      bloc.setWindowFullScreen(false);
      expect(bloc.state.isWindowFullScreen).toBe(false);
    });
  });

  describe('initialize', () => {
    it('should set isInitialized to true on success', async () => {
      await bloc.initialize();
      expect(bloc.state.isInitialized).toBe(true);
    });

    it('should not have an error after successful initialization', async () => {
      await bloc.initialize();
      expect(bloc.state.error).toBeNull();
    });
  });

  describe('error handling', () => {
    it('setError should set the error message', () => {
      const errorMessage = 'Something went wrong';
      bloc.setError(errorMessage);
      expect(bloc.state.error).toBe(errorMessage);
    });

    it('setError with null should clear the error', () => {
      bloc.setError('Some error');
      bloc.setError(null);
      expect(bloc.state.error).toBeNull();
    });

    it('clearError should clear the error', () => {
      bloc.setError('Some error');
      bloc.clearError();
      expect(bloc.state.error).toBeNull();
    });
  });

  describe('state immutability', () => {
    it('should create new state object on each update', () => {
      const initialState = bloc.state;
      bloc.setActiveView('edit');
      expect(bloc.state).not.toBe(initialState);
    });

    it('should preserve unrelated state when updating', () => {
      bloc.setWindowFullScreen(true);
      bloc.setActiveView('edit');
      expect(bloc.state.isWindowFullScreen).toBe(true);
    });
  });
});
