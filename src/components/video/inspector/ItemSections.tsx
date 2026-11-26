import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bold,
  FlipHorizontal2,
  FlipVertical2,
  Italic,
  Loader2,
  Palette,
  type LucideIcon,
} from 'lucide-react';
import Dropdown from '../../ui/Dropdown';
import { SpeedCurve } from './SpeedCurve';
import { FrameInterpolation } from './FrameInterpolation';
import LookKeyframes from './LookKeyframes';
import FontPicker from '../../ui/FontPicker';
import { MotionBlurFields, TrackMatteFields } from './LayeringFields';
import { ReframeRow } from './ReframeControl';
import Slider, { type SliderChangeEvent } from '../../ui/Slider';
import Switch from '../../ui/Switch';
import SegmentedControl from '../../ui/SegmentedControl';
import Text from '../../ui/Text';
import { TextVariants } from '../../../types/typography';
import { Panel } from '../../../types/ui';
import {
  AdjustmentItem,
  AudioItem,
  BlendMode,
  CAMERA_LOGS,
  CameraLog,
  ClipItem,
  Direction,
  FitMode,
  FrameRate,
  Motion,
  SolidItem,
  Ticks,
  TimelineItem,
  TitleAlign,
  TitleItem,
  VideoProject,
  VisualItem,
} from '../../../types/video';
import { editProject, getVideo, setPlayhead, useVideoStore } from '../../../store/useVideoStore';
import { contentSize } from '../../../utils/video/layouts';
import { prepareReverse, setClipReversed, setCornerPin, useVideoMotion } from '../../../store/videoMotion';
import { setTransitionKind } from '../../../store/videoEffects';
import { useUIStore } from '../../../store/useUIStore';
import {
  DEFAULT_TRANSITION_SECONDS,
  halfDuration,
  lookUsers,
  makeLookUnique,
  patchMedia,
  previousAudio,
  roomAfter,
  setCrossfade,
  setItemDuration,
  setAnimation,
  setItemFade,
  setSpeedCurve,
  setTransition,
  setTransitionDuration,
  speedOf,
  transitionLimit,
} from '../../../utils/video/edit';
import {
  BLEND_MODES,
  EffectKind,
  MOTIONS,
  TEXT_MOTIONS,
  TRANSITIONS,
  isDirectional,
} from '../../../utils/video/effectRegistry';
import { MAX_SPEED, MIN_SPEED, itemEnd, locateItem, mediaOf, sourceLength } from '../../../utils/video/model';
import { isAnimated } from '../../../utils/video/animation';
import {
  DEFAULT_LINE_HEIGHT,
  DEFAULT_OUTLINE_COLOR,
  MAX_TITLE_SIZE,
  MIN_TITLE_SIZE,
  titleShadow,
} from '../../../utils/video/titles';
import { formatDuration, frameTicks, secondsToTicks, ticksToSeconds } from '../../../utils/video/time';
import {
  ActionButton,
  AnimatedEdit,
  AnimatedSlider,
  ColorRow,
  FieldRow,
  IconToggle,
  InspectorSection,
  LOG_SCALE,
  PERCENT,
  TextBox,
  Toolbar,
  ToolbarDivider,
  editItem,
} from './InspectorControls';

type Transformable = ClipItem | TitleItem | SolidItem;
type AnimatedTransformKey = 'x' | 'y' | 'scale' | 'rotation' | 'opacity' | 'radius';

const DIRECTIONS: Array<{ id: Direction; icon: LucideIcon }> = [
  { id: 'left', icon: ArrowLeft },
  { id: 'right', icon: ArrowRight },
  { id: 'up', icon: ArrowUp },
  { id: 'down', icon: ArrowDown },
];
const ALIGNMENTS: Array<{ id: TitleAlign; icon: LucideIcon }> = [
  { id: 'left', icon: AlignLeft },
  { id: 'center', icon: AlignCenter },
  { id: 'right', icon: AlignRight },
];
const MAX_STILL_SECONDS = 60;
const MIN_STILL_SECONDS = 0.1;

