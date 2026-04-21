import { useState, useRef, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { RotateCcw, Copy, ClipboardPaste, Spline, SlidersHorizontal } from 'lucide-react';
import { ActiveChannel, Adjustments, Coord, ParametricCurveSettings } from '../../utils/adjustments';
import { Theme, OPTION_SEPARATOR } from '../ui/AppProperties';
import { useContextMenu } from '../../context/ContextMenuContext';
import Text from '../ui/Text';
import Slider from '../ui/Slider';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';

let curveClipboard: Array<Coord> | null = null;
let parametricClipboard: ParametricCurveSettings | null = null;

export interface ChannelConfig {
  [index: string]: ColorData;
  [ActiveChannel.Luma]: ColorData;
  [ActiveChannel.Red]: ColorData;
  [ActiveChannel.Green]: ColorData;
  [ActiveChannel.Blue]: ColorData;
}

interface ColorData {
  color: string;
  data: any;
}

interface CurveGraphProps {
  adjustments: Adjustments;
  histogram: ChannelConfig | null;
  isForMask?: boolean;
  setAdjustments(updater: (prev: any) => any): void;
  theme: string;
  onDragStateChange?: (isDragging: boolean) => void;
}

function getDefaultParametricCurve(): ParametricCurveSettings {
  return {
    darks: 0,
    shadows: 0,
    highlights: 0,
    lights: 0,
    split1: 25,
    split2: 50,
    split3: 75,
  };
}

function getDefaultParametricCurveChannels() {
  return {
    [ActiveChannel.Luma]: getDefaultParametricCurve(),
    [ActiveChannel.Red]: getDefaultParametricCurve(),
    [ActiveChannel.Green]: getDefaultParametricCurve(),
    [ActiveChannel.Blue]: getDefaultParametricCurve(),
  };
}

function isDefaultParametricCurve(settings: ParametricCurveSettings | undefined) {
  if (!settings) return true;
  const defaults = getDefaultParametricCurve();
  return (
    settings.darks === defaults.darks &&
    settings.shadows === defaults.shadows &&
    settings.highlights === defaults.highlights &&
    settings.lights === defaults.lights &&
    settings.split1 === defaults.split1 &&
    settings.split2 === defaults.split2 &&
    settings.split3 === defaults.split3
  );
}

function getInfluence(slider: string, splitPointValue: number): number {
  
  if (slider === 'shadows') {
    if (splitPointValue < 0 || splitPointValue > 0.30) return 0;
    const t = splitPointValue / 0.30;
    const influence = Math.sin(t * Math.PI);
    return influence;
  } 
  else if (slider === 'darks') {
    if (splitPointValue < 0.20 || splitPointValue > 0.55) return 0;
    const t = (splitPointValue - 0.20) / 0.35;
    const influence = Math.sin(t * Math.PI);
    return influence;
  } 
  else if (slider === 'lights') {
    if (splitPointValue < 0.45 || splitPointValue > 0.80) return 0;
    const t = (splitPointValue - 0.45) / 0.35;
    const influence = Math.sin(t * Math.PI);
    return influence;
  } 
  else if (slider === 'highlights') {
    if (splitPointValue < 0.70 || splitPointValue > 1.0) return 0;
    const t = (splitPointValue - 0.70) / 0.30;
    const influence = Math.sin(t * Math.PI);
    return influence;
  }
  return 0;
}

const MAX_OFFSET = 0.25;

function computeControlPoints(settings: ParametricCurveSettings) {
  const normShadows = settings.shadows / 100;
  const normDarks = settings.darks / 100;
  const normLights = settings.lights / 100;
  const normHighlights = settings.highlights / 100;

  const split1 = settings.split1 / 100;
  const split2 = settings.split2 / 100;
  const split3 = settings.split3 / 100;

  function offsetAt(splitPointNorm: number): number {
    let off = 0;
    off += normShadows * getInfluence('shadows', splitPointNorm) * MAX_OFFSET;
    off += normDarks * getInfluence('darks', splitPointNorm) * MAX_OFFSET;
    off += normLights * getInfluence('lights', splitPointNorm) * MAX_OFFSET;
    off += normHighlights * getInfluence('highlights', splitPointNorm) * MAX_OFFSET;
    return off;
  }

  let y1 = split1 + offsetAt(split1);
  let y2 = split2 + offsetAt(split2);
  let y3 = split3 + offsetAt(split3);

  const minGap = 0.01;
  
  y1 = Math.min(Math.max(y1, 0.02), Math.min(y2 - minGap, 0.98));
  y2 = Math.min(Math.max(y2, y1 + minGap), Math.min(y3 - minGap, 0.95));
  y3 = Math.min(Math.max(y3, y2 + minGap), 0.98);

  return { y1, y2, y3 };
}

function createMonotonicSpline(xp: number[], yp: number[]) {
  const n = xp.length;
  const m = new Array(n);
  const delta = [];

  for (let i = 0; i < n - 1; i++) {
    delta.push((yp[i + 1] - yp[i]) / (xp[i + 1] - xp[i]));
  }

  for (let i = 0; i < n; i++) {
    if (i === 0) {
      m[i] = delta[0];
    } else if (i === n - 1) {
      m[i] = delta[n - 2];
    } else {
      if (delta[i - 1] * delta[i] <= 0) {
        m[i] = 0;
      } else {
        const w1 = 2 * (xp[i + 1] - xp[i]);
        const w2 = 2 * (xp[i] - xp[i - 1]);
        m[i] = (w1 * delta[i - 1] + w2 * delta[i]) / (w1 + w2);
      }
    }
  }

  for (let i = 0; i < n - 1; i++) {
    if (delta[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const alpha = m[i] / delta[i];
      const beta = m[i + 1] / delta[i];
      
      if (alpha * alpha + beta * beta > 9) {
        const tau = 3.0 / Math.sqrt(alpha * alpha + beta * beta);
        m[i] = tau * alpha * delta[i];
        m[i + 1] = tau * beta * delta[i];
      }
    }
  }

  return function (t: number) {
    if (t <= xp[0]) return yp[0];
    if (t >= xp[n - 1]) return yp[n - 1];

    let idx = 0;
    for (let i = 0; i < n - 1; i++) {
      if (t >= xp[i] && t <= xp[i + 1]) {
        idx = i;
        break;
      }
    }

    const x0 = xp[idx], x1 = xp[idx + 1];
    const y0 = yp[idx], y1 = yp[idx + 1];
    const m0 = m[idx], m1 = m[idx + 1];
    const h = x1 - x0;
    const tNorm = (t - x0) / h;
    const t2 = tNorm * tNorm;
    const t3 = t2 * tNorm;

    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + tNorm;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;

    return h00 * y0 + h10 * m0 * h + h01 * y1 + h11 * m1 * h;
  };
}

function buildParametricCurve(settings: ParametricCurveSettings, pointCount = 256): Array<Coord> {
  const split1 = settings.split1 / 100;
  const split2 = settings.split2 / 100;
  const split3 = settings.split3 / 100;

  const { y1, y2, y3 } = computeControlPoints(settings);

  const xPoints = [0, split1, split2, split3, 1];
  const yPoints = [0, y1, y2, y3, 1];

  const spline = createMonotonicSpline(xPoints, yPoints);

  const points: Array<Coord> = [];

  for (let i = 0; i < pointCount; i++) {
    const x = (i / (pointCount - 1)) * 255;
    const t = x / 255;
    let y = spline(t);
    y = Math.max(0, Math.min(1, y));

    points.push({
      x,
      y: y * 255,
    });
  }

  return points;
}

function buildParametricCurvePreview(settings: ParametricCurveSettings): Array<Coord> {
  return buildParametricCurve(settings, 256);
}

function getCurvePath(points: Array<Coord>) {
  if (points.length < 2) return '';

  const n = points.length;
  const deltas = [];
  const ms = [];

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
      const alpha: number = ms[i] / deltas[i];
      const beta: number = ms[i + 1] / deltas[i];

      const tau = alpha * alpha + beta * beta;
      if (tau > 9) {
        const scale = 3.0 / Math.sqrt(tau);
        ms[i] = scale * alpha * deltas[i];
        ms[i + 1] = scale * beta * deltas[i];
      }
    }
  }

  let path = '';

  if (points[0].x > 0) {
    path += `M 0 ${255 - points[0].y} L ${points[0].x} ${255 - points[0].y}`;
  } else {
    path += `M ${points[0].x} ${255 - points[0].y}`;
  }

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

    path += ` C ${cp1x.toFixed(2)} ${255 - Number(cp1y.toFixed(2))}, ${cp2x.toFixed(2)} ${
      255 - Number(cp2y.toFixed(2))
    }, ${p1.x} ${255 - p1.y}`;
  }

  if (points[n - 1].x < 255) {
    path += ` L 255 ${255 - points[n - 1].y}`;
  }

  return path;
}

