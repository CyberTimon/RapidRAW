import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { FoldHorizontal, Trash2 } from 'lucide-react';
import Text from '../../ui/Text';
import { TextVariants } from '../../../types/typography';
import { VideoProject } from '../../../types/video';
import { useContextMenu } from '../../../context/ContextMenuContext';
import { editProject, setVideo, useVideoStore } from '../../../store/useVideoStore';
import { deleteGap, selectGap, useGapSelection } from '../../../store/videoEditing';
import { closeAllGaps, mainGaps } from '../../../utils/video/edit';
import { formatDuration } from '../../../utils/video/time';
import { spanBox } from './layout';

const LABEL_MIN_WIDTH = 40;

export default function GapLayer({ project, pps }: { project: VideoProject; pps: number }) {
  const { t } = useTranslation();
  const { showContextMenu } = useContextMenu();
  const selected = useGapSelection((state) => state.selected);
  const itemsSelected = useVideoStore((state) => state.selection.length > 0);
  const gaps = useMemo(() => mainGaps(project), [project]);

  return gaps.map((gap) => {
    const isSelected = !itemsSelected && selected === gap.id;
    const { left, width } = spanBox(gap.start, gap.end, pps);
    return (
      <div
        key={gap.id}
        className={clsx(
          'absolute top-1 bottom-1 rounded-md border border-dashed flex items-center justify-center transition-colors',
          isSelected ? 'border-accent bg-accent/10' : 'border-transparent hover:border-text-secondary/40',
        )}
        style={{ left, width }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setVideo({ selection: [] });
          selectGap(gap.id);
          showContextMenu(event.clientX, event.clientY, [
            {
              icon: Trash2,
              label: t('video.timeline.deleteGap'),
              isDestructive: true,
              onClick: () => deleteGap(gap.id),
              shortcut: 'video_delete',
            },
            {
              icon: FoldHorizontal,
              label: t('video.timeline.closeAllGaps'),
              onClick: () => {
                selectGap(null);
                editProject(closeAllGaps);
              },
            },
          ]);
        }}
        data-gap={gap.id}
      >
        {isSelected && width >= LABEL_MIN_WIDTH && (
          <Text as="span" variant={TextVariants.small} className="tabular-nums pointer-events-none">
            {formatDuration(gap.end - gap.start)}
          </Text>
        )}
      </div>
    );
  });
}
