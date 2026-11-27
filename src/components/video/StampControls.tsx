import { useTranslation } from 'react-i18next';
import SegmentedControl from '../ui/SegmentedControl';
import Text from '../ui/Text';
import { TextColors, TextVariants } from '../../types/typography';
import { useVideoStore } from '../../store/useVideoStore';
import { sourceFpsOf } from '../../store/videoEditing';
import { maskItem, maskTrackKey, trackStampSource, useVideoMotion } from '../../store/videoMotion';
import { stampWarpsNow, useVideoRetouch } from '../../store/videoStamps';
import { maskTrackSpan } from '../../utils/video/edit';
import { SourceMode, StampContainer, shownStamp, storedStamp } from '../../utils/video/maskTracking';
import MaskTrackingControls, { ownedUpdater } from './MaskTracking';
import { TrackedRow } from './TrackControls';

const SOURCE_MODES: Array<SourceMode> = ['follow', 'fixed', 'track'];

export default function StampControls({
  container,
  updateContainer,
}: {
  container: StampContainer;
  updateContainer(id: string, data: Partial<StampContainer>): void;
}) {
  const { t } = useTranslation();
  const isVideo = useVideoRetouch();
  const project = useVideoStore((state) => state.project);
  const sourceKey = useVideoStore(() => maskTrackKey(`${container.id}:source`));
  const tracking = useVideoMotion((state) => state.tracking !== null);
  if (!isVideo) return null;
  const mode = container.sourceMode ?? 'follow';
  const hasSource = container.subMasks.some((subMask) => subMask.parameters?.sourceX !== undefined);
  const trackedItem = project ? maskItem() : null;

  const setMode = (sourceMode: SourceMode) => {
    const before = stampWarpsNow(container);
    const after = stampWarpsNow({ ...container, sourceMode });
    updateContainer(container.id, {
      sourceMode,
      subMasks: container.subMasks.map((subMask) => {
        const { sourceX, sourceY } = shownStamp(subMask.type, subMask.parameters ?? {}, before);
        if (sourceX === undefined || sourceY === undefined) return subMask;
        const stored = storedStamp(subMask.type, { sourceX, sourceY }, after);
        return { ...subMask, parameters: { ...subMask.parameters, sourceX: stored.sourceX, sourceY: stored.sourceY } };
      }),
    });
  };

  const trackSource = () => {
    const owner = maskItem()?.id ?? null;
    const update = ownedUpdater<StampContainer>('stamp', container.id, updateContainer);
    void trackStampSource(container, (sourceTrack) => update(owner, () => ({ sourceTrack })));
  };

  return (
    <MaskTrackingControls
      kind="stamp"
      container={container}
      updateContainer={updateContainer}
      jobs={
        mode === 'track'
          ? [
              {
                key: sourceKey,
                label: t('video.stampTracking.trackSource'),
                disabled: !hasSource,
                onTrack: trackSource,
              },
            ]
          : []
      }
    >
      <div className="space-y-1.5">
        <Text variant={TextVariants.small} color={TextColors.secondary} className="block">
          {t('video.stampTracking.source')}
        </Text>
        <SegmentedControl
          options={SOURCE_MODES.map((id) => ({
            id,
            label: t(`video.stampTracking.modes.${id}`),
            tooltip: t(`video.stampTracking.modes.${id}Tip`),
          }))}
          value={mode}
          disabled={tracking}
          onChange={setMode}
        />
      </div>
      {mode === 'track' && (
        <TrackedRow
          track={container.sourceTrack}
          span={
            trackedItem && project
              ? maskTrackSpan(project, trackedItem, container.sourceTrack, sourceFpsOf(project, trackedItem))
              : null
          }
          durationKey="video.stampTracking.sourceTracked"
          onRemove={() => updateContainer(container.id, { sourceTrack: null })}
        />
      )}
    </MaskTrackingControls>
  );
}
