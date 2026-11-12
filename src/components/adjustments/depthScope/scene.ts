import { RelightLight } from '../../../utils/adjustments';
import {
  DEPTH_SCALE,
  DepthPreview,
  Frame,
  MAX_LIGHTS,
  MODE_FOG,
  MODE_LENS,
  MODE_MASK,
  MODE_MOTION,
  MODE_RELIGHT,
  Overlay,
  PointUniforms,
  fromDisplay,
  toDisplay,
} from './renderer';

export type DepthScene =
  | { kind: 'lensBlur'; minDepth: number; maxDepth: number; minFade: number; maxFade: number; amount: number }
  | { kind: 'depthMask'; minDepth: number; maxDepth: number; minFade: number; maxFade: number }
  | {
      kind: 'fog';
      amount: number;
      start: number;
      density: number;
      height: number;
      temperature: number;
      tint: number;
    }
  | { kind: 'relight'; lights: Array<RelightLight>; activeId: string | null; ambient: number; softness: number }
  | { kind: 'motion'; amount: number; parallax: number; angle: number; radial: boolean };

type RangeScene = Extract<DepthScene, { kind: 'lensBlur' | 'depthMask' }>;

const isRange = (scene: DepthScene): scene is RangeScene => scene.kind === 'lensBlur' || scene.kind === 'depthMask';

export type ScenePatch = Record<string, number>;

export type HandleStyle = 'plane' | 'fade' | 'range' | 'light' | 'axis';
export type HandleDrag = 'depth' | 'x' | 'y' | 'free';
export type Vec3 = [number, number, number];

export interface Handle {
  id: string;
  z: number;
  style: HandleStyle;
  drag: HandleDrag;
  origin: Vec3;
  knob: Vec3;
  arms: Array<[Vec3, Vec3]>;
  label: string;
  contour: [number, number];
  color?: RGB;
}

export interface DragTarget {
  x: number;
  y: number;
  z: number;
}

export const LIGHT_NEAREST = -0.25;

export interface Palette {
  accent: [number, number, number];
  line: [number, number, number];
}

type RGB = [number, number, number];

const AXIS_COLORS: Record<'x' | 'y' | 'z', RGB> = {
  x: [0.94, 0.45, 0.45],
  y: [0.48, 0.86, 0.54],
  z: [0.45, 0.66, 1],
};
const ARM_PIXELS = 38;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const FOG_NEAR = 0.1;
const FOG_Z_NEAR = 1 / (1 + FOG_NEAR);
const FOG_Z_RANGE = 1 / FOG_NEAR - FOG_Z_NEAR;

const fogStartDistance = (start: number) => {
  const nearness = 1 / (start * FOG_Z_RANGE + FOG_Z_NEAR) - FOG_NEAR;
  return 1 - clamp(nearness, 0, 1);
};

const fogStartFromDistance = (z: number) => {
  const nearness = clamp(1 - z, 0, 1);
  return (1 / (nearness + FOG_NEAR) - FOG_Z_NEAR) / FOG_Z_RANGE;
};

const lightDistance = (light: RelightLight) => (light.depth / 100) * (1 - LIGHT_NEAREST) + LIGHT_NEAREST;

const tintColor = (temperature: number, tint: number): RGB => {
  const t = temperature / 100;
  const m = tint / 100;
  const rgb: RGB = [1 + 0.45 * t + 0.15 * m, 1 - 0.35 * m, 1 - 0.45 * t + 0.15 * m];
  const peak = Math.max(...rgb, 1e-3);
  return rgb.map((c) => Math.max(0, c / peak)) as RGB;
};

const lightRgb = (light: RelightLight): RGB => {
  const hex = parseInt((light.color || '#ffffff').slice(1), 16);
  const base = [hex >> 16, hex >> 8, hex].map((c) => ((c & 255) / 255) ** 2.2);
  const t = (light.temperature ?? 0) / 100;
  const m = (light.tint ?? 0) / 100;
  return [base[0] * (1 + 0.45 * t + 0.15 * m), base[1] * (1 - 0.35 * m), base[2] * (1 - 0.45 * t + 0.15 * m)];
};

const displayLightColor = (light: RelightLight): RGB => {
  const rgb = lightRgb(light).map((c) => Math.max(0, c) ** (1 / 2.2));
  const peak = Math.max(...rgb, 1e-3);
  return rgb.map((c) => c / peak) as RGB;
};

const visibleLights = (lights: Array<RelightLight>) =>
  lights.filter((light) => (light as RelightLight & { visible?: boolean }).visible !== false);

