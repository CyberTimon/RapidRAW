import { useTranslation } from 'react-i18next';
import SegmentedControl from '../../ui/SegmentedControl';
import Text from '../../ui/Text';
import { TextVariants } from '../../../types/typography';
import { ClipItem, Interpolation } from '../../../types/video';
import { useVideoStore } from '../../../store/useVideoStore';
import { sourceFpsOf } from '../../../store/videoEditing';
import { interpolationOptions, missingFrames } from '../../../utils/video/interpolation';
import { editItem } from './InspectorControls';

export function InterpolationField({
  value,
  onChange,
}: {
  value: Interpolation;
  onChange(value: Interpolation): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mb-3">
      <Text variant={TextVariants.label} className="block mb-2 select-none">
        {t('video.inspector.frameInterpolation')}
      </Text>
      <SegmentedControl<Interpolation> options={interpolationOptions(t)} value={value} onChange={onChange} />
    </div>
  );
}

export function FrameInterpolation({ item }: { item: ClipItem }) {
  const fallback = useVideoStore((state) => state.project?.settings.interpolation ?? 'none');
  const projectFps = useVideoStore((state) => state.project?.settings.fps);
  const sourceFps = useVideoStore((state) => (state.project ? sourceFpsOf(state.project, item) : undefined));
  if (!projectFps || !sourceFps) return null;
  if (!missingFrames(item, sourceFps, projectFps) && (item.interpolation ?? 'none') === 'none') return null;
  return (
    <InterpolationField
      value={item.interpolation ?? fallback}
      onChange={(choice) => {
        const interpolation = choice === fallback ? undefined : choice;
        if (interpolation !== item.interpolation) editItem<ClipItem>(item.id, null, { interpolation });
      }}
    />
  );
}
