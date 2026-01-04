import { Cubit } from '@blac/core';
import type { SubMask, MaskType } from '../../types/editor.js';

export interface AIPatch {
  id: string;
  name: string;
  visible: boolean;
  subMasks: SubMask[];
  prompt: string;
  patchData: string | null;
  isLoading: boolean;
  invert: boolean;
}

interface AIState {
  patches: AIPatch[];
  activePatchId: string | null;
  activeSubMaskId: string | null;
  isComfyUiConnected: boolean;
  isGenerating: boolean;
  isGeneratingMask: boolean;
  aiModelDownloadStatus: string | null;
  brushSettings: {
    size: number;
    hardness: number;
    opacity: number;
    isErase: boolean;
  };
}

const INITIAL_AI_STATE: AIState = {
  patches: [],
  activePatchId: null,
  activeSubMaskId: null,
  isComfyUiConnected: false,
  isGenerating: false,
  isGeneratingMask: false,
  aiModelDownloadStatus: null,
  brushSettings: {
    size: 50,
    hardness: 50,
    opacity: 100,
    isErase: false,
  },
};

let patchIdCounter = 0;
const generateId = () => `ai-patch-${Date.now()}-${++patchIdCounter}`;

export class AIBloc extends Cubit<AIState> {
  constructor() {
    super({ ...INITIAL_AI_STATE });
  }

  setComfyUiConnected = (connected: boolean) => {
    this.emit({ ...this.state, isComfyUiConnected: connected });
  };

  setIsGenerating = (isGenerating: boolean) => {
    this.emit({ ...this.state, isGenerating });
  };

  setIsGeneratingMask = (isGenerating: boolean) => {
    this.emit({ ...this.state, isGeneratingMask: isGenerating });
  };

  setAiModelDownloadStatus = (status: string | null) => {
    this.emit({ ...this.state, aiModelDownloadStatus: status });
  };

  createSubMask = (
    type: MaskType,
    imageWidth: number,
    imageHeight: number
  ): SubMask => {
    const id = generateId();
    const base = {
      id,
      inverted: false,
      feather: 50,
      opacity: 100,
    };

    switch (type) {
      case 'brush':
        return {
          ...base,
          type: 'brush',
          strokes: [],
        };
      case 'radial':
        return {
          ...base,
          type: 'radial',
          centerX: imageWidth * 0.5,
          centerY: imageHeight * 0.5,
          radiusX: imageWidth * 0.3,
          radiusY: imageHeight * 0.3,
          rotation: 0,
        };
      case 'ai':
        return {
          ...base,
          type: 'ai',
          prompt: undefined,
          maskData: undefined,
        };
      default:
        return {
          ...base,
          type: 'brush',
          strokes: [],
        };
    }
  };

  addPatch = (
    type: MaskType,
    imageWidth: number,
    imageHeight: number
  ): string => {
    const subMask = this.createSubMask(type, imageWidth, imageHeight);
    const patchCount = this.state.patches.length + 1;

    const newPatch: AIPatch = {
      id: generateId(),
      name: type === 'brush' ? `Quick Erase ${patchCount}` : `AI Edit ${patchCount}`,
      visible: true,
      subMasks: [subMask],
      prompt: '',
      patchData: null,
      isLoading: false,
      invert: false,
    };

    this.emit({
      ...this.state,
      patches: [...this.state.patches, newPatch],
      activePatchId: newPatch.id,
      activeSubMaskId: subMask.id,
    });

    return newPatch.id;
  };

  selectPatch = (patchId: string | null) => {
    if (!patchId) {
      this.emit({
        ...this.state,
        activePatchId: null,
        activeSubMaskId: null,
      });
      return;
    }

    const patch = this.state.patches.find((p) => p.id === patchId);
    const lastSubMaskId =
      patch && patch.subMasks.length > 0
        ? patch.subMasks[patch.subMasks.length - 1].id
        : null;

    this.emit({
      ...this.state,
      activePatchId: patchId,
      activeSubMaskId: lastSubMaskId,
    });
  };

  selectSubMask = (subMaskId: string | null) => {
    this.emit({ ...this.state, activeSubMaskId: subMaskId });
  };

  deletePatch = (patchId: string) => {
    this.emit({
      ...this.state,
      patches: this.state.patches.filter((p) => p.id !== patchId),
      activePatchId:
        this.state.activePatchId === patchId ? null : this.state.activePatchId,
    });
  };

  togglePatchVisibility = (patchId: string) => {
    this.emit({
      ...this.state,
      patches: this.state.patches.map((p) =>
        p.id === patchId ? { ...p, visible: !p.visible } : p
      ),
    });
  };

  updatePatch = (patchId: string, updates: Partial<Omit<AIPatch, 'id' | 'subMasks'>>) => {
    this.emit({
      ...this.state,
      patches: this.state.patches.map((p) =>
        p.id === patchId ? { ...p, ...updates } : p
      ),
    });
  };

  renamePatch = (patchId: string, name: string) => {
    this.updatePatch(patchId, { name });
  };

  setPatchLoading = (patchId: string, isLoading: boolean) => {
    this.updatePatch(patchId, { isLoading });
  };

  setPatchData = (patchId: string, patchData: string | null) => {
    this.updatePatch(patchId, { patchData, isLoading: false });
  };

  setPrompt = (patchId: string, prompt: string) => {
    this.updatePatch(patchId, { prompt });
  };

  updateSubMask = (subMaskId: string, updates: Partial<SubMask>) => {
    this.emit({
      ...this.state,
      patches: this.state.patches.map((p) => ({
        ...p,
        subMasks: p.subMasks.map((sm) =>
          sm.id === subMaskId ? ({ ...sm, ...updates } as SubMask) : sm
        ),
      })),
    });
  };

  clearSubMasks = (patchId: string) => {
    this.emit({
      ...this.state,
      patches: this.state.patches.map((p) =>
        p.id === patchId ? { ...p, subMasks: [] } : p
      ),
    });
  };

  setBrushSettings = (settings: Partial<AIState['brushSettings']>) => {
    this.emit({
      ...this.state,
      brushSettings: { ...this.state.brushSettings, ...settings },
    });
  };

  resetAll = () => {
    this.emit({ ...INITIAL_AI_STATE });
  };

  getActivePatch = (): AIPatch | null => {
    return (
      this.state.patches.find((p) => p.id === this.state.activePatchId) || null
    );
  };

  getActiveSubMask = (): SubMask | null => {
    const patch = this.getActivePatch();
    if (!patch) return null;
    return (
      patch.subMasks.find((sm) => sm.id === this.state.activeSubMaskId) || null
    );
  };
}
