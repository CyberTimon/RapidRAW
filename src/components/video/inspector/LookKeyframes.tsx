import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { X } from 'lucide-react';
import Text from '../../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../../types/typography';
import { AdjustmentItem, ClipItem, Ticks, VideoProject } from '../../../types/video';
import { editItemLook, editorLookTime, getVideo, setPlayhead, useVideoStore } from '../../../store/useVideoStore';
import {
  addKeys,
  channelsOf,
  easeKeys,
  keyNear,
  keyTimes,
  lookEaseAt,
  removeKeys,
  stopAnimating,
  timelineTimeOf,
} from '../../../utils/video/lookAnimation';
import { hasLook, locateItem, lookOf } from '../../../utils/video/model';
import { lookValueLabel } from '../../../utils/video/lookLabels';
import { channelGroupOf } from '../../../utils/video/maskPaths';
import { frameTicks } from '../../../utils/video/time';
import { KeyEase, KeyframeControls } from './InspectorControls';

type LookItem = ClipItem | AdjustmentItem;

export function useEditorLookItem() {
  const project = useVideoStore((state) => state.project);
  const editorItemId = useVideoStore((state) => state.editorItemId);
  const item = project && editorItemId ? locateItem(project, editorItemId)?.item : null;
  return project && item && hasLook(item) ? { project, item } : null;
}

export function useLookKeyframes(item: LookItem, project: VideoProject, paths: Array<string> | null) {
  const look = lookOf(project, item);
  const watched = paths ?? (look ? Object.keys(channelsOf(look)) : []);
  const animated = !!look && watched.some((path) => !!channelsOf(look)[path]);
  const fps = project.settings.fps;
  const tolerance = frameTicks(fps) / 2;
  const times = look ? keyTimes(look, watched) : [];
  const { onKey, previous, next } = useVideoStore(
    useShallow((state) => {
      const time = editorLookTime(project, item, animated ? state.playhead : 0);
      return {
        onKey: !!look && keyNear(look, watched, time, tolerance),
        previous: times.filter((key) => key < time - tolerance).at(-1),
        next: times.find((key) => key > time + tolerance),
      };
    }),
  );
  const jump = (key: Ticks | undefined) =>
    key === undefined ? null : () => setPlayhead(timelineTimeOf(item, key, fps));
  const ease: KeyEase = {
    current: () => {
      const time = editorLookTime(project, item, getVideo().playhead);
      const choices = new Set(look ? watched.map((path) => lookEaseAt(look, path, time, tolerance)) : []);
      return choices.size === 1 ? [...choices][0] : null;
    },
    apply: (preset) => editItemLook(item.id, (current, at) => easeKeys(current, watched, at, tolerance, preset)),
  };
  return {
    look,
    animated,
    onKey,
    onPrevious: jump(previous),
    onNext: jump(next),
    ease,
    toggle: (onKey: boolean) =>
      editItemLook(item.id, (current, at) =>
        onKey ? removeKeys(current, watched, at, tolerance) : addKeys(current, watched, at, tolerance),
      ),
  };
}

function ChannelRow({
  item,
  project,
  group,
  paths,
}: {
  item: LookItem;
  project: VideoProject;
  group: string;
  paths: Array<string>;
}) {
  const { t } = useTranslation();
  const keyframes = useLookKeyframes(item, project, paths);
  if (!keyframes.look) return null;
  return (
    <div className="flex items-center gap-1 min-h-6">
      <Text variant={TextVariants.small} color={TextColors.primary} className="flex-1 min-w-0 truncate">
        {lookValueLabel(keyframes.look, group, t)}
      </Text>
      <KeyframeControls
        animated
        onKey={keyframes.onKey}
        onPrevious={keyframes.onPrevious}
        onNext={keyframes.onNext}
        onToggle={() => keyframes.toggle(keyframes.onKey)}
        ease={keyframes.ease}
        revealOnHover={false}
      />
      <button
        type="button"
        className="w-5 h-5 flex items-center justify-center text-text-secondary hover:text-text-primary"
        onClick={() => editItemLook(item.id, (look, at) => stopAnimating(look, paths, at))}
        data-tooltip={t('video.keyframes.stop')}
        aria-label={t('video.keyframes.stop')}
      >
        <X size={12} />
      </button>
    </div>
  );
}

export default function LookKeyframes({ item, project }: { item: LookItem; project: VideoProject }) {
  const { t } = useTranslation();
  const look = lookOf(project, item);
  const groups = new Map<string, Array<string>>();
  (look ? Object.keys(channelsOf(look)) : []).forEach((path) => {
    const group = channelGroupOf(path);
    groups.set(group, [...(groups.get(group) ?? []), path]);
  });
  if (groups.size === 0) return null;
  return (
    <div className="mt-3 space-y-1">
      <Text variant={TextVariants.small} weight={TextWeights.medium} color={TextColors.primary} className="block">
        {t('video.keyframes.title')}
      </Text>
      {[...groups].map(([group, paths]) => (
        <ChannelRow key={group} item={item} project={project} group={group} paths={paths} />
      ))}
    </div>
  );
}
