import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useBloc } from '@blac/react';
import { FullscreenBloc } from '../../blocs/editor/FullscreenBloc';
import { PreviewBloc } from '../../blocs/editor/PreviewBloc';
import { EditorBloc } from '../../blocs/editor/EditorBloc';
import { SelectionBloc } from '../../blocs/library/SelectionBloc';
import { LibraryBloc } from '../../blocs/library/LibraryBloc';

export function FullscreenViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [fullscreenState, fullscreenBloc] = useBloc(FullscreenBloc);
  const [previewState] = useBloc(PreviewBloc);
  const [editorState] = useBloc(EditorBloc);
  const [selectionState, selectionBloc] = useBloc(SelectionBloc);
  const [libraryState] = useBloc(LibraryBloc);

  const { isFullscreen, showUI, cursorHidden } = fullscreenState;

  useEffect(() => {
    const handleFullscreenChange = () => {
      fullscreenBloc.syncWithBrowserState();
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, [fullscreenBloc]);

  const handleMouseMove = useCallback(() => {
    fullscreenBloc.onMouseMove();
  }, [fullscreenBloc]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isFullscreen) return;

      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          fullscreenBloc.exitFullscreen();
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault();
          navigateImage(-1);
          break;
        case 'ArrowRight':
        case 'ArrowDown':
          e.preventDefault();
          navigateImage(1);
          break;
        case ' ':
          e.preventDefault();
          fullscreenBloc.toggleUI();
          break;
      }
    },
    [isFullscreen, fullscreenBloc]
  );

  const navigateImage = (direction: number) => {
    const images = libraryState.images;
    if (images.length === 0) return;

    const currentPath = editorState.selectedImage?.path || selectionState.activePath;
    if (!currentPath) return;

    const currentIndex = images.findIndex((img) => img.path === currentPath);
    if (currentIndex === -1) return;

    let newIndex = currentIndex + direction;
    if (newIndex < 0) newIndex = images.length - 1;
    if (newIndex >= images.length) newIndex = 0;

    selectionBloc.selectSingle(images[newIndex].path);
  };

  useEffect(() => {
    if (isFullscreen) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isFullscreen, handleKeyDown]);

  if (!isFullscreen) return null;

  const previewUrl = previewState.previewUrl;
  const imagePath = editorState.selectedImage?.path;

  return createPortal(
    <div
      ref={containerRef}
      className={`
        fixed inset-0 z-[100] bg-black
        flex items-center justify-center
        ${cursorHidden ? 'cursor-none' : ''}
      `}
      onMouseMove={handleMouseMove}
    >
      {previewUrl ? (
        <img
          src={previewUrl}
          alt={imagePath || 'Preview'}
          className="max-w-full max-h-full object-contain select-none"
          draggable={false}
        />
      ) : (
        <div className="flex items-center justify-center text-white/50">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-white/50 border-t-transparent" />
        </div>
      )}

      {showUI && (
        <>
          <div className="absolute top-0 left-0 right-0 h-16 bg-gradient-to-b from-black/50 to-transparent pointer-events-none" />

          <div className="absolute top-4 right-4 flex items-center gap-2">
            <button
              onClick={() => fullscreenBloc.exitFullscreen()}
              className="p-2 rounded-full bg-black/50 hover:bg-black/70 text-white/80 hover:text-white"
              title="Exit Fullscreen (Esc)"
            >
              <svg
                width={20}
                height={20}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
              </svg>
            </button>
          </div>

          <button
            onClick={() => navigateImage(-1)}
            className="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/50 hover:bg-black/70 text-white/80 hover:text-white"
            title="Previous Image"
          >
            <svg
              width={24}
              height={24}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>

          <button
            onClick={() => navigateImage(1)}
            className="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/50 hover:bg-black/70 text-white/80 hover:text-white"
            title="Next Image"
          >
            <svg
              width={24}
              height={24}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>

          <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-black/50 to-transparent pointer-events-none" />

          {imagePath && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full bg-black/50 text-white/80 text-sm">
              {imagePath.split('/').pop()}
            </div>
          )}

          <div className="absolute bottom-4 left-4 text-white/50 text-xs">
            <span>Press Space to hide controls</span>
          </div>
        </>
      )}
    </div>,
    document.body
  );
}
