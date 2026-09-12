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

function rotateCropCenter(crop: Crop, orientedWidth: number, orientedHeight: number, deltaDegrees: number): Crop {
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

export function moveCropInsideBounds(
  crop: Crop,
  deltaX: number,
  deltaY: number,
  imageW: number,
  imageH: number,
  rotation: number,
): Crop {
  const fullTarget = { ...crop, x: crop.x + deltaX, y: crop.y + deltaY };
  if (isCropWithinBounds(fullTarget, imageW, imageH, rotation)) {
    return { ...crop, x: Math.round(fullTarget.x), y: Math.round(fullTarget.y) };
  }

  let bestX = crop.x;
  let loX = 0,
    hiX = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (loX + hiX) / 2;
    const testCrop = { ...crop, x: crop.x + deltaX * mid };
    if (isCropWithinBounds(testCrop, imageW, imageH, rotation)) {
      bestX = testCrop.x;
      loX = mid;
    } else {
      hiX = mid;
    }
  }

  let bestY = crop.y;
  let loY = 0,
    hiY = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (loY + hiY) / 2;
    const testCrop = { ...crop, x: bestX, y: crop.y + deltaY * mid };
    if (isCropWithinBounds(testCrop, imageW, imageH, rotation)) {
      bestY = testCrop.y;
      loY = mid;
    } else {
      hiY = mid;
    }
  }

  return {
    ...crop,
    x: Math.round(bestX),
    y: Math.round(bestY),
  };
}

export function forceCropInBounds(crop: Crop, imageW: number, imageH: number, rotation: number): Crop {
  if (isCropWithinBounds(crop, imageW, imageH, rotation)) {
    return crop;
  }

  if (rotation === 0) {
    let { x, y, width, height } = crop;
    x = Math.max(0, Math.min(x, imageW - width));
    y = Math.max(0, Math.min(y, imageH - height));
    return { ...crop, x, y };
  }

  const imgCx = imageW / 2;
  const imgCy = imageH / 2;
  const cropCx = crop.x + crop.width / 2;
  const cropCy = crop.y + crop.height / 2;

  const dx = imgCx - cropCx;
  const dy = imgCy - cropCy;

  let low = 0;
  let high = 1;
  let bestValid = crop;

  for (let i = 0; i < 15; i++) {
    const mid = (low + high) / 2;
    const testCrop = { ...crop, x: crop.x + dx * mid, y: crop.y + dy * mid };
    if (isCropWithinBounds(testCrop, imageW, imageH, rotation)) {
      bestValid = testCrop;
      high = mid;
    } else {
      low = mid;
    }
  }

  return bestValid;
}

export function zoomCrop(
  crop: Crop,
  scaleFactor: number,
  imageW: number,
  imageH: number,
  rotation: number,
  aspectRatio: number | null,
  mouseX?: number,
  mouseY?: number,
): Crop {
  const A = aspectRatio || (crop.height > 0 ? crop.width / crop.height : 1);
  const MIN_SIZE = 64;

  let targetW = crop.width * scaleFactor;
  let targetH = targetW / A;

  if (targetW < MIN_SIZE || targetH < MIN_SIZE) {
    targetW = Math.max(MIN_SIZE, MIN_SIZE * A);
    targetH = targetW / A;
  }

  const originX = mouseX ?? crop.x + crop.width / 2;
  const originY = mouseY ?? crop.y + crop.height / 2;

  const clampedOriginX = Math.max(crop.x, Math.min(crop.x + crop.width, originX));
  const clampedOriginY = Math.max(crop.y, Math.min(crop.y + crop.height, originY));

  const relX = (clampedOriginX - crop.x) / crop.width;
  const relY = (clampedOriginY - crop.y) / crop.height;

  const testCrop = (w: number): Crop => {
    const h = w / A;
    return {
      unit: 'px',
      x: clampedOriginX - relX * w,
      y: clampedOriginY - relY * h,
      width: w,
      height: h,
    };
  };

  const initial = testCrop(targetW);

  if (scaleFactor <= 1) {
    return forceCropInBounds(initial, imageW, imageH, rotation);
  }

  const clamped = forceCropInBounds(initial, imageW, imageH, rotation);
  if (isCropWithinBounds(clamped, imageW, imageH, rotation)) {
    return clamped;
  }

  let low = crop.width;
  let high = targetW;
  let bestCrop = crop;

  for (let i = 0; i < 15; i++) {
    const mid = (low + high) / 2;
    const candidate = testCrop(mid);
    const candidateClamped = forceCropInBounds(candidate, imageW, imageH, rotation);

    if (isCropWithinBounds(candidateClamped, imageW, imageH, rotation)) {
      bestCrop = candidateClamped;
      low = mid;
    } else {
      high = mid;
    }
  }

  return bestCrop;
}
