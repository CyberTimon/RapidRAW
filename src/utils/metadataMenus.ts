import type { ParseKeys, TFunction } from 'i18next';
import { Ban, Flag, FlagOff, Palette, Star } from 'lucide-react';
import { ImageFlag } from '../types/library';
import { OPTION_SEPARATOR } from '../types/ui';
import { Color, COLOR_LABELS } from './adjustments';

export const flagMenu = (t: TFunction, setFlag: (flag: ImageFlag | null) => void, keys = true) => ({
  label: t('contextMenus.editor.flag'),
  icon: Flag,
  submenu: [
    {
      label: t('contextMenus.editor.unflagged'),
      icon: FlagOff,
      onClick: () => setFlag(null),
      shortcut: keys ? 'unflag' : undefined,
    },
    { type: OPTION_SEPARATOR },
    { label: t('contextMenus.editor.flagPick'), icon: Flag, onClick: () => setFlag(ImageFlag.Pick) },
    {
      label: t('contextMenus.editor.flagReject'),
      icon: Ban,
      onClick: () => setFlag(ImageFlag.Reject),
    },
  ],
});

export const ratingMenu = (t: TFunction, rate: (rating: number) => void, keys = true) => ({
  label: t('contextMenus.editor.rating'),
  icon: Star,
  submenu: [
    {
      label: t('contextMenus.editor.noRating'),
      onClick: () => rate(0),
      shortcut: keys ? 'rate_0' : undefined,
    },
    { type: OPTION_SEPARATOR },
    ...[1, 2, 3, 4, 5].map((rating: number) => ({
      label: t('contextMenus.editor.ratingLabel', { count: rating }),
      onClick: () => rate(rating),
      shortcut: keys ? `rate_${rating}` : undefined,
    })),
  ],
});

export const colorLabelMenu = (t: TFunction, setLabel: (color: string | null) => void, keys = true) => ({
  label: t('contextMenus.editor.colorLabel'),
  icon: Palette,
  submenu: [
    {
      label: t('contextMenus.editor.noLabel'),
      onClick: () => setLabel(null),
      shortcut: keys ? 'color_label_none' : undefined,
    },
    { type: OPTION_SEPARATOR },
    ...COLOR_LABELS.map((label: Color) => ({
      label: t(`contextMenus.colors.${label.name}` as ParseKeys),
      color: label.color,
      onClick: () => setLabel(label.name),
      shortcut: keys ? `color_label_${label.name}` : undefined,
    })),
  ],
});
