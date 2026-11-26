import type React from 'react';

export const FINE_ADJUSTMENT_MULTIPLIER = 0.2;

export const hasFineAdjustmentModifier = (event: MouseEvent | TouchEvent | React.MouseEvent | React.TouchEvent) =>
  'shiftKey' in event && (event.shiftKey || event.altKey);
