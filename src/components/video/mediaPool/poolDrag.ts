import type { Active } from '@dnd-kit/core';
import { VideoProject } from '../../../types/video';
import { addMediaToPool, editProject, getVideo, isMediaCandidate } from '../../../store/useVideoStore';
import { binOfMedia, canMoveBin, moveBin, moveMediaToBin } from '../../../utils/video/bins';
import { draggedPaths } from '../timeline/drop';

export const PROJECT_DRAG_PREFIX = 'media-pool-project:';
export const BIN_DRAG_PREFIX = 'media-pool-bin:';
export const BIN_DRAG = 'media-bin';
export const BIN_TARGET = 'media-bin-target';

type DragSource = Pick<Active, 'id' | 'data'>;

export const isPoolMediaDrag = (active: DragSource) => String(active.id).startsWith(PROJECT_DRAG_PREFIX);

type Dragged = { kind: 'bin'; bin: string } | { kind: 'media'; paths: Array<string> };

const dragged = (active: DragSource): Dragged | null => {
  const data = active.data.current;
  if (data?.type === BIN_DRAG) return { kind: 'bin', bin: data.bin };
  if (data?.type !== 'library-image') return null;
  return { kind: 'media', paths: draggedPaths(data.path, data.paths).filter(isMediaCandidate) };
};

const movableMedia = (project: VideoProject, paths: Array<string>, target: string | null) => {
  const wanted = new Set(paths);
  return project.media.filter((media) => wanted.has(media.path) && binOfMedia(project, media) !== target);
};

const newPaths = (project: VideoProject, paths: Array<string>) => {
  const known = new Set(project.media.map((media) => media.path));
  return paths.filter((path) => !known.has(path));
};

export const acceptsBinDrop = (active: DragSource | null, target: string | null) => {
  const project = getVideo().project;
  const source = active && dragged(active);
  if (!project || !source) return false;
  if (source.kind === 'bin') return canMoveBin(project, source.bin, target);
  return (
    movableMedia(project, source.paths, target).length > 0 ||
    (!isPoolMediaDrag(active) && newPaths(project, source.paths).length > 0)
  );
};

export const dropOnBin = (active: DragSource, target: string | null) => {
  const project = getVideo().project;
  const source = dragged(active);
  if (!project || !source || !acceptsBinDrop(active, target)) return;
  if (source.kind === 'bin') {
    editProject((current) => moveBin(current, source.bin, target), undefined, false);
    return;
  }
  const moving = movableMedia(project, source.paths, target).map((media) => media.id);
  if (moving.length > 0) editProject((current) => moveMediaToBin(current, moving, target), undefined, false);
  const added = isPoolMediaDrag(active) ? [] : newPaths(project, source.paths);
  if (added.length > 0) void addMediaToPool(added, target);
};

export const dropOnPool = (active: DragSource, bin: string | null) => {
  const source = dragged(active);
  if (source?.kind === 'media' && !isPoolMediaDrag(active) && source.paths.length > 0)
    void addMediaToPool(source.paths, bin);
};