const packLights = (lights: Array<RelightLight>, aspect: [number, number]) => {
  const data = new Float32Array(MAX_LIGHTS * 16);
  const used = visibleLights(lights).slice(0, MAX_LIGHTS);
  used.forEach((light, i) => {
    const rgb = lightRgb(light);
    const luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    const strength = ((Math.max(light.intensity ?? 40, 0) / 100) * 4) / Math.max(luma, 1e-3);
    const radius = 0.05 + ((light.radius ?? 30) / 100) * 1.45;
    const angle = ((light.angle ?? 135) * Math.PI) / 180;
    const elevation = (clamp(light.elevation ?? 60, -180, 180) * Math.PI) / 180;
    const planeX = Math.cos(angle) * Math.cos(elevation);
    const planeY = -Math.sin(angle) * Math.cos(elevation);
    let kind = 0;
    let vector = [0, 0, 0];
    let outer = 0;
    let inner = 0;
    if (light.type === 'directional') {
      kind = 2;
      vector = [planeX, planeY, -Math.sin(elevation)];
    } else if (light.type === 'spot') {
      kind = 1;
      vector = [planeX, planeY, Math.sin(elevation)];
      const half = ((5 + (clamp(light.cone ?? 40, 0, 100) / 100) * 80) * Math.PI) / 180;
      const feather = clamp(light.feather ?? 50, 0, 100) / 100;
      outer = Math.cos(half);
      inner = Math.cos(half * (1 - feather));
    }
    data.set(
      [
        kind,
        (light.x - 0.5) * aspect[0],
        (light.y - 0.5) * aspect[1],
        lightDistance(light),
        ...rgb.map((c) => Math.max(c, 0) * strength),
        radius * radius,
        ...vector,
        outer,
        inner,
        0,
        0,
        0,
      ],
      i * 16,
    );
  });
  return { lights: data, count: used.length };
};

const nearnessAt = (preview: DepthPreview, u: number, v: number) => {
  const x = clamp(Math.floor(u * preview.width), 0, preview.width - 1);
  const y = clamp(Math.floor(v * preview.height), 0, preview.height - 1);
  return preview.pixels[(y * preview.width + x) * 4 + 3] / 255;
};

const worldXY = (u: number, v: number, frame: Frame, extent: [number, number]): [number, number] => {
  const [px, py] = toDisplay(u, v, frame);
  return [(px - 0.5) * extent[0], (0.5 - py) * extent[1]];
};

export const sceneUniforms = (
  scene: DepthScene,
  preview: DepthPreview,
  effectAspect: [number, number],
  reveal: number,
): PointUniforms => {
  switch (scene.kind) {
    case 'lensBlur':
      return {
        mode: MODE_LENS,
        reveal,
        lens: {
          min: scene.minDepth / 100,
          max: scene.maxDepth / 100,
          minFade: scene.minFade / 100,
          maxFade: scene.maxFade / 100,
          amount: 0.35 + 0.65 * clamp(scene.amount / 100, 0, 1),
        },
      };
    case 'depthMask':
      return {
        mode: MODE_MASK,
        reveal,
        lens: {
          min: scene.minDepth / 100,
          max: scene.maxDepth / 100,
          minFade: scene.minFade / 100,
          maxFade: scene.maxFade / 100,
          amount: 1,
        },
      };
    case 'fog':
      return {
        mode: MODE_FOG,
        reveal,
        fog: {
          amount: clamp(scene.amount / 100, 0, 1),
          start: Math.min(clamp(scene.start / 100, 0, 1), 0.99),
          density: 0.5 + clamp(scene.density / 100, 0, 1) * 7.5,
          height: clamp(scene.height / 100, 0, 1) * 6,
          color: tintColor(scene.temperature, scene.tint).map((c) => c * 0.86) as RGB,
        },
      };
    case 'relight':
      return {
        mode: MODE_RELIGHT,
        reveal,
        relight: {
          ambientGain: 2 ** (scene.ambient / 50),
          softness: clamp(scene.softness / 100, 0, 1),
          ...packLights(scene.lights, effectAspect),
        },
      };
    case 'motion': {
      const angle = (scene.angle * Math.PI) / 180;
      return {
        mode: MODE_MOTION,
        reveal,
        motion: {
          amount: clamp(scene.amount / 100, 0, 1) ** 1.5,
          parallax: clamp(scene.parallax / 100, 0, 1),
          reference: Math.max(preview.meanNearness, 0.05),
          radial: scene.radial,
          axis: [Math.cos(angle), Math.sin(angle)],
        },
      };
    }
  }
};

