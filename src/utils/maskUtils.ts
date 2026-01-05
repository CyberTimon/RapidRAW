import { v4 as uuidv4 } from 'uuid';
import type {
  MaskType,
  SubMask,
  BrushSubMask,
  GradientSubMask,
  RadialSubMask,
  LuminositySubMask,
  ColorSubMask,
  AISubMask,
  MaskContainer,
} from '../types/editor';
import type { Adjustments } from '../types/adjustments';
import { INITIAL_ADJUSTMENTS } from '../types/adjustments';

export interface ImageDimensions {
  width: number;
  height: number;
}

export function createSubMask(type: MaskType, imageDimensions?: ImageDimensions): SubMask {
  const { width, height } = imageDimensions ?? { width: 1000, height: 1000 };
  const baseProps = {
    id: uuidv4(),
    inverted: false,
    feather: 0,
    opacity: 1,
  };

  switch (type) {
    case 'brush':
      return {
        ...baseProps,
        type: 'brush',
        strokes: [],
      } as BrushSubMask;

    case 'gradient':
      return {
        ...baseProps,
        type: 'gradient',
        startX: width * 0.25,
        startY: height / 2,
        endX: width * 0.75,
        endY: height / 2,
      } as GradientSubMask;

    case 'radial':
      return {
        ...baseProps,
        type: 'radial',
        centerX: width / 2,
        centerY: height / 2,
        radiusX: width / 4,
        radiusY: width / 4,
        rotation: 0,
        feather: 50,
      } as RadialSubMask;

    case 'luminosity':
      return {
        ...baseProps,
        type: 'luminosity',
        range: [0, 100],
      } as LuminositySubMask;

    case 'color':
      return {
        ...baseProps,
        type: 'color',
        targetColor: '#ffffff',
        tolerance: 20,
      } as ColorSubMask;

    case 'ai':
      return {
        ...baseProps,
        type: 'ai',
        feather: 25,
      } as AISubMask;

    default:
      return {
        ...baseProps,
        type: 'brush',
        strokes: [],
      } as BrushSubMask;
  }
}

export function createMaskContainer(name?: string, imageDimensions?: ImageDimensions): MaskContainer {
  return {
    id: uuidv4(),
    name: name ?? 'New Mask',
    visible: true,
    opacity: 1,
    subMasks: [],
    adjustments: {} as Partial<Adjustments>,
    isLoading: false,
    patchData: null,
    prompt: '',
  };
}

export function invertSubMask<T extends SubMask>(subMask: T): T {
  return {
    ...subMask,
    inverted: !subMask.inverted,
  };
}

export function setSubMaskFeather<T extends SubMask>(subMask: T, feather: number): T {
  return {
    ...subMask,
    feather: Math.max(0, Math.min(100, feather)),
  };
}

export function setSubMaskOpacity<T extends SubMask>(subMask: T, opacity: number): T {
  return {
    ...subMask,
    opacity: Math.max(0, Math.min(1, opacity)),
  };
}

export function duplicateSubMask<T extends SubMask>(subMask: T): T {
  return {
    ...subMask,
    id: uuidv4(),
  };
}

export function duplicateMaskContainer(container: MaskContainer): MaskContainer {
  return {
    ...container,
    id: uuidv4(),
    name: `${container.name} (Copy)`,
    subMasks: container.subMasks.map((sm) => duplicateSubMask(sm)),
  };
}

export function combineMaskContainers(
  containers: MaskContainer[],
  name?: string
): MaskContainer {
  const combined = createMaskContainer(name ?? 'Combined Mask');
  combined.subMasks = containers.flatMap((c) => c.subMasks.map((sm) => duplicateSubMask(sm)));
  return combined;
}

export function resetMaskContainerAdjustments(container: MaskContainer): MaskContainer {
  return {
    ...container,
    adjustments: {} as Partial<Adjustments>,
  };
}

export function updateMaskContainerSubMask<T extends SubMask>(
  container: MaskContainer,
  subMaskId: string,
  updater: (subMask: T) => T
): MaskContainer {
  return {
    ...container,
    subMasks: container.subMasks.map((sm) =>
      sm.id === subMaskId ? updater(sm as T) : sm
    ),
  };
}

export function removeSubMaskFromContainer(
  container: MaskContainer,
  subMaskId: string
): MaskContainer {
  return {
    ...container,
    subMasks: container.subMasks.filter((sm) => sm.id !== subMaskId),
  };
}

export function addSubMaskToContainer(
  container: MaskContainer,
  type: MaskType,
  imageDimensions?: ImageDimensions
): MaskContainer {
  const newSubMask = createSubMask(type, imageDimensions);
  return {
    ...container,
    subMasks: [...container.subMasks, newSubMask],
  };
}

export function reorderSubMasks(
  container: MaskContainer,
  fromIndex: number,
  toIndex: number
): MaskContainer {
  const subMasks = [...container.subMasks];
  const [removed] = subMasks.splice(fromIndex, 1);
  subMasks.splice(toIndex, 0, removed);
  return {
    ...container,
    subMasks,
  };
}

export function getMaskDisplayName(type: MaskType): string {
  const names: Record<MaskType, string> = {
    brush: 'Brush',
    gradient: 'Linear Gradient',
    radial: 'Radial Gradient',
    luminosity: 'Luminosity Range',
    color: 'Color Range',
    ai: 'AI Mask',
  };
  return names[type] ?? 'Unknown';
}

export function getDefaultMaskAdjustments(): Partial<Adjustments> {
  return {
    exposure: 0,
    brightness: 0,
    contrast: 0,
    saturation: 0,
    temperature: 0,
    tint: 0,
    highlights: 0,
    shadows: 0,
    clarity: 0,
  };
}
