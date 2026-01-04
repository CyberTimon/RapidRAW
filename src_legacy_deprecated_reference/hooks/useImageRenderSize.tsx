import { useState, useEffect } from 'react';

export interface ImageDimensions {
  height: number;
  width: number;
}

export interface RenderSize {
  height: number;
  offsetX: number;
  offsetY: number;
  scale: number;
  width: number;
}

export const useImageRenderSize = (containerRef: any, imageDimensions: ImageDimensions | null) => {
  const [renderSize, setRenderSize] = useState<RenderSize>({ width: 0, height: 0, scale: 1, offsetX: 0, offsetY: 0 });

  useEffect(() => {
    const container: HTMLDivElement = containerRef.current;
    const { width: imgWidth, height: imgHeight } = imageDimensions || {};
    if (!container || !imgWidth || !imgHeight) {
      if (renderSize.width !== 0 || renderSize.height !== 0) {
        setRenderSize({ width: 0, height: 0, scale: 1, offsetX: 0, offsetY: 0 });
      }
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

      setRenderSize({ width, height, scale: width / imgWidth, offsetX, offsetY });
    };

    updateSize();
    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [containerRef, imageDimensions]);

  return renderSize;
};
