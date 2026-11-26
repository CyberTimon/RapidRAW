import { Ticks, VideoProject } from '../../../types/video';
import { useVideoStore } from '../../../store/useVideoStore';
import { beatsOnTimeline, useVideoBeats } from '../../../store/videoBeats';
import { allItems, itemEnd, mediaOf } from '../../../utils/video/model';
import { secondsToTicks, snapTicks } from '../../../utils/video/time';

const SNAP_PX = 8;

export const nearest = (value: Ticks, targets: Array<Ticks>, tolerance: Ticks) => {
  let best = value;
  let distance = tolerance;
  for (const target of targets) {
    if (Math.abs(target - value) <= distance) {
      best = target;
      distance = Math.abs(target - value);
    }
  }
  return best;
};

export const snapTo = (value: Ticks, targets: Array<Ticks>, tolerance: Ticks) => {
  const time = nearest(value, targets, tolerance);
  return { time, snap: time === value && !targets.includes(value) ? null : time };
};

export const snapSpan = (start: Ticks, duration: Ticks, targets: Array<Ticks>, tolerance: Ticks) => {
  const head = snapTo(start, targets, tolerance);
  if (head.snap !== null) return { time: Math.max(0, head.time), snap: head.snap };
  const tail = snapTo(start + duration, targets, tolerance);
  return { time: Math.max(0, tail.time - duration), snap: tail.snap };
};

const beatTimes = (project: VideoProject): Array<Ticks> => {
  const analyses = useVideoBeats.getState();
  return project.audioTracks.flatMap((track) =>
    track.items.flatMap((item) => {
      const path = mediaOf(project, item.media)?.path;
      return path
        ? beatsOnTimeline(item, analyses[path]).map((beat) => snapTicks(beat.time, project.settings.fps))
        : [];
    }),
  );
};

export const snapTargets = (project: VideoProject, exclude: string | Array<string> = []): Array<Ticks> => {
  const { playhead, snapping } = useVideoStore.getState();
  if (!snapping) return [];
  const skip = new Set([exclude].flat());
  return [
    0,
    playhead,
    ...allItems(project)
      .filter((item) => !skip.has(item.id))
      .flatMap((item) => [item.start, itemEnd(item)]),
    ...(project.captions?.items ?? [])
      .filter((caption) => !skip.has(caption.id))
      .flatMap((caption) => [caption.start, caption.start + caption.duration]),
    ...project.markers.filter((marker) => !skip.has(marker.id)).map((marker) => marker.time),
    ...(project.range ? [project.range.start, project.range.end] : []),
    ...beatTimes(project),
  ];
};

export const snapTolerance = (pps: number) => secondsToTicks(SNAP_PX / pps);