const floorTo = (value: number, step: number) => Math.floor(value / step + 1e-9) * step;
const seconds = (ticks: Ticks) => ticksToSeconds(ticks);

export function TransformSection({ item, pinnable = true }: { item: Transformable; pinnable?: boolean }) {
  const { t } = useTranslation();
  const { transform } = item;
  const pinned = pinnable && !!transform.pin;
  const sameShape = useVideoStore((state) => {
    if (item.type !== 'clip' || !state.project) return false;
    const { width, height } = contentSize(state.project, item, state.media);
    return Math.abs(width - state.project.settings.width) < 1 && Math.abs(height - state.project.settings.height) < 1;
  });
  const edit =
    (key: AnimatedTransformKey): AnimatedEdit =>
    (update, merge) =>
      editItem<Transformable>(item.id, merge ? `transform.${key}` : null, (current) => ({
        ...current,
        transform: { ...current.transform, [key]: update(current.transform[key]) },
      }));
  const flip = (key: 'flipH' | 'flipV') =>
    editItem<Transformable>(item.id, null, (current) => ({
      ...current,
      transform: { ...current.transform, [key]: !current.transform[key] },
    }));
  const timing = { start: item.start, duration: item.duration };

  return (
    <InspectorSection id="transform" title={t('video.inspector.transform')}>
      {!pinned && (
        <>
          <AnimatedSlider
            {...timing}
            label={t('video.inspector.positionX')}
            value={transform.x}
            min={-100}
            max={100}
            step={0.1}
            defaultValue={0}
            unit={PERCENT}
            suffix="%"
            onEdit={edit('x')}
          />
          <AnimatedSlider
            {...timing}
            label={t('video.inspector.positionY')}
            value={transform.y}
            min={-100}
            max={100}
            step={0.1}
            defaultValue={0}
            unit={PERCENT}
            suffix="%"
            onEdit={edit('y')}
          />
          <AnimatedSlider
            {...timing}
            label={t('video.inspector.scale')}
            value={transform.scale}
            min={0}
            max={400}
            step={1}
            defaultValue={100}
            unit={PERCENT}
            suffix="%"
            onEdit={edit('scale')}
          />
          <AnimatedSlider
            {...timing}
            label={t('video.inspector.rotation')}
            value={transform.rotation}
            min={-180}
            max={180}
            step={0.1}
            defaultValue={0}
            suffix="°"
            onEdit={edit('rotation')}
          />
        </>
      )}
      <AnimatedSlider
        {...timing}
        label={t('video.inspector.opacity')}
        value={transform.opacity}
        min={0}
        max={100}
        step={1}
        defaultValue={100}
        unit={PERCENT}
        suffix="%"
        fillOrigin="min"
        onEdit={edit('opacity')}
      />
      {item.type !== 'title' && (
        <AnimatedSlider
          {...timing}
          label={t('video.inspector.cornerRadius')}
          value={transform.radius}
          min={0}
          max={100}
          step={1}
          defaultValue={0}
          unit={PERCENT}
          suffix="%"
          fillOrigin="min"
          onEdit={edit('radius')}
        />
      )}
      <div className="flex flex-wrap items-stretch gap-2 mb-3">
        <Toolbar>
          <IconToggle
            icon={FlipHorizontal2}
            label={t('video.inspector.flipHorizontal')}
            isActive={transform.flipH}
            onClick={() => flip('flipH')}
          />
          <IconToggle
            icon={FlipVertical2}
            label={t('video.inspector.flipVertical')}
            isActive={transform.flipV}
            onClick={() => flip('flipV')}
          />
        </Toolbar>
        {item.type === 'clip' && (
          <div className="grow basis-24" data-tooltip={sameShape ? t('video.inspector.sameShape') : undefined}>
            <SegmentedControl<FitMode>
              options={[
                { id: 'fit', label: t('video.inspector.fit') },
                { id: 'fill', label: t('video.inspector.fill') },
                { id: 'blur', label: t('video.inspector.blurFill') },
              ]}
              value={item.fit}
              disabled={sameShape}
              onChange={(fit) => editItem<ClipItem>(item.id, null, { fit })}
            />
          </div>
        )}
      </div>
      {pinnable && (
        <div className="mb-3">
          <Switch
            label={t('video.inspector.cornerPin')}
            checked={pinned}
            onChange={(enabled: boolean) => setCornerPin(item.id, enabled)}
          />
        </div>
      )}
      {item.type === 'clip' && <ReframeRow item={item} />}
      <FieldRow label={t('video.inspector.blendMode')}>
        <Dropdown<BlendMode>
          className="w-full max-w-44"
          options={BLEND_MODES.map((mode) => ({ value: mode, label: t(`video.inspector.blendModes.${mode}`) }))}
          value={item.blend}
          onChange={(blend) => editItem<Transformable>(item.id, null, { blend })}
        />
      </FieldRow>
      <TrackMatteFields item={item} />
      {item.type !== 'clip' && <MotionBlurFields item={item} />}
    </InspectorSection>
  );
}

