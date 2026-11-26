import { ClipItem, MediaInfo, SolidItem, Transform, VideoProject, VisualItem } from '../../types/video';
import { getCroppedDimensions } from '../cropUtils';
import { animated } from './animation';
import { updateItem } from './edit';
import { locateItem, lookOf, mediaOf } from './model';
import { layoutTitle } from './titles';

export type Arrangement = 'fullFrame' | 'sideBySide' | 'stack' | 'grid' | 'pictureInPicture';
type Arrangeable = ClipItem | SolidItem;

export const ARRANGEMENTS: Array<Arrangement> = ['fullFrame', 'sideBySide', 'stack', 'grid', 'pictureInPicture'];
const MIN_ARRANGED = 2;
const MAX_ARRANGED = 4;

const INSET_SIZE = 0.3;
const INSET_MARGIN = 0.04;
const FULL_VIEW = 0.999;

interface Cell {
  x: number;
  y: number;
  width: number;
  height: number;
}

const mediaInfo = (project: VideoProject, item: ClipItem, media: Record<string, MediaInfo>) => {
  const ref = mediaOf(project, item.media);
  return ref ? media[ref.path] : undefined;
};

export const cellFrame = (width: number, height: number, aspect: number | undefined) => {
  if (!aspect) return { x: 0, y: 0, width, height };
  const framedWidth = Math.min(width, height * aspect);
  const framedHeight = Math.min(height, width / aspect);
  return { x: (width - framedWidth) / 2, y: (height - framedHeight) / 2, width: framedWidth, height: framedHeight };
};

const sourceSize = (project: VideoProject, item: Arrangeable, media: Record<string, MediaInfo>) => {
  if (item.type === 'solid') return { width: project.settings.width, height: project.settings.height };
  const info = mediaInfo(project, item, media);
  if (!info) return null;
  const look = lookOf(project, item);
  return getCroppedDimensions(info.width, info.height, look?.orientationSteps ?? 0, look?.crop ?? null);
};

export const contentSize = (project: VideoProject, item: VisualItem, media: Record<string, MediaInfo>) => {
  const { width, height } = project.settings;
  if (item.type === 'title') return layoutTitle(item, height);
  if (item.type === 'adjustment') return { width, height };
  const source = sourceSize(project, item, media) ?? { width, height };
  const framed = cellFrame(source.width, source.height, item.cellAspect);
  if (item.type === 'solid') return { width: framed.width, height: framed.height };
  const fit =
    item.fit === 'fill'
      ? Math.max(width / framed.width, height / framed.height)
      : Math.min(width / framed.width, height / framed.height);
  return { width: framed.width * fit, height: framed.height * fit };
};

const withoutCellAspect = <T extends Arrangeable>(item: T): T => {
  const { cellAspect: _cellAspect, ...whole } = item;
  return whole as T;
};

const framedInCell = <T extends Arrangeable>(
  project: VideoProject,
  item: T,
  media: Record<string, MediaInfo>,
  aspect: number,
): T => {
  const whole = withoutCellAspect(item);
  const unblurred = whole.type === 'clip' && whole.fit === 'blur' ? { ...whole, fit: 'fit' as const } : whole;
  const source = sourceSize(project, item, media);
  const framed = source && cellFrame(source.width, source.height, aspect);
  const full = !!framed && framed.width >= source.width * FULL_VIEW && framed.height >= source.height * FULL_VIEW;
  return full ? unblurred : { ...unblurred, cellAspect: aspect };
};

const insetCell = (project: VideoProject, index: number): Cell => {
  const { width, height } = project.settings;
  const marginX = (INSET_MARGIN * Math.min(width, height)) / width;
  const marginY = (INSET_MARGIN * Math.min(width, height)) / height;
  const right = index % 2 === 1;
  const bottom = index < 3;
  return {
    x: right ? 1 - marginX - INSET_SIZE : marginX,
    y: bottom ? 1 - marginY - INSET_SIZE : marginY,
    width: INSET_SIZE,
    height: INSET_SIZE,
  };
};

const cellsFor = (project: VideoProject, layout: Arrangement, count: number): Array<Cell> =>
  Array.from({ length: count }, (_, index) => {
    switch (layout) {
      case 'sideBySide':
        return { x: index / count, y: 0, width: 1 / count, height: 1 };
      case 'stack':
        return { x: 0, y: index / count, width: 1, height: 1 / count };
      case 'grid': {
        const alone = index === count - 1 && count % 2 === 1;
        const top = (1 - Math.ceil(count / 2) / 2) / 2;
        return { x: alone ? 0.25 : (index % 2) / 2, y: top + Math.floor(index / 2) / 2, width: 0.5, height: 0.5 };
      }
      default:
        return index === 0 ? { x: 0, y: 0, width: 1, height: 1 } : insetCell(project, index);
    }
  });

const placed = (transform: Transform, x: number, y: number, scale: number): Transform => ({
  ...transform,
  x: animated(x),
  y: animated(y),
  scale: animated(scale),
  rotation: animated(0),
});

const fullFrame = (project: VideoProject, item: Arrangeable) =>
  updateItem<Arrangeable>(project, item.id, (current) => {
    const whole = withoutCellAspect(current);
    return { ...whole, transform: placed(whole.transform, 0, 0, 1) };
  });

const placeInCell = (project: VideoProject, item: Arrangeable, cell: Cell, media: Record<string, MediaInfo>) => {
  const { width, height } = project.settings;
  const cellWidth = cell.width * width;
  const cellHeight = cell.height * height;
  return updateItem<Arrangeable>(project, item.id, (current) => {
    const framed = framedInCell(project, current, media, cellWidth / cellHeight);
    const content = contentSize(project, framed, media);
    const scale = Math.max(cellWidth / Math.max(1, content.width), cellHeight / Math.max(1, content.height));
    return {
      ...framed,
      transform: placed(framed.transform, cell.x + cell.width / 2 - 0.5, cell.y + cell.height / 2 - 0.5, scale),
    };
  });
};

const arrangeableItems = (project: VideoProject, ids: Array<string>) =>
  ids
    .flatMap((id) => {
      const location = locateItem(project, id);
      return location?.item.type === 'clip' || location?.item.type === 'solid' ? [location] : [];
    })
    .sort((a, b) => a.trackIndex - b.trackIndex || a.item.start - b.item.start)
    .map((location) => location.item as Arrangeable);

export const canArrange = (project: VideoProject, ids: Array<string>) => {
  const count = arrangeableItems(project, ids).length;
  return count >= MIN_ARRANGED && count <= MAX_ARRANGED;
};

export const arrangeItems = (
  project: VideoProject,
  ids: Array<string>,
  layout: Arrangement,
  media: Record<string, MediaInfo>,
): VideoProject => {
  const items = arrangeableItems(project, ids);
  if (items.length < MIN_ARRANGED || items.length > MAX_ARRANGED) return project;
  const cells = cellsFor(project, layout, items.length);
  return items.reduce(
    (next, item, index) =>
      layout === 'fullFrame' ? fullFrame(next, item) : placeInCell(next, item, cells[index], media),
    project,
  );
};

const placements = (project: VideoProject, ids: Array<string>) =>
  arrangeableItems(project, ids)
    .map((item) => JSON.stringify([item.transform, item.cellAspect ?? null]))
    .join('|');

export const arrangementOf = (
  project: VideoProject,
  ids: Array<string>,
  media: Record<string, MediaInfo>,
): Arrangement | null => {
  const current = placements(project, ids);
  return ARRANGEMENTS.find((layout) => placements(arrangeItems(project, ids, layout, media), ids) === current) ?? null;
};
