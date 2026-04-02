import { Crop } from 'react-image-crop';

export function getOrientedDimensions(
  imageWidth: number,
  imageHeight: number,
  orientationSteps: number,
): { width: number; height: number } {
  const isSwapped = orientationSteps === 1 || orientationSteps === 3;
  return {
    width: isSwapped ? imageHeight : imageWidth,
    height: isSwapped ? imageWidth : imageHeight,
  };
}

export function clampCrop(crop: Crop, maxWidth: number, maxHeight: number): Crop {
  // Existing behavior: size may shrink to fit
  const width = Math.max(0, Math.min(crop.width, maxWidth));
  const height = Math.max(0, Math.min(crop.height, maxHeight));
  const x = Math.max(0, Math.min(crop.x, maxWidth - width));
  const y = Math.max(0, Math.min(crop.y, maxHeight - height));

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export function clampCropInside(crop: Crop, maxWidth: number, maxHeight: number): Crop {
  let width = Math.max(0, crop.width);
  let height = Math.max(0, crop.height);

  // If crop is larger than bounds, shrink to bounds (can still be context-specific)
  if (width > maxWidth) {
    width = maxWidth;
  }
  if (height > maxHeight) {
    height = maxHeight;
  }

  let x = crop.x;
  let y = crop.y;

  if (x < 0) {
    x = 0;
  } else if (x + width > maxWidth) {
    x = maxWidth - width;
  }

  if (y < 0) {
    y = 0;
  } else if (y + height > maxHeight) {
    y = maxHeight - height;
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export function transformCropForOrientation(
  crop: Crop,
  oldOrientationSteps: number,
  newOrientationSteps: number,
  imageWidth: number,
  imageHeight: number,
): Crop {
  if (oldOrientationSteps === newOrientationSteps) {
    return crop;
  }

  const oldOriented = getOrientedDimensions(imageWidth, imageHeight, oldOrientationSteps);
  const newOriented = getOrientedDimensions(imageWidth, imageHeight, newOrientationSteps);

  let transformedCrop: Crop;

  const stepsDiff = (newOrientationSteps - oldOrientationSteps + 4) % 4;

  switch (stepsDiff) {
    case 1: // 90° clockwise
      transformedCrop = {
        x: crop.y,
        y: oldOriented.width - crop.x - crop.width,
        width: crop.height,
        height: crop.width,
      };
      break;
    case 2: // 180°
      transformedCrop = {
        x: oldOriented.width - crop.x - crop.width,
        y: oldOriented.height - crop.y - crop.height,
        width: crop.width,
        height: crop.height,
      };
      break;
    case 3: // 270° clockwise (90° counter-clockwise)
      transformedCrop = {
        x: oldOriented.height - crop.y - crop.height,
        y: crop.x,
        width: crop.height,
        height: crop.width,
      };
      break;
    default:
      transformedCrop = crop;
  }

  // Clamp to new dimensions with minimal movement, preserving size when possible.
  transformedCrop = clampCropInside(transformedCrop, newOriented.width, newOriented.height);

  return transformedCrop;
}

export function calculateCenteredCrop(
  imageWidth: number,
  imageHeight: number,
  orientationSteps: number,
  aspectRatio: number | null,
  rotation: number = 0,
): Crop | null {
  if (!aspectRatio || aspectRatio <= 0) return null;

  const { width: W, height: H } = getOrientedDimensions(imageWidth, imageHeight, orientationSteps);

  const angle = Math.abs(rotation);
  const rad = ((angle % 180) * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);

  const h_c = Math.min(H / (aspectRatio * sin + cos), W / (aspectRatio * cos + sin));
  const w_c = aspectRatio * h_c;

  return {
    x: Math.round((W - w_c) / 2),
    y: Math.round((H - h_c) / 2),
    width: Math.round(w_c),
    height: Math.round(h_c),
  };
}

export function applyAspectRatioToCrop(crop: Crop, aspectRatio: number, maxWidth: number, maxHeight: number): Crop {
  if (!aspectRatio || aspectRatio <= 0 || crop.width <= 0 || crop.height <= 0) {
    return clampCropInside(crop, maxWidth, maxHeight);
  }

  const currentWidth = crop.width;
  const currentHeight = crop.height;
  const targetWidth = currentHeight * aspectRatio;
  const targetHeight = currentWidth / aspectRatio;

  let newWidth = currentWidth;
  let newHeight = currentHeight;

  const deltaWidth = Math.abs(targetWidth - currentWidth);
  const deltaHeight = Math.abs(targetHeight - currentHeight);

  if (deltaWidth < deltaHeight) {
    newWidth = Math.min(targetWidth, maxWidth);
  } else {
    newHeight = Math.min(targetHeight, maxHeight);
  }

  const centerX = crop.x + currentWidth / 2;
  const centerY = crop.y + currentHeight / 2;

  const newX = centerX - newWidth / 2;
  const newY = centerY - newHeight / 2;

  return clampCropInside({ x: newX, y: newY, width: newWidth, height: newHeight }, maxWidth, maxHeight);
}

export function clampCropToRotation(
  crop: Crop,
  imageWidth: number,
  imageHeight: number,
  rotation: number,
  orientationSteps: number,
): Crop {
  const aspectRatio = crop.width > 0 && crop.height > 0 ? crop.width / crop.height : imageWidth / imageHeight;

  const maxRotatedCrop = calculateCenteredCrop(imageWidth, imageHeight, orientationSteps, aspectRatio, rotation);
  if (!maxRotatedCrop) {
    return clampCropInside(crop, imageWidth, imageHeight);
  }

  const width = Math.min(crop.width, maxRotatedCrop.width);
  const height = Math.min(crop.height, maxRotatedCrop.height);

  let x = crop.x;
  if (x < maxRotatedCrop.x) x = maxRotatedCrop.x;
  if (x + width > maxRotatedCrop.x + maxRotatedCrop.width) x = maxRotatedCrop.x + maxRotatedCrop.width - width;

  let y = crop.y;
  if (y < maxRotatedCrop.y) y = maxRotatedCrop.y;
  if (y + height > maxRotatedCrop.y + maxRotatedCrop.height) y = maxRotatedCrop.y + maxRotatedCrop.height - height;

  return {
    x: Math.round(Math.max(0, x)),
    y: Math.round(Math.max(0, y)),
    width: Math.round(Math.max(0, width)),
    height: Math.round(Math.max(0, height)),
  };
}
