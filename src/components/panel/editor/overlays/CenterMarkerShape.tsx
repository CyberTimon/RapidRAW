import { Circle, Group, Line } from 'react-konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { Adjustments } from '../../../../utils/adjustments';
import type { CenterMarker } from '../../../../store/useEditorStore';

interface Point {
  x: number;
  y: number;
}

interface CenterMarkerContour {
  midpoint: number;
  roundness: number;
}

interface CenterMarkerConfig {
  keys: [keyof Adjustments, keyof Adjustments];
  section: 'details' | 'effects';
  getContour(adjustments: Adjustments): CenterMarkerContour;
}

export const CENTER_MARKERS: Record<CenterMarker, CenterMarkerConfig> = {
  vignette: {
    keys: ['vignetteCenterX', 'vignetteCenterY'],
    section: 'effects',
    getContour: (adjustments) => ({
      midpoint: adjustments.vignetteMidpoint ?? 50,
      roundness: adjustments.vignetteRoundness ?? 0,
    }),
  },
  // Centré has a fixed falloff in shader.wgsl (midpoint 0.4, circular).
  centre: {
    keys: ['centréX', 'centréY'],
    section: 'details',
    getContour: () => ({ midpoint: 40, roundness: 0 }),
  },
};

interface CenterMarkerShapeProps {
  pos: Point;
  imageWidth: number;
  imageHeight: number;
  midpoint: number;
  roundness: number;
  zoomScale: number;
  onMove(pos: Point): void;
  onReset(): void;
  onDragStateChange(isDragging: boolean): void;
  onHoverChange(isHovered: boolean): void;
  onTouchInteraction(): void;
}

const CONTOUR_SEGMENTS = 96;

const getMidpointContour = (
  pos: Point,
  width: number,
  height: number,
  midpoint: number,
  roundness: number,
): number[] => {
  const exponent = Math.max(0.05, 1 - roundness / 100);
  const aspect = height / width;
  const mid = midpoint / 100;
  const points: number[] = [];
  for (let i = 0; i <= CONTOUR_SEGMENTS; i++) {
    const t = (i / CONTOUR_SEGMENTS) * 2 * Math.PI;
    const rx = 2 * mid * Math.cos(t);
    const ry = (2 * mid * Math.sin(t)) / aspect;
    const ux = Math.sign(rx) * Math.abs(rx) ** (1 / exponent);
    const uy = Math.sign(ry) * Math.abs(ry) ** (1 / exponent);
    points.push(pos.x + (ux * width) / 2, pos.y + (uy * height) / 2);
  }
  return points;
};

export default function CenterMarkerShape({
  pos,
  imageWidth,
  imageHeight,
  midpoint,
  roundness,
  zoomScale,
  onMove,
  onReset,
  onDragStateChange,
  onHoverChange,
  onTouchInteraction,
}: CenterMarkerShapeProps) {
  const px = (screenPx: number) => screenPx / zoomScale;
  const arm = px(10);
  const gap = px(4);

  const lineProps = {
    stroke: 'white',
    strokeWidth: px(1.5),
    shadowColor: 'black',
    shadowBlur: 3,
    shadowOpacity: 0.7,
    listening: false,
    perfectDrawEnabled: false,
  };

  const setCursor = (e: KonvaEventObject<MouseEvent>, cursor: string) => {
    const stage = e.target.getStage();
    if (stage) stage.container().style.cursor = cursor;
  };

  return (
    <>
      {imageWidth > 0 && imageHeight > 0 && (
        <Line
          {...lineProps}
          points={getMidpointContour(pos, imageWidth, imageHeight, midpoint, roundness)}
          dash={[px(4), px(4)]}
          opacity={0.6}
          strokeWidth={px(1)}
        />
      )}
      <Group
        x={pos.x}
        y={pos.y}
        draggable
        onMouseDown={(e: KonvaEventObject<MouseEvent>) => (e.cancelBubble = true)}
        onTouchStart={(e: KonvaEventObject<TouchEvent>) => {
          e.cancelBubble = true;
          onTouchInteraction();
        }}
        onDblClick={onReset}
        onDblTap={onReset}
        onDragStart={() => onDragStateChange(true)}
        onDragEnd={() => onDragStateChange(false)}
        onDragMove={(e: KonvaEventObject<DragEvent>) => onMove({ x: e.target.x(), y: e.target.y() })}
        onMouseEnter={(e: KonvaEventObject<MouseEvent>) => {
          setCursor(e, 'move');
          onHoverChange(true);
        }}
        onMouseLeave={(e: KonvaEventObject<MouseEvent>) => {
          setCursor(e, '');
          onHoverChange(false);
        }}
      >
        <Circle radius={px(14)} fill="black" opacity={0.01} />
        <Circle
          radius={px(7)}
          stroke="white"
          strokeWidth={px(2)}
          shadowColor="black"
          shadowBlur={4}
          shadowOpacity={0.6}
          listening={false}
        />
        <Circle radius={px(1.5)} fill="white" listening={false} />
        <Line {...lineProps} points={[-arm - gap, 0, -gap - px(3), 0]} />
        <Line {...lineProps} points={[gap + px(3), 0, arm + gap, 0]} />
        <Line {...lineProps} points={[0, -arm - gap, 0, -gap - px(3)]} />
        <Line {...lineProps} points={[0, gap + px(3), 0, arm + gap]} />
      </Group>
    </>
  );
}
