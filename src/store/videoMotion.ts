import { create } from 'zustand';
import { Channel, invoke } from '@tauri-apps/api/core';
import i18n from 'i18next';
import { Invokes } from '../types/invokes';
import {
  ClipItem,
  FrameRate,
  MediaInfo,
  MotionTrack,
  Quad,
  Ticks,
  TrackKey,
  VideoProject,
  VisualItem,
} from '../types/video';
import { lookUsers, setClipReverse, updateItem, visualItemsAt } from '../utils/video/edit';
import { contentSize } from '../utils/video/layouts';
import {
  allItems,
  allTimelines,
  frameSourceTime,
  isMovingVideo,
  itemEnd,
  locateItem,
  lookOf,
  mediaOf,
} from '../utils/video/model';
import { fpsValue, frameTicks, ticksToSeconds } from '../utils/video/time';
import { withRevision } from '../utils/video/revisions';
import {
  Region,
  TrackDirection,
  TrackKind,
  TrackSample,
  clampIntoItem,
  keptSamples,
  maxTrackGap,
  pinnedQuad,
  placementAt,
  regionQuad,
  thinTrack,
  trackRuns,
  trackStart,
  trackTimes,
} from '../utils/video/tracking';
import { getOrientedDimensions } from '../utils/cropUtils';
import { errorText, showError } from '../utils/errors';
import { Adjustments, MaskContainer } from '../utils/adjustments';
import { SubMask } from '../types/masks';
import {
  ResolvedFollow,
  TrackRegion,
  TrackedContainer,
  VIDEO_AI_MASKS,
  boundsRegion,
  extendPlane,
  extendTrack,
  invertSimilarity,
  isPlanar,
  mapParameters,
  mapPoint,
  maskWarp,
  planeAt,
  planeWarp,
  regionBounds,
  resolveFollows,
  trackAreaAt,
  trackSimilarity,
  trackingRegion,
} from '../utils/video/maskTracking';
import {
  Homography,
  boundsQuad,
  invert,
  isConvex,
  localScale,
  mapQuad,
  project as projectPoint,
  quadBounds,
  quadCenter,
  scaleQuad,
} from '../utils/video/planar';
import {
  editItemLook,
  editProject,
  editorClipAt,
  getVideo,
  isCancelled,
  refreshLook,
  useVideoStore,
} from './useVideoStore';
import { playbackRange } from './videoPlayback';
import { hideLayer, requestProgramFrame } from './videoView';
import { restoreTimelapses } from './videoTimelapse';

export type StabilizeLevel = 'off' | 'minimal' | 'recommended' | 'strong';
export const STABILIZE_LEVELS: Array<StabilizeLevel> = ['off', 'minimal', 'recommended', 'strong'];
const STRENGTHS: Record<StabilizeLevel, number> = { off: 0, minimal: 0.34, recommended: 0.67, strong: 1 };
const STATUS_POLL_MS = 150;
const REGION_SHARE = 0.2;
const AREA_PADDING = 0.25;
const MIN_AREA_PADDING = 0.04;

export type AnalysisState =
  { state: 'none' } | { state: 'running'; progress: number } | { state: 'failed' } | { state: 'ready' };

export const stabilizeLevelOf = (clip: ClipItem): StabilizeLevel => {
  const strength = clip.stabilize?.strength ?? 0;
  if (strength <= 0) return 'off';
  return STABILIZE_LEVELS.reduce((best, level) =>
    Math.abs(STRENGTHS[level] - strength) < Math.abs(STRENGTHS[best] - strength) ? level : best,
  );
};

type CachedWork = 'analysis' | 'reversed';

const WORK_COMMANDS: Record<CachedWork, { start: Invokes; status: Invokes }> = {
  analysis: { start: Invokes.VideoStabilize, status: Invokes.VideoStabilizeStatus },
  reversed: { start: Invokes.VideoReverse, status: Invokes.VideoReverseStatus },
};

interface MotionState {
  analysis: Record<string, AnalysisState>;
  reversed: Record<string, AnalysisState>;
  placing: { itemId: string; region: Region; quad: Quad } | null;
  tracking: { key: string; progress: number } | null;
  trackError: { key: string; message: string } | null;
  trackDirection: TrackDirection;
  trackKind: TrackKind;
  snaps: Array<[number, number]>;
  aiFollow: Record<string, number>;
  aiEpoch: number;
  followEpoch: number;
}

export const useVideoMotion = create<MotionState>(() => ({
  analysis: {},
  reversed: {},
  placing: null,
  tracking: null,
  trackError: null,
  trackDirection: 'both',
  trackKind: 'position',
  snaps: [],
  aiFollow: {},
  aiEpoch: 0,
  followEpoch: 0,
}));

const setMotion = (update: Partial<MotionState>) => useVideoMotion.setState(update);

useVideoMotion.subscribe(({ placing }) => hideLayer(placing?.itemId ?? null));

const polling = new Set<string>();
let cancelled = false;

const setWorkState = (work: CachedWork, path: string, state: AnalysisState) =>
  useVideoMotion.setState((current) => ({ [work]: { ...current[work], [path]: state } }));

const pollWork = async (work: CachedWork, path: string) => {
  const key = `${work}:${path}`;
  if (polling.has(key)) return;
  polling.add(key);
  try {
    for (;;) {
      const states = await invoke<Record<string, AnalysisState>>(WORK_COMMANDS[work].status, { paths: [path] });
      const state = states[path] ?? { state: 'none' };
      setWorkState(work, path, state);
      if (state.state !== 'running') {
        if (state.state === 'ready') void requestProgramFrame();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_MS));
    }
  } catch (error) {
    console.error(error);
  } finally {
    polling.delete(key);
  }
};

const startWork = (work: CachedWork, paths: Array<string>) =>
  invoke(WORK_COMMANDS[work].start, { paths })
    .catch(console.error)
    .finally(() => paths.forEach((path) => void pollWork(work, path)));

export const watchAnalysis = (path: string) => void pollWork('analysis', path);

export const prepareReverse = (paths: Array<string>) => void startWork('reversed', paths);