const rangeKeys = (scene: RangeScene) =>
  scene.kind === 'lensBlur'
    ? { min: 'lensBlurMinDepth', max: 'lensBlurMaxDepth', minFade: 'lensBlurMinFade', maxFade: 'lensBlurMaxFade' }
    : { min: 'minDepth', max: 'maxDepth', minFade: 'minFade', maxFade: 'maxFade' };

const lensRange = (scene: RangeScene, center: number): ScenePatch => {
  const keys = rangeKeys(scene);
  const width = scene.maxDepth - scene.minDepth;
  const min = Math.round(clamp(center * 100 - width / 2, 0, 100 - width));
  const max = min + width;
  return {
    [keys.min]: min,
    [keys.max]: max,
    [keys.minFade]: Math.min(scene.minFade, min),
    [keys.maxFade]: Math.min(scene.maxFade, 100 - max),
  };
};

const lightDepthValue = (z: number) => Math.round(clamp(((z - LIGHT_NEAREST) / (1 - LIGHT_NEAREST)) * 100, 0, 100));

export const sceneHandles = (
  scene: DepthScene,
  frame: Frame,
  extent: [number, number],
  pixelsPerUnit: (p: Vec3) => number,
): Array<Handle> => {
  const [hx, hy] = [extent[0] / 2, extent[1] / 2];
  const plane = (id: string, z: number, style: HandleStyle, label: string): Handle => {
    const knob: Vec3 = [hx, hy, -z * DEPTH_SCALE];
    return { id, z, style, drag: 'depth', origin: knob, knob, arms: [], label, contour: [z, z] };
  };
  switch (scene.kind) {
    case 'lensBlur':
    case 'depthMask': {
      const { minDepth, maxDepth, minFade, maxFade } = scene;
      const near = 1 - maxDepth / 100;
      const far = 1 - minDepth / 100;
      return [
        plane('farFade', 1 - (minDepth - minFade) / 100, 'fade', `${minFade}`),
        plane('nearFade', 1 - (maxDepth + maxFade) / 100, 'fade', `${maxFade}`),
        { ...plane('range', (near + far) / 2, 'range', `${100 - maxDepth}–${100 - minDepth}`), contour: [near, far] },
        plane('far', far, 'plane', `${100 - minDepth}`),
        plane('near', near, 'plane', `${100 - maxDepth}`),
      ];
    }
    case 'fog':
      return [plane('start', fogStartDistance(Math.min(scene.start / 100, 0.99)), 'plane', `${scene.start}`)];
    case 'relight': {
      const light = scene.lights.find((l) => l.id === scene.activeId);
      if (!light || light.type === 'directional') return [];
      const z = lightDistance(light);
      const [x, y] = worldXY(light.x, light.y, frame, extent);
      const [px, py] = toDisplay(light.x, light.y, frame).map((v) => Math.round(v * 100));
      const origin: Vec3 = [x, y, -z * DEPTH_SCALE];
      const arm = ARM_PIXELS / Math.max(pixelsPerUnit(origin), 1e-3);
      const contour: [number, number] = [z, z];
      const axis = (id: string, drag: HandleDrag, key: 'x' | 'y' | 'z', label: string): Handle => {
        const dir = key === 'x' ? [1, 0, 0] : key === 'y' ? [0, 1, 0] : [0, 0, 1];
        const at = (t: number): Vec3 => [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
        return {
          id,
          z,
          style: 'axis',
          drag,
          origin,
          knob: at(arm),
          arms: [
            [at(arm * 0.45), at(arm)],
            [at(-arm * 0.45), at(-arm * 0.7)],
          ],
          label,
          contour,
          color: AXIS_COLORS[key],
        };
      };
      return [
        axis('lightX', 'x', 'x', `X ${px}`),
        axis('lightY', 'y', 'y', `Y ${py}`),
        axis('lightZ', 'depth', 'z', `Z ${light.depth}`),
        {
          id: 'light',
          z,
          style: 'light',
          drag: 'free',
          origin,
          knob: origin,
          arms: [],
          label: `X ${px} · Y ${py}`,
          contour,
        },
      ];
    }
    default:
      return [];
  }
};

export const applyHandle = (
  scene: DepthScene,
  handle: Handle,
  target: DragTarget,
  frame: Frame,
  extent: [number, number],
): ScenePatch | null => {
  const { z } = target;
  if (isRange(scene)) {
    const v = Math.round(clamp((1 - z) * 100, 0, 100));
    const { minDepth, maxDepth, minFade, maxFade } = scene;
    const keys = rangeKeys(scene);
    switch (handle.id) {
      case 'far': {
        const next = clamp(v, 0, maxDepth);
        return { [keys.min]: next, [keys.minFade]: Math.min(minFade, next) };
      }
      case 'near': {
        const next = clamp(v, minDepth, 100);
        return { [keys.max]: next, [keys.maxFade]: Math.min(maxFade, 100 - next) };
      }
      case 'farFade':
        return { [keys.minFade]: minDepth - clamp(v, 0, minDepth) };
      case 'nearFade':
        return { [keys.maxFade]: clamp(v, maxDepth, 100) - maxDepth };
      case 'range':
        return lensRange(scene, 1 - z);
    }
  }
  if (scene.kind === 'fog' && handle.id === 'start') {
    return { fogStart: Math.round(clamp(fogStartFromDistance(z) * 100, 0, 99)) };
  }
  if (scene.kind === 'relight') {
    if (handle.drag === 'depth') return { depth: lightDepthValue(z) };
    const [u, v] = fromDisplay(clamp(target.x / extent[0] + 0.5, 0, 1), clamp(0.5 - target.y / extent[1], 0, 1), frame);
    return { x: u, y: v };
  }
  return null;
};

export const clickHandle = (scene: DepthScene, handles: Array<Handle>) => {
  const id = isRange(scene) ? 'range' : scene.kind === 'fog' ? 'start' : null;
  return handles.find((h) => h.id === id) ?? null;
};

type Push = (list: number[], p: number[], color: RGB, alpha: number, size?: number, shape?: number) => void;

const push: Push = (list, p, color, alpha, size = 0, shape = 0) => {
  list.push(p[0], p[1], p[2], color[0], color[1], color[2], alpha, size, shape);
};

const rect = (
  overlay: Overlay,
  extent: [number, number],
  z: number,
  color: RGB,
  fill: number,
  line: number,
  dashed: boolean,
) => {
  const [hx, hy] = [extent[0] / 2, extent[1] / 2];
  const Z = -z * DEPTH_SCALE;
  const corners = [
    [-hx, -hy, Z],
    [hx, -hy, Z],
    [hx, hy, Z],
    [-hx, hy, Z],
  ];
  if (fill > 0) {
    for (const i of [0, 1, 2, 0, 2, 3]) push(overlay.triangles, corners[i], color, fill);
  }
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const segments = dashed ? 14 : 1;
    for (let s = 0; s < segments; s += dashed ? 2 : 1) {
      const t0 = s / segments;
      const t1 = (s + 1) / segments;
      push(overlay.lines, [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0, Z], color, line);
      push(overlay.lines, [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1, Z], color, line);
    }
  }
};

