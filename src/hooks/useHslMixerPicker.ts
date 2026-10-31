import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { useEditorStore } from '../store/useEditorStore';
import { Adjustments, HueSatLum, INITIAL_ADJUSTMENTS, INITIAL_MASK_ADJUSTMENTS } from '../utils/adjustments';
import { HslMixerBand, HslMixerProperty, HslPresence, sampleHslPresence } from '../utils/hslMixer';
import { RenderSize } from './useImageRenderSize';
import { Invokes } from '../components/ui/AppProperties';
import { FINE_ADJUSTMENT_MULTIPLIER, hasFineAdjustmentModifier } from '../components/ui/Slider';
import { prepareAdjustmentsPayload } from '../utils/backendPayload';

export const MIXER_SAMPLE_SCREEN_SIZE = 16;
const DRAG_GAIN = 0.5;

interface Coord {
  x: number;
  y: number;
}

interface PickerDrag {
  property: HslMixerProperty;
  maskId: string | null;
  last: Coord;
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
  zoomScale: number;
  setAdjustments(fn: (prev: Adjustments) => Adjustments): void;
}

const clampOffset = ({ offsetRange: [min, max] }: PickerDrag, offset: number) => Math.max(min, Math.min(max, offset));

const getClientPoint = (e: MouseEvent | TouchEvent): Coord | undefined => {
  const point = 'touches' in e ? e.touches[0] : e;
  return point && { x: point.clientX, y: point.clientY };
};

const getTargetHsl = (adjustments: Adjustments, maskId: string | null): Adjustments['hsl'] =>
  maskId
    ? { ...INITIAL_MASK_ADJUSTMENTS.hsl, ...adjustments.masks.find((mask) => mask.id === maskId)?.adjustments.hsl }
    : { ...INITIAL_ADJUSTMENTS.hsl, ...adjustments.hsl };

const withBandValues = (
  adjustments: Adjustments,
  maskId: string | null,
  key: HslMixerProperty,
  values: Array<[string, number]>,
): Adjustments => {
  const hsl = getTargetHsl(adjustments, maskId);
  values.forEach(([band, value]) => {
    hsl[band] = { ...hsl[band], [key]: value };
  });
  return maskId
    ? {
        ...adjustments,
        masks: adjustments.masks.map((mask) =>
          mask.id === maskId ? { ...mask, adjustments: { ...mask.adjustments, hsl } } : mask,
        ),
      }
    : { ...adjustments, hsl };
};

export function useHslMixerPicker({
  activeMaskContainerId,
  getCanvasPointer,
  imageRenderSize,
  isMasking,
  zoomScale,
  setAdjustments,
}: HslMixerPickerOptions) {
  const property = useEditorStore((state) => state.mixerPickerProperty);
  const setEditor = useEditorStore((state) => state.setEditor);
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<PickerDrag | null>(null);
  const detachRef = useRef<(() => void) | null>(null);

  const sampleArea = useCallback(async (u: number, v: number, radius: number): Promise<Uint8Array> => {
    const { payload, markSent } = prepareAdjustmentsPayload(useEditorStore.getState().adjustments);
    const probe = await invoke<ArrayBuffer>(Invokes.SampleHslMixerArea, { jsAdjustments: payload, x: u, y: v, radius });
    markSent();
    return new Uint8Array(probe);
  }, []);

  const getPick = useCallback(
    (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
      const stage = e.target.getStage();
      const pos = stage && getCanvasPointer(stage);
      const maskId = isMasking ? activeMaskContainerId : null;
      if (!property || !pos || (isMasking && !maskId)) return null;
      if (pos.x < 0 || pos.y < 0 || pos.x > imageRenderSize.width || pos.y > imageRenderSize.height) return null;
      const radius = MIXER_SAMPLE_SCREEN_SIZE / 2 / zoomScale / imageRenderSize.width;
      return {
        property,
        maskId,
        sample: () => sampleArea(pos.x / imageRenderSize.width, pos.y / imageRenderSize.height, radius),
      };
    },
    [property, isMasking, activeMaskContainerId, imageRenderSize, zoomScale, getCanvasPointer, sampleArea],
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
      setAdjustments((prev) => withBandValues(prev, maskId, key, values));
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
      const pick = getPick(e);
      const clientPoint = getClientPoint(e.evt);
      if (!pick || !clientPoint) return;

      end();
      const drag: PickerDrag = {
        property: pick.property,
        maskId: pick.maskId,
        last: clientPoint,
        offset: 0,
        appliedKey: null,
        base: getTargetHsl(useEditorStore.getState().adjustments, pick.maskId),
        presence: null,
        offsetRange: [-Infinity, Infinity],
      };
      dragRef.current = drag;
      setIsDragging(true);
      setEditor({ isSliderDragging: true });

      const onMove = (ev: MouseEvent | TouchEvent) => {
        const point = getClientPoint(ev);
        if (!point) return;
        if (ev.cancelable) ev.preventDefault();
        const multiplier = hasFineAdjustmentModifier(ev) ? FINE_ADJUSTMENT_MULTIPLIER : 1;
        const delta = point.x - drag.last.x - (point.y - drag.last.y);
        drag.offset = clampOffset(drag, drag.offset + delta * DRAG_GAIN * multiplier);
        drag.last = point;
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

      pick
        .sample()
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
    [getPick, setEditor, applyDrag, end],
  );

  const reset = useCallback(
    (e: KonvaEventObject<MouseEvent>) => {
      const pick = getPick(e);
      if (!pick) return;
      pick
        .sample()
        .then((pixels) => {
          const values = Object.entries(sampleHslPresence(pixels, pick.property))
            .filter(([, weight]) => (weight as number) > 0)
            .map(([band]): [string, number] => [band, 0]);
          setAdjustments((prev) => withBandValues(prev, pick.maskId, pick.property, values));
        })
        .catch((err) => console.error('Failed to sample preview for color mixer picker:', err));
    },
    [getPick, setAdjustments],
  );

  useEffect(() => {
    if (!property) end();
  }, [property, end]);

  useEffect(() => end, [end]);

  return { isActive: property !== null, isDragging, start, reset };
}
