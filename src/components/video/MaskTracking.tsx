import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Invokes } from '../../types/invokes';
import { useTranslation } from 'react-i18next';
import { Crosshair, Pipette, Sparkles, X } from 'lucide-react';
import Slider from '../ui/Slider';
import Switch from '../ui/Switch';
import SegmentedControl from '../ui/SegmentedControl';
import Text from '../ui/Text';
import { TextColors, TextVariants } from '../../types/typography';
import { AdjustmentItem, ClipItem, VideoProject } from '../../types/video';
import { useEditorStore } from '../../store/useEditorStore';
import { editItemLook, isCancelled, useVideoStore } from '../../store/useVideoStore';
import { errorText } from '../../utils/errors';
import { sourceFpsOf } from '../../store/videoEditing';
import { useMaskCutout } from '../../store/videoIntegration';
import {
  ColorKey,
  DEFAULT_KEY,
  KEY_PRESETS,
  TrackedContainer,
  VIDEO_AI_MASKS,
  isPlanar,
  isTrackable,
} from '../../utils/video/maskTracking';
import { maskTrackSpan } from '../../utils/video/edit';
import { lookOf } from '../../utils/video/model';
import { numericLeaves } from '../../utils/video/lookAnimation';
import { useEditorLookItem, useLookKeyframes } from './inspector/LookKeyframes';
import { ActionButton, ColorRow, IconToggle } from './inspector/InspectorControls';
import { JobProgress, KeyframesRow, TrackKindControl, TrackedRow, Tracker } from './TrackControls';
import {
  cancelJob,
  clearTrackError,
  defaultTrackArea,
  followAiMasks,
  followsPlayedFrames,
  maskClip,
  maskItem,
  maskTrackKey,
  setTrackKind,
  trackMask,
  unfollowSubMask,
  useVideoMotion,
  withSequences,
} from '../../store/videoMotion';

function ShapeKeyframeRow({
  item,
  project,
  containerId,
}: {
  item: ClipItem | AdjustmentItem;
  project: VideoProject;
  containerId: string;
}) {
  const { t } = useTranslation();
  const look = lookOf(project, item);
  const prefix = `masks.#${containerId}.subMasks.`;
  const paths = look
    ? [...numericLeaves(look).keys()].filter((path) => path.startsWith(prefix) && path.includes('.parameters.'))
    : [];
  const keyframes = useLookKeyframes(item, project, paths);
  if (paths.length === 0) return null;
  return (
    <KeyframesRow
      label={t('video.keyframes.shape')}
      animated={keyframes.animated}
      onKey={keyframes.onKey}
      onPrevious={keyframes.onPrevious}
      onNext={keyframes.onNext}
      onToggle={() => keyframes.toggle(keyframes.onKey)}
    />
  );
}

function ShapeKeyframes({ containerId }: { containerId: string }) {
  const target = useEditorLookItem();
  return target && <ShapeKeyframeRow item={target.item} project={target.project} containerId={containerId} />;
}

type KeyMode = (typeof KEY_PRESETS)[number]['id'] | 'custom';

type TrackArea = 'mask' | 'custom';

const TRACK_AREAS: Array<TrackArea> = ['mask', 'custom'];

const EyeDropperApi = (window as unknown as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } })
  .EyeDropper;