const segment = (overlay: Overlay, a: number[], b: number[], color: RGB, alpha: number, dashes = 0) => {
  const count = dashes > 0 ? dashes * 2 : 1;
  for (let i = 0; i < count; i += dashes > 0 ? 2 : 1) {
    const t0 = i / count;
    const t1 = (i + 1) / count;
    push(
      overlay.lines,
      a.map((v, k) => v + (b[k] - v) * t0),
      color,
      alpha,
    );
    push(
      overlay.lines,
      a.map((v, k) => v + (b[k] - v) * t1),
      color,
      alpha,
    );
  }
};

const brackets = (overlay: Overlay, extent: [number, number], color: RGB) => {
  const [hx, hy] = [extent[0] / 2, extent[1] / 2];
  const len = Math.min(hx, hy) * 0.16;
  for (const z of [0, -DEPTH_SCALE]) {
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const c = [sx * hx, sy * hy, z];
        push(overlay.lines, c, color, 0.32);
        push(overlay.lines, [c[0] - sx * len, c[1], z], color, 0.32);
        push(overlay.lines, c, color, 0.32);
        push(overlay.lines, [c[0], c[1] - sy * len, z], color, 0.32);
      }
    }
  }
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      push(overlay.lines, [sx * hx, sy * hy, 0], color, 0.1);
      push(overlay.lines, [sx * hx, sy * hy, -DEPTH_SCALE], color, 0.1);
    }
  }
};

