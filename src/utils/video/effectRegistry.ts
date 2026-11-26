import {
  ArrowRightToLine,
  Blend,
  ChevronsRight,
  Circle,
  Droplets,
  Moon,
  PanelLeftOpen,
  RotateCw,
  Sun,
  Wind,
  ZoomIn,
  type LucideIcon,
} from 'lucide-react';
import { BlendMode, MotionKind, TransitionKind } from '../../types/video';

export type EffectKind = TransitionKind | MotionKind;

export const TRANSITION_ICONS: Record<TransitionKind, LucideIcon> = {
  dissolve: Blend,
  wipe: ArrowRightToLine,
  push: ChevronsRight,
  slide: PanelLeftOpen,
  zoom: ZoomIn,
  blur: Droplets,
  dipToBlack: Moon,
  dipToWhite: Sun,
  iris: Circle,
  whip: Wind,
  spin: RotateCw,
};

export const TRANSITIONS = Object.keys(TRANSITION_ICONS) as Array<TransitionKind>;

export const MOTIONS: Array<MotionKind> = ['fade', 'slide', 'zoom', 'pop', 'blur', 'wipe', 'spin'];

export const TEXT_MOTIONS: Array<MotionKind> = ['typewriter', 'words'];

const DIRECTIONAL: Array<EffectKind> = ['wipe', 'push', 'slide', 'whip'];

export const isDirectional = (kind: EffectKind) => DIRECTIONAL.includes(kind);

export const BLEND_MODES: Array<BlendMode> = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'softLight',
  'add',
  'difference',
  'darken',
  'lighten',
];
