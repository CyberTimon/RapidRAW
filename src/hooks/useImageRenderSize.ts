import { useState, useLayoutEffect } from 'react';

export interface ImageDimensions {
  height: number;
  width: number;
}

export interface RenderSize {
  containerHeight: number;
  containerWidth: number;
  height: number;
  offsetX: number;
  offsetY: number;
  scale: number;
  width: number;
}

const DEFAULT_SIZE: RenderSize = {
  width: 0,
  height: 0,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  containerWidth: 0,
  containerHeight: 0,
};

export const useImageRenderSize = (
  containerRef: React.RefObject<HTMLElement | null>,
  imageDimensions: ImageDimensions | null,
) => {
  const [renderSize, setRenderSize] = useState<RenderSize>(DEFAULT_SIZE);
  const imgWidth = imageDimensions?.width;
  const imgHeight = imageDimensions?.height;

  useLayoutEffect(() => {
    const container = containerRef.current;

    if (!container || !imgWidth || !imgHeight) {
      setRenderSize(DEFAULT_SIZE);
      return;
    }

    const updateSize = () => {
      const { clientWidth: containerWidth, clientHeight: containerHeight } = container;
      const imageAspectRatio = imgWidth / imgHeight;
      const containerAspectRatio = containerWidth / containerHeight;

      let width, height;
      if (imageAspectRatio > containerAspectRatio) {
        width = containerWidth;
        height = containerWidth / imageAspectRatio;
      } else {
        height = containerHeight;
        width = containerHeight * imageAspectRatio;
      }

      const offsetX = (containerWidth - width) / 2;
      const offsetY = (containerHeight - height) / 2;

      setRenderSize({ width, height, scale: width / imgWidth, offsetX, offsetY, containerWidth, containerHeight });
    };

    updateSize();

    // WebView2 can report a stale (pre-maximize) clientWidth/clientHeight on
    // the very first measurement when the OS window opens already maximized
    // (see the Rust side's "maximize on first launch" behavior): the native
    // window has finished resizing, but the webview's internal layout hasn't
    // caught up yet for that first paint. Since nothing actually resizes
    // afterward, ResizeObserver never fires again to self-correct — until
    // the user manually resizes the window, which is what "fixes" it. These
    // follow-up re-measurements catch that race without needing a real
    // resize event; they're cheap no-ops once the first measurement was
    // already correct.
    const rafId = requestAnimationFrame(updateSize);
    const timeoutId = window.setTimeout(updateSize, 250);

    const resizeObserver = new ResizeObserver(() => {
      updateSize();
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      cancelAnimationFrame(rafId);
      window.clearTimeout(timeoutId);
    };
  }, [containerRef, imgWidth, imgHeight]);

  return renderSize;
};
