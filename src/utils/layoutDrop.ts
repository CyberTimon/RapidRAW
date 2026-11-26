import { pointerWithin, type ClientRect, type CollisionDetection } from '@dnd-kit/core';
import type { SwitcherPlacement } from '../store/useUIStore';
import type { PanelRegion } from '../types/ui';

export type LayoutSide = 'left' | 'right';
export type SplitSlot = 'top' | 'bottom';

export const SPLIT_BAND_RATIO = 0.25;

export type LayoutDropData =
  | { type: 'layout-region'; side: LayoutSide; region: PanelRegion }
  | { type: 'layout-split'; side: LayoutSide; region: PanelRegion; slot: SplitSlot };

const LAYOUT_DROP_PRIORITY = ['layout-switcher', 'layout-split', 'layout-bottom', 'layout-region'];

const isClippedAway = (node: HTMLElement | null | undefined, pointer: { x: number; y: number } | null) => {
  const clip = node?.closest('[data-drop-clip]');
  if (!clip || !pointer) return false;
  const rect = clip.getBoundingClientRect();
  return pointer.x < rect.left || pointer.x > rect.right || pointer.y < rect.top || pointer.y > rect.bottom;
};

export const layoutCollisionDetection: CollisionDetection = (args) => {
  const collisions = pointerWithin(args).filter(
    (collision) => !isClippedAway(collision.data?.droppableContainer?.node.current, args.pointerCoordinates),
  );
  if (args.active.data.current?.type !== 'layout-tab') return collisions;
  for (const type of LAYOUT_DROP_PRIORITY) {
    const hit = collisions.find((collision) => collision.data?.droppableContainer?.data.current?.type === type);
    if (hit) return [hit];
  }
  return collisions;
};

export const getDropPlacement = (
  side: LayoutSide,
  target: ClientRect,
  dragged: ClientRect | null,
): SwitcherPlacement | null => {
  if (!dragged) return null;
  const x = dragged.left + dragged.width / 2 - target.left;
  const y = dragged.top + dragged.height / 2 - target.top;
  const slope = target.height / target.width;
  const diagonalY = side === 'left' ? target.height - slope * x : slope * x;
  return y < diagonalY ? side : 'bottom';
};
