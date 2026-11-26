import { AudioTrack, Ticks, TrackKind, VideoProject, VideoTrack } from '../../../types/video';
import { secondsToTicks, ticksToSeconds } from '../../../utils/video/time';

export const HEADER_WIDTH = 112;
export const RULER_HEIGHT = 30;
export const DRAG_THRESHOLD = 4;
const MAIN_TRACK_HEIGHT = 58;
const OVERLAY_TRACK_HEIGHT = 36;
const AUDIO_TRACK_HEIGHT = 36;
const MIN_TRACK_HEIGHT = 28;
const MAX_TRACK_HEIGHT = 200;
const MAIN_TRACK_AUTO_MAX = 120;
const TRACK_GAP = 4;
const NEW_TRACK_ZONE = OVERLAY_TRACK_HEIGHT + TRACK_GAP;
const NEW_AUDIO_ZONE = 14;
const CAPTION_TRACK_HEIGHT = 28;

export interface Row {
  kind: TrackKind;
  trackIndex: number;
  top: number;
  height: number;
  track: VideoTrack | AudioTrack;
  isNew?: boolean;
}

export interface Layout {
  rows: Array<Row>;
  captions: { top: number; height: number } | null;
  videoTop: number;
  newAudioZone: { top: number; height: number };
  height: number;
}

export type HeightOverrides = Record<string, number>;

export const isMainRow = (row: Row) => row.kind === 'video' && row.trackIndex === 0;

const defaultTrackHeight = (kind: TrackKind, trackIndex: number) =>
  kind === 'audio' ? AUDIO_TRACK_HEIGHT : trackIndex === 0 ? MAIN_TRACK_HEIGHT : OVERLAY_TRACK_HEIGHT;

export const clampTrackHeight = (height: number) =>
  Math.round(Math.min(MAX_TRACK_HEIGHT, Math.max(MIN_TRACK_HEIGHT, height)));

export const trackScaleLimits = (heights: Array<number>) => ({
  min: MIN_TRACK_HEIGHT / Math.max(...heights),
  max: MAX_TRACK_HEIGHT / Math.min(...heights),
});

const trackHeight = (
  kind: TrackKind,
  trackIndex: number,
  track: VideoTrack | AudioTrack,
  overrides?: HeightOverrides,
) =>
  overrides?.[track.id] ??
  (track.height === undefined ? defaultTrackHeight(kind, trackIndex) : clampTrackHeight(track.height));

export const storedTrackHeights = (project: VideoProject, overrides: HeightOverrides) =>
  Object.fromEntries(
    (['video', 'audio'] as const).flatMap((kind) =>
      (kind === 'video' ? project.videoTracks : project.audioTracks).flatMap((track, trackIndex) => {
        if (overrides[track.id] === undefined) return [];
        const height = clampTrackHeight(overrides[track.id]);
        return [[track.id, height === defaultTrackHeight(kind, trackIndex) ? null : height]];
      }),
    ),
  );

const mainGrowth = (project: VideoProject, spare: number, overrides?: HeightOverrides) => {
  const main = project.videoTracks[0];
  if (!main || main.height !== undefined || overrides?.[main.id] !== undefined) return 0;
  return Math.max(0, Math.min(spare - NEW_TRACK_ZONE, MAIN_TRACK_AUTO_MAX - MAIN_TRACK_HEIGHT));
};

export const computeLayout = (project: VideoProject, available = 0, overrides?: HeightOverrides): Layout => {
  const rows: Array<Row> = [];
  const grow = mainGrowth(project, available, overrides);
  const spare = available - grow;
  const captions = project.captions?.items.length ? { top: spare + TRACK_GAP, height: CAPTION_TRACK_HEIGHT } : null;
  const videoTop = (captions ? captions.top + captions.height : spare) + TRACK_GAP;
  let top = videoTop;
  for (let index = project.videoTracks.length - 1; index >= 0; index--) {
    const track = project.videoTracks[index];
    const height = trackHeight('video', index, track, overrides) + (index === 0 ? grow : 0);
    rows.push({ kind: 'video', trackIndex: index, top, height, track });
    top += height + TRACK_GAP;
  }
  top += TRACK_GAP * 2;
  project.audioTracks.forEach((track, index) => {
    const height = trackHeight('audio', index, track, overrides);
    rows.push({ kind: 'audio', trackIndex: index, top, height, track });
    top += height + TRACK_GAP;
  });
  const newAudioZone = { top, height: NEW_AUDIO_ZONE };
  return { rows, captions, videoTop, newAudioZone, height: top + NEW_AUDIO_ZONE };
};

