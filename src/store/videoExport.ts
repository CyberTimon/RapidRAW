import { create } from 'zustand';
import { Channel, invoke } from '@tauri-apps/api/core';
import { DialogFilter, open } from '@tauri-apps/plugin-dialog';
import i18n from 'i18next';
import { toast } from 'react-toastify';
import { errorReason, showError } from '../utils/errors';
import { Invokes } from '../types/invokes';
import {
  AudioCodec,
  DynamicRange,
  EncoderInfo,
  LoudnessTarget,
  Ticks,
  VideoCodec,
  VideoContainer,
  VideoExportPreset,
  VideoExportSettings,
  VideoProject,
  VideoQuality,
  VideoResolution,
} from '../types/video';
import { Adjustments, INITIAL_ADJUSTMENTS } from '../utils/adjustments';
import { getCroppedDimensions } from '../utils/cropUtils';
import { assignLook, withFrameRate } from '../utils/video/edit';
import {
  clipSettingsOf,
  createClipItem,
  createMediaRef,
  createProject,
  even,
  fileName,
  isMovingVideo,
  locateItem,
  mediaOf,
  settingsFor,
  trimRange,
} from '../utils/video/model';
import {
  FRAME_RATES,
  formatTimecode,
  frameTicks,
  rateFromNumber,
  snapTicks,
  ticksToSeconds,
} from '../utils/video/time';
import { debouncedSave, useEditorStore } from './useEditorStore';
import { useSettingsStore } from './useSettingsStore';
import { chooseSavePath, ensureMedia, fileStem, folderOf, getVideo, joinPath, readSidecarLook } from './useVideoStore';
import { VideoTaskHandle, startVideoTask } from './videoJobs';
import { CLIP_LOOK, pause, playbackProject } from './videoPlayback';
import { ensureTitleRasters, viewRequest } from './videoView';
import { rootProject } from '../utils/video/nesting';
import { withRevision } from '../utils/video/revisions';
import { prepareImmichExport } from '../utils/immichApi';

export type VideoExportStatus = 'idle' | 'exporting' | 'cancelling' | 'success' | 'error' | 'cancelled';
export type VideoExportStage = 'encoding' | 'measuring' | 'uploading';
export type VideoExportTarget = { kind: 'project' } | { kind: 'videos'; paths: Array<string> };

export interface VideoOutputOptions {
  destination: 'customFolder' | 'originalFolder' | 'immich';
  subfolder: string;
  filenameTemplate: string;
  lastExportPath: string | null;
  immichAlbum: string;
}

export interface VideoExportError {
  message: string;
  kept: string | null;
}

const immichExportFolder = (options: VideoOutputOptions) => prepareImmichExport(options.immichAlbum, false);