function DurationLine({ duration }: { duration: Ticks }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between mb-3">
      <Text variant={TextVariants.label}>{t('video.inspector.duration')}</Text>
      <Text className="tabular-nums text-text-primary">{formatDuration(duration)}</Text>
    </div>
  );
}

function ReverseSwitch({ item, path }: { item: ClipItem; path: string }) {
  const { t } = useTranslation();
  const state = useVideoMotion((s) => s.reversed[path]);
  const reverse = !!item.reverse;

  useEffect(() => {
    if (reverse) prepareReverse([path]);
  }, [reverse, path]);

  return (
    <div className="space-y-1.5 mb-3">
      <Switch
        label={t('video.inspector.reverse')}
        checked={reverse}
        onChange={(next: boolean) => setClipReversed(item.id, path, next)}
      />
      {reverse && state?.state === 'running' && (
        <div className="flex items-center gap-2">
          <Loader2 size={12} className="animate-spin text-text-secondary" />
          <Text variant={TextVariants.small}>
            {t('video.inspector.reversePreparing', { percent: Math.round(state.progress * 100) })}
          </Text>
        </div>
      )}
      {reverse && state?.state === 'failed' && (
        <Text variant={TextVariants.small} className="text-red-400!">
          {t('video.inspector.reverseFailed')}
        </Text>
      )}
    </div>
  );
}

export function SpeedSection({ item, reversePath }: { item: ClipItem | AudioItem; reversePath?: string }) {
  const { t } = useTranslation();
  const anchor = useRef<{ item: TimelineItem; source: Ticks } | null>(null);
  const retimed = (
    project: VideoProject,
    update: (current: ClipItem | AudioItem, source: Ticks) => VideoProject,
  ): VideoProject => {
    const current = locateItem(project, item.id)?.item;
    if (!current || (current.type !== 'clip' && current.type !== 'audio')) return project;
    const source =
      anchor.current?.item === current ? anchor.current.source : sourceLength(current, project.settings.fps);
    const next = update(current, source);
    const updated = locateItem(next, current.id)?.item;
    if (updated) anchor.current = { item: updated, source };
    return next;
  };
  const editSpeed: AnimatedEdit = (update, merge) => {
    const { playhead, isPlaying } = getVideo();
    const follow = { time: null as Ticks | null };
    editProject(
      (project) =>
        retimed(project, (current, source) => {
          const next = setSpeedCurve(project, current.id, update(speedOf(current)), source);
          const updated = locateItem(next, current.id)?.item;
          if (updated && isAnimated(speedOf(current)) && playhead >= current.start && playhead < itemEnd(current)) {
            follow.time =
              updated.start +
              Math.round(((playhead - current.start) * updated.duration) / Math.max(1, current.duration));
          }
          return next;
        }),
      merge ? `speed:${item.id}` : undefined,
    );
    if (follow.time !== null && !isPlaying) setPlayhead(follow.time);
  };

  return (
    <InspectorSection id="timing" title={t('video.inspector.timing')}>
      <AnimatedSlider
        label={t('video.inspector.speed')}
        value={speedOf(item)}
        start={item.start}
        duration={item.duration}
        min={MIN_SPEED}
        max={MAX_SPEED}
        step={0.01}
        defaultValue={1}
        suffix="×"
        scale={LOG_SCALE}
        onEdit={editSpeed}
      />
      <DurationLine duration={item.duration} />
      {item.type === 'clip' && reversePath && <ReverseSwitch item={item} path={reversePath} />}
      <SpeedCurve item={item} onEdit={editSpeed} />
      {item.type === 'clip' && <FrameInterpolation item={item} />}
    </InspectorSection>
  );
}