function getHistogramPath(data: Array<any>) {
  if (!data || data.length === 0) {
    return '';
  }
  const maxVal = Math.max(...data);
  if (maxVal === 0) {
    return '';
  }

  const pathData = data
    .map((value: number, index: number) => {
      const x = (index / 255) * 255;
      const y = (value / maxVal) * 255;
      return `${x},${255 - y}`;
    })
    .join(' ');

  return `M0,255 L${pathData} L255,255 Z`;
}

function getZeroHistogramPath(data: Array<any>) {
  if (!data || data.length === 0) {
    return '';
  }
  const pathData = data
    .map((_, index: number) => {
      const x = (index / 255) * 255;
      return `${x},255`;
    })
    .join(' ');

  return `M0,255 L${pathData} L255,255 Z`;
}

function isDefaultCurve(points: Array<Coord> | undefined) {
  if (!points || points.length !== 2) return false;
  const [p1, p2] = points;
  return p1.x === 0 && p1.y === 0 && p2.x === 255 && p2.y === 255;
}

function areCurvesEqual(a: Array<Coord> | undefined, b: Array<Coord> | undefined) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) {
    if (a[i].x !== b[i].x || a[i].y !== b[i].y) {
      return false;
    }
  }

  return true;
}

export default function CurveGraph({
  adjustments,
  setAdjustments,
  histogram,
  theme,
  isForMask,
  onDragStateChange,
}: CurveGraphProps) {
  const { showContextMenu } = useContextMenu();
  const [activeChannel, setActiveChannel] = useState<ActiveChannel>(ActiveChannel.Luma);
  const [draggingPointIndex, setDraggingPointIndex] = useState<number | null>(null);
  const [draggingSplitKey, setDraggingSplitKey] = useState<'split1' | 'split2' | 'split3' | null>(null);
  const [localPoints, setLocalPoints] = useState<Array<Coord> | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [curveMode, setCurveMode] = useState<'point' | 'parametric'>('point');
  const [activeParametricChannel, setActiveParametricChannel] = useState<ActiveChannel>(ActiveChannel.Luma);

  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const activeChannelRef = useRef(activeChannel);
  const draggingIndexRef = useRef<number | null>(null);
  const localPointsRef = useRef<Array<Coord> | null>(null);
  const propPointsRef = useRef<Array<Coord> | undefined>(undefined);
  const isHoveredRef = useRef(false);

  const parametricCurves = adjustments?.parametricCurve || getDefaultParametricCurveChannels();
  const parametricCurve = parametricCurves[activeParametricChannel] || getDefaultParametricCurve();
  const isParametricMode = curveMode === 'parametric';

  const parametricPreviewPoints = useMemo(() => buildParametricCurvePreview(parametricCurve), [parametricCurve]);

  useEffect(() => {
    activeChannelRef.current = activeChannel;
    setLocalPoints(null);
    setDraggingPointIndex(null);
  }, [activeChannel]);

  useEffect(() => {
    if (curveMode === 'parametric') {
      setActiveParametricChannel(ActiveChannel.Luma);
    }
  }, [curveMode]);

  useEffect(() => {
    propPointsRef.current = adjustments?.curves?.[activeChannel];
  }, [adjustments?.curves, activeChannel]);

  useEffect(() => {
    if (draggingPointIndex === null) {
      setLocalPoints(null);
      localPointsRef.current = null;
    }
  }, [adjustments?.curves?.[activeChannel], draggingPointIndex]);

  useEffect(() => {
    const isDragging = draggingPointIndex !== null || draggingSplitKey !== null;
    onDragStateChange?.(isDragging);
    draggingIndexRef.current = draggingPointIndex;
  }, [draggingPointIndex, draggingSplitKey, onDragStateChange]);

  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();

      const isInside =
        e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;

      if (isInside !== isHoveredRef.current) {
        isHoveredRef.current = isInside;
        setIsHovered(isInside);
      }
    };

    window.addEventListener('mousemove', handleGlobalMouseMove, { passive: true });

    return () => {
      window.removeEventListener('mousemove', handleGlobalMouseMove);
    };
  }, []);

  useEffect(() => {
    if (adjustments.curveMode !== curveMode) {
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        curveMode: curveMode,
      }));
    }
  }, [curveMode, adjustments.curveMode, setAdjustments]);

  useEffect(() => {
    const handleMove = (e: any) => {
      const index = draggingIndexRef.current;
      if (index === null) return;

      const currentPoints = localPointsRef.current || propPointsRef.current;
      if (!currentPoints || isParametricMode) return;

      const svg = svgRef.current;
      if (!svg) return;

      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;

      const rect = svg.getBoundingClientRect();
      let x = Math.max(0, Math.min(255, ((clientX - rect.left) / rect.width) * 255));
      const y = Math.max(0, Math.min(255, 255 - ((clientY - rect.top) / rect.height) * 255));

      const newPoints = [...currentPoints];

      const SNAP_THRESHOLD = 5;
      if (x < SNAP_THRESHOLD) x = 0;
      if (x > 255 - SNAP_THRESHOLD) x = 255;

      const prevX = index > 0 ? currentPoints[index - 1].x : 0;
      const nextX = index < currentPoints.length - 1 ? currentPoints[index + 1].x : 255;

      const minX = index === 0 ? 0 : prevX + 0.01;
      const maxX = index === currentPoints.length - 1 ? 255 : nextX - 0.01;

      x = Math.max(minX, Math.min(maxX, x));

      newPoints[index] = { x, y };

      localPointsRef.current = newPoints;
      setLocalPoints(newPoints);

      setAdjustments((prev: Adjustments) => ({
        ...prev,
        curves: { ...prev.curves, [activeChannelRef.current]: newPoints },
      }));

      if (e.cancelable) e.preventDefault();
    };

    const handleParametricMove = (e: any) => {
      if (!draggingSplitKey) return;

      const svg = svgRef.current;
      if (!svg) return;

      const rect = svg.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const rawX = ((clientX - rect.left) / rect.width) * 100;

      const minGap = 10;
      let nextValue = Math.max(0, Math.min(100, rawX));

      if (draggingSplitKey === 'split1') {
        nextValue = Math.min(nextValue, parametricCurve.split2 - minGap);
        nextValue = Math.max(nextValue, 10);
      } else if (draggingSplitKey === 'split2') {
        nextValue = Math.max(nextValue, parametricCurve.split1 + minGap);
        nextValue = Math.min(nextValue, parametricCurve.split3 - minGap);
      } else if (draggingSplitKey === 'split3') {
        nextValue = Math.max(nextValue, parametricCurve.split2 + minGap);
        nextValue = Math.min(nextValue, 90);
      }

      setAdjustments((prev: Adjustments) => {
        const parametricChannels = prev.parametricCurve || getDefaultParametricCurveChannels();
        return {
          ...prev,
          parametricCurve: {
            ...parametricChannels,
            [activeParametricChannel]: {
              ...(parametricChannels[activeParametricChannel] || getDefaultParametricCurve()),
              [draggingSplitKey]: nextValue,
            },
          },
        };
      });
    };

    const handleUp = () => {
      setDraggingPointIndex(null);
      setDraggingSplitKey(null);
      draggingIndexRef.current = null;
      localPointsRef.current = null;
      onDragStateChange?.(false);
    };

    if (draggingPointIndex !== null) {
      window.addEventListener('mousemove', handleMove, { passive: false });
      window.addEventListener('mouseup', handleUp);
      window.addEventListener('touchmove', handleMove, { passive: false });
      window.addEventListener('touchend', handleUp);
      window.addEventListener('touchcancel', handleUp);
    } else if (draggingSplitKey !== null) {
      window.addEventListener('mousemove', handleParametricMove);
      window.addEventListener('mouseup', handleUp);
      window.addEventListener('touchmove', handleParametricMove);
      window.addEventListener('touchend', handleUp);
      window.addEventListener('touchcancel', handleUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      window.removeEventListener('touchmove', handleMove);
      window.removeEventListener('touchend', handleUp);
      window.removeEventListener('touchcancel', handleUp);
      window.removeEventListener('mousemove', handleParametricMove);
      window.removeEventListener('touchmove', handleParametricMove);
    };
  }, [draggingPointIndex, draggingSplitKey, setAdjustments, onDragStateChange, parametricCurve, isParametricMode, activeParametricChannel]);

  const isLightTheme = theme === Theme.Light || theme === Theme.Arctic;
  const histogramOpacity = isLightTheme ? 0.6 : 0.15;

  const channelConfig: ChannelConfig = {
    luma: { color: 'var(--color-accent)', data: histogram?.luma },
    red: { color: '#FF6B6B', data: histogram?.red },
    green: { color: '#6BCB77', data: histogram?.green },
    blue: { color: '#4D96FF', data: histogram?.blue },
  };

  const propPoints = adjustments?.curves?.[activeChannel];
  const pointModePoints = localPoints ?? propPoints;
  const points = isParametricMode ? parametricPreviewPoints : pointModePoints;
  const renderChannel = isParametricMode ? activeParametricChannel : activeChannel;
  const { color, data: histogramData } = channelConfig[renderChannel];

  if ((!propPoints && !isParametricMode) || !points) {
    return (
      <Text
        as="div"
        variant={TextVariants.small}
        className="w-full aspect-square bg-surface-secondary p-1 rounded-md flex items-center justify-center"
      >
        Curve data not available.
      </Text>
    );
  }

  const getPointerPos = (e: any) => {
    const svg = svgRef.current;
    if (!svg) {
      return { x: 0, y: 0 };
    }
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const rect = svg.getBoundingClientRect();
    const x = Math.max(0, Math.min(255, ((clientX - rect.left) / rect.width) * 255));
    const y = Math.max(0, Math.min(255, 255 - ((clientY - rect.top) / rect.height) * 255));
    return { x, y };
  };

  const updateParametricValue = (key: keyof ParametricCurveSettings, value: number) => {
    if (isForMask) {
      setAdjustments((prev: any) => {
        const currentParametricCurve = prev.parametricCurve || getDefaultParametricCurveChannels();
        return {
          ...prev,
          parametricCurve: {
            ...currentParametricCurve,
            [activeParametricChannel]: {
              ...(currentParametricCurve[activeParametricChannel] || getDefaultParametricCurve()),
              [key]: value,
            },
          },
        };
      });
    } else {
      setAdjustments((prev: Adjustments) => {
        const parametricChannels = prev.parametricCurve || getDefaultParametricCurveChannels();
        return {
          ...prev,
          parametricCurve: {
            ...parametricChannels,
            [activeParametricChannel]: {
              ...(parametricChannels[activeParametricChannel] || getDefaultParametricCurve()),
              [key]: value,
            },
          },
        };
      });
    }
  };

  const handlePointStart = (e: any, index: number) => {
    if (isParametricMode) return;

    if (e.button === 2) return;
    
    if (!e.touches) e.preventDefault();
    e.stopPropagation();

    onDragStateChange?.(true);

    setLocalPoints(points);
    localPointsRef.current = points;
    setDraggingPointIndex(index);
    draggingIndexRef.current = index;
  };

  const handlePointContextMenu = (e: React.MouseEvent, index: number) => {
    if (isParametricMode || !pointModePoints) return;

    if (index > 0 && index < pointModePoints.length - 1) {
      e.preventDefault();
      e.stopPropagation();

      const newPoints = pointModePoints.filter((_, i) => i !== index);

      setLocalPoints(newPoints);
      localPointsRef.current = newPoints;

      setAdjustments((prev: Adjustments) => ({
        ...prev,
        curves: { ...prev.curves, [activeChannel]: newPoints },
      }));
    }
  };

  const handleContainerStart = (e: any) => {
    if (isParametricMode || !pointModePoints) return;
    if ((!e.touches && e.button !== 0) || e.target.tagName === 'circle') {
      return;
    }

    onDragStateChange?.(true);

    const { x, y } = getPointerPos(e);
    const newPoints = [...pointModePoints, { x, y }].sort((a: Coord, b: Coord) => a.x - b.x);
    const newPointIndex = newPoints.findIndex((p: Coord) => p.x === x && p.y === y);

    setLocalPoints(newPoints);
    localPointsRef.current = newPoints;

    setAdjustments((prev: Adjustments) => ({
      ...prev,
      curves: { ...prev.curves, [activeChannel]: newPoints },
    }));

    setDraggingPointIndex(newPointIndex);
    draggingIndexRef.current = newPointIndex;
  };

  const handleDoubleClick = () => {
    if (isParametricMode) {
      const defaultCurvePoints = [
        { x: 0, y: 0 },
        { x: 255, y: 255 },
      ];

      setAdjustments((prev: Adjustments) => {
        const parametricChannels = prev.parametricCurve || getDefaultParametricCurveChannels();

        return {
          ...prev,
          parametricCurve: {
            ...parametricChannels,
            [activeParametricChannel]: getDefaultParametricCurve(),
          },
          curves: {
            ...prev.curves,
            [activeParametricChannel]: defaultCurvePoints,
          },
        };
      });
      return;
    }

    const defaultPoints = [
      { x: 0, y: 0 },
      { x: 255, y: 255 },
    ];

    setLocalPoints(defaultPoints);
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      curves: { ...prev.curves, [activeChannel]: defaultPoints },
    }));
  };

  const handleResetParametric = () => {
    const defaultCurvePoints = [
      { x: 0, y: 0 },
      { x: 255, y: 255 },
    ];

    if (isForMask) {
      setAdjustments((prev: any) => {
        const parametricChannels = prev.parametricCurve || getDefaultParametricCurveChannels();
        return {
          ...prev,
          parametricCurve: {
            ...parametricChannels,
            [activeParametricChannel]: getDefaultParametricCurve(),
          },
          curves: {
            ...prev.curves,
            [activeParametricChannel]: defaultCurvePoints,
          },
        };
      });
    } else {
      setAdjustments((prev: Adjustments) => {
        const parametricChannels = prev.parametricCurve || getDefaultParametricCurveChannels();
        return {
          ...prev,
          parametricCurve: {
            ...parametricChannels,
            [activeParametricChannel]: getDefaultParametricCurve(),
          },
          curves: {
            ...prev.curves,
            [activeParametricChannel]: defaultCurvePoints,
          },
        };
      });
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (isParametricMode) {
      const handleCopyParametric = () => {
        parametricClipboard = { ...parametricCurve };
      };

      const handlePasteParametric = () => {
        if (!parametricClipboard) return;
        setAdjustments((prev: Adjustments) => {
          const parametricChannels = prev.parametricCurve || getDefaultParametricCurveChannels();
          return {
            ...prev,
            parametricCurve: {
              ...parametricChannels,
              [activeParametricChannel]: { ...parametricClipboard },
            },
          };
        });
      };

      const handleResetAllParametric = () => {
        const defaultCurvePoints = [
          { x: 0, y: 0 },
          { x: 255, y: 255 },
        ];

        setAdjustments((prev: Adjustments) => {
          return {
            ...prev,
            parametricCurve: {
              [ActiveChannel.Luma]: getDefaultParametricCurve(),
              [ActiveChannel.Red]: getDefaultParametricCurve(),
              [ActiveChannel.Green]: getDefaultParametricCurve(),
              [ActiveChannel.Blue]: getDefaultParametricCurve(),
            },
            curves: {
              ...prev.curves,
              [ActiveChannel.Luma]: defaultCurvePoints,
              [ActiveChannel.Red]: defaultCurvePoints,
              [ActiveChannel.Green]: defaultCurvePoints,
              [ActiveChannel.Blue]: defaultCurvePoints,
            },
          };
        });
      };

      const areOtherParametricChannelsDirty = [ActiveChannel.Luma, ActiveChannel.Red, ActiveChannel.Green, ActiveChannel.Blue].some(
        (channel) => {
          if (channel === activeParametricChannel) return false;
          return !isDefaultParametricCurve(parametricCurves[channel]);
        },
      );

      const parametricOptions = [
        {
          label: 'Copy Parametric Curve',
          icon: Copy,
          onClick: handleCopyParametric,
        },
        {
          label: 'Paste Parametric Curve',
          icon: ClipboardPaste,
          onClick: handlePasteParametric,
          disabled: !parametricClipboard,
        },
        { type: OPTION_SEPARATOR },
        {
          label: `Reset ${activeParametricChannel.charAt(0).toUpperCase() + activeParametricChannel.slice(1)} Parametric Curve`,
          icon: RotateCcw,
          onClick: handleResetParametric,
        },
      ];

      if (areOtherParametricChannelsDirty) {
        parametricOptions.push({
          label: 'Reset All Parametric Curves',
          icon: RotateCcw,
          onClick: handleResetAllParametric,
        });
      }

      showContextMenu(e.clientX, e.clientY, parametricOptions);
      return;
    }

    const handleCopy = () => {
      curveClipboard = pointModePoints.map((p) => ({ ...p }));
    };

    const handlePaste = () => {
      if (!curveClipboard) return;
      const newPoints = curveClipboard.map((p) => ({ ...p }));

      setLocalPoints(newPoints);
      localPointsRef.current = newPoints;

      setAdjustments((prev: Adjustments) => ({
        ...prev,
        curves: { ...prev.curves, [activeChannel]: newPoints },
      }));
    };

    const handleReset = () => {
      const defaultPoints = [
        { x: 0, y: 0 },
        { x: 255, y: 255 },
      ];
      setLocalPoints(defaultPoints);
      localPointsRef.current = defaultPoints;

      setAdjustments((prev: Adjustments) => ({
        ...prev,
        curves: { ...prev.curves, [activeChannel]: defaultPoints },
      }));
    };

    const handleResetAll = () => {
      const defaultPoints = [
        { x: 0, y: 0 },
        { x: 255, y: 255 },
      ];

      setLocalPoints(defaultPoints);
      localPointsRef.current = defaultPoints;

      setAdjustments((prev: Adjustments) => ({
        ...prev,
        curves: {
          [ActiveChannel.Luma]: defaultPoints,
          [ActiveChannel.Red]: defaultPoints,
          [ActiveChannel.Green]: defaultPoints,
          [ActiveChannel.Blue]: defaultPoints,
        },
      }));
    };

    const areOtherChannelsDirty = [ActiveChannel.Luma, ActiveChannel.Red, ActiveChannel.Green, ActiveChannel.Blue].some(
      (channel) => {
        if (channel === activeChannel) return false;
        return !isDefaultCurve(adjustments.curves?.[channel]);
      },
    );

    const options = [
      {
        label: 'Copy Point Curve',
        icon: Copy,
        onClick: handleCopy,
      },
      {
        label: 'Paste Point Curve',
        icon: ClipboardPaste,
        onClick: handlePaste,
        disabled: !curveClipboard,
      },
      { type: OPTION_SEPARATOR },
      {
        label: `Reset ${activeChannel.charAt(0).toUpperCase() + activeChannel.slice(1)} Point Curve`,
        icon: RotateCcw,
        onClick: handleReset,
      },
    ];

    if (areOtherChannelsDirty) {
      options.push({
        label: 'Reset All Point Curves',
        icon: RotateCcw,
        onClick: handleResetAll,
      });
    }

    showContextMenu(e.clientX, e.clientY, options);
  };

  const splitPositions = [
    { key: 'split1' as const, value: parametricCurve.split1 },
    { key: 'split2' as const, value: parametricCurve.split2 },
    { key: 'split3' as const, value: parametricCurve.split3 },
  ];

  return (
    <div className="select-none touch-none" ref={containerRef}>
      <div className="flex items-center justify-between gap-2 mb-2 mt-2">
        <div className="flex items-center gap-1 p-1 rounded-lg bg-surface-secondary shrink-0">
          <button
            className={`w-8 h-8 rounded-md flex items-center justify-center transition-all ${
              !isParametricMode ? 'bg-surface text-text-primary' : 'text-text-secondary hover:text-text-primary'
            }`}
            onClick={() => setCurveMode('point')}
            title="Point Curve"
            type="button"
          >
            <Spline size={16} />
          </button>
          <button
            className={`w-8 h-8 rounded-md flex items-center justify-center transition-all ${
              isParametricMode ? 'bg-surface text-text-primary' : 'text-text-secondary hover:text-text-primary'
            }`}
            onClick={() => setCurveMode('parametric')}
            title="Parametric Curve"
            type="button"
          >
            <SlidersHorizontal size={16} />
          </button>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {Object.keys(channelConfig).map((channel: any) => {
            const selected = isParametricMode ? activeParametricChannel === channel : activeChannel === channel;

            return (
              <button
                className={`w-7 h-7 rounded-full flex items-center justify-center transition-all
                ${
                  selected
                    ? 'ring-2 ring-offset-2 ring-offset-surface ring-accent'
                    : 'bg-surface-secondary'
                }
                ${channel === ActiveChannel.Luma ? 'text-text-primary' : ''}`}
                key={channel}
                onClick={() =>
                  isParametricMode
                    ? setActiveParametricChannel(channel as ActiveChannel)
                    : setActiveChannel(channel as ActiveChannel)
                }
                type="button"
                style={{
                  backgroundColor:
                    channel !== ActiveChannel.Luma && !selected
                      ? channelConfig[channel].color + '40'
                      : undefined,
                }}
                title={`${channel.charAt(0).toUpperCase() + channel.slice(1)} Channel`}
              >
                <Text variant={TextVariants.small} color={TextColors.primary} weight={TextWeights.bold}>
                  {channel.charAt(0).toUpperCase()}
                </Text>
              </button>
            );
          })}
        </div>
      </div>

      <div
        className="w-full aspect-square bg-surface-secondary p-1 rounded-md relative touch-none"
        onMouseDown={handleContainerStart}
        onTouchStart={handleContainerStart}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
      >
        <svg ref={svgRef} viewBox="0 0 255 255" className="w-full h-full overflow-visible">
          <path
            d="M 63.75,0 V 255 M 127.5,0 V 255 M 191.25,0 V 255 M 0,63.75 H 255 M 0,127.5 H 255 M 0,191.25 H 255"
            stroke="rgba(255,255,255,0.1)"
            strokeWidth="0.5"
          />

          <AnimatePresence>
            {histogramData && (
              <motion.path
                key={renderChannel}
                fill={color}
                initial={{ d: getZeroHistogramPath(histogramData), opacity: 0 }}
                animate={{
                  d: getHistogramPath(histogramData),
                  opacity: histogramOpacity,
                  transition: { d: { duration: 0.5, ease: [0.22, 1, 0.36, 1] }, opacity: { duration: 1 } },
                }}
                exit={{
                  d: getZeroHistogramPath(histogramData),
                  opacity: 0,
                  transition: { d: { duration: 0.3, ease: [0.55, 0, 0.78, 0.34] }, opacity: { duration: 1 } },
                }}
              />
            )}
          </AnimatePresence>

          <line x1="0" y1="255" x2="255" y2="0" stroke="rgba(255,255,255,0.2)" strokeWidth="1" strokeDasharray="2 2" />

          {isParametricMode &&
            splitPositions.map(({ key, value }) => {
              const x = (value / 100) * 255;
              return <line key={key} x1={x} y1="0" x2={x} y2="255" stroke="rgba(255,255,255,0.12)" strokeWidth="1" />;
            })}

          <path d={getCurvePath(points)} fill="none" stroke={color} strokeWidth="2.5" />

          {!isParametricMode &&
            points.map((p: Coord, i: number) => (
              <circle
                className="cursor-pointer"
                cx={p.x}
                cy={255 - p.y}
                fill={color}
                key={i}
                onMouseDown={(e: any) => handlePointStart(e, i)}
                onTouchStart={(e: any) => handlePointStart(e, i)}
                onContextMenu={(e: React.MouseEvent) => handlePointContextMenu(e, i)}
                r="6"
                stroke="#1e1e1e"
                strokeWidth="2"
              />
            ))}
        </svg>

        {isParametricMode && (
          <div className="absolute left-0 right-0 -bottom-8 px-1">
            <div className="relative">
              <div className="h-7 rounded-md bg-surface border border-border overflow-hidden relative">
                <div
                  className="absolute inset-0"
                  style={{
                    background: `linear-gradient(
                      to right,
                      rgba(0, 0, 0, 0.8) 0%,
                      rgba(64, 64, 64, 0.8) 25%,
                      rgba(105, 101, 101, 0.8) 50%,
                      rgba(158, 154, 154, 0.8) 75%,
                      rgba(198, 195, 197, 0.8) 100%
                    )`,
                  }}
                />

                <div className="absolute top-0 left-0 right-0 h-px bg-white/20" />

                {splitPositions.map(({ key, value }) => (
                  <button
                    key={key}
                    className="absolute top-0 bottom-0 w-3 -translate-x-1/2 cursor-ew-resize group"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDraggingSplitKey(key);
                    }}
                    onTouchStart={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDraggingSplitKey(key);
                    }}
                    onDoubleClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const defaults = getDefaultParametricCurve();
                      updateParametricValue(key, defaults[key]);
                    }}
                    style={{ left: `${value}%` }}
                    type="button"
                  >
                    <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-white/70 group-hover:bg-white" />
                    <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-4 rounded-sm bg-white/80 border border-white/60 group-hover:bg-white group-hover:border-white" />
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {isParametricMode && (
        <div 
          className="mt-14 flex flex-col gap-2"
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handleContextMenu(e);
          }}
        >
          <Text
            as="div"
            variant={TextVariants.small}
            color={TextColors.secondary}
            className="mb-1"
          >
            Parametric Channel: {activeParametricChannel.charAt(0).toUpperCase() + activeParametricChannel.slice(1)}
          </Text>
          <div onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handleContextMenu(e); }}>
            <Slider
              label="Highlights"
              min={-100}
              max={100}
              step={1}
              defaultValue={0}
              value={parametricCurve.highlights}
              onChange={(e: any) => updateParametricValue('highlights', parseFloat(e.target.value))}
            />
          </div>
          <div onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handleContextMenu(e); }}>
            <Slider
              label="Lights"
              min={-100}
              max={100}
              step={1}
              defaultValue={0}
              value={parametricCurve.lights}
              onChange={(e: any) => updateParametricValue('lights', parseFloat(e.target.value))}
            />
          </div>
          <div onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handleContextMenu(e); }}>
            <Slider
              label="Darks"
              min={-100}
              max={100}
              step={1}
              defaultValue={0}
              value={parametricCurve.darks}
              onChange={(e: any) => updateParametricValue('darks', parseFloat(e.target.value))}
            />
          </div>
          <div onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handleContextMenu(e); }}>
            <Slider
              label="Shadows"
              min={-100}
              max={100}
              step={1}
              defaultValue={0}
              value={parametricCurve.shadows}
              onChange={(e: any) => updateParametricValue('shadows', parseFloat(e.target.value))}
            />
          </div>
        </div>
      )}
    </div>
  );
}
