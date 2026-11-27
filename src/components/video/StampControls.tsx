import { useTranslation } from 'react-i18next';
import { useVideoStore } from '../../store/useVideoStore';
import { sourceFpsOf } from '../../store/videoEditing';
import { maskItem, maskTrackKey, trackStampSource, useTrackDone, useVideoMotion } from '../../store/videoMotion';
import { stampWarpsNow, useVideoRetouch } from '../../store/videoStamps';
import { maskTrackCoverage, maskTrackSpan } from '../../utils/video/edit';
import { formatDuration } from '../../utils/video/time';
import { useShallow } from 'zustand/react/shallow';
import { SourceMode, StampContainer, shownStamp, storedStamp } from '../../utils/video/maskTracking';
import MaskTrackingControls, { ownedUpdater } from './MaskTracking';
import { ChoiceRow } from './TrackControls';

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
  const span = useVideoStore(
    useShallow((state) => {
      const item = state.project ? maskItem() : null;
      return item && state.project
        ? maskTrackSpan(state.project, item, container.sourceTrack, sourceFpsOf(state.project, item))
        : null;
    }),
  );
  const coverage = useVideoStore(
    useShallow((state) => {
      const item = state.project ? maskItem() : null;
      return item && state.project
        ? maskTrackCoverage(state.project, item, container.sourceTrack, sourceFpsOf(state.project, item))
        : null;
    }),
  );
  const trackedItem = project ? maskItem() : null;
  const done = useTrackDone(trackedItem, container.sourceTrack, coverage, {
    onClipBelow: trackedItem?.type === 'adjustment',
  });
  if (!isVideo) return null;
  const mode = container.sourceMode ?? 'follow';
  const hasSource = container.subMasks.some((subMask) => subMask.parameters?.sourceX !== undefined);

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
                done: done
                  ? t('video.stampTracking.sourceDone', { duration: formatDuration(span ? span[1] - span[0] : 0) })
                  : null,
                disabled: !hasSource,
                onTrack: trackSource,
                onRemove: container.sourceTrack?.keys.length
                  ? () => updateContainer(container.id, { sourceTrack: null })
                  : undefined,
              },
            ]
          : []
      }
    >
      <ChoiceRow
        label={t('video.stampTracking.source')}
        options={SOURCE_MODES.map((id) => ({
          id,
          label: t(`video.stampTracking.modes.${id}`),
          tooltip: t(`video.stampTracking.modes.${id}Tip`),
        }))}
        value={mode}
        disabled={tracking}
        onChange={setMode}
      />
    </MaskTrackingControls>
  );
}
