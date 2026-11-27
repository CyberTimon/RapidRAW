import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { invoke } from '@tauri-apps/api/core';
import { DialogFilter, open, save } from '@tauri-apps/plugin-dialog';
import { documentDir, videoDir } from '@tauri-apps/api/path';
import debounce from 'lodash.debounce';
import i18n from 'i18next';
import { Invokes } from '../types/invokes';
import { KnownError, showError } from '../utils/errors';
import { ImmichMediaRef, ImmichOriginal, immichMediaRefs, isImmichPath, linkImmichMedia } from '../utils/immichApi';
import { describeProjectChange } from '../utils/video/history';
import {
  AdjustmentItem,
  AudioItem,
  ClipItem,
  FrameRate,
  MediaInfo,
  MediaOrigin,
  MediaRef,
  PROJECT_EXTENSION,
  RecentProject,
  Ticks,
  TimeRange,
  TimelineItem,
  VideoProject,
} from '../types/video';
import { Adjustments, INITIAL_ADJUSTMENTS } from '../utils/adjustments';
import { forgetSentPatches, loadImage } from '../utils/backendPayload';
import { isSameValue } from '../utils/editHistory';
import { animateLook, lookTimeOf, recordLookEdit } from '../utils/video/lookAnimation';
import type { WhiteBalance } from '../utils/whiteBalance';
import { adjustmentsFromMetadata } from '../utils/developDefaults';
import {
  allItems,
  clipSettingsOf,
  createAudioItem,
  createClipItem,
  createProject,
  fileName,
  hasLook,
  isMovingVideo,
  itemEnd,
  locateItem,
  lookOf,
  mainTrack,
  mediaDurationTicks,
  mediaKindOf,
  mediaOf,
  normalizeProject,
  sequenceDuration,
  settingsFor,
  frameSourceTime,
  trimRange,
} from '../utils/video/model';
import { canPlaceSequence, isSequencePath, openedAt, rootProject, sequenceInfo } from '../utils/video/nesting';
import { StillShutter, shutterLook, stillShutter } from '../utils/video/shutter';
import {
  MediaTarget,
  TrackHeights,
  addMedia,
  assignLook,
  insertMainClips,
  linkedIds,
  mediaRangeWithin,
  overlayTrackOf,
  placeMedia,
  removeItems,
  splitItem,
  tidy,
  trackHeights,
  visualItemsAt,
  withTrackHeights,
} from '../utils/video/edit';
import { moveMediaToBin } from '../utils/video/bins';
import { removeCaptions } from '../utils/video/captions';
import { sequenceProject, withRevision } from '../utils/video/revisions';
import { DEFAULT_FPS, frameTicks, secondsToTicks, snapTicks, ticksToSeconds } from '../utils/video/time';
import { canvasToolState, debouncedSave, useEditorStore } from './useEditorStore';
import { useLibraryStore } from './useLibraryStore';
import { computeSortedLibrary } from '../hooks/useSortedLibrary';
import { useProcessStore } from './useProcessStore';
import { useSettingsStore } from './useSettingsStore';
import { useUIStore } from './useUIStore';
import { continueAfterSeek, isResumingAfterSeek, pause, prepareAtPlayhead } from './videoPlayback';
import { prepareTimelapses } from './videoTimelapse';
import { cancelTranscription } from './videoCaptions';
import { ensureTitleRasters, isProgramView, requestProgramFrame, showsPresets } from './videoView';
import { releasePreviewUrl } from '../utils/ImageLRUCache';

const MAX_UNDO = 100;
const MERGE_WINDOW_MS = 800;
const SAVE_DELAY_MS = 400;
const CLOSE_SAVE_WAIT_MS = 3000;
const PROBE_REPORT_MS = 250;
const RECENT_PROJECTS_TTL_MS = 30000;
const RECENT_PROJECTS_IN_MENU = 6;
export const DEFAULT_PIXELS_PER_SECOND = 60;

export type ProjectSession = { kind: 'project'; path: string; draft: boolean; ask?: boolean };
export type VideoSession = ProjectSession | { kind: 'clip'; path: string };
export type PlaybackQuality = 'auto' | 'full' | 'half' | 'quarter';

interface ProjectStep {
  project: VideoProject;
  label: string;
}

interface VideoState {
  session: VideoSession | null;
  project: VideoProject | null;
  playhead: Ticks;
  isPlaying: boolean;
  selection: Array<string>;
  editorItemId: string | null;
  pixelsPerSecond: number;
  media: Record<string, MediaInfo>;
  offline: Record<string, true>;
  past: Array<ProjectStep>;
  future: Array<ProjectStep>;
  playbackQuality: PlaybackQuality;
  useProxies: boolean;
  snapping: boolean;
  recordKeyframes: boolean;
  recordFrom: Ticks | null;
  loop: boolean;
  recentProjects: Array<RecentProject>;
  setVideo: (updater: Partial<VideoState> | ((state: VideoState) => Partial<VideoState>)) => void;
}

export const useVideoStore = create<VideoState>((set) => ({
  session: null,
  project: null,
  playhead: 0,
  isPlaying: false,
  selection: [],
  editorItemId: null,
  pixelsPerSecond: DEFAULT_PIXELS_PER_SECOND,
  media: {},
  offline: {},
  past: [],
  future: [],
  playbackQuality: 'auto',
  useProxies: true,
  snapping: true,
  recordKeyframes: false,
  recordFrom: null,
  loop: true,
  recentProjects: [],
  setVideo: (updater) => set((state) => (typeof updater === 'function' ? updater(state) : updater)),
}));

export const getVideo = () => useVideoStore.getState();
export const setVideo = (updater: Parameters<VideoState['setVideo']>[0]) => getVideo().setVideo(updater);
export const useProjectFps = () => useVideoStore((state) => state.project?.settings.fps ?? DEFAULT_FPS);

export const isProjectSession = () => getVideo().session?.kind === 'project';

const projectPathOf = ({ session }: Pick<VideoState, 'session'>) => (session?.kind === 'project' ? session.path : null);

export const currentProjectPath = () => projectPathOf(getVideo());

export const useCurrentProjectPath = () => useVideoStore(projectPathOf);

export const isOpenProject = (path: string) => currentProjectPath() === path;

export const openProjectMedia = ({ session, project }: Pick<VideoState, 'session' | 'project'>) =>
  session?.kind === 'project' ? project?.media : undefined;

const extensionOf = (path: string) => path.split('?vc=')[0].split('.').pop()?.toLowerCase() ?? '';

export const isVideoPath = (path: string) =>
  useSettingsStore.getState().supportedTypes?.video.includes(extensionOf(path)) ??
  useLibraryStore.getState().imageList.some((image) => image.path === path && image.is_video);

export const isPlaceholderPath = (path: string) =>
  useLibraryStore.getState().imageList.some((image) => image.path === path && image.is_cloud_placeholder);

export const isAudioPath = (path: string) =>
  useSettingsStore.getState().supportedTypes?.audio.includes(extensionOf(path)) ?? false;

export const isRawPath = (path: string) =>
  useSettingsStore.getState().supportedTypes?.raw.includes(extensionOf(path)) ?? false;

export const isProjectPath = (path: string) => extensionOf(path) === PROJECT_EXTENSION;

export const isMediaCandidate = (path: string) => !isProjectPath(path) && !path.includes('?vc=');

const mediaExtensions = () => {
  const types = useSettingsStore.getState().supportedTypes;
  return [...(types?.video ?? []), ...(types?.audio ?? []), ...(types?.nonRaw ?? []), ...(types?.raw ?? [])];
};

export const isImportablePath = (path: string) =>
  isMediaCandidate(path) && mediaExtensions().includes(extensionOf(path));

export const fileStem = (path: string) => fileName(path).replace(/\.[^.]+$/, '');

