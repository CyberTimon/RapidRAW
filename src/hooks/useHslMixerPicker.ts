import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { useEditorStore } from '../store/useEditorStore';
import { Adjustments, HueSatLum, INITIAL_ADJUSTMENTS, INITIAL_MASK_ADJUSTMENTS } from '../utils/adjustments';
import { HslMixerBand, HslMixerProperty, HslPresence, sampleHslPresence } from '../utils/hslMixer';
import { RenderSize } from './useImageRenderSize';
import { Invokes } from '../components/ui/AppProperties';
import { FINE_ADJUSTMENT_MULTIPLIER } from '../components/ui/Slider';

const SAMPLE_SCREEN_SIZE = 16;
const DRAG_GAIN = 0.5;

interface Coord {
  x: number;
  y: number;
}

interface PickerDrag {
  property: HslMixerProperty;
  maskId: string | null;
  lastY: number;
  offset: number;
  appliedKey: string | null;
  base: Record<string, HueSatLum>;
  presence: HslPresence | null;
  offsetRange: [number, number];
}

interface HslMixerPickerOptions {
  activeMaskContainerId: string | null;
  getCanvasPointer(stage: Konva.Stage): Coord | null;
  imageRenderSize: RenderSize;
  isMasking: boolean;
  previewUrl: string | null;
  zoomScale: number;
  setAdjustments(fn: (prev: Adjustments) => Adjustments): void;
}

const clampOffset = ({ offsetRange: [min, max] }: PickerDrag, offset: number) => Math.max(min, Math.min(max, offset));

const getClientY = (e: MouseEvent | TouchEvent) => ('touches' in e ? e.touches[0]?.clientY : e.clientY);

const getTargetHsl = (adjustments: Adjustments, maskId: string | null): Adjustments['hsl'] =>
  maskId
    ? { ...INITIAL_MASK_ADJUSTMENTS.hsl, ...adjustments.masks.find((mask) => mask.id === maskId)?.adjustments.hsl }
    : { ...INITIAL_ADJUSTMENTS.hsl, ...adjustments.hsl };

