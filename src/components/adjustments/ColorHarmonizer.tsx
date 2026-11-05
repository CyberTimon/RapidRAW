import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Link2, Link2Off, RotateCcw, Sparkles, ChevronDown } from 'lucide-react';
import HarmonyRulePicker from './HarmonyRulePicker';
import Slider from '../ui/Slider';
import { useTranslation } from 'react-i18next';
import type { Adjustments, ColorHarmonySettings, HarmonyRule } from '../../utils/adjustments';
import { DEFAULT_COLOR_HARMONY } from '../../utils/adjustments';
import {
  HARMONY_RULES,
  dominantHarmonyHues,
  getHarmonyWidthMax,
  moveHarmonyNode,
  rotateHarmony,
  setHarmonyRule,
  wrapHue,
} from '../../utils/colorHarmony';
import { useEditorStore } from '../../store/useEditorStore';
import { Invokes } from '../ui/AppProperties';

type Props = {
  adjustments: Adjustments;
  setAdjustments: (updater: (prev: Adjustments) => Adjustments) => void;
  onDragStateChange?: (dragging: boolean) => void;
  isOpen?: boolean;
};

const WHEEL = 240;
const CENTER = WHEEL / 2;
const RAD = Math.PI / 180;

// Each image's source hue distribution is independent of the harmonizer's
// palette settings. Cache it per image for this editing session, shared by
// global and mask panels. A small bounded LRU avoids retaining all photos.
const HISTOGRAM_CACHE_LIMIT = 48;
const hueHistogramCache = new Map<string, number[]>();
const pendingHueHistograms = new Map<string, Promise<number[]>>();

function cachedHueHistogram(path: string): number[] | undefined {
  const bins = hueHistogramCache.get(path);
  if (bins) {
    hueHistogramCache.delete(path);
    hueHistogramCache.set(path, bins);
  }
  return bins;
}

function requestHueHistogram(path: string): Promise<number[]> {
  const cached = cachedHueHistogram(path);
  if (cached) return Promise.resolve(cached);

  const pending = pendingHueHistograms.get(path);
  if (pending) return pending;

  const request = invoke<number[]>(Invokes.SampleColorHarmonyHistogram, { imagePath: path })
    .then((bins) => {
      if (!Array.isArray(bins) || bins.length !== 72 || bins.some((bin) => !Number.isFinite(bin) || bin < 0)) {
        throw new Error('Invalid color harmony histogram returned by backend');
      }

      // A superseded in-flight request may finish late. Its caller may use
      // the result, but must not move a no-longer-requested image into the LRU.
      if (pendingHueHistograms.get(path) === request) {
        hueHistogramCache.delete(path);
        hueHistogramCache.set(path, bins);
        while (hueHistogramCache.size > HISTOGRAM_CACHE_LIMIT) {
          const oldestPath = hueHistogramCache.keys().next().value;
          if (oldestPath === undefined) break;
          hueHistogramCache.delete(oldestPath);
        }
      }
      return bins;
    })
    .finally(() => {
      if (pendingHueHistograms.get(path) === request) pendingHueHistograms.delete(path);
    });
  pendingHueHistograms.set(path, request);
  // Never retain more than 48 promises, even during rapid folder navigation.
  // Evicted requests still settle for their original callers; they just won't
  // be cached when they resolve.
  while (pendingHueHistograms.size > HISTOGRAM_CACHE_LIMIT) {
    const oldestPath = pendingHueHistograms.keys().next().value;
    if (oldestPath === undefined) break;
    pendingHueHistograms.delete(oldestPath);
  }
  return request;
}
const hueColor = (hue: number) => `oklch(70% 0.13 ${wrapHue(hue)}deg)`;

function point(angle: number, radius: number): [number, number] {
  return [CENTER + Math.sin(angle * RAD) * radius, CENTER - Math.cos(angle * RAD) * radius];
}

function wedge(start: number, end: number, inner: number, outer: number): string {
  const [ax, ay] = point(start, inner);
  const [bx, by] = point(start, outer);
  const [cx, cy] = point(end, outer);
  const [dx, dy] = point(end, inner);
  const largeArc = end - start > 180 ? 1 : 0;
  return `M ${ax} ${ay} L ${bx} ${by} A ${outer} ${outer} 0 ${largeArc} 1 ${cx} ${cy} L ${dx} ${dy} A ${inner} ${inner} 0 ${largeArc} 0 ${ax} ${ay} Z`;
}