export const folderOf = (path: string) => {
  const source = path.split('?vc=')[0];
  return source.slice(0, Math.max(source.lastIndexOf('/'), source.lastIndexOf('\\')));
};

export const joinPath = (folder: string, name: string) => {
  if (!name) return folder;
  const separator = folder.includes('\\') ? '\\' : '/';
  return folder.endsWith('/') || folder.endsWith('\\') ? `${folder}${name}` : `${folder}${separator}${name}`;
};

export const chooseSavePath = async (
  name: string,
  extension: string,
  folder: string | null,
  title: string,
  filters: Array<DialogFilter>,
) => {
  const chosen = await save({ title, defaultPath: folder ? joinPath(folder, name) : name, filters });
  if (!chosen) return null;
  return /\.[^.\\/]+$/.test(chosen) ? chosen : `${chosen}.${extension}`;
};

const isDraft = ({ session }: Pick<VideoState, 'session'>) => session?.kind === 'project' && session.draft;

export const useDraftProject = () => useVideoStore(isDraft);

const isEditedDraft = ({ session, project, past }: Pick<VideoState, 'session' | 'project' | 'past'>) =>
  session?.kind === 'project' &&
  session.draft &&
  !!project &&
  (past.length > 0 || project.name !== fileStem(session.path));

export const isCancelled = (error: unknown) => String(error).includes('cancelled');

export const notifyFrameError = (error: unknown) => {
  if (!isCancelled(error)) showError('video.toasts.frameFailed', error);
};

const gpuRendererOf = (state: ReturnType<typeof useSettingsStore.getState>) =>
  state.appSettings?.useWgpuRenderer !== false;

const hasGpuRenderer = () => gpuRendererOf(useSettingsStore.getState());

export const useVideoAvailable = () => useSettingsStore(gpuRendererOf);

export const canOpenInEditor = (path: string) => hasGpuRenderer() || !isVideoPath(path);

export const videoUnavailable = () => {
  if (hasGpuRenderer()) return false;
  showError('video.toasts.needsGpuRenderer', null);
  return true;
};

export const ensureMedia = async (paths: Array<string>, retry = false) => {
  if (retry) {
    setVideo((state) => ({
      offline: Object.fromEntries(Object.entries(state.offline).filter(([path]) => !paths.includes(path))),
    }));
    const media = openProjectMedia(getVideo());
    if (media?.some((entry) => entry.immich && paths.includes(entry.path))) await linkImmich(media, true);
  }
  await probeInto(
    [...new Set(paths)].filter((path) => !isSequencePath(path) && !getVideo().media[path] && !getVideo().offline[path]),
  );
  return getVideo().media;
};

const probeInto = async (paths: Array<string>) => {
  const found = (await Promise.all(paths.map(probeMedia))).filter((entry) => entry !== null);
  if (found.length > 0) setVideo((state) => ({ media: { ...state.media, ...Object.fromEntries(found) } }));
};

const probes = new Map<string, Promise<readonly [string, MediaInfo] | null>>();
const failedProbes = new Map<string, string>();

const reportFailedProbes = debounce(() => {
  const [first] = failedProbes;
  if (!first) return;
  const paths = [...failedProbes.keys()];
  showError('video.toasts.probeFailed', first[1], {
    retry: () => void ensureMedia(paths, true),
    values: { count: paths.length, file: fileStem(first[0]) },
    id: `probe:${paths.join('|')}`,
  });
  failedProbes.clear();
}, PROBE_REPORT_MS);

const probeMedia = (path: string) => {
  const running = probes.get(path);
  if (running) return running;
  const probe = invoke<MediaInfo>(Invokes.VideoProbe, { path })
    .then((info) => [path, info] as const)
    .catch((err) => {
      setVideo((state) => ({ offline: { ...state.offline, [path]: true } }));
      failedProbes.set(path, String(err));
      reportFailedProbes();
      return null;
    })
    .finally(() => probes.delete(path));
  probes.set(path, probe);
  return probe;
};

let saveSubmit: Promise<unknown> = Promise.resolve();

const writeProject = async (path: string, project: VideoProject) => {
  const submit = saveSubmit
    .catch(() => undefined)
    .then(() => withRevision(project, (revision) => invoke(Invokes.VideoSaveProject, { path, revision })));
  saveSubmit = submit;
  await submit;
  await invoke(Invokes.VideoProjectSaved, { path });
};

const saveProject = debounce(() => {
  const { project, session } = getVideo();
  if (!project || session?.kind !== 'project' || session.draft) return;
  return writeProject(session.path, project).catch((err) =>
    showError('video.toasts.saveFailed', err, { retry: () => saveProject() }),
  );
}, SAVE_DELAY_MS);

let lastEdit = { key: '', time: 0 };

export const clampPlayhead = (project: VideoProject, time: Ticks) => {
  const last = Math.max(0, sequenceDuration(project) - frameTicks(project.settings.fps));
  return Math.min(Math.max(0, snapTicks(time, project.settings.fps)), last);
};

const stepTo = (before: VideoProject, after: VideoProject): ProjectStep => ({
  project: before,
  label: describeProjectChange(before, after, i18n.t),
});

const recordedPast = (past: Array<ProjectStep>, project: VideoProject, next: VideoProject, mergeKey?: string) => {
  const now = performance.now();
  const merged = !!mergeKey && lastEdit.key === mergeKey && now - lastEdit.time < MERGE_WINDOW_MS ? past.at(-1) : null;
  lastEdit = { key: mergeKey ?? '', time: now };
  return merged
    ? [...past.slice(0, -1), stepTo(merged.project, next)]
    : [...past.slice(-MAX_UNDO + 1), stepTo(project, next)];
};

const recordProject = (next: VideoProject, mergeKey?: string) => {
  const { project, past, selection, session } = getVideo();
  if (!project) return;
  const stored = { ...next, modified: Date.now() };
  const existing = new Set([
    ...allItems(next).map((item) => item.id),
    ...(next.captions?.items ?? []).map((c) => c.id),
  ]);
  const kept = selection.filter((id) => existing.has(id));
  setVideo((state) => ({
    project: stored,
    playhead: clampPlayhead(next, state.playhead),
    selection: kept.length === selection.length ? selection : kept,
    past: session?.kind === 'project' ? recordedPast(past, project, stored, mergeKey) : past,
    future: [],
  }));
  saveProject();
};

export const editProject = (update: (project: VideoProject) => VideoProject, mergeKey?: string, refocus = true) => {
  flushEditorLook();
  const { project, isPlaying } = getVideo();
  if (!project) return;
  const next = update(project);
  if (next === project) return;
  if (isPlaying && next.looks !== project.looks) showEditorLook(next);
  recordProject(next, mergeKey);
  if (refocus && !isPlaying) void focusPlayhead();
};

export const resizeTracks = (heights: TrackHeights) => {
  const { project } = getVideo();
  const next = project && withTrackHeights(project, heights);
  if (!next || next === project) return;
  setVideo({ project: next });
  saveProject();
};

const projectLook = (project: VideoProject, item: ClipItem | AdjustmentItem): Adjustments =>
  lookOf(project, item) ?? INITIAL_ADJUSTMENTS;

let shownLook: { itemId: string; time: Ticks; adjustments: Adjustments } | null = null;

export const syncedEditorLook = (itemId: string) => (shownLook?.itemId === itemId ? shownLook.adjustments : null);

export const lookAt = (project: VideoProject, item: ClipItem | AdjustmentItem, time: Ticks) =>
  animateLook(projectLook(project, item), lookTimeOf(item, time, project.settings.fps));

const lookItem = (project: VideoProject, itemId: string | null) => {
  const item = itemId ? locateItem(project, itemId)?.item : null;
  return item && hasLook(item) ? item : null;
};

