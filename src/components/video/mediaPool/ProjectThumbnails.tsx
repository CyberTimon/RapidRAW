import { useEffect, useMemo } from 'react';
import { useProcessStore } from '../../../store/useProcessStore';
import { openProjectMedia, useVideoStore } from '../../../store/useVideoStore';

interface ProjectThumbnailsProps {
  onRequestThumbnails(paths: Array<string>): void;
}

export default function ProjectThumbnails({ onRequestThumbnails }: ProjectThumbnailsProps) {
  const media = useVideoStore(openProjectMedia);
  const known = useVideoStore((state) => state.media);
  const visualPaths = useMemo(
    () => (media ?? []).filter((entry) => entry.kind === 'video' || entry.kind === 'image').map((entry) => entry.path),
    [media],
  );
  const unthumbed = useProcessStore((state) => visualPaths.filter((path) => !state.thumbnails[path]).join('\n'));

  useEffect(() => {
    const wanted = unthumbed ? unthumbed.split('\n').filter((path) => known[path]) : [];
    if (wanted.length > 0) onRequestThumbnails(wanted);
  }, [unthumbed, known, onRequestThumbnails]);

  return null;
}
