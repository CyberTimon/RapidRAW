import { Cubit } from '@blac/core';

interface SelectionState {
  selectedPaths: string[];
  activePath: string | null;
  anchorPath: string | null;
}

export class SelectionBloc extends Cubit<SelectionState> {
  constructor() {
    super({
      selectedPaths: [],
      activePath: null,
      anchorPath: null,
    });
  }

  selectSingle = (path: string) => {
    this.emit({
      selectedPaths: [path],
      activePath: path,
      anchorPath: path,
    });
  };

  toggleSelection = (path: string) => {
    const isSelected = this.state.selectedPaths.includes(path);
    const newSelection = isSelected
      ? this.state.selectedPaths.filter((p) => p !== path)
      : [...this.state.selectedPaths, path];

    this.emit({
      selectedPaths: newSelection,
      activePath: path,
      anchorPath: isSelected ? this.state.anchorPath : path,
    });
  };

  selectRange = (path: string, allPaths: string[]) => {
    if (!this.state.anchorPath) {
      this.selectSingle(path);
      return;
    }

    const anchorIndex = allPaths.indexOf(this.state.anchorPath);
    const currentIndex = allPaths.indexOf(path);

    if (anchorIndex === -1 || currentIndex === -1) {
      this.selectSingle(path);
      return;
    }

    const start = Math.min(anchorIndex, currentIndex);
    const end = Math.max(anchorIndex, currentIndex);
    const rangePaths = allPaths.slice(start, end + 1);

    this.emit({
      ...this.state,
      selectedPaths: Array.from(new Set([...this.state.selectedPaths, ...rangePaths])),
      activePath: path,
    });
  };

  selectAll = (allPaths: string[]) => {
    this.emit({
      selectedPaths: allPaths,
      activePath: allPaths[allPaths.length - 1] || null,
      anchorPath: this.state.anchorPath,
    });
  };

  clearSelection = () => {
    this.emit({
      selectedPaths: [],
      activePath: null,
      anchorPath: null,
    });
  };

  handleClick = (
    path: string,
    modifiers: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
    allPaths: string[]
  ) => {
    const isCtrl = modifiers.ctrlKey || modifiers.metaKey;
    const isShift = modifiers.shiftKey;

    if (isShift && this.state.anchorPath) {
      this.selectRange(path, allPaths);
    } else if (isCtrl) {
      this.toggleSelection(path);
    } else {
      this.selectSingle(path);
    }
  };

  isSelected = (path: string): boolean => {
    return this.state.selectedPaths.includes(path);
  };

  get hasSelection(): boolean {
    return this.state.selectedPaths.length > 0;
  }

  get isSingleSelection(): boolean {
    return this.state.selectedPaths.length === 1;
  }

  get selectionCount(): number {
    return this.state.selectedPaths.length;
  }
}
