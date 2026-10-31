import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorStore } from '../../../../store/useEditorStore';
import { useSettingsStore } from '../../../../store/useSettingsStore';
import { useUIStore } from '../../../../store/useUIStore';
import { FINE_ADJUSTMENT_MULTIPLIER, SpeedEditTarget, hasFineAdjustmentModifier } from '../../../ui/Slider';
import { Coord } from '../../../../utils/adjustments';
import { KEYBIND_DEFINITIONS, getEffectiveCombo, normalizeCombo } from '../../../../utils/keyboardUtils';

const DRAG_RANGE_PX = 400;
const HUD_OFFSET = 16;
const SPEED_EDIT_KEYBIND = KEYBIND_DEFINITIONS.find((def) => def.action === 'speed_edit')!;
const FINE_ADJUSTMENT_KEYS = ['shift', 'alt'];

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

export default function SpeedEditOverlay() {
  const { t } = useTranslation();
  const keybinds = useSettingsStore((state) => state.appSettings?.keybinds);
  const osPlatform = useSettingsStore((state) => state.osPlatform);
  const speedEditTarget = useEditorStore((state) => state.speedEditTarget);
  const [isHeld, setIsHeld] = useState(false);
  const [pointer, setPointer] = useState<Coord | null>(null);
  const [value, setValue] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const lastPointerRef = useRef<Coord | null>(null);
  const dragRef = useRef<SpeedEditDrag | null>(null);

  useEffect(() => {
    const combo = getEffectiveCombo(SPEED_EDIT_KEYBIND, keybinds, osPlatform);

    const handleKeyDown = (e: KeyboardEvent) => {
      const { activeView, isSettingsOpen } = useUIStore.getState();
      if (activeView !== 'editor' || isSettingsOpen || isTextInputFocused() || combo.length === 0) return;
      const pressed = normalizeCombo(e, osPlatform).filter(
        (part) => combo.includes(part) || !FINE_ADJUSTMENT_KEYS.includes(part),
      );
      if (pressed.join('+') !== combo.join('+')) return;
      e.preventDefault();
      if (e.repeat) return;
      setIsHeld(true);
      setValue(null);
      setPointer(toLocalPoint(overlayRef.current, lastPointerRef.current));
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (normalizeCombo(e, osPlatform).at(-1) === combo.at(-1)) setIsHeld(false);
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
  }, [keybinds, osPlatform]);

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
          setValue(nextValue);
        }
      }
      if (isHeld || drag) setPointer(toLocalPoint(overlayRef.current, point));
    };
    const endDrag = () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      drag.target.onDragStateChange(false);
      setIsDragging(false);
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
    dragRef.current = {
      target,
      position: target.position,
      value: target.value,
      last: { x: e.clientX, y: e.clientY },
    };
    target.onDragStateChange(true);
    setIsDragging(true);
    setValue(target.value);
  };

  const handleDoubleClick = () => {
    const target = speedEditTarget?.current;
    if (!target) return;
    target.onChange(target.defaultValue);
    setValue(target.defaultValue);
  };

  const isActive = isHeld || isDragging;
  const target = speedEditTarget?.current;
  const overlay = overlayRef.current;
  const flipX = !!pointer && !!overlay && pointer.x > overlay.clientWidth * 0.75;
  const flipY = !!pointer && !!overlay && pointer.y > overlay.clientHeight * 0.75;

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0 z-40"
      style={{ pointerEvents: isActive ? 'auto' : 'none', cursor: isActive && target ? 'move' : undefined }}
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
    >
      {isActive && pointer && (
        <div
          className="absolute flex items-center gap-2 p-2 rounded-md bg-surface shadow-2xl ring-1 ring-black/10 text-xs text-text-primary whitespace-nowrap pointer-events-none"
          style={{
            left: pointer.x + (flipX ? -HUD_OFFSET : HUD_OFFSET),
            top: pointer.y + (flipY ? -HUD_OFFSET : HUD_OFFSET),
            transform: `translate(${flipX ? '-100%' : '0'}, ${flipY ? '-100%' : '0'})`,
          }}
        >
          {target ? (
            <>
              {target.label && <span className="text-text-secondary">{target.label}</span>}
              <span className="font-mono tabular-nums">{target.format(value ?? target.value)}</span>
            </>
          ) : (
            <span className="text-text-secondary">{t('editor.speedEdit.noTarget')}</span>
          )}
        </div>
      )}
    </div>
  );
}