export function useHslMixerPicker({
  activeMaskContainerId,
  getCanvasPointer,
  imageRenderSize,
  isMasking,
  previewUrl,
  zoomScale,
  setAdjustments,
}: HslMixerPickerOptions) {
  const property = useEditorStore((state) => state.mixerPickerProperty);
  const setEditor = useEditorStore((state) => state.setEditor);
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<PickerDrag | null>(null);
  const bitmapRef = useRef<{ url: string; bitmap: Promise<ImageBitmap> } | null>(null);
  const detachRef = useRef<(() => void) | null>(null);

  const releaseBitmap = useCallback(() => {
    bitmapRef.current?.bitmap.then((bitmap) => bitmap.close()).catch(() => {});
  }, []);

  const getBitmap = useCallback(
    (url: string) => {
      if (bitmapRef.current?.url !== url) {
        releaseBitmap();
        bitmapRef.current = {
          url,
          bitmap: fetch(url)
            .then((res) => res.blob())
            .then((blob) => createImageBitmap(blob)),
        };
      }
      return bitmapRef.current.bitmap;
    },
    [releaseBitmap],
  );

  const sampleArea = useCallback(
    async (u: number, v: number, radius: number): Promise<Uint8ClampedArray> => {
      if (!previewUrl) {
        return Uint8ClampedArray.from(await invoke<number[]>(Invokes.SampleDisplayArea, { x: u, y: v, radius }));
      }
      const bitmap = await getBitmap(previewUrl);
      const half = Math.max(1, radius * bitmap.width);
      const x0 = Math.max(0, Math.floor(u * bitmap.width - half));
      const y0 = Math.max(0, Math.floor(v * bitmap.height - half));
      const w = Math.max(1, Math.min(bitmap.width, Math.ceil(u * bitmap.width + half)) - x0);
      const h = Math.max(1, Math.min(bitmap.height, Math.ceil(v * bitmap.height + half)) - y0);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return new Uint8ClampedArray();
      ctx.drawImage(bitmap, x0, y0, w, h, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h).data;
    },
    [previewUrl, getBitmap],
  );

  const applyDrag = useCallback(
    (drag: PickerDrag) => {
      const { presence, base, property: key, maskId } = drag;
      if (!presence) return;
      const values = Object.entries(presence).map(([band, weight]): [string, number] => [
        band,
        Math.max(-100, Math.min(100, Math.round(base[band][key] + drag.offset * (weight as number)))),
      ]);
      const appliedKey = values.join();
      if (appliedKey === drag.appliedKey) return;
      drag.appliedKey = appliedKey;
      setAdjustments((prev) => {
        const hsl = getTargetHsl(prev, maskId);
        values.forEach(([band, value]) => {
          hsl[band] = { ...hsl[band], [key]: value };
        });
        return maskId
          ? {
              ...prev,
              masks: prev.masks.map((mask) =>
                mask.id === maskId ? { ...mask, adjustments: { ...mask.adjustments, hsl } } : mask,
              ),
            }
          : { ...prev, hsl };
      });
    },
    [setAdjustments],
  );

  const end = useCallback(() => {
    detachRef.current?.();
    detachRef.current = null;
    if (!dragRef.current) return;
    dragRef.current = null;
    setIsDragging(false);
    setEditor({ isSliderDragging: false });
  }, [setEditor]);

  const start = useCallback(
    (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
      const stage = e.target.getStage();
      const pos = stage && getCanvasPointer(stage);
      const clientY = getClientY(e.evt);
      const maskId = isMasking ? activeMaskContainerId : null;
      if (!property || !pos || clientY === undefined || (isMasking && !maskId)) return;
      if (pos.x < 0 || pos.y < 0 || pos.x > imageRenderSize.width || pos.y > imageRenderSize.height) return;

      end();
      const drag: PickerDrag = {
        property,
        maskId,
        lastY: clientY,
        offset: 0,
        appliedKey: null,
        base: getTargetHsl(useEditorStore.getState().adjustments, maskId),
        presence: null,
        offsetRange: [-Infinity, Infinity],
      };
      dragRef.current = drag;
      setIsDragging(true);
      setEditor({ isSliderDragging: true });

      const onMove = (ev: MouseEvent | TouchEvent) => {
        const y = getClientY(ev);
        if (y === undefined) return;
        if (ev.cancelable) ev.preventDefault();
        const multiplier = ev.altKey ? FINE_ADJUSTMENT_MULTIPLIER : 1;
        drag.offset = clampOffset(drag, drag.offset + (drag.lastY - y) * DRAG_GAIN * multiplier);
        drag.lastY = y;
        applyDrag(drag);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('mouseup', end);
      window.addEventListener('touchend', end);
      window.addEventListener('touchcancel', end);
      detachRef.current = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('touchmove', onMove);
        window.removeEventListener('mouseup', end);
        window.removeEventListener('touchend', end);
        window.removeEventListener('touchcancel', end);
      };

      const radius = SAMPLE_SCREEN_SIZE / 2 / zoomScale / imageRenderSize.width;
      sampleArea(pos.x / imageRenderSize.width, pos.y / imageRenderSize.height, radius)
        .then((pixels) => {
          if (dragRef.current !== drag) return;
          drag.presence = sampleHslPresence(pixels, drag.property);
          const dominant = Object.keys(drag.presence).find((band) => drag.presence?.[band as HslMixerBand] === 1);
          if (dominant) {
            const value = drag.base[dominant][drag.property];
            drag.offsetRange = [-100 - value, 100 - value];
            drag.offset = clampOffset(drag, drag.offset);
          }
          applyDrag(drag);
        })
        .catch((err) => console.error('Failed to sample preview for color mixer picker:', err));
    },
    [
      property,
      isMasking,
      activeMaskContainerId,
      imageRenderSize,
      zoomScale,
      getCanvasPointer,
      sampleArea,
      setEditor,
      applyDrag,
      end,
    ],
  );

  useEffect(() => {
    if (!property) end();
  }, [property, end]);

  useEffect(
    () => () => {
      end();
      releaseBitmap();
    },
    [end, releaseBitmap],
  );

  return { isActive: property !== null, isDragging, start };
}
