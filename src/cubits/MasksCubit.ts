import { Cubit } from '@blac/core';
import { BrushSettings } from '../components/ui/AppProperties';
import { MaskContainer, INITIAL_MASK_ADJUSTMENTS } from '../utils/adjustments';
import { SubMask, ToolType } from '../components/panel/right/Masks';
import { v4 as uuidv4 } from 'uuid';

export interface MasksState {
  activeMaskContainerId: string | null;
  activeMaskId: string | null;
  activeAiPatchContainerId: string | null;
  activeAiSubMaskId: string | null;
  brushSettings: BrushSettings;
  copiedMask: MaskContainer | null;
  isGeneratingAiMask: boolean;
  isMaskControlHovered: boolean;
}

const defaultBrushSettings: BrushSettings = {
  size: 50,
  feather: 50,
  tool: ToolType.Brush,
};

const defaultState: MasksState = {
  activeMaskContainerId: null,
  activeMaskId: null,
  activeAiPatchContainerId: null,
  activeAiSubMaskId: null,
  brushSettings: defaultBrushSettings,
  copiedMask: null,
  isGeneratingAiMask: false,
  isMaskControlHovered: false,
};

export class MasksCubit extends Cubit<MasksState> {
  constructor() {
    super(defaultState);
  }

  // Active mask management
  setActiveMaskContainer = (containerId: string | null) => {
    this.patch({ activeMaskContainerId: containerId });
  };

  setActiveMask = (maskId: string | null) => {
    this.patch({ activeMaskId: maskId });
  };

  setActiveMaskAndContainer = (containerId: string | null, maskId: string | null) => {
    this.patch({
      activeMaskContainerId: containerId,
      activeMaskId: maskId,
    });
  };

  clearActiveMask = () => {
    this.patch({
      activeMaskContainerId: null,
      activeMaskId: null,
    });
  };

  // Active AI patch management
  setActiveAiPatchContainer = (containerId: string | null) => {
    this.patch({ activeAiPatchContainerId: containerId });
  };

  setActiveAiSubMask = (subMaskId: string | null) => {
    this.patch({ activeAiSubMaskId: subMaskId });
  };

  setActiveAiPatchAndSubMask = (containerId: string | null, subMaskId: string | null) => {
    this.patch({
      activeAiPatchContainerId: containerId,
      activeAiSubMaskId: subMaskId,
    });
  };

  clearActiveAiPatch = () => {
    this.patch({
      activeAiPatchContainerId: null,
      activeAiSubMaskId: null,
    });
  };

  // Brush settings
  setBrushSettings = (settings: BrushSettings) => {
    this.patch({ brushSettings: settings });
  };

  updateBrushSettings = (updates: Partial<BrushSettings>) => {
    this.update((state) => ({
      ...state,
      brushSettings: { ...state.brushSettings, ...updates },
    }));
  };

  setBrushSize = (size: number) => {
    this.updateBrushSettings({ size: Math.max(1, Math.min(500, size)) });
  };

  setBrushFeather = (feather: number) => {
    this.updateBrushSettings({ feather: Math.max(0, Math.min(100, feather)) });
  };

  setBrushTool = (tool: ToolType) => {
    this.updateBrushSettings({ tool });
  };

  // Copy/paste mask
  setCopiedMask = (mask: MaskContainer | null) => {
    this.patch({ copiedMask: mask });
  };

  copyMask = (mask: MaskContainer) => {
    this.patch({ copiedMask: { ...mask, id: uuidv4() } });
  };

  clearCopiedMask = () => {
    this.patch({ copiedMask: null });
  };

  // AI mask generation
  setIsGeneratingAiMask = (generating: boolean) => {
    this.patch({ isGeneratingAiMask: generating });
  };

  // Hover state
  setIsMaskControlHovered = (hovered: boolean) => {
    this.patch({ isMaskControlHovered: hovered });
  };

  // Reset
  reset = () => {
    this.emit(defaultState);
  };

  // Helper to create a new mask container
  static createMaskContainer = (name?: string): MaskContainer => ({
    id: uuidv4(),
    name: name ?? 'New Mask',
    visible: true,
    opacity: 100,
    invert: false,
    subMasks: [],
    adjustments: { ...INITIAL_MASK_ADJUSTMENTS },
  });

  // Helper to create a new submask
  static createSubMask = (data: Partial<SubMask> = {}): SubMask => ({
    id: uuidv4(),
    points: [],
    visible: true,
    mode: 'add',
    ...data,
  } as SubMask);
}
