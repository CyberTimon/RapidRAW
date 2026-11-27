import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { Camera, Clapperboard, Repeat, Volume2, VolumeX } from 'lucide-react';
import Text from '../ui/Text';
import { TextColors, TextVariants } from '../../types/typography';
import { ClipSettings, FrameRate, Ticks } from '../../types/video';
import { useEditorStore } from '../../store/useEditorStore';
import { useProcessStore } from '../../store/useProcessStore';
import { createVideoProject, setPlayhead, useVideoStore } from '../../store/useVideoStore';
import { holdSeekResume, toggleLoop } from '../../store/videoPlayback';
import { exportVideoFrame } from '../../store/videoExport';
import { TrimEdge, resetTrim, setTrim, toggleClipMute } from '../../store/videoClip';
import { clipSettingsOf, sequenceDuration, trimRange } from '../../utils/video/model';
import { formatTimecode, frameTicks, snapTicks } from '../../utils/video/time';
import { useMediaImage } from './timeline/media';
import StripCanvas, { filmTiles } from './timeline/StripCanvas';
import Timecode, { PlayheadState, PlayheadTimecode, usePlayheadEffect } from './timeline/Timecode';
import PlayButton from './PlayButton';
import { useShortcut, useShortcuts } from '../../hooks/useShortcuts';

const HANDLE_WIDTH = 10;

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

const FrameStrip = memo(function FrameStrip({ path }: { path: string }) {
  const strip = useMediaImage('sprite', path, true);
  const thumbnail = useProcessStore((state) => state.thumbnails[path]);
  const [ref, size] = useElementSize<HTMLDivElement>();
  const width = Math.round(size.width);
  const height = Math.round(size.height);
  const tiles = useMemo(
    () =>
      strip && width > 0
        ? filmTiles(strip, 0, width, 0, height, (centers) => centers.map((center) => center / width))
        : null,
    [strip, width, height],
  );

  return (
    <div ref={ref} className="absolute inset-0 overflow-hidden">
      {strip && tiles ? (
        <StripCanvas strip={strip} from={0} to={width} height={height} tiles={tiles} />
      ) : (
        thumbnail && (
          <div
            className="h-full w-full opacity-60"
            style={{
              backgroundImage: `url(${thumbnail})`,
              backgroundSize: 'auto 100%',
              backgroundRepeat: 'repeat-x',
            }}
          />
        )
      )}
    </div>
  );
});

function BarButton({
  icon: Icon,
  label,
  onClick,
  active = false,
  disabled = false,
  shortcut,
}: {
  icon: React.ElementType;
  label: string;
  onClick(): void;
  active?: boolean;
  disabled?: boolean;
  shortcut?: string | null;
}) {
  const shortcutProps = useShortcut(shortcut);
  return (
    <button
      className={clsx(
        'w-8 h-8 shrink-0 flex items-center justify-center rounded-md transition-colors disabled:opacity-40 disabled:pointer-events-none',
        active ? 'text-accent hover:bg-surface' : 'text-text-secondary hover:bg-surface hover:text-text-primary',
      )}
      onClick={onClick}
      onMouseDown={(event) => event.preventDefault()}
      disabled={disabled}
      data-tooltip={label}
      aria-label={label}
      aria-pressed={active}
      {...shortcutProps}
    >
      <Icon size={17} />
    </button>
  );
}

type Drag = { kind: 'scrub' } | { kind: 'trim'; edge: TrimEdge; time: Ticks | null };

const percentOf = (time: Ticks, duration: Ticks) =>
  duration > 0 ? Math.min(100, Math.max(0, (time / duration) * 100)) : 0;

interface TrackProps {
  path: string;
  duration: Ticks;
  fps: FrameRate;
  settings: ClipSettings;
}

