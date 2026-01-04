import { Cubit } from '@blac/core';
import type {
  MaskContainer,
  SubMask,
  MaskType,
  BrushStroke,
} from '../../types/editor.js';
import type { Adjustments } from '../../types/adjustments.js';
import { INITIAL_ADJUSTMENTS } from '../../types/adjustments.js';

export interface BrushSettings {
  size: number;
  hardness: number;
  opacity: number;
  isErase: boolean;
}

const DEFAULT_BRUSH_SETTINGS: BrushSettings = {
  size: 50,
  hardness: 50,
  opacity: 100,
  isErase: false,
};

interface MasksState {
  masks: MaskContainer[];
  activeContainerId: string | null;
  activeSubMaskId: string | null;
  copiedMask: MaskContainer | null;
  brushSettings: BrushSettings;
  isGeneratingAiMask: boolean;
  aiModelDownloadStatus: string | null;
}

const INITIAL_MASKS_STATE: MasksState = {
  masks: [],
  activeContainerId: null,
  activeSubMaskId: null,
  copiedMask: null,
  brushSettings: { ...DEFAULT_BRUSH_SETTINGS },
  isGeneratingAiMask: false,
  aiModelDownloadStatus: null,
};

let maskIdCounter = 0;
const generateId = () => `mask-${Date.now()}-${++maskIdCounter}`;

const createDefaultMaskAdjustments = (): Partial<Adjustments> => ({
  exposure: 0,
  brightness: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  saturation: 0,
  clarity: 0,
  dehaze: 0,
  sharpness: 0,
});

