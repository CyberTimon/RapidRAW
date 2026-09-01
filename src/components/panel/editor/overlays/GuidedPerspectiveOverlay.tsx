import { Fragment, useRef, useState } from 'react';
import { Stage, Layer, Line, Circle, Rect } from 'react-konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { v4 as uuidv4 } from 'uuid';
import { GuideLine, GuideOrientation } from '../../../../utils/adjustments';

export interface GuidedResultJson {
  forwardH: number[];
  crop: [number, number, number, number];
  valid: boolean;
  debugVp: ([number, number] | null)[];
}

interface GuidedPerspectiveOverlayProps {
  lines: GuideLine[];
  selectedLineId: string | null;
  result: GuidedResultJson | null;
  autoCrop: boolean;
  imageWidth: number;
  imageHeight: number;
  stageWidth: number;
  stageHeight: number;
  orientationSteps: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
  onLinesChange(lines: GuideLine[]): void;
  onSelectLine(id: string | null): void;
}

function project(h: number[], x: number, y: number): [number, number] {
  const X = h[0] * x + h[1] * y + h[2];
  const Y = h[3] * x + h[4] * y + h[5];
  const W = h[6] * x + h[7] * y + h[8];
  if (Math.abs(W) < 1e-12) {
    return [x, y];
  }
  return [X / W, Y / W];
}

function invert3x3(h: number[]): number[] {
  const a = h[0];
  const b = h[1];
  const c = h[2];
  const d = h[3];
  const e = h[4];
  const f = h[5];
  const g = h[6];
  const hh = h[7];
  const i = h[8];
  const A = e * i - f * hh;
  const B = f * g - d * i;
  const C = d * hh - e * g;
  const D = c * hh - b * i;
  const E = a * i - c * g;
  const F = b * g - a * hh;
  const G = b * f - c * e;
  const H = c * d - a * f;
  const I = a * e - b * d;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) {
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }
  const inv = 1 / det;
  return [A * inv, D * inv, G * inv, B * inv, E * inv, H * inv, C * inv, F * inv, I * inv];
}

function orientPoint(
  x: number,
  y: number,
  w: number,
  h: number,
  steps: number,
): { x: number; y: number; w: number; h: number } {
  const s = ((steps % 4) + 4) % 4;
  if (s === 0) return { x, y, w, h };
  if (s === 1) return { x: h - y, y: x, w: h, h: w };
  if (s === 2) return { x: w - x, y: h - y, w, h };
  return { x: y, y: w - x, w: h, h: w };
}

function unorientPoint(x: number, y: number, w: number, h: number, steps: number): { x: number; y: number } {
  const s = ((steps % 4) + 4) % 4;
  const inv = (4 - s) % 4;
  const r = orientPoint(x, y, w, h, inv);
  return { x: r.x, y: r.y };
}

function orientNormalizedRect(
  rect: [number, number, number, number],
  steps: number,
): [number, number, number, number] {
  const [x, y, w, h] = rect;
  const s = ((steps % 4) + 4) % 4;
  if (s === 0) return [x, y, w, h];
  if (s === 1) return [1 - y - h, x, h, w];
  if (s === 2) return [1 - x - w, 1 - y - h, w, h];
  return [y, 1 - x - w, h, w];
}

function displayDims(imageWidth: number, imageHeight: number, orientationSteps: number) {
  const swapped = ((orientationSteps % 4) + 4) % 4 === 1 || ((orientationSteps % 4) + 4) % 4 === 3;
  return {
    Dw: swapped ? imageHeight : imageWidth,
    Dh: swapped ? imageWidth : imageHeight,
  };
}

