import { useTranslation } from 'react-i18next';
import { Gauge } from 'lucide-react';
import Dropdown from '../../ui/Dropdown';
import SegmentedControl from '../../ui/SegmentedControl';
import Text from '../../ui/Text';
import { TextVariants } from '../../../types/typography';
import { ProjectSettings as CanvasSettings, VideoProject } from '../../../types/video';
import { editProject, useVideoStore } from '../../../store/useVideoStore';
import { benefitsFromProxy, createProxies } from '../../../store/videoJobs';
import { isCreatingProxy, useProxyStateMap } from '../../../store/videoProxies';
import { withFrameRate } from '../../../utils/video/edit';
import { canvasSize, mainTrack, mediaPathOf, sameRatio, sequenceDuration } from '../../../utils/video/model';
import { FRAME_RATES, formatDuration, fpsLabel, sameRate } from '../../../utils/video/time';
import { ActionButton, ColorRow, FieldRow, InspectorSection } from '../inspector/InspectorControls';
import { InterpolationField } from '../inspector/FrameInterpolation';
import { ReframeClips } from '../inspector/ReframeControl';
import { withCanvasSize } from '../../../store/videoReframe';

type AspectId = 'original' | '16:9' | '9:16' | '1:1' | '4:5' | '21:9';

const ASPECTS: Array<{ id: AspectId; ratio: number | null }> = [
  { id: 'original', ratio: null },
  { id: '16:9', ratio: 16 / 9 },
  { id: '9:16', ratio: 9 / 16 },
  { id: '1:1', ratio: 1 },
  { id: '4:5', ratio: 4 / 5 },
  { id: '21:9', ratio: 21 / 9 },
];
const RESOLUTIONS = [720, 1080, 1440, 2160];

const resolutionLabel = (shortSide: number) => (shortSide === 2160 ? '4K' : `${shortSide}p`);

function CanvasSection({ project }: { project: VideoProject }) {
  const { t } = useTranslation();
  const { settings } = project;
  const originalRatio = useVideoStore((state) => {
    const clip = mainTrack(project).items.find((item) => item.type === 'clip');
    const path = clip ? mediaPathOf(project, clip) : null;
    const info = path ? state.media[path] : undefined;
    return info && info.width > 0 && info.height > 0 ? info.width / info.height : 16 / 9;
  });
  const ratio = settings.width / settings.height;
  const shortSide = Math.min(settings.width, settings.height);
  const resolution = RESOLUTIONS.includes(shortSide) ? shortSide : null;
  const aspect =
    ASPECTS.find((entry) => entry.ratio !== null && sameRatio(entry.ratio, ratio))?.id ??
    (sameRatio(originalRatio, ratio) ? 'original' : null);
  const frameRate = FRAME_RATES.find((entry) => sameRate(entry.rate, settings.fps))?.label ?? null;
  const update = (next: Partial<CanvasSettings>, mergeKey?: string) =>
    editProject((current) => ({ ...current, settings: { ...current.settings, ...next } }), mergeKey);
  const resize = (size: { width: number; height: number }) => editProject((current) => withCanvasSize(current, size));
  const details = [
    `${settings.width} × ${settings.height}`,
    `${fpsLabel(settings.fps)} fps`,
    formatDuration(sequenceDuration(project)),
  ].join(' · ');

  return (
    <InspectorSection id="canvas" title={t('video.inspector.canvas')}>
      <Text variant={TextVariants.small} className="block mb-3 tabular-nums">
        {details}
      </Text>
      <SegmentedControl<AspectId>
        className="mb-3"
        options={ASPECTS.map((entry) => ({
          id: entry.id,
          label: entry.id === 'original' ? t('video.inspector.original') : entry.id,
        }))}
        value={aspect}
        onChange={(id) =>
          resize(canvasSize(ASPECTS.find((entry) => entry.id === id)?.ratio ?? originalRatio, shortSide))
        }
      />
      <ReframeClips project={project} />
      <FieldRow label={t('video.inspector.resolution')}>
        <Dropdown<number>
          className="w-full max-w-36"
          options={RESOLUTIONS.map((value) => ({ value, label: resolutionLabel(value) }))}
          value={resolution}
          placeholder={resolutionLabel(shortSide)}
          onChange={(value) => resize(canvasSize(ratio, value))}
        />
      </FieldRow>
      <FieldRow label={t('video.inspector.frameRate')}>
        <Dropdown<string>
          className="w-full max-w-36"
          options={FRAME_RATES.map((entry) => ({ value: entry.label, label: entry.label }))}
          value={frameRate}
          placeholder={fpsLabel(settings.fps)}
          onChange={(label) => {
            const rate = FRAME_RATES.find((entry) => entry.label === label)?.rate;
            if (rate && !sameRate(rate, settings.fps)) editProject((current) => withFrameRate(current, rate));
          }}
        />
      </FieldRow>
      <InterpolationField
        value={settings.interpolation ?? 'none'}
        onChange={(interpolation) => update({ interpolation: interpolation === 'none' ? undefined : interpolation })}
      />
      <ColorRow
        label={t('video.inspector.background')}
        value={settings.background}
        onChange={(background) => update({ background }, 'settings.background')}
      />
    </InspectorSection>
  );
}

function ProxySection({ project }: { project: VideoProject }) {
  const { t } = useTranslation();
  const proxies = useProxyStateMap();
  const heavy = useVideoStore((state) =>
    project.media
      .filter((media) => media.kind === 'video' && benefitsFromProxy(state.media[media.path]))
      .map((media) => media.path)
      .join('\n'),
  );
  const paths = heavy ? heavy.split('\n') : [];
  const ready = paths.filter((path) => proxies[path]?.state === 'ready').length;
  const creating = paths.filter((path) => isCreatingProxy(proxies[path]));
  const missing = paths.filter((path) => (proxies[path]?.state ?? 'none') === 'none');
  const progress =
    creating.length > 0
      ? creating.reduce((sum, path) => {
          const proxy = proxies[path];
          return sum + (proxy?.state === 'running' ? proxy.progress : 0);
        }, 0) / creating.length
      : 0;

  return (
    <InspectorSection id="proxies" title={t('video.proxies.title')}>
      {paths.length === 0 ? (
        <Text variant={TextVariants.small} className="block">
          {t('video.proxies.notNeeded')}
        </Text>
      ) : (
        <>
          <FieldRow label={t('video.proxies.status')}>
            <Text variant={TextVariants.label} className="tabular-nums">
              {creating.length > 0
                ? t('video.proxies.creatingCount', { count: creating.length, percent: Math.round(progress * 100) })
                : t('video.proxies.readyCount', { ready, count: paths.length })}
            </Text>
          </FieldRow>
          <ActionButton
            icon={Gauge}
            label={t('video.proxies.createAll')}
            tooltip={t('video.proxies.hint')}
            disabled={missing.length === 0}
            onClick={() => void createProxies(missing)}
          />
        </>
      )}
    </InspectorSection>
  );
}

export default function ProjectSettings() {
  const project = useVideoStore((state) => state.project);
  if (!project) return null;
  return (
    <div className="grow min-h-0 overflow-y-auto custom-scrollbar px-3 pb-3 flex flex-col gap-2">
      <CanvasSection project={project} />
      <ProxySection project={project} />
    </div>
  );
}
