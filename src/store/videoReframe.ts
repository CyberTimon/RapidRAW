import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { Invokes } from '../types/invokes';
import {
  ClipItem,
  FitMode,
  MediaInfo,
  MotionTrack,
  Ticks,
  TrackKey,
  VideoProject,
  VideoTrack,
  VisualItem,
} from '../types/video';
import { showError } from '../utils/errors';
import { updateItem } from '../utils/video/edit';
import { contentSize } from '../utils/video/layouts';
import { frameSourceTime, itemEnd, locateItem, mediaOf, sameRatio } from '../utils/video/model';
import { frameTicks, ticksToSeconds } from '../utils/video/time';
import { thinTrack } from '../utils/video/tracking';
import { editProject, getVideo } from './useVideoStore';
import { AnalysisState } from './videoMotion';
import { cancelVideoJob } from './videoJobs';
import { requestProgramFrame } from './videoView';

const STATUS_POLL_MS = 150;
const ROOM_SHARE = 0.01;
const CENTER: TrackKey = { time: 0, x: 0.5, y: 0.5, scale: 1, rotation: 0 };

interface Analysis {
  id: string;
  job: string | null;
}

interface ReframeState {
  running: Record<string, number>;
}

export const useVideoReframe = create<ReframeState>(() => ({ running: {} }));

const jobs = new Map<string, string>();

const setRunning = (update: (running: Record<string, number>) => Record<string, number>) =>
  useVideoReframe.setState(({ running }) => ({ running: update(running) }));

export const isReframed = (item: VisualItem) => item.type === 'clip' && !!item.transform.track?.reframe;

const sourceOf = (project: VideoProject, clip: ClipItem, media: Record<string, MediaInfo>) => {
  const ref = mediaOf(project, clip.media);
  const info = ref ? media[ref.path] : undefined;
  return ref?.kind === 'video' && info?.hasVideo && !info.isStill ? { path: ref.path, info } : null;
};

const covers = (project: VideoProject, clip: ClipItem, media: Record<string, MediaInfo>) => {
  const { width, height } = contentSize(project, clip, media);
  return width >= project.settings.width - 1 && height >= project.settings.height - 1;
};

const framingOf = (project: VideoProject, clip: ClipItem, media: Record<string, MediaInfo>): ClipItem => ({
  ...clip,
  fit: covers(project, clip, media) ? clip.fit : 'fill',
  transform: { ...clip.transform, track: null },
});

export const canReframe = (project: VideoProject, clip: ClipItem, media: Record<string, MediaInfo>) => {
  if (clip.freeze || clip.cellAspect || (clip.transform.track && !clip.transform.track.reframe)) return false;
  if (!sourceOf(project, clip, media)) return false;
  const { width, height } = contentSize(project, { ...clip, fit: 'fill' }, media);
  const scale = Math.max(clip.transform.scale.value, ...(clip.transform.scale.keys ?? []).map((key) => key.value));
  return (
    width * scale > project.settings.width * (1 + ROOM_SHARE) ||
    height * scale > project.settings.height * (1 + ROOM_SHARE)
  );
};

export const reframeCandidates = (project: VideoProject, media: Record<string, MediaInfo>) =>
  project.videoTracks
    .flatMap((track) => track.items)
    .filter((item): item is ClipItem => item.type === 'clip' && !isReframed(item) && canReframe(project, item, media))
    .map((item) => item.id);

const timelineFrames = (project: VideoProject, clip: ClipItem) => {
  const times: Array<Ticks> = [];
  for (let time = clip.start; time < itemEnd(clip); time += frameTicks(project.settings.fps)) times.push(time);
  return times;
};

const sourceTimes = (project: VideoProject, clip: ClipItem, info: MediaInfo, times: Array<Ticks>) =>
  times.map((time) => ticksToSeconds(frameSourceTime(clip, time, project.settings.fps, info.fps)));

interface Reframing {
  itemId: string;
  fit: FitMode;
  track: MotionTrack;
}

const solve = async (
  project: VideoProject,
  media: Record<string, MediaInfo>,
  itemId: string,
  analysis: string,
): Promise<Reframing | null> => {
  const clip = locateItem(project, itemId)?.item;
  if (clip?.type !== 'clip' || !canReframe(project, clip, media) || !sourceOf(project, clip, media)) return null;
  const framing = framingOf(project, clip, media);
  const { width, height } = project.settings;
  const times = timelineFrames(project, clip);
  if (times.length === 0) return null;
  const shifts = await invoke<Array<[number, number]>>(Invokes.VideoReframePath, {
    request: { analysis, project: updateItem<ClipItem>(project, itemId, () => framing), itemId, times },
  });
  const keys = times.map((time, index) => ({
    time: ticksToSeconds(time - clip.start),
    x: 0.5 + shifts[index][0] / width,
    y: 0.5 + shifts[index][1] / height,
    scale: 1,
    rotation: 0,
  }));
  const track: MotionTrack = { reference: CENTER, keys: thinTrack(keys, [width, height, 0, 0]), reframe: true };
  return { itemId, fit: framing.fit, track };
};

