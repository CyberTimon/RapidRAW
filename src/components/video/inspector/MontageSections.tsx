import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ArrowRight,
  Ban,
  Columns2,
  Grid2x2,
  Loader2,
  PictureInPicture2,
  Rows2,
  Scissors,
  Shuffle,
  Square,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react';
import clsx from 'clsx';
import SegmentedControl from '../../ui/SegmentedControl';
import Text from '../../ui/Text';
import { TextVariants } from '../../../types/typography';
import { VideoProject } from '../../../types/video';
import { useVideoStore } from '../../../store/useVideoStore';
import { beatPathOf, useVideoBeats } from '../../../store/videoBeats';
import {
  arrangeSelection,
  beatSources,
  cutSelectionToBeats,
  kenBurnsMoveOf,
  kenBurnsSelection,
  stillsIn,
} from '../../../store/videoMontage';
import { Arrangement, arrangementOf, canArrange } from '../../../utils/video/layouts';
import { BEAT_STEPS, KenBurnsMove } from '../../../utils/video/montage';
import { ActionButton, InspectorSection } from './InspectorControls';

const KEN_BURNS_ICONS: Array<{ id: KenBurnsMove; icon: LucideIcon }> = [
  { id: 'none', icon: Ban },
  { id: 'zoomIn', icon: ZoomIn },
  { id: 'zoomOut', icon: ZoomOut },
  { id: 'panLeft', icon: ArrowLeft },
  { id: 'panRight', icon: ArrowRight },
];

const LAYOUT_ICONS: Array<{ id: Arrangement; icon: LucideIcon }> = [
  { id: 'fullFrame', icon: Square },
  { id: 'sideBySide', icon: Columns2 },
  { id: 'stack', icon: Rows2 },
  { id: 'grid', icon: Grid2x2 },
  { id: 'pictureInPicture', icon: PictureInPicture2 },
];

export function KenBurnsSection() {
  const { t } = useTranslation();
  const { project, selection, media } = useVideoStore(
    useShallow((state) => ({ project: state.project, selection: state.selection, media: state.media })),
  );
  const stills = useMemo(() => (project ? stillsIn(project, selection, media) : []), [project, selection, media]);
  const current = kenBurnsMoveOf(stills);
  return (
    <InspectorSection id="kenBurns" title={t('video.montage.kenBurns')}>
      <SegmentedControl<KenBurnsMove>
        iconOnly
        options={KEN_BURNS_ICONS.map(({ id, icon }) => ({ id, icon, label: t(`video.montage.kenBurnsOptions.${id}`) }))}
        value={current}
        onChange={kenBurnsSelection}
      />
      {current === null && stills.length > 1 && (
        <Text variant={TextVariants.small} className="block mt-1.5 px-0.5">
          {t('video.montage.mixed')}
        </Text>
      )}
      {stills.length > 1 && (
        <ActionButton
          icon={Shuffle}
          label={t('video.montage.kenBurnsOptions.random')}
          className="mt-2"
          onClick={() => kenBurnsSelection('random')}
        />
      )}
    </InspectorSection>
  );
}

function BeatCutSection({ loading }: { loading: boolean }) {
  const { t } = useTranslation();
  return (
    <InspectorSection id="cutToBeat" title={t('video.montage.cutToBeat')}>
      <Text variant={TextVariants.label} className="block mb-2 select-none">
        {t('video.montage.beatsPerCut')}
      </Text>
      <div className="grid grid-cols-3 gap-2">
        {BEAT_STEPS.map((every) => (
          <ActionButton
            key={every}
            icon={loading ? Loader2 : Scissors}
            label={String(every)}
            tooltip={t('video.montage.everyBeat', { count: every })}
            disabled={loading}
            className={clsx(loading && '[&_svg]:animate-spin')}
            onClick={() => void cutSelectionToBeats(every)}
          />
        ))}
      </div>
    </InspectorSection>
  );
}

function ArrangeSection({ project, selection }: { project: VideoProject; selection: Array<string> }) {
  const { t } = useTranslation();
  const media = useVideoStore((state) => state.media);
  const current = useMemo(() => arrangementOf(project, selection, media), [project, selection, media]);
  return (
    <InspectorSection id="arrange" title={t('video.montage.arrange')}>
      <SegmentedControl<Arrangement>
        iconOnly
        options={LAYOUT_ICONS.map(({ id, icon }) => ({ id, icon, label: t(`video.montage.layouts.${id}`) }))}
        value={current}
        onChange={arrangeSelection}
      />
      {current === null && (
        <Text variant={TextVariants.small} className="block mt-1.5 px-0.5">
          {t('video.montage.customLayout')}
        </Text>
      )}
    </InspectorSection>
  );
}

export function SelectionInspector({ project, selection }: { project: VideoProject; selection: Array<string> }) {
  const media = useVideoStore((state) => state.media);
  const analyses = useVideoBeats();
  const stills = stillsIn(project, selection, media).length > 0;
  const sources = beatSources(project, selection);
  const loading = sources.some((item) => analyses[beatPathOf(project, item) ?? ''] === 'loading');
  const arrange = canArrange(project, selection);

  return (
    <>
      {arrange && <ArrangeSection project={project} selection={selection} />}
      {sources.length > 0 && <BeatCutSection loading={loading} />}
      {stills && <KenBurnsSection />}
    </>
  );
}
