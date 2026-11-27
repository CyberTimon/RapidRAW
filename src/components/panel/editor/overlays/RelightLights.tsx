import { useEffect, useMemo, useState } from 'react';
import { RelightLight } from '../../../../utils/adjustments';
import { useEditorStore } from '../../../../store/useEditorStore';
import { useVideoStore } from '../../../../store/useVideoStore';
import { shownLookValues } from '../../../../store/videoLiveLook';
import RelightLightShape, { RelightBasis } from './RelightLightShape';

interface Point {
  x: number;
  y: number;
}

const PREFIX = 'relightLights.#';
const NO_VALUES = new Map<string, number>();

const lightValues = () => {
  const values = new Map<string, number>();
  shownLookValues().forEach((value, path) => {
    if (path.startsWith(PREFIX)) values.set(path.slice(PREFIX.length), value);
  });
  return values.size > 0 ? values : NO_VALUES;
};

const sameValues = (a: Map<string, number>, b: Map<string, number>) =>
  a.size === b.size && [...a].every(([path, value]) => b.get(path) === value);

const animated = (light: RelightLight, values: Map<string, number>): RelightLight => {
  let next = light;
  values.forEach((value, path) => {
    const [id, key] = path.split('.');
    if (id === light.id && key in light && next[key as keyof RelightLight] !== value) {
      next = { ...next, [key]: value };
    }
  });
  return next;
};

const useLiveLights = (lights: Array<RelightLight>) => {
  const [values, setValues] = useState(lightValues);
  useEffect(() => {
    const refresh = () =>
      setValues((current) => {
        const next = lightValues();
        return sameValues(current, next) ? current : next;
      });
    refresh();
    const stopVideo = useVideoStore.subscribe((state, prev) => {
      if (
        state.playhead !== prev.playhead ||
        state.project !== prev.project ||
        state.editorItemId !== prev.editorItemId ||
        state.session !== prev.session
      ) {
        refresh();
      }
    });
    const stopEditor = useEditorStore.subscribe((state, prev) => {
      if (state.adjustments !== prev.adjustments) refresh();
    });
    return () => {
      stopVideo();
      stopEditor();
    };
  }, []);
  const isPlaying = useVideoStore((state) => state.isPlaying);
  const isDragging = useEditorStore((state) => state.isSliderDragging);
  const live = isPlaying && !isDragging;
  return useMemo(
    () => (live && values.size > 0 ? lights.map((light) => animated(light, values)) : lights),
    [live, lights, values],
  );
};

interface RelightLightsProps {
  lights: Array<RelightLight>;
  activeId: string | null;
  basis: RelightBasis;
  zoomScale: number;
  toCanvas(light: RelightLight): Point;
  onSelect(id: string): void;
  onMove(id: string, pos: Point): void;
  onAim(id: string, angle: number, elevation: number): void;
  onDragStateChange(isDragging: boolean): void;
  onHoverChange(isHovered: boolean): void;
  onTouchInteraction(): void;
}

export default function RelightLights({
  lights,
  activeId,
  basis,
  zoomScale,
  toCanvas,
  onSelect,
  onMove,
  onAim,
  onDragStateChange,
  onHoverChange,
  onTouchInteraction,
}: RelightLightsProps) {
  const shown = useLiveLights(lights);
  return (
    <>
      {shown.map((light) => (
        <RelightLightShape
          key={light.id}
          light={light}
          pos={toCanvas(light)}
          basis={basis}
          zoomScale={zoomScale}
          isActive={light.id === activeId}
          onSelect={() => onSelect(light.id)}
          onMove={(pos) => onMove(light.id, pos)}
          onAim={(angle, elevation) => onAim(light.id, angle, elevation)}
          onDragStateChange={onDragStateChange}
          onHoverChange={onHoverChange}
          onTouchInteraction={onTouchInteraction}
        />
      ))}
    </>
  );
}
