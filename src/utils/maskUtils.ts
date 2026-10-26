import { v4 as uuidv4 } from 'uuid';
import { Mask, SubMask, SubMaskMode, formatMaskTypeName } from '../components/panel/right/Masks';
import { ImageDimensions } from '../hooks/useImageRenderSize';
import { MaskContainer } from './adjustments';

const AI_MASK_TYPES = new Set<string>([
  Mask.AiDepth,
  Mask.AiForeground,
  Mask.AiSky,
  Mask.AiSubject,
  Mask.AiText,
  Mask.AiFace,
]);

const isAiSubMask = (subMask: SubMask) => AI_MASK_TYPES.has(subMask.type);

const hasAiResult = (subMask: SubMask) => !!subMask.parameters?.maskDataBase64;

export const hasAiSubMasks = (masks: Array<MaskContainer> | undefined, missingResultOnly: boolean = false) =>
  !!masks?.some((container) =>
    container.subMasks.some((subMask) => isAiSubMask(subMask) && (!missingResultOnly || !hasAiResult(subMask))),
  );

export const stripAiMaskResults = (masks: Array<MaskContainer>): Array<MaskContainer> =>
  masks.map((container) => ({
    ...container,
    subMasks: container.subMasks.map((subMask) => {
      if (!isAiSubMask(subMask)) return subMask;
      const parameters = { ...subMask.parameters, maskDataBase64: null };
      delete parameters.aiSource;
      return { ...subMask, parameters };
    }),
  }));

export const mergeAiMaskResults = (
  masks: Array<MaskContainer>,
  source: Array<MaskContainer>,
): Array<MaskContainer> => {
  const results = new Map(
    source
      .flatMap((container) => container.subMasks)
      .filter((subMask) => isAiSubMask(subMask) && hasAiResult(subMask))
      .map((subMask) => [subMask.id, subMask.parameters]),
  );
  if (results.size === 0) return masks;
  return masks.map((container) => ({
    ...container,
    subMasks: container.subMasks.map((subMask) =>
      results.has(subMask.id) && !hasAiResult(subMask)
        ? { ...subMask, parameters: { ...subMask.parameters, ...results.get(subMask.id) } }
        : subMask,
    ),
  }));
};

export const createSubMask = (
  type: Mask,
  imageDimensions: ImageDimensions,
  mode: SubMaskMode = SubMaskMode.Additive
) => {
  const { width, height } = imageDimensions || { width: 1000, height: 1000 };
  const common = {
    id: uuidv4(),
    visible: true,
    invert: false,
    opacity: 100,
    mode,
    name: formatMaskTypeName(type),
    type,
  };

  switch (type) {
    case Mask.Radial:
      return {
        ...common,
        parameters: {
          centerX: width / 2,
          centerY: height / 2,
          radiusX: width / 4,
          radiusY: width / 4,
          rotation: 0,
          feather: 0.5,
        },
      };
    case Mask.Linear:
      return {
        ...common,
        parameters: { startX: width * 0.25, startY: height / 2, endX: width * 0.75, endY: height / 2, range: 50 },
      };
    case Mask.Brush:
      return { ...common, parameters: { lines: [] } };
    case Mask.Flow:
      return { ...common, parameters: { lines: [], flow: 10 } };
    case Mask.AiSubject:
      return { ...common, parameters: { maskDataBase64: null, grow: 0, feather: 0 } };
    case Mask.AiForeground:
      return { ...common, parameters: { maskDataBase64: null, grow: 0, feather: 0 } };
    case Mask.AiText:
      return { ...common, name: '', parameters: { maskDataBase64: null, prompt: '', grow: 0, feather: 0 } };
    case Mask.AiFace:
      return { ...common, parameters: { maskDataBase64: null, parts: ['faceSkin'], grow: 0, feather: 0 } };
    case Mask.QuickEraser:
      return { ...common, parameters: { maskDataBase64: null, grow: 150, feather: 75 } };
    default:
      return { ...common, parameters: {} };
  }
};