export const lookTargetOf = (project: VideoProject, selection: Array<string>): ClipItem | AdjustmentItem | null => {
  for (const id of selection) {
    const item = lookItem(project, id);
    if (item) return item;
  }
  return null;
};

export const useLookTargetType = () =>
  useVideoStore(({ session, project, selection }) =>
    session?.kind === 'project' && project ? (lookTargetOf(project, selection)?.type ?? null) : null,
  );

export const editorTimeOf = (project: VideoProject, item: TimelineItem, time: Ticks) =>
  Math.max(item.start, Math.min(time, itemEnd(item) - frameTicks(project.settings.fps)));

export const editorLookTime = (project: VideoProject, item: ClipItem | AdjustmentItem, time: Ticks) =>
  lookTimeOf(item, editorTimeOf(project, item, time), project.settings.fps);

const showEditorLook = (project = getVideo().project) => {
  const { editorItemId, playhead, session } = getVideo();
  const item = project && session?.kind === 'project' ? lookItem(project, editorItemId) : null;
  if (!project || !item) return;
  const look = lookAt(project, item, editorTimeOf(project, item, playhead));
  const current = useEditorStore.getState().adjustments;
  const changed = !isSameValue(current, look);
  shownLook = {
    itemId: item.id,
    time: editorLookTime(project, item, playhead),
    adjustments: changed ? look : current,
  };
  if (changed) useEditorStore.getState().setEditor({ adjustments: look });
};

const flushEditorLook = () => {
  const { selectedImage, adjustments } = useEditorStore.getState();
  if (selectedImage && shownLook?.itemId === getVideo().editorItemId && adjustments !== shownLook.adjustments) {
    saveVideoLook(selectedImage.path, adjustments);
  }
};

const syncEditorLook = () => {
  flushEditorLook();
  showEditorLook();
};

const restoreHistory = (indexOf: (current: number) => number) => {
  flushEditorLook();
  const { project, past, future, selection, playhead } = getVideo();
  const steps = [...past, ...[...future].reverse()];
  const index = indexOf(past.length);
  if (!project || index === past.length || index < 0 || index > steps.length) return;
  const states = [...past.map((step) => step.project), project, ...[...future].reverse().map((step) => step.project)];
  const restored = withTrackHeights(openedAt(states[index], project.open), trackHeights(project));
  lastEdit = { key: '', time: 0 };
  setVideo({
    project: restored,
    selection: selection.filter((id) => locateItem(restored, id)),
    playhead: clampPlayhead(restored, playhead),
    past: states.slice(0, index).map((state, step) => ({ project: state, label: steps[step].label })),
    future: states
      .slice(index + 1)
      .map((state, offset) => ({ project: state, label: steps[index + offset].label }))
      .reverse(),
  });
  showEditorLook();
  saveProject();
  void focusPlayhead();
};

export const showSequence = (project: VideoProject, playhead: Ticks) => {
  pause();
  syncEditorLook();
  setVideo({ project, selection: [], editorItemId: null, playhead: clampPlayhead(project, playhead) });
  saveProject();
  void focusPlayhead();
};

export const undoProject = () => restoreHistory((current) => current - 1);
export const redoProject = () => restoreHistory((current) => current + 1);
export const goToProjectHistory = (index: number) => restoreHistory(() => index);

interface InstalledFrame {
  width: number;
  height: number;
  is_raw?: boolean;
  exif?: Record<string, string> | null;
  metadata?: unknown;
  as_shot_white_balance?: WhiteBalance;
}

const historyKey = (path: string, itemId: string | null) => (itemId ? `${path}#${itemId}` : path);

let editorStale = false;
let installedTarget: string | null = null;

export const editorFramePending = () => editorStale && isProjectSession();

const showInEditor = (
  path: string,
  info: MediaInfo,
  look: Adjustments,
  itemId: string | null,
  loaded?: InstalledFrame,
) => {
  const editor = useEditorStore.getState();
  if (loaded) editor.setEditor((state) => ({ displayRevision: state.displayRevision + 1 }));
  if (!editorStale && editor.selectedImage?.path === path && getVideo().editorItemId === itemId) return;
  editorStale = false;
  flushEditorLook();
  shownLook = null;
  forgetSentPatches();
  debouncedSave.flush();
  editor.stashHistory();
  if (useLibraryStore.getState().isViewLoading) useLibraryStore.getState().setLibrary({ isViewLoading: false });
  const width = loaded?.width ?? info.width;
  const height = loaded?.height ?? info.height;
  const uncropped = editor.uncroppedAdjustedPreviewUrl;
  setVideo({ editorItemId: itemId });
  editor.setEditor({
    selectedImage: {
      path,
      isReady: true,
      isRaw: loaded?.is_raw ?? info.isRaw,
      exif: loaded?.exif ?? null,
      metadata: loaded?.metadata ?? null,
      asShotWhiteBalance: loaded?.as_shot_white_balance,
      thumbnailUrl: useProcessStore.getState().thumbnails[path] ?? '',
      width,
      height,
    },
    originalSize: { width, height },
    adjustments: look,
    previewOverride: null,
    activeMaskId: null,
    activeMaskContainerId: null,
    activeAiPatchContainerId: null,
    activeAiSubMaskId: null,
    interactivePatch: null,
    uncroppedAdjustedPreviewUrl: null,
    ...canvasToolState(),
  });
  releasePreviewUrl(uncropped);
  editor.resetHistory(look, historyKey(path, itemId));
};

let installedStill: string | null = null;
let installedShutter = JSON.stringify(null);

const installFrame = async (
  media: MediaRef,
  info: MediaInfo,
  sourceTime: Ticks,
  shutter: StillShutter | null,
): Promise<InstalledFrame | undefined> => {
  const { path } = media;
  const { project, useProxies } = getVideo();
  installedShutter = JSON.stringify(shutter?.look ?? null);
  if (media.kind === 'sequence' && project) {
    installedStill = null;
    const nested = sequenceProject(project, media.id);
    const titleKeys = await ensureTitleRasters(nested, nested.settings.height);
    return withRevision(nested, (revision) =>
      invoke<InstalledFrame>(Invokes.VideoInstallFrame, {
        request: {
          revision,
          time: ticksToSeconds(sourceTime),
          view: { targetResolution: null, contentPath: path, titleKeys, useProxies, lookOverrides: {} },
        },
      }),
    );
  }
  if (!info.isStill) {
    installedStill = null;
    return invoke<InstalledFrame>(Invokes.VideoSeek, {
      path,
      time: ticksToSeconds(sourceTime),
      log: media.log ?? null,
      deflicker: media.timelapse?.deflicker ?? false,
      shutter,
    });
  }
  if (installedStill === path) return undefined;
  const loaded = await loadImage<InstalledFrame>(path);
  installedStill = path;
  return loaded;
};

export const readSidecarLook = async (path: string) => {
  const metadata = await invoke<{ adjustments?: unknown } | null>(Invokes.LoadMetadata, { path }).catch(() => null);
  const adjustments = metadata?.adjustments;
  return adjustments && typeof adjustments === 'object' && !(adjustments as { is_null?: boolean }).is_null
    ? adjustmentsFromMetadata(adjustments)
    : null;
};

export const editorClipAt = (project: VideoProject, time: Ticks): ClipItem | null =>
  visualItemsAt(project, time)
    .map(({ item }) => item)
    .filter((item): item is ClipItem => item.type === 'clip')
    .at(-1) ?? null;

const sessionPath = (suffix: string) => `${getVideo().session?.path ?? 'video'}#${suffix}`;

const adjustmentLayerPath = (itemId: string) => sessionPath(`adjustment-${itemId}`);

