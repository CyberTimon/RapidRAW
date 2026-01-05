import { useMemo } from 'react';
import { useBloc } from '@blac/react';
import { PreviewBloc } from '../../blocs/editor/PreviewBloc.js';

interface HistogramChannelProps {
  data: number[];
  color: string;
  opacity?: number;
}

function HistogramChannelView({ data, color, opacity = 0.6 }: HistogramChannelProps) {
  const path = useMemo(() => {
    if (data.length === 0) return '';

    const max = Math.max(...data);
    if (max === 0) return '';

    const width = 256;
    const height = 100;

    const points = data.map((value, index) => {
      const x = (index / (data.length - 1)) * width;
      const y = height - (value / max) * height;
      return `${x},${y}`;
    });

    return `M0,${height} L${points.join(' L')} L${width},${height} Z`;
  }, [data]);

  if (!path) return null;

  return (
    <path d={path} fill={color} fillOpacity={opacity} />
  );
}

type DisplayMode = 'rgb' | 'luminance' | 'all';

export function ImageHistogram() {
  const [preview, previewBloc] = useBloc(PreviewBloc);
  const { histogramData, isHistogramLoading } = preview;

  // TODO: Make this configurable via state
  const displayMode = 'rgb' as DisplayMode;

  if (isHistogramLoading) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-bg-secondary p-4">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  if (!histogramData) {
    return (
      <div className="h-full w-full flex flex-col bg-bg-secondary p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-text-secondary uppercase tracking-wide">
            Histogram
          </span>
          <button
            className="text-xs text-accent hover:underline"
            onClick={() => previewBloc.requestHistogram()}
          >
            Load
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center bg-surface rounded">
          <span className="text-xs text-text-secondary">No data</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full flex flex-col bg-bg-secondary p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-text-secondary uppercase tracking-wide">
          Histogram
        </span>
        <button
          className="p-1 rounded hover:bg-surface transition-colors"
          onClick={() => previewBloc.requestHistogram()}
          title="Refresh"
        >
          <svg className="w-3 h-3 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>

      <div className="flex-1 relative bg-surface rounded overflow-hidden">
        <svg
          viewBox="0 0 256 100"
          preserveAspectRatio="none"
          className="absolute inset-0 w-full h-full"
        >
          {displayMode === 'luminance' && (
            <HistogramChannelView
              data={histogramData.luminance.data}
              color="#ffffff"
              opacity={0.8}
            />
          )}

          {(displayMode === 'rgb' || displayMode === 'all') && (
            <>
              <HistogramChannelView
                data={histogramData.red.data}
                color="#ef4444"
                opacity={0.5}
              />
              <HistogramChannelView
                data={histogramData.green.data}
                color="#22c55e"
                opacity={0.5}
              />
              <HistogramChannelView
                data={histogramData.blue.data}
                color="#3b82f6"
                opacity={0.5}
              />
            </>
          )}

          {displayMode === 'all' && (
            <HistogramChannelView
              data={histogramData.luminance.data}
              color="#ffffff"
              opacity={0.3}
            />
          )}
        </svg>

        <div className="absolute bottom-0 left-0 right-0 h-4 flex justify-between px-1 text-[8px] text-text-secondary">
          <span>0</span>
          <span>255</span>
        </div>
      </div>

      <div className="flex items-center justify-center gap-3 mt-2">
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-full bg-red-500" />
          <span className="text-[10px] text-text-secondary">R</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-full bg-green-500" />
          <span className="text-[10px] text-text-secondary">G</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-full bg-blue-500" />
          <span className="text-[10px] text-text-secondary">B</span>
        </div>
      </div>
    </div>
  );
}
