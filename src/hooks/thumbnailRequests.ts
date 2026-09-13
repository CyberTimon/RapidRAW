import { invoke } from '@tauri-apps/api/core';

export interface ThumbnailGeneratedEvent {
  path: string;
  thumbnailPath?: string;
  previewPath?: string;
  revision?: string;
  previewRevision?: string;
  requestGeneration?: number | null;
  rating?: number;
  is_edited?: boolean;
  data?: string;
}

let generation = 0;
let commands: Promise<unknown> = Promise.resolve();
export const thumbnailGeneration = () => generation;

export function queueThumbnails(paths: string[], medium = false, background = false) {
  const requestGeneration = generation;
  commands = commands
    .catch(() => undefined)
    .then(() => {
      if (requestGeneration !== generation) return;
      return invoke('update_thumbnail_queue', { paths, medium, background, requestGeneration });
    });
  return commands;
}

export function resetThumbnailRequests() {
  generation += 1;
  return queueThumbnails([]);
}
