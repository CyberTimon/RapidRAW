import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import { RotateCcw, Trash2 } from 'lucide-react';
import Dropdown from '../../ui/Dropdown';
import Text from '../../ui/Text';
import { TextVariants } from '../../../types/typography';
import { OPTION_SEPARATOR } from '../../../types/ui';
import { AudioItem, ClipItem, Keyframe, Ticks } from '../../../types/video';
import { useContextMenu } from '../../../context/ContextMenuContext';
import { getVideo, setPlayhead, useVideoStore } from '../../../store/useVideoStore';
import { selectKeyframe, useKeyframeSelection } from '../../../store/videoEditing';
import { speedOf } from '../../../utils/video/edit';
import { easeOfKey, valueAt, withEase } from '../../../utils/video/animation';
import { MAX_SPEED, MIN_SPEED, clipSpeed, isRamped, locateItem, sourceLength } from '../../../utils/video/model';
import { formatDuration, frameTicks } from '../../../utils/video/time';
import CurveEditor, { CurveScale, easeOptions } from './CurveEditor';
import { AnimatedEdit, FieldRow } from './InspectorControls';

type CurvePreset = 'glide' | 'hero' | 'bullet' | 'jumpCut' | 'flashIn' | 'flashOut';

const CURVES: Record<CurvePreset, Array<[number, number]>> = {
  glide: [
    [0, 2],
    [0.25, 2],
    [0.4, 0.6],
    [0.6, 0.6],
    [0.75, 2],
    [1, 2],
  ],
  hero: [
    [0, 1.5],
    [0.35, 1.5],
    [0.5, 0.25],
    [0.65, 1.5],
    [1, 1.5],
  ],
  bullet: [
    [0, 1.5],
    [0.3, 1.5],
    [0.45, 0.2],
    [0.7, 0.2],
    [0.85, 1.5],
    [1, 1.5],
  ],
  jumpCut: [
    [0, 1],
    [0.4, 1],
    [0.47, 6],
    [0.53, 6],
    [0.6, 1],
    [1, 1],
  ],
  flashIn: [
    [0, 4],
    [0.4, 1],
    [1, 1],
  ],
  flashOut: [
    [0, 1],
    [0.6, 1],
    [1, 4],
  ],
};

const PRESETS: Array<CurvePreset> = ['glide', 'hero', 'bullet', 'jumpCut', 'flashIn', 'flashOut'];

const LOW = Math.log2(MIN_SPEED);
const HIGH = Math.log2(MAX_SPEED);

const SPEED_SCALE: CurveScale = {
  toUnit: (speed) => (Math.log2(clipSpeed({ speed })) - LOW) / (HIGH - LOW),
  fromUnit: (unit) => clipSpeed({ speed: 2 ** (LOW + unit * (HIGH - LOW)) }),
  grid: [0.25, 0.5, 1, 2, 4, 8].map((value) => ({ value, label: `${value}×`, strong: value === 1 })),
  snaps: [1],
};

const formatSpeed = (speed: number) => `${speed.toFixed(2)}×`;

const presetKeys = (preset: CurvePreset, base: number, duration: Ticks): Array<Keyframe> =>
  CURVES[preset].map(([position, multiplier]) => ({
    time: Math.round(position * duration),
    value: base * multiplier,
    ease: 'ease',
  }));

const shapeOf = (keys: Array<Keyframe>, duration: Ticks, base: number) =>
  JSON.stringify(
    keys.map((key) => [
      Math.round((key.time / Math.max(1, duration)) * 100),
      Math.round((key.value / base) * 100),
      key.ease,
      key.in,
      key.out,
    ]),
  );

type Timed = ClipItem | AudioItem;

const presetOf = (item: Timed): CurvePreset | null => {
  const base = clipSpeed(item);
  const current = shapeOf(item.speedRamp ?? [], item.duration, base);
  return (
    PRESETS.find((preset) => shapeOf(presetKeys(preset, base, item.duration), item.duration, base) === current) ?? null
  );
};