export const reversedPaths = (project: VideoProject) =>
  [
    ...new Set(
      allTimelines(project)
        .flatMap(allItems)
        .flatMap((item) => {
          const reversed = (item.type === 'clip' && !item.freeze) || item.type === 'audio' ? item.reverse : false;
          const media = reversed && 'media' in item ? mediaOf(project, item.media) : null;
          return media?.kind === 'video' ? [media.path] : [];
        }),
    ),
  ].sort();

const stabilizedPaths = (project: VideoProject) => [
  ...new Set(
    allTimelines(project)
      .flatMap((timeline) => timeline.videoTracks)
      .flatMap((track) => track.items)
      .flatMap((item) => {
        const media = item.type === 'clip' && item.stabilize ? mediaOf(project, item.media) : null;
        return media?.kind === 'video' ? [media.path] : [];
      }),
  ),
];

export type VideoCachePart = 'proxies' | 'reversed' | 'analysis' | 'timelapses';

export const restoreAfterCacheClear = (part: VideoCachePart) => {
  const { project } = getVideo();
  if (part === 'reversed') {
    setMotion({ reversed: {} });
    if (project) prepareReverse(reversedPaths(project));
  }
  if (part === 'analysis') {
    useVideoMotion.setState(({ aiEpoch }) => ({ analysis: {}, aiEpoch: aiEpoch + 1 }));
    void requestProgramFrame();
    const paths = project ? stabilizedPaths(project) : [];
    if (paths.length > 0) void startWork('analysis', paths);
  }
  if (part === 'timelapses') restoreTimelapses();
};

export const setStabilizeLevel = (clipId: string, path: string, level: StabilizeLevel) => {
  editProject((project) =>
    updateItem<ClipItem>(project, clipId, (clip) => ({
      ...clip,
      stabilize: level === 'off' ? null : { strength: STRENGTHS[level] },
    })),
  );
  if (level === 'off') return;
  setWorkState('analysis', path, { state: 'running', progress: 0 });
  void startWork('analysis', [path]);
};

export const setClipReversed = (clipId: string, path: string, reverse: boolean) => {
  editProject((project) => setClipReverse(project, clipId, reverse));
  if (reverse) prepareReverse([path]);
};

interface ClipSpace {
  media: string;
  sourceTime: number;
  source: [number, number];
  canvas: Homography;
  anchor: Homography;
  frame: Homography;
  frameSize: [number, number];
  mirrored: boolean;
}

interface FrameGeometry {
  clips: Record<string, ClipSpace>;
  follows: Record<string, ResolvedFollow>;
}

const frameGeometry = (project: VideoProject, time: Ticks) =>
  withRevision(project, (revision) =>
    invoke<FrameGeometry>(Invokes.VideoGeometry, { request: { revision, time: ticksToSeconds(time) } }),
  );

const clipSpace = async (project: VideoProject, clip: ClipItem, time: Ticks) =>
  (await frameGeometry(project, time)).clips[clip.id] ?? null;

const canvasScale = (space: ClipSpace, [x, y]: [number, number]) =>
  localScale(space.canvas, x, y) / Math.sqrt(space.source[0] * space.source[1]);

const anchoredTracks = (project: VideoProject, time: Ticks): Array<[string, MotionTrack]> =>
  visualItemsAt(project, time).flatMap(({ item }): Array<[string, MotionTrack]> => {
    if ('transform' in item && item.transform.track?.anchor) return [[item.id, item.transform.track]];
    if (item.type !== 'adjustment') return [];
    return ((lookOf(project, item)?.masks ?? []) as Array<TrackedContainer>).flatMap(
      (container): Array<[string, MotionTrack]> =>
        container.track?.anchor ? [[maskKey(item.id, container.id), container.track]] : [],
    );
  });

let followsBusy = false;
let followsQueued = false;

const refreshFollows = async () => {
  if (followsBusy) {
    followsQueued = true;
    return;
  }
  followsBusy = true;
  try {
    do {
      followsQueued = false;
      const { project, playhead, isPlaying } = getVideo();
      const tracks = project && !isPlaying ? anchoredTracks(project, playhead) : [];
      if (!project || tracks.length === 0) continue;
      const { follows } = await frameGeometry(project, playhead);
      resolveFollows(
        tracks.flatMap(([key, track]): Array<[MotionTrack, ResolvedFollow]> =>
          follows[key] ? [[track, follows[key]]] : [],
        ),
      );
      useVideoMotion.setState(({ followEpoch }) => ({ followEpoch: followEpoch + 1 }));
    } while (followsQueued);
  } catch (error) {
    console.error(error);
  } finally {
    followsBusy = false;
  }
};

const clipBelow = (project: VideoProject, item: VisualItem, trackIndex: number, time: Ticks) => {
  const { media } = getVideo();
  return (
    visualItemsAt(project, time)
      .filter(
        (entry): entry is { item: ClipItem; trackIndex: number } =>
          entry.item.type === 'clip' && entry.item.id !== item.id && entry.trackIndex <= trackIndex,
      )
      .filter(({ item: clip }) => {
        const ref = mediaOf(project, clip.media);
        const info = ref ? media[ref.path] : undefined;
        return ref?.kind === 'video' && isMovingVideo(info);
      })
      .at(-1)?.item ?? null
  );
};

export const maskKey = (itemId: string, containerId: string) => `${itemId}:${containerId}`;

interface TrackSpan {
  start: Ticks;
  first: Ticks;
  end: Ticks;
}

const playedRange = (project: VideoProject): [Ticks, Ticks] | null =>
  getVideo().session?.kind === 'clip'
    ? playbackRange()
    : project.range
      ? [project.range.start, project.range.end]
      : null;

const playedSpan = (project: VideoProject, start: Ticks, first: Ticks, end: Ticks): TrackSpan => {
  const range = playedRange(project);
  if (!range || start < range[0] || start >= range[1]) return { start, first, end };
  return { start, first: Math.max(first, range[0]), end: Math.min(end, range[1]) };
};

