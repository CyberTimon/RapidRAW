import { Check, X, LockKeyhole, UnlockKeyhole } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useEditorStore } from '../store/useEditorStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { executeCommand } from '../shortcuts/runtime';
import { OVERLAY_MODES } from './overlays';

export default function CropControls() {
  const { t } = useTranslation();
  const overlay = useEditorStore((s) => s.overlayMode);
  const locked = useEditorStore((s) => !!s.adjustments.aspectRatio);
  const settings = useSettingsStore((s) => s.appSettings);
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <button
        type="button"
        data-command="crop_lock"
        data-tooltip={t('shortcuts.actions.crop_lock')}
        aria-label={t('shortcuts.actions.crop_lock')}
        aria-pressed={locked}
        className="p-2 hover:bg-surface rounded"
        onClick={() => executeCommand('crop_lock')}
      >
        {locked ? <LockKeyhole size={16} /> : <UnlockKeyhole size={16} />}
      </button>
      <select
        aria-label={t('shortcuts.overlay')}
        value={overlay}
        className="min-w-0 flex-1 bg-bg-primary text-text-primary rounded px-2 py-1"
        onChange={(event) => {
          const mode = event.target.value as typeof overlay;
          useEditorStore.getState().setEditor({ overlayMode: mode });
          if (settings) void useSettingsStore.getState().handleSettingsChange({ ...settings, cropOverlay: mode });
        }}
      >
        {OVERLAY_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {t(`shortcuts.overlays.${mode}`)}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="p-2 hover:bg-surface rounded"
        title={t('shortcuts.actions.crop_cancel')}
        data-command="crop_cancel"
        data-tooltip={t('shortcuts.actions.crop_cancel')}
        aria-label={t('shortcuts.actions.crop_cancel')}
        onClick={() => executeCommand('crop_cancel')}
      >
        <X size={17} />
      </button>
      <button
        type="button"
        className="p-2 hover:bg-surface rounded"
        title={t('shortcuts.actions.crop_accept')}
        data-command="crop_accept"
        data-tooltip={t('shortcuts.actions.crop_accept')}
        aria-label={t('shortcuts.actions.crop_accept')}
        onClick={() => executeCommand('crop_accept')}
      >
        <Check size={17} />
      </button>
    </div>
  );
}