const canvasInfo = ({ settings }: VideoProject): MediaInfo => ({
  duration: 0,
  width: settings.width,
  height: settings.height,
  fps: 0,
  hasVideo: true,
  hasAudio: false,
  codec: null,
  audioCodec: null,
  bitRate: null,
  hdr: false,
  isStill: true,
  isRaw: false,
});

const showAdjustmentLayer = (project: VideoProject, item: AdjustmentItem) => {
  showInEditor(
    adjustmentLayerPath(item.id),
    canvasInfo(project),
    lookAt(project, item, editorTimeOf(project, item, getVideo().playhead)),
    item.id,
  );
  syncEditorLook();
};

const releaseEditorTarget = () => {
  if (getVideo().editorItemId === null) return;
  editorStale = true;
  setVideo({ editorItemId: null });
};

export const isProjectViewPath = (path: string) => isProjectSession() && path.startsWith(sessionPath(''));

const showsProject = (project: VideoProject, path: string | undefined) =>
  !!path && (isProjectViewPath(path) || project.media.some((media) => media.path === path));

const showCanvas = (project: VideoProject) => {
  if (showsProject(project, useEditorStore.getState().selectedImage?.path)) releaseEditorTarget();
  else showInEditor(sessionPath('canvas'), canvasInfo(project), structuredClone(INITIAL_ADJUSTMENTS), null);
};

const editorLoaded = (path: string) =>
  new Promise<void>((resolve) => {
    const settled = () => {
      const image = useEditorStore.getState().selectedImage;
      return !image || image.path !== path || image.isReady;
    };
    if (settled()) {
      resolve();
      return;
    }
    const unsubscribe = useEditorStore.subscribe(() => {
      if (!settled()) return;
      unsubscribe();
      resolve();
    });
  });

const syncEditorToPlayhead = async () => {
  const { project, playhead, isPlaying, selection, session } = getVideo();
  if (!project || !session || (isPlaying && !isProgramView())) return;
  prepareAtPlayhead();
  const target = session.kind === 'project' ? lookTargetOf(project, selection) : null;
  if (target?.type === 'adjustment') {
    showAdjustmentLayer(project, target);
    void requestProgramFrame();
    return;
  }
  const clip = target ?? editorClipAt(project, playhead);
  const media = clip && mediaOf(project, clip.media);
  if (!clip || !media) {
    if (session.kind === 'project') showCanvas(project);
    else releaseEditorTarget();
    if (isProgramView()) void requestProgramFrame();
    return;
  }
  const stale = () => {
    const current = getVideo();
    return (
      current.session !== session ||
      current.project !== project ||
      (!isPlaying && current.playhead !== playhead) ||
      current.selection !== selection ||
      current.isPlaying !== isPlaying
    );
  };
  const infos = await ensureMedia([media.path]);
  if (stale()) return;
  const info = infos[media.path];
  if (!info) {
    releaseEditorTarget();
    return;
  }
  const editor = useEditorStore.getState();
  const time = editorTimeOf(project, clip, playhead);
  const itemId = target?.id ?? null;
  const frameKey = `${media.path}#${itemId}`;
  const programView = isProgramView();
  if (programView && (installedTarget === frameKey || !showsPresets(useUIStore.getState()))) {
    showInEditor(media.path, info, lookAt(project, clip, time), itemId);
    syncEditorLook();
    void requestProgramFrame();
    return;
  }
  const look =
    session.kind === 'clip'
      ? editor.selectedImage?.path === media.path
        ? editor.adjustments
        : ((await readSidecarLook(media.path)) ?? structuredClone(INITIAL_ADJUSTMENTS))
      : lookAt(project, clip, time);
  if (session.kind === 'clip') await editorLoaded(media.path);
  if (stale()) return;
  const current = useEditorStore.getState();
  const shown =
    current.selectedImage?.path === media.path && getVideo().editorItemId === itemId ? current.adjustments : look;
  const loaded = await installFrame(
    media,
    info,
    frameSourceTime(clip, time, project.settings.fps, info.fps),
    stillShutter(shown, clip, time, project.settings.fps),
  );
  if (stale()) return;
  installedTarget = frameKey;
  showInEditor(media.path, info, look, itemId, loaded);
  syncEditorLook();
  if (programView) void requestProgramFrame();
};

let seekRunning = false;
let seekQueued = false;

export const focusPlayhead = async () => {
  if (seekRunning) {
    seekQueued = true;
    return;
  }
  seekRunning = true;
  try {
    do {
      seekQueued = false;
      await syncEditorToPlayhead().catch(notifyFrameError);
    } while (seekQueued);
  } finally {
    seekRunning = false;
  }
};

export const setPlayhead = (time: Ticks) => {
  const { project, isPlaying } = getVideo();
  if (!project) return;
  const resume = isPlaying || isResumingAfterSeek();
  if (isPlaying) pause();
  setVideo({ playhead: clampPlayhead(project, time) });
  void focusPlayhead();
  if (resume) continueAfterSeek();
};

export const stepFrames = (frames: number) => {
  const { project, playhead } = getVideo();
  if (project) setPlayhead(playhead + frames * frameTicks(project.settings.fps));
};

export const goToLookTarget = () => {
  const { project, playhead, selection } = getVideo();
  const target = project ? lookTargetOf(project, selection) : null;
  if (project && target) setPlayhead(editorTimeOf(project, target, playhead));
};

const mainOverlap = (project: VideoProject, item: TimelineItem) => {
  const items = mainTrack(project).items;
  const index = items.findIndex((candidate) => candidate.id === item.id);
  return index > 0 ? Math.max(0, itemEnd(items[index - 1]) - item.start) : 0;
};

export const selectItems = (ids: Array<string>, seek = true, linked = true) => {
  const { project, playhead, isPlaying } = getVideo();
  setVideo({ selection: project && linked ? linkedIds(project, ids) : ids });
  const item = project && locateItem(project, ids[0] ?? null)?.item;
  if (!item || !seek) return;
  if (!isPlaying && (playhead < item.start || playhead >= itemEnd(item)))
    setPlayhead(item.start + mainOverlap(project, item));
  else void focusPlayhead();
};

export const splitAtPlayhead = () => {
  const { project, playhead, selection } = getVideo();
  if (!project) return;
  const covers = (item: TimelineItem | undefined): item is TimelineItem =>
    !!item && playhead > item.start && playhead < itemEnd(item);
  const selected = selection.map((id) => locateItem(project, id)?.item).filter(covers);
  const fallback = editorClipAt(project, playhead);
  const targets = selected.length > 0 ? selected : covers(fallback ?? undefined) ? [fallback!] : [];
  if (targets.length === 0) return;
  editProject((current) => targets.reduce((next, item) => splitItem(next, item.id, playhead), current));
};

export const deleteSelection = () => {
  const { selection, project } = getVideo();
  if (!project || selection.length === 0) return;
  editProject((current) => removeCaptions(removeItems(current, selection), selection));
  setVideo({ selection: [] });
};

const editedLook = (project: VideoProject, item: ClipItem | AdjustmentItem, adjustments: Adjustments) => {
  const { playhead, recordKeyframes, recordFrom, isPlaying } = getVideo();
  const shown = shownLook?.itemId === item.id ? shownLook : null;
  const stored = projectLook(project, item);
  const shownTime = editorLookTime(project, item, playhead);
  const editedAt = shown?.time ?? shownTime;
  return recordLookEdit(
    stored,
    adjustments,
    editedAt,
    isPlaying ? shownTime : editedAt,
    recordKeyframes,
    frameTicks(project.settings.fps) / 2,
    recordFrom === null ? null : editorLookTime(project, item, recordFrom),
  );
};

