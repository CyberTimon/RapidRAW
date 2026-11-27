import { Channel, invoke } from '@tauri-apps/api/core';
import debounce from 'lodash.debounce';
import { Invokes } from '../types/invokes';
import { ClipItem, PlaybackEvent, TICKS_PER_SECOND, Ticks, VideoProject } from '../types/video';
import { timelineAudio } from '../utils/video/audio';
import { rawJson, reuseLast, withRevision } from '../utils/video/revisions';
import {
  clipSettingsOf,
  identityTransform,
  itemEnd,
  locateItem,
  mainTrack,
  sequenceDuration,
  trimRange,
} from '../utils/video/model';
import { frameTicks, secondsToTicks, ticksToSeconds } from '../utils/video/time';
import { showError } from '../utils/errors';
import { Adjustments } from '../utils/adjustments';
import { debouncedSave, useEditorStore } from './useEditorStore';
import { useUIStore } from './useUIStore';
import { ViewerSource, playbackViewRequest, showsCrop, viewerSource, viewerSourceKey } from './videoView';
import {
  clampPlayhead,
  clipTrim,
  editProject,
  focusPlayhead,
  getVideo,
  isProjectSession,
  notifyFrameError,
  presentItem,
  setVideo,
  syncedEditorLook,
  useVideoStore,
} from './useVideoStore';

export const CLIP_LOOK = 'clip';

const PREPARE_DELAY_MS = 150;
const AUDIO_START_WAIT_MS = 300;
const SEEK_RESUME_MS = 100;

type AudioStart = (offset?: number) => Promise<void>;

let clock: { origin: number; start: Ticks } | null = null;
let clockEnd: Ticks = 0;
let loopFrom: Ticks | null = null;
let audioStart: Promise<AudioStart> | null = null;
let frameRequest = 0;
let inToOut = false;
let generation = 0;
let updating = false;
let updateQueued = false;
let followingEdits = false;
let updateSeq = 0;
let resumeTimer = 0;
let resumeWanted = false;
let resumeHeld = false;

const nextSeq = () => (updateSeq += 1);

const sendUpdate = (seq: number, update: object, revision?: number) =>
  invoke(Invokes.VideoUpdatePlayback, rawJson({ seq, ...update }), {
    headers: revision === undefined ? {} : { 'playback-revision': String(revision) },
  });

const updateFailed = (err: unknown) => showError('video.toasts.playbackFailed', err);

const playbackSource = (project: VideoProject) => viewerSource(project, true);

export const playbackRange = (): [Ticks, Ticks] => {
  const { project, session, loop } = getVideo();
  if (!project) return [0, 0];
  const end = sequenceDuration(project);
  if (session?.kind === 'clip') return trimRange(clipSettingsOf(clipTrim()), end);
  const source = playbackSource(project);
  if (source.kind === 'clip') return [source.clip.start, Math.min(itemEnd(source.clip), end)];
  const range = project.range;
  return range && (inToOut || loop) && range.start < end ? [range.start, Math.min(range.end, end)] : [0, end];
};

const clipView = reuseLast(
  (project: VideoProject, clip: ClipItem, look: Adjustments | null, muted: boolean, width: number, height: number) => ({
    ...project,
    settings: { ...project.settings, width, height },
    looks: look ? { [CLIP_LOOK]: look } : project.looks,
    videoTracks: [
      {
        ...(project.videoTracks.find((track) => track.items.some((item) => item.id === clip.id)) ??
          project.videoTracks[0]),
        hidden: false,
        items: [
          {
            ...clip,
            look: look ? CLIP_LOOK : clip.look,
            muted,
            transform: identityTransform(),
            fit: 'fill' as const,
            blend: 'normal' as const,
            cellAspect: undefined,
            stabilize: null,
            transitionIn: null,
            trackMatte: null,
            animIn: null,
            animOut: null,
            fadeIn: 0,
            fadeOut: 0,
          },
        ],
      },
    ],
    audioTracks: [],
    captions: null,
    range: null,
  }),
);

const editedPlayback = reuseLast((project: VideoProject, look: string, adjustments: Adjustments): VideoProject => ({
  ...project,
  looks: { ...project.looks, [look]: adjustments },
}));

export const playbackProject = (project: VideoProject): VideoProject => {
  const { session, editorItemId } = getVideo();
  const { adjustments } = useEditorStore.getState();
  const source = playbackSource(project);
  if (source.kind === 'clip') {
    const clipSession = session?.kind === 'clip';
    return clipView(
      project,
      source.clip,
      clipSession ? adjustments : null,
      clipSession ? !!clipTrim()?.muted : source.clip.muted,
      source.width,
      source.height,
    );
  }
  const item = editorItemId ? locateItem(project, editorItemId)?.item : null;
  if (!item || item.type !== 'clip' || !item.look || syncedEditorLook(item.id) === adjustments) return project;
  return editedPlayback(project, item.look, adjustments);
};