const clipPlayedSpan = (project: VideoProject, clip: ClipItem) => {
  const range = playedRange(project);
  const start =
    range && range[0] < itemEnd(clip) && range[1] > clip.start ? Math.max(clip.start, range[0]) : clip.start;
  return playedSpan(project, start, clip.start, itemEnd(clip));
};

const setAiFollow = (key: string, progress: number | null) =>
  useVideoMotion.setState(({ aiFollow }) => {
    const { [key]: _done, ...rest } = aiFollow;
    return { aiFollow: progress === null ? rest : { ...rest, [key]: progress } };
  });

const followsVideo = (container: MaskContainer) =>
  container.subMasks.some((subMask) => VIDEO_AI_MASKS.includes(subMask.type));

type FollowSpan = [reference: number, first: number, last: number];

interface FollowResult {
  sequence: string;
  followSpan: FollowSpan;
}

const followSpanOf = (subMask: SubMask): FollowSpan | null => {
  const span = subMask.parameters?.followSpan;
  return Array.isArray(span) && span.length === 3 ? (span as FollowSpan) : null;
};

const followedSubMasks = (container: MaskContainer) =>
  container.subMasks.filter((subMask) => VIDEO_AI_MASKS.includes(subMask.type) && !!subMask.parameters?.sequence);

export const withSequences = (subMasks: Array<SubMask>, results: Map<string, FollowResult>) =>
  subMasks.map((subMask) => {
    const result = results.get(subMask.id);
    return result ? { ...subMask, parameters: { ...subMask.parameters, ...result } } : subMask;
  });

export const unfollowSubMask = (subMask: SubMask): SubMask => {
  if (!subMask.parameters?.sequence) return subMask;
  const { sequence: _sequence, followSpan: _followSpan, ...parameters } = subMask.parameters;
  return { ...subMask, parameters };
};

const followTimes = (project: VideoProject, clip: ClipItem, sourceFps: number, span: TrackSpan) => {
  const fps = project.settings.fps;
  const times: Array<number> = [];
  for (let time = span.first; time < span.end; time += frameTicks(fps)) {
    times.push(ticksToSeconds(frameSourceTime(clip, time, fps, sourceFps)));
  }
  return times;
};

const coversClip = (project: VideoProject, clip: ClipItem, sourceFps: number, subMasks: Array<SubMask>) => {
  const fps = project.settings.fps;
  const span = clipPlayedSpan(project, clip);
  const count = Math.ceil((span.end - span.first) / frameTicks(fps));
  if (count <= 0) return true;
  const edges = [span.first, span.first + (count - 1) * frameTicks(fps)].map((time) =>
    ticksToSeconds(frameSourceTime(clip, time, fps, sourceFps)),
  );
  const slack = 0.5 / Math.max(sourceFps, 1);
  return subMasks.every((subMask) => {
    const followed = followSpanOf(subMask);
    return !followed || (followed[1] <= Math.min(...edges) + slack && followed[2] >= Math.max(...edges) - slack);
  });
};

export const followsPlayedFrames = (container: MaskContainer) => {
  const { project, media } = getVideo();
  const clip = maskClip();
  const ref = project && clip ? mediaOf(project, clip.media) : null;
  const info = ref ? media[ref.path] : undefined;
  return !project || !clip || !isMovingVideo(info) || coversClip(project, clip, info.fps, followedSubMasks(container));
};

const runFollow = async (
  key: string,
  path: string,
  subMasks: Array<SubMask>,
  times: Array<number>,
  referenceOf: (subMask: SubMask) => number,
) => {
  const results = new Map<string, FollowResult>();
  if (times.length === 0) return results;
  const first = times.reduce((low, time) => Math.min(low, time), Infinity);
  const last = times.reduce((high, time) => Math.max(high, time), -Infinity);
  setAiFollow(key, 0);
  try {
    for (const subMask of subMasks) {
      if (!VIDEO_AI_MASKS.includes(subMask.type)) continue;
      const reference = referenceOf(subMask);
      const onProgress = new Channel<number>();
      onProgress.onmessage = (progress) => setAiFollow(key, progress);
      const sequence = await invoke<string>(Invokes.VideoAiMaskSequence, {
        request: { path, kind: subMask.type, times, reference, parameters: unfollowSubMask(subMask).parameters },
        onProgress,
      });
      results.set(subMask.id, { sequence, followSpan: [reference, first, last] });
    }
    return results;
  } finally {
    setAiFollow(key, null);
  }
};

export const followAiMasks = async (
  itemId: string,
  container: MaskContainer,
  apply: (results: Map<string, FollowResult>) => void,
) => {
  const { project, playhead, media } = getVideo();
  const clip = project ? locateItem(project, itemId)?.item : null;
  const ref = project && clip?.type === 'clip' ? mediaOf(project, clip.media) : null;
  const info = ref ? media[ref.path] : undefined;
  if (!project || clip?.type !== 'clip' || ref?.kind !== 'video' || !isMovingVideo(info))
    throw new Error(i18n.t('video.tracking.noClip'));
  if (!followsVideo(container)) return;
  const fps = project.settings.fps;
  const span = playedSpan(project, trackStart(clip, playhead, fps), clip.start, itemEnd(clip));
  const reference = ticksToSeconds(frameSourceTime(clip, span.start, fps, info.fps));
  const times = followTimes(project, clip, info.fps, span);
  apply(await runFollow(maskKey(itemId, container.id), ref.path, container.subMasks, times, () => reference));
};

interface FollowGap {
  key: string;
  jobKey: string;
  lookId: string;
  containerId: string;
  path: string;
  subMasks: Array<SubMask>;
  times: Array<number>;
}

