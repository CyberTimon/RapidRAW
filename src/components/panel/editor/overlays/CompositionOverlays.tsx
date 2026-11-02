import React from 'react';
import type { OverlayMode } from '../../right/CropPanel';

interface CompositionOverlaysProps {
  width: number;
  height: number;
  mode: OverlayMode;
  rotation: number;
  color?: string;
  opacity?: number;
  denseVisible?: boolean;
}

export default function CompositionOverlays({
  width,
  height,
  mode,
  rotation,
  color = 'rgba(255, 255, 255, 0.7)',
  opacity = 0.7,
  denseVisible = false,
}: CompositionOverlaysProps) {
  if (width <= 0 || height <= 0) return null;

  const strokeProps = {
    stroke: color,
    strokeWidth: '1.5',
    fill: 'none',
    vectorEffect: 'non-scaling-stroke',
  };

  const renderThirds = () => (
    <g
      style={{
        opacity: mode === 'thirds' ? opacity : 0,
        transition: 'opacity 300ms ease-in-out',
      }}
    >
      <line x1={width * 0.333} y1={0} x2={width * 0.333} y2={height} {...strokeProps} />
      <line x1={width * 0.666} y1={0} x2={width * 0.666} y2={height} {...strokeProps} />
      <line x1={0} y1={height * 0.333} x2={width} y2={height * 0.333} {...strokeProps} />
      <line x1={0} y1={height * 0.666} x2={width} y2={height * 0.666} {...strokeProps} />
    </g>
  );

  const renderDenseGrid = () => (
    <g
      style={{
        opacity: denseVisible ? opacity : 0,
        transition: 'opacity 300ms ease-in-out',
      }}
    >
      {[...Array(17)].map((_, i) => (
        <line
          key={`v-${i}`}
          x1={`${(i + 1) * 5.555}%`}
          y1={0}
          x2={`${(i + 1) * 5.555}%`}
          y2={height}
          {...strokeProps}
          strokeWidth="1"
        />
      ))}
      {[...Array(17)].map((_, i) => (
        <line
          key={`h-${i}`}
          x1={0}
          y1={`${(i + 1) * 5.555}%`}
          x2={width}
          y2={`${(i + 1) * 5.555}%`}
          {...strokeProps}
          strokeWidth="1"
        />
      ))}
    </g>
  );

  const renderDiagonal = () => (
    <g style={{ opacity: mode === 'diagonal' ? opacity : 0, transition: 'opacity 300ms ease-in-out' }}>
      <line x1={0} y1={0} x2={width * 0.666} y2={height} {...strokeProps} />
      <line x1={width * 0.333} y1={0} x2={width} y2={height} {...strokeProps} />
      <line x1={width} y1={0} x2={width * 0.333} y2={height} {...strokeProps} />
      <line x1={width * 0.666} y1={0} x2={0} y2={height} {...strokeProps} />
    </g>
  );

  const renderCenter = () => (
    <g style={{ opacity: mode === 'center' ? opacity : 0, transition: 'opacity 300ms ease-in-out' }}>
      <line x1={width / 2} y1={0} x2={width / 2} y2={height} {...strokeProps} />
      <line x1={0} y1={height / 2} x2={width} y2={height / 2} {...strokeProps} />
    </g>
  );

  const renderPhiGrid = () => {
    const p1 = 0.382;
    const p2 = 0.618;
    return (
      <g style={{ opacity: mode === 'phiGrid' ? opacity : 0, transition: 'opacity 300ms ease-in-out' }}>
        <line x1={width * p1} y1={0} x2={width * p1} y2={height} {...strokeProps} />
        <line x1={width * p2} y1={0} x2={width * p2} y2={height} {...strokeProps} />
        <line x1={0} y1={height * p1} x2={width} y2={height * p1} {...strokeProps} />
        <line x1={0} y1={height * p2} x2={width} y2={height * p2} {...strokeProps} />
      </g>
    );
  };

  const renderGoldenTriangle = () => {
    const r = rotation % 4;

    let mainStart = { x: 0, y: height };
    let mainEnd = { x: width, y: 0 };
    let recipStart = { x: 0, y: 0 };

    if (r === 1) {
      mainStart = { x: 0, y: 0 };
      mainEnd = { x: width, y: height };
      recipStart = { x: width, y: 0 };
    } else if (r === 2) {
      mainStart = { x: width, y: 0 };
      mainEnd = { x: 0, y: height };
      recipStart = { x: width, y: height };
    } else if (r === 3) {
      mainStart = { x: width, y: height };
      mainEnd = { x: 0, y: 0 };
      recipStart = { x: 0, y: height };
    }

    const dx = mainEnd.x - mainStart.x;
    const dy = mainEnd.y - mainStart.y;
    if (Math.abs(dx) < 0.01) return null;

    const m1 = dy / dx;
    const m2 = -1 / m1;

    const x_int = (m1 * mainStart.x - mainStart.y - m2 * recipStart.x + recipStart.y) / (m1 - m2);
    const y_int = m1 * (x_int - mainStart.x) + mainStart.y;

    const recipStart2 = { x: Math.abs(width - recipStart.x), y: Math.abs(height - recipStart.y) };
    const x_int2 = (m1 * mainStart.x - mainStart.y - m2 * recipStart2.x + recipStart2.y) / (m1 - m2);
    const y_int2 = m1 * (x_int2 - mainStart.x) + mainStart.y;

    return (
      <g style={{ opacity: mode === 'goldenTriangle' ? opacity : 0, transition: 'opacity 300ms ease-in-out' }}>
        <line x1={mainStart.x} y1={mainStart.y} x2={mainEnd.x} y2={mainEnd.y} {...strokeProps} />
        <line x1={recipStart.x} y1={recipStart.y} x2={x_int} y2={y_int} {...strokeProps} />
        <line x1={recipStart2.x} y1={recipStart2.y} x2={x_int2} y2={y_int2} {...strokeProps} />
      </g>
    );
  };

  const renderArmature = () => {
    const m = height / width;
    const x = (m * m * width) / (m * m + 1);
    const y = m * x;

    const leftX = width - x;
    const rightX = x;
    const topY = y;
    const bottomY = height - y;
    const dashedStrokeProps = { ...strokeProps, strokeDasharray: '5 5' };

    return (
      <g style={{ opacity: mode === 'armature' ? opacity : 0, transition: 'opacity 300ms ease-in-out' }}>
        <line x1={0} y1={0} x2={width} y2={height} {...strokeProps} />
        <line x1={width} y1={0} x2={0} y2={height} {...strokeProps} />
        <line x1={width} y1={0} x2={0} y2={height / (m * m)} {...strokeProps} />
        <line x1={0} y1={0} x2={width} y2={height / (m * m)} {...strokeProps} />
        <line x1={0} y1={height} x2={width} y2={height - height / (m * m)} {...strokeProps} />
        <line x1={width} y1={height} x2={0} y2={height - height / (m * m)} {...strokeProps} />
        <line x1={leftX} y1={0} x2={leftX} y2={height} {...dashedStrokeProps} />
        <line x1={rightX} y1={0} x2={rightX} y2={height} {...dashedStrokeProps} />
        <line x1={0} y1={topY} x2={width} y2={topY} {...dashedStrokeProps} />
        <line x1={0} y1={bottomY} x2={width} y2={bottomY} {...dashedStrokeProps} />
      </g>
    );
  };

  const renderGoldenSpiral = () => {
    const r = rotation % 4;
    const PHI = (1 + Math.sqrt(5)) / 2;
    const baseW = 1000;
    const baseH = baseW / PHI;
    const pathData = 'M 0 618.03 A 618.03 618.03 0 0 1 618.03 0 A 381.97 381.97 0 0 1 1000 381.97 A 236.06 236.06 0 0 1 763.94 618.03 A 145.91 145.91 0 0 1 618.03 472.12 A 90.15 90.15 0 0 1 708.18 381.97 A 55.76 55.76 0 0 1 763.94 437.73 A 34.39 34.39 0 0 1 729.55 472.12 A 21.37 21.37 0 0 1 708.18 450.75 A 13.12 13.12 0 0 1 721.30 437.77 A 8.11 8.11 0 0 1 729.41 445.88 A 5.01 5.01 0 0 1 724.40 450.89';
    const transform = `translate(${width / 2} ${height / 2}) rotate(${r * 90}) scale(${r % 2 === 0 ? width / baseW : height / baseW}, ${r % 2 === 0 ? height / baseH : width / baseH}) translate(${-baseW / 2} ${-baseH / 2})`;

    return (
      <g style={{ opacity: mode === 'goldenSpiral' ? opacity : 0, transition: 'opacity 300ms ease-in-out' }}>
        <path d={pathData} {...strokeProps} strokeLinecap="round" strokeLinejoin="round" transform={transform} />
      </g>
    );
  };

  return (
    <svg
      width={width}
      height={height}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        pointerEvents: 'none',
        zIndex: 50,
      }}
    >
      {renderThirds()}
      {renderDenseGrid()}
      {renderPhiGrid()}
      {renderGoldenTriangle()}
      {renderGoldenSpiral()}
      {renderArmature()}
      {renderDiagonal()}
      {renderCenter()}
    </svg>
  );
}