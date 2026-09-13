import { useTranslation } from 'react-i18next';
import type { AppSettings } from '../components/ui/AppProperties';
import { OVERLAY_MODES } from './overlays';
import { useEditorStore } from '../store/useEditorStore';

export default function CropPreferences({
  settings,
  save,
}: {
  settings: AppSettings;
  save: (settings: AppSettings) => Promise<void>;
}) {
  const { t } = useTranslation();
  const style = 'bg-bg-primary text-text-primary rounded px-2 py-1 max-w-full';
  return (
    <div className="space-y-3">
      <h3 className="font-medium">{t('shortcuts.crop')}</h3>
      <label className="flex items-center justify-between gap-4">
        <span>{t('shortcuts.drag')}</span>
        <select
          className={style}
          value={settings.cropDragMode ?? 'frame'}
          onChange={(e) => void save({ ...settings, cropDragMode: e.target.value as 'photo' | 'frame' })}
        >
          <option value="frame">{t('shortcuts.moveFrame')}</option>
          <option value="photo">{t('shortcuts.movePhoto')}</option>
        </select>
      </label>
      <label className="flex items-center justify-between gap-4">
        <span>{t('shortcuts.overlay')}</span>
        <select
          className={style}
          value={settings.cropOverlay ?? 'thirds'}
          onChange={(e) => {
            const mode = e.target.value as NonNullable<AppSettings['cropOverlay']>;
            useEditorStore.getState().setEditor({ overlayMode: mode });
            void save({ ...settings, cropOverlay: mode });
          }}
        >
          {OVERLAY_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {t(`shortcuts.overlays.${mode}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center justify-between gap-4">
        <span>{t('shortcuts.rotationGrid')}</span>
        <select
          className={style}
          value={settings.cropRotationGrid ?? 'dense'}
          onChange={(e) => void save({ ...settings, cropRotationGrid: e.target.value as 'selected' | 'dense' })}
        >
          <option value="selected">{t('shortcuts.selectedOverlay')}</option>
          <option value="dense">{t('shortcuts.denseGrid')}</option>
        </select>
      </label>
    </div>
  );
}
