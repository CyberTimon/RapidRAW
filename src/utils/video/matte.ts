import { Ticks, VideoTrack, VisualItem } from '../../types/video';
import { itemEnd } from './model';

export interface MatteRole {
  matted: boolean;
  spans: Array<{ start: Ticks; end: Ticks }>;
}

const usesMatte = (item: VisualItem) => item.type !== 'adjustment' && !!item.trackMatte;

const overlapOf = (item: VisualItem, user: VisualItem) => {
  const span = { start: Math.max(item.start, user.start), end: Math.min(itemEnd(item), itemEnd(user)) };
  return item.type !== 'adjustment' && span.end > span.start ? span : null;
};

const cache = new WeakMap<Array<VideoTrack>, Map<string, MatteRole>>();

export const matteRoles = (tracks: Array<VideoTrack>): Map<string, MatteRole> => {
  const cached = cache.get(tracks);
  if (cached) return cached;
  const roles = new Map<string, MatteRole>();
  tracks.forEach((track, index) => {
    const users = track.items.filter(usesMatte);
    users.forEach((user) => roles.set(user.id, { matted: true, spans: roles.get(user.id)?.spans ?? [] }));
    if (track.hidden) return;
    tracks[index + 1]?.items.forEach((item) => {
      const spans = users.flatMap((user) => overlapOf(item, user) ?? []);
      if (spans.length) roles.set(item.id, { matted: roles.get(item.id)?.matted ?? false, spans });
    });
  });
  cache.set(tracks, roles);
  return roles;
};

export const hasMatteSource = (tracks: Array<VideoTrack>, user: VisualItem) => {
  const index = tracks.findIndex((track) => track.items.some((item) => item.id === user.id));
  return index >= 0 && !!tracks[index + 1]?.items.some((item) => overlapOf(item, user));
};