const newVideoBandTop = (layout: Layout, viewTop: number) => Math.max(viewTop, layout.videoTop - NEW_TRACK_ZONE);

export const stableLayout = (base: Layout, project: VideoProject, viewTop: number): Layout => {
  const tracks = { video: project.videoTracks, audio: project.audioTracks } as const;
  const rows = base.rows.map((row) => {
    const track = (tracks[row.kind] as Array<VideoTrack | AudioTrack>).find(({ id }) => id === row.track.id);
    return { ...row, track: track ?? { ...row.track, items: [] } };
  });
  const known = new Set(base.rows.map((row) => row.track.id));
  const added = (kind: TrackKind) =>
    (tracks[kind] as Array<VideoTrack | AudioTrack>).filter((track) => !known.has(track.id));
  const baseCount = (kind: TrackKind) => base.rows.filter((row) => row.kind === kind).length;
  const bandTop = newVideoBandTop(base, viewTop);
  added('video').forEach((track, index) =>
    rows.push({
      kind: 'video',
      trackIndex: baseCount('video') + index,
      top: bandTop - index * NEW_TRACK_ZONE,
      height: OVERLAY_TRACK_HEIGHT,
      track,
      isNew: true,
    }),
  );
  added('audio').forEach((track, index) =>
    rows.push({
      kind: 'audio',
      trackIndex: baseCount('audio') + index,
      top: base.newAudioZone.top + index * NEW_TRACK_ZONE,
      height: AUDIO_TRACK_HEIGHT,
      track,
      isNew: true,
    }),
  );
  return { ...base, rows };
};

export const trackLabel = (kind: TrackKind, index: number, main: string) =>
  kind === 'video' ? (index === 0 ? main : `V${index + 1}`) : `A${index + 1}`;

export const timeToX = (time: Ticks, pps: number) => ticksToSeconds(time) * pps;

export const xToTime = (x: number, pps: number): Ticks => secondsToTicks(Math.max(0, x / pps));

export const spanBox = (start: Ticks, end: Ticks, pps: number) => {
  const left = Math.round(timeToX(start, pps)) + 1;
  return { left, width: Math.max(2, Math.round(timeToX(end, pps)) - 1 - left) };
};

export const cutRowTop = (layout: Layout, y: number) => {
  const boxes = layout.captions ? [layout.captions, ...layout.rows] : layout.rows;
  const cut = boxes.find((box) => box.top < y && box.top + box.height > y);
  return cut ? Math.max(0, cut.top - TRACK_GAP) : null;
};

export type RowHit = { row: Row } | { newTrack: TrackKind } | null;

export const rowAt = (layout: Layout, y: number, viewTop = Number.NEGATIVE_INFINITY): RowHit => {
  if (y < Math.max(layout.videoTop, viewTop)) return { newTrack: 'video' };
  const row = layout.rows.find(
    (candidate) => y >= candidate.top - TRACK_GAP / 2 && y < candidate.top + candidate.height + TRACK_GAP / 2,
  );
  if (row) return { row };
  if (y >= layout.newAudioZone.top) return { newTrack: 'audio' };
  const audioStart = layout.rows.find((candidate) => candidate.kind === 'audio')?.top ?? Number.POSITIVE_INFINITY;
  return y < audioStart ? { newTrack: 'video' } : null;
};

interface TimelineGeometry {
  viewport: HTMLElement;
  lanes: HTMLElement;
  layout: Layout;
  pps: number;
  zoom(factor: number): void;
  fit(): void;
}

let geometry: TimelineGeometry | null = null;

export const registerTimelineGeometry = (next: TimelineGeometry | null) => {
  geometry = next;
};

export const zoomTimeline = (factor: number) => geometry?.zoom(factor);

export const fitTimeline = () => geometry?.fit();

export const timelinePoint = (clientX: number, clientY: number) => {
  if (!geometry) return null;
  const view = geometry.viewport.getBoundingClientRect();
  if (clientX < view.left + HEADER_WIDTH || clientX > view.right || clientY < view.top || clientY > view.bottom)
    return null;
  const rect = geometry.lanes.getBoundingClientRect();
  return {
    time: xToTime(clientX - rect.left, geometry.pps),
    hit: rowAt(geometry.layout, clientY - rect.top, geometry.viewport.scrollTop),
    pps: geometry.pps,
  };
};
