import { Panel } from '../components/ui/AppProperties';
import { useEditorActions } from '../hooks/useEditorActions';
import { calculateCenteredCrop, getOrientedDimensions, isCropWithinBounds } from '../utils/cropUtils';
import { cancelCropGesture, finishCropSession } from '../crop/lifecycle';
import type { CommandHandlers } from './types';
import { OVERLAY_MODES } from '../crop/overlays';

export function cropCommands(): CommandHandlers {
  const update = (
    patch: Parameters<ReturnType<typeof useEditorActions>['setAdjustments']>[0],
    s: Parameters<NonNullable<CommandHandlers['crop_reset']>['execute']>[1],
  ) => {
    s.editor.setEditor({
      adjustments: typeof patch === 'function' ? patch(s.editor.adjustments) : { ...s.editor.adjustments, ...patch },
    });
  };
  const commands: CommandHandlers = {
    crop_accept: {
      execute: (_, s) => {
        finishCropSession();
        s.ui.setPanel(Panel.Adjustments);
      },
    },
    crop_cancel: {
      execute: (_, s) => {
        if (!cancelCropGesture()) {
          finishCropSession(false);
          s.ui.setPanel(Panel.Adjustments);
        }
      },
    },
    crop_lock: {
      execute: (_, s) => {
        const a = s.editor.adjustments,
          image = s.editor.selectedImage;
        if (!image) return;
        const { width, height } = getOrientedDimensions(image.width, image.height, a.orientationSteps || 0);
        update({ aspectRatio: a.aspectRatio ? null : a.crop ? a.crop.width / a.crop.height : width / height }, s);
      },
    },
    crop_orientation: {
      execute: (_, s) => {
        const a = s.editor.adjustments,
          image = s.editor.selectedImage;
        if (!image || !a.aspectRatio) return;
        const ratio = 1 / a.aspectRatio;
        update(
          {
            aspectRatio: ratio,
            crop: calculateCenteredCrop(image.width, image.height, a.orientationSteps || 0, ratio, a.rotation || 0),
          },
          s,
        );
      },
    },
    crop_overlay: {
      execute: (_, s) => {
        const mode = OVERLAY_MODES[(OVERLAY_MODES.indexOf(s.editor.overlayMode) + 1) % OVERLAY_MODES.length];
        s.editor.setEditor({ overlayMode: mode });
        if (s.settings.appSettings)
          void s.settings.handleSettingsChange({ ...s.settings.appSettings, cropOverlay: mode });
      },
    },
    crop_overlay_rotate: {
      execute: (_, s) => s.editor.setEditor({ overlayRotation: (s.editor.overlayRotation + 1) % 4 }),
    },
    crop_drag_mode: {
      execute: (_, s) => {
        if (s.settings.appSettings)
          void s.settings.handleSettingsChange({
            ...s.settings.appSettings,
            cropDragMode: s.settings.appSettings.cropDragMode === 'photo' ? 'frame' : 'photo',
          });
      },
    },
    crop_flip_h: { execute: (_, s) => update({ flipHorizontal: !s.editor.adjustments.flipHorizontal }, s) },
    crop_flip_v: { execute: (_, s) => update({ flipVertical: !s.editor.adjustments.flipVertical }, s) },
    crop_reset: {
      execute: (_, s) => {
        const image = s.editor.selectedImage;
        if (!image) return;
        update(
          {
            crop: null,
            rotation: 0,
            orientationSteps: 0,
            flipHorizontal: false,
            flipVertical: false,
            aspectRatio: image.width / image.height,
          },
          s,
        );
      },
    },
  };
  for (const [action, dx, dy] of [
    ['crop_left', -1, 0],
    ['crop_right', 1, 0],
    ['crop_up', 0, -1],
    ['crop_down', 0, 1],
  ] as const) {
    commands[action] = {
      execute: (event, s) => {
        const image = s.editor.selectedImage,
          a = s.editor.adjustments;
        if (!image || !a.crop) return;
        const { width, height } = getOrientedDimensions(image.width, image.height, a.orientationSteps || 0);
        const step = event.shiftKey ? 10 : 1;
        const direction = s.settings.appSettings?.cropDragMode === 'photo' ? -1 : 1;
        const crop = { ...a.crop, x: a.crop.x + dx * step * direction, y: a.crop.y + dy * step * direction };
        if (isCropWithinBounds(crop, width, height, a.rotation || 0)) update({ crop }, s);
      },
    };
  }
  for (const handler of Object.values(commands))
    handler.shouldFire = (s) =>
      s.ui.activeView === 'editor' && s.ui.activePanel === Panel.Crop && !!s.editor.cropSession;
  return commands;
}
