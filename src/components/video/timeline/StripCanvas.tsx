import { memo, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import clsx from 'clsx';
import type { Filmstrip } from './media';

const MIN_TILE_WIDTH = 16;

const pixelRatio = () => window.devicePixelRatio || 1;

const watchPixelRatio = (notify: () => void) => {
  let query = window.matchMedia(`(resolution: ${pixelRatio()}dppx)`);
  const changed = () => {
    query.removeEventListener('change', changed);
    query = window.matchMedia(`(resolution: ${pixelRatio()}dppx)`);
    query.addEventListener('change', changed);
    notify();
  };
  query.addEventListener('change', changed);
  return () => query.removeEventListener('change', changed);
};

export interface FilmTile {
  left: number;
  right: number;
  tile: number;
}

export const filmTiles = (
  strip: Filmstrip,
  from: number,
  to: number,
  origin: number,
  height: number,
  fractionsAt: (centers: Array<number>) => Array<number>,
): Array<FilmTile> => {
  const size = Math.max(MIN_TILE_WIDTH, height * strip.aspect);
  const starts: Array<number> = [];
  for (let index = Math.floor((from - origin) / size); to > from && origin + index * size < to; index++) {
    starts.push(origin + index * size);
  }
  const fractions = fractionsAt(starts.map((start) => start + size / 2));
  const count = strip.tiles.length;
  return starts.map((start, index) => ({
    left: Math.round(start),
    right: Math.round(start + size),
    tile: Math.min(count - 1, Math.max(0, Math.floor((fractions[index] ?? 0) * count))),
  }));
};

function StripCanvas({
  strip,
  from,
  to,
  height,
  tiles,
  className,
}: {
  strip: Filmstrip;
  from: number;
  to: number;
  height: number;
  tiles: Array<FilmTile>;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const width = Math.max(0, to - from);
  const ratio = useSyncExternalStore(watchPixelRatio, pixelRatio);

  useLayoutEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext('2d', { willReadFrequently: true });
    if (!canvas || !context) return;
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    context.clearRect(0, 0, pixelWidth, pixelHeight);
    context.imageSmoothingQuality = 'high';
    const x = (edge: number) => Math.round((edge - from) * ratio);
    tiles.forEach(({ left, right, tile }) => {
      const bitmap = strip.tiles[tile];
      if (bitmap?.width) context.drawImage(bitmap, x(left), 0, x(right) - x(left), pixelHeight);
    });
  }, [strip, from, width, height, tiles, ratio]);

  return (
    <canvas
      ref={ref}
      className={clsx('absolute top-0 pointer-events-none', className)}
      style={{ left: from, width, height }}
    />
  );
}

export default memo(StripCanvas);
