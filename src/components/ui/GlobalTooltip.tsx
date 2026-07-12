import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import Text from './Text';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';

const TOOLTIP_DELAY = 500;
const OFFSET = 8;
const TOOLTIP_VIEWPORT_MARGIN = 12;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

interface TooltipData {
  content: string;
  centerX: number;
  y: number;
  isAbove: boolean;
}

export default function GlobalTooltip() {
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const [leftOverride, setLeftOverride] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const targetRef = useRef<HTMLElement | null>(null);
  const rafRef = useRef<number>(0);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const stopWatch = () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };

    const hide = () => {
      clearTimer();
      stopWatch();
      targetRef.current = null;
      setTooltip(null);
    };

    const computePosition = (el: HTMLElement): TooltipData | null => {
      const content = el.getAttribute('data-tooltip');
      if (!content) return null;

      const rect = el.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      let y = rect.bottom + OFFSET;
      let isAbove = false;

      if (y + 40 > window.innerHeight) {
        y = rect.top - OFFSET;
        isAbove = true;
      }

      return { content, centerX, y, isAbove };
    };

    const watchTarget = () => {
      const tick = () => {
        const el = targetRef.current;
        if (!el || !document.contains(el) || !el.getAttribute('data-tooltip')) {
          hide();
          return;
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    };

    const handleMouseOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest?.('[data-tooltip]');
      if (!el || !(el instanceof HTMLElement)) return;
      if (el === targetRef.current) return;

      hide();

      if (!el.getAttribute('data-tooltip')) return;

      targetRef.current = el;

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const current = targetRef.current;
        if (!current || !document.contains(current)) {
          hide();
          return;
        }

        const data = computePosition(current);
        if (!data) {
          hide();
          return;
        }

        setLeftOverride(null);
        setTooltip(data);
        watchTarget();
      }, TOOLTIP_DELAY);
    };

    const handleMouseOut = (e: MouseEvent) => {
      const current = targetRef.current;
      if (!current) return;

      const from = e.target as HTMLElement;
      const to = e.relatedTarget as HTMLElement | null;

      const leaving = from === current || current.contains(from);
      const staying = to !== null && current.contains(to);

      if (leaving && !staying) {
        hide();
      }
    };

    const dismiss = () => hide();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };

    document.addEventListener('mouseover', handleMouseOver);
    document.addEventListener('mouseout', handleMouseOut);
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('scroll', dismiss, true);
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('mouseover', handleMouseOver);
      document.removeEventListener('mouseout', handleMouseOut);
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('scroll', dismiss, true);
      document.removeEventListener('keydown', onKey);
      clearTimer();
      stopWatch();
    };
  }, []);

  useLayoutEffect(() => {
    if (!tooltip) {
      if (leftOverride !== null) setLeftOverride(null);
      return;
    }

    const el = tooltipRef.current;
    if (!el) return;

    const width = el.offsetWidth;
    const minLeft = TOOLTIP_VIEWPORT_MARGIN;
    const maxLeft = Math.max(minLeft, window.innerWidth - TOOLTIP_VIEWPORT_MARGIN - width);
    const desiredLeft = tooltip.centerX - width / 2;
    const clampedLeft = clamp(desiredLeft, minLeft, maxLeft);
    // Compensate for the -50% translateX so the original animation stays identical.
    const adjustedCenterX = clampedLeft + width / 2;

    if (leftOverride !== adjustedCenterX) {
      setLeftOverride(adjustedCenterX);
    }
  }, [tooltip, leftOverride]);

  const left = leftOverride !== null ? leftOverride : tooltip?.centerX ?? 0;

  return createPortal(
    <AnimatePresence mode="wait">
      {tooltip && (
        <motion.div
          ref={tooltipRef}
          key={tooltip.content}
          initial={{ opacity: 0, scale: 0.9, y: tooltip.isAbove ? 5 : -5, x: '-50%' }}
          animate={{ opacity: 1, scale: 1, y: tooltip.isAbove ? -10 : 0, x: '-50%' }}
          exit={{ opacity: 0, scale: 0.9, x: '-50%' }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          style={{ top: tooltip.y, left }}
          className={clsx(
            'fixed z-100 pointer-events-none',
            'bg-surface/80 backdrop-blur-xs',
            'border border-text-secondary/10 shadow-xl rounded-md',
            'px-2.5 py-1.5 whitespace-nowrap',
            tooltip.isAbove && '-translate-y-full',
          )}
        >
          <Text variant={TextVariants.small} color={TextColors.primary} weight={TextWeights.medium}>
            {tooltip.content}
          </Text>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
