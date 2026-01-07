import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useBloc } from '@blac/react';
import { AdjustmentsBloc } from '../../blocs/editor/AdjustmentsBloc.js';
import { usePreviewRequest } from '../../hooks/usePreviewRequest.js';
import type { CurvePoint, CurvesData } from '../../types/adjustments.js';

type CurveChannel = keyof CurvesData;

interface ChannelConfig {
  id: CurveChannel;
  label: string;
  color: string;
}

const CHANNELS: ChannelConfig[] = [
  { id: 'rgb', label: 'L', color: 'rgb(var(--color-accent))' },
  { id: 'red', label: 'R', color: '#FF6B6B' },
  { id: 'green', label: 'G', color: '#6BCB77' },
  { id: 'blue', label: 'B', color: '#4D96FF' },
];

function getCurvePath(points: CurvePoint[]): string {
  if (points.length < 2) return '';

  const n = points.length;
  const deltas: number[] = [];
  const ms: number[] = [];

  for (let i = 0; i < n - 1; i++) {
    const dx = points[i + 1].x - points[i].x;
    const dy = points[i + 1].y - points[i].y;
    if (dx === 0) {
      deltas.push(dy > 0 ? 1e6 : dy < 0 ? -1e6 : 0);
    } else {
      deltas.push(dy / dx);
    }
  }

  ms.push(deltas[0]);

  for (let i = 1; i < n - 1; i++) {
    if (deltas[i - 1] * deltas[i] <= 0) {
      ms.push(0);
    } else {
      ms.push((deltas[i - 1] + deltas[i]) / 2);
    }
  }

  ms.push(deltas[n - 2]);

  for (let i = 0; i < n - 1; i++) {
    if (deltas[i] === 0) {
      ms[i] = 0;
      ms[i + 1] = 0;
    } else {
      const alpha = ms[i] / deltas[i];
      const beta = ms[i + 1] / deltas[i];

      const tau = alpha * alpha + beta * beta;
      if (tau > 9) {
        const scale = 3.0 / Math.sqrt(tau);
        ms[i] = scale * alpha * deltas[i];
        ms[i + 1] = scale * beta * deltas[i];
      }
    }
  }

  let path = `M ${points[0].x} ${255 - points[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const m0 = ms[i];
    const m1 = ms[i + 1];
    const dx = p1.x - p0.x;

    const cp1x = p0.x + dx / 3.0;
    const cp1y = p0.y + (m0 * dx) / 3.0;
    const cp2x = p1.x - dx / 3.0;
    const cp2y = p1.y - (m1 * dx) / 3.0;

    path += ` C ${cp1x.toFixed(2)} ${(255 - cp1y).toFixed(2)}, ${cp2x.toFixed(2)} ${(255 - cp2y).toFixed(2)}, ${p1.x} ${255 - p1.y}`;
  }

  return path;
}

interface ChannelButtonProps {
  channel: ChannelConfig;
  isActive: boolean;
  onClick: () => void;
}

function ChannelButton({ channel, isActive, onClick }: ChannelButtonProps) {
  const bgStyle =
    channel.id !== 'rgb' && !isActive ? { backgroundColor: channel.color + '40' } : undefined;

  return (
    <button
      type="button"
      className={`
        w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center transition-all
        ${isActive ? 'ring-2 ring-offset-2 ring-offset-surface ring-accent' : 'bg-surface-secondary'}
        ${channel.id === 'rgb' ? 'text-text-primary' : ''}
      `}
      onClick={onClick}
      style={bgStyle}
    >
      {channel.label}
    </button>
  );
}

export function ToneCurves() {
  const [state, bloc] = useBloc(AdjustmentsBloc);
  const [activeChannel, setActiveChannel] = useState<CurveChannel>('rgb');
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [localPoints, setLocalPoints] = useState<CurvePoint[] | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const rafRef = useRef<number | null>(null);
  const { requestPreview } = usePreviewRequest();

  const { curves } = state.adjustments;
  const channelConfig = CHANNELS.find((c) => c.id === activeChannel)!;
  const propPoints = curves[activeChannel];
  const points = localPoints ?? propPoints;

  useEffect(() => {
    if (draggingIndex === null) {
      setLocalPoints(null);
    }
  }, [curves[activeChannel], draggingIndex]);

  useEffect(() => {
    setLocalPoints(null);
    setDraggingIndex(null);
  }, [activeChannel]);

  const getMousePos = useCallback(
    (e: MouseEvent | React.MouseEvent): { x: number; y: number } => {
      const svg = svgRef.current;
      if (!svg) return { x: 0, y: 0 };

      const rect = svg.getBoundingClientRect();
      const x = Math.max(0, Math.min(255, ((e.clientX - rect.left) / rect.width) * 255));
      const y = Math.max(0, Math.min(255, 255 - ((e.clientY - rect.top) / rect.height) * 255));
      return { x, y };
    },
    []
  );

  const commitPoints = useCallback(
    (newPoints: CurvePoint[]) => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
      rafRef.current = requestAnimationFrame(() => {
        bloc.setCurveChannel(activeChannel, newPoints);
        rafRef.current = null;
      });
    },
    [bloc, activeChannel]
  );

  const handlePointMouseDown = useCallback(
    (e: React.MouseEvent, index: number) => {
      e.preventDefault();
      e.stopPropagation();
      setLocalPoints([...points]);
      setDraggingIndex(index);
    },
    [points]
  );

  useEffect(() => {
    if (draggingIndex === null) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (draggingIndex === null || !localPoints) return;

      const { x: rawX, y } = getMousePos(e);
      let x = rawX;
      const newPoints = [...localPoints];
      const isEndPoint = draggingIndex === 0 || draggingIndex === localPoints.length - 1;

      if (isEndPoint) {
        x = newPoints[draggingIndex].x;
      } else {
        const prevX = localPoints[draggingIndex - 1].x;
        const nextX = localPoints[draggingIndex + 1].x;
        x = Math.max(prevX + 0.01, Math.min(nextX - 0.01, x));
      }

      newPoints[draggingIndex] = { x, y };
      setLocalPoints(newPoints);
      commitPoints(newPoints);
    };

    const handleMouseUp = () => {
      setDraggingIndex(null);
      requestPreview();
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingIndex, localPoints, getMousePos, commitPoints]);

  const handleCanvasMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as Element;
      if (target.tagName === 'circle') return;

      const { x, y } = getMousePos(e);
      const newPoints = [...points, { x, y }].sort((a, b) => a.x - b.x);
      const newPointIndex = newPoints.findIndex((p) => p.x === x && p.y === y);

      setLocalPoints(newPoints);
      commitPoints(newPoints);
      setDraggingIndex(newPointIndex);
    },
    [points, getMousePos, commitPoints]
  );

  const handleDoubleClick = useCallback(() => {
    const defaultPoints: CurvePoint[] = [
      { x: 0, y: 0 },
      { x: 255, y: 255 },
    ];
    setLocalPoints(defaultPoints);
    bloc.setCurveChannel(activeChannel, defaultPoints);
    requestPreview();
  }, [bloc, activeChannel, requestPreview]);

  const handleReset = useCallback(() => {
    bloc.resetCurves();
    requestPreview();
  }, [bloc, requestPreview]);

  const curvePath = useMemo(() => getCurvePath(points), [points]);

  return (
    <div className="select-none">
      <div className="flex items-center justify-between gap-1 mb-2">
        <div className="flex items-center gap-1">
          {CHANNELS.map((channel) => (
            <ChannelButton
              key={channel.id}
              channel={channel}
              isActive={activeChannel === channel.id}
              onClick={() => setActiveChannel(channel.id)}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={handleReset}
          className="text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          Reset
        </button>
      </div>

      <div
        className="w-full aspect-square bg-surface-secondary p-1 rounded-md relative cursor-crosshair"
        onMouseDown={handleCanvasMouseDown}
        onDoubleClick={handleDoubleClick}
      >
        <svg
          ref={svgRef}
          viewBox="0 0 255 255"
          className="w-full h-full overflow-visible"
        >
          <path
            d="M 63.75,0 V 255 M 127.5,0 V 255 M 191.25,0 V 255 M 0,63.75 H 255 M 0,127.5 H 255 M 0,191.25 H 255"
            stroke="rgba(255,255,255,0.1)"
            strokeWidth="0.5"
          />

          <line
            x1="0"
            y1="255"
            x2="255"
            y2="0"
            stroke="rgba(255,255,255,0.2)"
            strokeWidth="1"
            strokeDasharray="2 2"
          />

          <path
            d={curvePath}
            fill="none"
            stroke={channelConfig.color}
            strokeWidth="2.5"
          />

          {points.map((p, i) => (
            <circle
              key={i}
              className="cursor-pointer"
              cx={p.x}
              cy={255 - p.y}
              r="6"
              fill={channelConfig.color}
              stroke="#1e1e1e"
              strokeWidth="2"
              onMouseDown={(e) => handlePointMouseDown(e, i)}
            />
          ))}
        </svg>
      </div>

      <p className="text-xs text-text-secondary mt-2 text-center">
        Click to add points. Double-click to reset channel.
      </p>
    </div>
  );
}
