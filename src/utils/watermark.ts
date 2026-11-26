import {
  BorderBasis,
  ExportPreset,
  ExportSettings,
  WatermarkAnchor,
  WatermarkSettings,
  WatermarkSource,
  WatermarkSourceKind,
} from '../types/export';

type WatermarkAlign = 'start' | 'center' | 'end';

export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WatermarkPlacement {
  anchor: WatermarkAnchor;
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface WatermarkState extends WatermarkPlacement {
  enabled: boolean;
  source: WatermarkSourceKind;
  path: string | null;
  text: string;
  font: string | null;
  fontWeight: number;
  color: string;
  margin: number;
  opacity: number;
}

export interface ExportLayout {
  border: ExportSettings['border'];
  pad: ExportSettings['pad'];
}

export interface ExportFrame {
  width: number;
  height: number;
  box: FrameRect;
  photo: FrameRect;
}

export const MIN_WATERMARK_SCALE = 1;
export const MAX_WATERMARK_SCALE = 100;
export const MAX_WATERMARK_MARGIN = 25;

export const DEFAULT_WATERMARK: WatermarkState = {
  enabled: false,
  source: WatermarkSourceKind.Image,
  path: null,
  text: '',
  font: null,
  fontWeight: 400,
  color: '#ffffff',
  anchor: WatermarkAnchor.BottomRight,
  scale: 10,
  offsetX: 5,
  offsetY: 5,
  margin: 5,
  opacity: 75,
};

const PAD_RATIO_EPSILON = 0.001;

const ALIGNMENTS: Record<WatermarkAnchor, [WatermarkAlign, WatermarkAlign]> = {
  [WatermarkAnchor.TopLeft]: ['start', 'start'],
  [WatermarkAnchor.TopCenter]: ['center', 'start'],
  [WatermarkAnchor.TopRight]: ['end', 'start'],
  [WatermarkAnchor.CenterLeft]: ['start', 'center'],
  [WatermarkAnchor.Center]: ['center', 'center'],
  [WatermarkAnchor.CenterRight]: ['end', 'center'],
  [WatermarkAnchor.BottomLeft]: ['start', 'end'],
  [WatermarkAnchor.BottomCenter]: ['center', 'end'],
  [WatermarkAnchor.BottomRight]: ['end', 'end'],
};

const AXIS_ALIGNS: Array<WatermarkAlign> = ['start', 'center', 'end'];

const roundTo = (value: number, decimals: number) => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const anchorAlignment = (anchor: WatermarkAnchor) => ALIGNMENTS[anchor] ?? ALIGNMENTS[WatermarkAnchor.BottomRight];

const anchorFor = (horizontal: WatermarkAlign, vertical: WatermarkAlign) =>
  (Object.keys(ALIGNMENTS) as Array<WatermarkAnchor>).find(
    (anchor) => ALIGNMENTS[anchor][0] === horizontal && ALIGNMENTS[anchor][1] === vertical,
  ) ?? WatermarkAnchor.BottomRight;

const positionAlong = (align: WatermarkAlign, extent: number, size: number, offset: number) =>
  align === 'start' ? offset : align === 'end' ? extent - size - offset : (extent - size) / 2 + offset;

const offsetAlong = (align: WatermarkAlign, extent: number, size: number, position: number) =>
  align === 'start' ? position : align === 'end' ? extent - size - position : position - (extent - size) / 2;

const nearestAlign = (extent: number, size: number, position: number) =>
  AXIS_ALIGNS.reduce((best, align) =>
    Math.abs(offsetAlong(align, extent, size, position)) < Math.abs(offsetAlong(best, extent, size, position))
      ? align
      : best,
  );

export const watermarkRect = (
  frameWidth: number,
  frameHeight: number,
  aspect: number,
  placement: WatermarkPlacement,
): FrameRect => {
  const shortSide = Math.min(frameWidth, frameHeight);
  const width = (shortSide * placement.scale) / 100;
  const height = width / aspect;
  const [horizontal, vertical] = anchorAlignment(placement.anchor);
  return {
    x: positionAlong(horizontal, frameWidth, width, (shortSide * placement.offsetX) / 100),
    y: positionAlong(vertical, frameHeight, height, (shortSide * placement.offsetY) / 100),
    width,
    height,
  };
};

export const placementFromRect = (frameWidth: number, frameHeight: number, rect: FrameRect): WatermarkPlacement => {
  const shortSide = Math.min(frameWidth, frameHeight);
  const horizontal = nearestAlign(frameWidth, rect.width, rect.x);
  const vertical = nearestAlign(frameHeight, rect.height, rect.y);
  const percent = (value: number) => roundTo((value / shortSide) * 100, 2);
  return {
    anchor: anchorFor(horizontal, vertical),
    scale: percent(rect.width),
    offsetX: percent(offsetAlong(horizontal, frameWidth, rect.width, rect.x)),
    offsetY: percent(offsetAlong(vertical, frameHeight, rect.height, rect.y)),
  };
};

export const withMargin = <T extends WatermarkPlacement>(placement: T, margin: number): T => {
  const [horizontal, vertical] = anchorAlignment(placement.anchor);
  return {
    ...placement,
    offsetX: horizontal === 'center' ? placement.offsetX : margin,
    offsetY: vertical === 'center' ? placement.offsetY : margin,
  };
};

export const snapLines = (extent: number, size: number, margin: number) => [
  { position: 0, guide: 0 },
  { position: margin, guide: margin },
  { position: (extent - size) / 2, guide: extent / 2 },
  { position: extent - size - margin, guide: extent - margin },
  { position: extent - size, guide: extent },
];

export const exportFrame = (
  photoWidth: number,
  photoHeight: number,
  border: ExportSettings['border'],
  pad: ExportSettings['pad'],
): ExportFrame => {
  let borderX = 0;
  let borderY = 0;
  if (border) {
    const longSide = Math.max(photoWidth, photoHeight);
    const shortSide = Math.min(photoWidth, photoHeight);
    const [basisX, basisY] =
      border.basis === BorderBasis.EachEdge
        ? [photoWidth, photoHeight]
        : border.basis === BorderBasis.ShortEdge
          ? [shortSide, shortSide]
          : [longSide, longSide];
    borderX = (basisX * border.horizontalPercent) / 100;
    borderY = (basisY * border.verticalPercent) / 100;
  }
  const boxWidth = photoWidth + 2 * borderX;
  const boxHeight = photoHeight + 2 * borderY;
  let width = boxWidth;
  let height = boxHeight;
  if (pad && pad.ratioWidth > 0 && pad.ratioHeight > 0) {
    const target = pad.ratioWidth / pad.ratioHeight;
    if (Math.abs(width / height - target) >= PAD_RATIO_EPSILON) {
      if (width / height > target) height = width / target;
      else width = height * target;
    }
  }
  const centered = (w: number, h: number): FrameRect => ({
    x: (width - w) / 2,
    y: (height - h) / 2,
    width: w,
    height: h,
  });
  return { width, height, box: centered(boxWidth, boxHeight), photo: centered(photoWidth, photoHeight) };
};

export const watermarkFromPreset = (preset: Omit<ExportPreset, 'id' | 'name'>): WatermarkState => {
  const anchor = Object.values(WatermarkAnchor).includes(preset.watermarkAnchor as WatermarkAnchor)
    ? (preset.watermarkAnchor as WatermarkAnchor)
    : DEFAULT_WATERMARK.anchor;
  const margin = preset.watermarkSpacing ?? DEFAULT_WATERMARK.margin;
  const [horizontal, vertical] = anchorAlignment(anchor);
  return {
    enabled: preset.enableWatermark,
    source: preset.watermarkSource === WatermarkSourceKind.Text ? WatermarkSourceKind.Text : WatermarkSourceKind.Image,
    path: preset.watermarkPath ?? null,
    text: preset.watermarkText ?? DEFAULT_WATERMARK.text,
    font: preset.watermarkFont ?? DEFAULT_WATERMARK.font,
    fontWeight: preset.watermarkFontWeight ?? DEFAULT_WATERMARK.fontWeight,
    color: preset.watermarkColor ?? DEFAULT_WATERMARK.color,
    anchor,
    scale: preset.watermarkScale ?? DEFAULT_WATERMARK.scale,
    offsetX: preset.watermarkOffsetX ?? (horizontal === 'center' ? 0 : margin),
    offsetY: preset.watermarkOffsetY ?? (vertical === 'center' ? 0 : margin),
    margin,
    opacity: preset.watermarkOpacity ?? DEFAULT_WATERMARK.opacity,
  };
};

export const watermarkPresetFields = (watermark: WatermarkState) => ({
  enableWatermark: watermark.enabled,
  watermarkSource: watermark.source,
  watermarkPath: watermark.path,
  watermarkText: watermark.text,
  watermarkFont: watermark.font,
  watermarkFontWeight: watermark.fontWeight,
  watermarkColor: watermark.color,
  watermarkAnchor: watermark.anchor,
  watermarkScale: watermark.scale,
  watermarkSpacing: watermark.margin,
  watermarkOffsetX: watermark.offsetX,
  watermarkOffsetY: watermark.offsetY,
  watermarkOpacity: watermark.opacity,
});

export const watermarkSource = (watermark: WatermarkState): WatermarkSource | null => {
  if (watermark.source === WatermarkSourceKind.Image) {
    return watermark.path ? { kind: WatermarkSourceKind.Image, path: watermark.path } : null;
  }
  const text = watermark.text.trim();
  return text
    ? {
        kind: WatermarkSourceKind.Text,
        text,
        font: watermark.font,
        weight: watermark.fontWeight,
        color: watermark.color,
      }
    : null;
};

export const watermarkExportSettings = (watermark: WatermarkState): WatermarkSettings | null => {
  const source = watermark.enabled ? watermarkSource(watermark) : null;
  return source
    ? {
        source,
        anchor: watermark.anchor,
        scale: watermark.scale,
        offsetX: watermark.offsetX,
        offsetY: watermark.offsetY,
        opacity: watermark.opacity,
      }
    : null;
};
