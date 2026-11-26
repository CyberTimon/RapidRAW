import { useEffect } from 'react';
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import i18n from 'i18next';
import { v4 as uuidv4 } from 'uuid';
import { Invokes } from '../types/invokes';
import { FitMode, MediaInfo, MediaRef, ProjectSettings, TimelapseSource, VideoProject } from '../types/video';
import { Adjustments } from '../utils/adjustments';
import { getCroppedDimensions } from '../utils/cropUtils';
import { errorReason, showError } from '../utils/errors';
import { placeMedia } from '../utils/video/edit';
import { mapParameters } from '../utils/video/maskTracking';
import {
  allItems,
  allTimelines,
  createClipItem,
  createProject,
  even,
  fileName,
  mainTrack,
  settingsFor,
} from '../utils/video/model';
import { retryMediaImages } from '../components/video/timeline/media';
import {
  editProject,
  ensureMedia,
  fileStem,
  getVideo,
  isAudioPath,
  isOpenProject,
  isProjectPath,
  isRawPath,
  isVideoPath,
  openProjectFile,
  readSidecarLook,
  seedLook,
  setVideo,
  startNewProjectFrom,
  useVideoStore,
  videoUnavailable,
} from './useVideoStore';
import { VideoJob, cancelVideoJob, isActiveJob, jobStatusFeed, useVideoJobs } from './videoJobs';
import type { AnalysisState } from './videoMotion';
import { requestProgramFrame } from './videoView';

export const TIMELAPSE_RATES = [24, 25, 30, 50, 60];
const JOB_KIND = 'timelapse';

export type TimelapseMedia = MediaRef & { timelapse: TimelapseSource };

type TimelapseFailure = {
  state: 'failed';
  reason: 'cancelled' | 'missing' | 'failed';
  file: string | null;
  error?: string;
};

export type TimelapseStatus = Exclude<AnalysisState, { state: 'failed' }> | TimelapseFailure;

interface Prepared {
  path: string;
  info: MediaInfo;
  ready: boolean;
}

interface TimelapseState {
  paths: Array<string> | null;
  states: Record<string, TimelapseStatus>;
}

export const useTimelapse = create<TimelapseState>(() => ({ paths: null, states: {} }));

const shotOf = (path: string) => path.replace(/\.[^./\\]*$/, '');

export const timelapsePhotos = (paths: Array<string>) => {
  const photos = [
    ...new Set(
      paths
        .filter((path) => !isProjectPath(path) && !isAudioPath(path) && !isVideoPath(path))
        .map((path) => path.split('?vc=')[0]),
    ),
  ];
  const rawShots = new Set(photos.filter(isRawPath).map(shotOf));
  return photos.filter((path) => isRawPath(path) || !rawShots.has(shotOf(path)));
};

export const mixesRaw = (photos: Array<string>) => photos.some(isRawPath) && !photos.every(isRawPath);

export const isTimelapseMedia = (media: MediaRef): media is TimelapseMedia => !!media.timelapse;

export const openTimelapseDialog = (paths: Array<string>) => {
  if (!videoUnavailable()) useTimelapse.setState({ paths: timelapsePhotos(paths) });
};

export const closeTimelapseDialog = () => useTimelapse.setState({ paths: null });

const synthetic = new Set<string>();
const failures = new Map<string, TimelapseStatus>();
const RUNNING: TimelapseStatus = { state: 'running', progress: 0 };
const NONE: TimelapseStatus = { state: 'none' };
const FAILED: TimelapseFailure = { state: 'failed', reason: 'failed', file: null };

const prepare = async (source: TimelapseSource, replace = false) => {
  const prepared = await invoke<Prepared>(Invokes.VideoTimelapsePrepare, { source });
  failures.delete(prepared.path);
  if (replace || !getVideo().media[prepared.path]) {
    setVideo((state) => ({ media: { ...state.media, [prepared.path]: prepared.info } }));
  }
  if (!prepared.ready) {
    synthetic.add(prepared.path);
    useTimelapse.setState((current) =>
      current.states[prepared.path]?.state === 'running'
        ? current
        : { states: { ...current.states, [prepared.path]: RUNNING } },
    );
  }
  return prepared;
};

const timelapseMedia = () => (getVideo().project?.media ?? []).filter(isTimelapseMedia);

const failureOf = (
  source: TimelapseSource,
  error: string | null | undefined,
  reason: 'cancelled' | 'missing' | 'failed',
): TimelapseFailure => {
  const frame = source.frames.find((path) => error?.startsWith(`${path}: `));
  return { state: 'failed', reason, file: frame ? fileName(frame) : null };
};

