import type { ReactNode } from 'react';
import { create } from 'zustand';
import { Ticks, VideoProject } from '../../../types/video';
import {
  PreparedMedia,
  addMediaToProject,
  addPreparedMedia,
  getVideo,
  mediaItems,
  prepareMedia,
} from '../../../store/useVideoStore';
import { selectionWith } from '../../../store/useLibraryStore';
import {
  addGenerator,
  applyTransitionTarget,
  generatorItem,
  placeGenerated,
  transitionTargetAt,
  withTransitionTarget,
} from '../../../store/videoEffects';
import type { VideoDragData } from '../EffectsPanel';
import { MediaTarget, mainSlotOf, overlayTrackOf, placeMedia } from '../../../utils/video/edit';
import { locateItem } from '../../../utils/video/model';
import { snapTicks } from '../../../utils/video/time';
import { alignHaptic } from '../../../utils/haptics';
import { RowHit, timelinePoint } from './layout';
import { snapTargets, snapTo, snapTolerance } from './snapping';

type DropSource = { type: 'library-image'; paths: Array<string> } | VideoDragData;

type Point = NonNullable<ReturnType<typeof timelinePoint>>;

export interface DropEdge {
  item: string;
  edge: 'in' | 'out';
}

interface DropPlan {
  project: VideoProject;
  ghosts: Array<string>;
  cut: string | null;
  edge: DropEdge | null;
  snap: Ticks | null;
  commit(): unknown;
}

export const useDropPlan = create<{ plan: DropPlan | null; pending: boolean }>(() => ({ plan: null, pending: false }));

export const draggedPaths = (path: string, paths?: Array<string>) => paths ?? selectionWith(path);

const ghostId = (index: number) => `drop-ghost-${index}`;

const overlayTrack = (project: VideoProject, hit: RowHit) =>
  hit && 'row' in hit && hit.row.kind === 'video' && hit.row.trackIndex > 0
    ? hit.row.trackIndex
    : hit && 'newTrack' in hit && hit.newTrack === 'video'
      ? project.videoTracks.length
      : null;

const audioTrack = (project: VideoProject, hit: RowHit) =>
  hit && 'row' in hit && hit.row.kind === 'audio'
    ? hit.row.trackIndex
    : hit && 'newTrack' in hit && hit.newTrack === 'audio'
      ? project.audioTracks.length
      : null;

const snapped = (project: VideoProject, time: Ticks, pps: number) =>
  snapTo(snapTicks(time, project.settings.fps), snapTargets(project), snapTolerance(pps));

const mediaTarget = (project: VideoProject, point: Point) => {
  const free = snapped(project, point.time, point.pps);
  const target: MediaTarget = {
    time: free.time,
    trackIndex: overlayTrack(project, point.hit),
    audioTrack: audioTrack(project, point.hit),
  };
  return { target, snap: free.snap };
};

const mediaPlan = (project: VideoProject, prepared: Array<PreparedMedia>, point: Point): DropPlan | null => {
  if (prepared.length === 0) return null;
  const { target, snap } = mediaTarget(project, point);
  const [next, built] = mediaItems(project, prepared, overlayTrackOf(target) !== null);
  const items = built.map((item, index) => ({ ...item, id: ghostId(index) }));
  const placed = placeMedia(next, items, target);
  const landed = items.some((item) => locateItem(placed, item.id)?.item.start === snap);
  return {
    project: placed,
    ghosts: items.map((item) => item.id),
    cut: null,
    edge: null,
    snap: landed ? snap : null,
    commit: () => addPreparedMedia(prepared, target),
  };
};

const videoRowOf = (hit: Point['hit']) => (hit && 'row' in hit && hit.row.kind === 'video' ? hit.row.trackIndex : null);

const effectPlan = (project: VideoProject, data: VideoDragData, point: Point): DropPlan | null => {
  const base = { project, ghosts: [], cut: null, edge: null, snap: null };
  if (data.type === 'video-transition') {
    const row = videoRowOf(point.hit);
    const target = row === null ? null : transitionTargetAt(project, row, point.time);
    return target
      ? {
          ...base,
          project: withTransitionTarget(project, target, data.kind),
          cut: 'cut' in target ? target.cut : null,
          edge: 'cut' in target ? null : target,
          commit: () => applyTransitionTarget(target, data.kind),
        }
      : null;
  }
  const trackIndex = overlayTrack(project, point.hit);
  const free = snapped(project, point.time, point.pps);
  const item = { ...generatorItem(project, data.generator, free.time), id: ghostId(0) };
  return {
    ...base,
    project: placeGenerated(project, item, trackIndex),
    ghosts: [item.id],
    snap: free.snap,
    commit: () => addGenerator(data.generator, free.time, trackIndex),
  };
};

