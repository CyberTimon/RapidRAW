import { useBloc } from '@blac/react';
import { Star, Copy, ClipboardPaste, RotateCcw, ChevronUp, ChevronDown, Save, Settings } from 'lucide-react';
import { SelectionBloc } from '../../blocs/library/SelectionBloc';
import { AdjustmentsBloc } from '../../blocs/editor/AdjustmentsBloc';
import { ClipboardService } from '../../blocs/services/ClipboardService';
import { UIBloc } from '../../blocs/app/UIBloc';
import { AppBloc } from '../../blocs/app/AppBloc';
import { ZoomBloc } from '../../blocs/editor/ZoomBloc';

interface StarRatingProps {
  rating: number;
  onRate: (rating: number) => void;
  disabled?: boolean;
}

function StarRating({ rating, onRate, disabled = false }: StarRatingProps) {
  return (
    <div className={`flex items-center gap-1 ${disabled ? 'cursor-not-allowed' : ''}`}>
      {[1, 2, 3, 4, 5].map((starValue) => (
        <button
          key={starValue}
          className="disabled:cursor-not-allowed"
          disabled={disabled}
          onClick={() => !disabled && onRate(starValue === rating ? 0 : starValue)}
          title={disabled ? 'Select an image to rate' : `Rate ${starValue} star${starValue > 1 ? 's' : ''}`}
        >
          <Star
            size={18}
            className={`
              ${disabled
                ? 'text-text-secondary opacity-40'
                : starValue <= rating
                  ? 'fill-accent text-accent'
                  : 'text-text-secondary hover:text-accent'
              }
            `}
          />
        </button>
      ))}
    </div>
  );
}

export function BottomBar() {
  const [appState] = useBloc(AppBloc);
  const [selectionState] = useBloc(SelectionBloc);
  const [adjustmentsState, adjustmentsBloc] = useBloc(AdjustmentsBloc);
  const [clipboardState, clipboardService] = useBloc(ClipboardService);
  const [uiState, uiBloc] = useBloc(UIBloc);
  const [zoomState, zoomBloc] = useBloc(ZoomBloc);

  const isLibraryView = appState.activeView === 'explore';
  const isEditView = appState.activeView === 'edit';
  const hasSelection = selectionState.activePath !== null;
  const multiSelectCount = selectionState.selectedPaths.length;
  const showSelectionCounter = multiSelectCount > 1;

  const handleRate = (rating: number) => {
    adjustmentsBloc.setRating(rating);
  };

  const handleCopy = () => {
    if (selectionState.activePath) {
      clipboardService.copyAdjustments(adjustmentsState.adjustments, selectionState.activePath);
    }
  };

  const handlePaste = () => {
    const copied = clipboardState.copiedAdjustments;
    if (copied) {
      const pasted = clipboardService.pasteAdjustments(adjustmentsState.adjustments);
      if (pasted) {
        adjustmentsBloc.loadAdjustments(pasted);
      }
    }
  };

  const handleReset = () => {
    adjustmentsBloc.resetAll();
  };

  const handleExport = () => {
    // TODO: Open export modal
  };

  const handleToggleFilmstrip = () => {
    uiBloc.toggleBottomPanel();
  };

  const handleZoomChange = (value: number) => {
    zoomBloc.setScale(value);
  };

  const handleResetZoom = () => {
    zoomBloc.zoomToFit();
  };

  return (
    <div className="flex-shrink-0 h-10 bg-bg-secondary flex items-center justify-between px-3">
      {/* Left section: Rating + Copy/Paste */}
      <div className="flex items-center gap-4">
        <StarRating
          rating={adjustmentsState.adjustments.rating}
          onRate={handleRate}
          disabled={!hasSelection}
        />

        <div className="h-5 w-px bg-surface" />

        <div className="flex items-center gap-2">
          <button
            className={`
              w-8 h-8 flex items-center justify-center rounded-md
              text-text-secondary hover:bg-surface hover:text-text-primary
              disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed
            `}
            disabled={!hasSelection}
            onClick={handleCopy}
            title="Copy Settings"
          >
            <Copy size={18} />
          </button>

          <button
            className={`
              w-8 h-8 flex items-center justify-center rounded-md
              text-text-secondary hover:bg-surface hover:text-text-primary
              disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed
            `}
            disabled={!clipboardState.copiedAdjustments || !hasSelection}
            onClick={handlePaste}
            title="Paste Settings"
          >
            <ClipboardPaste size={18} />
          </button>

          <button
            className="w-8 h-8 flex items-center justify-center rounded-md text-text-secondary hover:bg-surface hover:text-text-primary"
            title="Copy & Paste Settings"
          >
            <Settings size={18} />
          </button>
        </div>

        {/* Selection counter */}
        {showSelectionCounter && (
          <>
            <div className="h-5 w-px bg-surface" />
            <span className="text-sm text-text-secondary whitespace-nowrap">
              {multiSelectCount} images selected
            </span>
          </>
        )}
      </div>

      {/* Spacer */}
      <div className="flex-grow" />

      {/* Right section: View-specific controls */}
      {isLibraryView ? (
        <div className="flex items-center gap-2">
          <button
            className={`
              w-8 h-8 flex items-center justify-center rounded-md
              text-text-secondary hover:bg-surface hover:text-text-primary
              disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed
            `}
            disabled={!hasSelection}
            onClick={handleReset}
            title="Reset All Adjustments"
          >
            <RotateCcw size={18} />
          </button>

          <button
            className={`
              w-8 h-8 flex items-center justify-center rounded-md
              text-text-secondary hover:bg-surface hover:text-text-primary
              disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed
            `}
            disabled={!hasSelection}
            onClick={handleExport}
            title="Export Selected Images"
          >
            <Save size={18} />
          </button>
        </div>
      ) : isEditView ? (
        <div className="flex items-center gap-4">
          {/* Zoom controls */}
          <div className="flex items-center gap-2 w-56">
            <button
              className="text-xs text-text-secondary hover:text-text-primary"
              onClick={handleResetZoom}
              title="Reset Zoom to Fit Window"
            >
              Zoom
            </button>

            <input
              type="range"
              min={0.1}
              max={2.0}
              step={0.05}
              value={zoomState.scale}
              onChange={(e) => handleZoomChange(parseFloat(e.target.value))}
              onDoubleClick={handleResetZoom}
              className="flex-1 h-1 bg-surface rounded-lg appearance-none cursor-pointer slider-input"
            />

            <span className="text-xs text-text-secondary w-8 text-right">
              {Math.round(zoomState.scale * 100)}%
            </span>
          </div>

          <div className="h-5 w-px bg-surface" />

          {/* Filmstrip toggle */}
          <button
            className="p-1.5 rounded-md text-text-secondary hover:bg-surface hover:text-text-primary"
            onClick={handleToggleFilmstrip}
            title={uiState.bottomPanel.visible ? 'Collapse Filmstrip' : 'Expand Filmstrip'}
          >
            {uiState.bottomPanel.visible ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
          </button>
        </div>
      ) : null}
    </div>
  );
}