const statusOf = (media: TimelapseMedia, status: AnalysisState | undefined, job: VideoJob | undefined) => {
  if (status?.state === 'ready' || status?.state === 'running') return status;
  if (job?.state === 'failed' || job?.state === 'cancelled')
    failures.set(media.path, failureOf(media.timelapse, job.error, job.state === 'cancelled' ? 'cancelled' : 'failed'));
  return failures.get(media.path) ?? (status?.state === 'failed' ? FAILED : NONE);
};

const prepareMedia = (media: TimelapseMedia, replace = false) =>
  prepare(media.timelapse, replace).catch((err) => {
    const failure = failureOf(media.timelapse, String(err), 'missing');
    failures.set(media.path, failure.file ? failure : { ...FAILED, error: errorReason(err) });
    return null;
  });

const { refresh, watch: watchStatus } = jobStatusFeed<TimelapseStatus>(JOB_KIND, useTimelapse, async (publish) => {
  const media = timelapseMedia();
  const statuses: Record<string, AnalysisState> =
    media.length > 0
      ? await invoke<Record<string, AnalysisState>>(Invokes.VideoTimelapseStatus, {
          paths: media.map((entry) => entry.path),
        }).catch(() => ({}))
      : {};
  const jobs = new Map(
    useVideoJobs
      .getState()
      .jobs.filter((job) => job.kind === JOB_KIND)
      .map((job) => [job.key, job]),
  );
  const finished = new Set(
    media.filter((entry) => statuses[entry.path]?.state === 'ready' && synthetic.delete(entry.path)),
  );
  finished.forEach((entry) => retryMediaImages(entry.path));
  publish(
    Object.fromEntries(
      media.map((entry) => [entry.path, statusOf(entry, statuses[entry.path], jobs.get(fileStem(entry.path)))]),
    ),
  );
  for (const entry of media) {
    if (finished.has(entry) || !getVideo().media[entry.path]) await prepareMedia(entry, finished.has(entry));
  }
  if (finished.size > 0) void requestProgramFrame();
});

const usedTimelapses = (project: VideoProject | null) => {
  const paths = new Map((project?.media ?? []).filter(isTimelapseMedia).map((media) => [media.id, media.path]));
  if (!project || paths.size === 0) return new Set<string>();
  return new Set(
    allTimelines(project)
      .flatMap(allItems)
      .map((item) => (item.type === 'clip' ? paths.get(item.media) : undefined))
      .filter((path): path is string => !!path),
  );
};

const unused = new Set<string>();
let watchingUsage = false;

const watchUsage = () => {
  if (watchingUsage) return;
  watchingUsage = true;
  let previous = getVideo().project;
  let used = usedTimelapses(previous);
  useVideoStore.subscribe(({ project }) => {
    if (project === previous) return;
    const next = usedTimelapses(project);
    if (project && project.id === previous?.id) {
      const jobs = useVideoJobs.getState().jobs.filter((job) => job.kind === JOB_KIND && isActiveJob(job));
      for (const path of used) {
        const job = jobs.find((entry) => entry.key === fileStem(path));
        if (next.has(path) || !job) continue;
        unused.add(path);
        void cancelVideoJob(job.id);
      }
      for (const media of project.media.filter(isTimelapseMedia)) {
        if (next.has(media.path) && unused.delete(media.path)) void prepareMedia(media).then(refresh);
      }
    }
    previous = project;
    used = next;
  });
};

const watchTimelapses = () => {
  watchStatus();
  watchUsage();
};

export const restoreTimelapses = () =>
  void Promise.all(timelapseMedia().map((entry) => prepareMedia(entry))).then(refresh);

export const useTimelapseState = (path: string | null | undefined) => {
  useEffect(() => watchTimelapses(), []);
  return useTimelapse((state) => (path ? state.states[path] : undefined));
};

export const prepareTimelapses = async (project: VideoProject): Promise<VideoProject> => {
  const sources = project.media.filter(isTimelapseMedia);
  if (sources.length === 0) return project;
  watchTimelapses();
  const prepared = new Map(
    await Promise.all(sources.map(async (media) => [media.id, await prepareMedia(media)] as const)),
  );
  return {
    ...project,
    media: project.media.map((media) => {
      const path = prepared.get(media.id)?.path;
      return path && path !== media.path ? { ...media, path } : media;
    }),
  };
};

const capturedAt = (exif: Record<string, string> | undefined) =>
  exif?.DateTimeOriginal ? `${exif.DateTimeOriginal}.${(exif.SubSecTimeOriginal ?? '').padEnd(6, '0')}` : '';