export default function GuidedPerspectiveOverlay({
  lines,
  selectedLineId,
  result,
  autoCrop,
  imageWidth,
  imageHeight,
  stageWidth,
  stageHeight,
  orientationSteps,
  flipHorizontal,
  flipVertical,
  onLinesChange,
  onSelectLine,
}: GuidedPerspectiveOverlayProps) {
  const { t } = useTranslation();
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<{ p1: { x: number; y: number }; p2: { x: number; y: number } } | null>(
    null,
  );

  if (stageWidth <= 0 || stageHeight <= 0 || imageWidth <= 0 || imageHeight <= 0) {
    return null;
  }

  const Ow = imageWidth;
  const Oh = imageHeight;
  const { Dw, Dh } = displayDims(Ow, Oh, orientationSteps);
  const validH = result?.valid && result.forwardH?.length === 9 ? result.forwardH : null;
  const invH = validH ? invert3x3(validH) : null;

  const uvToStage = (uv: { x: number; y: number }) => {
    let x = uv.x * Ow;
    let y = uv.y * Oh;
    if (validH) {
      const [px, py] = project(validH, x - Ow / 2, y - Oh / 2);
      x = px + Ow / 2;
      y = py + Oh / 2;
    }
    const oriented = orientPoint(x, y, Ow, Oh, orientationSteps);
    x = oriented.x;
    y = oriented.y;
    if (flipHorizontal) x = Dw - x;
    if (flipVertical) y = Dh - y;
    return { x: x * (stageWidth / Dw), y: y * (stageHeight / Dh) };
  };

  const stageToUv = (pt: { x: number; y: number }) => {
    let x = pt.x / (stageWidth / Dw);
    let y = pt.y / (stageHeight / Dh);
    if (flipHorizontal) x = Dw - x;
    if (flipVertical) y = Dh - y;
    const un = unorientPoint(x, y, Dw, Dh, orientationSteps);
    x = un.x;
    y = un.y;
    if (validH && invH) {
      const [px, py] = project(invH, x - Ow / 2, y - Oh / 2);
      x = px + Ow / 2;
      y = py + Oh / 2;
    }
    return { x: x / Ow, y: y / Oh };
  };

  const tan35 = Math.tan((35 * Math.PI) / 180);
  const diagonal = Math.hypot(Ow, Oh);

  const classifyAndValidate = (p1: { x: number; y: number }, p2: { x: number; y: number }) => {
    const p1px = { x: p1.x * Ow, y: p1.y * Oh };
    const p2px = { x: p2.x * Ow, y: p2.y * Oh };
    const length = Math.hypot(p2px.x - p1px.x, p2px.y - p1px.y);
    if (length < 0.02 * diagonal) {
      return null;
    }
    const dx = p2px.x - p1px.x;
    const dy = p2px.y - p1px.y;
    const nearVertical = Math.abs(dx) <= Math.abs(dy) * tan35;
    const nearHorizontal = Math.abs(dy) <= Math.abs(dx) * tan35;
    if (!nearVertical && !nearHorizontal) {
      toast.error(t('editor.guided.toast.angleRejected'));
      return null;
    }
    const type: GuideOrientation = Math.abs(dx) < Math.abs(dy) ? 'vertical' : 'horizontal';
    return { type, p1, p2 };
  };

  const updatePointer = (stage: { getPointerPosition(): { x: number; y: number } | null } | null) => {
    const pos = stage?.getPointerPosition();
    if (pos) pointerRef.current = pos;
    return pos;
  };

  const handlePointerMove = (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
    const pos = updatePointer(e.target.getStage());
    if (!pos || !draft) return;
    setDraft({ p1: draft.p1, p2: stageToUv(pos) });
  };

  const handlePointerDown = (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
    const stage = e.target.getStage();
    if (e.target !== stage) return;
    const pos = updatePointer(stage);
    if (!pos) return;
    onSelectLine(null);
    const uv = stageToUv(pos);
    setDraft({ p1: uv, p2: uv });
  };

  const handlePointerUp = () => {
    if (!draft) return;
    const classified = classifyAndValidate(draft.p1, draft.p2);
    setDraft(null);
    if (!classified) return;
    const existing = lines.filter((l) => l.type === classified.type).length;
    if (existing >= 2) {
      toast.error(t('editor.guided.toast.maxLines'));
      return;
    }
    onLinesChange([...lines, { id: uuidv4(), type: classified.type, p1: classified.p1, p2: classified.p2 }]);
  };

  const handleToggleType = (line: GuideLine) => {
    const nextType: GuideOrientation = line.type === 'vertical' ? 'horizontal' : 'vertical';
    const p1px = { x: line.p1.x * Ow, y: line.p1.y * Oh };
    const p2px = { x: line.p2.x * Ow, y: line.p2.y * Oh };
    const dx = p2px.x - p1px.x;
    const dy = p2px.y - p1px.y;
    const violates =
      nextType === 'vertical' ? Math.abs(dx) > Math.abs(dy) * tan35 : Math.abs(dy) > Math.abs(dx) * tan35;
    if (violates) {
      toast.error(t('editor.guided.toast.angleRejected'));
      return;
    }
    const nextOfType = lines.filter((l) => l.id !== line.id && l.type === nextType).length;
    if (nextOfType >= 2) {
      toast.error(t('editor.guided.toast.maxLines'));
      return;
    }
    onLinesChange(lines.map((l) => (l.id === line.id ? { ...l, type: nextType } : l)));
  };

  const corners = [
    uvToStage({ x: 0, y: 0 }),
    uvToStage({ x: 1, y: 0 }),
    uvToStage({ x: 1, y: 1 }),
    uvToStage({ x: 0, y: 1 }),
  ];

  let cropRect: { x: number; y: number; width: number; height: number } | null = null;
  if (result?.valid && autoCrop) {
    let rect = orientNormalizedRect(result.crop, orientationSteps);
    if (flipHorizontal) rect = [1 - rect[0] - rect[2], rect[1], rect[2], rect[3]];
    if (flipVertical) rect = [rect[0], 1 - rect[1] - rect[3], rect[2], rect[3]];
    cropRect = {
      x: rect[0] * stageWidth,
      y: rect[1] * stageHeight,
      width: rect[2] * stageWidth,
      height: rect[3] * stageHeight,
    };
  }

  const draftStage = draft ? { p1: uvToStage(draft.p1), p2: uvToStage(draft.p2) } : null;

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 10,
        cursor: 'crosshair',
        touchAction: 'none',
      }}
    >
      <Stage
        width={stageWidth}
        height={stageHeight}
        onMouseDown={handlePointerDown}
        onTouchStart={handlePointerDown}
        onMouseMove={handlePointerMove}
        onTouchMove={handlePointerMove}
        onMouseUp={handlePointerUp}
        onTouchEnd={handlePointerUp}
        onContextMenu={(e) => {
          e.evt.preventDefault();
        }}
      >
        <Layer>
          {result?.valid && (
            <Line
              points={corners.flatMap((c) => [c.x, c.y])}
              closed
              stroke="#FFFFFF"
              strokeWidth={1}
              listening={false}
            />
          )}
          {cropRect && (
            <Rect
              x={cropRect.x}
              y={cropRect.y}
              width={cropRect.width}
              height={cropRect.height}
              stroke="#FFFFFF"
              strokeWidth={1}
              dash={[6, 4]}
              listening={false}
            />
          )}
          {lines.map((line) => {
            const a = uvToStage(line.p1);
            const b = uvToStage(line.p2);
            const selected = line.id === selectedLineId;
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            return (
              <Fragment key={line.id}>
                <Line
                  points={[a.x, a.y, b.x, b.y]}
                  stroke="#FFFFFF"
                  strokeWidth={selected ? 2 : 1.5}
                  opacity={selected ? 1 : 0.7}
                  dash={selected ? undefined : [8, 6]}
                  hitStrokeWidth={16}
                  onClick={(e) => {
                    e.cancelBubble = true;
                    onSelectLine(line.id);
                  }}
                  onTap={(e) => {
                    e.cancelBubble = true;
                    onSelectLine(line.id);
                  }}
                  onContextMenu={(e) => {
                    e.evt.preventDefault();
                    e.evt.stopPropagation();
                    e.cancelBubble = true;
                    onLinesChange(lines.filter((l) => l.id !== line.id));
                    if (selectedLineId === line.id) onSelectLine(null);
                  }}
                />
                <Circle
                  x={a.x}
                  y={a.y}
                  radius={5}
                  fill="#FFFFFF"
                  stroke="#9ca3af"
                  strokeWidth={1}
                  draggable
                  onMouseDown={(e) => {
                    e.cancelBubble = true;
                  }}
                  onDragMove={(e) => {
                    const uv = stageToUv({ x: e.target.x(), y: e.target.y() });
                    onLinesChange(lines.map((l) => (l.id === line.id ? { ...l, p1: uv } : l)));
                  }}
                />
                <Circle
                  x={b.x}
                  y={b.y}
                  radius={5}
                  fill="#FFFFFF"
                  stroke="#9ca3af"
                  strokeWidth={1}
                  draggable
                  onMouseDown={(e) => {
                    e.cancelBubble = true;
                  }}
                  onDragMove={(e) => {
                    const uv = stageToUv({ x: e.target.x(), y: e.target.y() });
                    onLinesChange(lines.map((l) => (l.id === line.id ? { ...l, p2: uv } : l)));
                  }}
                />
                <Rect
                  x={mid.x - 4}
                  y={mid.y - 4}
                  width={8}
                  height={8}
                  fill="#FFFFFF"
                  stroke="#9ca3af"
                  strokeWidth={1}
                  onMouseDown={(e) => {
                    e.cancelBubble = true;
                  }}
                  onClick={(e) => {
                    e.cancelBubble = true;
                    handleToggleType(line);
                  }}
                  onTap={(e) => {
                    e.cancelBubble = true;
                    handleToggleType(line);
                  }}
                />
              </Fragment>
            );
          })}
          {draftStage && (
            <Line
              points={[draftStage.p1.x, draftStage.p1.y, draftStage.p2.x, draftStage.p2.y]}
              stroke="#FFFFFF"
              strokeWidth={1.5}
              opacity={0.7}
              dash={[8, 6]}
              listening={false}
            />
          )}
        </Layer>
      </Stage>
    </div>
  );
}
