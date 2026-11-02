import { RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { useEditorStore } from '../../../../store/useEditorStore';
import { useSettingsStore } from '../../../../store/useSettingsStore';
import { useUIStore } from '../../../../store/useUIStore';
import {
  FINE_ADJUSTMENT_MULTIPLIER,
  SpeedEditTarget,
  getSpeedEditTarget,
  hasFineAdjustmentModifier,
} from '../../../ui/Slider';
import { Coord, DEFAULT_SPEED_EDIT_ADJUSTMENTS } from '../../../../utils/adjustments';
import { Panel, PanelRegion } from '../../../ui/AppProperties';
import { formatKeyCode, normalizeCombo } from '../../../../utils/keyboardUtils';

const DRAG_RANGE_PX = 400;
const HUD_OFFSET = 16;
const SPEED_EDIT_KEY = 'KeyW';
const FINE_ADJUSTMENT_KEYS = ['shift', 'alt'];
const PREVIOUS_KEY = 'KeyA';
const NEXT_KEY = 'KeyD';
const RESET_KEY = 'KeyR';
const COPY_KEY = 'KeyC';
const PASTE_KEY = 'KeyV';
const NOTICE_DURATION_MS = 1200;
const CYCLE_DIRECTIONS: Record<string, number> = { [PREVIOUS_KEY]: -1, [NEXT_KEY]: 1 };
const NUDGE_DIRECTIONS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };
const HUD_TRANSITION = { type: 'spring', bounce: 0, duration: 0.3 } as const;
const HUD_ITEM = {
  enter: (direction: number) => ({ x: `${200 * direction}%`, opacity: 0.5 }),
  current: { x: 0, opacity: 1 },
  neighbor: { x: 0, opacity: 0.5 },
  exit: (direction: number) => ({ x: `${-200 * direction}%`, opacity: 0.5 }),
};

interface SpeedEditNotice {
  key: 'editor.speedEdit.copied' | 'editor.speedEdit.pasted';
  label: string;
  value: string;
}

interface SpeedEditCopy {
  target: RefObject<SpeedEditTarget | null>;
  value: number;
}

interface SpeedEditDrag {
  target: SpeedEditTarget;
  position: number;
  value: number;
  last: Coord;
}

const isTextInputFocused = () =>
  document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA';

const toLocalPoint = (element: HTMLElement | null, client: Coord | null): Coord | null => {
  if (!element || !client) return null;
  const rect = element.getBoundingClientRect();
  const x = client.x - rect.left;
  const y = client.y - rect.top;
  return x >= 0 && y >= 0 && x <= rect.width && y <= rect.height ? { x, y } : null;
};

const placeHud = (hud: HTMLElement | null, overlay: HTMLElement | null, client: Coord | null) => {
  const point = toLocalPoint(overlay, client);
  if (!hud || !overlay || !point) return;
  const shift = (isFlipped: boolean) => (isFlipped ? `calc(-100% - ${HUD_OFFSET}px)` : `${HUD_OFFSET}px`);
  hud.style.transition = hud.style.transform ? 'transform 150ms ease-out' : 'none';
  hud.style.left = `${point.x}px`;
  hud.style.top = `${point.y}px`;
  hud.style.transform = `translate(${shift(point.x > overlay.clientWidth * 0.75)}, ${shift(point.y > overlay.clientHeight * 0.75)})`;
};

const getActivePanelArea = () =>
  document.querySelector(`[data-panel="${useUIStore.getState().activePanel}"]`) ?? document;

const getSpeedEditElements = (scope: ParentNode = document) => {
  const ids = useSettingsStore.getState().appSettings?.speedEditAdjustments ?? DEFAULT_SPEED_EDIT_ADJUSTMENTS;
  return [...scope.querySelectorAll<HTMLElement>('[data-speed-edit-id]')]
    .filter((element) => ids.includes(element.dataset.speedEditId!) && element.offsetParent !== null)
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
};

const getAdjacentElement = (
  elements: HTMLElement[],
  target: RefObject<SpeedEditTarget | null> | null,
  direction: number,
) => {
  if (elements.length === 0) return null;
  const current = elements.findIndex((element) => getSpeedEditTarget(element) === target);
  const start = current === -1 ? (direction > 0 ? -1 : elements.length) : current;
  return elements[(start + direction + elements.length) % elements.length];
};

const setIsHeld = (isSpeedEditHeld: boolean) => useEditorStore.getState().setEditor({ isSpeedEditHeld });

