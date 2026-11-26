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

export const getFitRenderSize = (
  containerWidth: number,
  containerHeight: number,
  imgWidth: number,
  imgHeight: number,
): RenderSize => {
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

  return { width, height, scale: width / imgWidth, offsetX, offsetY, containerWidth, containerHeight };
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
      setRenderSize(getFitRenderSize(container.clientWidth, container.clientHeight, imgWidth, imgHeight));
    };

    updateSize();

    const resizeObserver = new ResizeObserver(() => {
      updateSize();
    });

    resizeObserver.observe(container);

    return () => resizeObserver.disconnect();
  }, [containerRef, imgWidth, imgHeight]);

  return renderSize;
};
