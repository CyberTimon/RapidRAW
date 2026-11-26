import { useTranslation } from 'react-i18next';
import { CircleDot } from 'lucide-react';
import { useVideoStore } from '../../store/useVideoStore';
import { toggleRecordKeyframes } from '../../store/videoEditing';
import { IconToggle } from './inspector/InspectorControls';

export const RECORDING_CLASS = 'bg-red-500/20 text-red-400 hover:bg-red-500/30';

export function RecordToggle() {
  const { t } = useTranslation();
  const isRecording = useVideoStore((state) => state.recordKeyframes);
  return (
    <IconToggle
      icon={CircleDot}
      label={isRecording ? t('video.keyframes.stopRecording') : t('video.keyframes.record')}
      isActive={isRecording}
      activeClassName={RECORDING_CLASS}
      onClick={toggleRecordKeyframes}
      shortcut="video_record_keyframes"
    />
  );
}
