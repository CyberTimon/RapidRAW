import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { Focus } from 'lucide-react';
import { ClipItem, VideoProject } from '../../../types/video';
import { useVideoStore } from '../../../store/useVideoStore';
import {
  canReframe,
  cancelReframe,
  reframeCandidates,
  reframeClips,
  removeReframe,
  useVideoReframe,
} from '../../../store/videoReframe';
import { JobProgress, TrackedRow } from '../TrackControls';
import { ActionButton } from './InspectorControls';

function ReframeProgress({ ids }: { ids: Array<string> }) {
  const { t } = useTranslation();
  const progress = useVideoReframe((state) => {
    const running = ids.filter((id) => id in state.running);
    return running.length > 0 ? running.reduce((sum, id) => sum + state.running[id], 0) / running.length : null;
  });
  if (progress === null) return null;
  return (
    <JobProgress
      label={t('video.reframe.progress', { percent: Math.round(progress * 100) })}
      progress={progress}
      onCancel={() => cancelReframe(ids)}
    />
  );
}

export function ReframeRow({ item }: { item: ClipItem }) {
  const { t } = useTranslation();
  const project = useVideoStore((state) => state.project);
  const media = useVideoStore((state) => state.media);
  const available = useMemo(() => !!project && canReframe(project, item, media), [project, item, media]);
  const running = useVideoReframe((state) => item.id in state.running);
  const track = item.transform.track;

  if (!running && !track?.reframe && !available) return null;
  return (
    <div className="mb-3">
      {running ? (
        <ReframeProgress ids={[item.id]} />
      ) : track?.reframe ? (
        <TrackedRow track={track} span={null} label={t('video.reframe.done')} onRemove={() => removeReframe(item.id)} />
      ) : (
        <ActionButton icon={Focus} label={t('video.reframe.action')} onClick={() => void reframeClips([item.id])} />
      )}
    </div>
  );
}

export function ReframeClips({ project }: { project: VideoProject }) {
  const { t } = useTranslation();
  const media = useVideoStore((state) => state.media);
  const candidates = useMemo(() => reframeCandidates(project, media), [project, media]);
  const running = useVideoReframe(useShallow((state) => Object.keys(state.running)));

  if (running.length > 0)
    return (
      <div className="mb-3">
        <ReframeProgress ids={running} />
      </div>
    );
  if (candidates.length === 0) return null;
  return (
    <ActionButton
      className="mb-3"
      icon={Focus}
      label={t('video.reframe.clips')}
      onClick={() => void reframeClips(candidates)}
    />
  );
}