const followGaps = (project: VideoProject, media: Record<string, MediaInfo>): Array<FollowGap> => {
  const users = new Map<string, Array<ClipItem>>();
  allItems(project).forEach((item) => {
    if (item.type === 'clip' && item.look) users.set(item.look, [...(users.get(item.look) ?? []), item]);
  });
  return [...users].flatMap(([lookId, clips]) => {
    const ref = mediaOf(project, clips[0].media);
    const info = ref ? media[ref.path] : undefined;
    if (
      ref?.kind !== 'video' ||
      !isMovingVideo(info) ||
      clips.some((clip) => clip.media !== clips[0].media) ||
      lookUsers(project, lookId).length !== clips.length
    )
      return [];
    return (project.looks[lookId]?.masks ?? []).flatMap((container) => {
      const subMasks = followedSubMasks(container).filter((subMask) => followSpanOf(subMask));
      const missing = clips.find((clip) => !coversClip(project, clip, info.fps, subMasks));
      if (subMasks.length === 0 || !missing) return [];
      const times = clips.flatMap((clip) => followTimes(project, clip, info.fps, clipPlayedSpan(project, clip)));
      return [
        {
          key: `${lookId}:${container.id}:${times.length}:${times[0]}:${times.at(-1)}`,
          jobKey: maskKey(missing.id, container.id),
          lookId,
          containerId: container.id,
          path: ref.path,
          subMasks,
          times,
        },
      ];
    });
  });
};

const EXTEND_DELAY_MS = 1000;
const attemptedFollows = new Set<string>();
let extendTimer: ReturnType<typeof setTimeout> | undefined;

const motionBusy = ({ tracking, aiFollow }: MotionState) => tracking !== null || Object.keys(aiFollow).length > 0;

const extendAiFollows = async () => {
  const { project, session, media } = getVideo();
  if (!project || session?.kind !== 'project' || motionBusy(useVideoMotion.getState())) return;
  const gap = followGaps(project, media).find((candidate) => !attemptedFollows.has(candidate.key));
  if (!gap) return;
  attemptedFollows.add(gap.key);
  const started = new Map(gap.subMasks.map((subMask) => [subMask.id, subMask.parameters.sequence]));
  try {
    const results = await runFollow(
      gap.jobKey,
      gap.path,
      gap.subMasks,
      gap.times,
      (subMask) => followSpanOf(subMask)?.[0] ?? 0,
    );
    refreshLook(gap.lookId, (look) => ({
      ...look,
      masks: (look.masks ?? []).map((mask) =>
        mask.id === gap.containerId
          ? {
              ...mask,
              subMasks: withSequences(
                mask.subMasks,
                new Map(
                  [...results].filter(([id]) =>
                    mask.subMasks.some(
                      (subMask) => subMask.id === id && subMask.parameters?.sequence === started.get(id),
                    ),
                  ),
                ),
              ),
            }
          : mask,
      ),
    }));
  } catch (err) {
    if (!isCancelled(err)) showError('video.toasts.aiMasksFailed', err, { retry: () => void extendAiFollows() });
  }
};

const scheduleFollowExtension = () => {
  clearTimeout(extendTimer);
  extendTimer = setTimeout(() => void extendAiFollows(), EXTEND_DELAY_MS);
};

let watchingFollows = false;

export const watchFollows = () => {
  if (watchingFollows) return;
  watchingFollows = true;
  useVideoStore.subscribe((state, prev) => {
    if (state.project !== prev.project || state.media !== prev.media) scheduleFollowExtension();
    if (state.project !== prev.project || state.playhead !== prev.playhead || state.isPlaying !== prev.isPlaying)
      void refreshFollows();
  });
  useVideoMotion.subscribe((state, prev) => {
    if (motionBusy(prev) && !motionBusy(state)) scheduleFollowExtension();
  });
};

export const followPastedAiMasks = async (itemIds: Array<string>) => {
  for (const itemId of itemIds) {
    const { project, media } = getVideo();
    const clip = project ? locateItem(project, itemId)?.item : null;
    const ref = project && clip?.type === 'clip' ? mediaOf(project, clip.media) : null;
    if (!project || !clip || ref?.kind !== 'video' || media[ref.path]?.isStill) continue;
    const containers = (lookOf(project, clip)?.masks ?? []).filter(followsVideo);
    for (const container of containers) {
      try {
        await followAiMasks(itemId, container, (sequences) =>
          editItemLook(itemId, (look) => ({
            ...look,
            masks: (look.masks ?? []).map((mask) =>
              mask.id === container.id ? { ...mask, subMasks: withSequences(mask.subMasks, sequences) } : mask,
            ),
          })),
        );
      } catch (err) {
        if (!isCancelled(err))
          showError('video.toasts.aiMasksFailed', err, { retry: () => void followPastedAiMasks([itemId]) });
      }
    }
  }
};

export const setTrackDirection = (trackDirection: TrackDirection) => setMotion({ trackDirection });

let detected: { key: string; points: Promise<Array<[number, number]>> } | null = null;

const detectedCorners = (path: string, time: number) => {
  const key = `${path}:${time}`;
  if (detected?.key === key) return detected.points;
  const points = invoke<Array<[number, number]>>(Invokes.VideoTrackCorners, { path, time });
  detected = { key, points };
  points.catch(() => {
    if (detected?.points === points) detected = null;
  });
  return points;
};

const cornersAt = async (project: VideoProject, clip: ClipItem, time: Ticks) => {
  const ref = mediaOf(project, clip.media);
  const info = ref ? getVideo().media[ref.path] : undefined;
  if (!ref || !info) return null;
  const [space, points] = await Promise.all([
    clipSpace(project, clip, time),
    detectedCorners(ref.path, ticksToSeconds(frameSourceTime(clip, time, project.settings.fps, info.fps))),
  ]);
  return space && { space, points };
};

const projectPoints = (map: Homography, points: Array<[number, number]>) =>
  points.flatMap(([x, y]): Array<[number, number]> => {
    const point = projectPoint(map, x, y);
    return point ? [point] : [];
  });

const loadSnaps = async (itemId: string) => {
  const { project, playhead } = getVideo();
  const location = project ? locateItem(project, itemId) : null;
  if (!project || !location || location.item.type === 'audio' || location.item.type === 'adjustment') return;
  const start = trackStart(location.item, playhead, project.settings.fps);
  const clip = clipBelow(project, location.item, location.trackIndex, start);
  if (!clip) return;
  try {
    const found = await cornersAt(project, clip, start);
    if (!found || useVideoMotion.getState().placing?.itemId !== itemId) return;
    setMotion({ snaps: projectPoints(found.space.canvas, found.points) });
  } catch (error) {
    console.error(error);
  }
};