export const sceneOverlay = (
  scene: DepthScene,
  handles: Array<Handle>,
  preview: DepthPreview | null,
  frame: Frame,
  extent: [number, number],
  palette: Palette,
  hoverId: string | null,
  activeId: string | null,
): Overlay => {
  const overlay: Overlay = { lines: [], triangles: [], points: [] };
  brackets(overlay, extent, palette.line);

  const fogColor: RGB | null = scene.kind === 'fog' ? tintColor(scene.temperature, scene.tint) : null;

  if (isRange(scene)) {
    const near = handles.find((h) => h.id === 'near')!;
    const far = handles.find((h) => h.id === 'far')!;
    const rangeHot = hoverId === 'range' || activeId === 'range';
    const steps = 6;
    for (let i = 1; i < steps; i++) {
      const z = near.z + ((far.z - near.z) * i) / steps;
      rect(overlay, extent, z, palette.accent, 0, rangeHot ? 0.16 : 0.06, false);
    }
    const [hx, hy] = [extent[0] / 2, extent[1] / 2];
    segment(
      overlay,
      [hx, hy, -near.z * DEPTH_SCALE],
      [hx, hy, -far.z * DEPTH_SCALE],
      palette.accent,
      rangeHot ? 0.9 : 0.45,
    );
  }

  for (const handle of handles) {
    const hot = handle.id === hoverId || handle.id === activeId;
    if (handle.style === 'light' || handle.style === 'axis') continue;
    const color = fogColor ?? palette.accent;
    const knob = handle.knob;
    if (handle.style === 'range') {
      push(overlay.points, knob, color, hot ? 1 : 0.7, hot ? 9 : 6, 0);
      if (hot) push(overlay.points, knob, color, 0.9, 18, 2);
      continue;
    }
    if (handle.style === 'plane') {
      rect(overlay, extent, handle.z, color, hot ? 0.13 : 0.06, hot ? 0.95 : 0.6, false);
    } else {
      rect(overlay, extent, handle.z, color, 0, hot ? 0.7 : 0.28, true);
    }
    push(overlay.points, knob, color, hot ? 1 : 0.85, handle.style === 'plane' ? 7 : 5, 0);
    if (hot) push(overlay.points, knob, color, 0.9, 18, 2);
  }

  if (scene.kind === 'relight') {
    const active = scene.lights.find((l) => l.id === scene.activeId);
    if (active && active.type !== 'directional') {
      const [hx, hy] = [extent[0] / 2, extent[1] / 2];
      const [x, y, Z] = handles.find((h) => h.id === 'light')?.origin ?? [0, 0, 0];
      const focus = activeId ?? hoverId;
      const tracks: Array<[string, number[], number[], RGB]> = [
        ['lightX', [-hx, y, Z], [hx, y, Z], AXIS_COLORS.x],
        ['lightY', [x, -hy, Z], [x, hy, Z], AXIS_COLORS.y],
        ['lightZ', [x, y, -LIGHT_NEAREST * DEPTH_SCALE], [x, y, -DEPTH_SCALE], AXIS_COLORS.z],
      ];
      for (const [id, a, b, color] of tracks) {
        if (focus === id) segment(overlay, a, b, color, activeId ? 0.55 : 0.35, 18);
        else if (focus === 'light' && id !== 'lightZ') segment(overlay, a, b, color, 0.2, 18);
      }
      for (const handle of handles) {
        if (handle.style !== 'axis' || !handle.color) continue;
        const hot = handle.id === hoverId || handle.id === activeId;
        const alpha = hot ? 1 : focus && focus !== handle.id ? 0.3 : 0.85;
        const tail = handle.arms[1][1];
        segment(overlay, tail, handle.knob, handle.color, alpha);
        for (let i = 1; i < 6; i++) {
          const t = 0.3 + (0.7 * i) / 6;
          const bead = handle.origin.map((v, k) => v + (handle.knob[k] - v) * t);
          push(overlay.points, bead, handle.color, alpha * 0.9, 2.5, 0);
        }
        push(overlay.points, handle.knob, handle.color, alpha, hot ? 8 : 7, 0);
        push(overlay.points, handle.knob, handle.color, hot ? 0.9 : alpha * 0.55, hot ? 17 : 13, 2);
      }
    }
    for (const light of visibleLights(scene.lights)) {
      if (light.type === 'directional') continue;
      const active = light.id === scene.activeId;
      const hot = active && (hoverId === 'light' || activeId === 'light');
      const [x, y] = worldXY(light.x, light.y, frame, extent);
      const z = lightDistance(light);
      const color = displayLightColor(light);
      const position = [x, y, -z * DEPTH_SCALE];
      if (preview) {
        const surface = 1 - nearnessAt(preview, light.x, light.y);
        const ground = [x, y, -surface * DEPTH_SCALE];
        push(overlay.lines, position, color, active ? 0.55 : 0.25);
        push(overlay.lines, ground, color, active ? 0.55 : 0.25);
        push(overlay.points, ground, color, active ? 0.7 : 0.35, 9, 2);
      }
      push(overlay.points, position, color, active ? 0.95 : 0.45, active ? 30 : 22, 1);
      push(overlay.points, position, [1, 1, 1], active ? 1 : 0.6, active ? 6 : 4, 0);
      if (hot) push(overlay.points, position, palette.accent, 0.95, 20, 2);
    }
  }

  return overlay;
};
