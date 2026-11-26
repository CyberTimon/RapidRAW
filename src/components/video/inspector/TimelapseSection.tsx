import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import Switch from '../../ui/Switch';
import Text from '../../ui/Text';
import { TextColors, TextVariants } from '../../../types/typography';
import {
  TimelapseMedia,
  retryTimelapse,
  setTimelapseDeflicker,
  useTimelapseState,
} from '../../../store/videoTimelapse';
import TimelapseProgress from '../TimelapseProgress';
import { ActionButton, FieldRow, InspectorSection } from './InspectorControls';

export default function TimelapseSection({ media }: { media: TimelapseMedia }) {
  const { t } = useTranslation();
  const state = useTimelapseState(media.path);
  return (
    <InspectorSection id="timelapse" title={t('video.timelapse.section')}>
      <FieldRow label={t('video.timelapse.photos')}>
        <Text variant={TextVariants.label} color={TextColors.primary}>
          {media.timelapse.frames.length}
        </Text>
      </FieldRow>
      <Switch
        label={t('video.timelapse.deflicker')}
        checked={media.timelapse.deflicker}
        onChange={(deflicker) => setTimelapseDeflicker(media, deflicker)}
      />
      {state?.state === 'running' && (
        <>
          <Text variant={TextVariants.small} color={TextColors.secondary} className="mt-3 mb-1.5 block">
            {t('video.timelapse.rendering', { percent: Math.round(state.progress * 100) })}
          </Text>
          <TimelapseProgress path={media.path} className="bg-bg-primary" />
        </>
      )}
      {state?.state === 'failed' && (
        <>
          <Text variant={TextVariants.small} color={TextColors.secondary} className="mt-3 mb-2 block">
            {state.reason === 'cancelled'
              ? t('video.timelapse.cancelled')
              : state.file
                ? t(state.reason === 'missing' ? 'video.timelapse.missingPhoto' : 'video.timelapse.failedPhoto', {
                    file: state.file,
                  })
                : (state.error ?? t('video.timelapse.failed'))}
          </Text>
          <ActionButton icon={RotateCcw} label={t('video.timelapse.retry')} onClick={() => retryTimelapse(media)} />
        </>
      )}
    </InspectorSection>
  );
}
