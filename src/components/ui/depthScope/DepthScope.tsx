import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import clsx from 'clsx';
import { Invokes } from '../AppProperties';
import { useEditorStore } from '../../../store/useEditorStore';
import { useCtrlClickMenuGuard } from '../../../hooks/useCtrlClickMenuGuard';
import { Camera, DEPTH_SCALE, DepthPreview, DepthScopeRenderer, Frame, toDisplay } from './renderer';
import {
  DepthScene,
  Handle,
  LIGHT_NEAREST,
  Palette,
  ScenePatch,
  Vec3,
  applyHandle,
  clickHandle,
  sceneHandles,
  sceneOverlay,
  sceneUniforms,
} from './scene';
import { getDevicePixelRatio } from '../../../utils/displayScale';

export type DepthMapKey = 'lensBlurDepthMap' | 'fogDepthMap' | 'motionBlurDepthMap' | 'relightNormalMap';

type DepthScopeProps = {
  scene: DepthScene;
  onChange?(patch: ScenePatch): void;
  onDragStateChange?(isDragging: boolean): void;
} & ({ mapKey: DepthMapKey; mapData?: never } | { mapData: string; mapKey?: never });

interface Drag {
  pointerId: number;
  start: [number, number];
  startTime: number;
  handle: Handle | null;
  pixelsPerUnit: [number, number];
  offset: [number, number, number];
  camera: Camera;
  pan: number | null;
}

const PREVIEW_SIZE = 192;
const PREVIEW_CACHE_LIMIT = 6;
// Grows with the panel width (via aspect ratio) between these heights.
const MIN_HEIGHT = 136;
const MAX_HEIGHT = 300;
const ASPECT_RATIO = 1.6;
const DEFAULT_CAMERA: Camera = { yaw: 0.62, pitch: 0.3, zoom: 1, offset: [0, 0, 0] };
const SIDE_CAMERA: Camera = { yaw: 1.35, pitch: 0.06, zoom: 1, offset: [0, 0, 0] };
const MAX_ZOOM = 4;
const CLICK_DELAY = 230;
const FLASH_DURATION = 900;
const WARP_KEYS = [
  'transformDistortion',
  'transformVertical',
  'transformHorizontal',
  'transformRotate',
  'transformAspect',
  'transformScale',
  'transformXOffset',
  'transformYOffset',
  'lensDistortionAmount',
  'lensVignetteAmount',
  'lensTcaAmount',
  'lensCorrectionMode',
  'lensMaker',
  'lensModel',
  'lensDistortionEnabled',
  'lensTcaEnabled',
  'lensVignetteEnabled',
  'guidedPerspective',
];

const OMITTED_KEYS = [
  'lensBlurDepthMap',
  'fogDepthMap',
  'motionBlurDepthMap',
  'relightNormalMap',
  'aiPatches',
  'masks',
  'lutData',
];

const cameras = new Map<string, Camera>();
const previewCache = new Map<string, Promise<DepthPreview>>();

const parsePreview = (buffer: ArrayBuffer): DepthPreview => {
  const view = new DataView(buffer);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  const count = width * height;
  const pixels = new Uint8Array(buffer, 12, count * 4);
  const normals = view.getUint32(8, true) ? new Uint8Array(buffer, 12 + count * 4, count * 4) : null;
  let sum = 0;
  for (let i = 3; i < pixels.length; i += 4) sum += pixels[i];
  return { width, height, pixels, normals, meanNearness: sum / Math.max(count, 1) / 255 };
};

const fingerprint = (value: string) => {
  let hash = 0x811c9dc5;
  const step = Math.max(1, Math.floor(value.length / 8192));
  for (let i = 0; i < value.length; i += step) hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193);
  return `${value.length}:${(hash >>> 0).toString(36)}`;
};

