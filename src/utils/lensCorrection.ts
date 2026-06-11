import { invoke } from '@tauri-apps/api/core';
import { Adjustments, INITIAL_ADJUSTMENTS } from './adjustments';

type ExifData = Partial<
  Record<'FocalLength' | 'FNumber' | 'SubjectDistance' | 'LensMake' | 'Make' | 'LensModel' | 'Lens', unknown>
>;

export type LensCorrectionParams = Pick<
  Adjustments,
  | 'lensCorrectionMode'
  | 'lensMaker'
  | 'lensModel'
  | 'lensDistortionAmount'
  | 'lensVignetteAmount'
  | 'lensTcaAmount'
  | 'lensDistortionEnabled'
  | 'lensTcaEnabled'
  | 'lensVignetteEnabled'
  | 'lensDistortionParams'
>;

export type LensDistortionParams = Adjustments['lensDistortionParams'];

const parseExifNumber = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') return null;

  const val = parseFloat(value);
  return isNaN(val) ? null : val;
};

const parseExifString = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
};

export const parseFocalLength = (exif: ExifData | null | undefined): number | null =>
  parseExifNumber(exif?.FocalLength);

export const parseAperture = (exif: ExifData | null | undefined): number | null => parseExifNumber(exif?.FNumber);

export const parseDistance = (exif: ExifData | null | undefined): number | null =>
  parseExifNumber(exif?.SubjectDistance);

export const isLensCorrectionDefault = (adjustments: Adjustments) =>
  adjustments.lensCorrectionMode === INITIAL_ADJUSTMENTS.lensCorrectionMode &&
  adjustments.lensMaker === INITIAL_ADJUSTMENTS.lensMaker &&
  adjustments.lensModel === INITIAL_ADJUSTMENTS.lensModel &&
  adjustments.lensDistortionAmount === INITIAL_ADJUSTMENTS.lensDistortionAmount &&
  adjustments.lensVignetteAmount === INITIAL_ADJUSTMENTS.lensVignetteAmount &&
  adjustments.lensTcaAmount === INITIAL_ADJUSTMENTS.lensTcaAmount &&
  adjustments.lensDistortionEnabled === INITIAL_ADJUSTMENTS.lensDistortionEnabled &&
  adjustments.lensTcaEnabled === INITIAL_ADJUSTMENTS.lensTcaEnabled &&
  adjustments.lensVignetteEnabled === INITIAL_ADJUSTMENTS.lensVignetteEnabled &&
  adjustments.lensDistortionParams === INITIAL_ADJUSTMENTS.lensDistortionParams;

export const fetchLensDistortionParams = async (
  maker: string,
  model: string,
  exif: ExifData | null | undefined,
): Promise<LensDistortionParams> => {
  const focalLength = parseFocalLength(exif);
  if (focalLength === null) return null;

  try {
    return await invoke<LensDistortionParams>('get_lens_distortion_params', {
      maker,
      model,
      focalLength,
      aperture: parseAperture(exif),
      distance: parseDistance(exif),
    });
  } catch (error) {
    console.error('Failed to fetch lens params', error);
    return null;
  }
};

export const detectLensCorrectionParams = async (
  exif: ExifData | null | undefined,
): Promise<LensCorrectionParams | null> => {
  const exifMaker = parseExifString(exif?.LensMake) || parseExifString(exif?.Make);
  const exifModel = parseExifString(exif?.LensModel) || parseExifString(exif?.Lens);

  if (!exifModel) return null;

  const result: [string, string] | null = await invoke('autodetect_lens', {
    maker: exifMaker,
    model: exifModel,
  });

  if (!result) return null;

  const [detectedMaker, detectedModel] = result;
  const distortionParams = await fetchLensDistortionParams(detectedMaker, detectedModel, exif);

  return {
    lensCorrectionMode: 'auto',
    lensMaker: detectedMaker,
    lensModel: detectedModel,
    lensDistortionAmount: INITIAL_ADJUSTMENTS.lensDistortionAmount,
    lensVignetteAmount: INITIAL_ADJUSTMENTS.lensVignetteAmount,
    lensTcaAmount: INITIAL_ADJUSTMENTS.lensTcaAmount,
    lensDistortionEnabled: INITIAL_ADJUSTMENTS.lensDistortionEnabled,
    lensTcaEnabled: INITIAL_ADJUSTMENTS.lensTcaEnabled,
    lensVignetteEnabled: INITIAL_ADJUSTMENTS.lensVignetteEnabled,
    lensDistortionParams: distortionParams,
  };
};
