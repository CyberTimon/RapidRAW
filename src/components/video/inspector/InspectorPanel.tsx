import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Captions, SquareStack } from 'lucide-react';
import SegmentedControl, { SegmentedIntro } from '../../ui/SegmentedControl';
import PanelHeader from '../../ui/PanelHeader';
import {
  AdjustmentItem,
  AudioItem,
  ClipItem,
  SolidItem,
  TimelineItem,
  TitleItem,
  VideoProject,
  VisualItem,
} from '../../../types/video';
import { useVideoStore } from '../../../store/useVideoStore';
import { useProxyState } from '../../../store/videoProxies';
import { isTimelapseMedia } from '../../../store/videoTimelapse';
import { ItemLocation, locateItem, mediaOf } from '../../../utils/video/model';
import { gapOf, groupLeaders } from '../../../utils/video/edit';
import { roundFps } from '../../../utils/video/time';
import {
  FadeSection,
  LookSection,
  SolidSection,
  SpeedSection,
  StillDurationSection,
  TitleSection,
  TransformSection,
  TransitionSection,
} from './ItemSections';
import { StabilizeSection, TrackingSection } from './MotionSections';
import KeyframeSection from './KeyframeSection';
import TimelapseSection from './TimelapseSection';
import AudioSections from './AudioSections';
import { KenBurnsSection, SelectionInspector } from './MontageSections';
import { proxyLabel } from '../mediaPool/proxyStatus';
import { PanelNotice } from '../LookPanelFrame';
import { ItemChip } from '../ItemChip';
import { itemIcon, lookItemName } from '../../../utils/video/items';
import CaptionInspector from '../CaptionInspector';

type ClipView = 'video' | 'audio';

let rememberedView: ClipView = 'video';

const useMediaInfo = (path: string | null) => useVideoStore((state) => (path ? state.media[path] : undefined));

function TimelineItemChip({ item, project }: { item: TimelineItem; project: VideoProject }) {
  const { t } = useTranslation();
  const media = 'media' in item ? mediaOf(project, item.media) : null;
  const info = useMediaInfo(item.type === 'clip' ? (media?.path ?? null) : null);
  const proxy = useProxyState(item.type === 'clip' && media?.kind === 'video' ? media.path : null);
  const label = lookItemName(project, item, t);
  const isStill = media?.kind === 'image' || !!info?.isStill;
  const tooltip = [
    label,
    info && info.width > 0 ? `${info.width} × ${info.height}` : null,
    info && !isStill && info.fps > 0 ? `${roundFps(info.fps)} fps` : null,
    info?.variableFrameRate ? 'VFR' : null,
    info?.hdr ? 'HDR' : null,
    proxyLabel(proxy),
  ]
    .filter(Boolean)
    .join(' · ');
  return <ItemChip icon={itemIcon(project, item)} label={label} tooltip={tooltip} />;
}