let source: DropSource | null = null;
let pointer: { x: number; y: number } | null = null;
let frame = 0;
let preparing: Promise<unknown> | null = null;
let prepared: { paths: Array<string>; entries: Array<PreparedMedia> } | null = null;

const preparedFor = (paths: Array<string>) =>
  prepared && prepared.paths.length === paths.length && prepared.paths.every((path, index) => path === paths[index])
    ? prepared.entries
    : null;

const prepare = (paths: Array<string>) => {
  const run = prepareMedia(paths).then((entries) => {
    if (preparing !== run) return;
    prepared = { paths, entries };
    refresh();
  });
  preparing = run;
};

const planDrop = (next: DropSource, clientX: number, clientY: number): DropPlan | null => {
  const project = getVideo().project;
  const point = timelinePoint(clientX, clientY);
  if (!project || !point) return null;
  if (next.type !== 'library-image') return effectPlan(project, next, point);
  const entries = preparedFor(next.paths);
  return entries ? mediaPlan(project, entries, point) : null;
};

const unpreparedDrop = (next: DropSource, clientX: number, clientY: number) => {
  const project = getVideo().project;
  const point = timelinePoint(clientX, clientY);
  if (!project || !point || next.type !== 'library-image') return null;
  const { target } = mediaTarget(project, point);
  return () => addMediaToProject(next.paths, target);
};

function refresh() {
  frame = 0;
  if (!source || !pointer || useDropPlan.getState().pending) return;
  if (source.type === 'library-image' && !preparing && timelinePoint(pointer.x, pointer.y)) prepare(source.paths);
  const plan = planDrop(source, pointer.x, pointer.y);
  alignHaptic(
    source,
    isShown(plan),
    plan?.snap,
    plan?.cut,
    plan?.edge && `${plan.edge.item}:${plan.edge.edge}`,
    plan && mainSlotOf(plan.project, plan.ghosts[0] ?? null),
  );
  if (plan || useDropPlan.getState().plan) useDropPlan.setState({ plan });
}

export const moveDropPreview = (x: number, y: number) => {
  pointer = { x, y };
  if (!frame) frame = requestAnimationFrame(refresh);
};

const track = (event: PointerEvent) => moveDropPreview(event.clientX, event.clientY);

export const beginDropPreview = (next: DropSource) => {
  source = next;
  pointer = null;
  preparing = null;
  prepared = null;
  window.addEventListener('pointermove', track, true);
};

export const endDropPreview = () => {
  window.removeEventListener('pointermove', track, true);
  cancelAnimationFrame(frame);
  frame = 0;
  source = null;
  pointer = null;
  preparing = null;
  prepared = null;
  if (!useDropPlan.getState().pending) useDropPlan.setState({ plan: null });
};

export const isDropPreviewing = () => source !== null;

const commitDrop = (fallback: DropSource, clientX: number, clientY: number) => {
  if (frame) {
    cancelAnimationFrame(frame);
    refresh();
  }
  const plan = useDropPlan.getState().plan ?? planDrop(fallback, clientX, clientY);
  const commit = plan?.commit ?? unpreparedDrop(fallback, clientX, clientY);
  if (!commit) return false;
  useDropPlan.setState({ plan, pending: true });
  void Promise.resolve(commit()).finally(() => useDropPlan.setState({ plan: null, pending: false }));
  return true;
};

export const dropMediaOnTimeline = (paths: Array<string>, clientX: number, clientY: number) =>
  commitDrop({ type: 'library-image', paths }, clientX, clientY);

export const dropEffectOnTimeline = (data: VideoDragData, clientX: number, clientY: number) =>
  commitDrop(data, clientX, clientY);

const isShown = (plan: DropPlan | null) => !!plan && (plan.ghosts.length > 0 || !!plan.cut || !!plan.edge);

export function TimelineDragOverlay({ children }: { children: ReactNode }) {
  const hidden = useDropPlan((state) => isShown(state.plan));
  return (
    <div
      className={hidden ? 'opacity-0 transition-opacity duration-100' : 'opacity-100 transition-opacity duration-100'}
    >
      {children}
    </div>
  );
}
