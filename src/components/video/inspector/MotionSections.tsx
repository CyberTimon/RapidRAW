import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';
import { Crosshair, Pin, X } from 'lucide-react';
import SegmentedControl from '../../ui/SegmentedControl';
import Switch from '../../ui/Switch';
import Text from '../../ui/Text';
import { TextVariants } from '../../../types/typography';
import { ClipItem, SolidItem, TitleItem, Transform } from '../../../types/video';
import {
  STABILIZE_LEVELS,
  TRACKED_CHANNELS,
  cancelTracking,
  pinToPlane,
  setStabilizeLevel,
  stabilizeLevelOf,
  startTrackingPlacement,
  trackLayer,
  useVideoMotion,
  watchAnalysis,
} from '../../../store/videoMotion';
import { useVideoStore } from '../../../store/useVideoStore';
import { keyAt, removeKeyAt, toggleKeyAt } from '../../../utils/video/animation';
import { layerTrackSpan } from '../../../utils/video/edit';
import { isPlanar } from '../../../utils/video/maskTracking';
import { JobProgress, KeyframesRow, TrackKindControl, TrackedRow, Tracker } from '../TrackControls';
import { ActionButton, InspectorSection, editItem, useAnimatedKeys } from './InspectorControls';

type Trackable = ClipItem | TitleItem | SolidItem;

const samePin = (track: Trackable['transform']['track'], pin: Trackable['transform']['pin']) => {
  const corners = (track?.reference ?? track?.keys[0])?.corners;
  return !!corners && !!pin && corners.every(([x, y], index) => x === pin[index][0] && y === pin[index][1]);
};

export function StabilizeSection({ item, path }: { item: ClipItem; path: string }) {
  const { t } = useTranslation();
  const level = stabilizeLevelOf(item);
  const analysis = useVideoMotion((state) => state.analysis[path]);
  const enabled = level !== 'off';

  useEffect(() => {
    if (enabled) watchAnalysis(path);
  }, [enabled, path]);

  return (
    <InspectorSection id="stabilize" title={t('video.motion.stabilize')}>
      <div className="space-y-2">
        <SegmentedControl
          options={STABILIZE_LEVELS.map((id) => ({ id, label: t(`video.motion.levels.${id}`) }))}
          value={level}
          onChange={(next) => setStabilizeLevel(item.id, path, next)}
        />
        {enabled && analysis?.state === 'running' && (
          <JobProgress
            label={t('video.motion.analyzing', { percent: Math.round(analysis.progress * 100) })}
            progress={analysis.progress}
          />
        )}
        {enabled && analysis?.state === 'failed' && (
          <Text variant={TextVariants.small} className="text-red-400!">
            {t('video.motion.analysisFailed')}
          </Text>
        )}
      </div>
    </InspectorSection>
  );
}

function TransformKeyframes({ item }: { item: Trackable }) {
  const { t } = useTranslation();
  const keys = useAnimatedKeys(
    TRACKED_CHANNELS.map((channel) => item.transform[channel]),
    item.start,
    item.duration,
  );
  const toggle = () => {
    const time = keys.now();
    editItem<Trackable>(item.id, null, (current) => {
      const onKey = TRACKED_CHANNELS.some((channel) => keyAt(current.transform[channel], time, keys.tolerance));
      const transform: Transform = { ...current.transform };
      TRACKED_CHANNELS.forEach((channel) => {
        transform[channel] = onKey
          ? removeKeyAt(transform[channel], time, keys.tolerance)
          : toggleKeyAt(transform[channel], time, keys.tolerance);
      });
      return { ...current, transform };
    });
  };
  return (
    <KeyframesRow
      label={t('video.keyframes.transform')}
      animated={keys.animated}
      onKey={keys.onKey}
      onPrevious={keys.onPrevious}
      onNext={keys.onNext}
      onToggle={toggle}
    />
  );
}

export function TrackingSection({ item }: { item: Trackable }) {
  const { t } = useTranslation();
  const { placing, running } = useVideoMotion(
    useShallow((state) => ({
      placing: state.placing?.itemId === item.id,
      running: state.tracking?.key === item.id,
    })),
  );

  useEffect(
    () => () => {
      const state = useVideoMotion.getState();
      if (state.placing?.itemId === item.id && !state.tracking) cancelTracking();
    },
    [item.id],
  );

  const span = useVideoStore(useShallow((state) => (state.project ? layerTrackSpan(state.project, item) : null)));
  const tracked = item.transform.track?.reframe ? null : item.transform.track;
  const planar = isPlanar(tracked);
  const pinned = planar && !!item.transform.pin;

  return (
    <InspectorSection id="tracking" title={t('video.motion.tracking')}>
      <div className="space-y-2">
        <TrackedRow
          track={tracked}
          span={span}
          onRemove={() =>
            editItem<Trackable>(item.id, null, (current) => ({
              ...current,
              transform: { ...current.transform, track: null },
            }))
          }
        />
        {!!tracked?.keys.length && !pinned && (
          <Switch
            label={t('video.motion.followScale')}
            checked={!tracked.positionOnly}
            onChange={(follows: boolean) =>
              editItem<Trackable>(item.id, null, (current) =>
                current.transform.track
                  ? {
                      ...current,
                      transform: {
                        ...current.transform,
                        track: { ...current.transform.track, positionOnly: !follows },
                      },
                    }
                  : current,
              )
            }
          />
        )}
        {placing ? (
          <>
            <TrackKindControl disabled={running} />
            <Tracker jobKey={item.id} onTrack={() => void trackLayer(item.id)} />
            {!running && <ActionButton icon={X} label={t('video.tracking.cancel')} onClick={cancelTracking} />}
          </>
        ) : (
          <ActionButton
            icon={Crosshair}
            label={t('video.motion.trackMotion')}
            onClick={() => startTrackingPlacement(item.id)}
          />
        )}
        {planar && !placing && !samePin(tracked, item.transform.pin) && (
          <ActionButton icon={Pin} label={t('video.tracking.pinToPlane')} onClick={() => pinToPlane(item.id)} />
        )}
        <TransformKeyframes item={item} />
      </div>
    </InspectorSection>
  );
}