export const liveLook = (project: VideoProject, itemId: string, adjustments: Adjustments) => {
  const item = lookItem(project, itemId);
  if (!item || (shownLook?.itemId === item.id && shownLook.adjustments === adjustments)) return adjustments;
  return editedLook(project, item, adjustments);
};

export const saveVideoLook = (path: string, adjustments: Adjustments) => {
  const { project, session, editorItemId } = getVideo();
  if (session?.kind !== 'project' || !project) return false;
  const item = lookItem(project, editorItemId);
  const matches =
    item?.type === 'clip'
      ? mediaOf(project, item.media)?.path === path
      : item?.type === 'adjustment' && adjustmentLayerPath(item.id) === path;
  if (!item || !matches) return true;
  const shown = shownLook?.itemId === item.id ? shownLook : null;
  if (shown?.adjustments === adjustments) return true;
  const stored = projectLook(project, item);
  const next = editedLook(project, item, adjustments);
  if (shown) shown.adjustments = adjustments;
  if (isSameValue(next, stored)) return true;
  recordProject(assignLook(project, item.id, next)[0], `look:${item.id}`);
  showEditorLook();
  return true;
};

export const editItemLook = (itemId: string, update: (look: Adjustments, lookTime: Ticks) => Adjustments) => {
  flushEditorLook();
  const { project, playhead } = getVideo();
  const item = project ? lookItem(project, itemId) : null;
  if (!project || !item) return;
  const stored = projectLook(project, item);
  const next = update(stored, editorLookTime(project, item, playhead));
  if (isSameValue(next, stored)) return;
  recordProject(assignLook(project, item.id, next)[0], `look:${item.id}`);
  showEditorLook();
};

export const refreshLook = (lookId: string, update: (look: Adjustments) => Adjustments) => {
  flushEditorLook();
  const { project } = getVideo();
  const stored = project?.looks[lookId];
  if (!project || !stored) return;
  const next = update(stored);
  if (isSameValue(next, stored)) return;
  setVideo({ project: { ...project, looks: { ...project.looks, [lookId]: next } } });
  showEditorLook();
  saveProject();
};

const revealTimeline = () => useUIStore.getState().setUI({ activeView: 'editor' });

export const seedLook = (project: VideoProject, look: Adjustments | null): [VideoProject, string | null] => {
  if (!look) return [project, null];
  const existing = Object.entries(project.looks).find(([, candidate]) => isSameValue(candidate, look));
  if (existing) return [project, existing[0]];
  const id = crypto.randomUUID();
  return [{ ...project, looks: { ...project.looks, [id]: look } }, id];
};

export interface PreparedMedia {
  path: string;
  info: MediaInfo;
  kind: ReturnType<typeof mediaKindOf>;
  look: Adjustments | null;
  immich?: ImmichMediaRef;
}

const usableMedia = (paths: Array<string>): Array<Omit<PreparedMedia, 'look'>> => {
  const { project, media } = getVideo();
  return paths
    .filter((path) => media[path])
    .flatMap((path) => {
      const ref = isSequencePath(path) ? project?.media.find((candidate) => candidate.path === path) : null;
      if (ref) return project && canPlaceSequence(project, ref.id) ? [{ path, info: media[path], kind: ref.kind }] : [];
      return [{ path, info: media[path], kind: mediaKindOf(media[path], isAudioPath(path)) }];
    });
};

export const prepareMedia = async (paths: Array<string>): Promise<Array<PreparedMedia>> => {
  const media = paths.filter(isMediaCandidate);
  await ensureMedia(media);
  const usable = usableMedia(media);
  const refs = await immichMediaRefs(usable.map((entry) => entry.path)).catch(() => []);
  return Promise.all(
    usable.map(async (entry, index) => ({
      ...entry,
      look: entry.kind === 'video' || entry.kind === 'image' ? await readSidecarLook(entry.path) : null,
      ...(refs[index] ? { immich: refs[index] } : {}),
    })),
  );
};

const originOf = (entry: PreparedMedia): MediaOrigin => ({
  log: entry.look ? undefined : entry.info.detectedLog,
  immich: entry.immich,
});

const DEFAULT_SETTINGS = settingsFor(undefined);

const hasDefaultSettings = ({ settings }: VideoProject) =>
  settings.width === DEFAULT_SETTINGS.width &&
  settings.height === DEFAULT_SETTINGS.height &&
  settings.fps.num === DEFAULT_SETTINGS.fps.num &&
  settings.fps.den === DEFAULT_SETTINGS.fps.den &&
  settings.background === DEFAULT_SETTINGS.background &&
  settings.sampleRate === DEFAULT_SETTINGS.sampleRate;

const conformEmptyProject = (project: VideoProject, prepared: Array<PreparedMedia>) => {
  const visual = prepared.find((entry) => entry.kind === 'video') ?? prepared.find((entry) => entry.kind === 'image');
  return visual && allItems(project).length === 0 && hasDefaultSettings(project)
    ? { ...project, settings: settingsFor(visual.info) }
    : project;
};

const withSourceRange = <T extends ClipItem | AudioItem>(item: T, range: TimeRange | null, fps: FrameRate): T =>
  range
    ? { ...item, sourceIn: range.start, duration: Math.max(frameTicks(fps), snapTicks(range.end - range.start, fps)) }
    : item;

export const mediaItems = (
  start: VideoProject,
  prepared: Array<PreparedMedia>,
  overlay = false,
): [VideoProject, Array<ClipItem | AudioItem>] => {
  let project = conformEmptyProject(start, prepared);
  const items: Array<ClipItem | AudioItem> = [];
  for (const entry of prepared) {
    const [withRef, media] = addMedia(project, entry.path, entry.kind, originOf(entry));
    project = withRef;
    const { fps } = project.settings;
    const duration = mediaDurationTicks(entry.info, entry.kind);
    if (entry.kind === 'audio') {
      const audio = createAudioItem(media, entry.info, 0, project.settings);
      items.push(withSourceRange(audio, mediaRangeWithin(media.range, duration), fps));
      continue;
    }
    const [seeded, look] = seedLook(project, entry.look);
    project = seeded;
    const trim = look && entry.kind === 'video' ? clipSettingsOf(project.looks[look]?.video) : null;
    const [from, to] = trim ? trimRange(trim, duration) : [0, duration];
    const range =
      entry.kind === 'image'
        ? null
        : (mediaRangeWithin(media.range, duration) ?? (trim ? { start: from, end: to } : null));
    const clip = withSourceRange(createClipItem(media, entry.info, project.settings, look, overlay), range, fps);
    items.push(trim ? { ...clip, muted: trim.muted } : clip);
  }
  return [project, items];
};

const withMedia = (start: VideoProject, prepared: Array<PreparedMedia>, at: MediaTarget) =>
  placeMedia(...mediaItems(start, prepared, overlayTrackOf(at) !== null), at);

export const addPreparedMedia = (prepared: Array<PreparedMedia>, at?: MediaTarget) => {
  if (prepared.length === 0 || !getVideo().project) return;
  let added: Array<string> = [];
  editProject((current) => {
    const next = withMedia(current, prepared, at ?? { time: getVideo().playhead });
    const existing = new Set(allItems(current).map((item) => item.id));
    added = allItems(next)
      .filter((item) => !existing.has(item.id))
      .map((item) => item.id);
    return next;
  });
  selectItems(added, false);
};

export const addMediaToProject = async (paths: Array<string>, at?: MediaTarget) => {
  if (!getVideo().project) return;
  addPreparedMedia(await prepareMedia(paths), at);
};

export const addMediaToPool = async (paths: Array<string>, bin: string | null = null) => {
  const target = currentProjectPath();
  if (!target) return;
  const entries = await prepareMedia(paths);
  if (currentProjectPath() !== target) return;
  editProject((current) => {
    const [next, added] = entries.reduce<[VideoProject, Array<string>]>(
      ([project, ids], entry) => {
        const [withEntry, media] = addMedia(project, entry.path, entry.kind, originOf(entry));
        return [withEntry, withEntry === project ? ids : [...ids, media.id]];
      },
      [current, []],
    );
    return bin ? moveMediaToBin(next, added, bin) : next;
  });
};

