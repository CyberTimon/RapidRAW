import { useTranslation } from 'react-i18next';
import { Unlink } from 'lucide-react';
import Slider, { type SliderChangeEvent } from '../../ui/Slider';
import Switch from '../../ui/Switch';
import Text from '../../ui/Text';
import { TextColors, TextVariants } from '../../../types/typography';
import { AudioItem, ClipItem } from '../../../types/video';
import { editProject } from '../../../store/useVideoStore';
import { editAudio } from '../../../store/videoPlayback';
import { DEFAULT_DUCK_DB, MAX_DUCK_DB, MIN_DUCK_DB } from '../../../store/videoDucking';
import { detachAudio } from '../../../utils/video/edit';
import { GAIN_DB, VOLUME_SLIDER, compressorOf, formatDb } from '../../../utils/video/sound';
import EqualizerGraph from '../audio/EqualizerGraph';
import DynamicsGraph from '../audio/DynamicsGraph';
import OutputAnalysis from '../audio/OutputAnalysis';
import { ActionButton, AnimatedEdit, AnimatedSlider, InspectorSection, editItem } from './InspectorControls';

type Audible = ClipItem | AudioItem;

export default function AudioSections({ item, canDetach }: { item: Audible; canDetach: boolean }) {
  const { t } = useTranslation();
  const compress = item.compress ?? 0;
  const compressor = compressorOf(compress);
  const editVolume: AnimatedEdit = (update, merge) =>
    editItem<Audible>(
      item.id,
      merge ? 'volume' : null,
      (current) => ({ ...current, volume: update(current.volume) }),
      editAudio,
    );
  const setAmount = (key: 'compress' | 'denoise') => (event: SliderChangeEvent) => {
    const value = Number(event.target.value);
    if (Number.isFinite(value)) editItem<Audible>(item.id, key, { [key]: value / 100 }, editAudio);
  };

  return (
    <>
      <InspectorSection id="audio" title={t('video.inspector.audio')}>
        <div className="mb-3">
          <OutputAnalysis item={item.id} />
        </div>
        <AnimatedSlider
          start={item.start}
          duration={item.duration}
          label={t('video.inspector.volume')}
          value={item.volume}
          {...VOLUME_SLIDER}
          unit={GAIN_DB}
          disabled={item.muted}
          onEdit={editVolume}
        />
        <Switch
          className="mb-3"
          label={t('video.inspector.mute')}
          checked={item.muted}
          onChange={(muted: boolean) => editItem<Audible>(item.id, null, { muted }, editAudio)}
        />
        {item.type === 'audio' && (
          <>
            <Switch
              className="mb-3"
              label={t('video.inspector.duck')}
              checked={item.duck != null}
              disabled={item.muted}
              onChange={(on: boolean) =>
                editItem<AudioItem>(item.id, null, { duck: on ? -DEFAULT_DUCK_DB : null }, editAudio)
              }
            />
            {item.duck != null && (
              <Slider
                label={t('video.inspector.duckAmount')}
                min={MIN_DUCK_DB}
                max={MAX_DUCK_DB}
                step={1}
                value={-item.duck}
                defaultValue={DEFAULT_DUCK_DB}
                suffix=" dB"
                fillOrigin="min"
                disabled={item.muted}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value)) editItem<AudioItem>(item.id, 'duck', { duck: -value }, editAudio);
                }}
              />
            )}
          </>
        )}
        {canDetach && (
          <ActionButton
            icon={Unlink}
            label={t('video.inspector.detachAudio')}
            disabled={item.muted}
            onClick={() => editProject((project) => detachAudio(project, item.id))}
          />
        )}
      </InspectorSection>
      <InspectorSection id="equalizer" title={t('video.audio.equalizer')}>
        <EqualizerGraph
          sound={item}
          item={item.id}
          disabled={item.muted}
          onChange={(patch, mergeKey) => editItem<Audible>(item.id, mergeKey, patch, editAudio)}
        />
      </InspectorSection>
      <InspectorSection id="enhance" title={t('video.audio.enhance')}>
        <div className="flex items-start gap-3 mb-1">
          <DynamicsGraph amount={compress} />
          <div className="min-w-0 flex-1">
            <Slider
              label={t('video.inspector.compress')}
              min={0}
              max={100}
              step={1}
              value={Math.round(compress * 100)}
              defaultValue={0}
              suffix="%"
              fillOrigin="min"
              disabled={item.muted}
              onChange={setAmount('compress')}
            />
            {compress > 0 && (
              <Text variant={TextVariants.small} color={TextColors.secondary}>
                {t('video.audio.compressorInfo', {
                  threshold: formatDb(compressor.threshold),
                  ratio: compressor.ratio.toFixed(1),
                })}
              </Text>
            )}
          </div>
        </div>
        <Slider
          label={t('video.inspector.denoise')}
          min={0}
          max={100}
          step={1}
          value={Math.round((item.denoise ?? 0) * 100)}
          defaultValue={0}
          suffix="%"
          fillOrigin="min"
          disabled={item.muted}
          onChange={setAmount('denoise')}
        />
      </InspectorSection>
    </>
  );
}