function ColorKeyControls({ value, onChange }: { value: ColorKey; onChange(key: ColorKey): void }) {
  const { t } = useTranslation();
  const preset = KEY_PRESETS.find((entry) => entry.color === value.color)?.id;
  const [custom, setCustom] = useState(!preset);
  const mode: KeyMode = custom || !preset ? 'custom' : preset;
  const set = (patch: Partial<ColorKey>) => onChange({ ...value, ...patch });
  const pick = () =>
    EyeDropperApi &&
    new EyeDropperApi()
      .open()
      .then((result) => set({ color: result.sRGBHex }))
      .catch(() => undefined);
  const slider = (id: 'tolerance' | 'softness' | 'spill', defaultValue: number) => (
    <Slider
      label={t(`video.masks.${id}`)}
      min={0}
      max={100}
      step={1}
      value={value[id]}
      defaultValue={defaultValue}
      fillOrigin="min"
      onChange={(event) => set({ [id]: Number(event.target.value) })}
    />
  );
  return (
    <div className="space-y-3">
      <SegmentedControl<KeyMode>
        options={[...KEY_PRESETS.map(({ id }) => id), 'custom' as const].map((id) => ({
          id,
          label: t(`video.masks.keyColors.${id}`),
        }))}
        value={mode}
        onChange={(next) => {
          setCustom(next === 'custom');
          const color = KEY_PRESETS.find((entry) => entry.id === next)?.color;
          if (color) set({ color });
        }}
      />
      {mode === 'custom' && (
        <ColorRow
          label={t('video.masks.keyColor')}
          value={value.color}
          onChange={(color) => set({ color })}
          action={
            EyeDropperApi && (
              <IconToggle icon={Pipette} label={t('video.masks.pickColor')} isActive={false} onClick={pick} />
            )
          }
        />
      )}
      {slider('tolerance', DEFAULT_KEY.tolerance)}
      {slider('softness', DEFAULT_KEY.softness)}
      {slider('spill', DEFAULT_KEY.spill)}
    </div>
  );
}

export function MaskCutoutControls({
  container,
  onChange,
}: {
  container: TrackedContainer;
  onChange(key: 'cutout' | 'key', value: boolean | ColorKey | null): void;
}) {
  const { t } = useTranslation();
  const available = useMaskCutout();
  if (!available) return null;
  return (
    <>
      <Switch
        checked={!!container.cutout}
        label={t('video.masks.cutout')}
        tooltip={t('video.masks.cutoutHint')}
        onChange={(cutout) => onChange('cutout', cutout)}
      />
      {container.cutout && (
        <Switch
          checked={!!container.key}
          label={t('video.masks.colorKey')}
          tooltip={t('video.masks.colorKeyHint')}
          onChange={(on) => onChange('key', on ? DEFAULT_KEY : null)}
        />
      )}
      {container.cutout && container.key && (
        <ColorKeyControls key={container.id} value={container.key} onChange={(key) => onChange('key', key)} />
      )}
    </>
  );
}

const useSequencesReady = (ids: Array<string>) => {
  const epoch = useVideoMotion((s) => s.aiEpoch);
  const key = ids.join('|');
  const [ready, setReady] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!key) return;
    let live = true;
    const list = key.split('|');
    invoke<Array<boolean>>(Invokes.VideoAiMasksReady, { ids: list })
      .then((found) => live && setReady(Object.fromEntries(list.map((id, index) => [id, found[index]]))))
      .catch(console.error);
    return () => {
      live = false;
    };
  }, [key, epoch]);
  return ready;
};

