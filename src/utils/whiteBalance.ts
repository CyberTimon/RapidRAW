import type { AppSettings } from '../components/ui/AppProperties';

export interface WhiteBalance {
  temperature: number;
  tint: number;
}

export enum WhiteBalanceMode {
  Kelvin = 'kelvin',
  Relative = 'relative',
}

interface WhiteBalanceAdjustments {
  temperature: number;
  tint: number;
  whiteBalance?: WhiteBalance | null;
}

export const MIN_TEMPERATURE = 2000;
export const MAX_TEMPERATURE = 50000;
export const MAX_TINT = 150;
export const RELATIVE_RANGE = 100;
const MIRED_PER_RELATIVE_UNIT = 1.5;
const TINT_PER_RELATIVE_UNIT = 1.5;

const toMired = (kelvin: number) => 1_000_000 / kelvin;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const kelvinSliderScale = {
  fromPosition: (position: number) => -toMired(position),
  toPosition: (kelvin: number) => -toMired(kelvin),
};

export const getWhiteBalanceMode = (settings: AppSettings | null | undefined): WhiteBalanceMode =>
  settings?.whiteBalanceMode ?? WhiteBalanceMode.Relative;

export const resolveWhiteBalance = (asShot: WhiteBalance, adjustments: WhiteBalanceAdjustments): WhiteBalance => {
  const base = adjustments.whiteBalance ?? asShot;
  const temperature = adjustments.temperature || 0;
  const tint = adjustments.tint || 0;
  if (temperature === 0 && tint === 0) {
    return base;
  }
  const mired = toMired(base.temperature) - temperature * MIRED_PER_RELATIVE_UNIT;
  return {
    temperature: clamp(toMired(Math.max(mired, toMired(MAX_TEMPERATURE))), MIN_TEMPERATURE, MAX_TEMPERATURE),
    tint: clamp(base.tint + tint * TINT_PER_RELATIVE_UNIT, -MAX_TINT, MAX_TINT),
  };
};

export const toRelativeWhiteBalance = (asShot: WhiteBalance, whiteBalance: WhiteBalance): WhiteBalance => ({
  temperature: clamp(
    (toMired(asShot.temperature) - toMired(whiteBalance.temperature)) / MIRED_PER_RELATIVE_UNIT,
    -RELATIVE_RANGE,
    RELATIVE_RANGE,
  ),
  tint: clamp((whiteBalance.tint - asShot.tint) / TINT_PER_RELATIVE_UNIT, -RELATIVE_RANGE, RELATIVE_RANGE),
});

export const getRelativeWhiteBalance = (
  asShot: WhiteBalance | undefined,
  adjustments: WhiteBalanceAdjustments,
): WhiteBalance =>
  asShot && adjustments.whiteBalance
    ? toRelativeWhiteBalance(asShot, resolveWhiteBalance(asShot, adjustments))
    : { temperature: adjustments.temperature || 0, tint: adjustments.tint || 0 };

export const withKelvinWhiteBalance = <T extends WhiteBalanceAdjustments>(
  adjustments: T,
  whiteBalance: WhiteBalance,
): T => ({
  ...adjustments,
  temperature: 0,
  tint: 0,
  whiteBalance,
});

export const withRelativeWhiteBalance = <T extends WhiteBalanceAdjustments>(
  adjustments: T,
  relative: WhiteBalance,
): T => ({
  ...adjustments,
  ...relative,
  whiteBalance: null,
});