function ClipTrack({ path, duration, fps, settings }: TrackProps) {
  const { t } = useTranslation();
  const shortcut = useShortcuts();
  const trackRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const lastEdgeRef = useRef<TrimEdge | null>(null);
  const [liveTrim, setLiveTrim] = useState<{ edge: TrimEdge; time: Ticks } | null>(null);

  const gap = frameTicks(fps);
  const ready = duration > 0;
  const [savedStart, savedEnd] = trimRange(settings, duration);
  const start = liveTrim?.edge === 'in' ? liveTrim.time : savedStart;
  const end = liveTrim?.edge === 'out' ? liveTrim.time : savedEnd;
  const isTrimmed = start > 0 || end < duration;
  const percent = (time: Ticks) => percentOf(time, duration);

  const place = useCallback(
    ({ playhead }: PlayheadState) => {
      const frame = snapTicks(playhead, fps);
      lineRef.current?.style.setProperty('left', `${percentOf(frame, duration)}%`);
      trackRef.current?.setAttribute('aria-valuenow', String(frame));
      trackRef.current?.setAttribute('aria-valuetext', formatTimecode(frame, fps));
    },
    [duration, fps],
  );
  usePlayheadEffect(place);

  const timeAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * duration;
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !ready) return;
    const edge = (event.target as HTMLElement).closest<HTMLElement>('[data-edge]')?.dataset.edge as
      TrimEdge | undefined;
    lastEdgeRef.current = edge ?? null;
    event.currentTarget.setPointerCapture(event.pointerId);
    holdSeekResume(true);
    if (edge) {
      dragRef.current = { kind: 'trim', edge, time: null };
      return;
    }
    dragRef.current = { kind: 'scrub' };
    setPlayhead(timeAt(event.clientX));
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    if (drag.kind === 'scrub') {
      setPlayhead(timeAt(event.clientX));
      return;
    }
    const time = snapTicks(timeAt(event.clientX), fps);
    drag.time =
      drag.edge === 'in'
        ? Math.min(Math.max(0, time), savedEnd - gap)
        : Math.max(Math.min(duration, time), savedStart + gap);
    setLiveTrim({ edge: drag.edge, time: drag.time });
    setPlayhead(drag.edge === 'in' ? drag.time : drag.time - gap);
  };

  const handlePointerUp = () => {
    holdSeekResume(false);
    const drag = dragRef.current;
    dragRef.current = null;
    setLiveTrim(null);
    if (drag?.kind === 'trim' && drag.time !== null) setTrim(drag.edge, drag.time);
  };

  const handleDoubleClick = () => {
    if (lastEdgeRef.current) resetTrim(lastEdgeRef.current);
  };

  const handleClass = clsx(
    'absolute inset-y-0 flex items-center justify-center cursor-ew-resize transition-colors',
    isTrimmed || liveTrim ? 'bg-accent' : 'bg-accent/60 hover:bg-accent',
  );

  return (
    <div
      ref={trackRef}
      className="relative flex-1 min-w-24 h-8 rounded-md overflow-hidden bg-surface cursor-pointer touch-none"
      role="slider"
      aria-label={t('video.clipBar.position')}
      aria-valuemin={0}
      aria-valuemax={duration}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={handleDoubleClick}
    >
      <FrameStrip path={path} />
      <div className="absolute inset-y-0 left-0 bg-black/60" style={{ width: `${percent(start)}%` }} />
      <div className="absolute inset-y-0 right-0 bg-black/60" style={{ width: `${100 - percent(end)}%` }} />
      {isTrimmed && (
        <div
          className="absolute inset-y-0 border-y-2 border-accent pointer-events-none"
          style={{
            left: `calc(${percent(start)}% + ${HANDLE_WIDTH}px)`,
            right: `calc(${100 - percent(end)}% + ${HANDLE_WIDTH}px)`,
          }}
        />
      )}
      <div
        data-edge="in"
        className={clsx(handleClass, 'rounded-l-md')}
        style={{ left: `${percent(start)}%`, width: HANDLE_WIDTH }}
        data-tooltip={t('video.clipBar.trimStart')}
        {...shortcut('video_set_in')}
      >
        <div className="w-0.5 h-3 rounded-full bg-button-text/70" />
      </div>
      <div
        data-edge="out"
        className={clsx(handleClass, 'rounded-r-md -translate-x-full')}
        style={{ left: `${percent(end)}%`, width: HANDLE_WIDTH }}
        data-tooltip={t('video.clipBar.trimEnd')}
        {...shortcut('video_set_out')}
      >
        <div className="w-0.5 h-3 rounded-full bg-button-text/70" />
      </div>
      <div
        ref={lineRef}
        className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_3px_rgba(0,0,0,0.6)] pointer-events-none"
      />
    </div>
  );
}

export default function ClipBar({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const { path, project } = useVideoStore(
    useShallow((state) => ({
      path: state.session?.kind === 'clip' ? state.session.path : null,
      project: state.project,
    })),
  );
  const info = useVideoStore((state) => (path ? state.media[path] : undefined));
  const video = useEditorStore((state) => (state.selectedImage?.path === path ? state.adjustments.video : undefined));
  const loop = useVideoStore((state) => state.loop);
  const settings = useMemo(() => clipSettingsOf(video), [video]);

  if (!path || !project) return null;

  const fps = project.settings.fps;
  const duration = sequenceDuration(project);
  const ready = duration > 0;

  return (
    <div className="h-12 shrink-0 bg-bg-secondary rounded-lg flex items-center gap-2 px-2">
      <PlayButton className="mx-0.5" disabled={!ready} />
      <Text
        as="span"
        variant={TextVariants.small}
        color={TextColors.primary}
        className="shrink-0 flex items-center gap-1 whitespace-nowrap"
      >
        <PlayheadTimecode fps={fps} />
        {!compact && (
          <>
            <span className="text-text-secondary">/</span>
            <Timecode value={formatTimecode(duration, fps)} className="text-text-secondary" />
          </>
        )}
      </Text>
      <ClipTrack path={path} duration={duration} fps={fps} settings={settings} />
      <div className="flex items-center shrink-0">
        <BarButton
          icon={Camera}
          label={t('video.frame.export')}
          onClick={() => void exportVideoFrame()}
          disabled={!ready}
          shortcut="video_export_frame"
        />
        {info?.hasAudio && (
          <BarButton
            icon={settings.muted ? VolumeX : Volume2}
            label={settings.muted ? t('video.clipBar.unmute') : t('video.clipBar.mute')}
            onClick={toggleClipMute}
            active={settings.muted}
          />
        )}
        {!compact && (
          <BarButton
            icon={Repeat}
            label={t('video.timeline.loop')}
            onClick={toggleLoop}
            active={loop}
            disabled={!ready}
            shortcut="video_loop"
          />
        )}
        <BarButton
          icon={Clapperboard}
          label={t('video.clipBar.openInTimeline')}
          onClick={() => void createVideoProject([path])}
          disabled={!ready}
        />
      </div>
    </div>
  );
}
