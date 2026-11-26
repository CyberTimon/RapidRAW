import i18n from 'i18next';
import { toast } from 'react-toastify';
import { AudioItem, ClipItem, MediaInfo, VideoProject } from '../types/video';
import { showError } from '../utils/errors';
import { linkedIds, updateItem } from '../utils/video/edit';
import { Arrangement, arrangeItems } from '../utils/video/layouts';
import { fileName, itemEnd, locateItem, mediaOf } from '../utils/video/model';
import {
  KenBurnsChoice,
  KenBurnsMove,
  applyKenBurns,
  cutToBeats,
  kenBurnsOf,
  kenBurnsPlan,
  mainItemsIn,
} from '../utils/video/montage';
import { snapTicks } from '../utils/video/time';
import { editProject, getVideo } from './useVideoStore';
import { beatPathOf, beatsOnTimeline, loadBeats, useVideoBeats } from './videoBeats';
import { mediaDurationOf } from './videoEditing';
import { startVideoTask } from './videoJobs';

export const stillsIn = (project: VideoProject, ids: Array<string>, media: Record<string, MediaInfo>) =>
  ids
    .flatMap((id) => {
      const item = locateItem(project, id)?.item;
      const ref = item?.type === 'clip' ? mediaOf(project, item.media) : null;
      return item?.type === 'clip' && ref && (ref.kind === 'image' || media[ref.path]?.isStill) ? [item] : [];
    })
    .sort((a, b) => a.start - b.start);

export const kenBurnsMoveOf = (stills: Array<ClipItem>): KenBurnsMove | null => {
  const moves = new Set(stills.map(kenBurnsOf));
  return moves.size === 1 ? [...moves][0] : null;
};

export const beatSources = (project: VideoProject, ids: Array<string>): Array<AudioItem> => {
  const main = mainItemsIn(project, ids);
  if (main.length === 0) return [];
  const from = Math.min(...main.map((item) => item.start));
  const to = Math.max(...main.map(itemEnd));
  const overlap = (item: AudioItem) => Math.min(to, itemEnd(item)) - Math.max(from, item.start);
  const under = project.audioTracks
    .flatMap((track) => track.items)
    .filter((item) => overlap(item) > 0 && beatPathOf(project, item));
  const shown = under.filter((item) => item.beats);
  if (shown.length > 0) return shown;
  const ownIds = main.map((item) => item.id);
  const own = new Set(linkedIds(project, ownIds));
  const music = under.filter((item) => !own.has(item.id));
  const widest = (music.length > 0 ? music : under).reduce<AudioItem | null>(
    (best, item) => (!best || overlap(item) > overlap(best) ? item : best),
    null,
  );
  return widest ? [widest] : [];
};

const beatCuts = (project: VideoProject, sources: Array<string>, every: number) => {
  const analyses = useVideoBeats.getState();
  const beats = sources
    .flatMap((id) => {
      const item = locateItem(project, id)?.item;
      return item?.type === 'audio' ? beatsOnTimeline(item, analyses[beatPathOf(project, item) ?? '']) : [];
    })
    .sort((a, b) => a.time - b.time);
  const phase = Math.max(
    0,
    beats.findIndex((beat) => beat.isDownbeat),
  );
  const onGrid = beats.filter((_, index) => (((index - phase) % every) + every) % every === 0);
  return [...new Set(onGrid.map((beat) => snapTicks(beat.time, project.settings.fps)))];
};

export const canCutToBeats = (project: VideoProject, ids: Array<string>) => beatSources(project, ids).length > 0;

export const kenBurnsSelection = (choice: KenBurnsChoice) => {
  const { project, selection, media } = getVideo();
  if (!project) return;
  const ids = stillsIn(project, selection, media).map((item) => item.id);
  if (ids.length === 0) return;
  const plan = kenBurnsPlan(ids.length, choice);
  editProject((current) => applyKenBurns(current, ids, plan));
};

const findBeats = async (paths: Array<string>) => {
  const analyses = useVideoBeats.getState();
  if (paths.every((path) => typeof analyses[path] === 'object')) return Promise.all(paths.map(loadBeats));
  let cancelled = false;
  const task = startVideoTask('beats', paths.map(fileName).join(', '), () => {
    cancelled = true;
    task.finish('cancelled');
  });
  const entries = await Promise.all(paths.map(loadBeats));
  if (cancelled) return null;
  task.finish(entries.every((entry) => entry === 'failed') ? 'failed' : 'done');
  return entries;
};

export const cutSelectionToBeats = async (every: number) => {
  const { project, selection, session } = getVideo();
  if (!project) return;
  const items = beatSources(project, selection);
  const sources = items.map((item) => item.id);
  const paths = [...new Set(items.flatMap((item) => beatPathOf(project, item) ?? []))];
  if (paths.length === 0) return;
  const entries = await findBeats(paths);
  const { project: live, session: active } = getVideo();
  if (!entries || active !== session || !live) return;
  if (mainItemsIn(live, selection).length === 0 || !sources.some((id) => locateItem(live, id))) return;
  if (entries.every((entry) => entry === 'failed')) {
    showError('video.montage.beatsFailed', null, { retry: () => void cutSelectionToBeats(every) });
    return;
  }
  let found = false;
  editProject((current) => {
    const shown = sources.reduce((next, id) => updateItem<AudioItem>(next, id, { beats: true }), current);
    const cuts = beatCuts(shown, sources, every);
    found = cuts.length > 0;
    return found ? cutToBeats(shown, selection, cuts, mediaDurationOf) : current;
  });
  if (!found) toast.info(i18n.t('video.montage.noBeats'));
};

export const arrangeSelection = (layout: Arrangement) => {
  const { selection, media } = getVideo();
  editProject((current) => arrangeItems(current, selection, layout, media));
};
