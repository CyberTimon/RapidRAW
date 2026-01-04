import { Cubit } from '@blac/core';
import type { Adjustments } from '../../types/adjustments.js';

interface HistoryEntry {
  id: string;
  timestamp: number;
  label: string;
  adjustments: Adjustments;
}

interface HistoryState {
  entries: HistoryEntry[];
  currentIndex: number;
  maxEntries: number;
}

export class HistoryBloc extends Cubit<HistoryState> {
  constructor(maxEntries = 50) {
    super({
      entries: [],
      currentIndex: -1,
      maxEntries,
    });
  }

  private generateId = (): string => {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  };

  push = (label: string, adjustments: Adjustments) => {
    const { entries, currentIndex, maxEntries } = this.state;

    // Remove any entries after current index (redo history)
    const newEntries = entries.slice(0, currentIndex + 1);

    const entry: HistoryEntry = {
      id: this.generateId(),
      timestamp: Date.now(),
      label,
      adjustments: structuredClone(adjustments),
    };

    newEntries.push(entry);

    // Trim to max entries
    while (newEntries.length > maxEntries) {
      newEntries.shift();
    }

    this.emit({
      ...this.state,
      entries: newEntries,
      currentIndex: newEntries.length - 1,
    });
  };

  undo = (): Adjustments | null => {
    const { entries, currentIndex } = this.state;

    if (currentIndex <= 0) {
      return null;
    }

    const newIndex = currentIndex - 1;
    this.patch({ currentIndex: newIndex });

    return structuredClone(entries[newIndex].adjustments);
  };

  redo = (): Adjustments | null => {
    const { entries, currentIndex } = this.state;

    if (currentIndex >= entries.length - 1) {
      return null;
    }

    const newIndex = currentIndex + 1;
    this.patch({ currentIndex: newIndex });

    return structuredClone(entries[newIndex].adjustments);
  };

  goTo = (index: number): Adjustments | null => {
    const { entries } = this.state;

    if (index < 0 || index >= entries.length) {
      return null;
    }

    this.patch({ currentIndex: index });
    return structuredClone(entries[index].adjustments);
  };

  goToEntry = (id: string): Adjustments | null => {
    const index = this.state.entries.findIndex((e) => e.id === id);
    return this.goTo(index);
  };

  clear = () => {
    this.emit({
      entries: [],
      currentIndex: -1,
      maxEntries: this.state.maxEntries,
    });
  };

  initialize = (label: string, adjustments: Adjustments) => {
    this.clear();
    this.push(label, adjustments);
  };

  get canUndo(): boolean {
    return this.state.currentIndex > 0;
  }

  get canRedo(): boolean {
    return this.state.currentIndex < this.state.entries.length - 1;
  }

  get currentEntry(): HistoryEntry | null {
    const { entries, currentIndex } = this.state;
    return entries[currentIndex] || null;
  }

  get undoLabel(): string | null {
    const { entries, currentIndex } = this.state;
    if (currentIndex <= 0) return null;
    return entries[currentIndex].label;
  }

  get redoLabel(): string | null {
    const { entries, currentIndex } = this.state;
    if (currentIndex >= entries.length - 1) return null;
    return entries[currentIndex + 1].label;
  }

  get historyList(): Array<{ id: string; label: string; isCurrent: boolean }> {
    return this.state.entries.map((entry, index) => ({
      id: entry.id,
      label: entry.label,
      isCurrent: index === this.state.currentIndex,
    }));
  }

  get entryCount(): number {
    return this.state.entries.length;
  }
}
