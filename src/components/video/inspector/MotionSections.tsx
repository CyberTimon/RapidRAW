import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import SegmentedControl from '../../ui/SegmentedControl';
import Text from '../../ui/Text';
import { TextVariants } from '../../../types/typography';
import { ClipItem, SolidItem, TitleItem, Transform } from '../../../types/video';
import {
  STABILIZE_LEVELS,
  TRACKED_CHANNELS,
  cancelTracking,
  removeLayerTrack,
  setPinFit,
  setStabilizeLevel,
  setTrackAttach,
  setTrackKind,
  stabilizeLevelOf,
  startTrackingPlacement,
  trackLayer,
  useVideoMotion,
  useTrackDone,
  watchAnalysis,
} from '../../../store/videoMotion';
import { useVideoStore } from '../../../store/useVideoStore';
import { keyAt, removeKeyAt, toggleKeyAt } from '../../../utils/video/animation';
import { layerTrackCoverage, layerTrackSpan } from '../../../utils/video/edit';
import { LAYER_ATTACH, isPlanar } from '../../../utils/video/maskTracking';
import { formatDuration } from '../../../utils/video/time';
import {
  AttachControl,
  JobProgress,
  KeyframesRow,
  PinFitControl,
  TrackKindControl,
  Tracker,
  useAttachChoice,
} from '../TrackControls';
import { ActionButton, InspectorSection, editItem, useAnimatedKeys } from './InspectorControls';

type Trackable = ClipItem | TitleItem | SolidItem;

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

  const tracked = item.transform.track?.reframe ? null : item.transform.track;
  const hasTrack = !!tracked?.keys.length;
  const planar = isPlanar(tracked);
  useEffect(() => {
    if (hasTrack) setTrackKind(planar ? 'planar' : 'position');
  }, [item.id, hasTrack, planar]);
  const span = useVideoStore(useShallow((state) => (state.project ? layerTrackSpan(state.project, item) : null)));
  const coverage = useVideoStore(
    useShallow((state) => (state.project && hasTrack ? layerTrackCoverage(state.project, item) : null)),
  );
  const done = useTrackDone(item, tracked, coverage, { onClipBelow: true }) && !placing;
  const attach = useAttachChoice(item.id, tracked, LAYER_ATTACH, (next) => setTrackAttach(item.id, next));

  return (
    <InspectorSection id="tracking" title={t('video.motion.tracking')}>
      <div className="space-y-2">
        <TrackKindControl disabled={running} />
        <AttachControl options={attach.options} value={attach.value} disabled={running} onChange={attach.choose} />
        {attach.value === 'pin' && (
          <PinFitControl
            value={item.transform.pinFit ?? (item.transform.pin ? 'stretch' : 'fill')}
            onChange={(fit) => setPinFit(item.id, fit)}
          />
        )}
        <Tracker
          jobs={[
            {
              key: item.id,
              done: done ? t('video.tracking.done', { duration: formatDuration(span ? span[1] - span[0] : 0) }) : null,
              onTrack: () => (placing ? void trackLayer(item.id) : startTrackingPlacement(item.id)),
              onRemove: hasTrack ? () => removeLayerTrack(item.id) : undefined,
            },
          ]}
        />
        {placing && !running && <ActionButton icon={X} label={t('video.tracking.cancel')} onClick={cancelTracking} />}
        <TransformKeyframes item={item} />
      </div>
    </InspectorSection>
  );
}