export const setTrackKind = (trackKind: TrackKind) => {
  const { placing, snaps } = useVideoMotion.getState();
  setMotion({ trackKind, trackError: null });
  if (trackKind === 'planar' && placing && snaps.length === 0) void loadSnaps(placing.itemId);
};

export const startTrackingPlacement = (itemId: string) => {
  const { project, playhead } = getVideo();
  const location = project ? locateItem(project, itemId) : null;
  if (!project || !location || location.item.type === 'adjustment' || !('transform' in location.item)) return;
  const item = location.item;
  const { width, height } = project.settings;
  const time = clampIntoItem(item, playhead);
  const side = Math.min(width, height) * REGION_SHARE;
  const local = time - item.start;
  const placed = placementAt(item.transform, local, width, height);
  const region = { x: placed.x - side / 2, y: placed.y - side / 2, width: side, height: side };
  const planar = isPlanar(item.transform.track) || !!item.transform.pin;
  const trackKind = planar ? 'planar' : useVideoMotion.getState().trackKind;
  setMotion({
    trackError: null,
    trackKind,
    snaps: [],
    placing: {
      itemId,
      region,
      quad:
        planeAt(item.transform.track, ticksToSeconds(local), width, height) ??
        pinnedQuad(item.transform, local, width, height) ??
        regionQuad(region),
    },
  });
  if (trackKind === 'planar') void loadSnaps(itemId);
};

export const setTrackingRegion = (region: Region) =>
  useVideoMotion.setState(({ placing }) => (placing ? { placing: { ...placing, region } } : {}));

export const setTrackingQuad = (quad: Quad) =>
  useVideoMotion.setState(({ placing }) => (placing ? { placing: { ...placing, quad } } : {}));

export const cancelJob = () => {
  cancelled = true;
  return invoke(Invokes.VideoCancelTrack).catch(console.error);
};

export const cancelTracking = () => {
  if (useVideoMotion.getState().tracking) void cancelJob();
  else setMotion({ placing: null, trackError: null, snaps: [] });
};

interface TrackPlan {
  clip: ClipItem;
  path: string;
  span: TrackSpan;
  region: { cx: number; cy: number; width: number; height: number };
  quad?: Quad;
  lost: string;
  apply(samples: Array<[Ticks, TrackSample]>): void;
}

const trackClipRegion = async (
  plan: TrackPlan,
  fps: FrameRate,
  onProgress: (fraction: number) => void,
): Promise<Array<[Ticks, TrackSample]>> => {
  const tracked = new Map<Ticks, TrackSample>();
  const sourceFps = getVideo().media[plan.path]?.fps;
  const runs = trackRuns(useVideoMotion.getState().trackDirection);
  const maxGap = maxTrackGap(fpsValue(fps));
  for (const [runIndex, run] of runs.entries()) {
    const times = trackTimes(plan.span.start, plan.span.first, plan.span.end, frameTicks(fps), run);
    if (times.length < 2) continue;
    if (cancelled) throw new Error('Tracking cancelled');
    const channel = new Channel<number>();
    channel.onmessage = (progress) => onProgress((runIndex + progress) / runs.length);
    const samples = await invoke<Array<TrackSample | null>>(Invokes.VideoTrack, {
      request: {
        path: plan.path,
        region: plan.region,
        quad: plan.quad,
        times: times.map((time) => ticksToSeconds(frameSourceTime(plan.clip, time, fps, sourceFps))),
        maxGap,
      },
      onProgress: channel,
    });
    keptSamples(samples, maxGap).forEach(([index, sample]) => tracked.set(times[index], sample));
  }
  return [...tracked.entries()].sort(([a], [b]) => a - b);
};

const runTrack = async (key: string, planned: Promise<TrackPlan | string>) => {
  const plan = await planned.catch(errorText);
  const { project } = getVideo();
  if (!project) return false;
  if (typeof plan === 'string') {
    setMotion({ trackError: { key, message: plan } });
    return false;
  }
  cancelled = false;
  setMotion({ tracking: { key, progress: 0 }, trackError: null });
  try {
    const samples = await trackClipRegion(plan, project.settings.fps, (progress) =>
      setMotion({ tracking: { key, progress } }),
    );
    if (samples.length < 2) throw new Error(plan.lost);
    plan.apply(samples);
    void requestProgramFrame();
    return true;
  } catch (error) {
    const message = errorText(error);
    if (!cancelled && !isCancelled(error)) setMotion({ trackError: { key, message } });
    return false;
  } finally {
    setMotion({ tracking: null });
  }
};

export const TRACKED_CHANNELS = ['x', 'y', 'scale', 'rotation'] as const;

const sourceSeconds = (project: VideoProject, clip: ClipItem, info: MediaInfo) => (time: Ticks) =>
  ticksToSeconds(frameSourceTime(clip, time, project.settings.fps, info.fps));

const fromCanvas = (space: ClipSpace, quad: Quad) => {
  const inverse = invert(space.canvas);
  return inverse && mapQuad(inverse, quad);
};

const anchorOf = (clip: ClipItem, space: ClipSpace, previous: MotionTrack | null) =>
  previous?.anchor ?? { clip: clip.id, media: clip.media, canvas: space.anchor };

const sameSource = (track: MotionTrack | null | undefined, clip: ClipItem) =>
  track?.anchor?.media === clip.media ? track : null;