const playbackTimeline = async (project: VideoProject, end: Ticks, loopStart: Ticks | null) => ({
  endTime: ticksToSeconds(end),
  loopStart: loopStart === null ? null : ticksToSeconds(loopStart),
  view: await playbackViewRequest(project),
});

const playbackBlocked = () => !!getVideo().session && showsCrop(useUIStore.getState());

export const usePlaybackBlocked = () => {
  const session = useVideoStore((state) => !!state.session);
  const crop = useUIStore(showsCrop);
  return session && crop;
};

const finish = () => {
  pause();
  if (!getVideo().loop) return;
  const [start] = playbackRange();
  setVideo({ playhead: start });
  void startPlayback();
};

const syncClock = (time: number) => {
  clock = { origin: performance.now(), start: secondsToTicks(time) };
};

const confirmStart = async (time: number) => {
  const run = generation;
  const audio = audioStart;
  const ready = await Promise.race([
    audio?.catch(() => null) ?? null,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), AUDIO_START_WAIT_MS)),
  ]);
  if (run !== generation) return;
  syncClock(time);
  sendUpdate(nextSeq(), { started: true }).catch(updateFailed);
  if (ready) {
    void ready(0);
    return;
  }
  audio
    ?.then((start) => {
      if (run === generation && clock) void start((performance.now() - clock.origin) / 1000);
    })
    .catch(console.error);
};

const tick = () => {
  const { project, isPlaying, loop } = getVideo();
  if (!project || !isPlaying) return;
  if (clock) {
    const time = clock.start + Math.round(((performance.now() - clock.origin) / 1000) * TICKS_PER_SECOND);
    if (time < clockEnd) {
      setVideo({ playhead: time });
    } else if (loopFrom !== null && loop) {
      clock = { origin: clock.origin + ((clockEnd - clock.start) / TICKS_PER_SECOND) * 1000, start: loopFrom };
      setVideo({ playhead: loopFrom + time - clockEnd });
    } else {
      finish();
      return;
    }
  }
  frameRequest = requestAnimationFrame(tick);
};

const onPlaybackMessage = (message: PlaybackEvent) => {
  if (!getVideo().isPlaying) return;
  if (message.type === 'started') {
    void confirmStart(message.time);
  } else if (message.type === 'looped') {
    if (getVideo().loop) syncClock(message.time);
    else finish();
  } else if (message.type === 'clip') {
    if (isProjectSession()) void presentItem(message.itemId);
  } else if (message.type === 'ended') {
    finish();
  } else if (message.type === 'error') {
    pause();
    showError('video.toasts.playbackFailed', message.message, { retry: () => void startPlayback() });
  }
};

const followEdits = () => {
  if (followingEdits) return;
  followingEdits = true;
  useVideoStore.subscribe((state, prev) => {
    if (state.isPlaying && prev.isPlaying && state.project !== prev.project)
      queueMicrotask(() => void updatePlayback());
  });
  let shown: ViewerSource | null = null;
  const followView = () => {
    const { project, isPlaying } = getVideo();
    const source = project && isPlaying ? playbackSource(project) : null;
    const previous = shown;
    shown = source;
    if (!previous || !source || viewerSourceKey(previous) === viewerSourceKey(source)) return;
    const switchedClip = previous.kind === 'clip' && source.kind === 'clip' && previous.clip.id !== source.clip.id;
    queueMicrotask(switchedClip ? pause : restartPlayback);
  };
  useUIStore.subscribe(followView);
  useVideoStore.subscribe(followView);
  useEditorStore.subscribe(followView);
};

const startPlayback = async () => {
  followEdits();
  const { project, playhead, isPlaying, session, loop } = getVideo();
  if (!project || isPlaying || !session || playbackBlocked()) return;
  const [rangeStart, rangeEnd] = playbackRange();
  if (rangeEnd <= rangeStart) return;
  const nearEnd = playhead >= rangeEnd - frameTicks(project.settings.fps) * 1.5;
  const start = nearEnd || playhead < rangeStart ? rangeStart : playhead;
  debouncedSave.flush();
  prepareAtPlayhead.cancel();
  setVideo((state) => ({
    isPlaying: true,
    playhead: start,
    recordFrom: state.recordKeyframes ? start : state.recordFrom,
  }));
  clock = null;
  clockEnd = rangeEnd;
  loopFrom = loop ? rangeStart : null;
  const run = generation;
  try {
    const seq = nextSeq();
    const request = playbackProject(project);
    const loopStart = loopFrom === null ? null : ticksToSeconds(loopFrom);
    audioStart = timelineAudio.prime(request, ticksToSeconds(start), ticksToSeconds(rangeEnd), loopStart);
    const timeline = await playbackTimeline(request, rangeEnd, loopFrom);
    if (run !== generation) return;
    const onEvent = new Channel<PlaybackEvent>();
    onEvent.onmessage = (message) => {
      if (run === generation) onPlaybackMessage(message);
    };
    await withRevision(request, async (revision) => {
      if (run !== generation) return;
      await invoke(Invokes.VideoPlay, rawJson({ ...timeline, startTime: ticksToSeconds(start) }), {
        headers: {
          'playback-seq': String(seq),
          'playback-channel': onEvent.toJSON(),
          'playback-revision': String(revision),
        },
      });
    });
    if (run !== generation) return;
    frameRequest = requestAnimationFrame(tick);
    if (getVideo().project !== project) void updatePlayback();
  } catch (err) {
    if (run !== generation) return;
    setVideo({ isPlaying: false });
    timelineAudio.stop();
    showError('video.toasts.playbackFailed', err, { retry: () => void startPlayback() });
  }
};

