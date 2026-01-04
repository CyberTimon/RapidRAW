import { useBloc } from '@blac/react';
import { Button } from '../../primitives/Button.js';
import { ZoomBloc } from '../../blocs/editor/ZoomBloc.js';

export function ZoomControls() {
  const [zoom, zoomBloc] = useBloc(ZoomBloc);

  return (
    <div className="h-full flex items-center justify-center gap-2 px-4 bg-bg-secondary border-t border-border-color">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => zoomBloc.zoomOut()}
        disabled={!zoomBloc.canZoomOut}
        title="Zoom Out"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM13 10H7" />
        </svg>
      </Button>

      <div className="relative w-32 h-1.5 bg-surface rounded-full">
        <input
          type="range"
          min={zoom.minScale * 100}
          max={zoom.maxScale * 100}
          value={zoom.scale * 100}
          onChange={(e) => zoomBloc.setScale(Number(e.target.value) / 100)}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        />
        <div
          className="absolute top-0 left-0 h-full bg-accent rounded-full pointer-events-none"
          style={{
            width: `${((zoom.scale - zoom.minScale) / (zoom.maxScale - zoom.minScale)) * 100}%`,
          }}
        />
        <div
          className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-accent rounded-full shadow pointer-events-none"
          style={{
            left: `calc(${((zoom.scale - zoom.minScale) / (zoom.maxScale - zoom.minScale)) * 100}% - 6px)`,
          }}
        />
      </div>

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => zoomBloc.zoomIn()}
        disabled={!zoomBloc.canZoomIn}
        title="Zoom In"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v6m3-3H7" />
        </svg>
      </Button>

      <div className="w-px h-4 bg-border-color mx-1" />

      <button
        className={`
          px-2 py-1 text-xs rounded transition-colors min-w-[60px]
          ${zoomBloc.isFitMode
            ? 'bg-accent/20 text-accent'
            : 'text-text-secondary hover:text-text-primary hover:bg-surface'
          }
        `}
        onClick={() => zoomBloc.zoomToFit()}
        title="Fit to Screen"
      >
        Fit
      </button>

      <button
        className={`
          px-2 py-1 text-xs rounded transition-colors min-w-[60px]
          ${zoomBloc.isActualSize
            ? 'bg-accent/20 text-accent'
            : 'text-text-secondary hover:text-text-primary hover:bg-surface'
          }
        `}
        onClick={() => zoomBloc.zoomToActual()}
        title="Actual Size (100%)"
      >
        100%
      </button>

      <div className="w-px h-4 bg-border-color mx-1" />

      <span className="text-xs text-text-secondary min-w-[50px] text-center">
        {zoomBloc.zoomPercentage}%
      </span>
    </div>
  );
}
