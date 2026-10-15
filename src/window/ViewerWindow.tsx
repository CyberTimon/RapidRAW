import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AppSettings, Invokes } from '../components/ui/AppProperties';
import { calculateTargetResolution } from '../utils/previewResolution';
import { wheelZoomFactor } from '../utils/wheelZoom';

interface Size {
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

interface ViewerImage extends Size {
  path: string;
}

interface ViewerInfo {
  native: boolean;
  background: [number, number, number, number];
  image: ViewerImage | null;
}

interface ViewerView {
  zoom: number;
  center: [number, number];
}

const FIT_VIEW: ViewerView = { zoom: 1, center: [0.5, 0.5] };

const toCssColor = ([r, g, b]: ViewerInfo['background']) =>
  `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;

const toggleFullscreen = async () => {
  const appWindow = getCurrentWindow();
  await appWindow.setFullscreen(!(await appWindow.isFullscreen()));
};

const windowSize = (): Size => ({ width: window.innerWidth, height: window.innerHeight });

const fitScale = (win: Size, image: Size) => Math.min(win.width / image.width, win.height / image.height);

const viewRect = (view: ViewerView, win: Size, image: Size) => {
  const scale = fitScale(win, image) * view.zoom;
  const width = image.width * scale;
  const height = image.height * scale;
  return { x: win.width / 2 - view.center[0] * width, y: win.height / 2 - view.center[1] * height, width, height };
};

const maxZoom = (win: Size, image: Size) => Math.max(1, 1 / (fitScale(win, image) * window.devicePixelRatio));

const clampAxis = (center: number, span: number, extent: number) =>
  span > extent ? Math.min(Math.max(center, extent / (2 * span)), 1 - extent / (2 * span)) : 0.5;

const clampView = (view: ViewerView, win: Size, image: Size): ViewerView => {
  const zoom = Math.min(Math.max(view.zoom, 1), maxZoom(win, image));
  const rect = viewRect({ zoom, center: view.center }, win, image);
  return {
    zoom,
    center: [clampAxis(view.center[0], rect.width, win.width), clampAxis(view.center[1], rect.height, win.height)],
  };
};

const zoomAt = (view: ViewerView, zoom: number, point: Point, win: Size, image: Size): ViewerView => {
  const current = viewRect(view, win, image);
  const anchorX = (point.x - current.x) / current.width;
  const anchorY = (point.y - current.y) / current.height;
  const next = viewRect({ ...view, zoom: Math.min(Math.max(zoom, 1), maxZoom(win, image)) }, win, image);
  return clampView(
    {
      zoom,
      center: [anchorX + (win.width / 2 - point.x) / next.width, anchorY + (win.height / 2 - point.y) / next.height],
    },
    win,
    image,
  );
};

export default function ViewerWindow() {
  const [info, setInfo] = useState<ViewerInfo | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [win, setWin] = useState<Size>(windowSize);
  const [view, setView] = useState<ViewerView>(FIT_VIEW);
  const [isDragging, setIsDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointer: Point; view: ViewerView } | null>(null);

  const image = info?.image ?? null;
  const imagePath = image?.path;

  useEffect(() => {
    let isActive = true;
    let frameRequest = 0;

    const refreshInfo = async () => {
      const nextInfo = await invoke<ViewerInfo>(Invokes.GetViewerInfo);
      if (isActive) setInfo(nextInfo);
      return nextInfo;
    };

    const refreshFrame = async () => {
      const request = ++frameRequest;
      const frame = await invoke<ArrayBuffer>(Invokes.GetViewerFrame);
      const url = frame.byteLength > 0 ? URL.createObjectURL(new Blob([frame], { type: 'image/jpeg' })) : null;
      if (url) {
        const decoder = new Image();
        decoder.src = url;
        await decoder.decode().catch(() => undefined);
      }
      if (!isActive || request !== frameRequest) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      setFrameUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return url;
      });
    };

    const unlistenInfo = listen('viewer-info', () => {
      refreshInfo().catch(console.error);
    });
    const unlistenFrame = listen('viewer-updated', () => {
      refreshFrame().catch(console.error);
    });
    Promise.all([unlistenInfo, unlistenFrame])
      .then(() => refreshInfo())
      .then((nextInfo) => (nextInfo.native ? undefined : refreshFrame()))
      .catch(console.error);
    invoke<AppSettings>(Invokes.LoadSettings)
      .then((loaded) => {
        if (isActive) setSettings(loaded);
      })
      .catch(console.error);

    const handleResize = () => setWin(windowSize());
    window.addEventListener('resize', handleResize);

    return () => {
      isActive = false;
      unlistenInfo.then((fn) => fn());
      unlistenFrame.then((fn) => fn());
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'F11') {
        event.preventDefault();
        toggleFullscreen().catch(console.error);
      } else if (event.key === 'Escape') {
        getCurrentWindow().setFullscreen(false).catch(console.error);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    setView(FIT_VIEW);
  }, [imagePath]);

  useEffect(() => {
    if (image) setView((current) => clampView(current, win, image));
  }, [image, win]);

  useEffect(() => {
    if (!image) return;
    const frame = requestAnimationFrame(() => {
      const rect = viewRect(view, win, image);
      invoke(Invokes.SetViewerView, {
        payload: {
          path: image.path,
          view,
          targetResolution: calculateTargetResolution(
            settings,
            Math.max(rect.width, rect.height),
            window.devicePixelRatio,
            Math.max(image.width, image.height),
          ),
        },
      }).catch(console.error);
    });
    return () => cancelAnimationFrame(frame);
  }, [image, settings, view, win]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!image) return;
      const factor = wheelZoomFactor(event, settings?.zoomSpeedMultiplier, settings?.canvasInputMode);
      const point = { x: event.clientX, y: event.clientY };
      setView((current) => zoomAt(current, current.zoom * factor, point, win, image));
    };
    root.addEventListener('wheel', handleWheel, { passive: false });
    return () => root.removeEventListener('wheel', handleWheel);
  }, [image, settings?.zoomSpeedMultiplier, settings?.canvasInputMode, win]);

  const rect = image ? viewRect(view, win, image) : null;
  const canPan = rect !== null && (rect.width > win.width + 0.5 || rect.height > win.height + 0.5);
  const isJpegMode = info !== null && !info.native;

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !canPan) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointer: { x: event.clientX, y: event.clientY }, view };
    setIsDragging(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || !image) return;
    const start = viewRect(drag.view, win, image);
    setView(
      clampView(
        {
          zoom: drag.view.zoom,
          center: [
            drag.view.center[0] - (event.clientX - drag.pointer.x) / start.width,
            drag.view.center[1] - (event.clientY - drag.pointer.y) / start.height,
          ],
        },
        win,
        image,
      ),
    );
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setIsDragging(false);
  };

  const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!image) return;
    const point = { x: event.clientX, y: event.clientY };
    setView((current) => (current.zoom > 1 ? FIT_VIEW : zoomAt(current, maxZoom(win, image), point, win, image)));
  };

  return (
    <div
      className="relative h-screen w-screen select-none overflow-hidden"
      onContextMenu={(event) => event.preventDefault()}
      onDoubleClick={handleDoubleClick}
      onPointerCancel={handlePointerUp}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      ref={rootRef}
      style={{
        backgroundColor: isJpegMode ? toCssColor(info.background) : 'transparent',
        cursor: isDragging ? 'grabbing' : canPan ? 'grab' : 'default',
      }}
    >
      {isJpegMode && frameUrl && image && rect && (
        <img
          alt=""
          className="absolute left-0 top-0 max-w-none origin-top-left"
          draggable={false}
          src={frameUrl}
          style={{
            height: rect.height / view.zoom,
            transform: `translate(${rect.x}px, ${rect.y}px) scale(${view.zoom})`,
            width: rect.width / view.zoom,
          }}
        />
      )}
    </div>
  );
}
