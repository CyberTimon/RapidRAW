import { useTranslation } from 'react-i18next';
import Slider from '../../ui/Slider';
import Switch from '../../ui/Switch';
import SegmentedControl from '../../ui/SegmentedControl';
import Text from '../../ui/Text';
import { TextColors, TextVariants } from '../../../types/typography';
import { ClipItem, MatteKind, SolidItem, TitleItem } from '../../../types/video';
import { useVideoStore } from '../../../store/useVideoStore';
import { hasMatteSource } from '../../../utils/video/matte';
import { DEFAULT_SHUTTER } from '../../../utils/video/shutter';
import { FieldRow, editItem } from './InspectorControls';

type Layered = ClipItem | TitleItem | SolidItem;
type Graphic = TitleItem | SolidItem;

export function TrackMatteFields({ item }: { item: Layered }) {
  const { t } = useTranslation();
  const matte = item.trackMatte ?? null;
  const sourced = useVideoStore((state) => !matte || !state.project || hasMatteSource(state.project.videoTracks, item));
  return (
    <>
      <FieldRow label={t('video.inspector.trackMatte')}>
        <SegmentedControl<'none' | MatteKind>
          className="w-full"
          options={[
            { id: 'none', label: t('video.inspector.mattes.none') },
            { id: 'alpha', label: t('video.inspector.mattes.alpha') },
            { id: 'luma', label: t('video.inspector.mattes.luma') },
          ]}
          value={matte?.kind ?? 'none'}
          onChange={(kind) =>
            editItem<Layered>(item.id, null, {
              trackMatte: kind === 'none' ? null : { kind, invert: matte?.invert ?? false },
            })
          }
        />
      </FieldRow>
      {matte && (
        <>
          <Switch
            className="mb-2"
            label={t('video.inspector.invertMatte')}
            checked={matte.invert}
            onChange={(invert: boolean) => editItem<Layered>(item.id, null, { trackMatte: { ...matte, invert } })}
          />
          {!sourced && (
            <Text variant={TextVariants.small} color={TextColors.secondary} className="block mb-3">
              {t('video.inspector.matteNoSource')}
            </Text>
          )}
        </>
      )}
    </>
  );
}

export function MotionBlurFields({ item }: { item: Graphic }) {
  const { t } = useTranslation();
  const blur = item.motionBlur ?? null;
  return (
    <>
      <Switch
        className="mb-3"
        label={t('video.inspector.motionBlur')}
        checked={!!blur}
        onChange={(on: boolean) =>
          editItem<Graphic>(item.id, null, { motionBlur: on ? { shutter: DEFAULT_SHUTTER } : null })
        }
      />
      {blur && (
        <Slider
          label={t('video.inspector.shutter')}
          min={0}
          max={360}
          step={1}
          value={blur.shutter}
          defaultValue={DEFAULT_SHUTTER}
          suffix="°"
          fillOrigin="min"
          onChange={(event) => {
            const shutter = Number(event.target.value);
            if (Number.isFinite(shutter)) editItem<Graphic>(item.id, 'motionBlur', { motionBlur: { shutter } });
          }}
        />
      )}
    </>
  );
}
