import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { Channel, invoke } from '@tauri-apps/api/core';
import { Invokes } from '../types/invokes';
import { CameraLog, ClipItem, FrameRate, MediaRef } from '../types/video';
import { Adjustments } from '../utils/adjustments';
import {
  clipSettingsOf,
  frameSourceTime,
  isMovingVideo,
  locateItem,
  mainTrack,
  mediaOf,
  trimRange,
} from '../utils/video/model';
import { ticksToSeconds } from '../utils/video/time';
import { useEditorStore } from './useEditorStore';
import { showError } from '../utils/errors';
import { editorTimeOf, getVideo, useVideoStore } from './useVideoStore';
import { useVideoMotion } from './videoMotion';
import { isProgramView, requestProgramFrame } from './videoView';

export type MapKind = 'depth' | 'surfaces';

export const CLIP_MAPS = 'video:frames';

const CANCELLED = 'cancelled';

type VideoState = ReturnType<typeof getVideo>;
type Trim = Adjustments['video'];

interface MapTarget {
  path: string;
  item: ClipItem;
  range: ClipItem;
  fps: FrameRate;
  sourceFps?: number;
  media: MediaRef | null;
}

type Analysis =
  | { state: 'checking'; ready: boolean }
  | { state: 'running'; progress: number }
  | { state: 'ready' | 'stopped' | 'failed' };

const useAnalyses = create<Record<string, Analysis>>(() => ({}));

const runs = new Map<string, string>();
let runCount = 0;

const targetOf = ({ session, project, editorItemId, media }: VideoState, trim: Trim): MapTarget | null => {
  if (!session || !project) return null;
  const fps = project.settings.fps;
  if (session.kind === 'clip') {
    const item = mainTrack(project).items[0];
    if (item?.type !== 'clip') return null;
    const [start, end] = trimRange(clipSettingsOf(trim), item.duration);
    const range = { ...item, sourceIn: start, duration: end - start };
    return {
      path: session.path,
      item,
      range,
      fps,
      sourceFps: media[session.path]?.fps,
      media: mediaOf(project, item.media),
    };
  }
  const item = editorItemId ? locateItem(project, editorItemId)?.item : null;
  const ref = item?.type === 'clip' ? mediaOf(project, item.media) : null;
  const info = ref ? media[ref.path] : undefined;
  if (item?.type !== 'clip' || ref?.kind !== 'video' || ref.timelapse || !isMovingVideo(info)) return null;
  return { path: ref.path, item, range: item, fps, sourceFps: info.fps, media: ref };
};

const keyOf = ({ path, range }: MapTarget) =>
  JSON.stringify([
    path,
    range.sourceIn,
    range.duration,
    range.speed,
    range.speedRamp ?? null,
    !!range.reverse,
    !!range.freeze,
  ]);

const analysisId = (kind: MapKind, key: string, epoch: number) => `${epoch}|${kind}|${key}`;

const currentAnalysis = (kind: MapKind) => {
  const target = targetOf(getVideo(), useEditorStore.getState().adjustments.video);
  return target && { target, id: analysisId(kind, keyOf(target), useVideoMotion.getState().aiEpoch) };
};

const shownSeconds = ({ project, playhead }: VideoState, { item, fps, sourceFps }: MapTarget) =>
  project ? ticksToSeconds(frameSourceTime(item, editorTimeOf(project, item, playhead), fps, sourceFps)) : 0;

const refreshFrame = () => {
  if (isProgramView()) void requestProgramFrame();
  else useEditorStore.getState().setEditor((state) => ({ displayRevision: state.displayRevision + 1 }));
};

const analyze = async (kind: MapKind, target: MapTarget, id: string, ready: boolean) => {
  const run = `${id}#${(runCount += 1)}`;
  runs.set(id, run);
  const current = () => runs.get(id) === run;
  const report = (analysis: Analysis) => {
    if (current()) useAnalyses.setState({ [id]: analysis });
  };
  report({ state: 'checking', ready });
  const onProgress = new Channel<number>();
  onProgress.onmessage = (progress) => {
    if (progress < 1) report({ state: 'running', progress });
  };
  try {
    await invoke(Invokes.VideoClipMaps, {
      request: {
        id: run,
        path: target.path,
        clip: target.range,
        fps: target.fps,
        kind,
        at: shownSeconds(getVideo(), target),
      },
      onProgress,
    });
    if (!current()) return;
    report({ state: 'ready' });
    refreshFrame();
  } catch (error) {
    if (!current()) return;
    const cancelled = String(error).toLowerCase().includes(CANCELLED);
    report({ state: cancelled ? 'stopped' : 'failed' });
    if (!cancelled)
      showError('video.toasts.analysisFailed', error, { retry: () => void analyze(kind, target, id, ready) });
  } finally {
    if (current()) runs.delete(id);
  }
};

const forget = (id: string) =>
  useAnalyses.setState((analyses) => {
    const { [id]: _forgotten, ...rest } = analyses;
    return rest;
  }, true);

const stopAnalysis = (id: string) => {
  const run = runs.get(id);
  if (!run) return;
  runs.delete(id);
  invoke(Invokes.VideoClipMapsStop, { id: run }).catch(() => {});
  forget(id);
};

const sessionOf = ({ session }: VideoState) => (session ? `${session.kind}:${session.path}` : null);

useVideoStore.subscribe((state, prev) => {
  if (sessionOf(state) !== sessionOf(prev)) [...runs.keys()].forEach(stopAnalysis);
});

export const prepareClipMaps = (kind: MapKind, ready = true) => {
  const current = currentAnalysis(kind);
  if (current && !useAnalyses.getState()[current.id]) void analyze(kind, current.target, current.id, ready);
};

export const dismissClipMaps = (kind: MapKind) => {
  const current = currentAnalysis(kind);
  if (current) forget(current.id);
};

export interface ClipMaps {
  ready: boolean;
  failed: boolean;
  progress: number | null;
}

export const useClipMaps = (kind: MapKind, wanted: boolean): ClipMaps | null => {
  const trim = useEditorStore((state) => state.adjustments.video);
  const key = useVideoStore((state) => {
    const target = targetOf(state, trim);
    return target ? keyOf(target) : null;
  });
  const epoch = useVideoMotion((state) => state.aiEpoch);
  const id = key === null ? null : analysisId(kind, key, epoch);
  const analysis = useAnalyses((analyses) => (id ? analyses[id] : undefined));
  const last = useRef({ id, wanted });
  useEffect(() => {
    const previous = last.current;
    last.current = { id, wanted };
    if (id && previous.id === id && previous.wanted && !wanted) stopAnalysis(id);
  }, [id, wanted]);
  useEffect(() => {
    if (wanted && id && !analysis) prepareClipMaps(kind);
  }, [wanted, id, analysis, kind]);
  if (id === null) return null;
  return {
    ready:
      !analysis ||
      analysis.state === 'ready' ||
      analysis.state === 'stopped' ||
      (analysis.state === 'checking' && analysis.ready),
    failed: analysis?.state === 'failed',
    progress: analysis?.state === 'running' ? analysis.progress : null,
  };
};

export interface VideoFrame {
  path: string;
  time: number | null;
  log: CameraLog | null;
  deflicker: boolean;
}

export const useVideoFrame = () =>
  useVideoStore(
    useShallow((state): VideoFrame | null => {
      const target = targetOf(state, useEditorStore.getState().adjustments.video);
      return (
        target && {
          path: target.path,
          time: state.isPlaying ? null : shownSeconds(state, target),
          log: target.media?.log ?? null,
          deflicker: !!target.media?.timelapse?.deflicker,
        }
      );
    }),
  );
