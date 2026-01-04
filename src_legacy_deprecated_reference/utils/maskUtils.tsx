import { v4 as uuidv4 } from 'uuid';
import { Mask, SubMaskMode } from '../components/panel/right/Masks';
import { ImageDimensions } from '../hooks/useImageRenderSize';

export const createSubMask = (type: Mask, imageDimensions: ImageDimensions) => {
  const { width, height } = imageDimensions || { width: 1000, height: 1000 };
  const common = { id: uuidv4(), visible: true, mode: SubMaskMode.Additive, type };

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
    case Mask.AiSubject:
      return { ...common, parameters: { maskDataBase64: null, grow: 0, feather: 0 } };
    case Mask.AiForeground:
      return { ...common, parameters: { maskDataBase64: null, grow: 0, feather: 0 } };
    case Mask.QuickEraser:
      return { ...common, parameters: { maskDataBase64: null, grow: 50, feather: 50 } };
    default:
      return { ...common, parameters: {} };
  }
};
