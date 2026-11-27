import { invoke } from '@tauri-apps/api/core';
import { Window } from '@tauri-apps/api/window';
import { Invokes } from '../types/invokes';
import { Panel, PanelRegion } from '../types/ui';
import { Caption, CaptionStyle, ClipItem, Ticks, TitleItem, VideoProject, VisualItem } from '../types/video';
import { getDevicePixelRatio } from '../utils/displayScale';
import { captionAsTitle } from '../utils/video/captions';
import { updateItem } from '../utils/video/edit';
import { allTimelines, hasLook, hashString, itemEnd, mainTrack, mediaOf } from '../utils/video/model';
import { TitleRaster, hasTextMotion, rasterizeTitle } from '../utils/video/titles';
import { frameTicks, ticksToSeconds } from '../utils/video/time';
import { reuseLast, withRevision } from '../utils/video/revisions';
import { croppedImageSize, useEditorStore } from './useEditorStore';
import { useSettingsStore } from './useSettingsStore';
import { UIState, getRegionActivePanel, isPanelAvailable, useUIStore } from './useUIStore';
import { useShallow } from 'zustand/react/shallow';
import {
  editorTimeOf,
  getVideo,
  isProjectSession,
  liveLook,
  lookTargetOf,
  notifyFrameError,
  useVideoStore,
} from './useVideoStore';

const CLIP_TOOL_PANELS: Array<Panel> = [Panel.Crop, Panel.Masks, Panel.Ai];
const LOOK_PANELS: Array<Panel> = [Panel.Adjustments, Panel.Presets, ...CLIP_TOOL_PANELS];

type VideoState = ReturnType<typeof getVideo>;

const regionsOf = (state: UIState) => Object.keys(state.activePanels) as Array<PanelRegion>;

const showsAny = (state: UIState, panels: Array<Panel>) =>
  regionsOf(state).some((region) => {
    const panel = getRegionActivePanel(state, region);
    return !!panel && panels.includes(panel);
  });

export const showsCrop = (state: UIState) => showsAny(state, [Panel.Crop]);

export const showsPresets = (state: UIState) => showsAny(state, [Panel.Presets]);

const panelFacts = (state: UIState) => ({
  grading: showsAny(state, LOOK_PANELS),
  clipTool: showsAny(state, CLIP_TOOL_PANELS),
});

const targetFacts = ({ session, project, selection, isPlaying, playhead }: VideoState, playing = isPlaying) => {
  const target = session?.kind === 'project' && project ? lookTargetOf(project, selection) : null;
  return {
    isClip: target?.type === 'clip',
    away: !!project && !!target && !playing && editorTimeOf(project, target, playhead) !== playhead,
  };
};

export interface ViewerMode {
  clipOnly: boolean;
  clipTool: boolean;
  away: boolean;
}

const viewerModeOf = (panels: ReturnType<typeof panelFacts>, target: ReturnType<typeof targetFacts>): ViewerMode => {
  const away = panels.grading && target.away;
  const clipTool = target.isClip && panels.clipTool;
  return { clipOnly: clipTool || (target.isClip && away), clipTool, away };
};

const viewerMode = () => viewerModeOf(panelFacts(useUIStore.getState()), targetFacts(getVideo()));

export const useViewerMode = () => {
  const panels = useUIStore(useShallow(panelFacts));
  const target = useVideoStore(useShallow(targetFacts));
  return viewerModeOf(panels, target);
};

const canvasOf = (state: VideoState) =>
  state.session?.kind === 'project' && state.project
    ? { width: state.project.settings.width, height: state.project.settings.height }
    : null;

export const useProgramCanvas = () => {
  const { clipOnly } = useViewerMode();
  const canvas = useVideoStore(useShallow(canvasOf));
  return clipOnly ? null : canvas;
};

export const programCanvas = () => (viewerMode().clipOnly ? null : canvasOf(getVideo()));

export const isProgramView = () => isProjectSession() && !viewerMode().clipOnly;

export const displayContent = (path: string, program: boolean) => (program ? `${path}#program` : path);

export const shownContent = (path: string | null | undefined) =>
  path ? displayContent(path, programCanvas() !== null) : null;

export type ViewerSource =
  { kind: 'program'; width: number; height: number } | { kind: 'clip'; clip: ClipItem; width: number; height: number };

