import { Cubit } from '@blac/core';
import type { Adjustments } from '../../types/adjustments';

export type AdjustmentCategory =
  | 'basic'
  | 'color'
  | 'presence'
  | 'detail'
  | 'effects'
  | 'curves'
  | 'hsl'
  | 'splitToning'
  | 'lensCorrections'
  | 'transform';

export interface CopiedAdjustments {
  adjustments: Partial<Adjustments>;
  sourcePath: string;
  timestamp: number;
  categories: AdjustmentCategory[];
}

interface ClipboardState {
  copiedAdjustments: CopiedAdjustments | null;
  copiedFilePaths: string[];
  lastOperation: 'copy' | 'cut' | null;
}

const CATEGORY_KEYS: Record<AdjustmentCategory, (keyof Adjustments)[]> = {
  basic: ['exposure', 'brightness', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'toneMapper'],
  color: ['temperature', 'tint', 'saturation', 'vibrance'],
  presence: ['clarity', 'dehaze', 'texture'],
  detail: ['sharpness', 'noiseReduction', 'colorNoiseReduction'],
  effects: ['vignette', 'grain'],
  curves: ['curves'],
  hsl: ['hsl'],
  splitToning: ['splitToning'],
  lensCorrections: ['lensCorrections'],
  transform: ['crop', 'rotation', 'flipHorizontal', 'flipVertical', 'straighten'],
};

export class ClipboardService extends Cubit<ClipboardState> {
  constructor() {
    super({
      copiedAdjustments: null,
      copiedFilePaths: [],
      lastOperation: null,
    });
  }

  copyAdjustments = (
    adjustments: Adjustments,
    sourcePath: string,
    categories?: AdjustmentCategory[]
  ) => {
    const categoriesToCopy = categories ?? (Object.keys(CATEGORY_KEYS) as AdjustmentCategory[]);
    const partialAdjustments: Partial<Adjustments> = {};

    categoriesToCopy.forEach((category) => {
      const keys = CATEGORY_KEYS[category];
      keys.forEach((key) => {
        const value = adjustments[key];
        if (value !== undefined) {
          (partialAdjustments as Record<string, unknown>)[key] = this.deepClone(value);
        }
      });
    });

    this.patch({
      copiedAdjustments: {
        adjustments: partialAdjustments,
        sourcePath,
        timestamp: Date.now(),
        categories: categoriesToCopy,
      },
    });
  };

  pasteAdjustments = (
    targetAdjustments: Adjustments,
    categories?: AdjustmentCategory[]
  ): Adjustments | null => {
    const { copiedAdjustments } = this.state;
    if (!copiedAdjustments) return null;

    const categoriesToPaste = categories ?? copiedAdjustments.categories;
    const result = { ...targetAdjustments };

    categoriesToPaste.forEach((category) => {
      const keys = CATEGORY_KEYS[category];
      keys.forEach((key) => {
        const value = (copiedAdjustments.adjustments as Record<string, unknown>)[key];
        if (value !== undefined) {
          (result as Record<string, unknown>)[key] = this.deepClone(value);
        }
      });
    });

    return result;
  };

  clearAdjustments = () => {
    this.patch({ copiedAdjustments: null });
  };

  copyFilePaths = (paths: string[], operation: 'copy' | 'cut' = 'copy') => {
    this.patch({
      copiedFilePaths: [...paths],
      lastOperation: operation,
    });
  };

  cutFilePaths = (paths: string[]) => {
    this.copyFilePaths(paths, 'cut');
  };

  clearFilePaths = () => {
    this.patch({
      copiedFilePaths: [],
      lastOperation: null,
    });
  };

  get hasCopiedAdjustments(): boolean {
    return this.state.copiedAdjustments !== null;
  }

  get hasCopiedFiles(): boolean {
    return this.state.copiedFilePaths.length > 0;
  }

  get isCutOperation(): boolean {
    return this.state.lastOperation === 'cut';
  }

  get copiedCategories(): AdjustmentCategory[] {
    return this.state.copiedAdjustments?.categories ?? [];
  }

  private deepClone = <T>(value: T): T => {
    if (value === null || typeof value !== 'object') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.deepClone(item)) as T;
    }
    const result: Record<string, unknown> = {};
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        result[key] = this.deepClone((value as Record<string, unknown>)[key]);
      }
    }
    return result as T;
  };
}
