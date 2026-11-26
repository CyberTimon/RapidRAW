import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import i18n from 'i18next';
import { toast } from 'react-toastify';
import { Invokes } from '../../../types/invokes';
import { ImmichMediaRef, immichMediaRefs } from '../../../utils/immichApi';
import { SupportedTypes } from '../../../types/library';
import { MediaKind, MediaRef, TimeRange, TimelineItem, VideoProject } from '../../../types/video';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { editProject, ensureMedia, getVideo, openProjectMedia, useVideoStore } from '../../../store/useVideoStore';
import { patchMedia, setMediaRangeEdge } from '../../../utils/video/edit';
import { allItems, allTimelines, fileName } from '../../../utils/video/model';
import { secondsToTicks, snapTicks } from '../../../utils/video/time';

const KIND_TYPES: Record<MediaKind, Array<keyof SupportedTypes>> = {
  video: ['video'],
  image: ['nonRaw', 'raw'],
  audio: ['audio'],
  sequence: [],
};

export const mediaName = (media: MediaRef) => media.name ?? fileName(media.path);

const searchableTag = (tag: string) => (tag.startsWith('color:') ? '' : tag.replace(/^user:/, '').toLowerCase());

export const matchesQuery = (media: MediaRef, query: string, tags?: Array<string> | null) =>
  !query || mediaName(media).toLowerCase().includes(query) || !!tags?.some((tag) => searchableTag(tag).includes(query));

export const firstUses = (project: VideoProject) => {
  const uses = new Map<string, TimelineItem>();
  for (const item of allItems(project)) {
    if (!('media' in item)) continue;
    const current = uses.get(item.media);
    if (!current || item.start < current.start) uses.set(item.media, item);
  }
  return uses;
};

const usedMedia = new WeakMap<VideoProject, ReadonlySet<string>>();

export const usedMediaIds = (project: VideoProject): ReadonlySet<string> => {
  let used = usedMedia.get(project);
  if (!used) {
    used = new Set(
      allTimelines(project).flatMap((timeline) =>
        allItems(timeline).flatMap((item) => ('media' in item ? [item.media] : [])),
      ),
    );
    usedMedia.set(project, used);
  }
  return used;
};

export const isMediaUsed = (project: VideoProject, id: string) => usedMediaIds(project).has(id);

export const removeMedia = (project: VideoProject, id: string): VideoProject => ({
  ...project,
  media: project.media.filter((media) => media.id !== id),
  sequences: Object.fromEntries(Object.entries(project.sequences ?? {}).filter(([key]) => key !== id)),
});

const relinkMedia = (project: VideoProject, id: string, path: string, immich?: ImmichMediaRef): VideoProject => {
  const existing = project.media.find((media) => media.path === path && media.id !== id);
  if (!existing) return patchMedia(project, id, { path, immich });
  const remap = <T extends TimelineItem>(item: T): T =>
    'media' in item && item.media === id ? { ...item, media: existing.id } : item;
  return {
    ...removeMedia(project, id),
    videoTracks: project.videoTracks.map((track) => ({ ...track, items: track.items.map(remap) })),
    audioTracks: project.audioTracks.map((track) => ({ ...track, items: track.items.map(remap) })),
  };
};

export const locateMedia = async (media: MediaRef) => {
  const types = useSettingsStore.getState().supportedTypes;
  const extensions = KIND_TYPES[media.kind].flatMap((key) => types?.[key] ?? []);
  const selected = await open({
    multiple: false,
    filters:
      extensions.length > 0
        ? [
            {
              name: i18n.t('video.mediaPool.mediaFiles'),
              extensions: [...extensions, ...extensions.map((extension) => extension.toUpperCase())],
            },
          ]
        : undefined,
  });
  if (typeof selected !== 'string') return;
  const known = await ensureMedia([selected], true);
  if (!known[selected] || selected === media.path) return;
  const [immich] = await immichMediaRefs([selected]).catch(() => []);
  editProject((project) => relinkMedia(project, media.id, selected, immich ?? undefined));
};

export const revealPath = (path: string) =>
  invoke(Invokes.ShowInFinder, { path }).catch((err) =>
    toast.error(i18n.t('contextMenus.toasts.couldNotShowExplorer', { err })),
  );

const mediaIndexes = new WeakMap<Array<MediaRef>, Map<string, MediaRef>>();

const projectMediaAt = (media: Array<MediaRef> | undefined, path: string) => {
  if (!media) return undefined;
  let index = mediaIndexes.get(media);
  if (!index) {
    index = new Map(media.map((entry) => [entry.path, entry]));
    mediaIndexes.set(media, index);
  }
  return index.get(path);
};

export const useProjectMedia = (path: string) =>
  useVideoStore((state) => projectMediaAt(openProjectMedia(state), path));

export const markMediaRange = (media: MediaRef, edge: keyof TimeRange, fraction: number) => {
  const project = getVideo().project;
  const duration = media.kind === 'image' ? 0 : secondsToTicks(getVideo().media[media.path]?.duration ?? 0);
  if (!project || duration <= 0) return;
  const time = Math.min(duration, snapTicks(fraction * duration, project.settings.fps));
  editProject((current) => setMediaRangeEdge(current, media.id, edge, time, duration), undefined, false);
};

export const clearMediaRange = (media: MediaRef) => {
  if (media.range) editProject((current) => patchMedia(current, media.id, { range: undefined }), undefined, false);
};

let skimmed: { path: string; fraction: number } | null = null;

export const skimTo = (path: string, fraction: number) => {
  skimmed = { path, fraction };
};

export const endSkim = (path: string) => {
  if (skimmed?.path === path) skimmed = null;
};

const skimmedMedia = () => {
  const media = skimmed ? projectMediaAt(openProjectMedia(getVideo()), skimmed.path) : undefined;
  return media && skimmed && media.kind !== 'image' ? { media, fraction: skimmed.fraction } : null;
};

export const markSkimmedMedia = (edge: keyof TimeRange) => {
  const target = skimmedMedia();
  if (target) markMediaRange(target.media, edge, target.fraction);
  return target !== null;
};

export const clearSkimmedRange = () => {
  const target = skimmedMedia();
  if (target) clearMediaRange(target.media);
  return target !== null;
};

const probed = new Set<string>();

export const useMissingMedia = (paths: Array<string>) => {
  const media = useVideoStore((state) => state.media);
  const offline = useVideoStore((state) => state.offline);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const key = paths.join('\n');

  useEffect(() => {
    const known = getVideo().media;
    const todo = key.split('\n').filter((path) => path && !known[path] && !probed.has(path));
    if (todo.length === 0) return;
    todo.forEach((path) => probed.add(path));
    setPending((prev) => new Set([...prev, ...todo]));
    void ensureMedia(todo).finally(() =>
      setPending((prev) => new Set([...prev].filter((path) => !todo.includes(path)))),
    );
  }, [key]);

  return useCallback(
    (path: string) => !media[path] && (probed.has(path) || !!offline[path]) && !pending.has(path),
    [media, offline, pending],
  );
};