const shownClipOf = (project: VideoProject, state: VideoState, playing: boolean): ClipItem | null => {
  if (state.session?.kind === 'clip') {
    const clip = mainTrack(project).items[0];
    return clip?.type === 'clip' ? clip : null;
  }
  if (!viewerModeOf(panelFacts(useUIStore.getState()), targetFacts(state, playing)).clipOnly) return null;
  const target = lookTargetOf(project, state.selection);
  return target?.type === 'clip' ? target : null;
};

const clipFrameSize = (project: VideoProject, clip: ClipItem, state: VideoState) => {
  if (state.session?.kind === 'clip' || state.editorItemId === clip.id) {
    const { selectedImage, adjustments } = useEditorStore.getState();
    return croppedImageSize(selectedImage, adjustments.orientationSteps, adjustments.crop);
  }
  const ref = mediaOf(project, clip.media);
  const look = clip.look ? project.looks[clip.look] : null;
  return croppedImageSize(ref ? state.media[ref.path] : null, look?.orientationSteps, look?.crop ?? null);
};

export const viewerSource = (project: VideoProject, playing = getVideo().isPlaying): ViewerSource => {
  const state = getVideo();
  const clip = shownClipOf(project, state, playing);
  if (!clip) return { kind: 'program', width: project.settings.width, height: project.settings.height };
  const size = clipFrameSize(project, clip, state);
  const { width, height } = size && size.width > 0 && size.height > 0 ? size : project.settings;
  return { kind: 'clip', clip, width, height };
};

export const viewerSourceKey = (source: ViewerSource) =>
  source.kind === 'clip' ? `clip:${source.clip.id}:${source.width}x${source.height}` : 'program';

export const leaveClipTools = () => {
  const ui = useUIStore.getState();
  regionsOf(ui).forEach((region) => {
    const panel = getRegionActivePanel(ui, region);
    if (!panel || !CLIP_TOOL_PANELS.includes(panel)) return;
    const layout = ui.panelLayout[region];
    const fallback = layout.includes(Panel.Adjustments)
      ? Panel.Adjustments
      : layout.find((candidate) => !CLIP_TOOL_PANELS.includes(candidate) && isPanelAvailable(ui, candidate));
    if (fallback) ui.setActivePanel(region, fallback);
  });
};

const titleKeys = new WeakMap<TitleItem, { height: number; key: string }>();
const captionTitles = new WeakMap<Caption, { style: CaptionStyle; aspect: number; title: TitleItem }>();

const computeTitleKey = (title: TitleItem, height: number) =>
  `t${hashString(
    JSON.stringify([
      title.text,
      title.font,
      title.size,
      title.color,
      title.bold,
      title.italic,
      title.align,
      title.backdrop,
      height,
      title.outline,
      title.outlineColor,
      title.shadow,
      title.letterSpacing,
      title.lineHeight,
      hasTextMotion(title),
      title.wrapWidth,
    ]),
  )}`;

const titleKey = (title: TitleItem, height: number) => {
  const known = titleKeys.get(title);
  if (known?.height === height) return known.key;
  const key = computeTitleKey(title, height);
  titleKeys.set(title, { height, key });
  return key;
};

const captionTitle = (caption: Caption, style: CaptionStyle, aspect: number) => {
  const known = captionTitles.get(caption);
  if (known?.style === style && known.aspect === aspect) return known.title;
  const title = captionAsTitle(caption, style, aspect);
  captionTitles.set(caption, { style, aspect, title });
  return title;
};

const uploadBody = ({ pixels, units }: TitleRaster) => {
  if (!units) return new Uint8Array(pixels.buffer);
  const body = new Uint8Array(pixels.length + units.pixels.length);
  body.set(pixels);
  body.set(units.pixels, pixels.length);
  return body;
};

const uploadedTitles = new Set<string>();
const pendingTitles = new Map<string, Promise<void>>();
let titleUploads = 0;
let titleFill = 0;

const uploadTitle = async (title: TitleItem, key: string, canvasHeight: number) => {
  const raster = await rasterizeTitle(title, canvasHeight);
  if (!raster) return;
  const evicted = await invoke<Array<string>>(Invokes.VideoUploadTitle, uploadBody(raster), {
    headers: {
      'x-title-key': key,
      'x-title-width': String(raster.width),
      'x-title-height': String(raster.height),
      ...(raster.units
        ? { 'x-title-characters': String(raster.units.characters), 'x-title-words': String(raster.units.words) }
        : {}),
    },
  });
  titleUploads += 1;
  evicted.forEach((stale) => uploadedTitles.delete(stale));
  uploadedTitles.add(key);
};