const fetchPreview = (mapKey: DepthMapKey | undefined, mapValue: string, signature: string) => {
  const key = `${mapKey ? `${mapKey}|${mapValue}` : `data|${fingerprint(mapValue)}`}|${signature}`;
  const cached = previewCache.get(key);
  if (cached) {
    previewCache.delete(key);
    previewCache.set(key, cached);
    return cached;
  }
  const payload: Record<string, unknown> = { ...useEditorStore.getState().adjustments };
  for (const omitted of OMITTED_KEYS) delete payload[omitted];
  if (mapKey) payload[mapKey] = mapValue;
  const request = invoke<ArrayBuffer>(Invokes.GetDepthPreview, {
    jsAdjustments: payload,
    mapKey: mapKey ?? null,
    mapData: mapKey ? null : mapValue,
    maxSize: PREVIEW_SIZE,
  }).then(parsePreview);
  request.catch(() => previewCache.delete(key));
  previewCache.set(key, request);
  if (previewCache.size > PREVIEW_CACHE_LIMIT) {
    const oldest = previewCache.keys().next().value;
    if (oldest !== undefined) previewCache.delete(oldest);
  }
  return request;
};

const useDepthPreview = (mapKey: DepthMapKey | undefined, mapData: string | undefined) => {
  const storeValue = useEditorStore((state) => (mapKey ? state.adjustments[mapKey] : null));
  const mapValue = mapKey ? storeValue : mapData;
  const signature = useEditorStore((state) =>
    WARP_KEYS.map((key) => JSON.stringify((state.adjustments as Record<string, unknown>)[key] ?? null)).join('|'),
  );
  const [preview, setPreview] = useState<DepthPreview | null>(null);

  useEffect(() => {
    if (!mapValue) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchPreview(mapKey, mapValue, signature)
        .then((next) => !cancelled && setPreview(next))
        .catch(() => {});
    }, 90);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mapKey, mapValue, signature]);

  return preview;
};