export const importMediaDialog = async (bin: string | null = null) => {
  const extensions = mediaExtensions();
  const selected = await open({
    multiple: true,
    filters: [
      {
        name: i18n.t('video.mediaPool.mediaFiles'),
        extensions: [...extensions, ...extensions.map((extension) => extension.toUpperCase())],
      },
    ],
  });
  const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
  if (paths.length > 0) await addMediaToPool(paths, bin);
};

let releaseEpoch = 0;

const resetSessionState = (session: VideoSession | null, project: VideoProject | null) => {
  cancelTranscription();
  const epoch = ++releaseEpoch;
  if (!session && getVideo().session) {
    saveSubmit
      .catch(() => undefined)
      .then(() => (epoch === releaseEpoch && !getVideo().session ? invoke(Invokes.VideoRelease) : undefined))
      .catch(console.error);
  }
  installedStill = null;
  installedTarget = null;
  installedShutter = JSON.stringify(null);
  editorStale = false;
  shownLook = null;
  setVideo({
    session,
    project,
    playhead: 0,
    selection: [],
    editorItemId: null,
    past: [],
    future: [],
    recordKeyframes: false,
    recordFrom: null,
  });
};

let openRun = 0;

const claimOpen = () => {
  const run = ++openRun;
  return () => run === openRun;
};

export const cancelPendingOpen = () => void claimOpen();

let linkedKey = '';

const linkImmich = async (media: Array<MediaRef>, force = false) => {
  const linked = media.flatMap(({ path, immich }) => (immich ? [{ path, immich }] : []));
  const key = linked.map(({ path, immich }) => `${path}|${immich.server}|${immich.asset}`).join('\n');
  if (key === linkedKey && (!force || !key)) return new Map<string, ImmichOriginal>();
  linkedKey = key;
  const originals = await linkImmichMedia(linked).catch(() => []);
  return new Map(linked.flatMap(({ path }, index) => (originals[index] ? [[path, originals[index]!] as const] : [])));
};

let linkedMedia: Array<MediaRef> | undefined;

useVideoStore.subscribe((state) => {
  const media = openProjectMedia(state);
  if (media === linkedMedia) return;
  linkedMedia = media;
  void linkImmich(media ?? []);
});

const withOriginals = (project: VideoProject, originals: Map<string, ImmichOriginal>): VideoProject =>
  project.media.some((media) => (originals.get(media.path)?.path ?? media.path) !== media.path)
    ? {
        ...project,
        media: project.media.map((media) => ({ ...media, path: originals.get(media.path)?.path ?? media.path })),
      }
    : project;

const reconnectMedia = (paths: Array<string>, current: () => boolean) => {
  for (const path of paths) {
    void probeInto([path]).then(() => {
      if (current()) void focusPlayhead();
    });
  }
};

const startProject = async (session: ProjectSession, opened: VideoProject, current: () => boolean) => {
  const originals = await linkImmich(opened.media, true);
  const project = withOriginals(opened, originals);
  const downloading = new Set([...originals.values()].filter((original) => original.missing).map(({ path }) => path));
  await ensureMedia(project.media.map((media) => media.path).filter((path) => !downloading.has(path)));
  if (!current()) return;
  resetSessionState(session, tidy({ ...project, name: fileStem(session.path) }));
  handOffEditor();
  const first = mainTrack(project).items[0];
  if (first) setVideo({ selection: [first.id] });
  useUIStore.getState().enterWorkspace('video');
  revealTimeline();
  void refreshRecentProjects();
  await focusPlayhead();
  reconnectMedia([...downloading], current);
};

const moveProject = (session: ProjectSession, path: string) => {
  const { project } = getVideo();
  if (getVideo().session !== session || !project || session.path === path) return false;
  setVideo({ session: { ...session, path }, project: session.draft ? project : { ...project, name: fileStem(path) } });
  saveProject();
  void focusPlayhead();
  void refreshRecentProjects();
  return true;
};

let draftSave: Promise<boolean> | null = null;

const newProjectPath = (folder: string, name: string) => invoke<string>(Invokes.VideoNewProjectPath, { folder, name });

const projectSaveFolder = async () => {
  await refreshRecentProjects();
  const [recent] = presentProjects(getVideo().recentProjects);
  return recent ? folderOf(recent.path) : videoDir().catch(documentDir);
};

type ProjectSource = Pick<MediaRef, 'path' | 'kind' | 'immich' | 'timelapse'>;

const localMediaPath = (media: Array<ProjectSource>) => {
  const local = media.filter(
    (entry) => !entry.immich && !entry.timelapse && entry.kind !== 'sequence' && !isImmichPath(entry.path),
  );
  return (local.find(({ kind }) => kind === 'video') ?? local.find(({ kind }) => kind === 'image') ?? local[0])?.path;
};

const projectHome = async (media: Array<ProjectSource>) => {
  const local = localMediaPath(media);
  return local ? { folder: folderOf(local), ask: false } : { folder: await projectSaveFolder(), ask: true };
};

const draftPath = async (session: ProjectSession, project: VideoProject) => {
  const local = session.ask ? localMediaPath(project.media) : session.path;
  if (local) return newProjectPath(folderOf(local), project.name);
  const suggested = await newProjectPath(folderOf(session.path), project.name);
  const chosen = await chooseSavePath(
    fileName(suggested),
    PROJECT_EXTENSION,
    folderOf(suggested),
    i18n.t('video.project.saveAs'),
    [{ name: i18n.t('video.project.projects'), extensions: [PROJECT_EXTENSION] }],
  );
  return chosen && !isProjectPath(chosen) ? `${chosen}.${PROJECT_EXTENSION}` : chosen;
};

const writeDraft = async (session: ProjectSession, project: VideoProject) => {
  try {
    const path = await draftPath(session, project);
    if (!path) return false;
    const name = fileStem(path);
    await writeProject(path, { ...project, name });
    if (getVideo().session !== session) return true;
    const edited = getVideo().project !== project;
    setVideo((state) => ({
      session: { kind: 'project', path, draft: false },
      project: state.project && { ...state.project, name },
    }));
    if (edited) saveProject();
    if (path !== session.path) void focusPlayhead();
    void useUIStore.getState().libraryRefreshHandler?.();
    void refreshRecentProjects();
    return true;
  } catch (err) {
    showError('video.toasts.saveFailed', err, { retry: () => void saveOpenProject() });
    return false;
  }
};

export const saveOpenProject = async () => {
  debouncedSave.flush();
  const { session, project } = getVideo();
  if (session?.kind !== 'project' || !project) return false;
  if (!session.draft) {
    await saveProject.flush();
    return true;
  }
  draftSave ??= writeDraft(session, project).finally(() => {
    draftSave = null;
  });
  return draftSave;
};

export const renameProject = async (name: string) => {
  const { session, project } = getVideo();
  if (session?.kind !== 'project' || !project) return;
  if (session.draft) {
    setVideo({ project: { ...project, name } });
    return;
  }
  await saveProject.flush();
  try {
    const path = await invoke<string>(Invokes.VideoRenameProject, { path: session.path, name });
    if (moveProject(session, path)) void useUIStore.getState().libraryRefreshHandler?.();
  } catch (err) {
    showError('video.toasts.saveFailed', err, { retry: () => void renameProject(name) });
  }
};

const isWithin = (path: string, folder: string) =>
  path === folder || path.startsWith(`${folder}/`) || path.startsWith(`${folder}\\`);