function SpeedGraph({ item, onEdit }: { item: Timed; onEdit: AnimatedEdit }) {
  const { t } = useTranslation();
  const { showContextMenu } = useContextMenu();
  const step = useVideoStore((state) => (state.project ? frameTicks(state.project.settings.fps) : 1));
  const keys = item.speedRamp ?? [];
  const selectedTime = useKeyframeSelection((state) =>
    state.selected?.itemId === item.id ? state.selected.time : null,
  );
  const found = selectedTime === null ? -1 : keys.findIndex((key) => Math.abs(key.time - selectedTime) <= step / 2);

  const focus = (index: number) => {
    const project = getVideo().project;
    const current = project ? locateItem(project, item.id)?.item : null;
    const key = current?.type === 'clip' || current?.type === 'audio' ? current.speedRamp?.[index] : undefined;
    if (!current || !key) return;
    selectKeyframe({ itemId: item.id, time: key.time });
    setPlayhead(current.start + Math.min(key.time, current.duration - step));
  };

  const commit = (next: Array<Keyframe>, merge: boolean, index: number | null) => {
    onEdit(
      () => (next.length > 1 ? { value: item.speed, keys: next } : { value: next[0]?.value ?? item.speed }),
      merge,
    );
    if (index !== null) focus(index);
  };

  const add = (current: Array<Keyframe>, time: Ticks) => {
    const base: Array<Keyframe> =
      current.length > 0
        ? current
        : [
            { time: 0, value: item.speed, ease: 'ease' },
            { time: item.duration, value: item.speed, ease: 'ease' },
          ];
    const added: Keyframe = { time, value: valueAt({ value: item.speed, keys: base }, time), ease: 'ease' };
    const next = [...base.filter((key) => Math.abs(key.time - time) > step / 2), added].sort((a, b) => a.time - b.time);
    return { keys: next, index: next.indexOf(added) };
  };

  const remove = (index: number) => {
    if (!keys[index]) return;
    selectKeyframe(null);
    commit(
      keys.filter((_, other) => other !== index),
      false,
      null,
    );
  };

  const openMenu = (event: React.MouseEvent, index: number) =>
    showContextMenu(event.clientX, event.clientY, [
      ...easeOptions(t, easeOfKey(keys, index), (preset) => commit(withEase(keys, index, preset), false, index)),
      { type: OPTION_SEPARATOR },
      { icon: Trash2, label: t('video.keyframes.delete'), isDestructive: true, onClick: () => remove(index) },
    ]);

  return (
    <div className="mb-3">
      <CurveEditor
        value={speedOf(item)}
        from={0}
        to={item.duration}
        scale={SPEED_SCALE}
        selected={found < 0 ? null : found}
        format={formatSpeed}
        playhead={(playhead) =>
          playhead >= item.start && playhead < item.start + item.duration ? playhead - item.start : null
        }
        points={{ step, add, remove }}
        onSelect={focus}
        onChange={(next, index) => commit(next, true, index)}
        onMenu={openMenu}
      />
    </div>
  );
}

export function SpeedCurve({ item, onEdit }: { item: Timed; onEdit: AnimatedEdit }) {
  const { t } = useTranslation();
  const fps = useVideoStore((state) => state.project?.settings.fps);
  const preset = presetOf(item);
  return (
    <>
      <FieldRow label={t('video.inspector.speedCurve')}>
        {isRamped(item) && fps && (
          <div className="flex items-center gap-2">
            <Text variant={TextVariants.small} className="tabular-nums">
              {`${formatDuration(sourceLength(item, fps))} → ${formatDuration(item.duration)}`}
            </Text>
            <button
              type="button"
              className="w-5 h-5 flex items-center justify-center text-text-secondary hover:text-text-primary"
              onClick={() => onEdit(() => ({ value: clipSpeed(item) }), false)}
              data-tooltip={t('video.inspector.resetCurve')}
              aria-label={t('video.inspector.resetCurve')}
            >
              <RotateCcw size={13} />
            </button>
          </div>
        )}
      </FieldRow>
      <SpeedGraph item={item} onEdit={onEdit} />
      <FieldRow label={t('video.inspector.speedPreset')}>
        <Dropdown<CurvePreset | 'none'>
          className="w-full max-w-44"
          options={(['none', ...PRESETS] as const).map((id) => ({
            value: id,
            label: t(`video.inspector.curves.${id}` as ParseKeys),
          }))}
          value={preset ?? (isRamped(item) ? null : 'none')}
          placeholder={t('video.inspector.curves.custom')}
          onChange={(next) => {
            const base = clipSpeed(item);
            onEdit(
              () => (next === 'none' ? { value: base } : { value: base, keys: presetKeys(next, base, item.duration) }),
              false,
            );
          }}
        />
      </FieldRow>
    </>
  );
}
