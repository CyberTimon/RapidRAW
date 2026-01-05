import { useState, useEffect, useCallback, type RefObject } from 'react';

export interface ImageRenderSize {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  scale: number;
}

interface UseImageRenderSizeOptions {
  imageWidth: number;
  imageHeight: number;
  containerRef: RefObject<HTMLElement | null>;
  padding?: number;
}

export function useImageRenderSize({
  imageWidth,
  imageHeight,
  containerRef,
  padding = 0,
}: UseImageRenderSizeOptions): ImageRenderSize {
  const [renderSize, setRenderSize] = useState<ImageRenderSize>({
    width: 0,
    height: 0,
    offsetX: 0,
    offsetY: 0,
    scale: 1,
  });

  const calculateSize = useCallback(() => {
    const container = containerRef.current;
    if (!container || imageWidth === 0 || imageHeight === 0) {
      return;
    }

    const containerWidth = container.clientWidth - padding * 2;
    const containerHeight = container.clientHeight - padding * 2;

    if (containerWidth <= 0 || containerHeight <= 0) {
      return;
    }

    const imageAspect = imageWidth / imageHeight;
    const containerAspect = containerWidth / containerHeight;

    let renderWidth: number;
    let renderHeight: number;
    let scale: number;

    if (imageAspect > containerAspect) {
      renderWidth = containerWidth;
      renderHeight = containerWidth / imageAspect;
      scale = containerWidth / imageWidth;
    } else {
      renderHeight = containerHeight;
      renderWidth = containerHeight * imageAspect;
      scale = containerHeight / imageHeight;
    }

    const offsetX = (containerWidth - renderWidth) / 2 + padding;
    const offsetY = (containerHeight - renderHeight) / 2 + padding;

    setRenderSize({
      width: renderWidth,
      height: renderHeight,
      offsetX,
      offsetY,
      scale,
    });
  }, [imageWidth, imageHeight, containerRef, padding]);

  useEffect(() => {
    calculateSize();

    const container = containerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver(calculateSize);
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, [calculateSize, containerRef]);

  return renderSize;
}
