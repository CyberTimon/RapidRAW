import { Arrow, Circle, Line } from 'react-konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { RelightLight, getRelightLightColor } from '../../../../utils/adjustments';

interface Point {
  x: number;
  y: number;
}

type Vec3 = [number, number, number];

// Canvas-space images of the relight engine's x and y unit vectors (one unit = the image's long side).
export interface RelightBasis {
  ex: Point;
  ey: Point;
}

interface RelightLightShapeProps {
  light: RelightLight;
  pos: Point;
  basis: RelightBasis;
  zoomScale: number;
  isActive: boolean;
  onSelect(): void;
  onMove(pos: Point): void;
  onAim(angle: number, elevation: number): void;
  onDragStateChange(isDragging: boolean): void;
  onHoverChange(isHovered: boolean): void;
  onTouchInteraction(): void;
}

const ACCENT = '#0ea5e9';
const RING_SEGMENTS = 48;
const DIRECTIONAL_RAYS = 6;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// Direction the light travels, matching relight.rs: +z points into the scene, so a negative elevation aims
// back at the viewer. A spot's angle is where the beam points, a directional light's angle is where the
// light comes from.
const getAim = (type: RelightLight['type'], angle: number, elevation: number): Vec3 => {
  const a = toRad(angle);
  const e = toRad(clamp(elevation, -180, 180));
  const sign = type === 'directional' ? -1 : 1;
  return [sign * Math.cos(a) * Math.cos(e), -sign * Math.sin(a) * Math.cos(e), Math.sin(e)];
};