const markOffline = (paths: Array<string>) => {
  const gone = new Set(
    (openProjectMedia(getVideo()) ?? [])
      .map((media) => media.path)
      .filter((path) => paths.some((changed) => isWithin(path, changed))),
  );
  if (gone.size === 0) return;
  setVideo((state) => ({
    media: Object.fromEntries(Object.entries(state.media).filter(([path]) => !gone.has(path))),
    offline: { ...state.offline, ...Object.fromEntries([...gone].map((path) => [path, true as const])) },
  }));
};

const followProjectPath = async <T>(
  paths: Array<string>,
  change: () => Promise<T>,
  movedTo: (result: T, index: number) => string | undefined,
) => {
  const { session } = getVideo();
  const open = session?.kind === 'project' ? session : null;
  const index = open ? paths.findIndex((path) => isWithin(open.path, path)) : -1;
  if (index >= 0) await saveProject.flush();
  const result = await change();
  const moved = index >= 0 ? movedTo(result, index) : undefined;
  if (open && moved) moveProject(open, moved + open.path.slice(paths[index].length));
  void refreshRecentProjects();
  markOffline(
    paths.filter((path, position) => {
      const target = movedTo(result, position);
      return !!target && target !== path;
    }),
  );
  return result;
};

export const followProjectRename = (paths: Array<string>, rename: () => Promise<Array<string>>) =>
  followProjectPath(paths, rename, (renamed, index) => renamed[index]);

export const followProjectMove = (paths: Array<string>, move: () => Promise<Record<string, string>>) =>
  followProjectPath(paths, move, (moved, index) => moved[paths[index]]);

export const followProjectDelete = async (paths: Array<string>, remove: () => Promise<unknown>) => {
  const { session } = getVideo();
  if (session?.kind === 'project' && paths.some((path) => isWithin(session.path, path))) {
    await saveProject.flush();
    saveProject.cancel();
    closeVideoSession();
  }
  await remove();
  markOffline(paths);
  void refreshRecentProjects();
};

const leaveSessions = () => {
  pause();
  saveProject.flush();
  debouncedSave.flush();
};

const loadProjectFile = async (path: string) => {
  await saveSubmit.catch(() => undefined);
  const project = normalizeProject(await invoke<unknown>(Invokes.VideoLoadProject, { path }));
  if (!project) throw new KnownError(i18n.t('video.toasts.invalidProject'));
  return rootProject(await prepareTimelapses(project));
};

type DraftChoice = 'save' | 'discard' | 'cancel';

const askToSaveDraft = (name: string) =>
  new Promise<DraftChoice>((resolve) => {
    const unsubscribe = useUIStore.subscribe(({ confirmModalState }) => {
      if (confirmModalState.isOpen) return;
      unsubscribe();
      resolve('cancel');
    });
    useUIStore.getState().setUI({
      confirmModalState: {
        isOpen: true,
        title: i18n.t('video.project.saveChanges', { name }),
        confirmText: i18n.t('video.project.save'),
        secondaryText: i18n.t('video.project.dontSave'),
        onConfirm: () => resolve('save'),
        onSecondary: () => resolve('discard'),
      },
    });
  });

let leavePrompt: Promise<boolean> | null = null;

const confirmLeave = () => {
  if (!isProjectSession()) return Promise.resolve(true);
  debouncedSave.flush();
  const state = getVideo();
  if (!isEditedDraft(state)) return Promise.resolve(true);
  pause();
  leavePrompt ??= askToSaveDraft(state.project!.name)
    .then((choice) => (choice === 'save' ? saveOpenProject() : choice === 'discard'))
    .finally(() => {
      leavePrompt = null;
    });
  return leavePrompt;
};

const handOffEditor = () => {
  if (useUIStore.getState().activeView === 'editor' && useEditorStore.getState().selectedImage) {
    editorStale = true;
    return;
  }
  releaseEditor();
  useEditorStore.getState().setEditor({ wgpuPhase: 'hidden' });
};

const enterProjectView = () => {
  if (isProjectSession()) return;
  closeVideoSession();
  handOffEditor();
  useUIStore.getState().enterWorkspace('video');
  revealTimeline();
};

const leaveEmptyProjectView = () => {
  if (getVideo().session) return;
  useUIStore.getState().enterWorkspace('photo');
  useUIStore.getState().setUI({ activeView: 'library' });
};

export const openProjectFile = async (path: string) => {
  if (videoUnavailable()) return;
  const current = claimOpen();
  if (isOpenProject(path)) {
    returnToProject();
    return;
  }
  if (!(await confirmLeave()) || !current()) return;
  leaveSessions();
  enterProjectView();
  try {
    const project = await loadProjectFile(path);
    if (current()) await startProject({ kind: 'project', path, draft: false }, project, current);
  } catch (err) {
    if (!current()) return;
    leaveEmptyProjectView();
    showError('video.toasts.openFailed', err, { retry: () => void openProjectFile(path) });
  }
};

const startNew = async (folder: string, project: VideoProject, current: () => boolean, ask = false) => {
  if (videoUnavailable() || !(await confirmLeave()) || !current()) return;
  leaveSessions();
  enterProjectView();
  const path = await newProjectPath(folder, project.name);
  if (current()) await startProject({ kind: 'project', path, draft: true, ...(ask ? { ask } : {}) }, project, current);
};

export const startNewProject = (folder: string, project: VideoProject) => startNew(folder, project, claimOpen());

export const startNewProjectFrom = async (paths: Array<string>, project: VideoProject) => {
  const current = claimOpen();
  const { folder, ask } = await projectHome(paths.map((path) => ({ path, kind: 'image' })));
  await startNew(folder, project, current, ask);
};

export const projectMedia = (paths: Array<string>) => {
  const usable = paths.filter(isMediaCandidate);
  return usable.some((path) => !isAudioPath(path)) ? usable : [];
};

const inLibraryOrder = (paths: Array<string>) => {
  const order = new Map(
    computeSortedLibrary(useLibraryStore.getState(), useSettingsStore.getState()).map((image, index) => [
      image.path,
      index,
    ]),
  );
  return paths
    .map((path, index) => ({ path, index, rank: order.get(path) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ path }) => path);
};

export const createVideoProject = async (paths: Array<string>) => {
  const usable = projectMedia(inLibraryOrder(paths));
  if (usable.length === 0) return;
  const current = claimOpen();
  try {
    const prepared = await prepareMedia(usable);
    const firstVisual =
      prepared.find((entry) => entry.kind === 'video') ?? prepared.find((entry) => entry.kind === 'image');
    if (!firstVisual || !current()) return;
    const name = fileStem(firstVisual.path);
    const project = withMedia(createProject(name, settingsFor(firstVisual.info)), prepared, { mainIndex: 0 });
    const { folder, ask } = await projectHome(prepared);
    await startNew(folder, project, current, ask);
  } catch (err) {
    if (current()) showError('video.toasts.openFailed', err, { retry: () => void createVideoProject(paths) });
  }
};

export const createEmptyVideoProject = async (folder: string) => {
  try {
    await startNewProject(folder, createProject(i18n.t('video.project.untitled'), settingsFor(undefined)));
  } catch (err) {
    showError('video.toasts.openFailed', err, { retry: () => void createEmptyVideoProject(folder) });
  }
};

export const addToProjectFile = async (path: string, paths: Array<string>) => {
  if (!isOpenProject(path)) await openProjectFile(path);
  if (isOpenProject(path)) {
    const project = getVideo().project!;
    await addMediaToProject(paths, { mainIndex: mainTrack(project).items.length });
  }
};

