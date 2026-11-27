import { ReactNode } from 'react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import { AdjustmentItem, ClipItem, VideoProject } from '../../types/video';
import Text from '../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';
import { lookTargetOf, useVideoStore } from '../../store/useVideoStore';
import { mediaOf } from '../../utils/video/model';

type LookNeed = 'clip' | 'media';

const UNSUPPORTED: Record<LookNeed, ParseKeys> = {
  clip: 'video.lookTarget.noCrop',
  media: 'video.lookTarget.mediaOnly',
};

const supports = (project: VideoProject, item: ClipItem | AdjustmentItem, need?: LookNeed) => {
  if (!need) return true;
  if (item.type !== 'clip') return false;
  const kind = mediaOf(project, item.media)?.kind;
  return need === 'clip' || kind === 'image' || kind === 'video';
};

export function PanelNotice({ message }: { message: ParseKeys }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-center text-center h-full p-6">
      <Text variant={TextVariants.heading} color={TextColors.secondary} weight={TextWeights.normal}>
        {t(message)}
      </Text>
    </div>
  );
}

export default function LookPanelFrame({
  children,
  needs,
  browsable = false,
}: {
  children: ReactNode;
  needs?: LookNeed;
  browsable?: boolean;
}) {
  const state = useVideoStore((video) => {
    if (video.session?.kind !== 'project' || !video.project) return 'photo';
    const target = lookTargetOf(video.project, video.selection);
    if (!target) return 'empty';
    const path = target.type === 'clip' ? mediaOf(video.project, target.media)?.path : null;
    if (path && video.offline[path]) return 'offline';
    if (!supports(video.project, target, needs)) return 'unsupported';
    return target.id === video.editorItemId ? 'target' : 'pending';
  });

  if (state === 'photo') return <>{children}</>;

  if (state === 'offline') return <PanelNotice message="video.lookTarget.offline" />;

  if (state === 'unsupported' && needs) return <PanelNotice message={UNSUPPORTED[needs]} />;

  if (state === 'empty' && !browsable) return <PanelNotice message="video.inspector.noSelection" />;

  return (
    <div
      className={clsx(
        'h-full transition-opacity duration-150',
        state === 'pending' && 'opacity-50 pointer-events-none delay-200',
      )}
    >
      {children}
    </div>
  );
}