export default function RelightLightShape({
  light,
  pos,
  basis,
  zoomScale,
  isActive,
  onSelect,
  onMove,
  onAim,
  onDragStateChange,
  onHoverChange,
  onTouchInteraction,
}: RelightLightShapeProps) {
  const { ex, ey } = basis;
  const px = (screenPx: number) => screenPx / zoomScale;
  const unit = Math.hypot(ex.x, ex.y) || 1;
  const color = getRelightLightColor(light);
  const stroke = isActive ? ACCENT : 'white';

  const project = (v: Vec3): Point => ({
    x: pos.x + v[0] * ex.x + v[1] * ey.x,
    y: pos.y + v[0] * ex.y + v[1] * ey.y,
  });

  const handleProps = (cursor: string) => ({
    draggable: true,
    onMouseDown: onSelect,
    onTouchStart: () => {
      onTouchInteraction();
      onSelect();
    },
    onDragStart: () => onDragStateChange(true),
    onDragEnd: () => onDragStateChange(false),
    onMouseEnter: (e: KonvaEventObject<MouseEvent>) => {
      const stage = e.target.getStage();
      if (stage) stage.container().style.cursor = cursor;
      onHoverChange(true);
    },
    onMouseLeave: (e: KonvaEventObject<MouseEvent>) => {
      const stage = e.target.getStage();
      if (stage) stage.container().style.cursor = '';
      onHoverChange(false);
    },
  });

  const positionHandle = (
    <Circle
      x={pos.x}
      y={pos.y}
      radius={px(6 + (100 - light.depth) * 0.06)}
      fill={color}
      stroke={stroke}
      strokeWidth={px(2)}
      shadowColor="black"
      shadowBlur={4}
      shadowOpacity={0.6}
      {...handleProps('move')}
      onDragMove={(e: KonvaEventObject<DragEvent>) => onMove({ x: e.target.x(), y: e.target.y() })}
    />
  );

  if (light.type === 'point') return positionHandle;

  const isSpot = light.type === 'spot';
  const aim = getAim(light.type, light.angle, light.elevation);
  const planar = Math.hypot(aim[0], aim[1]);
  // u, v span the plane perpendicular to the aim; u stays in the image plane so sin(t) > 0 faces the viewer.
  const u: Vec3 = planar > 1e-4 ? [aim[1] / planar, -aim[0] / planar, 0] : [1, 0, 0];
  const v: Vec3 = [-aim[2] * u[1], aim[2] * u[0], aim[0] * u[1] - aim[1] * u[0]];

  const ringPoint = (dist: number, radius: number, t: number): Point => {
    const c = Math.cos(t) * radius;
    const s = Math.sin(t) * radius;
    return project([aim[0] * dist + c * u[0] + s * v[0], aim[1] * dist + c * u[1] + s * v[1], 0]);
  };

  const ring = (dist: number, radius: number, from: number, to: number): number[] => {
    const points: number[] = [];
    const segments = Math.max(2, Math.round((RING_SEGMENTS * (to - from)) / (2 * Math.PI)));
    for (let i = 0; i <= segments; i++) {
      const p = ringPoint(dist, radius, from + ((to - from) * i) / segments);
      points.push(p.x, p.y);
    }
    return points;
  };

  const lineProps = {
    stroke,
    strokeWidth: px(1.5),
    shadowColor: 'black',
    shadowBlur: 3,
    shadowOpacity: 0.7,
    listening: false,
    perfectDrawEnabled: false,
  };
  const dash = [px(4), px(4)];

  const halfAngle = toRad(5 + (clamp(light.cone, 0, 100) / 100) * 80);
  const slant = 0.06 + (0.05 + (clamp(light.radius, 0, 100) / 100) * 1.45) * 0.25;
  const ringDist = isSpot ? slant * Math.cos(halfAngle) : 0;
  const ringRadius = isSpot ? slant * Math.sin(halfAngle) : px(20) / unit;
  const aimLength = isSpot ? slant : px(64) / unit;
  const aimTip = project([aim[0] * aimLength, aim[1] * aimLength, 0]);

  const handleAimDrag = (e: KonvaEventObject<DragEvent>) => {
    const det = ex.x * ey.y - ex.y * ey.x;
    if (Math.abs(det) < 1e-9) return;
    const wx = e.target.x() - pos.x;
    const wy = e.target.y() - pos.y;
    const bx = (wx * ey.y - wy * ey.x) / det / aimLength;
    const by = (ex.x * wy - ex.y * wx) / det / aimLength;
    const length = Math.hypot(bx, by);
    const sign = isSpot ? 1 : -1;
    // The projection cannot tell front from back, so a drag stays in the hemisphere the light already faces.
    const depth = (aim[2] < 0 ? -1 : 1) * Math.sqrt(1 - Math.min(1, length) ** 2);
    const elevation = Math.round((Math.asin(depth) * 180) / Math.PI);
    const angle =
      length > 1e-3
        ? Math.round((((Math.atan2(-sign * by, sign * bx) * 180) / Math.PI) % 360) + 360) % 360
        : light.angle;
    const snapped = getAim(light.type, angle, elevation);
    e.target.position(project([snapped[0] * aimLength, snapped[1] * aimLength, 0]));
    onAim(angle, elevation);
  };

  const sides: number[][] = [];
  if (isSpot) {
    // The apex projects inside the base ellipse once the view axis falls within the cone.
    if (Math.abs(aim[2]) >= Math.cos(halfAngle) - 1e-3) {
      for (let i = 0; i < 4; i++) {
        const p = ringPoint(ringDist, ringRadius, (i * Math.PI) / 2);
        sides.push([pos.x, pos.y, p.x, p.y]);
      }
    } else {
      const ax = aimTip.x - pos.x;
      const ay = aimTip.y - pos.y;
      let minAngle = Infinity;
      let maxAngle = -Infinity;
      let minPoint = pos;
      let maxPoint = pos;
      for (let i = 0; i < RING_SEGMENTS; i++) {
        const p = ringPoint(ringDist, ringRadius, (i * 2 * Math.PI) / RING_SEGMENTS);
        const dx = p.x - pos.x;
        const dy = p.y - pos.y;
        const a = Math.atan2(ax * dy - ay * dx, ax * dx + ay * dy);
        if (a < minAngle) {
          minAngle = a;
          minPoint = p;
        }
        if (a > maxAngle) {
          maxAngle = a;
          maxPoint = p;
        }
      }
      sides.push([pos.x, pos.y, minPoint.x, minPoint.y], [pos.x, pos.y, maxPoint.x, maxPoint.y]);
    }
  }

  const rays: Array<{ from: Point; to: Point }> = [];
  if (!isSpot) {
    for (let i = 0; i < DIRECTIONAL_RAYS; i++) {
      const from = ringPoint(0, ringRadius, (i * 2 * Math.PI) / DIRECTIONAL_RAYS);
      rays.push({ from, to: { x: from.x + aimTip.x - pos.x, y: from.y + aimTip.y - pos.y } });
    }
  }
  const facesViewer = aim[2] < 0;
  const showArrows = Math.hypot(aimTip.x - pos.x, aimTip.y - pos.y) > px(6);
  const innerRadius = ringDist * Math.tan(halfAngle * (1 - clamp(light.feather, 0, 100) / 100));

  return (
    <>
      <Line
        points={ring(ringDist, ringRadius, 0, 2 * Math.PI)}
        closed
        fill={color}
        opacity={facesViewer ? 0.4 : 0.18}
        listening={false}
        perfectDrawEnabled={false}
      />
      <Line {...lineProps} points={ring(ringDist, ringRadius, Math.PI, 2 * Math.PI)} dash={dash} opacity={0.6} />
      <Line {...lineProps} points={ring(ringDist, ringRadius, 0, Math.PI)} />
      {isSpot && innerRadius > 1e-4 && innerRadius < ringRadius - 1e-4 && (
        <Line {...lineProps} points={ring(ringDist, innerRadius, 0, 2 * Math.PI)} dash={dash} strokeWidth={px(1)} />
      )}
      {sides.map((points, i) => (
        <Line key={`side-${i}`} {...lineProps} points={points} />
      ))}
      {rays.map(({ from, to }, i) =>
        showArrows ? (
          <Arrow
            key={`ray-${i}`}
            {...lineProps}
            points={[from.x, from.y, to.x, to.y]}
            fill={stroke}
            pointerLength={px(6)}
            pointerWidth={px(5)}
            strokeWidth={px(1.25)}
          />
        ) : (
          <Circle key={`ray-${i}`} x={from.x} y={from.y} radius={px(2)} fill={stroke} listening={false} />
        ),
      )}
      <Line {...lineProps} points={[pos.x, pos.y, aimTip.x, aimTip.y]} dash={isSpot ? dash : undefined} />
      <Circle
        x={aimTip.x}
        y={aimTip.y}
        radius={px(5 - 2 * aim[2])}
        fill={facesViewer ? color : 'white'}
        stroke={stroke}
        strokeWidth={px(2)}
        shadowColor="black"
        shadowBlur={4}
        shadowOpacity={0.6}
        {...handleProps('crosshair')}
        onDragMove={handleAimDrag}
      />
      {positionHandle}
    </>
  );
}
