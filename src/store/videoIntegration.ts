import { useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';
import i18n from 'i18next';
import { ListPlus } from 'lucide-react';
import type { Active } from '@dnd-kit/core';
import { draggedPaths } from '../components/video/timeline/drop';
import { SelectedImage } from '../types/editor';
import { Invokes } from '../types/invokes';
import { Mask, MaskType } from '../types/masks';
import { OPTION_SEPARATOR, Option, Panel } from '../types/ui';
import { Adjustments, MaskContainer } from '../utils/adjustments';
import { KEYBIND_DEFINITIONS, comboMapFor } from '../utils/keyboardUtils';
import { TrackedContainer, VIDEO_AI_MASKS } from '../utils/video/maskTracking';
import { fileName, frameSourceTime, locateItem, mediaOf } from '../utils/video/model';
import { lookItemName } from '../utils/video/items';
import { fpsLabel, roundFps, ticksToSeconds } from '../utils/video/time';
import { useEditorStore } from './useEditorStore';
import { useLibraryStore } from './useLibraryStore';
import { isPanelVisible, useUIStore, type UIState } from './useUIStore';
import {
  addMediaToPool,
  addToProjectFile,
  cancelPendingOpen,
  closeVideoSession,
  currentProjectPath,
  leaveProjectForLibrary,
  editorTimeOf,
  fileStem,
  getVideo,
  goToProjectHistory,
  isAudioPath,
  isMediaCandidate,
  isProjectPath,
  isProjectViewPath,
  isVideoPath,
  openProjectMedia,
  recentProjectsForMenu,
  redoProject,
  returnToProject,
  setVideo,
  undoProject,
  useLookTargetType,
  useVideoStore,
} from './useVideoStore';
import { copyLook, pasteCopiedLookToEditor, pasteLook, pasteLookToSelection } from './videoEditing';
import {
  VideoTask,
  jobTasks,
  clearFinishedVideoJobs,
  isActiveJob,
  markVideoJobsSeen,
  useVideoJobs,
  watchVideoJobs,
} from './videoJobs';
import { cancelJob, cancelTracking, maskClip, useVideoMotion } from './videoMotion';
import { leaveNested } from './videoNesting';
import { isProgramView, requestProgramFrame, useProgramCanvas } from './videoView';
import { isVideoShortcut, videoShortcutLive } from './videoShortcuts';

export {
  addToProjectFile,
  canOpenInEditor,
  createEmptyVideoProject,
  editorFramePending,
  folderOf,
  followProjectDelete,
  followProjectMove,
  followProjectRename,
  isMediaCandidate,
  isProjectPath,
  isVideoPath,
  openProjectFile,
  prefetchRecentProjects,
  projectCloseGuard,
  routeLibraryOpen,
  saveVideoLook,
  useCurrentProjectPath,
  useRecentProjects,
  useVideoAvailable,
} from './useVideoStore';
export { isProgramView, programCanvas, useProgramCanvas } from './videoView';
export { videoShortcutMatcher } from './videoShortcuts';
export { clearPresetSource, usePresetSource } from './videoPresets';
export { restoreAfterCacheClear } from './videoMotion';
export { CLIP_MAPS, dismissClipMaps, prepareClipMaps, useClipMaps, useVideoFrame } from './videoMaps';
export type { ClipMaps, MapKind, VideoFrame } from './videoMaps';
export type { VideoCachePart } from './videoMotion';
export { openTimelapseDialog, timelapsePhotos } from './videoTimelapse';
export { DEFAULT_SHUTTER } from '../utils/video/shutter';
export { confirmProjectLeave } from './useVideoStore';
export { pause as pausePlayback } from './videoPlayback';
export { default as TimelapseModal } from '../components/video/TimelapseModal';
export { default as MediaSkim } from '../components/video/mediaPool/MediaSkim';
export { default as ProjectThumbnails } from '../components/video/mediaPool/ProjectThumbnails';
export { default as FileDropTarget } from '../components/video/FileDropTarget';
export { BIN_DRAG } from '../components/video/mediaPool/poolDrag';
export { default as ProjectSwitcher } from '../components/video/ProjectSwitcher';
export {
  canCreateFrom,
  newVideoProject,
  newVideoProjectFrom,
  openProjectSwitcher,
  recentProjectMenu,
} from './videoProjects';

export type VideoKind = 'none' | 'clip' | 'project';

type VideoState = ReturnType<typeof getVideo>;
type EditorState = ReturnType<typeof useEditorStore.getState>;

const kindOf = (state: VideoState): VideoKind => state.session?.kind ?? 'none';

export const videoKind = () => kindOf(getVideo());

export const useVideoKind = () => useVideoStore(kindOf);

export const isPhotoFile = (path: string) => !isProjectPath(path) && !isVideoPath(path) && !isAudioPath(path);

const CODEC_NAMES: Record<string, string> = { h264: 'H.264', hevc: 'HEVC', prores: 'ProRes' };

export const useVideoFacts = (path: string | null) =>
  useVideoStore((state) => {
    const info = path ? state.media[path] : undefined;
    if (!info?.hasVideo || info.isStill) return null;
    const codec = info.codec && (CODEC_NAMES[info.codec] ?? info.codec.toUpperCase());
    const fps = info.fps > 0 && `${roundFps(info.fps)} fps`;
    const bitRate = info.bitRate && `${Math.round(info.bitRate / 100_000) / 10} Mbit/s`;
    return [codec, fps, bitRate].filter(Boolean).join(' · ') || null;
  });

export const photoEditorImage = () => (videoKind() === 'project' ? null : useEditorStore.getState().selectedImage);

export type MetadataFile = Pick<SelectedImage, 'path' | 'exif' | 'width' | 'height' | 'thumbnailUrl'>;

export const useMetadataFile = (): { file: MetadataFile | null; editable: boolean } => {
  const image = useEditorStore((state) => state.selectedImage);
  const inProject = useVideoKind() === 'project';
  const isView = useVideoStore(() => !!image && isProjectViewPath(image.path));
  const inLibrary = useUIStore((state) => state.activeView === 'library');
  const libraryPath = useLibraryStore((state) => (inProject && inLibrary ? state.libraryActivePath : null));
  const libraryExif = useLibraryStore((state) => (libraryPath ? state.exifByPath[libraryPath] : undefined));
  if (!inProject) return { file: image, editable: true };
  if (!inLibrary) return { file: isView ? null : image, editable: false };
  if (!libraryPath) return { file: null, editable: false };
  const file =
    image?.path === libraryPath
      ? image
      : { path: libraryPath, exif: libraryExif ?? null, width: 0, height: 0, thumbnailUrl: '' };
  return { file, editable: !isProjectPath(libraryPath) };
};

export const useLookEditable = () =>
  useVideoStore((state) => state.session?.kind !== 'project' || state.editorItemId !== null);

export const useEditorTargetId = () =>
  useVideoStore((state) => (state.session?.kind === 'project' ? state.editorItemId : null));

export const useCompareAvailable = () => useVideoStore((state) => state.session?.kind !== 'project');

useVideoStore.subscribe((state, prev) => {
  if (prev.session?.kind === 'project' && state.session?.kind !== 'project') cancelTracking();
});

useVideoStore.subscribe((state, prev) => {
  if (state.session?.kind !== 'project' || prev.session?.kind === 'project') return;
  useEditorStore
    .getState()
    .setEditor((editor) =>
      editor.showOriginal || editor.compareView !== 'off'
        ? { showOriginal: false, previewOverride: null, compareView: 'off' }
        : editor,
    );
});

export const isVideoPlaying = () => getVideo().isPlaying;

export const useVideoPlaying = () => useVideoStore((state) => state.isPlaying);

interface HistoryFlags {
  canUndo: boolean;
  canRedo: boolean;
}

const projectHistory = (state: VideoState): HistoryFlags | null =>
  state.session?.kind === 'project' ? { canUndo: state.past.length > 0, canRedo: state.future.length > 0 } : null;

const photoHistory = (state: EditorState, includePending: boolean) => ({
  canUndo: state.historyIndex > 0 || (includePending && state.adjustments !== state.history[state.historyIndex]),
  canRedo: state.historyIndex < state.history.length - 1,
});

const editHistoryOf = (project: HistoryFlags | null, photo: HistoryFlags) => {
  const { undo, redo } = useEditorStore.getState();
  return project ? { ...project, undo: undoProject, redo: redoProject } : { ...photo, undo, redo };
};

export const editHistory = () =>
  editHistoryOf(projectHistory(getVideo()), photoHistory(useEditorStore.getState(), true));

export const useEditHistory = () => {
  const project = useVideoStore(useShallow(projectHistory));
  const photo = useEditorStore(useShallow((state: EditorState) => photoHistory(state, false)));
  return editHistoryOf(project, photo);
};

export const useHistoryList = (open: boolean) => {
  const photo = useEditorStore(
    useShallow((state) => ({ labels: state.historyLabels, index: state.historyIndex, goTo: state.goToHistoryIndex })),
  );
  const project = useVideoStore(
    useShallow((state) =>
      open && state.session?.kind === 'project' ? { past: state.past, future: state.future } : null,
    ),
  );
  return useMemo(() => {
    if (!project) return photo;
    const { past, future } = project;
    return {
      labels: ['', ...past.map((step) => step.label), ...[...future].reverse().map((step) => step.label)],
      index: past.length,
      goTo: goToProjectHistory,
    };
  }, [photo, project]);
};

const inProjectEditor = () => videoKind() === 'project' && useUIStore.getState().activeView === 'editor';

const inProject = (run: () => void) => {
  if (!inProjectEditor()) return false;
  run();
  return true;
};

export const routeLookPatch = (patch: Partial<Adjustments>) => inProject(() => pasteLook(patch));

export const routeSelectionLook = (patch: Partial<Adjustments>) => inProject(() => pasteLookToSelection(patch));

export const routeLookCopy = () => inProject(() => copyLook(getVideo().editorItemId));

export const routeLookPaste = () => inProject(pasteCopiedLookToEditor);

export const routeProgramRender = () => {
  if (!isProgramView()) return false;
  if (!getVideo().isPlaying) void requestProgramFrame(true);
  return true;
};

const PROJECT_BLOCKED_ACTIONS = new Set([
  'show_original',
  'delete_selected',
  'delete_rejected',
  'copy_adjustments',
  'paste_adjustments',
  ...KEYBIND_DEFINITIONS.filter((def) => def.section === 'rating').map((def) => def.action),
]);

export const blocksPhotoAction = (action: string) => inProjectEditor() && PROJECT_BLOCKED_ACTIONS.has(action);

const NO_MASK_SELECTION = {
  activeMaskId: null,
  activeMaskContainerId: null,
  activeAiPatchContainerId: null,
  activeAiSubMaskId: null,
};

export const shortcutEditorState = (editor: EditorState, ui: UIState): EditorState =>
  inProjectEditor() && !isPanelVisible(ui, Panel.Masks) && !isPanelVisible(ui, Panel.Ai)
    ? { ...editor, ...NO_MASK_SELECTION }
    : editor;

export const useShortcutScope = () => {
  const kind = useVideoKind();
  const inEditor = useUIStore((state) => state.activeView === 'editor');
  return inEditor ? kind : 'none';
};

export const shortcutReach = (
  scope: VideoKind,
  keybinds: Record<string, Array<string>> | undefined,
  osPlatform: string,
) => {
  const claimed = new Set(
    (['media', 'video'] as const).flatMap((context) =>
      [...comboMapFor(context, keybinds, osPlatform)]
        .filter(([, action]) => videoShortcutLive(action, scope))
        .map(([combo]) => combo),
    ),
  );
  return (action: string, combo: string) =>
    isVideoShortcut(action)
      ? videoShortcutLive(action, scope)
      : !claimed.has(combo) && !(scope === 'project' && PROJECT_BLOCKED_ACTIONS.has(action));
};

export const videoEscape = () => {
  const { selection, project } = getVideo();
  if (videoKind() !== 'project') return false;
  if (!inProjectEditor()) returnToProject();
  else if (selection.length > 0) setVideo({ selection: [] });
  else if (project?.open?.length) leaveNested();
  else return false;
  return true;
};

export const enterLibrary = () => {
  cancelPendingOpen();
  if (getVideo().session?.kind === 'project') return leaveProjectForLibrary();
  closeVideoSession();
  return null;
};

export const libraryName = (path: string) => (isProjectPath(path) ? fileStem(path) : fileName(path));

export type MenuEntry = Option & {
  photoOnly?: boolean;
  libraryOnly?: boolean;
  videoOnly?: boolean;
  projectOnly?: boolean;
  needsLook?: boolean;
};

interface MenuScope {
  photos: boolean;
  videos: boolean;
  anyPhoto: boolean;
  anyVideo: boolean;
  project: boolean;
  noLook?: boolean;
}

const isHidden = (entry: MenuEntry, scope: MenuScope) =>
  (!scope.anyPhoto && entry.photoOnly) ||
  (!scope.anyVideo && entry.videoOnly) ||
  (scope.project && entry.libraryOnly) ||
  (!scope.project && entry.projectOnly);

const isBlocked = (entry: MenuEntry, scope: MenuScope) =>
  (!scope.photos && entry.photoOnly) || (!scope.videos && entry.videoOnly) || (scope.noLook && entry.needsLook);

const isSeparator = (option: Option) => option.type === OPTION_SEPARATOR;

const tidySeparators = (options: Array<Option>) =>
  options.filter(
    (option, index) =>
      !isSeparator(option) ||
      (options.slice(0, index).some((before) => !isSeparator(before)) && !isSeparator(options[index + 1] ?? option)),
  );

const filterMenu = (entries: Array<MenuEntry>, scope: MenuScope): Array<Option> =>
  tidySeparators(
    entries
      .filter((entry) => !isHidden(entry, scope))
      .map((entry) => {
        const {
          photoOnly: _photoOnly,
          libraryOnly: _libraryOnly,
          videoOnly: _videoOnly,
          projectOnly: _projectOnly,
          needsLook: _needsLook,
          ...option
        } = isBlocked(entry, scope) ? { ...entry, disabled: true } : entry;
        return option.submenu ? { ...option, submenu: filterMenu(option.submenu, scope) } : option;
      }),
  );

export const editorMenu = (entries: Array<MenuEntry>) => {
  const kind = videoKind();
  const video = kind !== 'none';
  const noLook = kind === 'project' && getVideo().editorItemId === null;
  return filterMenu(entries, {
    photos: !video,
    videos: video,
    anyPhoto: !video,
    anyVideo: video,
    project: kind === 'project',
    noLook,
  });
};

const addToProjectEntries = (paths: Array<string>): Array<Option> => {
  const media = openProjectMedia(getVideo());
  const usable = paths.filter(isMediaCandidate);
  if (!media || usable.length === 0) return [];
  const known = new Set(media.map((entry) => entry.path));
  return [
    {
      label: i18n.t('video.mediaPool.addToProject'),
      icon: ListPlus,
      disabled: usable.every((path) => known.has(path)),
      onClick: () => void addMediaToPool(usable),
    },
    { type: OPTION_SEPARATOR },
  ];
};

export const mediaMenu = (entries: Array<MenuEntry>, paths: Array<string>) => [
  ...addToProjectEntries(paths),
  ...filterMenu(entries, {
    photos: paths.every(isPhotoFile),
    videos: paths.every(isVideoPath),
    anyPhoto: paths.some(isPhotoFile),
    anyVideo: paths.some(isVideoPath),
    project: false,
  }),
];

export const projectsToAddTo = () => {
  const current = currentProjectPath();
  return recentProjectsForMenu().filter((recent) => recent.path !== current);
};

const POOL_DRAG_PREFIX = 'media-pool-';

export const projectDropMedia = (active: Pick<Active, 'id' | 'data'> | null) => {
  const data = active?.data.current;
  if (!active || data?.type !== 'library-image' || String(active.id).startsWith(POOL_DRAG_PREFIX)) return [];
  return draggedPaths(data.path, data.paths).filter(isMediaCandidate);
};

export const dropOnProject = (active: Pick<Active, 'id' | 'data'>, path: string) => {
  const media = projectDropMedia(active);
  if (media.length > 0) void addToProjectFile(path, media);
};

const FRAME_BOUND_MASKS: Array<Mask> = [Mask.MatchBrush];
const FRAME_PICKED_MASKS: Array<Mask> = [Mask.Color, Mask.Luminance];
const VIDEO_MASK_AI: Array<Mask> = [...VIDEO_AI_MASKS, Mask.AiDepth];

export const useMaskTypes = (ai: Array<MaskType>, basic: Array<MaskType>, range: Array<MaskType>) => {
  const kind = useVideoKind();
  const isAdjustmentLayer = useLookTargetType() === 'adjustment';
  if (kind === 'none') return { ai, basic, range };
  const hidden = isAdjustmentLayer ? [...FRAME_BOUND_MASKS, ...FRAME_PICKED_MASKS] : FRAME_BOUND_MASKS;
  const shown = (types: Array<MaskType>) => types.filter((maskType) => !hidden.includes(maskType.type));
  return {
    ai: isAdjustmentLayer ? [] : ai.filter((maskType) => VIDEO_MASK_AI.includes(maskType.type)),
    basic: shown(basic),
    range: shown(range),
  };
};

export const sampleMaskReference = (adjustments: Adjustments, x: number, y: number) =>
  videoKind() === 'none'
    ? null
    : invoke<[number, number, number] | null>(Invokes.SampleMaskReference, {
        jsAdjustments: { ...adjustments, masks: [] },
        x,
        y,
      }).catch(() => null);

const followsFrames = (container: TrackedContainer) =>
  !!container.track?.keys.length ||
  container.subMasks.some((subMask) => !!subMask.parameters?.sequence || subMask.type === Mask.AiDepth);

export const useMaskFrameRevision = (container: MaskContainer | null | undefined): number | null => {
  const picked =
    useVideoKind() !== 'none' && !!container?.subMasks.some(({ type }) => FRAME_PICKED_MASKS.includes(type));
  return useEditorStore((state) => (picked ? state.displayRevision : null));
};

export const useMaskFrameTime = (container: MaskContainer | null | undefined, whilePlaying = false): number | null => {
  const follows = !!container && followsFrames(container);
  return useVideoStore((state) => {
    const { project, playhead } = state;
    if (!follows || (state.isPlaying && !whilePlaying) || !state.session || !project) return null;
    const layer = locateItem(project, state.editorItemId)?.item;
    if (layer?.type === 'adjustment') return ticksToSeconds(editorTimeOf(project, layer, playhead) - layer.start);
    const clip = maskClip();
    if (!clip) return null;
    const sourceFps = state.media[mediaOf(project, clip.media)?.path ?? '']?.fps;
    return ticksToSeconds(
      frameSourceTime(clip, editorTimeOf(project, clip, playhead), project.settings.fps, sourceFps),
    );
  });
};

export const useFollowEpoch = () => useVideoMotion((state) => state.followEpoch);

export const useMaskCutout = () => {
  const kind = useVideoKind();
  const isAdjustmentLayer = useLookTargetType() === 'adjustment';
  return kind === 'project' && !isAdjustmentLayer;
};

export type ShutterScope = 'footage' | 'animation' | 'both';

export const useShutterScope = () =>
  useVideoStore((state): ShutterScope | null => {
    const { session, project, editorItemId } = state;
    if (session?.kind === 'clip') return isVideoPath(session.path) ? 'footage' : null;
    const item = session && project ? locateItem(project, editorItemId)?.item : null;
    if (!project || item?.type !== 'clip') return null;
    return mediaOf(project, item.media)?.kind === 'video' ? 'both' : 'animation';
  });

export type { VideoTask };

export { clearFinishedVideoJobs, isActiveJob, markVideoJobsSeen };

export const useVideoTasks = () => {
  const { t } = useTranslation();
  const { jobs, local, cleared } = useVideoJobs(useShallow(({ jobs, local, cleared }) => ({ jobs, local, cleared })));
  const { tracking, aiFollow } = useVideoMotion(useShallow(({ tracking, aiFollow }) => ({ tracking, aiFollow })));
  const following = Object.keys(aiFollow).length > 0;
  const project = useVideoStore((state) => (tracking || following ? state.project : null));

  useEffect(() => watchVideoJobs(), []);

  return useMemo<Array<VideoTask>>(() => {
    const label = (key: string) => {
      const item = project && locateItem(project, key.split(':')[0])?.item;
      return project && item ? lookItemName(project, item, t) : '';
    };
    const running = { state: 'running' as const, error: null };
    return [
      ...(tracking
        ? [
            {
              ...running,
              id: `tracking:${tracking.key}`,
              kind: 'tracking',
              label: label(tracking.key),
              progress: tracking.progress,
              cancel: () => void cancelJob(),
            },
          ]
        : []),
      ...Object.entries(aiFollow).map(([key, progress]) => ({
        ...running,
        id: `aiMasks:${key}`,
        kind: 'aiMasks',
        label: label(key),
        progress,
      })),
      ...jobTasks(jobs.filter((job) => !cleared.has(job.id))),
      ...local,
    ];
  }, [jobs, local, cleared, tracking, aiFollow, project, t]);
};

export const useUnseenVideoFailures = () =>
  useVideoJobs((state) =>
    [...state.jobs, ...state.local].some((job) => job.state === 'failed' && !state.seen.has(job.id)),
  );

export const useViewerHeader = (baseName: string, image: { width: number; height: number }) => {
  const { t } = useTranslation();
  const canvas = useProgramCanvas();
  const header = useVideoStore(
    useShallow((state) => {
      if (state.session?.kind !== 'project' || !state.project)
        return { title: baseName, fps: null, clipFps: null, draft: false };
      const item = locateItem(state.project, state.editorItemId)?.item;
      const media = item && 'media' in item ? mediaOf(state.project, item.media) : null;
      const info = media ? state.media[media.path] : undefined;
      return {
        title: [state.project.name, item && lookItemName(state.project, item, t)].filter(Boolean).join(' · '),
        fps: fpsLabel(state.project.settings.fps),
        clipFps: info && !info.isStill && info.fps > 0 ? roundFps(info.fps) : null,
        draft: state.session.draft,
      };
    }),
  );
  const projectPanelShown = useUIStore((state) => isPanelVisible(state, Panel.MediaPool));
  const size = canvas ?? (image.width > 0 && image.height > 0 ? image : null);
  const fps = canvas ? header.fps : header.clipFps;
  const details = size ? [`${size.width} × ${size.height}`, ...(fps ? [`${fps} fps`] : [])] : [];
  return {
    title: header.title,
    details,
    inProject: header.fps !== null,
    unsaved: header.draft && !projectPanelShown,
  };
};