function ClipInspector({
  item,
  project,
  previous,
  isMain,
}: {
  item: ClipItem;
  project: VideoProject;
  previous: VisualItem | null;
  isMain: boolean;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState(rememberedView);
  const media = mediaOf(project, item.media);
  const info = useMediaInfo(media?.path ?? null);
  const isStill = media?.kind === 'image' || !!info?.isStill;
  const isMoving = !isStill && !item.freeze;
  const hasAudio = isMoving && !!info?.hasAudio;

  const changeView = (next: ClipView) => {
    rememberedView = next;
    setView(next);
  };

  return (
    <>
      {hasAudio && (
        <SegmentedControl<ClipView>
          options={[
            { id: 'video', label: t('video.inspector.views.video') },
            { id: 'audio', label: t('video.inspector.views.audio') },
          ]}
          value={view}
          onChange={changeView}
        />
      )}
      {hasAudio && view === 'audio' ? (
        <AudioSections item={item} canDetach />
      ) : (
        <>
          <KeyframeSection item={item} project={project} />
          {media && isTimelapseMedia(media) && <TimelapseSection media={media} />}
          <LookSection item={item} project={project} />
          <TransformSection item={item} pinnable={!isMain} />
          {isStill && <KenBurnsSection />}
          {isMoving ? (
            <SpeedSection item={item} reversePath={media?.kind === 'video' ? media.path : undefined} />
          ) : (
            <StillDurationSection item={item} project={project} />
          )}
          {media?.kind === 'video' && isMoving && <StabilizeSection item={item} path={media.path} />}
          <FadeSection item={item} fps={project.settings.fps} />
          {previous && <TransitionSection item={item} previous={previous} fps={project.settings.fps} />}
          {!isMain && <TrackingSection item={item} />}
        </>
      )}
    </>
  );
}

function TitleInspector({ item, project }: { item: TitleItem; project: VideoProject }) {
  return (
    <>
      <KeyframeSection item={item} project={project} />
      <TitleSection item={item} />
      <TransformSection item={item} />
      <FadeSection item={item} fps={project.settings.fps} />
      <TrackingSection item={item} />
    </>
  );
}

function AdjustmentInspector({ item, project }: { item: AdjustmentItem; project: VideoProject }) {
  return (
    <>
      <KeyframeSection item={item} project={project} />
      <LookSection item={item} project={project} />
      <FadeSection item={item} fps={project.settings.fps} />
    </>
  );
}

function SolidInspector({ item, project }: { item: SolidItem; project: VideoProject }) {
  return (
    <>
      <KeyframeSection item={item} project={project} />
      <SolidSection item={item} />
      <TransformSection item={item} />
      <FadeSection item={item} fps={project.settings.fps} />
      <TrackingSection item={item} />
    </>
  );
}

function AudioInspector({ item, project }: { item: AudioItem; project: VideoProject }) {
  return (
    <>
      <KeyframeSection item={item} project={project} />
      <AudioSections item={item} canDetach={false} />
      <SpeedSection item={item} />
      <FadeSection item={item} fps={project.settings.fps} />
    </>
  );
}

function ItemInspector({ location, project }: { location: ItemLocation; project: VideoProject }) {
  const { item } = location;
  switch (item.type) {
    case 'clip': {
      const isMain = location.kind === 'video' && location.trackIndex === 0;
      const previous =
        isMain && location.index > 0 && !gapOf(item) ? (location.track.items[location.index - 1] as VisualItem) : null;
      return <ClipInspector item={item} project={project} previous={previous} isMain={isMain} />;
    }
    case 'title':
      return <TitleInspector item={item} project={project} />;
    case 'adjustment':
      return <AdjustmentInspector item={item} project={project} />;
    case 'solid':
      return <SolidInspector item={item} project={project} />;
    default:
      return <AudioInspector item={item} project={project} />;
  }
}

export default function InspectorPanel() {
  const { t } = useTranslation();
  const project = useVideoStore((state) => state.project);
  const selection = useVideoStore((state) => state.selection);
  const opening = useRef(true);
  useEffect(() => {
    opening.current = false;
  }, []);
  const leaders = project ? groupLeaders(project, selection) : [];
  const captions = project?.captions?.items.filter(({ id }) => leaders.includes(id)) ?? [];
  const itemLeaders = leaders.filter((id) => !captions.some((caption) => caption.id === id));
  const location = project && itemLeaders.length === 1 ? locateItem(project, itemLeaders[0]) : null;
  const caption = itemLeaders.length === 0 && captions.length === 1 ? captions[0] : null;

  const content =
    project && itemLeaders.length > 1
      ? {
          chip: (
            <ItemChip icon={SquareStack} label={t('video.inspector.selectedCount', { count: itemLeaders.length })} />
          ),
          body: <SelectionInspector project={project} selection={selection} />,
        }
      : project && location
        ? {
            chip: <TimelineItemChip item={location.item} project={project} />,
            body: <ItemInspector key={location.item.id} location={location} project={project} />,
          }
        : caption
          ? {
              chip: <ItemChip icon={Captions} label={caption.text.trim() || t('video.captions.newCaption')} />,
              body: <CaptionInspector key={caption.id} caption={caption} />,
            }
          : captions.length > 1
            ? {
                chip: (
                  <ItemChip icon={Captions} label={t('video.inspector.captionCount', { count: captions.length })} />
                ),
                body: null,
              }
            : null;

  return (
    <div className="flex flex-col h-full">
      <PanelHeader title={t('video.inspector.title')} chip={content?.chip} />
      {content ? (
        <div className="flex-1 overflow-y-auto custom-scrollbar p-3 flex flex-col gap-2">
          <SegmentedIntro.Provider value={opening}>{content.body}</SegmentedIntro.Provider>
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          <PanelNotice message="video.inspector.noSelection" />
        </div>
      )}
    </div>
  );
}
