import { useBloc } from '@blac/react';
import { Button } from '../../primitives/Button.js';
import { AppBloc } from '../../blocs/app/AppBloc.js';
import { EditorBloc } from '../../blocs/editor/EditorBloc.js';
import { HistoryBloc } from '../../blocs/editor/HistoryBloc.js';
import { AdjustmentsBloc } from '../../blocs/editor/AdjustmentsBloc.js';
import { FullscreenBloc } from '../../blocs/editor/FullscreenBloc.js';

export function EditorToolbar() {
  const [, appBloc] = useBloc(AppBloc);
  const [editor, editorBloc] = useBloc(EditorBloc);
  const [, historyBloc] = useBloc(HistoryBloc);
  const [adjustments, adjustmentsBloc] = useBloc(AdjustmentsBloc);
  const [fullscreen, fullscreenBloc] = useBloc(FullscreenBloc);

  const handleUndo = () => {
    const prev = historyBloc.undo();
    if (prev) {
      adjustmentsBloc.loadAdjustments(prev);
    }
  };

  const handleRedo = () => {
    const next = historyBloc.redo();
    if (next) {
      adjustmentsBloc.loadAdjustments(next);
    }
  };

  const handleReset = () => {
    adjustmentsBloc.resetAll();
    historyBloc.push('Reset All', adjustmentsBloc.current);
  };

  const imageName = editor.selectedImage?.path.split(/[\\/]/).pop() || 'No image';

  return (
    <div className="h-full flex items-center justify-between px-4 bg-bg-secondary border-b border-border-color">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => appBloc.navigateToLibrary()}
          title="Back to Library"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </Button>

        <div className="w-px h-6 bg-border-color mx-1" />

        <Button
          variant="ghost"
          size="icon"
          onClick={handleUndo}
          disabled={!historyBloc.canUndo}
          title={historyBloc.undoLabel ? `Undo: ${historyBloc.undoLabel}` : 'Undo'}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
          </svg>
        </Button>

        <Button
          variant="ghost"
          size="icon"
          onClick={handleRedo}
          disabled={!historyBloc.canRedo}
          title={historyBloc.redoLabel ? `Redo: ${historyBloc.redoLabel}` : 'Redo'}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 10h-10a8 8 0 00-8 8v2M21 10l-6 6m6-6l-6-6" />
          </svg>
        </Button>

        <div className="w-px h-6 bg-border-color mx-1" />

        <Button
          variant="ghost"
          size="icon"
          onClick={handleReset}
          disabled={!adjustments.isDirty}
          title="Reset All Adjustments"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </Button>
      </div>

      <div className="flex-1 min-w-0 px-4">
        <h2 className="text-sm font-medium text-text-primary truncate text-center">
          {imageName}
        </h2>
        {editor.selectedImage?.isRaw && (
          <p className="text-xs text-accent text-center">RAW</p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant={editor.showOriginal ? 'primary' : 'ghost'}
          size="sm"
          onMouseDown={() => editorBloc.setShowOriginal(true)}
          onMouseUp={() => editorBloc.setShowOriginal(false)}
          onMouseLeave={() => editorBloc.setShowOriginal(false)}
          title="Hold to show original"
        >
          <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
          </svg>
          Before
        </Button>

        <div className="w-px h-6 bg-border-color mx-1" />

        <Button
          variant="ghost"
          size="icon"
          onClick={() => fullscreenBloc.toggleFullscreen()}
          title={fullscreen.isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
        >
          {fullscreen.isFullscreen ? (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9L4 4m0 0v5m0-5h5m6 0l5-5m0 0v5m0-5h-5m-6 11l-5 5m0 0v-5m0 5h5m6-5l5 5m0 0v-5m0 5h-5" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
          )}
        </Button>

        <Button variant="primary" size="sm">
          <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
          Export
        </Button>
      </div>
    </div>
  );
}