const releaseEditor = () => {
  const editor = useEditorStore.getState();
  editor.setEditor({
    selectedImage: null,
    finalPreviewUrl: null,
    uncroppedAdjustedPreviewUrl: null,
    histogram: null,
    waveform: null,
    adjustments: INITIAL_ADJUSTMENTS,
    previewOverride: null,
    activeMaskId: null,
    activeMaskContainerId: null,
    activeAiPatchContainerId: null,
    activeAiSubMaskId: null,
    interactivePatch: null,
    ...canvasToolState(),
  });
  editor.resetHistory(INITIAL_ADJUSTMENTS, null);
};

export const closeVideoSession = () => {
  const { session } = getVideo();
  if (!session) return;
  leaveSessions();
  resetSessionState(null, null);
  if (session.kind !== 'project') return;
  releaseEditor();
  useUIStore.getState().enterWorkspace('photo');
  if (session.draft) return;
  window.setTimeout(() => {
    invoke('update_thumbnail_queue', { paths: [session.path] }).catch(console.error);
  }, SAVE_DELAY_MS * 2);
};

export const projectCloseGuard = async () => {
  if (!(await confirmLeave())) return false;
  await Promise.race([saveProject.flush(), new Promise((resolve) => window.setTimeout(resolve, CLOSE_SAVE_WAIT_MS))]);
  return true;
};

let recentProjectsFetchedAt = Number.NEGATIVE_INFINITY;

export const refreshRecentProjects = async () => {
  recentProjectsFetchedAt = performance.now();
  const recentProjects = await invoke<Array<RecentProject>>(Invokes.VideoRecentProjects).catch(() => []);
  setVideo({ recentProjects });
};

export const prefetchRecentProjects = () => {
  if (performance.now() - recentProjectsFetchedAt > RECENT_PROJECTS_TTL_MS) void refreshRecentProjects();
};

const presentProjects = (recent: Array<RecentProject>) => recent.filter((project) => !project.missing);

export const recentProjectsForMenu = (limit = RECENT_PROJECTS_IN_MENU) => {
  prefetchRecentProjects();
  return presentProjects(getVideo().recentProjects).slice(0, limit);
};

export const useRecentProjects = () => useVideoStore(useShallow((state) => presentProjects(state.recentProjects)));

export const clipTrim = () => useEditorStore.getState().adjustments.video ?? null;

const isClipOf = (path: string) => {
  const { session } = getVideo();
  return session?.kind === 'clip' && session.path === path;
};

const startClipSession = async (path: string, retryOffline = false) => {
  const media = await ensureMedia([path], retryOffline && !!getVideo().offline[path]);
  const info = media[path];
  const editorPath = useEditorStore.getState().selectedImage?.path;
  if (!isMovingVideo(info) || editorPath !== path || isProjectSession() || isClipOf(path) || !hasGpuRenderer())
    return false;
  const settings = { ...settingsFor(info), width: info.width, height: info.height };
  const [withRef, ref] = addMedia(createProject(fileStem(path), settings), path, 'video');
  const project = insertMainClips(withRef, [createClipItem(ref, info, settings, null)], 0);
  resetSessionState({ kind: 'clip', path }, project);
  const trim = clipTrim();
  if (trim?.in) setVideo({ playhead: clampPlayhead(project, secondsToTicks(trim.in)) });
  prepareAtPlayhead();
  return true;
};

const endClipSession = () => {
  if (getVideo().session?.kind !== 'clip') return;
  pause();
  resetSessionState(null, null);
};

export const presentItem = (itemId: string) => {
  const { project, media, selection, playhead } = getVideo();
  const item = project && !lookTargetOf(project, selection) ? locateItem(project, itemId)?.item : null;
  if (!project || !item || item.type !== 'clip') return;
  const ref = mediaOf(project, item.media);
  const info = ref && media[ref.path];
  if (!ref || !info) return;
  showInEditor(ref.path, info, lookAt(project, item, playhead), null);
};

export const confirmProjectLeave = () => confirmLeave();

export const leaveProjectForLibrary = () => {
  const { session } = getVideo();
  if (session?.kind !== 'project') return null;
  closeVideoSession();
  return session.path;
};

export const returnToProject = () => {
  if (!isProjectSession()) return;
  revealTimeline();
  void focusPlayhead();
};

export const exitProject = async () => {
  if (!(await confirmLeave())) return;
  const { session } = getVideo();
  if (session?.kind !== 'project') return;
  closeVideoSession();
  useUIStore.getState().setUI({ activeView: 'library' });
  const { imageList, setLibrary } = useLibraryStore.getState();
  if (imageList.some((image) => image.path === session.path)) {
    setLibrary({
      multiSelectedPaths: [session.path],
      libraryActivePath: session.path,
      selectionAnchorPath: session.path,
    });
  }
};

export const routeLibraryOpen = (path: string, open = true) => {
  if (open && isVideoPath(path) && videoUnavailable()) return true;
  if (isProjectPath(path)) {
    if (open) void openProjectFile(path);
    return true;
  }
  if (open) claimOpen();
  leaveProjectForLibrary();
  const reopened = open && isVideoPath(path) && useEditorStore.getState().selectedImage?.path === path;
  if (reopened && !isClipOf(path)) {
    endClipSession();
    void startClipSession(path, true).then((started) => {
      if (started) void focusPlayhead();
    });
  }
  return false;
};

useEditorStore.subscribe((state, prev) => {
  const path = state.selectedImage?.path ?? null;
  if (path !== (prev.selectedImage?.path ?? null) && !isProjectSession()) {
    const { session } = getVideo();
    if (path && isVideoPath(path)) {
      if (session?.kind !== 'clip' || session.path !== path) {
        endClipSession();
        void startClipSession(path);
      }
    } else {
      endClipSession();
    }
  }
});

const syncPanelTargets = () => {
  const { project, selection, session, editorItemId } = getVideo();
  const target = session?.kind === 'project' && project ? lookTargetOf(project, selection) : null;
  if (session?.kind === 'project' && (target?.id ?? null) !== editorItemId) void focusPlayhead();
};

useVideoStore.subscribe((state, prev) => {
  if (state.selection !== prev.selection || state.session !== prev.session || state.project !== prev.project) {
    syncPanelTargets();
  }
});

useVideoStore.subscribe((state, prev) => {
  const { project } = state;
  if (!project || project === prev.project) return;
  const changed = project.media.flatMap((ref) => {
    const info = sequenceInfo(project, ref);
    return info && !isSameValue(info, state.media[ref.path]) ? [[ref.path, info] as const] : [];
  });
  if (changed.length > 0) setVideo((current) => ({ media: { ...current.media, ...Object.fromEntries(changed) } }));
});

useEditorStore.subscribe((state, prev) => {
  if (state.selectedImage?.path !== prev.selectedImage?.path) syncPanelTargets();
});

const refreshShutter = () => {
  const { session, isPlaying } = getVideo();
  if (!session || isPlaying || isProgramView()) return;
  if (JSON.stringify(shutterLook(useEditorStore.getState().adjustments)) !== installedShutter) void focusPlayhead();
};

useEditorStore.subscribe((state, prev) => {
  if (state.adjustments !== prev.adjustments) refreshShutter();
});

useVideoStore.subscribe((state, prev) => {
  if (state.project !== prev.project) refreshShutter();
});

let lastProgramView = false;

const syncViewMode = () => {
  const programView = isProgramView();
  if (programView === lastProgramView) return;
  lastProgramView = programView;
  if (!isProjectSession()) return;
  installedStill = null;
  installedTarget = null;
  editorStale = true;
  void focusPlayhead();
};

useUIStore.subscribe(syncViewMode);
useVideoStore.subscribe(syncViewMode);

let presetsShown = false;

useUIStore.subscribe((state) => {
  const shown = showsPresets(state);
  if (shown === presetsShown) return;
  presetsShown = shown;
  if (shown && isProjectSession()) void focusPlayhead();
});