const canvasPlan = async (
  project: VideoProject,
  item: VisualItem,
  trackIndex: number,
  start: Ticks,
  region: Region,
  radius: number,
  previous: MotionTrack | null | undefined,
  lost: string,
  apply: (track: MotionTrack) => void,
): Promise<TrackPlan | string> => {
  const { media } = getVideo();
  const clip = clipBelow(project, item, trackIndex, start);
  const ref = clip ? mediaOf(project, clip.media) : null;
  const info = ref ? media[ref.path] : undefined;
  if (!clip || !ref || !info) return i18n.t('video.tracking.noClip');
  const space = await clipSpace(project, clip, start);
  const source = space && fromCanvas(space, regionQuad(region));
  if (!space || !source) return i18n.t('video.tracking.noClip');
  const bounds = quadBounds(source);
  const center: [number, number] = [(bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2];
  const [width, height] = space.source;
  const scale = canvasScale(space, center);
  const base = sameSource(previous, clip);
  const timeOf = sourceSeconds(project, clip, info);
  return {
    clip,
    path: ref.path,
    span: playedSpan(project, start, Math.max(item.start, clip.start), Math.min(itemEnd(item), itemEnd(clip))),
    region: { cx: center[0], cy: center[1], width: bounds.right - bounds.left, height: bounds.bottom - bounds.top },
    lost,
    apply: (samples) => {
      const keys = samples.map(([time, sample]): TrackKey => ({
        time: timeOf(time),
        x: sample.cx,
        y: sample.cy,
        scale: sample.scale,
        rotation: sample.rotation,
      }));
      const track = extendTrack(
        base,
        timeOf(start),
        { x: center[0] * width, y: center[1] * height },
        keys,
        width,
        height,
        (kept) => thinTrack(kept, [width * scale, height * scale, radius, radius]),
      );
      apply({ ...track, anchor: anchorOf(clip, space, base) });
    },
  };
};

const planeTarget = (quad: Quad) => ({ region: boundsRegion(quadBounds(quad), 1, 1), quad });

const planePlan = async (
  project: VideoProject,
  item: VisualItem,
  trackIndex: number,
  start: Ticks,
  quad: Quad,
  previous: MotionTrack | null | undefined,
  lost: string,
  apply: (track: MotionTrack) => void,
): Promise<TrackPlan | string> => {
  const { media } = getVideo();
  const clip = clipBelow(project, item, trackIndex, start);
  const ref = clip ? mediaOf(project, clip.media) : null;
  const info = ref ? media[ref.path] : undefined;
  if (!clip || !ref || !info) return i18n.t('video.tracking.noClip');
  if (!isConvex(quad)) return i18n.t('video.tracking.notConvex');
  const space = await clipSpace(project, clip, start);
  const source = space && fromCanvas(space, quad);
  if (!space || !source) return i18n.t('video.tracking.noClip');
  const [width, height] = space.source;
  const scale = canvasScale(space, quadCenter(source));
  const side = Math.hypot(width, height) * scale;
  const base = sameSource(previous, clip);
  const timeOf = sourceSeconds(project, clip, info);
  return {
    clip,
    path: ref.path,
    span: playedSpan(project, start, Math.max(item.start, clip.start), Math.min(itemEnd(item), itemEnd(clip))),
    ...planeTarget(source),
    lost,
    apply: (samples) => {
      const keys = samples.flatMap(([time, sample]) =>
        sample.corners ? [{ time: timeOf(time), corners: sample.corners }] : [],
      );
      const track = extendPlane(base && isPlanar(base) ? base : null, timeOf(start), keys, width, height, (kept) =>
        thinTrack(kept, [width * scale, height * scale, side / 2, side / 2]),
      );
      apply({ ...track, anchor: anchorOf(clip, space, base && isPlanar(base) ? base : null) });
    },
  };
};

const layerPlan = async (itemId: string): Promise<TrackPlan | string> => {
  const { project, playhead, media } = getVideo();
  const { placing, trackKind } = useVideoMotion.getState();
  const location = project ? locateItem(project, itemId) : null;
  const item = location?.item;
  if (!project || !location || !placing || !item || item.type === 'adjustment' || item.type === 'audio')
    return i18n.t('video.tracking.noClip');
  const { width, height } = project.settings;
  const start = trackStart(item, playhead, project.settings.fps);
  const previous = item.transform.track;
  const positionOnly = previous?.keys.length && !previous.reframe ? !!previous.positionOnly : true;
  const apply = (track: MotionTrack) => {
    editProject((current) =>
      updateItem<VisualItem>(current, item.id, (target) =>
        'transform' in target
          ? ({ ...target, transform: { ...target.transform, track: { ...track, positionOnly } } } as VisualItem)
          : target,
      ),
    );
    setMotion({ placing: null, snaps: [] });
  };
  if (trackKind === 'planar')
    return planePlan(
      project,
      item,
      location.trackIndex,
      start,
      placing.quad,
      previous,
      i18n.t('video.motion.lost'),
      apply,
    );
  const size = contentSize(project, item, media);
  const scale = placementAt(item.transform, start - item.start, width, height).scale;
  return canvasPlan(
    project,
    item,
    location.trackIndex,
    start,
    placing.region,
    (Math.hypot(size.width, size.height) / 2) * scale,
    previous,
    i18n.t('video.motion.lost'),
    apply,
  );
};

const layerQuad = (project: VideoProject, item: VisualItem, local: Ticks, media: Record<string, MediaInfo>): Quad => {
  const { width, height } = project.settings;
  const size = contentSize(project, item, media);
  const placed = placementAt((item as ClipItem).transform, local, width, height);
  const angle = (placed.rotation * Math.PI) / 180;
  const corner = (sx: number, sy: number): [number, number] => {
    const dx = (sx * size.width * placed.scale) / 2;
    const dy = (sy * size.height * placed.scale) / 2;
    return [
      placed.x + dx * Math.cos(angle) - dy * Math.sin(angle),
      placed.y + dx * Math.sin(angle) + dy * Math.cos(angle),
    ];
  };
  return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
};

const pinUnwarp = (item: VisualItem, local: Ticks, width: number, height: number) => {
  if (!('transform' in item)) return null;
  const warp: Homography | null = planeWarp(item.transform.track, ticksToSeconds(local), width, height);
  const inverse = warp && invert(warp);
  if (inverse) return (quad: Quad) => mapQuad(inverse, quad);
  const similarity = trackSimilarity(item.transform.track, ticksToSeconds(local), width, height);
  if (!similarity) return (quad: Quad) => quad;
  const back = invertSimilarity(similarity);
  return (quad: Quad) =>
    quad.map(([x, y]) => {
      const point = mapPoint(back, x, y);
      return [point.x, point.y];
    }) as Quad;
};

export const setCornerPin = (itemId: string, enabled: boolean) => {
  const { playhead, media } = getVideo();
  editProject((project) =>
    updateItem<VisualItem>(project, itemId, (item) => {
      if (!('transform' in item)) return item;
      if (!enabled) return { ...item, transform: { ...item.transform, pin: null } } as VisualItem;
      const { width, height } = project.settings;
      const local = clampIntoItem(item, playhead) - item.start;
      const corners = pinUnwarp(item, local, width, height)?.(layerQuad(project, item, local, media));
      return corners
        ? ({ ...item, transform: { ...item.transform, pin: scaleQuad(corners, 1 / width, 1 / height) } } as VisualItem)
        : item;
    }),
  );
};

export const editPin = (itemId: string, quad: Quad, mergeKey: string) => {
  const { playhead } = getVideo();
  editProject(
    (project) =>
      updateItem<VisualItem>(project, itemId, (item) => {
        if (!('transform' in item) || !item.transform.pin) return item;
        const { width, height } = project.settings;
        const corners = pinUnwarp(item, clampIntoItem(item, playhead) - item.start, width, height)?.(quad);
        return corners
          ? ({
              ...item,
              transform: { ...item.transform, pin: scaleQuad(corners, 1 / width, 1 / height) },
            } as VisualItem)
          : item;
      }),
    mergeKey,
  );
};

export const pinToPlane = (itemId: string) =>
  editProject((project) =>
    updateItem<VisualItem>(project, itemId, (item) => {
      if (!('transform' in item) || !isPlanar(item.transform.track)) return item;
      const track = item.transform.track!;
      const corners = (track.reference ?? track.keys[0]).corners!;
      const pin = track.anchor ? mapQuad(track.anchor.canvas, corners) : corners;
      return pin ? ({ ...item, transform: { ...item.transform, pin } } as VisualItem) : item;
    }),
  );

export const trackLayer = (itemId: string) => runTrack(itemId, layerPlan(itemId));

export const maskClip = () => {
  const { project, playhead, editorItemId } = getVideo();
  if (!project) return null;
  const item = editorItemId ? locateItem(project, editorItemId)?.item : null;
  return item?.type === 'clip' ? item : editorClipAt(project, playhead);
};

const maskLayer = () => {
  const { project, editorItemId } = getVideo();
  const location = project && editorItemId ? locateItem(project, editorItemId) : null;
  return location?.item.type === 'adjustment' ? { item: location.item, trackIndex: location.trackIndex } : null;
};

export const maskItem = () => maskLayer()?.item ?? maskClip();

export const maskTrackKey = (containerId: string) => maskKey(maskItem()?.id ?? '', containerId);

let maskSnaps: { key: string; project: VideoProject; points: Array<[number, number]> } | null = null;

const maskSnapFrame = () => {
  const { project, playhead, media } = getVideo();
  if (!project) return null;
  const layer = maskLayer();
  if (layer) {
    const start = trackStart(layer.item, playhead, project.settings.fps);
    const clip = clipBelow(project, layer.item, layer.trackIndex, start);
    return clip && { key: `${layer.item.id}:${start}`, project, clip, start, onCanvas: true };
  }
  const clip = maskClip();
  const ref = clip ? mediaOf(project, clip.media) : null;
  if (!clip || ref?.kind !== 'video' || !isMovingVideo(media[ref.path])) return null;
  const start = trackStart(clip, playhead, project.settings.fps);
  return { key: `${clip.id}:${start}`, project, clip, start, onCanvas: false };
};

export const loadMaskSnaps = async () => {
  const frame = maskSnapFrame();
  if (!frame || (maskSnaps?.key === frame.key && maskSnaps.project === frame.project)) return;
  const { key, project } = frame;
  maskSnaps = { key, project, points: [] };
  try {
    const found = await cornersAt(project, frame.clip, frame.start);
    if (!found || maskSnaps?.key !== key || maskSnaps.project !== project) return;
    const { space } = found;
    const [width, height] = space.frameSize;
    maskSnaps = {
      key,
      project,
      points: frame.onCanvas
        ? projectPoints(space.anchor, found.points)
        : projectPoints(space.frame, found.points).map(([x, y]): [number, number] => [x / width, y / height]),
    };
  } catch (error) {
    console.error(error);
  }
};

export const maskSnapPoints = (width: number, height: number) => {
  const frame = maskSnapFrame();
  return frame && maskSnaps?.key === frame.key
    ? maskSnaps.points.map(([x, y]): [number, number] => [x * width, y * height])
    : [];
};

const shownSubMasks = (container: TrackedContainer, time: number, width: number, height: number) => {
  const warp = maskWarp(container.track, time, width, height);
  return warp
    ? container.subMasks.map((subMask) => ({
        ...subMask,
        parameters: mapParameters(subMask.type, subMask.parameters, warp),
      }))
    : container.subMasks;
};

interface TrackTarget {
  region: TrackRegion;
  quad: Quad;
}

const trackTarget = (
  container: TrackedContainer,
  time: number,
  width: number,
  height: number,
): TrackTarget | string => {
  const area = trackAreaAt(container, time, width, height);
  const region = area
    ? boundsRegion(quadBounds(area), width, height)
    : trackingRegion(shownSubMasks(container, time, width, height), width, height);
  if (!region) return i18n.t('video.maskTracking.noShape');
  const quad = area ?? scaleQuad(boundsQuad(regionBounds(region)), width, height);
  if (useVideoMotion.getState().trackKind === 'planar' && !isConvex(quad)) return i18n.t('video.tracking.notConvex');
  return { region, quad };
};

const sameKind = (track: MotionTrack | null | undefined) =>
  isPlanar(track) === (useVideoMotion.getState().trackKind === 'planar') ? track : null;

const layerMaskPlan = async (
  item: VisualItem,
  trackIndex: number,
  container: TrackedContainer,
  update: (track: MotionTrack) => void,
): Promise<TrackPlan | string> => {
  const { project, playhead } = getVideo();
  if (!project) return i18n.t('video.tracking.noClip');
  const { width, height } = project.settings;
  const start = trackStart(item, playhead, project.settings.fps);
  const target = trackTarget(container, ticksToSeconds(start - item.start), width, height);
  if (typeof target === 'string') return target;
  const lost = i18n.t('video.maskTracking.lost');
  const previous = sameKind(container.track);
  if (useVideoMotion.getState().trackKind === 'planar')
    return planePlan(project, item, trackIndex, start, target.quad, previous, lost, update);
  const { region } = target;
  const box = {
    x: (region.cx - region.width / 2) * width,
    y: (region.cy - region.height / 2) * height,
    width: region.width * width,
    height: region.height * height,
  };
  return canvasPlan(
    project,
    item,
    trackIndex,
    start,
    box,
    Math.hypot(box.width, box.height) / 2,
    previous,
    lost,
    update,
  );
};

const maskPlan = async (
  clip: ClipItem | null,
  container: TrackedContainer,
  update: (track: MotionTrack) => void,
): Promise<TrackPlan | string> => {
  const { project, playhead, media } = getVideo();
  const ref = project && clip ? mediaOf(project, clip.media) : null;
  const info = ref ? media[ref.path] : undefined;
  if (!project || !clip || ref?.kind !== 'video' || !isMovingVideo(info)) return i18n.t('video.tracking.noClip');
  const fps = project.settings.fps;
  const start = trackStart(clip, playhead, fps);
  const space = await clipSpace(project, clip, start);
  const toSource = space && invert(space.frame);
  if (!space || !toSource) return i18n.t('video.tracking.noClip');
  const [frameWidth, frameHeight] = space.frameSize;
  const timeOf = sourceSeconds(project, clip, info);
  const startSource = timeOf(start);
  const target = trackTarget(container, startSource, frameWidth, frameHeight);
  if (typeof target === 'string') return target;
  const { region } = target;
  const origin = { x: region.cx * frameWidth, y: region.cy * frameHeight };
  const source = mapQuad(toSource, scaleQuad(boundsQuad(regionBounds(region)), frameWidth, frameHeight));
  if (!source) return i18n.t('video.tracking.noClip');
  const bounds = quadBounds(source);
  const center: [number, number] = [(bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2];
  const scale = localScale(space.canvas, center[0], center[1]) / localScale(space.frame, center[0], center[1]);
  const radius = (Math.hypot(region.width * frameWidth, region.height * frameHeight) / 2) * scale;
  const previous = sameKind(container.track);
  const thin = (kept: Array<TrackKey>) => thinTrack(kept, [frameWidth * scale, frameHeight * scale, radius, radius]);
  const toFrame = (x: number, y: number): [number, number] | null => {
    const point = projectPoint(space.frame, x, y);
    return point && [point[0] / frameWidth, point[1] / frameHeight];
  };
  const plan = {
    clip,
    path: ref.path,
    span: playedSpan(project, start, clip.start, itemEnd(clip)),
    lost: i18n.t('video.maskTracking.lost'),
  };
  if (useVideoMotion.getState().trackKind === 'planar') {
    const quad = mapQuad(toSource, target.quad);
    if (!quad) return i18n.t('video.tracking.noClip');
    return {
      ...plan,
      ...planeTarget(quad),
      apply: (samples) => {
        const keys = samples.flatMap(([time, sample]) => {
          const corners = sample.corners?.map(([x, y]) => toFrame(x, y));
          return corners?.every(Boolean) ? [{ time: timeOf(time), corners: corners as Quad }] : [];
        });
        update(extendPlane(previous, startSource, keys, frameWidth, frameHeight, thin));
      },
    };
  }
  return {
    ...plan,
    region: { cx: center[0], cy: center[1], width: bounds.right - bounds.left, height: bounds.bottom - bounds.top },
    apply: (samples) => {
      const keys = samples.flatMap(([time, sample]): Array<TrackKey> => {
        const point = toFrame(sample.cx, sample.cy);
        return point
          ? [
              {
                time: timeOf(time),
                x: point[0],
                y: point[1],
                scale: sample.scale,
                rotation: space.mirrored ? -sample.rotation : sample.rotation,
              },
            ]
          : [];
      });
      update(extendTrack(previous, startSource, origin, keys, frameWidth, frameHeight, thin));
    },
  };
};

export const trackMask = (container: TrackedContainer, update: (track: MotionTrack) => void) => {
  const layer = maskLayer();
  return runTrack(
    maskTrackKey(container.id),
    layer ? layerMaskPlan(layer.item, layer.trackIndex, container, update) : maskPlan(maskClip(), container, update),
  );
};

const maskFrameSize = (look: Adjustments) => {
  const { project, media } = getVideo();
  if (!project) return null;
  if (maskLayer()) return { width: project.settings.width, height: project.settings.height };
  const clip = maskClip();
  const ref = clip ? mediaOf(project, clip.media) : null;
  const info = ref ? media[ref.path] : undefined;
  return info ? getOrientedDimensions(info.width, info.height, look.orientationSteps ?? 0) : null;
};

export const defaultTrackArea = (container: TrackedContainer, look: Adjustments): Quad => {
  const size = maskFrameSize(look) ?? { width: 1, height: 1 };
  const shortSide = Math.min(size.width, size.height);
  const side = shortSide * REGION_SHARE;
  const region = trackingRegion(container.subMasks, size.width, size.height) ?? {
    cx: 0.5,
    cy: 0.5,
    width: side / size.width,
    height: side / size.height,
  };
  const padding = (share: number, length: number) =>
    Math.max(share * length * AREA_PADDING, shortSide * MIN_AREA_PADDING) / length;
  const padX = padding(region.width, size.width);
  const padY = padding(region.height, size.height);
  const { left, top, right, bottom } = regionBounds(region);
  return boundsQuad({
    left: Math.max(0, left - padX),
    top: Math.max(0, top - padY),
    right: Math.min(1, right + padX),
    bottom: Math.min(1, bottom + padY),
  });
};

export const clearTrackError = () => setMotion({ trackError: null });