const uploadTitles = async (
  titles: Array<TitleItem>,
  keys: Record<string, string>,
  canvasHeight: number,
  current = () => true,
) => {
  const unknown = [...new Set(titles.map((title) => keys[title.id]))].filter((key) => !uploadedTitles.has(key));
  if (unknown.length === 0) return;
  const uploads = titleUploads;
  const missing = new Set(await invoke<Array<string>>(Invokes.VideoMissingTitles, { keys: unknown }));
  if (uploads === titleUploads) unknown.filter((key) => !missing.has(key)).forEach((key) => uploadedTitles.add(key));
  for (const title of titles) {
    const key = keys[title.id];
    if (!missing.delete(key) || uploadedTitles.has(key)) continue;
    if (!current()) return;
    const pending =
      pendingTitles.get(key) ?? uploadTitle(title, key, canvasHeight).finally(() => pendingTitles.delete(key));
    pendingTitles.set(key, pending);
    await pending;
  }
};

const isTitle = (item: VisualItem): item is TitleItem => item.type === 'title' && item.text.trim().length > 0;

const titlesOf = (project: VideoProject, canvasHeight: number) => {
  const { width, height } = project.settings;
  const captions = project.captions?.enabled
    ? project.captions.items.map((caption) => captionTitle(caption, project.captions!.style, width / height))
    : [];
  const [own, ...sequences] = allTimelines(project).map((timeline) =>
    timeline.videoTracks.flatMap((track) => track.items),
  );
  const timed = [...own, ...captions].filter(isTitle);
  const nested = sequences.flat().filter(isTitle);
  const keys = Object.fromEntries([...timed, ...nested].map((title) => [title.id, titleKey(title, canvasHeight)]));
  return { timed, nested, keys };
};

export const ensureTitleRasters = async (project: VideoProject, canvasHeight: number) => {
  const { timed, nested, keys } = titlesOf(project, canvasHeight);
  await uploadTitles([...timed, ...nested], keys, canvasHeight);
  return keys;
};

const byStart = (a: TitleItem, b: TitleItem) => a.start - b.start;

const titleKeysAt = async (project: VideoProject, at: Ticks, fill: boolean) => {
  const { height, fps } = project.settings;
  const { timed, nested, keys } = titlesOf(project, height);
  const margin = frameTicks(fps);
  const shown = timed.filter((title) => title.start <= at + margin && itemEnd(title) > at - margin);
  await uploadTitles([...shown, ...nested], keys, height);
  if (fill) {
    const run = ++titleFill;
    const ahead = timed.filter((title) => itemEnd(title) > at).sort(byStart);
    const behind = timed.filter((title) => itemEnd(title) <= at).sort(byStart);
    uploadTitles([...ahead, ...behind], keys, height, () => run === titleFill).catch(console.error);
  }
  return keys;
};

const qualityScale = { auto: 1, full: 1, half: 0.5, quarter: 0.25 } as const;
const PLAYBACK_PIXEL_RATE = 1920 * 1080 * 120;
const VIEWER_WINDOW = 'viewer';

let viewerWindowSide = 0;
let viewerWatch = 0;
let stopViewerWatch = () => {};

const setViewerWindowSide = (side: number) => {
  if (side === viewerWindowSide) return;
  viewerWindowSide = side;
  void requestProgramFrame(true);
};

const releaseViewerVideo = (state: VideoState, prev: VideoState) => {
  if (prev.session && !state.session) invoke(Invokes.ReleaseViewerVideo).catch(console.error);
};

const watchViewer = async (watch: number) => {
  const viewer = await Window.getByLabel(VIEWER_WINDOW);
  if (!viewer) return;
  const unlisten = await viewer.onResized(({ payload }) =>
    setViewerWindowSide(Math.max(payload.width, payload.height)),
  );
  const unsubscribe = useVideoStore.subscribe(releaseViewerVideo);
  const stop = () => {
    unlisten();
    unsubscribe();
  };
  if (watch !== viewerWatch) return stop();
  stopViewerWatch = stop;
  const { width, height } = await viewer.innerSize();
  if (watch === viewerWatch) setViewerWindowSide(Math.max(width, height));
};

useUIStore.subscribe((state, prev) => {
  if (state.isViewerOpen === prev.isViewerOpen) return;
  viewerWatch += 1;
  stopViewerWatch();
  stopViewerWatch = () => {};
  if (state.isViewerOpen) watchViewer(viewerWatch).catch(console.error);
  else setViewerWindowSide(0);
});