const parseColor = (value: string, fallback: [number, number, number]): [number, number, number] => {
  const match = value.match(/(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/);
  return match ? [Number(match[1]) / 255, Number(match[2]) / 255, Number(match[3]) / 255] : fallback;
};

const readPalette = (): Palette => {
  const style = getComputedStyle(document.documentElement);
  return {
    accent: parseColor(style.getPropertyValue('--app-accent'), [1, 1, 1]),
    line: parseColor(style.getPropertyValue('--app-text-secondary'), [0.7, 0.7, 0.7]),
  };
};

const easeOut = (t: number) => 1 - (1 - t) ** 3;

const clampOffset = (offset: Vec3, [ex, ey]: [number, number]): Vec3 => {
  const limits = [ex / 2, ey / 2, DEPTH_SCALE / 2];
  return offset.map((v, i) => Math.max(-limits[i], Math.min(limits[i], v))) as Vec3;
};

export default function DepthScope({ mapKey, mapData, scene, onChange, onDragStateChange }: DepthScopeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<DepthScopeRenderer | null>(null);
  const preview = useDepthPreview(mapKey, mapData);
  const orientation = useEditorStore((state) => (state.adjustments.orientationSteps ?? 0) % 4);
  const flipH = useEditorStore((state) => !!state.adjustments.flipHorizontal);
  const flipV = useEditorStore((state) => !!state.adjustments.flipVertical);
  const [failed, setFailed] = useState(false);
  const ctrlClickMenuGuard = useCtrlClickMenuGuard();

  const state = useRef({
    scene,
    frame: { orientation, flipH, flipV } as Frame,
    preview: null as DepthPreview | null,
    camera: cameras.get(scene.kind) ?? { ...DEFAULT_CAMERA },
    palette: null as Palette | null,
    handles: [] as Array<Handle>,
    hover: null as string | null,
    drag: null as Drag | null,
    reveal: 1,
    visible: true,
    raf: 0,
    animation: 0,
    pending: null as ScenePatch | null,
    patchRaf: 0,
    flash: null as { id: string; until: number } | null,
    clickTimer: 0,
    sceneKey: '',
  });

  const callbacks = useRef({ onChange, onDragStateChange });
  callbacks.current = { onChange, onDragStateChange };

  const draw = useCallback(() => {
    const s = state.current;
    const renderer = rendererRef.current;
    if (!renderer || !s.visible) return;
    s.palette ??= readPalette();
    renderer.updateCamera(s.camera, s.frame, s.scene.kind === 'relight' ? -LIGHT_NEAREST : 0);
    const extent = renderer.extent(s.frame);
    s.handles = sceneHandles(s.scene, s.frame, extent, (p) => renderer.pixelsPerUnit(p[0], p[1], p[2]));
    const flashId = s.flash && performance.now() < s.flash.until ? s.flash.id : null;
    const focusId = s.drag?.handle?.id ?? s.hover ?? flashId;
    const focus = s.handles.find((h) => h.id === focusId) ?? null;
    const uniforms = s.preview
      ? {
          ...sceneUniforms(s.scene, s.preview, renderer.effectAspect(), easeOut(s.reveal)),
          contour: focus
            ? { depths: focus.contour, strength: s.drag?.handle ? 1 : 0.75, color: s.palette.accent }
            : undefined,
        }
      : null;
    const overlay = sceneOverlay(
      s.scene,
      s.handles,
      s.preview,
      s.frame,
      extent,
      s.palette,
      s.hover ?? flashId,
      s.drag?.handle?.id ?? null,
    );
    renderer.render(s.frame, uniforms ?? { mode: 0, reveal: 1 }, overlay);

    const readout = readoutRef.current;
    if (readout) {
      if (focus && s.preview) {
        const [x, y] = renderer.project(...focus.knob);
        readout.textContent = focus.label;
        readout.style.opacity = '1';
        readout.style.transform = `translate(${Math.round(x + 10)}px, ${Math.round(y - 22)}px)`;
      } else {
        readout.style.opacity = '0';
      }
    }
  }, []);

  const requestDraw = useCallback(() => {
    const s = state.current;
    if (s.raf) return;
    s.raf = requestAnimationFrame(() => {
      s.raf = 0;
      draw();
    });
  }, [draw]);

  useLayoutEffect(() => {
    const s = state.current;
    const key = `${JSON.stringify(scene)}|${orientation}|${flipH}|${flipV}`;
    s.scene = scene;
    if (key === s.sceneKey) return;
    s.sceneKey = key;
    s.frame = { orientation, flipH, flipV };
    requestDraw();
  }, [scene, orientation, flipH, flipV, requestDraw]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'absolute inset-0 h-full w-full';
    container.insertBefore(canvas, readoutRef.current);
    let renderer: DepthScopeRenderer;
    try {
      renderer = new DepthScopeRenderer(canvas);
    } catch (error) {
      console.error('Depth scope unavailable:', error);
      canvas.remove();
      setFailed(true);
      return;
    }
    rendererRef.current = renderer;
    const s = state.current;

    const resize = () => {
      renderer.resize(container.clientWidth, container.clientHeight, Math.min(getDevicePixelRatio(), 2));
      draw();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();

    const intersection = new IntersectionObserver(([entry]) => {
      s.visible = entry.isIntersecting;
      if (s.visible) requestDraw();
    });
    intersection.observe(container);

    const onLost = (e: Event) => e.preventDefault();
    canvas.addEventListener('webglcontextlost', onLost);

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const from = s.camera.zoom;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 120 : 1;
      const zoom = Math.min(MAX_ZOOM, Math.max(1, from * Math.exp(-e.deltaY * unit * 0.0025)));
      if (zoom === from) return;
      let offset = s.camera.offset;
      if (zoom < from) {
        const k = from > 1 ? (zoom - 1) / (from - 1) : 0;
        offset = offset.map((v) => v * k) as Vec3;
      } else {
        const rect = container.getBoundingClientRect();
        const focus = renderer.focusPoint(e.clientX - rect.left, e.clientY - rect.top);
        if (focus) {
          const k = 1 - from / zoom;
          offset = offset.map((v, i) => v + (focus.point[i] - focus.target[i]) * k) as Vec3;
        }
      }
      offset = clampOffset(offset, renderer.extent(s.frame));
      cancelAnimationFrame(s.animation);
      s.camera = { ...s.camera, zoom, offset };
      cameras.set(s.scene.kind, s.camera);
      requestDraw();
    };
    container.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      resizeObserver.disconnect();
      intersection.disconnect();
      canvas.removeEventListener('webglcontextlost', onLost);
      container.removeEventListener('wheel', onWheel);
      cancelAnimationFrame(s.raf);
      cancelAnimationFrame(s.animation);
      cancelAnimationFrame(s.patchRaf);
      clearTimeout(s.clickTimer);
      s.raf = 0;
      s.preview = null;
      s.reveal = 1;
      renderer.dispose();
      canvas.remove();
      rendererRef.current = null;
    };
  }, [draw, requestDraw]);

  useEffect(() => {
    const renderer = rendererRef.current;
    const s = state.current;
    if (!renderer || !preview) return;
    const first = !s.preview;
    s.preview = preview;
    s.palette = readPalette();
    renderer.setPreview(preview);
    if (!first) {
      requestDraw();
      return;
    }
    const started = performance.now();
    const step = (now: number) => {
      s.reveal = Math.min((now - started) / 720, 1);
      draw();
      if (s.reveal < 1) s.animation = requestAnimationFrame(step);
    };
    s.reveal = 0;
    s.animation = requestAnimationFrame(step);
  }, [preview, draw, requestDraw]);

  const localPoint = (e: { clientX: number; clientY: number }): [number, number] => {
    const rect = containerRef.current!.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  const hitTest = (point: [number, number]): Handle | null => {
    const renderer = rendererRef.current;
    const s = state.current;
    if (!renderer || !s.preview || !callbacks.current.onChange) return null;
    const screen = (p: Vec3) => renderer.project(p[0], p[1], p[2]);
    const segmentDistance = ([a, b]: [Vec3, Vec3]) => {
      const [ax, ay] = screen(a);
      const [bx, by] = screen(b);
      const lengthSq = (bx - ax) ** 2 + (by - ay) ** 2;
      const t =
        lengthSq > 0
          ? Math.max(0, Math.min(1, ((point[0] - ax) * (bx - ax) + (point[1] - ay) * (by - ay)) / lengthSq))
          : 0;
      return Math.hypot(point[0] - (ax + (bx - ax) * t), point[1] - (ay + (by - ay) * t));
    };
    let best: Handle | null = null;
    let bestScore = 0;
    for (const handle of s.handles) {
      const [kx, ky] = screen(handle.knob);
      const radius = handle.style === 'light' ? 11 : handle.style === 'axis' ? 9 : handle.style === 'range' ? 11 : 13;
      let score = Math.hypot(point[0] - kx, point[1] - ky) - radius + (handle.style === 'fade' ? 3 : 0);
      for (const arm of handle.arms) score = Math.min(score, segmentDistance(arm) - 6);
      if (score < bestScore) {
        best = handle;
        bestScore = score;
      }
    }
    return best;
  };

  const intersect = (point: [number, number], depth: number): Vec3 | null => {
    const renderer = rendererRef.current;
    if (!renderer) return null;
    const { origin, direction } = renderer.ray(point[0], point[1]);
    if (Math.abs(direction[2]) < 1e-6) return null;
    const t = (depth - origin[2]) / direction[2];
    if (t < 0) return null;
    return [origin[0] + direction[0] * t, origin[1] + direction[1] * t, depth];
  };

  const pickDistance = (point: [number, number]): number | null => {
    const renderer = rendererRef.current;
    const s = state.current;
    const preview = s.preview;
    if (!renderer || !preview) return null;
    const [ex, ey] = renderer.extent(s.frame);
    let best: number | null = null;
    let bestScore = Infinity;
    for (let y = 0; y < preview.height; y++) {
      for (let x = 0; x < preview.width; x++) {
        const dist = 1 - preview.pixels[(y * preview.width + x) * 4 + 3] / 255;
        const [px, py] = toDisplay((x + 0.5) / preview.width, (y + 0.5) / preview.height, s.frame);
        const [sx, sy, depth] = renderer.project((px - 0.5) * ex, (0.5 - py) * ey, -dist * DEPTH_SCALE);
        const d2 = (sx - point[0]) ** 2 + (sy - point[1]) ** 2;
        if (d2 > 100) continue;
        const score = d2 < 25 ? depth : 1000 + d2;
        if (score < bestScore) {
          bestScore = score;
          best = dist;
        }
      }
    }
    return best;
  };

  const placeAt = (point: [number, number]) => {
    const renderer = rendererRef.current;
    const s = state.current;
    if (!renderer || !callbacks.current.onChange) return;
    const handle = clickHandle(s.scene, s.handles);
    const dist = handle ? pickDistance(point) : null;
    if (!handle || dist === null) return;
    const target = { x: handle.origin[0], y: handle.origin[1], z: dist };
    const patch = applyHandle(s.scene, handle, target, s.frame, renderer.extent(s.frame));
    if (!patch) return;
    callbacks.current.onChange(patch);
    s.flash = { id: handle.id, until: performance.now() + FLASH_DURATION };
    setTimeout(requestDraw, FLASH_DURATION + 20);
  };

  const setCursor = (cursor: string) => {
    const container = containerRef.current;
    if (container && container.style.cursor !== cursor) container.style.cursor = cursor;
  };

  const flushPatch = () => {
    const s = state.current;
    s.patchRaf = 0;
    if (s.pending) {
      callbacks.current.onChange?.(s.pending);
      s.pending = null;
    }
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const renderer = rendererRef.current;
    const s = state.current;
    if (!renderer) return;
    e.preventDefault();
    const start = localPoint(e);
    const pan = e.ctrlKey || e.metaKey ? renderer.pixelsPerUnit(...renderer.pivot()) : null;
    const handle = pan === null ? hitTest(start) : null;
    let pixelsPerUnit: [number, number] = [0, 0];
    let offset: Vec3 = [0, 0, 0];
    if (handle?.drag === 'free') {
      const hit = intersect(start, handle.origin[2]);
      if (hit) offset = [handle.origin[0] - hit[0], handle.origin[1] - hit[1], 0];
    } else if (handle) {
      const o = handle.origin;
      const step = handle.drag === 'x' ? [0.1, 0, 0] : handle.drag === 'y' ? [0, 0.1, 0] : [0, 0, -0.1 * DEPTH_SCALE];
      const [x0, y0] = renderer.project(o[0], o[1], o[2]);
      const [x1, y1] = renderer.project(o[0] + step[0], o[1] + step[1], o[2] + step[2]);
      pixelsPerUnit = [(x1 - x0) / 0.1, (y1 - y0) / 0.1];
    }
    if (handle) callbacks.current.onDragStateChange?.(true);
    s.drag = {
      pointerId: e.pointerId,
      start,
      startTime: performance.now(),
      handle,
      pixelsPerUnit,
      offset,
      camera: { ...s.camera },
      pan,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    setCursor(handle || pan !== null ? 'grabbing' : 'move');
    requestDraw();
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = state.current;
    const point = localPoint(e);
    const drag = s.drag;
    if (!drag) {
      const hit = hitTest(point);
      const id = hit?.id ?? null;
      setCursor(hit ? 'grab' : 'move');
      if (id !== s.hover) {
        s.hover = id;
        requestDraw();
      }
      return;
    }
    if (e.pointerId !== drag.pointerId) return;
    const dx = point[0] - drag.start[0];
    const dy = point[1] - drag.start[1];

    if (drag.handle) {
      const renderer = rendererRef.current;
      if (!renderer) return;
      const { origin, drag: mode, z } = drag.handle;
      const target = { x: origin[0], y: origin[1], z };
      if (mode === 'free') {
        const hit = intersect(point, origin[2]);
        if (!hit) return;
        target.x = hit[0] + drag.offset[0];
        target.y = hit[1] + drag.offset[1];
      } else {
        const [px, py] = drag.pixelsPerUnit;
        const lengthSq = px * px + py * py;
        const height = containerRef.current?.clientHeight || MIN_HEIGHT;
        const fallback = mode === 'x' ? dx / (height * 1.2) : -dy / (height * (mode === 'y' ? 1.2 : 0.9));
        const delta = lengthSq > 900 ? (dx * px + dy * py) / lengthSq : fallback;
        if (mode === 'x') target.x += delta;
        else if (mode === 'y') target.y += delta;
        else target.z += delta;
      }
      const patch = applyHandle(s.scene, drag.handle, target, s.frame, renderer.extent(s.frame));
      if (patch) {
        s.pending = { ...(s.pending ?? {}), ...patch };
        if (!s.patchRaf) s.patchRaf = requestAnimationFrame(flushPatch);
      }
      return;
    }

    if (drag.pan !== null) {
      const renderer = rendererRef.current;
      if (!renderer) return;
      const { yaw, pitch, offset } = drag.camera;
      const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
      const up = [-Math.sin(pitch) * Math.sin(yaw), Math.cos(pitch), -Math.sin(pitch) * Math.cos(yaw)];
      const scale = 1 / Math.max(drag.pan, 1e-3);
      const moved = offset.map((v, i) => v + (-right[i] * dx + up[i] * dy) * scale) as Vec3;
      s.camera = { ...s.camera, offset: clampOffset(moved, renderer.extent(s.frame)) };
      cameras.set(s.scene.kind, s.camera);
      requestDraw();
      return;
    }

    s.camera = {
      ...s.camera,
      yaw: Math.max(-1.4, Math.min(1.4, drag.camera.yaw - dx * 0.01)),
      pitch: Math.max(-1.2, Math.min(1.2, drag.camera.pitch + dy * 0.008)),
    };
    cameras.set(s.scene.kind, s.camera);
    requestDraw();
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = state.current;
    const drag = s.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    s.drag = null;
    const end = localPoint(e);
    if (drag.handle) {
      cancelAnimationFrame(s.patchRaf);
      flushPatch();
      callbacks.current.onDragStateChange?.(false);
    } else if (
      drag.pan === null &&
      Math.hypot(end[0] - drag.start[0], end[1] - drag.start[1]) < 4 &&
      performance.now() - drag.startTime < 350
    ) {
      s.camera = { ...s.camera, yaw: drag.camera.yaw, pitch: drag.camera.pitch };
      clearTimeout(s.clickTimer);
      s.clickTimer = window.setTimeout(() => placeAt(end), CLICK_DELAY);
    }
    const hit = hitTest(end);
    s.hover = hit?.id ?? null;
    setCursor(hit ? 'grab' : 'move');
    requestDraw();
  };

  const handlePointerLeave = () => {
    const s = state.current;
    if (s.drag || s.hover === null) return;
    s.hover = null;
    requestDraw();
  };

  const handleDoubleClick = () => {
    const s = state.current;
    clearTimeout(s.clickTimer);
    const from = { ...s.camera };
    const isAt = (camera: Camera) =>
      Math.abs(from.yaw - camera.yaw) < 0.05 &&
      Math.abs(from.pitch - camera.pitch) < 0.05 &&
      Math.abs(from.zoom - camera.zoom) < 0.01;
    const goal = isAt(DEFAULT_CAMERA) ? SIDE_CAMERA : DEFAULT_CAMERA;
    const started = performance.now();
    cancelAnimationFrame(s.animation);
    const step = (now: number) => {
      const t = easeOut(Math.min((now - started) / 380, 1));
      s.camera = {
        yaw: from.yaw + (goal.yaw - from.yaw) * t,
        pitch: from.pitch + (goal.pitch - from.pitch) * t,
        zoom: from.zoom + (goal.zoom - from.zoom) * t,
        offset: from.offset.map((v, i) => v + (goal.offset[i] - v) * t) as Vec3,
      };
      cameras.set(s.scene.kind, s.camera);
      draw();
      if (t < 1) s.animation = requestAnimationFrame(step);
    };
    s.animation = requestAnimationFrame(step);
  };

  if (failed) return null;

  return (
    <div
      className={clsx(
        'grid transition-all duration-300 ease-in-out',
        preview ? 'grid-rows-[1fr] opacity-100' : 'my-0! grid-rows-[0fr] opacity-0',
      )}
    >
      <div className="overflow-hidden">
        <div
          ref={containerRef}
          className="relative w-full overflow-hidden rounded-md bg-bg-primary select-none"
          style={{
            aspectRatio: ASPECT_RATIO,
            minHeight: MIN_HEIGHT,
            maxHeight: MAX_HEIGHT,
            touchAction: 'none',
            cursor: 'move',
          }}
          {...ctrlClickMenuGuard}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={handlePointerLeave}
          onDoubleClick={handleDoubleClick}
        >
          <div
            ref={readoutRef}
            className="pointer-events-none absolute left-0 top-0 rounded-sm px-1.5 py-0.5 font-mono text-[10px] leading-none tabular-nums text-text-primary transition-opacity duration-150"
            style={{
              opacity: 0,
              background: 'color-mix(in srgb, var(--app-bg-secondary) 82%, transparent)',
            }}
          />
        </div>
      </div>
    </div>
  );
}
