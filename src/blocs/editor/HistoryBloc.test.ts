import { describe, it, expect, beforeEach } from 'vitest';
import { HistoryBloc } from './HistoryBloc';
import { INITIAL_ADJUSTMENTS } from '../../types/adjustments';
import type { Adjustments } from '../../types/adjustments';

describe('HistoryBloc', () => {
  let bloc: HistoryBloc;

  const createAdjustments = (exposure: number): Adjustments => ({
    ...INITIAL_ADJUSTMENTS,
    exposure,
  });

  beforeEach(() => {
    bloc = new HistoryBloc();
  });

  describe('initial state', () => {
    it('should have empty entries', () => {
      expect(bloc.state.entries).toEqual([]);
      expect(bloc.state.currentIndex).toBe(-1);
    });

    it('should not allow undo or redo', () => {
      expect(bloc.canUndo).toBe(false);
      expect(bloc.canRedo).toBe(false);
    });
  });

  describe('push', () => {
    it('should add entry to history', () => {
      const adj = createAdjustments(0.5);
      bloc.push('Set exposure', adj);
      expect(bloc.state.entries.length).toBe(1);
      expect(bloc.state.currentIndex).toBe(0);
    });

    it('should clone adjustments to prevent mutation', () => {
      const adj = createAdjustments(0.5);
      bloc.push('Set exposure', adj);
      adj.exposure = 1.0;
      expect(bloc.state.entries[0].adjustments.exposure).toBe(0.5);
    });

    it('should discard redo history when pushing new entry', () => {
      bloc.push('Entry 1', createAdjustments(0.1));
      bloc.push('Entry 2', createAdjustments(0.2));
      bloc.push('Entry 3', createAdjustments(0.3));
      bloc.undo();
      bloc.undo();
      bloc.push('Entry 4', createAdjustments(0.4));
      expect(bloc.state.entries.length).toBe(2);
      expect(bloc.state.entries[1].label).toBe('Entry 4');
    });

    it('should respect maxEntries limit', () => {
      const smallBloc = new HistoryBloc(3);
      smallBloc.push('Entry 1', createAdjustments(0.1));
      smallBloc.push('Entry 2', createAdjustments(0.2));
      smallBloc.push('Entry 3', createAdjustments(0.3));
      smallBloc.push('Entry 4', createAdjustments(0.4));
      expect(smallBloc.state.entries.length).toBe(3);
      expect(smallBloc.state.entries[0].label).toBe('Entry 2');
    });
  });

  describe('undo', () => {
    it('should return previous adjustments', () => {
      bloc.push('Initial', createAdjustments(0));
      bloc.push('Set exposure', createAdjustments(0.5));
      const result = bloc.undo();
      expect(result?.exposure).toBe(0);
      expect(bloc.state.currentIndex).toBe(0);
    });

    it('should return null when at beginning', () => {
      bloc.push('Initial', createAdjustments(0));
      const result = bloc.undo();
      expect(result).toBeNull();
    });

    it('should enable redo after undo', () => {
      bloc.push('Initial', createAdjustments(0));
      bloc.push('Change', createAdjustments(0.5));
      bloc.undo();
      expect(bloc.canRedo).toBe(true);
    });
  });

  describe('redo', () => {
    it('should return next adjustments', () => {
      bloc.push('Initial', createAdjustments(0));
      bloc.push('Set exposure', createAdjustments(0.5));
      bloc.undo();
      const result = bloc.redo();
      expect(result?.exposure).toBe(0.5);
      expect(bloc.state.currentIndex).toBe(1);
    });

    it('should return null when at end', () => {
      bloc.push('Initial', createAdjustments(0));
      const result = bloc.redo();
      expect(result).toBeNull();
    });
  });

  describe('goTo', () => {
    it('should jump to specific index', () => {
      bloc.push('Entry 0', createAdjustments(0));
      bloc.push('Entry 1', createAdjustments(0.1));
      bloc.push('Entry 2', createAdjustments(0.2));
      const result = bloc.goTo(0);
      expect(result?.exposure).toBe(0);
      expect(bloc.state.currentIndex).toBe(0);
    });

    it('should return null for invalid index', () => {
      bloc.push('Entry', createAdjustments(0));
      expect(bloc.goTo(-1)).toBeNull();
      expect(bloc.goTo(5)).toBeNull();
    });
  });

  describe('goToEntry', () => {
    it('should jump to entry by id', () => {
      bloc.push('Entry 0', createAdjustments(0));
      bloc.push('Entry 1', createAdjustments(0.1));
      const entryId = bloc.state.entries[0].id;
      const result = bloc.goToEntry(entryId);
      expect(result?.exposure).toBe(0);
    });

    it('should return null for unknown id', () => {
      bloc.push('Entry', createAdjustments(0));
      expect(bloc.goToEntry('unknown-id')).toBeNull();
    });
  });

  describe('initialize', () => {
    it('should clear and push initial entry', () => {
      bloc.push('Old', createAdjustments(0.5));
      bloc.push('Older', createAdjustments(0.6));
      bloc.initialize('Initial', createAdjustments(0));
      expect(bloc.state.entries.length).toBe(1);
      expect(bloc.state.entries[0].label).toBe('Initial');
    });
  });

  describe('clear', () => {
    it('should reset history state', () => {
      bloc.push('Entry 1', createAdjustments(0.1));
      bloc.push('Entry 2', createAdjustments(0.2));
      bloc.clear();
      expect(bloc.state.entries).toEqual([]);
      expect(bloc.state.currentIndex).toBe(-1);
    });
  });

  describe('getters', () => {
    it('currentEntry should return current entry', () => {
      bloc.push('Test', createAdjustments(0.5));
      expect(bloc.currentEntry?.label).toBe('Test');
    });

    it('undoLabel should return label of current entry', () => {
      bloc.push('Initial', createAdjustments(0));
      bloc.push('Change', createAdjustments(0.5));
      expect(bloc.undoLabel).toBe('Change');
    });

    it('redoLabel should return label of next entry', () => {
      bloc.push('Initial', createAdjustments(0));
      bloc.push('Change', createAdjustments(0.5));
      bloc.undo();
      expect(bloc.redoLabel).toBe('Change');
    });

    it('historyList should return formatted list', () => {
      bloc.push('Entry 1', createAdjustments(0.1));
      bloc.push('Entry 2', createAdjustments(0.2));
      const list = bloc.historyList;
      expect(list.length).toBe(2);
      expect(list[1].isCurrent).toBe(true);
    });

    it('entryCount should return number of entries', () => {
      bloc.push('Entry 1', createAdjustments(0.1));
      bloc.push('Entry 2', createAdjustments(0.2));
      expect(bloc.entryCount).toBe(2);
    });
  });
});
