import { create } from 'zustand';
import { shallow } from 'zustand/shallow';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Invokes } from '../types/invokes';
import { MediaInfo, VideoProject } from '../types/video';
import { isMovingVideo } from '../utils/video/model';
import { getVideo, useVideoStore } from './useVideoStore';
import { prepareReverse, reversedPaths } from './videoMotion';
import { requestProgramFrame } from './videoView';

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface VideoJob {
  id: string;
  kind: string;
  key: string;
  label: string;
  group?: string;
  progress: number;
  state: JobState;
  error: string | null;
}

export type VideoTask = Omit<VideoJob, 'key' | 'progress'> & { progress: number | null; cancel?: () => void };

interface JobsState {
  jobs: Array<VideoJob>;
  local: Array<VideoTask>;
  cleared: ReadonlySet<string>;
  seen: ReadonlySet<string>;
}

export const useVideoJobs = create<JobsState>(() => ({ jobs: [], local: [], cleared: new Set(), seen: new Set() }));

export const isActiveJob = (job: { state: JobState }) => job.state === 'queued' || job.state === 'running';

const MAX_FINISHED_TASKS = 20;

let taskRuns = 0;

type TaskUpdate = Partial<Pick<VideoTask, 'kind' | 'label' | 'progress' | 'state' | 'error' | 'cancel'>>;

const updateTask = (id: string, update: TaskUpdate) =>
  useVideoJobs.setState((state) => {
    const task = state.local.find((entry) => entry.id === id);
    const keys = Object.keys(update) as Array<keyof TaskUpdate>;
    if (!task || keys.every((key) => task[key] === update[key])) return state;
    return { local: state.local.map((entry) => (entry === task ? { ...task, ...update } : entry)) };
  });

export const startVideoTask = (kind: string, label: string, cancel?: () => void) => {
  const id = `local:${(taskRuns += 1)}`;
  useVideoJobs.setState(({ local }) => {
    const finished = local.filter((task) => !isActiveJob(task));
    const dropped = new Set(finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_TASKS)));
    const task: VideoTask = { id, kind, label, progress: null, state: 'running', error: null, cancel };
    return { local: [...local.filter((entry) => !dropped.has(entry)), task] };
  });
  return {
    update: ({ progress, ...update }: TaskUpdate) =>
      updateTask(id, {
        ...update,
        ...(progress !== undefined && { progress: progress === null ? null : Math.round(progress * 1000) / 1000 }),
      }),
    finish: (state: 'done' | 'failed' | 'cancelled', error: string | null = null) =>
      updateTask(id, { state, error, cancel: undefined }),
  };
};

export type VideoTaskHandle = ReturnType<typeof startVideoTask>;

let listening = false;

const REFRESHING_KINDS = ['depth', 'surfaces'];

const finishedRefresh = (before: Array<VideoJob>, after: Array<VideoJob>) =>
  after.some(
    (job) =>
      job.state === 'done' &&
      REFRESHING_KINDS.includes(job.kind) &&
      before.find((previous) => previous.id === job.id)?.state !== 'done',
  );

let reversedKey = '';

const prepareReversed = (project: VideoProject | null) => {
  const paths = project ? reversedPaths(project) : [];
  const key = paths.join('\n');
  if (key === reversedKey) return;
  reversedKey = key;
  if (paths.length > 0) prepareReverse(paths);
};

let proxiedKey = '';

const proxyImmichMedia = ({ session, project, media }: ReturnType<typeof getVideo>) => {
  const paths =
    session?.kind === 'project' && project
      ? project.media
          .filter((entry) => entry.immich && entry.kind === 'video' && benefitsFromProxy(media[entry.path]))
          .map((entry) => entry.path)
      : [];
  const key = paths.join('\n');
  if (key === proxiedKey) return;
  proxiedKey = key;
  if (paths.length > 0) void createProxies(paths);
};

export const watchVideoJobs = () => {
  if (listening) return;
  listening = true;
  void listen<Array<VideoJob>>('video-jobs', (event) => {
    const refresh = finishedRefresh(useVideoJobs.getState().jobs, event.payload);
    useVideoJobs.setState({ jobs: event.payload });
    if (refresh) void requestProgramFrame();
  });
  invoke<Array<VideoJob>>(Invokes.VideoJobs)
    .then((jobs) => useVideoJobs.setState({ jobs }))
    .catch(() => undefined);
  useVideoStore.subscribe((state, previous) => {
    if (state.project !== previous.project) prepareReversed(state.project);
    if (state.project !== previous.project || state.media !== previous.media) proxyImmichMedia(state);
  });
  prepareReversed(getVideo().project);
  proxyImmichMedia(getVideo());
};