const activateOwningPanel = (element: Element | undefined) => {
  const area = element?.closest<HTMLElement>('[data-panel-region]');
  if (!area?.dataset.panel) return;
  useUIStore.getState().setActivePanel(area.dataset.panelRegion as PanelRegion, area.dataset.panel as Panel);
};

const getFraction = (target: SpeedEditTarget, value: number) =>
  (target.toPosition(value) - target.minPosition) / (target.maxPosition - target.minPosition);

export default function SpeedEditOverlay() {
  const osPlatform = useSettingsStore((state) => state.osPlatform);
  const speedEditTarget = useEditorStore((state) => state.speedEditTarget);
  const adjustments = useEditorStore((state) => state.adjustments);
  const liveRotation = useEditorStore((state) => state.liveRotation);
  const isHeld = useEditorStore((state) => state.isSpeedEditHeld);
  const [isPointerInside, setIsPointerInside] = useState(false);
  const [value, setValue] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [cycleDirection, setCycleDirection] = useState(1);
  const [hudWidth, setHudWidth] = useState<number | null>(null);
  const [notice, setNotice] = useState<SpeedEditNotice | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const lastPointerRef = useRef<Coord | null>(null);
  const dragRef = useRef<SpeedEditDrag | null>(null);
  const copyRef = useRef<SpeedEditCopy | null>(null);
  const nudgeRef = useRef<SpeedEditTarget | null>(null);
  const noticeTimeoutRef = useRef<number | undefined>(undefined);

  const showNotice = (key: SpeedEditNotice['key'], target: SpeedEditTarget, value: number) => {
    window.clearTimeout(noticeTimeoutRef.current);
    setNotice({ key, label: target.label ?? '', value: target.format(value) });
    noticeTimeoutRef.current = window.setTimeout(() => setNotice(null), NOTICE_DURATION_MS);
  };

  const beginDrag = (target: SpeedEditTarget, point: Coord) => {
    dragRef.current = { target, position: target.toPosition(target.value), value: target.value, last: point };
    target.onDragStateChange(true);
    setIsDragging(true);
  };

  const endDrag = () => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    drag.target.onDragStateChange(false);
    setIsDragging(false);
  };

  const endNudge = () => {
    nudgeRef.current?.onDragStateChange(false);
    nudgeRef.current = null;
  };

  const measureHud = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const observer = new ResizeObserver(() => setHudWidth(element.offsetWidth));
    observer.observe(element);
    return () => {
      observer.disconnect();
      setHudWidth(null);
    };
  }, []);

  useLayoutEffect(() => {
    placeHud(hudRef.current, overlayRef.current, lastPointerRef.current);
  });

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const forwardWheel = (e: WheelEvent) => {
      e.preventDefault();
      overlay.style.pointerEvents = 'none';
      const below = document.elementFromPoint(e.clientX, e.clientY);
      overlay.style.pointerEvents = 'auto';
      below?.dispatchEvent(new WheelEvent(e.type, e));
    };
    overlay.addEventListener('wheel', forwardWheel, { passive: false });
    return () => overlay.removeEventListener('wheel', forwardWheel);
  }, []);

  useLayoutEffect(() => {
    setValue(speedEditTarget?.current?.value ?? null);
  }, [speedEditTarget, adjustments, liveRotation]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const { activeView, isSettingsOpen } = useUIStore.getState();
      if (activeView !== 'editor' || isSettingsOpen || isTextInputFocused()) return;
      const pressed = normalizeCombo(e, osPlatform).filter((part) => !FINE_ADJUSTMENT_KEYS.includes(part));
      if (pressed.join('+') !== SPEED_EDIT_KEY) return;
      e.preventDefault();
      if (e.repeat) return;
      setIsHeld(true);
      setIsPointerInside(toLocalPoint(overlayRef.current, lastPointerRef.current) !== null);
      const { speedEditTarget: current, setEditor } = useEditorStore.getState();
      const element = current?.current
        ? getSpeedEditElements().find((item) => getSpeedEditTarget(item) === current)
        : getSpeedEditElements(getActivePanelArea())[0];
      if (!current?.current && element) setEditor({ speedEditTarget: getSpeedEditTarget(element) });
      activateOwningPanel(element);
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (normalizeCombo(e, osPlatform).at(-1) === SPEED_EDIT_KEY) setIsHeld(false);
    };
    const handleBlur = () => setIsHeld(false);

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [osPlatform]);

  useEffect(() => {
    if (!isHeld) return;
    const handleHeldKey = (e: KeyboardEvent) => {
      const key = normalizeCombo(e, osPlatform).at(-1) ?? '';
      if (!(key in CYCLE_DIRECTIONS || key in NUDGE_DIRECTIONS || [RESET_KEY, COPY_KEY, PASTE_KEY].includes(key)))
        return;
      e.preventDefault();
      e.stopPropagation();
      const { speedEditTarget: current, setEditor } = useEditorStore.getState();
      const target = current?.current;
      const drag = dragRef.current;
      if (key in NUDGE_DIRECTIONS) {
        if (!target || drag) return;
        if (!nudgeRef.current) {
          nudgeRef.current = target;
          target.onDragStateChange(true);
        }
        target.onChange(target.toValue(target.toPosition(target.value + NUDGE_DIRECTIONS[key] * target.step)));
        return;
      }
      if (e.repeat) return;
      if (key === RESET_KEY) {
        if (target && !drag) target.onChange(target.defaultValue);
        return;
      }
      if (key === COPY_KEY) {
        if (!current || !target) return;
        const copiedValue = drag?.value ?? target.value;
        copyRef.current = { target: current, value: copiedValue };
        showNotice('editor.speedEdit.copied', target, copiedValue);
        return;
      }
      if (key === PASTE_KEY) {
        const copy = copyRef.current;
        const copyTarget = copy?.target.current;
        if (!copy || !copyTarget || drag) return;
        setEditor({ speedEditTarget: copy.target });
        copyTarget.onChange(copy.value);
        showNotice('editor.speedEdit.pasted', copyTarget, copy.value);
        return;
      }
      const next = getAdjacentElement(getSpeedEditElements(getActivePanelArea()), current, CYCLE_DIRECTIONS[key]);
      const nextTarget = next && getSpeedEditTarget(next);
      if (!next || !nextTarget) return;
      endNudge();
      setEditor({ speedEditTarget: nextTarget });
      next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      setCycleDirection(CYCLE_DIRECTIONS[key]);
      if (!drag) return;
      endDrag();
      if (nextTarget.current) beginDrag(nextTarget.current, drag.last);
    };
    const handleHeldKeyUp = (e: KeyboardEvent) => {
      if ((normalizeCombo(e, osPlatform).at(-1) ?? '') in NUDGE_DIRECTIONS) endNudge();
    };
    window.addEventListener('keydown', handleHeldKey, true);
    window.addEventListener('keyup', handleHeldKeyUp);
    window.addEventListener('blur', endNudge);
    return () => {
      window.removeEventListener('keydown', handleHeldKey, true);
      window.removeEventListener('keyup', handleHeldKeyUp);
      window.removeEventListener('blur', endNudge);
      endNudge();
    };
  }, [isHeld, osPlatform]);

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      const point = { x: e.clientX, y: e.clientY };
      lastPointerRef.current = point;
      const drag = dragRef.current;
      if (drag) {
        const { target } = drag;
        const delta = point.x - drag.last.x - (point.y - drag.last.y);
        const multiplier = hasFineAdjustmentModifier(e) ? FINE_ADJUSTMENT_MULTIPLIER : 1;
        const range = target.maxPosition - target.minPosition;
        drag.position = Math.max(
          target.minPosition,
          Math.min(target.maxPosition, drag.position + (delta / DRAG_RANGE_PX) * range * multiplier),
        );
        drag.last = point;
        const nextValue = target.toValue(drag.position);
        if (nextValue !== drag.value) {
          drag.value = nextValue;
          target.onChange(nextValue);
        }
      }
      if (isHeld || drag) {
        placeHud(hudRef.current, overlayRef.current, point);
        setIsPointerInside(toLocalPoint(overlayRef.current, point) !== null);
      }
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    window.addEventListener('blur', endDrag);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      window.removeEventListener('blur', endDrag);
    };
  }, [isHeld]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = speedEditTarget?.current;
    if (!target || e.button !== 0) return;
    e.preventDefault();
    beginDrag(target, { x: e.clientX, y: e.clientY });
  };

  const handleDoubleClick = () => {
    const target = speedEditTarget?.current;
    target?.onChange(target.defaultValue);
  };

  const isActive = isHeld || isDragging;
  const target = speedEditTarget?.current;
  const elements = isHeld && target ? getSpeedEditElements(getActivePanelArea()) : [];

  const getNeighborLabel = (direction: number) => {
    const element = getAdjacentElement(elements, speedEditTarget, direction);
    const neighbor = element && getSpeedEditTarget(element);
    return neighbor && neighbor !== speedEditTarget ? neighbor.current?.label : null;
  };
  const nextLabel = getNeighborLabel(1);
  const neighborLabel = getNeighborLabel(-1);
  const previousLabel = neighborLabel !== nextLabel ? neighborLabel : null;
  const valueFraction = target ? getFraction(target, value ?? target.value) : 0.5;
  const valueWidth = target
    ? Math.max(
        target.format(target.toValue(target.minPosition) + target.step).length,
        target.format(target.toValue(target.maxPosition) - target.step).length,
      )
    : 0;
  const itemMotion = {
    custom: cycleDirection,
    exit: 'exit',
    initial: 'enter',
    layout: 'position' as const,
    transition: HUD_TRANSITION,
    variants: HUD_ITEM,
  };

  const renderKey = (code: string) => (
    <kbd className="px-1 rounded-sm border border-border-color bg-bg-primary font-sans text-[10px]">
      {formatKeyCode(code, osPlatform)}
    </kbd>
  );

  const renderPeek = (label: string, direction: number) => (
    <span
      className={`flex overflow-hidden ${direction < 0 ? 'justify-end mask-l-from-40%' : 'mask-r-from-40%'}`}
      style={{ maxWidth: `${Math.ceil(label.length / 2)}ch` }}
    >
      <span className="shrink-0">{label}</span>
    </span>
  );

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0 z-40"
      style={{ pointerEvents: isActive ? 'auto' : 'none', cursor: isActive && target ? 'move' : undefined }}
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
    >
      <AnimatePresence>
        {isActive && isPointerInside && target && (
          <div className="absolute pointer-events-none" key="hud" ref={hudRef}>
            <motion.div
              animate={{ opacity: 1, scale: 1, width: hudWidth ?? 'auto' }}
              className="relative overflow-hidden rounded-lg bg-surface/95 backdrop-blur-md shadow-xl text-xs text-text-primary whitespace-nowrap"
              exit={{ opacity: 0, scale: 0.95 }}
              initial={{ opacity: 0, scale: 0.95 }}
              layoutRoot
              transition={{ duration: 0.1, ease: 'easeOut', width: HUD_TRANSITION }}
            >
              <div className="relative flex items-center gap-2 p-2 w-max" ref={measureHud}>
                {previousLabel && renderKey(PREVIOUS_KEY)}
                <span className="relative flex items-center gap-3 overflow-hidden">
                  {notice ? (
                    <span className="text-text-secondary">
                      <Trans
                        components={[
                          <span className="text-text-primary" key="0" />,
                          <span className="text-text-primary font-mono tabular-nums" key="1" />,
                        ]}
                        i18nKey={notice.key}
                        values={{ label: notice.label, value: notice.value }}
                      />
                    </span>
                  ) : (
                    <AnimatePresence custom={cycleDirection} initial={false} mode="popLayout">
                      {previousLabel && (
                        <motion.span
                          {...itemMotion}
                          animate="neighbor"
                          className="text-text-secondary"
                          key={previousLabel}
                        >
                          {renderPeek(previousLabel, -1)}
                        </motion.span>
                      )}
                      <motion.span
                        {...itemMotion}
                        animate="current"
                        className="flex items-center gap-2"
                        key={target.label}
                      >
                        {target.label && <span>{target.label}</span>}
                        <span className="font-mono tabular-nums text-right" style={{ minWidth: `${valueWidth}ch` }}>
                          {target.format(value ?? target.value)}
                        </span>
                      </motion.span>
                      {nextLabel && (
                        <motion.span {...itemMotion} animate="neighbor" className="text-text-secondary" key={nextLabel}>
                          {renderPeek(nextLabel, 1)}
                        </motion.span>
                      )}
                    </AnimatePresence>
                  )}
                </span>
                {nextLabel && (
                  <motion.span layout="position" transition={HUD_TRANSITION}>
                    {renderKey(NEXT_KEY)}
                  </motion.span>
                )}
              </div>
              <span className="absolute inset-x-0 bottom-0 h-0.5 bg-card-active">
                <span
                  className="absolute inset-y-0 bg-accent"
                  style={{
                    left: `${Math.min(valueFraction, 0.5) * 100}%`,
                    width: `${Math.abs(valueFraction - 0.5) * 100}%`,
                  }}
                />
              </span>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