const fileNameStem = (name: string) =>
  name.replace(/[<>:"/\\|?*\p{Cc}]/gu, '_').replace(/^[\s.]+|[\s.]+$/g, '') || i18n.t('video.project.untitled');

export const VIDEO_CODECS: Array<{ id: VideoCodec; label: string }> = [
  { id: 'h264', label: 'H.264' },
  { id: 'hevc', label: 'HEVC' },
  { id: 'av1', label: 'AV1' },
  { id: 'proRes', label: 'ProRes' },
  { id: 'vp9', label: 'VP9' },
];
export const VIDEO_CONTAINERS: Record<VideoCodec, Array<VideoContainer>> = {
  h264: ['mp4', 'mov', 'mkv'],
  hevc: ['mp4', 'mov', 'mkv'],
  av1: ['mp4', 'mkv', 'webm'],
  proRes: ['mov'],
  vp9: ['webm', 'mkv', 'mp4'],
};
export const AUDIO_CODECS: Record<VideoContainer, Array<AudioCodec>> = {
  mp4: ['aac'],
  mov: ['aac', 'pcm'],
  mkv: ['aac', 'opus', 'pcm'],
  webm: ['opus'],
};
const CODEC_AUDIO: Record<VideoCodec, AudioCodec> = {
  h264: 'aac',
  hevc: 'aac',
  av1: 'aac',
  proRes: 'pcm',
  vp9: 'opus',
};
const AUDIO_DEFAULT_KBPS: Record<AudioCodec, number> = { aac: 192, opus: 160, pcm: 0 };
const PCM_BITS_PER_SECOND = 48000 * 2 * 16;
export const AUDIO_BITRATES = [128, 160, 192, 256, 320];
export const VIDEO_QUALITIES: Array<VideoQuality> = ['high', 'medium', 'low'];
export const VIDEO_RESOLUTIONS: Array<VideoResolution> = ['original', '2160', '1440', '1080', '720', 'custom'];
export const ORIGINAL_FRAME_RATE = 'original';
export const MIN_EXPORT_SIZE = 16;
export const MAX_EXPORT_SIZE = 8192;
export const MAX_BITRATE_MBPS = 500;
export const LOUDNESS_TARGETS: Array<{ id: LoudnessTarget; lufs: number | null }> = [
  { id: 'off', lufs: null },
  { id: 'streaming', lufs: -14 },
  { id: 'podcast', lufs: -16 },
  { id: 'broadcast', lufs: -23 },
];

type PresetSettings = Omit<VideoExportSettings, 'preset' | 'bitrate' | 'width' | 'height' | 'lockAspect'>;

interface VideoExportPresetSpec {
  id: Exclude<VideoExportPreset, 'custom'>;
  aspect: [number, number] | null;
  maxFps: number | null;
  settings: PresetSettings;
}

const SOCIAL_FPS = 60;
const SOCIAL: Omit<PresetSettings, 'resolution'> = {
  codec: 'h264',
  container: 'mp4',
  rateControl: 'quality',
  quality: 'high',
  frameRate: ORIGINAL_FRAME_RATE,
  audioCodec: 'aac',
  audioBitrate: AUDIO_DEFAULT_KBPS.aac,
  dynamicRange: 'sdr',
  loudness: 'streaming',
};

export const VIDEO_EXPORT_PRESETS: Array<VideoExportPresetSpec> = [
  { id: 'youtube', aspect: [16, 9], maxFps: SOCIAL_FPS, settings: { ...SOCIAL, resolution: 'original' } },
  { id: 'youtubeShorts', aspect: [9, 16], maxFps: SOCIAL_FPS, settings: { ...SOCIAL, resolution: '1080' } },
  { id: 'instagramReels', aspect: [9, 16], maxFps: SOCIAL_FPS, settings: { ...SOCIAL, resolution: '1080' } },
  { id: 'instagramPost', aspect: [4, 5], maxFps: SOCIAL_FPS, settings: { ...SOCIAL, resolution: '1080' } },
  { id: 'tiktok', aspect: [9, 16], maxFps: SOCIAL_FPS, settings: { ...SOCIAL, resolution: '1080' } },
  {
    id: 'archive',
    aspect: null,
    maxFps: null,
    settings: {
      codec: 'proRes',
      container: 'mov',
      rateControl: 'quality',
      quality: 'high',
      resolution: 'original',
      frameRate: ORIGINAL_FRAME_RATE,
      audioCodec: 'pcm',
      audioBitrate: AUDIO_DEFAULT_KBPS.aac,
      dynamicRange: 'hlg',
      loudness: 'off',
    },
  },
];

export const presetOf = (preset: VideoExportPreset) =>
  VIDEO_EXPORT_PRESETS.find((entry) => entry.id === preset) ?? null;

const PROGRESS_INTERVAL_MS = 100;
const RESULT_RESET_MS = 5000;

export const supportsBitrate = (codec: VideoCodec) => codec !== 'proRes';

const defaultAudio = (codec: VideoCodec, container: VideoContainer) =>
  AUDIO_CODECS[container].includes(CODEC_AUDIO[codec]) ? CODEC_AUDIO[codec] : AUDIO_CODECS[container][0];

interface VideoExportState extends VideoExportSettings {
  span: 'all' | 'range';
  status: VideoExportStatus;
  current: number;
  total: number;
  frame: number;
  frames: number;
  stage: VideoExportStage;
  label: string;
  outputs: Array<string>;
  errors: Array<VideoExportError>;
  encoders: Array<EncoderInfo> | null;
}

export const useVideoExportStore = create<VideoExportState>(() => ({
  preset: 'custom',
  codec: 'h264',
  container: 'mp4',
  rateControl: 'quality',
  quality: 'high',
  bitrate: 20,
  dynamicRange: 'sdr',
  resolution: 'original',
  width: 1920,
  height: 1080,
  lockAspect: true,
  frameRate: ORIGINAL_FRAME_RATE,
  audioCodec: 'aac',
  audioBitrate: AUDIO_DEFAULT_KBPS.aac,
  loudness: 'off',
  span: 'range',
  status: 'idle',
  current: 0,
  total: 0,
  frame: 0,
  frames: 0,
  stage: 'encoding',
  label: '',
  outputs: [],
  errors: [],
  encoders: null,
}));

const setExport = (update: Partial<VideoExportState>) => useVideoExportStore.setState(update);

const settingsOf = (source: VideoExportSettings): VideoExportSettings => ({
  preset: source.preset,
  codec: source.codec,
  container: source.container,
  rateControl: source.rateControl,
  quality: source.quality,
  bitrate: source.bitrate,
  resolution: source.resolution,
  width: source.width,
  height: source.height,
  lockAspect: source.lockAspect,
  frameRate: source.frameRate,
  audioCodec: source.audioCodec,
  audioBitrate: source.audioBitrate,
  dynamicRange: source.dynamicRange,
  loudness: source.loudness,
});

const withValidFormat = (settings: VideoExportSettings, resetAudio: boolean): VideoExportSettings => {
  const containers = VIDEO_CONTAINERS[settings.codec];
  const container = containers.includes(settings.container) ? settings.container : containers[0];
  const keepAudio = !resetAudio && AUDIO_CODECS[container].includes(settings.audioCodec);
  const audioCodec = keepAudio ? settings.audioCodec : defaultAudio(settings.codec, container);
  const audioBitrate =
    audioCodec === settings.audioCodec
      ? settings.audioBitrate
      : AUDIO_DEFAULT_KBPS[audioCodec] || settings.audioBitrate;
  return { ...settings, container, audioCodec, audioBitrate };
};

const withUsableCodec = (settings: VideoExportSettings): VideoExportSettings => {
  const { encoders } = useVideoExportStore.getState();
  return !encoders?.length || encoders.some((encoder) => encoder.codec === settings.codec)
    ? settings
    : withValidFormat({ ...settings, codec: encoders[0].codec, preset: 'custom' }, true);
};

export const changeVideoExport = (update: Partial<VideoExportSettings>) => {
  const current = settingsOf(useVideoExportStore.getState());
  const resetAudio = !!update.codec && update.codec !== current.codec && !update.audioCodec;
  setExport(withValidFormat({ ...current, ...update, preset: 'custom' }, resetAudio));
};

export const applyVideoExportPreset = (preset: VideoExportPreset) =>
  setExport({ preset, ...presetOf(preset)?.settings });

let settingsRestored = false;

export const restoreVideoExportSettings = (saved: Partial<VideoExportSettings> | undefined) => {
  if (settingsRestored || !saved) return;
  settingsRestored = true;
  setExport(withUsableCodec(withValidFormat(settingsOf({ ...useVideoExportStore.getState(), ...saved }), false)));
};

export const rememberVideoExportSettings = () => {
  const { appSettings, handleSettingsChange } = useSettingsStore.getState();
  if (appSettings)
    void handleSettingsChange({ ...appSettings, videoExport: settingsOf(useVideoExportStore.getState()) });
};

let encodersRequested = false;

export const loadVideoEncoders = () => {
  if (encodersRequested) return;
  encodersRequested = true;
  invoke<Array<EncoderInfo>>(Invokes.VideoEncoders)
    .then((encoders) => {
      setExport({ encoders });
      setExport(withUsableCodec(settingsOf(useVideoExportStore.getState())));
    })
    .catch((error) => {
      encodersRequested = false;
      console.error(error);
    });
};

export const DYNAMIC_RANGES: Array<DynamicRange> = ['sdr', 'hlg', 'pq'];

export const supportsHdr = (codec: VideoCodec, encoders: Array<EncoderInfo> | null) =>
  codec !== 'h264' && (!encoders || encoders.some((encoder) => encoder.codec === codec && encoder.tenBit));

export const isVideoExportBusy = (status: VideoExportStatus) => status === 'exporting' || status === 'cancelling';

type SizeSettings = Pick<VideoExportSettings, 'resolution' | 'width' | 'height' | 'lockAspect'>;

export const outputCanvas = (width: number, height: number, settings: SizeSettings) => {
  if (settings.resolution === 'custom') {
    return {
      width: even(settings.width),
      height: even(settings.lockAspect ? (settings.width * height) / Math.max(1, width) : settings.height),
    };
  }
  if (settings.resolution === 'original') return { width: even(width), height: even(height) };
  const scale = Number(settings.resolution) / Math.max(1, Math.min(width, height));
  return { width: even(width * scale), height: even(height * scale) };
};

const QUALITY_BITS_PER_PIXEL = [0.14, 0.09, 0.055];
const PRORES_BITS_PER_PIXEL = [3.54, 2.37, 1.64];

export const videoBitsPerSecond = (
  settings: Pick<VideoExportSettings, 'codec' | 'rateControl' | 'quality' | 'bitrate'>,
  pixelsPerSecond: number,
) => {
  const level = VIDEO_QUALITIES.indexOf(settings.quality);
  if (settings.codec === 'proRes') return PRORES_BITS_PER_PIXEL[level] * pixelsPerSecond;
  if (settings.rateControl === 'bitrate') return settings.bitrate * 1e6;
  return QUALITY_BITS_PER_PIXEL[level] * (settings.codec === 'h264' ? 1 : 0.7) * pixelsPerSecond;
};

export const audioBitsPerSecond = (settings: Pick<VideoExportSettings, 'audioCodec' | 'audioBitrate'>) =>
  settings.audioCodec === 'pcm' ? PCM_BITS_PER_SECOND : settings.audioBitrate * 1000;

export const exportFrameRate = (frameRate: string) => FRAME_RATES.find((entry) => entry.label === frameRate)?.rate;

const withSequence = (template: string, index: number, total: number) =>
  template.replaceAll('{sequence}', String(index + 1).padStart(String(total).length, '0'));

const uniqueOutputs = (outputs: Array<string>) => {
  const seen = new Set<string>();
  return outputs.map((output) => {
    let candidate = output;
    for (let copy = 2; seen.has(candidate.toLowerCase()); copy++) {
      candidate = output.replace(/(\.[^.\\/]+)$/, `_${copy}$1`);
    }
    seen.add(candidate.toLowerCase());
    return candidate;
  });
};

const lookFor = async (path: string): Promise<Adjustments> => {
  const editor = useEditorStore.getState();
  if (editor.selectedImage?.path === path && getVideo().session?.kind !== 'project') {
    return structuredClone(editor.adjustments);
  }
  return (await readSidecarLook(path)) ?? structuredClone(INITIAL_ADJUSTMENTS);
};

type ExportSnapshot = VideoExportSettings & Pick<VideoExportState, 'span'>;

const exportSnapshot = (): ExportSnapshot => {
  const state = useVideoExportStore.getState();
  return { ...settingsOf(state), span: state.span };
};

const buildVideoProject = async (path: string, output: ExportSnapshot): Promise<VideoProject> => {
  const info = (await ensureMedia([path]))[path];
  if (!isMovingVideo(info)) throw new Error(i18n.t('video.export.unreadable'));
  const look = await lookFor(path);
  const frame = getCroppedDimensions(info.width, info.height, look.orientationSteps || 0, look.crop);
  const fps = rateFromNumber(info.fps > 0 ? info.fps : 30);
  const project = createProject(fileStem(path), {
    ...settingsFor(info),
    ...outputCanvas(frame.width, frame.height, output),
    fps,
  });
  const media = createMediaRef(path, 'video');
  const clip = createClipItem(media, info, project.settings, CLIP_LOOK);
  const settings = clipSettingsOf(look.video);
  const [start, end] = trimRange(settings, clip.duration);
  const sourceIn = snapTicks(start, fps);
  const duration = Math.max(frameTicks(fps), Math.min(snapTicks(end, fps), clip.duration) - sourceIn);
  return {
    ...project,
    media: [media],
    looks: { [CLIP_LOOK]: look },
    videoTracks: [{ ...project.videoTracks[0], items: [{ ...clip, sourceIn, duration, muted: settings.muted }] }],
  };
};

const buildProjectExport = (output: ExportSnapshot): VideoProject | null => {
  const { project, session, editorItemId } = getVideo();
  if (!project || session?.kind !== 'project') return null;
  const editor = useEditorStore.getState();
  const item = editorItemId ? locateItem(project, editorItemId)?.item : null;
  const withLook = rootProject(
    item?.type === 'clip' && mediaOf(project, item.media)?.path === editor.selectedImage?.path
      ? assignLook(project, item.id, editor.adjustments)[0]
      : project,
  );
  return {
    ...withLook,
    settings: {
      ...withLook.settings,
      ...outputCanvas(withLook.settings.width, withLook.settings.height, output),
    },
  };
};

interface ExportJob {
  label: string;
  output: string;
  source?: string;
  keepFolder: string | null;
  build: (settings: ExportSnapshot) => Promise<VideoProject>;
}

const isExportFailure = (error: unknown): error is VideoExportError =>
  typeof error === 'object' && error !== null && 'message' in error && 'kept' in error;

const failureOf = (error: unknown): VideoExportError => {
  if (!isExportFailure(error)) return { message: errorReason(error), kept: null };
  const reason = errorReason(error.message);
  return {
    message: error.kept ? i18n.t('video.export.keptLocally', { reason, folder: folderOf(error.kept) }) : reason,
    kept: error.kept,
  };
};

const STAGE_TASKS: Record<VideoExportStage, string> = {
  encoding: 'export',
  measuring: 'loudness',
  uploading: 'upload',
};

let cancelRequested = false;
let resetTimer: ReturnType<typeof setTimeout> | undefined;

const capFrameRate = (project: VideoProject, maxFps: number | null) => {
  const { fps } = project.settings;
  const step = maxFps ? Math.ceil(fps.num / (fps.den * maxFps)) : 1;
  return step > 1 ? withFrameRate(project, { num: fps.num, den: fps.den * step }) : project;
};

const renderVideo = async (
  built: VideoProject,
  job: ExportJob,
  settings: ExportSnapshot,
  onFrame: (fraction: number, stage: VideoExportStage) => void,
) => {
  const { codec, quality, dynamicRange, span, preset, loudness, frameRate } = settings;
  const { encoders } = useVideoExportStore.getState();
  const rate = exportFrameRate(frameRate);
  const project = rate ? withFrameRate(built, rate) : capFrameRate(built, presetOf(preset)?.maxFps ?? null);
  const { media } = getVideo();
  const hdrSource = project.media.some((entry) => media[entry.path]?.hdr);
  const dynamic = hdrSource && dynamicRange !== 'sdr' && supportsHdr(codec, encoders) ? dynamicRange : 'sdr';
  const onProgress = new Channel<{ frame: number; total: number; stage: VideoExportStage }>();
  let lastUpdate = 0;
  onProgress.onmessage = ({ frame, total, stage }) => {
    if (cancelRequested) {
      invoke(Invokes.VideoCancelExport).catch(console.error);
      return;
    }
    const now = performance.now();
    const sameStage = stage === useVideoExportStore.getState().stage;
    if (now - lastUpdate < PROGRESS_INTERVAL_MS && frame < total && sameStage) return;
    lastUpdate = now;
    setExport({ frame, frames: total, stage });
    onFrame(total > 0 ? frame / total : 0, stage);
  };
  const titleKeys = await ensureTitleRasters(project, project.settings.height);
  return invoke<string>(Invokes.VideoExport, {
    request: {
      project,
      outputPath: job.output,
      source: job.source,
      keepFolder: job.keepFolder,
      codec,
      container: settings.container,
      quality,
      bitRate: settings.rateControl === 'bitrate' && supportsBitrate(codec) ? Math.round(settings.bitrate * 1e6) : null,
      audioCodec: settings.audioCodec,
      audioBitRate: settings.audioCodec === 'pcm' ? null : settings.audioBitrate * 1000,
      titleKeys,
      dynamic,
      range:
        span === 'range' && project.range
          ? [ticksToSeconds(project.range.start), ticksToSeconds(project.range.end)]
          : null,
      loudness: LOUDNESS_TARGETS.find((target) => target.id === loudness)?.lufs ?? null,
    },
    onProgress,
  });
};

const finishTask = (task: VideoTaskHandle, status: VideoExportStatus, errors: Array<VideoExportError>) =>
  task.finish(
    status === 'cancelled' ? 'cancelled' : errors.length > 0 ? 'failed' : 'done',
    errors.length > 0 ? errors.map((error) => error.message).join('\n') : null,
  );

const runQueue = async (jobs: Array<ExportJob>, uploads: boolean) => {
  const settings = exportSnapshot();
  cancelRequested = false;
  clearTimeout(resetTimer);
  pause();
  debouncedSave.flush();
  setExport({ status: 'exporting', current: 0, total: jobs.length, frame: 0, frames: 0, outputs: [], errors: [] });
  const task = startVideoTask(
    'export',
    jobs.length > 1 ? i18n.t('video.export.videoCount', { count: jobs.length }) : jobs[0].label,
    cancelVideoExport,
  );
  const outputs: Array<string> = [];
  const errors: Array<VideoExportError> = [];
  for (const [index, job] of jobs.entries()) {
    if (cancelRequested) break;
    setExport({ current: index, frame: 0, frames: 0, stage: 'encoding', label: job.label });
    task.update({ kind: STAGE_TASKS.encoding, progress: index / jobs.length });
    try {
      const project = await job.build(settings);
      if (cancelRequested) break;
      const output = await renderVideo(project, job, settings, (fraction, stage) =>
        task.update({ kind: STAGE_TASKS[stage], progress: (index + fraction) / jobs.length }),
      );
      outputs.push(output);
    } catch (error) {
      const failure = failureOf(error);
      if (!cancelRequested || failure.kept) {
        console.error(error);
        errors.push(jobs.length > 1 ? { ...failure, message: `${job.label}: ${failure.message}` } : failure);
      }
      if (cancelRequested) break;
    }
  }
  const status: VideoExportStatus = cancelRequested
    ? 'cancelled'
    : errors.length > 0 && outputs.length === 0
      ? 'error'
      : 'success';
  setExport({ status, outputs: uploads ? [] : outputs, errors });
  finishTask(task, status, errors);
  resetTimer = setTimeout(() => setExport({ status: 'idle' }), RESULT_RESET_MS);
};

const chooseOutputFile = (
  name: string,
  extension: string,
  folder: string | null,
  title = i18n.t('video.export.saveTitle'),
  filters: Array<DialogFilter> = [{ name: i18n.t('video.export.videoFile'), extensions: [extension] }],
) => chooseSavePath(name, extension, folder, title, filters);

const resolveVideoOutputs = async (paths: Array<string>, options: VideoOutputOptions) => {
  const extension = useVideoExportStore.getState().container;
  const stems = await Promise.all(
    paths.map((path, index) =>
      invoke<string>(Invokes.ResolveExportFileStem, {
        path,
        filenameTemplate: withSequence(options.filenameTemplate, index, paths.length),
      }),
    ),
  );
  const names = stems.map((stem) => `${stem}.${extension}`);
  const inFolder = (folder: string) => uniqueOutputs(names.map((name) => joinPath(folder, name)));
  if (options.destination === 'immich') {
    return { outputs: inFolder(await immichExportFolder(options)), folder: null };
  }
  if (options.destination === 'originalFolder') {
    const subfolder = options.subfolder.trim();
    const folders = paths.map((path) => joinPath(folderOf(path), subfolder));
    if (subfolder) {
      await Promise.all(
        [...new Set(folders)].map((folder) => invoke(Invokes.CreateFolder, { path: folder }).catch(() => undefined)),
      );
    }
    return { outputs: uniqueOutputs(folders.map((folder, index) => joinPath(folder, names[index]))), folder: null };
  }
  if (paths.length === 1) {
    const chosen = await chooseOutputFile(names[0], extension, options.lastExportPath);
    return chosen ? { outputs: [chosen], folder: folderOf(chosen) } : null;
  }
  const folder = await open({
    title: i18n.t('video.export.selectFolder', { count: paths.length }),
    directory: true,
    defaultPath: options.lastExportPath ?? undefined,
  });
  if (typeof folder !== 'string') return null;
  return { outputs: inFolder(folder), folder };
};

const failBeforeStart = (error: unknown) => {
  clearTimeout(resetTimer);
  console.error(error);
  setExport({ status: 'error', outputs: [], errors: [failureOf(error)] });
  resetTimer = setTimeout(() => setExport({ status: 'idle' }), RESULT_RESET_MS);
  return null;
};

export const exportVideos = async (paths: Array<string>, options: VideoOutputOptions) => {
  if (paths.length === 0 || isVideoExportBusy(useVideoExportStore.getState().status)) return null;
  try {
    const resolved = await resolveVideoOutputs(paths, options);
    if (!resolved) return null;
    void runQueue(
      paths.map((path, index) => ({
        label: fileName(path),
        output: resolved.outputs[index],
        source: path,
        keepFolder: options.lastExportPath,
        build: (settings) => buildVideoProject(path, settings),
      })),
      options.destination === 'immich',
    );
    return { folder: resolved.folder };
  } catch (error) {
    return failBeforeStart(error);
  }
};

export const exportProjectVideo = async (options: VideoOutputOptions) => {
  const { project } = getVideo();
  if (!project || isVideoExportBusy(useVideoExportStore.getState().status)) return null;
  try {
    const extension = useVideoExportStore.getState().container;
    const name = `${fileNameStem(project.name)}.${extension}`;
    const uploads = options.destination === 'immich';
    const output = uploads
      ? joinPath(await immichExportFolder(options), name)
      : await chooseOutputFile(name, extension, options.lastExportPath);
    if (!output) return null;
    void runQueue(
      [
        {
          label: project.name,
          output,
          keepFolder: options.lastExportPath,
          build: async (settings) => {
            const request = buildProjectExport(settings);
            if (!request) throw new Error(i18n.t('video.export.emptyTimeline'));
            return request;
          },
        },
      ],
      uploads,
    );
    return { folder: uploads ? null : folderOf(output) };
  } catch (error) {
    return failBeforeStart(error);
  }
};

const FRAME_FILTERS: Array<DialogFilter> = [
  { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
  { name: 'PNG', extensions: ['png'] },
  { name: 'TIFF', extensions: ['tif', 'tiff'] },
];

const saveFrame = async (project: VideoProject, playhead: Ticks, output: string) => {
  try {
    const request = playbackProject(project);
    const view = await viewRequest(request, false);
    await withRevision(request, (revision) =>
      invoke(Invokes.VideoExportFrame, {
        request: {
          revision,
          time: ticksToSeconds(playhead),
          view: { ...view, targetResolution: null, useProxies: false, scopePath: null },
        },
        path: output,
      }),
    );
    toast.success(i18n.t('video.frame.saved', { file: fileName(output) }));
  } catch (error) {
    showError('video.frame.failed', error, { retry: () => void saveFrame(project, playhead, output) });
  }
};

export const exportVideoFrame = async () => {
  const { project, session } = getVideo();
  if (!project || !session) return;
  pause();
  const { playhead } = getVideo();
  const stem = session.kind === 'project' ? project.name : fileStem(session.path);
  const timecode = formatTimecode(playhead, project.settings.fps).replaceAll(':', '-');
  const output = await chooseOutputFile(
    `${stem} ${timecode}.jpg`,
    'jpg',
    folderOf(session.path),
    i18n.t('video.frame.export'),
    FRAME_FILTERS,
  );
  if (output) await saveFrame(project, playhead, output);
};

export const cancelVideoExport = () => {
  if (useVideoExportStore.getState().status !== 'exporting') return;
  cancelRequested = true;
  setExport({ status: 'cancelling' });
  invoke(Invokes.VideoCancelExport).catch(console.error);
};
