import {
  Brush,
  BringToFront,
  Circle,
  Cloud,
  Droplet,
  Droplets,
  Eraser,
  SquareMousePointer,
  RectangleHorizontal,
  TriangleRight,
  User,
  Sun,
  Stamp,
  Bandage,
  Spline,
  MopSparkles,
  TextSearch,
  ScanFace,
  Magnet,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import Text from '../../ui/Text';
import { TextWeights } from '../../../types/typography';
import type { ParseKeys } from 'i18next';
import { Mask, MaskType } from '../../../types/masks';

export const MASK_ICON_MAP: Record<Mask, any> = {
  [Mask.AiDepth]: BringToFront,
  [Mask.AiForeground]: User,
  [Mask.AiSky]: Cloud,
  [Mask.AiSubject]: SquareMousePointer,
  [Mask.AiText]: TextSearch,
  [Mask.AiFace]: ScanFace,
  [Mask.All]: RectangleHorizontal,
  [Mask.Brush]: Brush,
  [Mask.Flow]: Droplets,
  [Mask.MatchBrush]: Magnet,
  [Mask.Color]: Droplet,
  [Mask.Linear]: TriangleRight,
  [Mask.Luminance]: Sun,
  [Mask.QuickEraser]: Eraser,
  [Mask.Radial]: Circle,
  [Mask.Clone]: Stamp,
  [Mask.Heal]: Bandage,
  [Mask.Liquify]: Spline,
  [Mask.Retouch]: MopSparkles,
};

export const MASK_AI_TYPES: Array<MaskType> = [
  { disabled: false, icon: SquareMousePointer, name: 'Subject', type: Mask.AiSubject },
  { disabled: false, icon: Cloud, name: 'Sky', type: Mask.AiSky },
  { disabled: false, icon: User, name: 'Foreground', type: Mask.AiForeground },
  { disabled: false, icon: BringToFront, name: 'Depth', type: Mask.AiDepth },
  { disabled: false, icon: TextSearch, name: 'Text', type: Mask.AiText },
  { disabled: false, icon: ScanFace, name: 'Face', type: Mask.AiFace },
];

export const FACE_PARTS = [
  'faceSkin',
  'bodySkin',
  'eyebrows',
  'eyeWhites',
  'iris',
  'lips',
  'teeth',
  'nose',
  'hair',
] as const;
export type FacePart = (typeof FACE_PARTS)[number];

export const MASK_BASIC_TYPES: Array<MaskType> = [
  { disabled: false, icon: Brush, name: 'Brush', type: Mask.Brush },
  { disabled: false, icon: TriangleRight, name: 'Linear', type: Mask.Linear },
  { disabled: false, icon: Circle, name: 'Radial', type: Mask.Radial },
  { disabled: false, icon: Droplets, name: 'Flow', type: Mask.Flow },
  { disabled: false, icon: Magnet, name: 'Match Brush', type: Mask.MatchBrush },
];

export const MASK_RANGE_TYPES: Array<MaskType> = [
  { disabled: false, icon: Droplet, name: 'Color', type: Mask.Color },
  { disabled: false, icon: Sun, name: 'Luminance', type: Mask.Luminance },
  { disabled: false, icon: RectangleHorizontal, name: 'Whole Image', type: Mask.All },
];

export const ALL_MASK_TYPES = [...MASK_AI_TYPES, ...MASK_BASIC_TYPES, ...MASK_RANGE_TYPES];

export const AI_DIRECT_PATCH_TYPES: Array<MaskType> = [
  {
    disabled: false,
    icon: Stamp,
    name: 'Clone',
    type: Mask.Clone,
  },
  {
    disabled: false,
    icon: Bandage,
    name: 'Heal',
    type: Mask.Heal,
  },
];

export const AI_TOUCH_UP_TYPES: Array<MaskType> = [
  {
    disabled: false,
    icon: Spline,
    name: 'Liquify',
    type: Mask.Liquify,
  },
  {
    disabled: false,
    icon: MopSparkles,
    name: 'Retouch',
    type: Mask.Retouch,
  },
];

export const AI_GENERATIVE_CREATION_TYPES: Array<MaskType> = [
  {
    disabled: false,
    icon: Eraser,
    name: 'Quick Erase',
    type: Mask.QuickEraser,
  },
  {
    disabled: false,
    icon: SquareMousePointer,
    name: 'Subject',
    type: Mask.AiSubject,
  },
  {
    disabled: false,
    icon: User,
    name: 'Foreground',
    type: Mask.AiForeground,
  },
  {
    disabled: false,
    icon: Brush,
    name: 'Brush',
    type: Mask.Brush,
  },
  {
    disabled: false,
    icon: TriangleRight,
    name: 'Linear',
    type: Mask.Linear,
  },
  {
    disabled: false,
    icon: Circle,
    name: 'Radial',
    type: Mask.Radial,
  },
];

export const OTHERS_MASK_TYPES: Array<MaskType> = [
  {
    disabled: false,
    icon: BringToFront,
    name: 'Depth',
    type: Mask.AiDepth,
  },
  {
    disabled: false,
    icon: Droplet,
    name: 'Color',
    type: Mask.Color,
  },
  {
    disabled: false,
    icon: Sun,
    name: 'Luminance',
    type: Mask.Luminance,
  },
  {
    disabled: false,
    icon: Brush,
    name: 'Brush',
    type: Mask.Brush,
  },
  {
    disabled: false,
    icon: Droplets,
    name: 'Flow',
    type: Mask.Flow,
  },
  {
    disabled: false,
    icon: RectangleHorizontal,
    name: 'Whole Image',
    type: Mask.All,
  },
];

export const AI_SUB_MASK_COMPONENT_TYPES: Array<MaskType> = [
  ...AI_DIRECT_PATCH_TYPES,
  ...AI_TOUCH_UP_TYPES,
  ...AI_GENERATIVE_CREATION_TYPES,
];

export function NewMaskDropZone({ isOver, textKey }: { isOver: boolean; textKey: ParseKeys }) {
  const { t } = useTranslation();
  return (
    <motion.div
      layout
      initial={{ opacity: 0, height: 0, marginTop: 0 }}
      animate={{ opacity: 1, height: 'auto', marginTop: '4px' }}
      exit={{ opacity: 0, height: 0, marginTop: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className={`p-3 rounded-lg text-center ${isOver ? 'border border-accent/80 bg-bg-tertiary/50' : ''}`}
    >
      <Text weight={TextWeights.medium}>{t(textKey)}</Text>
    </motion.div>
  );
}
