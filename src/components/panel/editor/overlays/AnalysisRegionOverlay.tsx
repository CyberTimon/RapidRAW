import type { CSSProperties, PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorStore } from '../../../../store/useEditorStore';
import { DEFAULT_ANALYSIS_REGION } from '../../../../utils/adjustments';
import { useNegativeAnalysisStore } from '../../../../store/useNegativeAnalysisStore';

type Point = { x: number; y: number };
interface Props {
  width: number;
  height: number;
  zoom: number;
  imageUrl: string;
  imageStyle: CSSProperties;
  project(point: Point): Point;
  unproject(x: number, y: number): Point;
}

export default function AnalysisRegionOverlay({
  width,
  height,
  zoom,
  imageUrl,
  imageStyle,
  project,
  unproject,
}: Props) {
  const { t } = useTranslation();
  const state = useNegativeAnalysisStore();
  const appliedRegion = useEditorStore((s) => s.adjustments.negativeAnalysisRegion ?? DEFAULT_ANALYSIS_REGION);
  const region = state.draft ?? appliedRegion;
  const corners = [
    { x: region.x, y: region.y },
    { x: region.x + region.width, y: region.y },
    { x: region.x + region.width, y: region.y + region.height },
    { x: region.x, y: region.y + region.height },
  ];
  const screen = corners.map((corner) => project(corner));
  const handles = ['nw', 'ne', 'se', 'sw'] as const;
  const point = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return unproject(
      ((event.clientX - bounds.left) * width) / bounds.width,
      ((event.clientY - bounds.top) * height) / bounds.height,
    );
  };
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div style={{ width, height, position: 'relative' }}>
        <img src={imageUrl} alt="" draggable={false} style={{ width, height, display: 'block', ...imageStyle }} />
        <svg
          width={width}
          height={height}
          aria-label={t('adjustments.details.analysisRegion')}
          data-analysis-region
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Escape' || event.key === 'Enter') {
              state.finishEditing(event.key === 'Enter');
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            const handle = (event.target as SVGElement).dataset.handle as (typeof handles)[number] | 'move' | undefined;
            if (!handle || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            const step = event.shiftKey ? 0.02 : 0.005;
            const start = { x: 0.5, y: 0.5 };
            state.begin(start, handle);
            state.move({
              x: start.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
              y: start.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0),
            });
            state.commit();
          }}
          style={{ position: 'absolute', inset: 0, overflow: 'visible', touchAction: 'none', cursor: 'crosshair' }}
          onPointerDown={(event) => {
            const handle = (event.target as SVGElement).dataset.handle as (typeof handles)[number] | 'move' | undefined;
            if (event.button !== 0) return;
            const start = point(event);
            if (
              !handle &&
              (!Number.isFinite(start.x) ||
                !Number.isFinite(start.y) ||
                start.x < 0 ||
                start.x > 1 ||
                start.y < 0 ||
                start.y > 1)
            )
              return;
            event.stopPropagation();
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            state.begin(start, handle ?? 'draw');
          }}
          onPointerMove={(event) => {
            if (!useNegativeAnalysisStore.getState().gesture) return;
            event.stopPropagation();
            state.move(point(event));
          }}
          onPointerUp={(event) => {
            if (!useNegativeAnalysisStore.getState().gesture) return;
            event.stopPropagation();
            state.move(point(event));
            state.commit();
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={state.cancel}
          onLostPointerCapture={state.cancel}
        >
          <polygon
            points={screen.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="rgba(14,165,233,0.08)"
            stroke="white"
            strokeWidth={2 / zoom}
            data-handle="move"
            tabIndex={0}
            role="button"
            aria-label={t('adjustments.details.moveAnalysisRegion')}
            style={{ cursor: 'move' }}
          />
          {screen.map((p, i) => (
            <circle
              key={handles[i]}
              cx={p.x}
              cy={p.y}
              r={6 / zoom}
              fill="white"
              stroke="#0ea5e9"
              strokeWidth={2 / zoom}
              data-handle={handles[i]}
              tabIndex={0}
              role="button"
              aria-label={`${t('adjustments.details.resizeAnalysisRegion')} ${i + 1}`}
              style={{ cursor: 'crosshair' }}
            />
          ))}
        </svg>
      </div>
    </div>
  );
}