const updatePlayback = async () => {
  if (updating) {
    updateQueued = true;
    return;
  }
  updating = true;
  try {
    do {
      updateQueued = false;
      const { project, isPlaying } = getVideo();
      if (!project || !isPlaying) break;
      const run = generation;
      const [rangeStart, rangeEnd] = playbackRange();
      const loopStart = loopFrom === null ? null : rangeStart;
      const seq = nextSeq();
      const request = playbackProject(project);
      const timeline = await playbackTimeline(request, rangeEnd, loopStart);
      if (run !== generation) break;
      clockEnd = rangeEnd;
      loopFrom = loopStart;
      timelineAudio.update(request, timeline.endTime, timeline.loopStart);
      await withRevision(request, (revision) => sendUpdate(seq, { timeline }, revision));
    } while (updateQueued);
  } catch (err) {
    updateFailed(err);
  } finally {
    updating = false;
  }
};

const scheduleResume = () => {
  window.clearTimeout(resumeTimer);
  resumeTimer = 0;
  if (!resumeWanted || resumeHeld) return;
  resumeTimer = window.setTimeout(() => {
    resumeTimer = 0;
    if (!resumeWanted || resumeHeld) return;
    resumeWanted = false;
    const { project, playhead } = getVideo();
    const [, end] = playbackRange();
    if (!project || playhead >= end - frameTicks(project.settings.fps) * 1.5) return;
    void startPlayback();
  }, SEEK_RESUME_MS);
};

export const continueAfterSeek = () => {
  resumeWanted = true;
  scheduleResume();
};

export const holdSeekResume = (held: boolean) => {
  resumeHeld = held;
  scheduleResume();
};

export const isResumingAfterSeek = () => resumeWanted;

export function pause() {
  resumeWanted = false;
  scheduleResume();
  if (!getVideo().isPlaying) return;
  generation += 1;
  cancelAnimationFrame(frameRequest);
  timelineAudio.stop();
  audioStart = null;
  clock = null;
  invoke(Invokes.VideoStop).catch(console.error);
  const { project, playhead } = getVideo();
  setVideo({
    isPlaying: false,
    playhead: project ? clampPlayhead(project, Math.min(playhead, clockEnd - 1)) : playhead,
  });
  void focusPlayhead();
}

const restartPlayback = () => {
  if (!getVideo().isPlaying) return;
  pause();
  void startPlayback();
};

export const play = () => {
  inToOut = false;
  return startPlayback();
};

export const togglePlay = () => (getVideo().isPlaying || resumeWanted ? pause() : void play());

export const playInToOut = () => {
  const { project } = getVideo();
  if (!project || playbackBlocked()) return;
  pause();
  inToOut = true;
  setVideo({ playhead: project.range?.start ?? 0 });
  void startPlayback();
};

export const editAudio = (update: (project: VideoProject) => VideoProject, mergeKey?: string) =>
  editProject(update, mergeKey, false);

export const toggleLoop = () => setVideo((state) => ({ loop: !state.loop }));

const preparePlayback = async () => {
  const { project, playhead, isPlaying, session } = getVideo();
  if (!project || isPlaying || !session) return;
  const request = playbackProject(project);
  const view = await playbackViewRequest(request);
  if (getVideo().isPlaying) return;
  await withRevision(request, (revision) =>
    invoke(Invokes.VideoPrepare, { request: { revision, time: ticksToSeconds(playhead), view } }),
  );
};

export const prepareAtPlayhead = debounce(() => {
  preparePlayback().catch(notifyFrameError);
}, PREPARE_DELAY_MS);

useUIStore.subscribe((state, prev) => {
  if (showsCrop(state) && !showsCrop(prev) && getVideo().isPlaying) pause();
});

useEditorStore.subscribe((state, prev) => {
  if (state.adjustments === prev.adjustments || !getVideo().isPlaying) return;
  const { session, editorItemId, project } = getVideo();
  if (session?.kind === 'clip' && state.adjustments.video !== prev.adjustments.video) void updatePlayback();
  const itemId = session?.kind === 'clip' ? (project ? mainTrack(project).items[0]?.id : null) : editorItemId;
  if (!itemId) return;
  sendUpdate(nextSeq(), { looks: { [itemId]: state.adjustments } }).catch(updateFailed);
});