const waitForAnalyses = async (analyses: Map<string, Analysis>) => {
  const ids = [...new Set([...analyses.values()].map((analysis) => analysis.id))];
  for (;;) {
    const states = await invoke<Record<string, AnalysisState>>(Invokes.VideoReframeStatus, { ids });
    const progress = (state: AnalysisState | undefined) => (state?.state === 'running' ? state.progress : null);
    setRunning((running) => {
      const next = { ...running };
      analyses.forEach((analysis, itemId) => {
        const value = progress(states[analysis.id]);
        if (value !== null && itemId in next) next[itemId] = value;
      });
      return next;
    });
    if (ids.every((id) => progress(states[id]) === null)) return states;
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_MS));
  }
};

export const reframeClips = async (itemIds: Array<string>) => {
  const { project, media } = getVideo();
  if (!project) return;
  const ids = itemIds.filter((id) => !(id in useVideoReframe.getState().running));
  if (ids.length === 0) return;
  setRunning((running) => ({ ...running, ...Object.fromEntries(ids.map((id) => [id, 0])) }));
  try {
    const analyses = new Map<string, Analysis>();
    for (const id of ids) {
      const clip = locateItem(project, id)?.item;
      const source = clip?.type === 'clip' ? sourceOf(project, clip, media) : null;
      if (clip?.type !== 'clip' || !source) continue;
      const analysis = await invoke<Analysis>(Invokes.VideoReframeAnalyze, {
        request: { path: source.path, times: sourceTimes(project, clip, source.info, timelineFrames(project, clip)) },
      });
      analyses.set(id, analysis);
      if (analysis.job) jobs.set(id, analysis.job);
    }
    const states = await waitForAnalyses(analyses);
    const current = getVideo();
    if (!current.project) return;
    const results: Array<Reframing> = [];
    for (const [itemId, analysis] of analyses) {
      if (states[analysis.id]?.state !== 'ready') continue;
      const result = await solve(current.project, current.media, itemId, analysis.id);
      if (result) results.push(result);
    }
    if (results.length === 0) return;
    editProject((edited) =>
      results.reduce(
        (next, { itemId, fit, track }) =>
          updateItem<ClipItem>(next, itemId, (clip) => ({ ...clip, fit, transform: { ...clip.transform, track } })),
        edited,
      ),
    );
    void requestProgramFrame();
  } catch (error) {
    showError('video.toasts.reframeFailed', error, { retry: () => void reframeClips(ids) });
  } finally {
    ids.forEach((id) => jobs.delete(id));
    setRunning((running) => Object.fromEntries(Object.entries(running).filter(([id]) => !ids.includes(id))));
  }
};

export const cancelReframe = (itemIds: Array<string>) =>
  itemIds.forEach((id) => {
    const job = jobs.get(id);
    if (job) void cancelVideoJob(job);
  });

export const removeReframe = (itemId: string) =>
  editProject((project) =>
    updateItem<ClipItem>(project, itemId, (clip) => ({ ...clip, transform: { ...clip.transform, track: null } })),
  );

const withoutReframe = (track: VideoTrack): VideoTrack =>
  track.items.some(isReframed)
    ? {
        ...track,
        items: track.items.map((item) =>
          isReframed(item) && item.type === 'clip' ? { ...item, transform: { ...item.transform, track: null } } : item,
        ),
      }
    : track;

export const withCanvasSize = (project: VideoProject, size: { width: number; height: number }): VideoProject => {
  const resized = { ...project, settings: { ...project.settings, ...size } };
  if (sameRatio(project.settings.width / project.settings.height, size.width / size.height)) return resized;
  return {
    ...resized,
    videoTracks: resized.videoTracks.map(withoutReframe),
    ...(resized.sequences && {
      sequences: Object.fromEntries(
        Object.entries(resized.sequences).map(([id, sequence]) => [
          id,
          { ...sequence, videoTracks: sequence.videoTracks.map(withoutReframe) },
        ]),
      ),
    }),
  };
};
