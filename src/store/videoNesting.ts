import i18n from 'i18next';
import { toast } from 'react-toastify';
import { Ticks } from '../types/video';
import { itemEnd, locateItem, mediaOf, sourceTimeOf } from '../utils/video/model';
import {
  NestResult,
  enterSequence,
  isPlainCompound,
  leaveSequence,
  nestItems,
  unnestItem,
} from '../utils/video/nesting';
import { editProject, getVideo, setVideo, showSequence } from './useVideoStore';

const outerPlayheads: Array<Ticks> = [];

const nestedSequenceOf = (itemId: string) => {
  const { project } = getVideo();
  const item = project ? locateItem(project, itemId)?.item : null;
  const ref = project && item?.type === 'clip' ? mediaOf(project, item.media) : null;
  return ref?.kind === 'sequence' ? { project: project!, clip: item!, ref } : null;
};

export const nestSelection = () => {
  const { project, selection } = getVideo();
  if (!project || selection.length === 0) return;
  const count = project.media.filter((media) => media.kind === 'sequence').length + 1;
  let result = null as NestResult | null;
  editProject((current) => {
    result = nestItems(current, selection, i18n.t('video.nesting.name', { count }));
    return 'refusal' in result ? current : result.project;
  });
  if (!result) return;
  if ('refusal' in result) {
    toast.info(i18n.t(`video.nesting.refused.${result.refusal}`));
    return;
  }
  setVideo({ selection: [result.clipId] });
};

export const openNested = (itemId: string) => {
  const nested = nestedSequenceOf(itemId);
  if (!nested || nested.clip.type !== 'clip') return;
  const { project, clip, ref } = nested;
  const { playhead } = getVideo();
  const inside = playhead >= clip.start && playhead < itemEnd(clip);
  outerPlayheads.length = project.open?.length ?? 0;
  outerPlayheads.push(playhead);
  showSequence(
    enterSequence(project, ref.id),
    inside ? sourceTimeOf(clip, playhead, project.settings.fps) : clip.sourceIn,
  );
};

export const leaveNested = (levels = 1) => {
  const { project, playhead } = getVideo();
  if (!project?.open?.length) return;
  let next = project;
  for (let level = 0; level < levels && next.open?.length; level++) next = leaveSequence(next);
  if (outerPlayheads.length !== project.open.length) outerPlayheads.length = 0;
  const restored = outerPlayheads.splice(-Math.min(levels, outerPlayheads.length))[0];
  showSequence(next, restored ?? playhead);
};

export const canUnnest = (itemId: string) => {
  const nested = nestedSequenceOf(itemId);
  return !!nested && isPlainCompound(nested.project, nested.clip);
};

export const unnestSelection = () => {
  const ids = getVideo().selection.filter(canUnnest);
  if (ids.length === 0) return;
  editProject((project) => ids.reduce(unnestItem, project));
  setVideo({ selection: [] });
};
