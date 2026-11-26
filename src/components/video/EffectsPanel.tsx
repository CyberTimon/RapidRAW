import { useMemo } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import { Heading, Layers2, LetterText, Square, type LucideIcon } from 'lucide-react';
import PanelSection from '../ui/PanelSection';
import PanelHeader from '../ui/PanelHeader';
import ToolTile from '../ui/ToolTile';
import { TransitionKind } from '../../types/video';
import { useVideoStore } from '../../store/useVideoStore';
import { Generator, addGenerator, applyTransition } from '../../store/videoEffects';
import { TRANSITIONS, TRANSITION_ICONS } from '../../utils/video/effectRegistry';
import { useShortcut } from '../../hooks/useShortcuts';
import type { ShortcutAction } from '../../utils/keyboardUtils';

export type VideoDragData =
  | { type: 'video-transition'; kind: TransitionKind; label: string; icon: LucideIcon }
  | { type: 'video-generator'; generator: Generator; label: string; icon: LucideIcon };

const GENERATORS: Array<{ generator: Generator; icon: LucideIcon; labelKey: ParseKeys; shortcut?: ShortcutAction }> = [
  { generator: 'title:title', icon: Heading, labelKey: 'video.titles.presets.title', shortcut: 'video_add_title' },
  { generator: 'title:lowerThird', icon: LetterText, labelKey: 'video.titles.presets.lowerThird' },
  { generator: 'adjustment', icon: Layers2, labelKey: 'video.timeline.adjustmentLayer' },
  { generator: 'solid', icon: Square, labelKey: 'video.timeline.solid' },
];

function Tile({
  id,
  data,
  shortcut,
  onApply,
}: {
  id: string;
  data: VideoDragData;
  shortcut?: ShortcutAction;
  onApply(): void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id, data });
  const shortcutProps = useShortcut(shortcut);
  return (
    <ToolTile
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      {...shortcutProps}
      data-tooltip={shortcutProps['data-shortcut'] ? data.label : undefined}
      icon={data.icon}
      label={data.label}
      dragging={isDragging}
      onClick={onApply}
    />
  );
}

export default function EffectsPanel() {
  const { t } = useTranslation();
  const hasProject = useVideoStore((s) => s.project !== null);

  const transitions = useMemo(
    () =>
      TRANSITIONS.map((kind) => ({
        id: `transition-${kind}`,
        data: {
          type: 'video-transition' as const,
          kind,
          label: t(`video.transitions.${kind}`),
          icon: TRANSITION_ICONS[kind],
        },
      })),
    [t],
  );
  const generators = useMemo(
    () =>
      GENERATORS.map((entry) => ({
        id: `generator-${entry.generator}`,
        shortcut: entry.shortcut,
        data: {
          type: 'video-generator' as const,
          generator: entry.generator,
          label: t(entry.labelKey),
          icon: entry.icon,
        },
      })),
    [t],
  );

  return (
    <div className="flex flex-col h-full">
      <PanelHeader title={t('video.effectsPanel.title')} />
      {hasProject && (
        <div className="grow overflow-y-auto custom-scrollbar p-3 space-y-6">
          <PanelSection title={t('video.effectsPanel.add')}>
            <div className="grid grid-cols-3 gap-2">
              {generators.map((entry) => (
                <Tile
                  key={entry.id}
                  id={entry.id}
                  data={entry.data}
                  shortcut={entry.shortcut}
                  onApply={() => addGenerator(entry.data.generator)}
                />
              ))}
            </div>
          </PanelSection>
          <PanelSection title={t('video.effectsPanel.transitions')}>
            <div className="grid grid-cols-3 gap-2">
              {transitions.map((entry) => (
                <Tile key={entry.id} id={entry.id} data={entry.data} onApply={() => applyTransition(entry.data.kind)} />
              ))}
            </div>
          </PanelSection>
        </div>
      )}
    </div>
  );
}