const sortFrames = async (frames: Array<string>) => {
  const exif = await invoke<Record<string, Record<string, string>>>(Invokes.ReadExifForPaths, { paths: frames }).catch(
    () => ({}) as Record<string, Record<string, string>>,
  );
  const dated = frames.every((path) => capturedAt(exif[path]));
  const names = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...frames].sort(
    (a, b) => (dated ? capturedAt(exif[a]).localeCompare(capturedAt(exif[b])) : 0) || names.compare(a, b),
  );
};

const framing = (photo: MediaInfo, shown: { width: number; height: number }, canvas: ProjectSettings) => {
  const fit: FitMode = shown.width >= shown.height === canvas.width >= canvas.height ? 'fill' : 'fit';
  const scales = [canvas.width / shown.width, canvas.height / shown.height];
  const scale = Math.min(1, fit === 'fill' ? Math.max(...scales) : Math.min(...scales));
  return { fit, size: [even(photo.width * scale), even(photo.height * scale)] as [number, number] };
};

const scaledLook = (look: Adjustments, scale: number): Adjustments => {
  const similarity = { from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, scale, angle: 0 };
  const crop = look.crop && look.crop.unit !== '%' ? look.crop : null;
  return {
    ...look,
    aiPatches: [],
    crop: crop
      ? { ...crop, x: crop.x * scale, y: crop.y * scale, width: crop.width * scale, height: crop.height * scale }
      : look.crop,
    masks: (look.masks ?? []).map((container) => ({
      ...container,
      subMasks: container.subMasks.map((subMask) => ({
        ...subMask,
        parameters: mapParameters(subMask.type, subMask.parameters, similarity),
      })),
    })),
  };
};

const withTimelapse = (
  project: VideoProject,
  source: TimelapseSource,
  prepared: Prepared,
  look: Adjustments | null,
  fit: FitMode,
  mainIndex: number,
) => {
  const media: MediaRef = {
    id: uuidv4(),
    path: prepared.path,
    kind: 'video',
    name: i18n.t('video.timelapse.name', { name: fileStem(source.frames[0]) }),
    timelapse: source,
  };
  const [seeded, lookId] = seedLook({ ...project, media: [...project.media, media] }, look);
  return placeMedia(seeded, [{ ...createClipItem(media, prepared.info, seeded.settings, lookId), fit }], {
    mainIndex,
  });
};

export interface TimelapseRequest {
  paths: Array<string>;
  fps: number;
  deflicker: boolean;
  project: string | null;
}

export const createTimelapse = async ({ paths, fps, deflicker, project: target }: TimelapseRequest) => {
  try {
    const frames = await sortFrames(paths);
    const first = frames[0];
    const photo = first ? (await ensureMedia([first]))[first] : undefined;
    if (!photo) return;
    watchTimelapses();
    if (target && !isOpenProject(target)) await openProjectFile(target);
    const open = target && isOpenProject(target) ? getVideo().project : null;
    if (target && !open) return;
    const look = await readSidecarLook(first);
    const shown = getCroppedDimensions(photo.width, photo.height, look?.orientationSteps ?? 0, look?.crop);
    const canvas = open?.settings ?? { ...settingsFor({ ...photo, ...shown }), fps: { num: fps, den: 1 } };
    const { fit, size } = framing(photo, shown, canvas);
    const source: TimelapseSource = { frames, fps: canvas.fps, deflicker, size };
    const prepared = await prepare(source);
    const scaled = look ? scaledLook(look, size[0] / photo.width) : null;
    if (open) {
      editProject((current) => withTimelapse(current, source, prepared, scaled, fit, mainTrack(current).items.length));
      return;
    }
    const name = i18n.t('video.timelapse.name', { name: fileStem(first) });
    await startNewProjectFrom([first], withTimelapse(createProject(name, canvas), source, prepared, scaled, fit, 0));
  } catch (err) {
    showError('video.toasts.timelapseFailed', err);
  }
};

export const setTimelapseDeflicker = (media: TimelapseMedia, deflicker: boolean) =>
  editProject((project) =>
    project.media.some((entry) => entry.id === media.id && entry.timelapse && entry.timelapse.deflicker !== deflicker)
      ? {
          ...project,
          media: project.media.map((entry) =>
            entry.id === media.id && entry.timelapse
              ? { ...entry, timelapse: { ...entry.timelapse, deflicker } }
              : entry,
          ),
        }
      : project,
  );

export const retryTimelapse = (media: TimelapseMedia) => void prepareMedia(media).then(refresh);