export function StillDurationSection({ item, project }: { item: ClipItem; project: VideoProject }) {
  const { t } = useTranslation();
  const room = roomAfter(project, item.id);
  const max = Math.max(seconds(item.duration), Math.min(MAX_STILL_SECONDS, seconds(room)));
  return (
    <InspectorSection id="timing" title={t('video.inspector.timing')}>
      <Slider
        label={t('video.inspector.duration')}
        min={MIN_STILL_SECONDS}
        max={floorTo(max, 0.01)}
        step={0.01}
        value={seconds(item.duration)}
        defaultValue={3}
        suffix=" s"
        scale={LOG_SCALE}
        onChange={(event) => {
          const value = Number(event.target.value);
          if (!Number.isFinite(value)) return;
          editProject((current) => setItemDuration(current, item.id, secondsToTicks(value)), `duration:${item.id}`);
        }}
      />
    </InspectorSection>
  );
}

function DurationSlider({
  label,
  value,
  limit,
  defaultValue = 0,
  onChange,
}: {
  label: string;
  value: Ticks;
  limit: Ticks;
  defaultValue?: number;
  onChange(duration: Ticks): void;
}) {
  const max = floorTo(seconds(limit), 0.01);
  return (
    <Slider
      label={label}
      min={0}
      max={Math.max(max, 0.01)}
      step={0.01}
      value={seconds(Math.min(value, limit))}
      defaultValue={Math.min(defaultValue, max)}
      suffix=" s"
      fillOrigin="min"
      disabled={max <= 0}
      onChange={(event) => {
        const next = Number(event.target.value);
        if (Number.isFinite(next)) onChange(secondsToTicks(next));
      }}
    />
  );
}

function EffectFields<K extends EffectKind>({
  label,
  kinds,
  kind,
  direction,
  duration,
  limit,
  fps,
  onKind,
  onDirection,
  onDuration,
}: {
  label: string;
  kinds: Array<K>;
  kind: K | null;
  direction?: Direction;
  duration: Ticks;
  limit: Ticks;
  fps: FrameRate;
  onKind(kind: K | null): void;
  onDirection(direction: Direction): void;
  onDuration(duration: Ticks): void;
}) {
  const { t } = useTranslation();
  const available = limit >= frameTicks(fps);
  const picker = (
    <Dropdown<K | 'none'>
      className="w-full max-w-44"
      options={[
        { value: 'none', label: t('video.transitions.none') },
        ...kinds.map((value) => ({ value, label: t(`video.transitions.${value as EffectKind}`) })),
      ]}
      value={kind ?? 'none'}
      disabled={!available}
      onChange={(value) => onKind(value === 'none' ? null : (value as K))}
    />
  );
  return (
    <>
      <FieldRow label={label}>{picker}</FieldRow>
      {kind && available && (
        <>
          {isDirectional(kind) && (
            <FieldRow label={t('video.inspector.direction')}>
              <SegmentedControl<Direction>
                className="w-full max-w-44"
                iconOnly
                options={DIRECTIONS.map(({ id, icon }) => ({ id, icon, label: t(`video.inspector.directions.${id}`) }))}
                value={direction ?? 'left'}
                onChange={onDirection}
              />
            </FieldRow>
          )}
          <DurationSlider
            label={t('video.inspector.duration')}
            value={duration}
            limit={limit}
            defaultValue={DEFAULT_TRANSITION_SECONDS}
            onChange={onDuration}
          />
        </>
      )}
    </>
  );
}

