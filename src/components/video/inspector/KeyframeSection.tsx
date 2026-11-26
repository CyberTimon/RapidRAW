import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Dropdown from '../../ui/Dropdown';
import Text from '../../ui/Text';
import { TextColors } from '../../../types/typography';
import { Keyframe, Ticks, TimelineItem, VideoProject } from '../../../types/video';
import { useContextMenu } from '../../../context/ContextMenuContext';
import { editProject, setPlayhead } from '../../../store/useVideoStore';
import { selectKeyframe, useKeyframeSelection } from '../../../store/videoEditing';
import {
  SPEED_CHANNEL,
  channelAnimated,
  channelGroup,
  groupHeads,
  isMarkAt,
  keyframeMarks,
  lookChannelPath,
  setChannelKeys,
} from '../../../utils/video/edit';
import { EASE_PRESETS, EaseChoice, EasePreset, easeOfKey, withEase } from '../../../utils/video/animation';
import { lookTimeOf, timelineTimeOf } from '../../../utils/video/lookAnimation';
import { hasLook } from '../../../utils/video/model';
import { frameTicks } from '../../../utils/video/time';
import { formatGain } from '../../../utils/video/sound';
import { channelLabel } from '../timeline/KeyframeMarks';
import CurveEditor, { easeOptions } from './CurveEditor';
import { FieldRow, InspectorSection } from './InspectorControls';

const PERCENT_CHANNELS = new Set([
  'transform.x',
  'transform.y',
  'transform.scale',
  'transform.opacity',
  'transform.radius',
  'opacity',
]);

const formatterOf = (channel: string) => (value: number) => {
  if (channel === 'volume') return formatGain(value);
  if (PERCENT_CHANNELS.has(channel)) return `${Number((value * 100).toFixed(1))}%`;
  if (channel === 'transform.rotation') return `${Number(value.toFixed(1))}°`;
  return String(Number(value.toFixed(2)));
};

export default function KeyframeSection({ item, project }: { item: TimelineItem; project: VideoProject }) {
  const { t } = useTranslation();
  const { showContextMenu } = useContextMenu();
  const [picked, setPicked] = useState<string | null>(null);
  const selected = useKeyframeSelection((state) => (state.selected?.itemId === item.id ? state.selected : null));
  const fps = project.settings.fps;
  const mark = selected
    ? keyframeMarks(project, item).find((candidate) => isMarkAt(candidate, selected.time, fps))
    : undefined;
  const refs = groupHeads((mark?.keys ?? []).filter((key) => key.channel !== SPEED_CHANNEL));
  const ref = refs.find((key) => channelGroup(key.channel) === picked) ?? refs[0];
  const value = ref ? channelAnimated(project, item, ref.channel) : null;
  const keys = value?.keys ?? [];
  const index = ref ? keys.findIndex((key) => key.time === ref.time) : -1;
  if (!ref || !value || index < 0) return null;

  const lookItem = lookChannelPath(ref.channel) !== null && hasLook(item) ? item : null;
  const localOf = (time: Ticks) => (lookItem ? timelineTimeOf(lookItem, time, fps) - item.start : time);
  const from = keys[index - 1]?.time ?? keys[index].time;
  const to = keys[index + 1]?.time ?? keys[index].time;
  const ease = easeOfKey(keys, index);

  const commit = (next: Array<Keyframe>, merge: boolean) =>
    editProject(
      (current) => setChannelKeys(current, item.id, ref.channel, next),
      merge ? `keyCurve:${item.id}` : undefined,
    );
  const applyEase = (at: number, preset: EasePreset) => commit(withEase(keys, at, preset), false);
  const select = (at: number) => {
    const local = localOf(keys[at].time);
    selectKeyframe({ itemId: item.id, time: local });
    setPlayhead(item.start + Math.min(local, item.duration - frameTicks(fps)));
  };

  return (
    <InspectorSection id="keyframe" title={t('video.keyframes.keyframe')}>
      <FieldRow label={t('video.keyframes.value')}>
        {refs.length > 1 ? (
          <Dropdown<string>
            className="w-full max-w-44"
            options={refs.map((key) => ({
              value: channelGroup(key.channel),
              label: channelLabel(t, project, item, channelGroup(key.channel)),
            }))}
            value={channelGroup(ref.channel)}
            onChange={setPicked}
          />
        ) : (
          <Text color={TextColors.primary} className="truncate">
            {channelLabel(t, project, item, channelGroup(ref.channel))}
          </Text>
        )}
      </FieldRow>
      <FieldRow label={t('video.keyframes.easing')}>
        <Dropdown<EaseChoice>
          className="w-full max-w-44"
          options={[
            ...EASE_PRESETS.map((preset) => ({ value: preset, label: t(`video.keyframes.ease.${preset}`) })),
            ...(ease === 'custom'
              ? [{ value: 'custom' as const, label: t('video.keyframes.ease.custom'), disabled: true }]
              : []),
          ]}
          value={ease}
          onChange={(preset) => {
            if (preset !== 'custom') applyEase(index, preset);
          }}
        />
      </FieldRow>
      {from !== to && (
        <div className="mb-3">
          <CurveEditor
            value={value}
            from={from}
            to={to}
            selected={index}
            format={formatterOf(ref.channel)}
            playhead={(playhead) => {
              if (playhead < item.start || playhead >= item.start + item.duration) return null;
              return lookItem ? lookTimeOf(lookItem, playhead, fps) : playhead - item.start;
            }}
            onSelect={select}
            onChange={(next) => commit(next, true)}
            onMenu={(event, at) =>
              showContextMenu(
                event.clientX,
                event.clientY,
                easeOptions(t, easeOfKey(keys, at), (preset) => applyEase(at, preset)),
              )
            }
          />
        </div>
      )}
    </InspectorSection>
  );
}
