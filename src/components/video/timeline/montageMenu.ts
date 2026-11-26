import { TFunction } from 'i18next';
import { AudioWaveform, Check, LayoutGrid, ZoomIn } from 'lucide-react';
import { Option } from '../../../types/ui';
import { getVideo } from '../../../store/useVideoStore';
import {
  arrangeSelection,
  canCutToBeats,
  cutSelectionToBeats,
  kenBurnsMoveOf,
  kenBurnsSelection,
  stillsIn,
} from '../../../store/videoMontage';
import { ARRANGEMENTS, arrangementOf, canArrange } from '../../../utils/video/layouts';
import { BEAT_STEPS, KEN_BURNS, KenBurnsChoice } from '../../../utils/video/montage';

const KEN_BURNS_CHOICES: Array<KenBurnsChoice> = ['none', ...KEN_BURNS, 'random'];

export const montageMenu = (t: TFunction): Array<Option> => {
  const { project, selection, media } = getVideo();
  if (!project) return [];
  const stills = stillsIn(project, selection, media);
  const current = kenBurnsMoveOf(stills);
  const arrangement = canArrange(project, selection) ? arrangementOf(project, selection, media) : null;
  return [
    ...(stills.length > 0
      ? [
          {
            icon: ZoomIn,
            label: t('video.montage.kenBurns'),
            submenu: KEN_BURNS_CHOICES.map((choice) => ({
              icon: choice === current ? Check : undefined,
              label: t(`video.montage.kenBurnsOptions.${choice}`),
              onClick: () => kenBurnsSelection(choice),
            })),
          },
        ]
      : []),
    ...(canCutToBeats(project, selection)
      ? [
          {
            icon: AudioWaveform,
            label: t('video.montage.cutToBeat'),
            submenu: BEAT_STEPS.map((every) => ({
              label: t('video.montage.everyBeat', { count: every }),
              onClick: () => void cutSelectionToBeats(every),
            })),
          },
        ]
      : []),
    ...(canArrange(project, selection)
      ? [
          {
            icon: LayoutGrid,
            label: t('video.montage.arrange'),
            submenu: ARRANGEMENTS.map((layout) => ({
              icon: layout === arrangement ? Check : undefined,
              label: t(`video.montage.layouts.${layout}`),
              onClick: () => arrangeSelection(layout),
            })),
          },
        ]
      : []),
  ];
};
