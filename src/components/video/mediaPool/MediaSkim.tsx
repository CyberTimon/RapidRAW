import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import clsx from 'clsx';
import { MediaKind, Ticks } from '../../../types/video';
import { mediaRangeWithin } from '../../../utils/video/edit';
import { getVideo, useVideoStore } from '../../../store/useVideoStore';
import { sequenceIdOf, sequenceRevision } from '../../../utils/video/nesting';
import { secondsToTicks } from '../../../utils/video/time';
import { useMediaImage } from '../timeline/media';
import { endSkim, skimTo, useProjectMedia } from './media';

const OUTSIDE_DWELL_MS = 200;

export type SkimFit = 'cover' | 'contain';

type Painter = MutableRefObject<((fraction: number) => void) | null>;

interface SkimFramesProps {
  path: string;
  kind: MediaKind;
  fit: SkimFit;
  fraction: MutableRefObject<number>;
  painter: Painter;
}

function SkimFrames({ path, kind, fit, fraction, painter }: SkimFramesProps) {
  const revision = useMemo(() => {
    const id = sequenceIdOf(path);
    const project = getVideo().project;
    return id && project ? sequenceRevision(project, id) : '';
  }, [path]);
  const strip = useMediaImage('sprite', path, kind !== 'audio', revision);
  const waveform = useMediaImage('waveform', path, kind === 'audio');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!strip || !canvas || !context) return;
    let shown = -1;
    painter.current = (value) => {
      const tile = Math.min(strip.tiles.length - 1, Math.floor(value * strip.tiles.length));
      const bitmap = strip.tiles[tile];
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        shown = -1;
      }
      if (tile === shown || !bitmap?.width) return;
      shown = tile;
      const scale = (fit === 'cover' ? Math.max : Math.min)(width / bitmap.width, height / bitmap.height);
      const drawnWidth = bitmap.width * scale;
      const drawnHeight = bitmap.height * scale;
      context.imageSmoothingQuality = 'high';
      context.clearRect(0, 0, width, height);
      context.drawImage(bitmap, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight);
    };
    painter.current(fraction.current);
    return () => {
      painter.current = null;
    };
  }, [strip, fit, fraction, painter]);

  if (kind === 'audio') {
    return waveform ? (
      <div className="absolute inset-0 bg-surface">
        <div
          className="absolute inset-x-0 inset-y-2 bg-text-secondary"
          style={{
            maskImage: `url(${waveform})`,
            WebkitMaskImage: `url(${waveform})`,
            maskSize: '100% 100%',
            WebkitMaskSize: '100% 100%',
          }}
        />
      </div>
    ) : null;
  }
  return (
    <canvas
      ref={canvasRef}
      className={clsx('absolute inset-0 w-full h-full', fit === 'contain' && 'bg-surface', !strip && 'invisible')}
    />
  );
}

type Phase = 'idle' | 'skim' | 'load';

function MediaSkim({ path, kind, fit = 'cover' }: { path: string; kind: MediaKind; fit?: SkimFit }) {
  const media = useProjectMedia(path);
  const total = useVideoStore((state) => secondsToTicks(state.media[path]?.duration ?? 0));
  const rootRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const fraction = useRef(0);
  const painter: Painter = useRef(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const dwell = media ? 0 : OUTSIDE_DWELL_MS;

  useEffect(() => {
    const host = rootRef.current?.parentElement;
    if (!host) return;
    let timer = 0;
    let active = false;
    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || event.buttons !== 0) return;
      const rect = host.getBoundingClientRect();
      const value = rect.width > 0 ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) : 0;
      fraction.current = value;
      skimTo(path, value);
      if (lineRef.current) lineRef.current.style.left = `${value * 100}%`;
      painter.current?.(value);
      if (active) return;
      active = true;
      if (dwell > 0) {
        setPhase('skim');
        timer = window.setTimeout(() => setPhase('load'), dwell);
      } else {
        setPhase('load');
      }
    };
    const leave = () => {
      window.clearTimeout(timer);
      active = false;
      endSkim(path);
      setPhase('idle');
    };
    host.addEventListener('pointermove', move);
    host.addEventListener('pointerleave', leave);
    return () => {
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerleave', leave);
      leave();
    };
  }, [path, dwell]);

  const range = mediaRangeWithin(media?.range, total);
  const percent = (time: Ticks) => `${Math.min(100, Math.max(0, (time / total) * 100))}%`;

  return (
    <div ref={rootRef} className="absolute inset-0 pointer-events-none">
      {phase === 'load' && <SkimFrames path={path} kind={kind} fit={fit} fraction={fraction} painter={painter} />}
      {range && phase !== 'idle' && (
        <>
          <div className="absolute inset-y-0 left-0 bg-black/50" style={{ width: percent(range.start) }} />
          <div className="absolute inset-y-0 right-0 bg-black/50" style={{ left: percent(range.end) }} />
        </>
      )}
      {range && (
        <div
          className="absolute bottom-0 h-[3px] bg-accent"
          style={{ left: percent(range.start), width: percent(range.end - range.start) }}
        />
      )}
      <div
        ref={lineRef}
        className={clsx(
          'absolute inset-y-0 w-px -translate-x-1/2 bg-accent shadow-[0_0_2px_rgba(0,0,0,0.8)]',
          phase === 'idle' && 'hidden',
        )}
      />
    </div>
  );
}

export default memo(MediaSkim);
