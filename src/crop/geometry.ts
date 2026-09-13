export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type Handle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
export interface Bounds {
  width: number;
  height: number;
  rotation: number;
  minimum?: number;
}

export function withinImage(crop: Rect, bounds: Bounds) {
  const minimum = Math.min(bounds.minimum ?? 1, bounds.width, bounds.height);
  if (
    ![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) ||
    crop.width < minimum ||
    crop.height < minimum
  )
    return false;
  const angle = (-bounds.rotation * Math.PI) / 180,
    cos = Math.cos(angle),
    sin = Math.sin(angle);
  return [0, crop.width].every((dx) =>
    [0, crop.height].every((dy) => {
      const x = crop.x + dx - bounds.width / 2,
        y = crop.y + dy - bounds.height / 2;
      const u = cos * x - sin * y + bounds.width / 2,
        v = sin * x + cos * y + bounds.height / 2;
      return u >= -1e-7 && v >= -1e-7 && u <= bounds.width + 1e-7 && v <= bounds.height + 1e-7;
    }),
  );
}

export function constrainRect(start: Rect, target: Rect, bounds: Bounds): Rect {
  if (withinImage(target, bounds)) return target;
  let low = 0,
    high = 1,
    best = start;
  for (let i = 0; i < 32; i++) {
    const t = (low + high) / 2;
    const candidate = {
      x: start.x + (target.x - start.x) * t,
      y: start.y + (target.y - start.y) * t,
      width: start.width + (target.width - start.width) * t,
      height: start.height + (target.height - start.height) * t,
    };
    if (withinImage(candidate, bounds)) {
      best = candidate;
      low = t;
    } else high = t;
  }
  return best;
}

export function resizeRect(
  start: Rect,
  handle: Handle,
  dx: number,
  dy: number,
  ratio: number | null,
  centered = false,
): Rect {
  const horizontal = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0;
  const vertical = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0;
  const multiplier = centered ? 2 : 1;
  let width = start.width + horizontal * dx * multiplier;
  let height = start.height + vertical * dy * multiplier;
  if (ratio) {
    if (!horizontal) width = height * ratio;
    else if (!vertical) height = width / ratio;
    else {
      // Project a corner's pointer motion onto the fixed-ratio diagonal.
      const delta = ((horizontal * dx * ratio + vertical * dy) * multiplier) / (ratio * ratio + 1);
      height = start.height + delta;
      width = height * ratio;
    }
  }
  const cx = start.x + start.width / 2,
    cy = start.y + start.height / 2;
  return {
    width,
    height,
    x: centered || !horizontal ? cx - width / 2 : horizontal < 0 ? start.x + start.width - width : start.x,
    y: centered || !vertical ? cy - height / 2 : vertical < 0 ? start.y + start.height - height : start.y,
  };
}

export function angleDelta(start: number, end: number) {
  return ((end - start + 540) % 360) - 180;
}
