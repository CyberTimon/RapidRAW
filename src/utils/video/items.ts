import type { TFunction } from 'i18next';
import { Film, Group, Image as ImageIcon, Layers, Music, Square, Type, type LucideIcon } from 'lucide-react';
import { TimelineItem, VideoProject } from '../../types/video';
import { fileName, mediaOf } from './model';

export const lookItemName = (project: VideoProject, item: TimelineItem, t: TFunction) => {
  if (item.type === 'adjustment') return t('video.timeline.adjustmentLayer');
  if (item.type === 'solid') return t('video.inspector.types.solid');
  if (item.type === 'title') {
    const line = item.text.split('\n').find((text) => text.trim());
    return line?.trim() || t('video.inspector.types.title');
  }
  const media = mediaOf(project, item.media);
  if (media) return media.name ?? fileName(media.path);
  return t(item.type === 'audio' ? 'video.inspector.types.audio' : 'video.inspector.types.clip');
};

export const itemIcon = (project: VideoProject, item: TimelineItem): LucideIcon => {
  if (item.type === 'adjustment') return Layers;
  if (item.type === 'solid') return Square;
  if (item.type === 'title') return Type;
  if (item.type === 'audio') return Music;
  const kind = mediaOf(project, item.media)?.kind;
  return kind === 'sequence' ? Group : kind === 'image' ? ImageIcon : Film;
};
