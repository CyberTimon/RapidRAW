import { describe, it, expect, beforeEach } from 'vitest';
import { SelectionBloc } from './SelectionBloc';

describe('SelectionBloc', () => {
  let bloc: SelectionBloc;
  const allPaths = ['/img/a.jpg', '/img/b.jpg', '/img/c.jpg', '/img/d.jpg', '/img/e.jpg'];

  beforeEach(() => {
    bloc = new SelectionBloc();
  });

  describe('initial state', () => {
    it('should have empty selection', () => {
      expect(bloc.state.selectedPaths).toEqual([]);
      expect(bloc.state.activePath).toBeNull();
      expect(bloc.state.anchorPath).toBeNull();
    });

    it('hasSelection should be false', () => {
      expect(bloc.hasSelection).toBe(false);
    });
  });

  describe('selectSingle', () => {
    it('should select a single path', () => {
      bloc.selectSingle('/img/a.jpg');
      expect(bloc.state.selectedPaths).toEqual(['/img/a.jpg']);
      expect(bloc.state.activePath).toBe('/img/a.jpg');
      expect(bloc.state.anchorPath).toBe('/img/a.jpg');
    });

    it('should replace existing selection', () => {
      bloc.selectSingle('/img/a.jpg');
      bloc.selectSingle('/img/b.jpg');
      expect(bloc.state.selectedPaths).toEqual(['/img/b.jpg']);
    });
  });

  describe('toggleSelection', () => {
    it('should add to selection when not selected', () => {
      bloc.selectSingle('/img/a.jpg');
      bloc.toggleSelection('/img/b.jpg');
      expect(bloc.state.selectedPaths).toContain('/img/a.jpg');
      expect(bloc.state.selectedPaths).toContain('/img/b.jpg');
    });

    it('should remove from selection when already selected', () => {
      bloc.selectSingle('/img/a.jpg');
      bloc.toggleSelection('/img/b.jpg');
      bloc.toggleSelection('/img/a.jpg');
      expect(bloc.state.selectedPaths).toEqual(['/img/b.jpg']);
    });

    it('should update activePath to toggled path', () => {
      bloc.selectSingle('/img/a.jpg');
      bloc.toggleSelection('/img/b.jpg');
      expect(bloc.state.activePath).toBe('/img/b.jpg');
    });
  });

  describe('selectRange', () => {
    it('should select range from anchor to target', () => {
      bloc.selectSingle('/img/b.jpg');
      bloc.selectRange('/img/d.jpg', allPaths);
      expect(bloc.state.selectedPaths).toContain('/img/b.jpg');
      expect(bloc.state.selectedPaths).toContain('/img/c.jpg');
      expect(bloc.state.selectedPaths).toContain('/img/d.jpg');
    });

    it('should work in reverse direction', () => {
      bloc.selectSingle('/img/d.jpg');
      bloc.selectRange('/img/b.jpg', allPaths);
      expect(bloc.state.selectedPaths).toContain('/img/b.jpg');
      expect(bloc.state.selectedPaths).toContain('/img/c.jpg');
      expect(bloc.state.selectedPaths).toContain('/img/d.jpg');
    });

    it('should fall back to selectSingle if no anchor', () => {
      bloc.selectRange('/img/c.jpg', allPaths);
      expect(bloc.state.selectedPaths).toEqual(['/img/c.jpg']);
    });

    it('should add to existing selection', () => {
      bloc.selectSingle('/img/a.jpg');
      bloc.toggleSelection('/img/e.jpg');
      bloc.selectRange('/img/c.jpg', allPaths);
      expect(bloc.state.selectedPaths).toContain('/img/a.jpg');
      expect(bloc.state.selectedPaths).toContain('/img/c.jpg');
      expect(bloc.state.selectedPaths).toContain('/img/d.jpg');
      expect(bloc.state.selectedPaths).toContain('/img/e.jpg');
    });
  });

  describe('selectAll', () => {
    it('should select all paths', () => {
      bloc.selectAll(allPaths);
      expect(bloc.state.selectedPaths).toEqual(allPaths);
    });

    it('should set activePath to last item', () => {
      bloc.selectAll(allPaths);
      expect(bloc.state.activePath).toBe('/img/e.jpg');
    });
  });

  describe('clearSelection', () => {
    it('should clear all selection state', () => {
      bloc.selectAll(allPaths);
      bloc.clearSelection();
      expect(bloc.state.selectedPaths).toEqual([]);
      expect(bloc.state.activePath).toBeNull();
      expect(bloc.state.anchorPath).toBeNull();
    });
  });

  describe('handleClick', () => {
    it('should select single on plain click', () => {
      bloc.handleClick('/img/b.jpg', { ctrlKey: false, metaKey: false, shiftKey: false }, allPaths);
      expect(bloc.state.selectedPaths).toEqual(['/img/b.jpg']);
    });

    it('should toggle on ctrl+click', () => {
      bloc.selectSingle('/img/a.jpg');
      bloc.handleClick('/img/b.jpg', { ctrlKey: true, metaKey: false, shiftKey: false }, allPaths);
      expect(bloc.state.selectedPaths).toContain('/img/a.jpg');
      expect(bloc.state.selectedPaths).toContain('/img/b.jpg');
    });

    it('should toggle on meta+click (Mac)', () => {
      bloc.selectSingle('/img/a.jpg');
      bloc.handleClick('/img/b.jpg', { ctrlKey: false, metaKey: true, shiftKey: false }, allPaths);
      expect(bloc.state.selectedPaths).toContain('/img/a.jpg');
      expect(bloc.state.selectedPaths).toContain('/img/b.jpg');
    });

    it('should select range on shift+click', () => {
      bloc.selectSingle('/img/a.jpg');
      bloc.handleClick('/img/c.jpg', { ctrlKey: false, metaKey: false, shiftKey: true }, allPaths);
      expect(bloc.state.selectedPaths).toEqual(['/img/a.jpg', '/img/b.jpg', '/img/c.jpg']);
    });
  });

  describe('getters', () => {
    it('isSingleSelection should return true for single selection', () => {
      bloc.selectSingle('/img/a.jpg');
      expect(bloc.isSingleSelection).toBe(true);
    });

    it('isSingleSelection should return false for multi-selection', () => {
      bloc.selectSingle('/img/a.jpg');
      bloc.toggleSelection('/img/b.jpg');
      expect(bloc.isSingleSelection).toBe(false);
    });

    it('selectionCount should return correct count', () => {
      bloc.selectAll(allPaths);
      expect(bloc.selectionCount).toBe(5);
    });

    it('isSelected should check if path is selected', () => {
      bloc.selectSingle('/img/a.jpg');
      expect(bloc.isSelected('/img/a.jpg')).toBe(true);
      expect(bloc.isSelected('/img/b.jpg')).toBe(false);
    });
  });
});