export class MasksBloc extends Cubit<MasksState> {
  constructor() {
    super({ ...INITIAL_MASKS_STATE });
  }

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
      case 'gradient':
        return {
          ...base,
          type: 'gradient',
          startX: imageWidth * 0.5,
          startY: imageHeight * 0.3,
          endX: imageWidth * 0.5,
          endY: imageHeight * 0.7,
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
      case 'luminosity':
        return {
          ...base,
          type: 'luminosity',
          range: [0, 255],
        };
      case 'color':
        return {
          ...base,
          type: 'color',
          targetColor: '#ffffff',
          tolerance: 30,
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

  addMaskContainer = (
    type: MaskType,
    imageWidth: number,
    imageHeight: number
  ): string => {
    const subMask = this.createSubMask(type, imageWidth, imageHeight);
    const newContainer: MaskContainer = {
      id: generateId(),
      name: `Mask ${this.state.masks.length + 1}`,
      visible: true,
      opacity: 100,
      subMasks: [subMask],
      adjustments: createDefaultMaskAdjustments(),
      isLoading: false,
      patchData: null,
      prompt: '',
    };

    this.emit({
      ...this.state,
      masks: [...this.state.masks, newContainer],
      activeContainerId: newContainer.id,
      activeSubMaskId: subMask.id,
    });

    return newContainer.id;
  };

  addSubMaskToContainer = (
    containerId: string,
    type: MaskType,
    imageWidth: number,
    imageHeight: number
  ): string | null => {
    const container = this.state.masks.find((m) => m.id === containerId);
    if (!container) return null;

    const subMask = this.createSubMask(type, imageWidth, imageHeight);

    this.emit({
      ...this.state,
      masks: this.state.masks.map((m) =>
        m.id === containerId
          ? { ...m, subMasks: [...m.subMasks, subMask] }
          : m
      ),
      activeSubMaskId: subMask.id,
    });

    return subMask.id;
  };

  selectContainer = (containerId: string | null) => {
    if (!containerId) {
      this.emit({
        ...this.state,
        activeContainerId: null,
        activeSubMaskId: null,
      });
      return;
    }

    const container = this.state.masks.find((m) => m.id === containerId);
    const lastSubMaskId =
      container && container.subMasks.length > 0
        ? container.subMasks[container.subMasks.length - 1].id
        : null;

    this.emit({
      ...this.state,
      activeContainerId: containerId,
      activeSubMaskId: lastSubMaskId,
    });
  };

  selectSubMask = (subMaskId: string | null) => {
    this.emit({
      ...this.state,
      activeSubMaskId: subMaskId,
    });
  };

  deselectAll = () => {
    this.emit({
      ...this.state,
      activeContainerId: null,
      activeSubMaskId: null,
    });
  };

  deleteContainer = (containerId: string) => {
    this.emit({
      ...this.state,
      masks: this.state.masks.filter((m) => m.id !== containerId),
      activeContainerId:
        this.state.activeContainerId === containerId
          ? null
          : this.state.activeContainerId,
      activeSubMaskId:
        this.state.masks.find((m) => m.id === containerId)?.subMasks.some(
          (sm) => sm.id === this.state.activeSubMaskId
        )
          ? null
          : this.state.activeSubMaskId,
    });
  };

  deleteSubMask = (subMaskId: string) => {
    this.emit({
      ...this.state,
      masks: this.state.masks.map((m) => ({
        ...m,
        subMasks: m.subMasks.filter((sm) => sm.id !== subMaskId),
      })),
      activeSubMaskId:
        this.state.activeSubMaskId === subMaskId
          ? null
          : this.state.activeSubMaskId,
    });
  };

  toggleContainerVisibility = (containerId: string) => {
    this.emit({
      ...this.state,
      masks: this.state.masks.map((m) =>
        m.id === containerId ? { ...m, visible: !m.visible } : m
      ),
    });
  };

  updateContainer = (
    containerId: string,
    updates: Partial<Omit<MaskContainer, 'id' | 'subMasks'>>
  ) => {
    this.emit({
      ...this.state,
      masks: this.state.masks.map((m) =>
        m.id === containerId ? { ...m, ...updates } : m
      ),
    });
  };

  updateContainerAdjustments = (
    containerId: string,
    adjustments: Partial<Adjustments>
  ) => {
    this.emit({
      ...this.state,
      masks: this.state.masks.map((m) =>
        m.id === containerId
          ? { ...m, adjustments: { ...m.adjustments, ...adjustments } }
          : m
      ),
    });
  };

  resetContainerAdjustments = (containerId: string) => {
    this.emit({
      ...this.state,
      masks: this.state.masks.map((m) =>
        m.id === containerId
          ? { ...m, adjustments: createDefaultMaskAdjustments() }
          : m
      ),
    });
  };

  updateSubMask = (subMaskId: string, updates: Partial<SubMask>) => {
    this.emit({
      ...this.state,
      masks: this.state.masks.map((m) => ({
        ...m,
        subMasks: m.subMasks.map((sm) =>
          sm.id === subMaskId ? ({ ...sm, ...updates } as SubMask) : sm
        ),
      })),
    });
  };

  renameContainer = (containerId: string, name: string) => {
    this.updateContainer(containerId, { name });
  };

  duplicateContainer = (containerId: string): string | null => {
    const container = this.state.masks.find((m) => m.id === containerId);
    if (!container) return null;

    const newContainer: MaskContainer = {
      ...JSON.parse(JSON.stringify(container)),
      id: generateId(),
      name: `${container.name} Copy`,
      subMasks: container.subMasks.map((sm) => ({
        ...JSON.parse(JSON.stringify(sm)),
        id: generateId(),
      })),
    };

    this.emit({
      ...this.state,
      masks: [...this.state.masks, newContainer],
    });

    return newContainer.id;
  };

  copyContainer = (containerId: string) => {
    const container = this.state.masks.find((m) => m.id === containerId);
    if (container) {
      this.emit({
        ...this.state,
        copiedMask: JSON.parse(JSON.stringify(container)),
      });
    }
  };

  pasteMask = (): string | null => {
    if (!this.state.copiedMask) return null;

    const newContainer: MaskContainer = {
      ...JSON.parse(JSON.stringify(this.state.copiedMask)),
      id: generateId(),
      subMasks: this.state.copiedMask.subMasks.map((sm) => ({
        ...JSON.parse(JSON.stringify(sm)),
        id: generateId(),
      })),
    };

    this.emit({
      ...this.state,
      masks: [...this.state.masks, newContainer],
    });

    return newContainer.id;
  };

  pasteAdjustmentsToContainer = (containerId: string) => {
    if (!this.state.copiedMask) return;

    this.emit({
      ...this.state,
      masks: this.state.masks.map((m) =>
        m.id === containerId
          ? {
              ...m,
              adjustments: JSON.parse(
                JSON.stringify(this.state.copiedMask!.adjustments)
              ),
            }
          : m
      ),
    });
  };

  addBrushStroke = (containerId: string, subMaskId: string, stroke: BrushStroke) => {
    this.emit({
      ...this.state,
      masks: this.state.masks.map((m) =>
        m.id === containerId
          ? {
              ...m,
              subMasks: m.subMasks.map((sm) =>
                sm.id === subMaskId && sm.type === 'brush'
                  ? { ...sm, strokes: [...sm.strokes, stroke] }
                  : sm
              ),
            }
          : m
      ),
    });
  };

  setBrushSettings = (settings: Partial<BrushSettings>) => {
    this.emit({
      ...this.state,
      brushSettings: { ...this.state.brushSettings, ...settings },
    });
  };

  setIsGeneratingAiMask = (isGenerating: boolean) => {
    this.emit({
      ...this.state,
      isGeneratingAiMask: isGenerating,
    });
  };

  setAiModelDownloadStatus = (status: string | null) => {
    this.emit({
      ...this.state,
      aiModelDownloadStatus: status,
    });
  };

  resetAll = () => {
    this.emit({ ...INITIAL_MASKS_STATE });
  };

  getActiveContainer = (): MaskContainer | null => {
    return (
      this.state.masks.find((m) => m.id === this.state.activeContainerId) ||
      null
    );
  };

  getActiveSubMask = (): SubMask | null => {
    const container = this.getActiveContainer();
    if (!container) return null;
    return (
      container.subMasks.find((sm) => sm.id === this.state.activeSubMaskId) ||
      null
    );
  };
}