function AnimationEdge({
  item,
  edge,
  fps,
}: {
  item: ClipItem | TitleItem | SolidItem;
  edge: 'in' | 'out';
  fps: FrameRate;
}) {
  const { t } = useTranslation();
  const fadeKey = edge === 'in' ? 'fadeIn' : 'fadeOut';
  const motion = item[edge === 'in' ? 'animIn' : 'animOut'];
  const setMotion = (next: Motion | null) => editProject((project) => setAnimation(project, item.id, edge, next));

  return (
    <EffectFields
      label={edge === 'in' ? t('video.inspector.animIn') : t('video.inspector.animOut')}
      kinds={item.type === 'title' ? [...MOTIONS, ...TEXT_MOTIONS] : MOTIONS}
      kind={item[fadeKey] > 0 ? (motion?.kind ?? 'fade') : null}
      direction={motion?.direction}
      duration={item[fadeKey]}
      limit={halfDuration(item.duration, fps)}
      fps={fps}
      onKind={(kind) =>
        setMotion(
          kind && {
            kind,
            ...(isDirectional(kind) ? { direction: motion?.direction ?? (edge === 'in' ? 'right' : 'left') } : {}),
          },
        )
      }
      onDirection={(direction) => motion && setMotion({ ...motion, direction })}
      onDuration={(duration) =>
        editProject((project) => setItemFade(project, item.id, fadeKey, duration), `${fadeKey}:${item.id}`)
      }
    />
  );
}

export function FadeSection({ item, fps }: { item: TimelineItem; fps: FrameRate }) {
  const { t } = useTranslation();
  const previous = useVideoStore((state) =>
    state.project && item.type === 'audio' ? previousAudio(state.project, item) : null,
  );

  if (item.type === 'clip' || item.type === 'title' || item.type === 'solid')
    return (
      <InspectorSection id="fade" title={t('video.inspector.animation')}>
        {item.type !== 'clip' && <DurationLine duration={item.duration} />}
        <AnimationEdge item={item} edge="in" fps={fps} />
        <div className="h-px bg-surface my-3" />
        <AnimationEdge item={item} edge="out" fps={fps} />
      </InspectorSection>
    );

  const fade = (edge: 'fadeIn' | 'fadeOut') => (
    <DurationSlider
      label={edge === 'fadeIn' ? t('video.inspector.fadeIn') : t('video.inspector.fadeOut')}
      value={item[edge]}
      limit={halfDuration(item.duration, fps)}
      onChange={(duration) =>
        editProject((project) => setItemFade(project, item.id, edge, duration), `${edge}:${item.id}`)
      }
    />
  );

  return (
    <InspectorSection id="fade" title={t('video.inspector.fade')}>
      {item.type === 'adjustment' && <DurationLine duration={item.duration} />}
      {fade('fadeIn')}
      {fade('fadeOut')}
      {previous && item.type === 'audio' && (
        <DurationSlider
          label={t('video.inspector.crossfade')}
          value={item.crossfade ?? 0}
          limit={transitionLimit(previous, item, fps)}
          onChange={(duration) =>
            editProject((project) => setCrossfade(project, item.id, duration), `crossfade:${item.id}`)
          }
        />
      )}
    </InspectorSection>
  );
}

