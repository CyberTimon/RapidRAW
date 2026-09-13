import { useCallback, useEffect, useRef, useState } from 'react';
import type { Crop, PercentCrop } from 'react-image-crop';
import type { SelectedImage } from '../components/ui/AppProperties';
import type { Adjustments } from '../utils/adjustments';
import {
  calculateCenteredCrop,
  calculateAreaPreservingCrop,
  calculateAutoCropForRotation,
  getOrientedDimensions,
} from '../utils/cropUtils';
import { constrainRect, withinImage } from './geometry';

interface Props {
  selectedImage: SelectedImage | null;
  adjustments: Adjustments;
  liveRotation: number | null;
  isCropping: boolean;
  setAdjustments: (value: Partial<Adjustments> | ((previous: Adjustments) => Adjustments)) => void;
}
export function useCropState({ selectedImage: image, adjustments, liveRotation, isCropping, setAdjustments }: Props) {
  const [crop, setCrop] = useState<Crop | null>(null);
  const previous = useRef<{
    path: string;
    rotation: number;
    aspect: number | null;
    crop: Crop | null;
    orientation: number;
  } | null>(null);
  const lastValid = useRef<PercentCrop | null>(null);
  const { width, height } = getOrientedDimensions(
    image?.width || 0,
    image?.height || 0,
    adjustments.orientationSteps || 0,
  );
  const toPercent = useCallback(
    (rect: Crop): PercentCrop => ({
      unit: '%',
      x: (rect.x / width) * 100,
      y: (rect.y / height) * 100,
      width: (rect.width / width) * 100,
      height: (rect.height / height) * 100,
    }),
    [width, height],
  );
  const toPixel = useCallback(
    (rect: PercentCrop): Crop => ({
      unit: 'px',
      x: (rect.x / 100) * width,
      y: (rect.y / 100) * height,
      width: (rect.width / 100) * width,
      height: (rect.height / 100) * height,
    }),
    [width, height],
  );

  useEffect(() => {
    if (!isCropping || !image || !width || !height) {
      previous.current = null;
      lastValid.current = null;
      setCrop(null);
      return;
    }
    const rotation = adjustments.rotation || 0;
    const effectiveRotation = liveRotation ?? rotation;
    const aspect = adjustments.aspectRatio ?? null;
    const originalCrop = adjustments.crop?.unit === '%' ? toPixel(adjustments.crop as PercentCrop) : adjustments.crop;
    const reference = previous.current?.path === image.path ? previous.current : null;
    const suppliedNewCrop = reference && JSON.stringify(reference.crop) !== JSON.stringify(adjustments.crop);
    let next = originalCrop;
    const ratio = aspect || (next ? next.width / next.height : width / height);
    if (!next)
      next = calculateCenteredCrop(
        image.width,
        image.height,
        adjustments.orientationSteps || 0,
        ratio,
        effectiveRotation,
      );
    else if (aspect && Math.abs(next.width / next.height - aspect) > 0.005) {
      next =
        calculateAreaPreservingCrop(
          image.width,
          image.height,
          adjustments.orientationSteps || 0,
          aspect,
          effectiveRotation,
          next,
        ) ||
        calculateCenteredCrop(image.width, image.height, adjustments.orientationSteps || 0, aspect, effectiveRotation);
    } else if (
      liveRotation !== null ||
      !withinImage(next, { width, height, rotation: effectiveRotation }) ||
      (reference && !suppliedNewCrop && reference.rotation !== rotation)
    ) {
      const delta =
        liveRotation !== null
          ? liveRotation - rotation
          : suppliedNewCrop
            ? 0
            : rotation - (reference?.rotation ?? rotation);
      next = calculateAutoCropForRotation(
        image.width,
        image.height,
        adjustments.orientationSteps || 0,
        ratio,
        effectiveRotation,
        next,
        delta,
      );
    }
    if (!next) return;
    const percent = toPercent(next);
    setCrop(percent);
    lastValid.current = percent;
    if (liveRotation === null) {
      previous.current = {
        path: image.path,
        rotation,
        aspect,
        crop: adjustments.crop,
        orientation: adjustments.orientationSteps || 0,
      };
      // Opening a crop with no saved rectangle is a preview, not an edit.
      if (originalCrop && JSON.stringify(next) !== JSON.stringify(originalCrop)) setAdjustments({ crop: next });
    }
  }, [
    image,
    width,
    height,
    isCropping,
    adjustments.crop,
    adjustments.rotation,
    adjustments.aspectRatio,
    adjustments.orientationSteps,
    liveRotation,
    setAdjustments,
    toPercent,
    toPixel,
  ]);

  const handleCropChange = useCallback(
    (_: Crop, percent: PercentCrop) => {
      if (!width || !height) return;
      const target = toPixel(percent);
      const bounds = {
        width,
        height,
        rotation: liveRotation ?? adjustments.rotation ?? 0,
        minimum: Math.min(64, width, height),
      };
      const next = withinImage(target, bounds)
        ? target
        : lastValid.current
          ? constrainRect(toPixel(lastValid.current), target, bounds)
          : null;
      if (!next) return;
      const valid = toPercent({ unit: 'px', ...next });
      lastValid.current = valid;
      setCrop(valid);
    },
    [width, height, liveRotation, adjustments.rotation, toPercent, toPixel],
  );

  const handleCropComplete = useCallback(
    (_: Crop, percent: PercentCrop) => {
      if (!image || !percent.width || !percent.height || liveRotation !== null) return;
      const pixel = toPixel(percent);
      // Keep fractional source coordinates; rounding each edge independently breaks locked ratios.
      if (!withinImage(pixel, { width, height, rotation: adjustments.rotation || 0 })) return;
      if (JSON.stringify(pixel) !== JSON.stringify(adjustments.crop)) setAdjustments({ crop: pixel });
    },
    [image, width, height, liveRotation, adjustments.crop, adjustments.rotation, toPixel, setAdjustments],
  );
  return { crop, handleCropChange, handleCropComplete };
}