export default function MaskTrackingControls({
  container,
  updateContainer,
}: {
  container: TrackedContainer | null | undefined;
  updateContainer(id: string, data: Partial<TrackedContainer>): void;
}) {
  const { t } = useTranslation();
  const isVideo = useVideoStore((s) => s.session !== null);
  const [error, setError] = useState<string | null>(null);
  const jobKey = useVideoStore(() => maskTrackKey(container?.id ?? ''));
  const project = useVideoStore((s) => s.project);
  const followProgress = useVideoMotion((s) => s.aiFollow[jobKey] ?? null);
  const tracking = useVideoMotion((s) => s.tracking?.key === jobKey);
  const aiSubMasks = (container?.subMasks ?? []).filter((subMask) => VIDEO_AI_MASKS.includes(subMask.type));
  const ready = useSequencesReady(aiSubMasks.flatMap((subMask) => subMask.parameters?.sequence ?? []));
  const tracked = !!container?.track?.keys.length;
  const planarTrack = isPlanar(container?.track);
  useEffect(() => {
    if (tracked) setTrackKind(planarTrack ? 'planar' : 'position');
  }, [container?.id, tracked, planarTrack]);
  if (!isVideo || !container) return null;
  const trackable = container.subMasks.some(isTrackable);
  const trackedItem = project ? maskItem() : null;
  const followsFrames =
    aiSubMasks.length > 0 &&
    aiSubMasks.every((subMask) => {
      const sequence = subMask.parameters?.sequence;
      return !!sequence && ready[sequence] !== false;
    });
  const followsAll = followsFrames && followsPlayedFrames(container);

  const updateOwned = (owner: string | null, patch: (mask: TrackedContainer) => Partial<TrackedContainer>) => {
    if (!owner) return;
    if (maskItem()?.id === owner) {
      const latest = useEditorStore.getState().adjustments.masks?.find((mask) => mask.id === container.id);
      if (latest) updateContainer(container.id, patch(latest as TrackedContainer));
      return;
    }
    editItemLook(owner, (look) => ({
      ...look,
      masks: look.masks.map((mask) =>
        mask.id === container.id ? { ...mask, ...patch(mask as TrackedContainer) } : mask,
      ),
    }));
  };

  const follow = async () => {
    setError(null);
    const clip = maskClip();
    if (!clip) return setError(t('video.tracking.noClip'));
    const owner = maskItem()?.id ?? null;
    try {
      await followAiMasks(clip.id, container, (sequences) =>
        updateOwned(owner, (latest) => ({ subMasks: withSequences(latest.subMasks, sequences) })),
      );
    } catch (err) {
      if (!isCancelled(err)) setError(errorText(err));
    }
  };

  const unfollow = () => updateContainer(container.id, { subMasks: container.subMasks.map(unfollowSubMask) });

  const track = () => {
    const owner = maskItem()?.id ?? null;
    void trackMask(container, (track) => updateOwned(owner, () => ({ track })));
  };

  const setArea = (area: TrackArea) => {
    clearTrackError();
    updateContainer(container.id, {
      trackArea: area === 'custom' ? defaultTrackArea(container, useEditorStore.getState().adjustments) : null,
    });
  };

  return (
    <div className="rounded-md bg-surface p-2.5 space-y-2">
      <div className="flex items-center gap-2">
        <Crosshair size={14} className="text-text-secondary shrink-0" />
        <Text as="span" variant={TextVariants.small} className="flex-1 font-medium text-text-primary">
          {t('video.maskTracking.title')}
        </Text>
      </div>
      <TrackedRow
        track={container.track}
        span={
          trackedItem && project
            ? maskTrackSpan(project, trackedItem, container.track, sourceFpsOf(project, trackedItem))
            : null
        }
        onRemove={() => updateContainer(container.id, { track: null })}
      />
      {trackable && (
        <div className="grid grid-cols-2 gap-2">
          <SegmentedControl
            options={TRACK_AREAS.map((id) => ({
              id,
              label: t(`video.maskTracking.${id}`),
              tooltip: t(`video.maskTracking.${id}Area`),
            }))}
            value={container.trackArea ? 'custom' : 'mask'}
            disabled={tracking}
            onChange={setArea}
          />
          <TrackKindControl disabled={tracking} />
        </div>
      )}
      <Tracker jobKey={jobKey} disabled={!trackable} onTrack={track} />
      <ShapeKeyframes containerId={container.id} />
      {aiSubMasks.length > 0 &&
        (followProgress !== null ? (
          <JobProgress
            label={t('video.tracking.progress', { percent: Math.round(followProgress * 100) })}
            progress={followProgress}
            onCancel={cancelJob}
          />
        ) : (
          <div className="space-y-2 pt-1">
            {followsFrames && (
              <Text variant={TextVariants.small} color={TextColors.secondary} className="block leading-snug">
                {t(followsAll ? 'video.maskTracking.aiFollowing' : 'video.maskTracking.aiFollowPartial')}
              </Text>
            )}
            <ActionButton
              icon={followsAll ? X : Sparkles}
              label={followsAll ? t('video.tracking.remove') : t('video.maskTracking.aiFollow')}
              disabled={tracking}
              onClick={() => (followsAll ? unfollow() : void follow())}
            />
          </div>
        ))}
      {error && (
        <Text variant={TextVariants.small} className="block text-red-400 leading-snug">
          {error}
        </Text>
      )}
    </div>
  );
}
