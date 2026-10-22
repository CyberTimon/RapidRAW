import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AppSettings, Invokes } from '../components/ui/AppProperties';
import { calculateTargetResolution } from '../utils/previewResolution';
import { clickZoomTarget, interpretWheel, movedBeyondClick } from '../utils/canvasControls';

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

const panBy = (view: ViewerView, dx: number, dy: number, win: Size, image: Size): ViewerView => {
  const rect = viewRect(view, win, image);
  return clampView(
    { zoom: view.zoom, center: [view.center[0] - dx / rect.width, view.center[1] - dy / rect.height] },
    win,
    image,
  );
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
  const pressRef = useRef<{ pointer: Point; view: ViewerView; button: number } | null>(null);
  const savedZoomRef = useRef<number | null>(null);

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
      const gesture = interpretWheel(event, settings?.zoomSpeedMultiplier, settings?.canvasInputMode);
      const point = { x: event.clientX, y: event.clientY };
      setView((current) =>
        gesture.kind === 'zoom'
          ? zoomAt(current, current.zoom * gesture.factor, point, win, image)
          : panBy(current, -gesture.dx, -gesture.dy, win, image),
      );
    };
    root.addEventListener('wheel', handleWheel, { passive: false });
    return () => root.removeEventListener('wheel', handleWheel);
  }, [image, settings?.zoomSpeedMultiplier, settings?.canvasInputMode, win]);

  const rect = image ? viewRect(view, win, image) : null;
  const canPan = rect !== null && (rect.width > win.width + 0.5 || rect.height > win.height + 0.5);
  const isJpegMode = info !== null && !info.native;

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pressRef.current = { pointer: { x: event.clientX, y: event.clientY }, view, button: event.button };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const press = pressRef.current;
    if (!press || !image) return;
    if (!isDragging && !movedBeyondClick(press.pointer, event.clientX, event.clientY)) return;
    setIsDragging(canPan);
    setView(panBy(press.view, event.clientX - press.pointer.x, event.clientY - press.pointer.y, win, image));
  };

  const releasePress = (event: React.PointerEvent<HTMLDivElement>) => {
    const press = pressRef.current;
    if (!press) return null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    pressRef.current = null;
    setIsDragging(false);
    return press;
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const press = releasePress(event);
    if (
      press &&
      image &&
      press.button === 0 &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !movedBeyondClick(press.pointer, event.clientX, event.clientY)
    ) {
      if (view.zoom > 1) {
        savedZoomRef.current = view.zoom;
        setView(FIT_VIEW);
      } else {
        const limit = maxZoom(win, image);
        const target = clickZoomTarget(view.zoom, limit, limit, savedZoomRef.current, settings?.zoomPhotoToPixelClick);
        setView(zoomAt(view, target, { x: event.clientX, y: event.clientY }, win, image));
      }
    }
  };

  return (
    <div
      className="relative h-screen w-screen select-none overflow-hidden"
      onContextMenu={(event) => event.preventDefault()}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onPointerCancel={releasePress}
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
