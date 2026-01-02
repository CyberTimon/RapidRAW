import { Cubit } from '@blac/core';
import { invoke } from '@tauri-apps/api/core';
import { Adjustments, COPYABLE_ADJUSTMENT_KEYS, INITIAL_ADJUSTMENTS, PasteMode } from '../utils/adjustments';
import { Invokes, AppSettings } from '../components/ui/AppProperties';

export interface ClipboardState {
  copiedFilePaths: string[];
  copiedAdjustments: Partial<Adjustments> | null;
  copiedSectionAdjustments: Partial<Adjustments> | null;
  isCopied: boolean;
  isPasted: boolean;
}

const INITIAL_STATE: ClipboardState = {
  copiedFilePaths: [],
  copiedAdjustments: null,
  copiedSectionAdjustments: null,
  isCopied: false,
  isPasted: false,
};

const FEEDBACK_TIMEOUT = 1000;

export class ClipboardCubit extends Cubit<ClipboardState> {
  private copyTimer: ReturnType<typeof setTimeout> | null = null;
  private pasteTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super(INITIAL_STATE);

    this.onSystemEvent('dispose', () => {
      if (this.copyTimer) clearTimeout(this.copyTimer);
      if (this.pasteTimer) clearTimeout(this.pasteTimer);
    });
  }

  setCopiedFilePaths = (paths: string[]) => {
    this.patch({ copiedFilePaths: paths });
  };

  setCopiedAdjustments = (adjustments: Partial<Adjustments> | null) => {
    this.patch({ copiedAdjustments: adjustments });
  };

  setCopiedSectionAdjustments = (adjustments: Partial<Adjustments> | null) => {
    this.patch({ copiedSectionAdjustments: adjustments });
  };

  clearCopiedFilePaths = () => {
    this.patch({ copiedFilePaths: [] });
  };

  copyAdjustments = (sourceAdjustments: Adjustments) => {
    const adjustmentsToCopy: Partial<Adjustments> = {};
    for (const key of COPYABLE_ADJUSTMENT_KEYS) {
      if (Object.prototype.hasOwnProperty.call(sourceAdjustments, key)) {
        (adjustmentsToCopy as any)[key] = sourceAdjustments[key as keyof Adjustments];
      }
    }
    this.patch({ copiedAdjustments: adjustmentsToCopy });
    this.showCopiedFeedback();
  };

  pasteAdjustments = async (
    targetPaths: string[],
    appSettings: AppSettings,
    currentAdjustments?: Adjustments,
    setAdjustments?: (adj: Adjustments) => void
  ): Promise<Partial<Adjustments> | null> => {
    const { copiedAdjustments } = this.state;
    if (!copiedAdjustments || !appSettings) {
      return null;
    }

    const { mode, includedAdjustments } = appSettings.copyPasteSettings;
    const adjustmentsToApply: Partial<Adjustments> = {};

    for (const key of includedAdjustments) {
      if (Object.prototype.hasOwnProperty.call(copiedAdjustments, key)) {
        const value = copiedAdjustments[key as keyof Adjustments];

        if (mode === PasteMode.Merge) {
          const defaultValue = INITIAL_ADJUSTMENTS[key as keyof Adjustments];
          if (JSON.stringify(value) !== JSON.stringify(defaultValue)) {
            (adjustmentsToApply as any)[key] = value;
          }
        } else {
          (adjustmentsToApply as any)[key] = value;
        }
      }
    }

    if (Object.keys(adjustmentsToApply).length === 0) {
      this.showPastedFeedback();
      return null;
    }

    if (targetPaths.length === 0) {
      return null;
    }

    if (currentAdjustments && setAdjustments) {
      const newAdjustments = { ...currentAdjustments, ...adjustmentsToApply };
      setAdjustments(newAdjustments as Adjustments);
    }

    try {
      await invoke(Invokes.ApplyAdjustmentsToPaths, {
        paths: targetPaths,
        adjustments: adjustmentsToApply,
      });
    } catch (err) {
      console.error('Failed to paste adjustments to multiple images:', err);
      throw err;
    }

    this.showPastedFeedback();
    return adjustmentsToApply;
  };

  pasteFiles = async (destinationFolder: string, mode: 'copy' | 'move' = 'copy') => {
    const { copiedFilePaths } = this.state;
    if (copiedFilePaths.length === 0 || !destinationFolder) {
      return;
    }

    try {
      if (mode === 'copy') {
        await invoke(Invokes.CopyFiles, {
          sourcePaths: copiedFilePaths,
          destinationFolder,
        });
      } else {
        await invoke(Invokes.MoveFiles, {
          sourcePaths: copiedFilePaths,
          destinationFolder,
        });
        this.clearCopiedFilePaths();
      }
    } catch (err) {
      console.error(`Failed to ${mode} files:`, err);
      throw err;
    }
  };

  private showCopiedFeedback = () => {
    if (this.copyTimer) clearTimeout(this.copyTimer);
    this.patch({ isCopied: true });
    this.copyTimer = setTimeout(() => {
      this.patch({ isCopied: false });
    }, FEEDBACK_TIMEOUT);
  };

  private showPastedFeedback = () => {
    if (this.pasteTimer) clearTimeout(this.pasteTimer);
    this.patch({ isPasted: true });
    this.pasteTimer = setTimeout(() => {
      this.patch({ isPasted: false });
    }, FEEDBACK_TIMEOUT);
  };
}
