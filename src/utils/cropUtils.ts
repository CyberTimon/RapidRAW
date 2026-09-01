import { Crop } from 'react-image-crop';
import { Adjustments } from './adjustments';

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
    unit: 'px',
    x: Math.round((W - w_c) / 2),
    y: Math.round((H - h_c) / 2),
    width: Math.round(w_c),
    height: Math.round(h_c),
  };
}

export function isCropWithinBounds(crop: Crop, imageW: number, imageH: number, rotation: number): boolean {
  const cx = imageW / 2;
  const cy = imageH / 2;
  const rad = (-rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const pts = [
    { x: crop.x, y: crop.y },
    { x: crop.x + crop.width, y: crop.y },
    { x: crop.x, y: crop.y + crop.height },
    { x: crop.x + crop.width, y: crop.y + crop.height },
  ];
  for (let i = 0; i < 4; i++) {
    const nx = cos * (pts[i].x - cx) - sin * (pts[i].y - cy) + cx;
    const ny = sin * (pts[i].x - cx) + cos * (pts[i].y - cy) + cy;
    if (nx < -1 || nx > imageW + 1 || ny < -1 || ny > imageH + 1) return false;
  }
  return true;
}

export function calculateAreaPreservingCrop(
  imageWidth: number,
  imageHeight: number,
  orientationSteps: number,
  aspectRatio: number | null,
  rotation: number,
  currentCrop: Crop | null | undefined,
): Crop | null {
  if (!aspectRatio || aspectRatio <= 0 || !currentCrop || !currentCrop.width || !currentCrop.height) return null;

  const { width: W, height: H } = getOrientedDimensions(imageWidth, imageHeight, orientationSteps);

  const area = currentCrop.width * currentCrop.height;
  const newH = Math.sqrt(area / aspectRatio);
  const newW = aspectRatio * newH;
  const centerX = currentCrop.x + currentCrop.width / 2;
  const centerY = currentCrop.y + currentCrop.height / 2;

  const candidate: Crop = {
    unit: 'px',
    x: Math.round(centerX - newW / 2),
    y: Math.round(centerY - newH / 2),
    width: Math.round(newW),
    height: Math.round(newH),
  };

  return isCropWithinBounds(candidate, W, H, rotation) ? candidate : null;
}

function rotateCropCenter(
  crop: Crop,
  orientedWidth: number,
  orientedHeight: number,
  deltaDegrees: number,
): Crop {
  const rad = (deltaDegrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = orientedWidth / 2;
  const cy = orientedHeight / 2;
  const px = crop.x + crop.width / 2 - cx;
  const py = crop.y + crop.height / 2 - cy;
  const rx = px * cos - py * sin;
  const ry = px * sin + py * cos;
  return {
    unit: 'px',
    x: Math.round(cx + rx - crop.width / 2),
    y: Math.round(cy + ry - crop.height / 2),
    width: crop.width,
    height: crop.height,
  };
}

export function calculateAutoCropForRotation(
  imageWidth: number,
  imageHeight: number,
  orientationSteps: number = 0,
  aspectRatio: number | null,
  newRotation: number,
  currentCrop: Crop | null = null,
  rotationDelta: number = 0,
): Crop | null {
  const { width: W, height: H } = getOrientedDimensions(imageWidth, imageHeight, orientationSteps);
  const A = aspectRatio || (W > 0 && H > 0 ? W / H : 1);

  if (!currentCrop) {
    return calculateCenteredCrop(imageWidth, imageHeight, orientationSteps, A, newRotation);
  }

  const followedCrop = rotationDelta !== 0 ? rotateCropCenter(currentCrop, W, H, rotationDelta) : currentCrop;

  if (isCropWithinBounds(followedCrop, W, H, newRotation)) {
    return followedCrop;
  }

  let low = 0.1;
  let high = 1.0;
  let bestCrop = followedCrop;

  for (let i = 0; i < 12; i++) {
    const mid = (low + high) / 2;
    const cx = followedCrop.x + followedCrop.width / 2;
    const cy = followedCrop.y + followedCrop.height / 2;
    const nw = followedCrop.width * mid;
    const nh = followedCrop.height * mid;
    const testCrop: Crop = {
      unit: 'px',
      x: cx - nw / 2,
      y: cy - nh / 2,
      width: nw,
      height: nh,
    };

    if (isCropWithinBounds(testCrop, W, H, newRotation)) {
      bestCrop = testCrop;
      low = mid;
    } else {
      high = mid;
    }
  }

  if (low < 0.15) {
    return calculateCenteredCrop(imageWidth, imageHeight, orientationSteps, A, newRotation);
  }

  return {
    unit: 'px',
    x: Math.ceil(bestCrop.x),
    y: Math.ceil(bestCrop.y),
    width: Math.floor(bestCrop.width),
    height: Math.floor(bestCrop.height),
  };
}

export function calculateStraightenAngle(dx: number, dy: number): number {
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);
  let targetAngle;

  if (angle > -45 && angle <= 45) {
    targetAngle = 0;
  } else if (angle > 45 && angle <= 135) {
    targetAngle = 90;
  } else if (angle > 135 || angle <= -135) {
    targetAngle = 180;
  } else {
    targetAngle = -90;
  }

  let correction = targetAngle - angle;
  if (correction > 180) correction -= 360;
  if (correction < -180) correction += 360;

  return correction;
}

export function guidedCropToPixelCrop(
  crop: [number, number, number, number],
  adjustments: Adjustments,
  image: { width: number; height: number },
): Crop {
  let [x, y, w, h] = crop;
  const steps = ((adjustments.orientationSteps % 4) + 4) % 4;
  if (steps === 1) {
    [x, y, w, h] = [1 - y - h, x, h, w];
  } else if (steps === 2) {
    x = 1 - x - w;
    y = 1 - y - h;
  } else if (steps === 3) {
    [x, y, w, h] = [y, 1 - x - w, h, w];
  }
  if (adjustments.flipHorizontal) {
    x = 1 - x - w;
  }
  if (adjustments.flipVertical) {
    y = 1 - y - h;
  }
  const { width: baseW, height: baseH } = getOrientedDimensions(
    image.width,
    image.height,
    adjustments.orientationSteps,
  );
  let px = Math.ceil(x * baseW);
  let py = Math.ceil(y * baseH);
  let pw = Math.floor(w * baseW);
  let ph = Math.floor(h * baseH);
  px = Math.max(0, Math.min(px, baseW));
  py = Math.max(0, Math.min(py, baseH));
  pw = Math.max(0, Math.min(pw, baseW - px));
  ph = Math.max(0, Math.min(ph, baseH - py));
  return { unit: 'px', x: px, y: py, width: pw, height: ph };
}
