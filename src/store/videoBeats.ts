import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { Invokes } from '../types/invokes';
import { AudioItem, BeatAnalysis, Ticks, TimelineItem, VideoProject } from '../types/video';
import { clipSpeed, mediaOf } from '../utils/video/model';
import { secondsToTicks } from '../utils/video/time';

export type BeatEntry = BeatAnalysis | 'loading' | 'failed';

export const useVideoBeats = create<Record<string, BeatEntry>>(() => ({}));

const requests = new Map<string, Promise<BeatEntry>>();

export const loadBeats = (path: string): Promise<BeatEntry> => {
  const pending = requests.get(path);
  if (pending) return pending;
  useVideoBeats.setState({ [path]: 'loading' });
  const request = invoke<BeatAnalysis>(Invokes.VideoBeats, { path })
    .then((analysis): BeatEntry => analysis)
    .catch((err): BeatEntry => {
      console.error('Beat detection failed:', err);
      requests.delete(path);
      return 'failed';
    })
    .then((entry) => {
      useVideoBeats.setState({ [path]: entry });
      return entry;
    });
  requests.set(path, request);
  return request;
};

export const beatPathOf = (project: VideoProject, item: TimelineItem) => {
  const ref = item.type === 'audio' ? mediaOf(project, item.media) : null;
  return ref && ref.kind !== 'sequence' ? ref.path : null;
};

export interface TimelineBeat {
  time: Ticks;
  isDownbeat: boolean;
}

export const beatsOnTimeline = (item: AudioItem, analysis: BeatEntry | undefined): Array<TimelineBeat> => {
  if (!item.beats || !analysis || typeof analysis === 'string') return [];
  const speed = clipSpeed(item);
  const direction = item.reverse ? -1 : 1;
  const downbeats = new Set(analysis.downbeats);
  return analysis.beats.flatMap((beat) => {
    const time = item.start + Math.round((direction * (secondsToTicks(beat) - item.sourceIn)) / speed);
    return time >= item.start && time < item.start + item.duration ? [{ time, isDownbeat: downbeats.has(beat) }] : [];
  });
};
