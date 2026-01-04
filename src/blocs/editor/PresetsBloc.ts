import { Cubit } from '@blac/core';
import type { Adjustments } from '../../types/adjustments.js';
import { INITIAL_ADJUSTMENTS } from '../../types/adjustments.js';

export interface Preset {
  id: string;
  name: string;
  adjustments: Partial<Adjustments>;
  createdAt: number;
  updatedAt: number;
}

export interface PresetFolder {
  id: string;
  name: string;
  children: (Preset | PresetFolder)[];
  isFolder: true;
}

export type PresetItem = Preset | PresetFolder;

export function isPresetFolder(item: PresetItem): item is PresetFolder {
  return 'isFolder' in item && item.isFolder === true;
}

interface PresetsState {
  presets: PresetItem[];
  expandedFolders: Set<string>;
  isLoading: boolean;
  activePreviewId: string | null;
  previewUrls: Record<string, string>;
  isGeneratingPreviews: boolean;
}

const INITIAL_PRESETS_STATE: PresetsState = {
  presets: [],
  expandedFolders: new Set(),
  isLoading: false,
  activePreviewId: null,
  previewUrls: {},
  isGeneratingPreviews: false,
};

let presetIdCounter = 0;
const generateId = () => `preset-${Date.now()}-${++presetIdCounter}`;

export class PresetsBloc extends Cubit<PresetsState> {
  constructor() {
    super({ ...INITIAL_PRESETS_STATE });
  }

  setLoading = (isLoading: boolean) => {
    this.emit({ ...this.state, isLoading });
  };

  loadPresets = (presets: PresetItem[]) => {
    this.emit({
      ...this.state,
      presets,
      isLoading: false,
    });
  };

  addPreset = (name: string, adjustments: Partial<Adjustments>): Preset => {
    const now = Date.now();
    const newPreset: Preset = {
      id: generateId(),
      name,
      adjustments,
      createdAt: now,
      updatedAt: now,
    };

    this.emit({
      ...this.state,
      presets: [...this.state.presets, newPreset],
    });

    return newPreset;
  };

  addFolder = (name: string): PresetFolder => {
    const newFolder: PresetFolder = {
      id: generateId(),
      name,
      children: [],
      isFolder: true,
    };

    this.emit({
      ...this.state,
      presets: [...this.state.presets, newFolder],
    });

    return newFolder;
  };

  private findAndUpdateItem = (
    items: PresetItem[],
    id: string,
    updater: (item: PresetItem) => PresetItem | null
  ): PresetItem[] => {
    return items
      .map((item) => {
        if (item.id === id) {
          return updater(item);
        }
        if (isPresetFolder(item)) {
          return {
            ...item,
            children: this.findAndUpdateItem(item.children, id, updater),
          };
        }
        return item;
      })
      .filter((item): item is PresetItem => item !== null);
  };

  renameItem = (id: string, newName: string) => {
    this.emit({
      ...this.state,
      presets: this.findAndUpdateItem(this.state.presets, id, (item) => ({
        ...item,
        name: newName,
        ...(isPresetFolder(item) ? {} : { updatedAt: Date.now() }),
      })),
    });
  };

  updatePreset = (id: string, adjustments: Partial<Adjustments>) => {
    this.emit({
      ...this.state,
      presets: this.findAndUpdateItem(this.state.presets, id, (item) => {
        if (isPresetFolder(item)) return item;
        return {
          ...item,
          adjustments,
          updatedAt: Date.now(),
        };
      }),
    });
  };

  deleteItem = (id: string) => {
    this.emit({
      ...this.state,
      presets: this.findAndUpdateItem(this.state.presets, id, () => null),
    });
  };

  duplicatePreset = (id: string): Preset | null => {
    let duplicated: Preset | null = null;

    const findPreset = (items: PresetItem[]): Preset | null => {
      for (const item of items) {
        if (item.id === id && !isPresetFolder(item)) {
          return item;
        }
        if (isPresetFolder(item)) {
          const found = findPreset(item.children);
          if (found) return found;
        }
      }
      return null;
    };

    const original = findPreset(this.state.presets);
    if (!original) return null;

    const now = Date.now();
    duplicated = {
      id: generateId(),
      name: `${original.name} Copy`,
      adjustments: JSON.parse(JSON.stringify(original.adjustments)),
      createdAt: now,
      updatedAt: now,
    };

    this.emit({
      ...this.state,
      presets: [...this.state.presets, duplicated],
    });

    return duplicated;
  };

  moveToFolder = (itemId: string, targetFolderId: string | null) => {
    let movedItem: PresetItem | null = null;

    const removeItem = (items: PresetItem[]): PresetItem[] => {
      return items.filter((item) => {
        if (item.id === itemId) {
          movedItem = item;
          return false;
        }
        if (isPresetFolder(item)) {
          item.children = removeItem(item.children);
        }
        return true;
      });
    };

    const updatedPresets = removeItem([...this.state.presets]);

    if (!movedItem) return;

    if (targetFolderId === null) {
      updatedPresets.push(movedItem);
    } else {
      const addToFolder = (items: PresetItem[]): PresetItem[] => {
        return items.map((item) => {
          if (item.id === targetFolderId && isPresetFolder(item)) {
            return {
              ...item,
              children: [...item.children, movedItem!],
            };
          }
          if (isPresetFolder(item)) {
            return {
              ...item,
              children: addToFolder(item.children),
            };
          }
          return item;
        });
      };

      this.emit({
        ...this.state,
        presets: addToFolder(updatedPresets),
      });
      return;
    }

    this.emit({
      ...this.state,
      presets: updatedPresets,
    });
  };

  toggleFolderExpanded = (folderId: string) => {
    const expanded = new Set(this.state.expandedFolders);
    if (expanded.has(folderId)) {
      expanded.delete(folderId);
    } else {
      expanded.add(folderId);
    }
    this.emit({
      ...this.state,
      expandedFolders: expanded,
    });
  };

  setPreviewUrl = (presetId: string, url: string) => {
    this.emit({
      ...this.state,
      previewUrls: {
        ...this.state.previewUrls,
        [presetId]: url,
      },
    });
  };

  clearPreviewUrls = () => {
    Object.values(this.state.previewUrls).forEach((url) => {
      if (url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
      }
    });
    this.emit({
      ...this.state,
      previewUrls: {},
    });
  };

  setIsGeneratingPreviews = (isGenerating: boolean) => {
    this.emit({
      ...this.state,
      isGeneratingPreviews: isGenerating,
    });
  };

  sortAlphabetically = () => {
    const sortItems = (items: PresetItem[]): PresetItem[] => {
      const sorted = [...items].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      );
      return sorted.map((item) => {
        if (isPresetFolder(item)) {
          return {
            ...item,
            children: sortItems(item.children),
          };
        }
        return item;
      });
    };

    this.emit({
      ...this.state,
      presets: sortItems(this.state.presets),
    });
  };

  getAllPresets = (): Preset[] => {
    const collect = (items: PresetItem[]): Preset[] => {
      return items.flatMap((item) => {
        if (isPresetFolder(item)) {
          return collect(item.children);
        }
        return [item];
      });
    };
    return collect(this.state.presets);
  };

  getRootPresets = (): Preset[] => {
    return this.state.presets.filter(
      (item): item is Preset => !isPresetFolder(item)
    );
  };

  getFolders = (): PresetFolder[] => {
    return this.state.presets.filter(isPresetFolder);
  };

  reset = () => {
    this.clearPreviewUrls();
    this.emit({ ...INITIAL_PRESETS_STATE });
  };
}
