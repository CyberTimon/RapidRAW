import { memo, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import Text from '../../ui/Text';
import { TextVariants } from '../../../types/typography';
import { LOUDNESS_TARGETS, useVideoExportStore } from '../../../store/videoExport';
import { HISTORY_STEPS, OutputMeter } from '../../../utils/video/audioMeter';
import { frequencyToUnit } from '../../../utils/video/sound';
import {
  OutputFrame,
  canvasColor,
  drawSpectrum,
  redrawOutput,
  useCanvasSize,
  useOutputDraw,
  useThemeChange,
} from './outputMeter';

const SPECTRUM_FLOOR_DB = -110;
const SPECTRUM_CEILING_DB = -20;
const METER_FLOOR_DB = -60;
const METER_SCALE = [-48, -36, -24, -12, -6, 0];
const METER_STOPS: Array<[number, string]> = [
  [-9, '#22c55e'],
  [-1, '#facc15'],
  [0, '#ef4444'],
];
const CLIP_DB = -0.1;
const LOUDNESS_FLOOR = -42;
const LOUDNESS_CEILING = -6;
const LOUDNESS_GRID = [-36, -24, -12];
const SPECTRUM_LABELS: Array<[number, string]> = [
  [100, '100'],
  [1000, '1k'],
  [10000, '10k'],
];

const meterUnit = (db: number) => Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
const loudnessUnit = (lufs: number) =>
  Math.max(0, Math.min(1, (lufs - LOUDNESS_FLOOR) / (LOUDNESS_CEILING - LOUDNESS_FLOOR)));
const formatLevel = (db: number) =>
  Number.isFinite(db) ? (db < 0 ? `−${Math.abs(db).toFixed(1)}` : db.toFixed(1)) : '–';

interface Paints {
  accent: string;
  accentFill: string;
  spectrum: CanvasGradient | null;
  meter: CanvasGradient | null;
  muted: string;
  primary: string;
}

const setText = (node: HTMLElement | null, text: string) => {
  if (node && node.textContent !== text) node.textContent = text;
};

const paintsFor = (spectrum: HTMLCanvasElement | null, meters: HTMLCanvasElement): Paints => {
  const accent = spectrum ?? meters;
  const spectrumFill = spectrum?.getContext('2d')?.createLinearGradient(0, 0, 0, spectrum.height) ?? null;
  spectrumFill?.addColorStop(0, canvasColor(accent, 0.75));
  spectrumFill?.addColorStop(1, canvasColor(accent, 0.15));
  const meterFill = meters.getContext('2d')?.createLinearGradient(0, 0, meters.width, 0) ?? null;
  METER_STOPS.forEach(([db, color], index) => {
    meterFill?.addColorStop(index === 0 ? 0 : meterUnit(METER_STOPS[index - 1][0]), color);
    meterFill?.addColorStop(meterUnit(db), color);
  });
  return {
    accent: canvasColor(accent),
    accentFill: canvasColor(accent, 0.15),
    spectrum: spectrumFill,
    meter: meterFill,
    muted: canvasColor(meters, 0.12),
    primary: canvasColor(meters, 0.85),
  };
};

function drawMeters(canvas: HTMLCanvasElement, meter: OutputMeter, paints: Paints) {
  const context = canvas.getContext('2d');
  if (!context) return;
  const { width, height } = canvas;
  const gap = Math.round(height * 0.2);
  const bar = (height - gap) / 2;
  context.clearRect(0, 0, width, height);
  [0, 1].forEach((channel) => {
    const top = channel * (bar + gap);
    context.fillStyle = paints.muted;
    context.fillRect(0, top, width, bar);
    context.fillStyle = paints.meter ?? paints.accent;
    context.globalAlpha = 0.45;
    context.fillRect(0, top, meterUnit(meter.level[channel]) * width, bar);
    context.globalAlpha = 1;
    context.fillRect(0, top, meterUnit(meter.rms[channel]) * width, bar);
    const hold = meter.hold[channel];
    if (Number.isFinite(hold) && hold > METER_FLOOR_DB) {
      context.fillStyle = hold >= CLIP_DB ? '#ef4444' : paints.primary;
      context.fillRect(Math.min(width - 2, meterUnit(hold) * width), top, 2, bar);
    }
  });
}

function drawHistory(canvas: HTMLCanvasElement, meter: OutputMeter, target: number | null, paints: Paints) {
  const context = canvas.getContext('2d');
  if (!context) return;
  const { width, height } = canvas;
  const ratio = window.devicePixelRatio || 1;
  context.clearRect(0, 0, width, height);
  const yOf = (lufs: number) => height * (1 - loudnessUnit(lufs));
  context.strokeStyle = paints.muted;
  context.lineWidth = ratio;
  LOUDNESS_GRID.forEach((lufs) => {
    context.beginPath();
    context.moveTo(0, Math.round(yOf(lufs)) + 0.5);
    context.lineTo(width, Math.round(yOf(lufs)) + 0.5);
    context.stroke();
  });
  const history = meter.history;
  if (history.length > 1) {
    const step = width / (HISTORY_STEPS - 1);
    const left = width - (history.length - 1) * step;
    context.beginPath();
    history.forEach((lufs, index) => context.lineTo(left + index * step, yOf(lufs)));
    context.lineTo(width, height);
    context.lineTo(left, height);
    context.closePath();
    context.fillStyle = paints.accentFill;
    context.fill();
    context.beginPath();
    history.forEach((lufs, index) => context.lineTo(left + index * step, yOf(lufs)));
    context.strokeStyle = paints.accent;
    context.lineWidth = 1.5 * ratio;
    context.stroke();
  }
  if (target !== null) {
    context.setLineDash([4 * ratio, 3 * ratio]);
    context.strokeStyle = paints.primary;
    context.lineWidth = ratio;
    context.beginPath();
    context.moveTo(0, Math.round(yOf(target)) + 0.5);
    context.lineTo(width, Math.round(yOf(target)) + 0.5);
    context.stroke();
    context.setLineDash([]);
  }
}

function Stat({
  label,
  tooltip,
  valueRef,
}: {
  label: string;
  tooltip?: string;
  valueRef(node: HTMLSpanElement): void;
}) {
  return (
    <div className="min-w-0 rounded-md bg-bg-primary px-2 py-1.5" data-tooltip={tooltip}>
      <Text as="span" variant={TextVariants.small} className="block truncate text-[10px]!">
        {label}
      </Text>
      <span className="flex items-baseline gap-1">
        <span ref={valueRef} className="text-base tabular-nums text-text-primary">
          –
        </span>
        <span className="text-[10px] text-text-secondary">LUFS</span>
      </span>
    </div>
  );
}

export default memo(function OutputAnalysis({ item = null }: { item?: string | null }) {
  const { t } = useTranslation();
  const target = useVideoExportStore(
    (state) => LOUDNESS_TARGETS.find((entry) => entry.id === state.loudness)?.lufs ?? null,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const spectrumRef = useRef<HTMLCanvasElement>(null);
  const metersRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef<HTMLCanvasElement>(null);
  const statsRef = useRef<HTMLDivElement>(null);
  const values = useRef<Array<HTMLSpanElement | null>>([]);
  const peakRef = useRef<HTMLSpanElement>(null);
  const paints = useRef<Paints | null>(null);
  const drawnRevision = useRef<number | null>(null);
  const targetRef = useRef(target);

  const draw = useCallback(({ meter, spectrum, fresh, live }: OutputFrame) => {
    const [spectrumCanvas, meters, history] = [spectrumRef.current, metersRef.current, historyRef.current];
    if (!meters) return;
    paints.current ??= paintsFor(spectrumCanvas, meters);
    const context = spectrumCanvas?.getContext('2d');
    if (spectrumCanvas && context && fresh) {
      context.clearRect(0, 0, spectrumCanvas.width, spectrumCanvas.height);
      if (spectrum)
        drawSpectrum(
          context,
          spectrum,
          spectrumCanvas.width,
          spectrumCanvas.height,
          SPECTRUM_FLOOR_DB,
          SPECTRUM_CEILING_DB,
          paints.current.spectrum ?? paints.current.accent,
        );
    }
    drawMeters(meters, meter, paints.current);
    if (history && drawnRevision.current !== meter.revision) {
      drawnRevision.current = meter.revision;
      drawHistory(history, meter, targetRef.current, paints.current);
    }
    [meter.momentary, meter.shortTerm, meter.integrated].forEach((value, index) =>
      setText(values.current[index], formatLevel(value)),
    );
    setText(peakRef.current, formatLevel(Math.max(...meter.hold)));
    statsRef.current?.classList.toggle('opacity-60', !live);
  }, []);
  const redraw = useCallback(() => {
    paints.current = null;
    drawnRevision.current = null;
    redrawOutput(draw);
  }, [draw]);
  useOutputDraw(draw, item, item === null ? undefined : rootRef);
  useEffect(() => {
    targetRef.current = target;
    drawnRevision.current = null;
    redrawOutput(draw);
  }, [target, draw]);
  useCanvasSize(spectrumRef, redraw);
  useCanvasSize(metersRef, redraw);
  useCanvasSize(historyRef, redraw);
  useThemeChange(redraw);

  return (
    <div ref={rootRef} className="space-y-3">
      {item === null && (
        <div className="relative h-24 rounded-md bg-bg-primary overflow-hidden">
          <canvas ref={spectrumRef} className="absolute inset-0 w-full h-full text-accent" />
          {SPECTRUM_LABELS.map(([frequency, label]) => (
            <span
              key={frequency}
              className="absolute bottom-0.5 -translate-x-1/2 text-[9px] text-text-secondary pointer-events-none"
              style={{ left: `${frequencyToUnit(frequency) * 100}%` }}
            >
              {label}
            </span>
          ))}
        </div>
      )}
      <div>
        <div className="flex items-center gap-2">
          <div className="flex flex-col justify-between h-6 text-[9px] leading-none text-text-secondary">
            <span>L</span>
            <span>R</span>
          </div>
          <canvas ref={metersRef} className="flex-1 min-w-0 h-6 text-text-primary" />
          <span
            ref={peakRef}
            className="w-9 text-right text-xs tabular-nums text-text-primary"
            data-tooltip={t('video.mixer.peak')}
          >
            –
          </span>
        </div>
        <div className="@container relative h-3 ml-4 mr-11">
          {METER_SCALE.map((db) => (
            <span
              key={db}
              className={clsx(
                'absolute top-0.5 -translate-x-1/2 text-[9px] leading-none text-text-secondary',
                db === -6 && '@max-[14rem]:hidden',
                db === -36 && '@max-[9rem]:hidden',
              )}
              style={{ left: `${meterUnit(db) * 100}%` }}
            >
              {db === 0 ? '0' : `−${-db}`}
            </span>
          ))}
        </div>
      </div>
      <div ref={statsRef} className="space-y-2 transition-opacity">
        {item === null && (
          <div className="relative">
            <canvas ref={historyRef} className="block w-full h-14 rounded-md bg-bg-primary text-accent" />
            {target !== null && (
              <span
                className="absolute right-1.5 text-[9px] leading-none text-text-primary pointer-events-none"
                style={{ top: `calc(${(1 - loudnessUnit(target)) * 100}% - 11px)` }}
              >
                {t('video.mixer.target', { lufs: `−${Math.abs(target)}` })}
              </span>
            )}
          </div>
        )}
        <div className="grid grid-cols-3 gap-1.5">
          {[
            { label: t('video.mixer.momentary') },
            { label: t('video.mixer.shortTerm') },
            { label: t('video.mixer.integrated'), tooltip: t('video.mixer.integratedHint') },
          ].map(({ label, tooltip }, index) => (
            <Stat
              key={label}
              label={label}
              tooltip={tooltip}
              valueRef={(node) => {
                values.current[index] = node;
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
});