export function TransitionSection({ item, previous, fps }: { item: ClipItem; previous: VisualItem; fps: FrameRate }) {
  const { t } = useTranslation();
  const transition = item.transitionIn;

  return (
    <InspectorSection id="transition" title={t('video.inspector.transition')}>
      <EffectFields
        label={t('video.inspector.type')}
        kinds={TRANSITIONS}
        kind={transition?.kind ?? null}
        direction={transition?.direction}
        duration={transition?.duration ?? 0}
        limit={transitionLimit(previous, item, fps)}
        fps={fps}
        onKind={(kind) => setTransitionKind(item.id, kind)}
        onDirection={(direction) =>
          transition && editProject((project) => setTransition(project, item.id, { ...transition, direction }))
        }
        onDuration={(duration) =>
          editProject((project) => setTransitionDuration(project, item.id, duration), `transition:${item.id}`)
        }
      />
    </InspectorSection>
  );
}

function CameraLogField({ item, project }: { item: ClipItem; project: VideoProject }) {
  const { t } = useTranslation();
  const media = mediaOf(project, item.media);
  const detected = useVideoStore((state) => (media ? state.media[media.path]?.detectedLog : undefined));
  if (media?.kind !== 'video' || media.timelapse) return null;
  const label = (log: CameraLog) => t(`video.inspector.cameraLogs.${log}`);
  return (
    <FieldRow label={t('video.inspector.cameraLog')}>
      <Dropdown<CameraLog | ''>
        className="w-full max-w-44"
        options={[
          { value: '', label: t('video.inspector.cameraLogs.none') },
          ...CAMERA_LOGS.map((log) => ({
            value: log,
            label: log === detected ? t('video.inspector.cameraLogDetected', { name: label(log) }) : label(log),
          })),
        ]}
        value={media.log ?? ''}
        onChange={(log) => editProject((current) => patchMedia(current, media.id, { log: log || null }))}
      />
    </FieldRow>
  );
}

export function LookSection({ item, project }: { item: ClipItem | AdjustmentItem; project: VideoProject }) {
  const { t } = useTranslation();
  const users = item.look ? lookUsers(project, item.look).length : 0;
  const editOpacity: AnimatedEdit = (update, merge) =>
    editItem<AdjustmentItem>(item.id, merge ? 'opacity' : null, (current) => ({
      ...current,
      opacity: update(current.opacity),
    }));

  return (
    <InspectorSection id="look" title={t('video.inspector.look')}>
      {item.type === 'adjustment' && (
        <AnimatedSlider
          start={item.start}
          duration={item.duration}
          label={t('video.inspector.opacity')}
          value={item.opacity}
          min={0}
          max={100}
          step={1}
          defaultValue={100}
          unit={PERCENT}
          suffix="%"
          fillOrigin="min"
          onEdit={editOpacity}
        />
      )}
      {item.type === 'clip' && <CameraLogField item={item} project={project} />}
      <ActionButton
        icon={Palette}
        label={t('video.inspector.editLook')}
        onClick={() => useUIStore.getState().setPanel(Panel.Adjustments)}
      />
      {users > 1 && (
        <div className="flex items-center justify-between gap-2 mt-3">
          <Text variant={TextVariants.small} className="truncate">
            {t('video.inspector.sharedLook', { count: users - 1 })}
          </Text>
          <button
            type="button"
            className="shrink-0 text-sm text-accent hover:underline"
            onClick={() => editProject((current) => makeLookUnique(current, item.id))}
          >
            {t('video.inspector.makeUnique')}
          </button>
        </div>
      )}
      <LookKeyframes item={item} project={project} />
    </InspectorSection>
  );
}