const viewerResolution = (project: VideoProject) => {
  const { playbackQuality } = getVideo();
  const longest = Math.max(project.settings.width, project.settings.height);
  if (playbackQuality !== 'auto') return Math.round(longest * qualityScale[playbackQuality]);
  const { displaySize } = useEditorStore.getState();
  const viewer = Math.max(Math.max(displaySize.width, displaySize.height) * getDevicePixelRatio(), viewerWindowSide);
  return viewer > 0 ? Math.min(longest, Math.round(viewer)) : null;
};

export const viewRequest = async (project: VideoProject, compare = true, fill = false, program = true) => {
  const { editorItemId, useProxies, session, playhead } = getVideo();
  const editor = useEditorStore.getState();
  const showOriginal = compare && editor.showOriginal;
  const items = project.videoTracks.flatMap((track) => track.items);
  const lookOverrides: Record<string, unknown> = {};
  if (showOriginal) {
    items.forEach((item) => {
      if (hasLook(item)) lookOverrides[item.id] = null;
    });
  } else if (editorItemId) {
    lookOverrides[editorItemId] = liveLook(project, editorItemId, editor.adjustments);
  }
  return {
    targetResolution: viewerResolution(project),
    contentPath: displayContent(editor.selectedImage?.path ?? session?.path ?? '', program),
    titleKeys: await titleKeysAt(project, playhead, fill),
    useProxies,
    lookOverrides,
    scopePath: session?.path ?? null,
  };
};

const playbackResolution = (project: VideoProject) => {
  const viewer = viewerResolution(project);
  if (getVideo().playbackQuality !== 'auto') return viewer;
  const { width, height, fps } = project.settings;
  const pixelRate = width * height * (fps.num / Math.max(1, fps.den));
  const budget = Math.round(Math.max(width, height) * Math.min(1, Math.sqrt(PLAYBACK_PIXEL_RATE / pixelRate)));
  return Math.min(viewer ?? budget, budget);
};

export const playbackViewRequest = async (project: VideoProject) => ({
  ...(await viewRequest(project, true, true, viewerSource(project, true).kind === 'program')),
  targetResolution: playbackResolution(project),
  adaptive: getVideo().playbackQuality === 'auto',
});

let rendering = false;
let queued = false;
let renderedInputs: Array<unknown> | null = null;
let hiddenLayer: string | null = null;

export const hideLayer = (itemId: string | null) => {
  if (hiddenLayer === itemId) return;
  hiddenLayer = itemId;
  void requestProgramFrame();
};

const withoutHiddenLayer = reuseLast((project: VideoProject, hidden: string | null) =>
  hidden
    ? updateItem<VisualItem>(project, hidden, (item) =>
        'transform' in item ? { ...item, transform: { ...item.transform, opacity: { value: 0 } } } : item,
      )
    : project,
);

const programInputs = () => {
  const { project, playhead, editorItemId, useProxies, playbackQuality, session } = getVideo();
  const { adjustments, showOriginal, displaySize, selectedImage, isWaveformVisible, displayRevision } =
    useEditorStore.getState();
  const settings = useSettingsStore.getState().appSettings;
  return [
    hiddenLayer,
    viewerWindowSide,
    project,
    playhead,
    editorItemId,
    useProxies,
    playbackQuality,
    session,
    adjustments,
    showOriginal,
    displaySize,
    selectedImage?.path,
    isWaveformVisible,
    displayRevision,
    settings?.hdrDisplay,
    settings?.gainMapMode,
    settings?.displayColorMode,
    settings?.displayIccProfile,
    settings?.wideGamutPreview,
  ];
};

const rendersInputs = (inputs: Array<unknown>) =>
  !!renderedInputs && renderedInputs.every((value, index) => value === inputs[index]);

const renderOnce = async () => {
  const { project, playhead, isPlaying } = getVideo();
  if (!project || isPlaying || !isProgramView()) return;
  renderedInputs = programInputs();
  const view = await viewRequest(project);
  await withRevision(withoutHiddenLayer(project, hiddenLayer), (revision) =>
    invoke(Invokes.VideoRenderFrame, { request: { revision, time: ticksToSeconds(playhead), view } }),
  );
};

export const requestProgramFrame = async (unlessRendered = false) => {
  if (unlessRendered && rendersInputs(programInputs())) return;
  if (rendering) {
    queued = true;
    return;
  }
  rendering = true;
  try {
    do {
      queued = false;
      await renderOnce().catch((err) => {
        renderedInputs = null;
        notifyFrameError(err);
      });
    } while (queued);
  } finally {
    rendering = false;
  }
};
