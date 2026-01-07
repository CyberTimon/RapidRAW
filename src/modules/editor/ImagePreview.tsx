import { useCallback, useEffect, useRef, useState } from 'react';
import { useBloc } from '@blac/react';
import { EditorBloc } from '../../blocs/editor/EditorBloc.js';
import { PreviewBloc } from '../../blocs/editor/PreviewBloc.js';
import { ZoomBloc } from '../../blocs/editor/ZoomBloc.js';

export function ImagePreview() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [editor, editorBloc] = useBloc(EditorBloc);
  const [preview] = useBloc(PreviewBloc);
  const [zoom, zoomBloc] = useBloc(ZoomBloc);

  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (editorBloc.needsSync) {
      editorBloc.loadFromSelection();
    }
  }, [editorBloc, editorBloc.needsSync]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !editor.selectedImage) return;

    const { width, height } = editor.selectedImage;
    if (width === 0 || height === 0) return;

    const rect = container.getBoundingClientRect();
    zoomBloc.setFitScale(rect.width, rect.height, width, height);
    zoomBloc.zoomToFit();
  }, [editor.selectedImage, zoomBloc]);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const centerX = e.clientX - rect.left - rect.width / 2;
      const centerY = e.clientY - rect.top - rect.height / 2;
      zoomBloc.wheelZoom(e.deltaY, centerX, centerY);
    },
    [zoomBloc]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      setIsDragging(true);
      setDragStart({ x: e.clientX - zoom.positionX, y: e.clientY - zoom.positionY });
    },
    [zoom.positionX, zoom.positionY]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging) return;
      zoomBloc.setPosition(e.clientX - dragStart.x, e.clientY - dragStart.y);
    },
    [isDragging, dragStart, zoomBloc]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleDoubleClick = useCallback(() => {
    if (zoomBloc.isActualSize) {
      zoomBloc.zoomToFit();
    } else {
      zoomBloc.zoomToActual();
    }
  }, [zoomBloc]);

  if (!editor.selectedImage) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-bg-primary">
        <div className="flex flex-col items-center gap-4 text-center p-8">
          <svg
            className="w-16 h-16 text-text-secondary"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
          <p className="text-text-secondary">Select an image to edit</p>
        </div>
      </div>
    );
  }

  if (editor.isLoading) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-bg-primary">
        <div className="flex flex-col items-center gap-3">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-accent border-t-transparent" />
          <p className="text-sm text-text-secondary">Loading image...</p>
        </div>
      </div>
    );
  }

  if (editor.error) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-bg-primary">
        <div className="flex flex-col items-center gap-4 text-center p-8 max-w-md">
          <svg
            className="w-12 h-12 text-red-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <p className="text-sm text-text-secondary">{editor.error}</p>
        </div>
      </div>
    );
  }

  const imageUrl = editor.showOriginal
    ? preview.originalUrl || preview.previewUrl
    : preview.previewUrl;

  return (
    <div
      ref={containerRef}
      className={`
        h-full w-full overflow-hidden bg-bg-primary relative
        ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}
      `}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onDoubleClick={handleDoubleClick}
    >
      <div
        className="absolute top-1/2 left-1/2 origin-center"
        style={{
          transform: `translate(-50%, -50%) translate(${zoom.positionX}px, ${zoom.positionY}px) scale(${zoom.scale})`,
          transition: isDragging ? 'none' : 'transform 0.1s ease-out',
        }}
      >
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={editor.selectedImage.path}
            className="max-w-none select-none"
            style={{
              width: editor.selectedImage.width,
              height: editor.selectedImage.height,
            }}
            draggable={false}
          />
        ) : (
          <div
            className="bg-surface flex items-center justify-center"
            style={{
              width: editor.selectedImage.width || 800,
              height: editor.selectedImage.height || 600,
            }}
          >
            {preview.isGenerating ? (
              <div className="animate-spin rounded-full h-8 w-8 border-2 border-accent border-t-transparent" />
            ) : (
              <span className="text-text-secondary">Generating preview...</span>
            )}
          </div>
        )}
      </div>

      {editor.showOriginal && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-black/70 text-white text-sm rounded-full">
          Showing Original
        </div>
      )}

      {zoom.isLoadingFullRes && (
        <div className="absolute top-4 right-4 flex items-center gap-2 px-3 py-1.5 bg-black/70 text-white text-sm rounded-full">
          <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
          Loading full resolution...
        </div>
      )}
    </div>
  );
}
