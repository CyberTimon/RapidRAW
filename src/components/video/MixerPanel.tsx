import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Volume2, VolumeX } from 'lucide-react';
import Slider from '../ui/Slider';
import Text from '../ui/Text';
import PanelHeader from '../ui/PanelHeader';
import { TextVariants } from '../../types/typography';
import { AudioTrack, TrackKind, VideoTrack } from '../../types/video';
import { useVideoStore } from '../../store/useVideoStore';
import { editAudio } from '../../store/videoPlayback';
import { updateTrack } from '../../utils/video/edit';
import { VOLUME_SLIDER, dbToGain, gainToDb } from '../../utils/video/sound';
import { trackLabel } from './timeline/layout';
import OutputAnalysis from './audio/OutputAnalysis';
import TrackToggle from './TrackToggle';

const ChannelStrip = memo(function ChannelStrip({
  label,
  track,
  kind,
  index,
}: {
  label: string;
  track: VideoTrack | AudioTrack;
  kind: TrackKind;
  index: number;
}) {
  const { t } = useTranslation();
  const patch = (update: Parameters<typeof updateTrack>[3], key?: string) =>
    editAudio((project) => updateTrack(project, kind, index, update), key ? `${key}:${track.id}` : undefined);
  return (
    <div className="rounded-md bg-surface p-2.5 space-y-2">
      <div className="flex items-center gap-1.5">
        <Text as="span" variant={TextVariants.small} className="flex-1 font-medium text-text-primary">
          {label}
        </Text>
        <TrackToggle
          tone="solo"
          active={!!track.solo}
          className="w-6 h-6 text-[11px] font-semibold"
          onClick={() => patch({ solo: !track.solo })}
          label={t('video.mixer.solo')}
        >
          S
        </TrackToggle>
        <TrackToggle
          tone="off"
          active={track.muted}
          className="w-6 h-6"
          onClick={() => patch({ muted: !track.muted })}
          label={track.muted ? t('video.clip.unmute') : t('video.clip.mute')}
        >
          {track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
        </TrackToggle>
      </div>
      <Slider
        label={t('video.mixer.volume')}
        {...VOLUME_SLIDER}
        value={gainToDb(track.volume ?? 1)}
        disabled={track.muted}
        onChange={(event) => patch({ volume: dbToGain(Number(event.target.value)) }, 'trackVolume')}
      />
      <Slider
        label={t('video.mixer.pan')}
        min={-100}
        max={100}
        step={1}
        value={Math.round((track.pan ?? 0) * 100)}
        defaultValue={0}
        disabled={track.muted}
        onChange={(event) => patch({ pan: Number(event.target.value) / 100 }, 'trackPan')}
      />
    </div>
  );
});

const hasAudio = (track: VideoTrack | AudioTrack, kind: TrackKind) =>
  kind === 'audio' || track.items.some((item) => item.type === 'clip');

export default function MixerPanel() {
  const { t } = useTranslation();
  const project = useVideoStore((s) => s.project);
  if (!project) return null;
  const strips = [
    ...project.videoTracks.map((track, index) => ({ track, kind: 'video' as TrackKind, index })),
    ...project.audioTracks.map((track, index) => ({ track, kind: 'audio' as TrackKind, index })),
  ].filter(({ track, kind }) => hasAudio(track, kind));
  const master = project.masterVolume ?? 1;

  return (
    <div className="flex flex-col h-full">
      <PanelHeader title={t('video.mixer.title')} />
      <div className="grow overflow-y-auto custom-scrollbar p-3 space-y-2">
        <div className="rounded-md bg-surface p-2.5 space-y-3">
          <Text as="span" variant={TextVariants.small} className="block font-medium text-text-primary">
            {t('video.mixer.master')}
          </Text>
          <OutputAnalysis />
          <Slider
            label={t('video.mixer.volume')}
            {...VOLUME_SLIDER}
            value={gainToDb(master)}
            onChange={(event) =>
              editAudio(
                (current) => ({ ...current, masterVolume: dbToGain(Number(event.target.value)) }),
                'masterVolume',
              )
            }
          />
        </div>
        {strips.map(({ track, kind, index }) => (
          <ChannelStrip
            key={track.id}
            label={trackLabel(kind, index, t('video.timeline.main'))}
            track={track}
            kind={kind}
            index={index}
          />
        ))}
      </div>
    </div>
  );
}