const jobsSignature = (jobs: Array<VideoJob>, kind: string) =>
  jobs
    .filter((job) => job.kind === kind)
    .map((job) => `${job.id}:${job.state}:${job.progress}`)
    .join();

interface StatusStore<S> {
  getState: () => { states: Record<string, S> };
  setState: (partial: { states: Record<string, S> }) => void;
}

export function jobStatusFeed<S>(
  kind: string,
  store: StatusStore<S>,
  update: (publish: (next: Record<string, S>) => void) => Promise<void>,
) {
  const publish = (next: Record<string, S>) => {
    const { states } = store.getState();
    const merged = Object.fromEntries(
      Object.entries(next).map(([path, state]) => [path, shallow(states[path], state) ? states[path] : state]),
    );
    if (!shallow(states, merged)) store.setState({ states: merged });
  };
  let refreshing = false;
  let stale = false;
  const refresh = async () => {
    if (refreshing) {
      stale = true;
      return;
    }
    refreshing = true;
    try {
      do {
        stale = false;
        await update(publish);
      } while (stale);
    } finally {
      refreshing = false;
    }
  };
  let watching = false;
  const watch = () => {
    if (watching) return;
    watching = true;
    watchVideoJobs();
    let media = getVideo().project?.media;
    useVideoStore.subscribe((state) => {
      if (state.project?.media === media) return;
      media = state.project?.media;
      void refresh();
    });
    useVideoJobs.subscribe((state, previous) => {
      if (jobsSignature(state.jobs, kind) !== jobsSignature(previous.jobs, kind)) void refresh();
    });
    void refresh();
  };
  return { refresh, watch };
}

export const cancelVideoJob = (id: string) => invoke(Invokes.VideoCancelJob, { id }).catch(console.error);

const STATE_ORDER: Array<JobState> = ['running', 'queued', 'failed', 'done', 'cancelled'];

const groupState = (members: Array<VideoJob>): JobState =>
  STATE_ORDER.find((state) => members.some((job) => job.state === state)) ?? 'done';

const mergeGroup = (members: Array<VideoJob>): VideoTask => {
  const state = groupState(members);
  const active = members.filter(isActiveJob);
  return {
    id: `group:${members[0].kind}:${members[0].group}`,
    kind: members[0].kind,
    label: members[0].label,
    progress: members.reduce((sum, job) => sum + (isActiveJob(job) ? job.progress : 1), 0) / members.length,
    state,
    error: members.find((job) => job.error)?.error ?? null,
    ...(active.length > 0 ? { cancel: () => active.forEach((job) => void cancelVideoJob(job.id)) } : {}),
  };
};

export const jobTasks = (jobs: Array<VideoJob>): Array<VideoTask> => {
  const groups = new Map<string, Array<VideoJob>>();
  const order: Array<VideoJob | string> = [];
  jobs.forEach((job) => {
    if (!job.group) {
      order.push(job);
      return;
    }
    const key = `${job.kind}
${job.group}`;
    const members = groups.get(key);
    if (members) members.push(job);
    else {
      groups.set(key, [job]);
      order.push(key);
    }
  });
  return order.map((entry) => {
    if (typeof entry === 'string') return mergeGroup(groups.get(entry)!);
    return isActiveJob(entry) ? { ...entry, cancel: () => void cancelVideoJob(entry.id) } : entry;
  });
};

export const clearFinishedVideoJobs = () =>
  useVideoJobs.setState(({ jobs, local, cleared }) => ({
    local: local.filter(isActiveJob),
    cleared: new Set([...cleared, ...jobs.filter((job) => !isActiveJob(job)).map((job) => job.id)]),
  }));

export const markVideoJobsSeen = () =>
  useVideoJobs.setState(({ jobs, local }) => ({ seen: new Set([...jobs, ...local].map((job) => job.id)) }));

const LONG_GOP_CODECS = ['h264', 'hevc', 'av1', 'vp9', 'vp8', 'mpeg2video', 'mpeg4'];

export const benefitsFromProxy = (info: MediaInfo | undefined) =>
  isMovingVideo(info) &&
  (Math.max(info.width, info.height) > 1920 ||
    (LONG_GOP_CODECS.includes(info.codec ?? '') && (info.hdr || Math.min(info.width, info.height) >= 1080)));

export const createProxies = (paths: Array<string>) =>
  invoke(Invokes.VideoCreateProxies, { paths }).catch(console.error);