export function TitleSection({ item }: { item: TitleItem }) {
  const { t } = useTranslation();
  const patch = (key: string | null, update: Partial<TitleItem>) => editItem<TitleItem>(item.id, key, update);
  const setNumber =
    (key: 'outline' | 'shadow' | 'letterSpacing' | 'lineHeight', factor = 100) =>
    (event: SliderChangeEvent) => {
      const value = Number(event.target.value);
      if (Number.isFinite(value)) patch(`title.${key}`, { [key]: value / factor });
    };

  return (
    <InspectorSection id="title" title={t('video.inspector.text')}>
      <TextBox
        value={item.text}
        placeholder={t('video.inspector.textPlaceholder')}
        onChange={(text) => patch('title.text', { text })}
      />
      <FieldRow label={t('video.inspector.font')}>
        <FontPicker value={item.font} onChange={(font) => patch(null, { font })} />
      </FieldRow>
      <Slider
        label={t('video.inspector.size')}
        min={MIN_TITLE_SIZE * 100}
        max={MAX_TITLE_SIZE * 100}
        step={0.5}
        value={item.size * 100}
        defaultValue={10}
        suffix="%"
        onChange={(event) => {
          const value = Number(event.target.value);
          if (Number.isFinite(value) && value > 0) patch('title.size', { size: value / 100 });
        }}
      />
      <Slider
        label={t('video.inspector.lineHeight')}
        min={0.6}
        max={2.5}
        step={0.05}
        value={item.lineHeight ?? DEFAULT_LINE_HEIGHT}
        defaultValue={DEFAULT_LINE_HEIGHT}
        suffix="×"
        onChange={setNumber('lineHeight', 1)}
      />
      <Slider
        label={t('video.inspector.letterSpacing')}
        min={-20}
        max={100}
        step={1}
        value={(item.letterSpacing ?? 0) * 100}
        defaultValue={0}
        suffix="%"
        onChange={setNumber('letterSpacing')}
      />
      <Toolbar className="mb-3">
        <label className="w-7 h-7 shrink-0 flex items-center justify-center" data-tooltip={t('video.inspector.color')}>
          <input
            type="color"
            className="w-5 h-5 p-0 border-none rounded-sm cursor-pointer bg-transparent"
            value={item.color}
            aria-label={t('video.inspector.color')}
            onChange={(event) => patch('title.color', { color: event.target.value })}
          />
        </label>
        <IconToggle
          icon={Bold}
          label={t('video.inspector.bold')}
          isActive={item.bold}
          onClick={() => patch(null, { bold: !item.bold })}
        />
        <IconToggle
          icon={Italic}
          label={t('video.inspector.italic')}
          isActive={item.italic}
          onClick={() => patch(null, { italic: !item.italic })}
        />
        <ToolbarDivider />
        {ALIGNMENTS.map(({ id, icon }) => (
          <IconToggle
            key={id}
            icon={icon}
            label={t(`video.inspector.align.${id}`)}
            isActive={item.align === id}
            onClick={() => patch(null, { align: id })}
          />
        ))}
      </Toolbar>
      <Slider
        label={t('video.inspector.outline')}
        min={0}
        max={20}
        step={0.5}
        value={(item.outline ?? 0) * 100}
        defaultValue={0}
        suffix="%"
        fillOrigin="min"
        onChange={setNumber('outline')}
      />
      {(item.outline ?? 0) > 0 && (
        <ColorRow
          label={t('video.inspector.outlineColor')}
          value={item.outlineColor ?? DEFAULT_OUTLINE_COLOR}
          onChange={(outlineColor) => patch('title.outlineColor', { outlineColor })}
        />
      )}
      <Slider
        label={t('video.inspector.shadow')}
        min={0}
        max={200}
        step={1}
        value={titleShadow(item) * 100}
        defaultValue={item.backdrop ? 0 : 100}
        suffix="%"
        fillOrigin="min"
        onChange={setNumber('shadow')}
      />
      <Switch
        label={t('video.inspector.backdrop')}
        checked={item.backdrop}
        onChange={(backdrop: boolean) => patch(null, { backdrop })}
      />
    </InspectorSection>
  );
}

export function SolidSection({ item }: { item: SolidItem }) {
  const { t } = useTranslation();
  return (
    <InspectorSection id="solid" title={t('video.inspector.solid')}>
      <ColorRow
        label={t('video.inspector.color')}
        value={item.color}
        onChange={(color) => editItem<SolidItem>(item.id, 'solid.color', { color })}
      />
    </InspectorSection>
  );
}
