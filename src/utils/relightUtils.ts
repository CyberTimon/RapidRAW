import { Coord } from './adjustments';

export const RELIGHT_TEMPERATURE_PRESETS = [1900, 2700, 3200, 4000, 5600, 6500, 8000, 10000];

const toHexChannel = (value: number) =>
  Math.round(Math.max(0, Math.min(255, value)))
    .toString(16)
    .padStart(2, '0');

// Tanner Helland's black body approximation, good enough for picking a light tint.
export const kelvinToHex = (kelvin: number): string => {
  const temp = Math.max(1000, Math.min(40000, kelvin)) / 100;

  const red = temp <= 66 ? 255 : 329.698727446 * Math.pow(temp - 60, -0.1332047592);
  const green =
    temp <= 66 ? 99.4708025861 * Math.log(temp) - 161.1195681661 : 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
  const blue = temp >= 66 ? 255 : temp <= 19 ? 0 : 138.5177312231 * Math.log(temp - 10) - 305.0447927307;

  return `#${toHexChannel(red)}${toHexChannel(green)}${toHexChannel(blue)}`;
};

export interface RelightGeometry {
  imageWidth: number;
  imageHeight: number;
  orientationSteps: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
  rotation: number;
  cropX: number;
  cropY: number;
}

const orientPoint = (x: number, y: number, w: number, h: number, steps: number): Coord => {
  const s = ((steps % 4) + 4) % 4;
  if (s === 0) return { x, y };
  if (s === 1) return { x: h - y, y: x };
  if (s === 2) return { x: w - x, y: h - y };
  return { x: y, y: w - x };
};

const getOrientedSize = (g: RelightGeometry) => {
  const swapped = (((g.orientationSteps % 4) + 4) % 4) % 2 !== 0;
  return {
    width: swapped ? g.imageHeight : g.imageWidth,
    height: swapped ? g.imageWidth : g.imageHeight,
  };
};

const rotateAboutCenter = (x: number, y: number, width: number, height: number, degrees: number): Coord => {
  if (Math.abs(degrees) < 1e-4) return { x, y };
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = width / 2;
  const cy = height / 2;
  const dx = x - cx;
  const dy = y - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
};

/**
 * The light position is stored as a fraction of the image before orientation, flip,
 * rotation and crop, because that is where the relight pass runs. These helpers convert
 * between that space and pixels of the cropped image shown in the editor.
 */
export const relightUvToDisplay = (uv: Coord, g: RelightGeometry): Coord => {
  const oriented = getOrientedSize(g);
  let { x, y } = orientPoint(
    uv.x * g.imageWidth,
    uv.y * g.imageHeight,
    g.imageWidth,
    g.imageHeight,
    g.orientationSteps,
  );
  if (g.flipHorizontal) x = oriented.width - x;
  if (g.flipVertical) y = oriented.height - y;
  const rotated = rotateAboutCenter(x, y, oriented.width, oriented.height, g.rotation);
  return { x: rotated.x - g.cropX, y: rotated.y - g.cropY };
};

export const relightDisplayToUv = (point: Coord, g: RelightGeometry): Coord => {
  const oriented = getOrientedSize(g);
  let { x, y } = rotateAboutCenter(point.x + g.cropX, point.y + g.cropY, oriented.width, oriented.height, -g.rotation);
  if (g.flipHorizontal) x = oriented.width - x;
  if (g.flipVertical) y = oriented.height - y;
  const original = orientPoint(x, y, oriented.width, oriented.height, 4 - (((g.orientationSteps % 4) + 4) % 4));
  return {
    x: g.imageWidth > 0 ? original.x / g.imageWidth : 0,
    y: g.imageHeight > 0 ? original.y / g.imageHeight : 0,
  };
};