export default function ColorHarmonizer({ adjustments, setAdjustments, onDragStateChange, isOpen = false }: Props) {
  const { t } = useTranslation();
  const harmony: ColorHarmonySettings = adjustments.colorHarmony ?? DEFAULT_COLOR_HARMONY;
  const selectedPath = useEditorStore((state) => state.selectedImage?.path);
  const wheelRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ index: number | 'rotate'; pointer: number } | null>(null);
  const pendingHueRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const [showSaturation, setShowSaturation] = useState(false);
  const [histogram, setHistogram] = useState<number[]>([]);
  const [sampling, setSampling] = useState(false);

  useEffect(() => {
    // Never trigger image analysis when the subsection is collapsed. Reopening
    // or revisiting an analyzed photo reuses the completed result immediately.
    if (!selectedPath || !isOpen) {
      setHistogram([]);
      setSampling(false);
      return;
    }

    const cached = cachedHueHistogram(selectedPath);
    if (cached) {
      setHistogram(cached);
      setSampling(false);
      return;
    }

    // Image selection may precede its Rust preview. Share in-flight analysis
    // between panels and retry only while this image's subsection is open.
    setHistogram([]);
    setSampling(true);
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;

    const sample = () => {
      void requestHueHistogram(selectedPath)
        .then((bins) => {
          if (cancelled) return;
          setHistogram(bins);
          setSampling(false);
        })
        .catch((error) => {
          if (cancelled) return;
          if (++attempts < 35) {
            retryTimer = setTimeout(sample, 200);
          } else {
            console.warn('Color harmony histogram unavailable:', error);
            setSampling(false);
          }
        });
    };
    sample();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [selectedPath, isOpen]);

  const update = useCallback(
    (change: (current: ColorHarmonySettings) => ColorHarmonySettings) => {
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        colorHarmony: change(prev.colorHarmony ?? DEFAULT_COLOR_HARMONY),
      }));
    },
    [setAdjustments],
  );

  const chooseRule = (rule: HarmonyRule) => update((current) => setHarmonyRule(current, rule));

  const hueAtPointer = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width - 0.5) * WHEEL;
    const y = ((e.clientY - rect.top) / rect.height - 0.5) * WHEEL;
    return wrapHue(Math.atan2(y, x) / RAD + 90);
  };

  const startDrag = (e: ReactPointerEvent<SVGElement>, index: number | 'rotate') => {
    if (!wheelRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    wheelRef.current.setPointerCapture(e.pointerId);
    dragRef.current = { index, pointer: e.pointerId };
    onDragStateChange?.(true);
  };

  const applyDrag = (hue: number) => {
    const drag = dragRef.current;
    if (!drag) return;
    update((current) => {
      if (drag.index === 'rotate') return rotateHarmony(current, hue);
      if (current.rule === 'custom') return moveHarmonyNode(current, drag.index, hue);
      const delta = ((hue - current.nodes[drag.index] + 540) % 360) - 180;
      return rotateHarmony(current, current.anchor + delta);
    });
  };

  const updateDrag = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (dragRef.current?.pointer !== e.pointerId) return;
    pendingHueRef.current = hueAtPointer(e);
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const angle = pendingHueRef.current;
      pendingHueRef.current = null;
      if (angle !== null) applyDrag(angle);
    });
  };

  const endDrag = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (dragRef.current?.pointer !== e.pointerId) return;
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    pendingHueRef.current = null;
    applyDrag(hueAtPointer(e));
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    onDragStateChange?.(false);
  };

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      onDragStateChange?.(false);
    },
    [onDragStateChange],
  );

  const bars = useMemo(
    () =>
      Array.from({ length: 72 }, (_, i) => {
        const hue = i * 5;
        const magnitude = histogram[i] ?? 0;
        return { hue, d: wedge(hue - 2.35, hue + 2.35, 59, 63 + magnitude * 30) };
      }),
    [histogram],
  );

  const matchDominant = () => {
    if (histogram.length !== 72) return;
    update((current) => {
      const dominant = dominantHarmonyHues(histogram, current.rule === 'custom' ? current.nodes.length : 1);
      if (dominant.length === 0) return current;
      if (current.rule !== 'custom') return rotateHarmony(current, dominant[0]);
      // Each node independently follows a distinct dominant color. Preserve
      // the existing nodes when the photo has fewer chromatic peaks.
      const nodes = current.nodes.map((hue, index) => dominant[index] ?? hue);
      return { ...current, anchor: nodes[0], nodes };
    });
  };

  const count = harmony.nodes.length;
  const widthMax = getHarmonyWidthMax(harmony.nodes);
  return (
    <div className="flex flex-col gap-4 select-none" data-color-harmonizer>
      <p className="text-sm leading-relaxed text-text-secondary">{t('adjustments.colorHarmonizer.description')}</p>

      <div className="grid grid-cols-[1fr_auto] items-center gap-2">
        <HarmonyRulePicker
          value={harmony.rule}
          options={HARMONY_RULES.map((rule) => ({
            value: rule,
            label: t(`adjustments.colorHarmonizer.rules.${rule}`),
          }))}
          ariaLabel={t('adjustments.colorHarmonizer.rule')}
          onChange={chooseRule}
        />
        <button
          type="button"
          aria-label={t('adjustments.colorHarmonizer.unlink')}
          title={
            harmony.rule === 'custom'
              ? t('adjustments.colorHarmonizer.unlinked')
              : t('adjustments.colorHarmonizer.linked')
          }
          onClick={() => chooseRule(harmony.rule === 'custom' ? 'complementary' : 'custom')}
          className="flex items-center justify-center rounded-lg bg-surface border border-border w-9 h-9 text-text-secondary hover:text-text-primary"
        >
          {harmony.rule === 'custom' ? <Link2Off size={17} /> : <Link2 size={17} />}
        </button>
      </div>

      <div className="relative mx-auto w-full max-w-[270px]">
        <svg
          ref={wheelRef}
          viewBox={`0 0 ${WHEEL} ${WHEEL}`}
          role="group"
          aria-label={t('adjustments.colorHarmonizer.wheel')}
          className="w-full h-auto overflow-visible touch-none"
          onPointerMove={updateDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <circle
            cx={CENTER}
            cy={CENTER}
            r={108}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.09}
            strokeWidth={1}
          />
          {Array.from({ length: 72 }, (_, i) => (
            <path
              key={`spectrum-${i}`}
              d={wedge(i * 5 - 2.6, i * 5 + 2.6, 97, 104)}
              fill={hueColor(i * 5)}
              opacity={0.9}
            />
          ))}
          {bars.map(({ hue, d }) => (
            <path key={`hist-${hue}`} d={d} fill={hueColor(hue)} opacity={histogram.length ? 0.75 : 0.12} />
          ))}
          {harmony.nodes.map((hue, i) => {
            // Show the widening sector throughout the useful slider range.
            // The 175° guard only protects legacy widths stored above today's
            // adaptive limit (an SVG sector cannot span a full 360°).
            const spread = Math.min(175, Math.max(5, (harmony.width * 90) / count));
            return (
              <path
                key={`zone-${i}`}
                d={wedge(hue - spread, hue + spread, 28, 55)}
                fill={hueColor(hue)}
                fillOpacity={0.23}
                stroke={hueColor(hue)}
                strokeOpacity={0.65}
                strokeWidth={0.8}
              />
            );
          })}
          <circle
            cx={CENTER}
            cy={CENTER}
            r={27}
            fill="currentColor"
            fillOpacity={0.035}
            onPointerDown={(e) => startDrag(e, 'rotate')}
            className="cursor-grab"
          />
          <text
            x={CENTER}
            y={CENTER - 3}
            textAnchor="middle"
            fontSize={10}
            fill="currentColor"
            opacity={0.65}
            pointerEvents="none"
          >
            {harmony.rule === 'custom'
              ? t('adjustments.colorHarmonizer.free')
              : t('adjustments.colorHarmonizer.rotate')}
          </text>
          <text
            x={CENTER}
            y={CENTER + 10}
            textAnchor="middle"
            fontSize={10}
            fill="currentColor"
            opacity={0.7}
            pointerEvents="none"
          >
            {count} {t('adjustments.colorHarmonizer.nodes')}
          </text>
          {harmony.nodes.map((hue, i) => {
            const [cx, cy] = point(hue, 82);
            return (
              <g key={`node-${i}`} onPointerDown={(e) => startDrag(e, i)} className="cursor-grab">
                <circle cx={cx} cy={cy} r={15} fill="transparent" />
                <circle
                  cx={cx}
                  cy={cy}
                  r={9}
                  fill={hueColor(hue)}
                  stroke="white"
                  strokeWidth={2}
                  style={{ filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.38))' }}
                />
                <text
                  x={cx}
                  y={cy + 3.5}
                  textAnchor="middle"
                  fontSize={9}
                  fontWeight={700}
                  pointerEvents="none"
                  fill="black"
                >
                  {i + 1}
                </text>
              </g>
            );
          })}
        </svg>
        <div className="mt-1 flex justify-between gap-1 text-xs text-text-secondary">
          <span>
            {sampling ? t('adjustments.colorHarmonizer.sampling') : t('adjustments.colorHarmonizer.histogram')}
          </span>
          <button
            type="button"
            className="flex items-center gap-1 hover:text-text-primary disabled:opacity-40"
            disabled={histogram.length === 0}
            onClick={matchDominant}
          >
            <Sparkles size={12} />
            {t('adjustments.colorHarmonizer.match')}
          </button>
        </div>
      </div>

      {harmony.rule === 'custom' && (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="text-text-secondary">{t('adjustments.colorHarmonizer.nodeCount')}</span>
          <div className="inline-flex rounded-lg bg-surface p-0.5 gap-0.5">
            {[2, 3, 4].map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={count === n}
                className={`w-8 h-7 rounded-md tabular-nums transition-colors ${count === n ? 'bg-card-active text-text-primary font-semibold' : 'text-text-secondary'}`}
                onClick={() =>
                  update((current) => ({
                    ...current,
                    nodes: Array.from(
                      { length: n },
                      (_, i) => current.nodes[i] ?? wrapHue(current.anchor + (i * 360) / n),
                    ),
                  }))
                }
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col border-t border-border pt-3">
        <Slider
          label={t('adjustments.colorHarmonizer.strength')}
          value={Math.round(harmony.strength * 100)}
          min={0}
          max={100}
          step={1}
          defaultValue={0}
          suffix="%"
          onChange={(event) => update((v) => ({ ...v, strength: Number(event.target.value) / 100 }))}
          onDragStateChange={onDragStateChange}
        />
        <Slider
          label={t('adjustments.colorHarmonizer.width')}
          value={harmony.width}
          min={0.25}
          max={widthMax}
          step={0.05}
          defaultValue={1}
          onChange={(event) => update((v) => ({ ...v, width: Number(event.target.value) }))}
          onDragStateChange={onDragStateChange}
        />
        <Slider
          label={t('adjustments.colorHarmonizer.neutral')}
          value={Math.round(harmony.neutralProtection * 100)}
          min={0}
          max={100}
          step={1}
          defaultValue={50}
          suffix="%"
          onChange={(event) => update((v) => ({ ...v, neutralProtection: Number(event.target.value) / 100 }))}
          onDragStateChange={onDragStateChange}
        />
      </div>

      <div className="border-t border-border pt-2">
        <button
          type="button"
          className="w-full flex items-center justify-between text-sm text-text-secondary py-1"
          aria-expanded={showSaturation}
          onClick={() => setShowSaturation((v) => !v)}
        >
          {t('adjustments.colorHarmonizer.saturation')}
          <ChevronDown size={15} className={`transition-transform ${showSaturation ? 'rotate-180' : ''}`} />
        </button>
        {showSaturation && (
          <div className="flex flex-col gap-3 pt-2">
            {harmony.nodes.map((hue, index) => (
              <div key={index} className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: hueColor(hue) }} />
                <div className="grow">
                  <Slider
                    label={`${t('adjustments.colorHarmonizer.node')} ${index + 1}`}
                    min={0}
                    max={200}
                    step={1}
                    defaultValue={100}
                    value={Math.round((harmony.nodeSaturation[index] ?? 1) * 100)}
                    suffix="%"
                    onDragStateChange={onDragStateChange}
                    onChange={(event) =>
                      update((v) => {
                        const nodeSaturation = [...v.nodeSaturation];
                        nodeSaturation[index] = Number(event.target.value) / 100;
                        return { ...v, nodeSaturation };
                      })
                    }
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        className="flex items-center justify-center gap-1.5 self-end rounded-md px-2 py-1 text-sm text-text-secondary hover:text-text-primary"
        onClick={() =>
          update(() => ({
            ...DEFAULT_COLOR_HARMONY,
            nodes: [...DEFAULT_COLOR_HARMONY.nodes],
            nodeSaturation: [...DEFAULT_COLOR_HARMONY.nodeSaturation],
          }))
        }
      >
        <RotateCcw size={13} /> {t('adjustments.colorHarmonizer.reset')}
      </button>
    </div>
  );
}
