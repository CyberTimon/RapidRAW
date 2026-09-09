import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { useExportSettings } from '../hooks/useExportSettings';
import { useSettingsStore } from '../store/useSettingsStore';
import { useEditorStore } from '../store/useEditorStore';
import { FILE_FORMATS } from '../components/ui/ExportImportProperties';
import { peopleInvoke, usePeopleStore } from './store';
import type { PeopleExportReport } from './types';

export default function PeopleExport({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const { t } = useTranslation();
  const settings = useExportSettings();
  const presets = useSettingsStore((s) => s.appSettings?.exportPresets ?? []);
  const [originals, setOriginals] = useState(true);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<PeopleExportReport | null>(null);
  const running = usePeopleStore((s) => s.progress?.running || s.mutating);
  const start = async () => {
    setBusy(true);
    try {
      const destination = await open({ directory: true, multiple: false, title: t('people.export') });
      if (!destination) return;
      const editor = useEditorStore.getState();
      setReport(null);
      const result = await peopleInvoke<PeopleExportReport>('export_people', {
        request: {
          ids,
          destination,
          originals,
          format: FILE_FORMATS.find((f) => f.id === settings.fileFormat)?.extensions[0] ?? 'jpg',
          currentEditPath: editor.selectedImage?.path ?? null,
          currentEditAdjustments: editor.adjustments ?? null,
          settings: {
            filenameTemplate: settings.filenameTemplate,
            jpegQuality: settings.jpegQuality,
            keepMetadata: settings.keepMetadata,
            preserveTimestamps: settings.preserveTimestamps,
            stripGps: settings.stripGps,
            resize: settings.enableResize
              ? { mode: settings.resizeMode, value: settings.resizeValue, dontEnlarge: settings.dontEnlarge }
              : null,
            exportMasks: settings.exportMasks,
            watermark:
              settings.enableWatermark && settings.watermarkPath
                ? {
                    path: settings.watermarkPath,
                    anchor: settings.watermarkAnchor,
                    scale: settings.watermarkScale,
                    spacing: settings.watermarkSpacing,
                    opacity: settings.watermarkOpacity,
                  }
                : null,
          },
        },
      });
      setReport(result);
    } catch (error) {
      usePeopleStore.setState({ error: String(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="p-3 bg-bg-secondary rounded-md max-w-lg" aria-label={t('people.export')}>
      <fieldset disabled={busy || running} className="flex flex-wrap gap-2 items-center text-sm">
        <select
          className="bg-surface rounded-md p-2"
          aria-label={t('people.exportMode')}
          value={originals ? 'originals' : 'edited'}
          onChange={(e) => setOriginals(e.target.value === 'originals')}
        >
          <option value="originals">{t('people.originals')}</option>
          <option value="edited">{t('people.edited')}</option>
        </select>
        {!originals && (
          <>
            <select
              className="bg-surface rounded-md p-2"
              aria-label={t('people.exportPreset')}
              defaultValue=""
              onChange={(e) => {
                const preset = presets.find((p) => p.id === e.target.value);
                if (preset) settings.handleApplyPreset(preset);
              }}
            >
              <option value="">{t('people.exportPreset')}</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              className="bg-surface rounded-md p-2"
              aria-label={t('people.format')}
              value={settings.fileFormat}
              onChange={(e) => settings.setFileFormat(e.target.value)}
            >
              {FILE_FORMATS.filter((f) => f.id !== 'cube').map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </>
        )}
        <button className="p-2 hover:bg-surface rounded-md" onClick={() => void start()}>
          {t('people.chooseFolder')}
        </button>
      </fieldset>
      <button disabled={busy} className="p-2 text-sm" onClick={onClose}>
        {t('people.back')}
      </button>
      {report && (
        <div role="status" className="text-sm p-2">
          <p>
            {t(report.cancelled ? 'people.exportCancelled' : 'people.exportResult', {
              count: report.copied,
              failed: report.failed.length,
            })}
          </p>
          {!!report.failed.length && (
            <details>
              <summary>{t('people.failures')}</summary>
              <ul>
                {report.failed.map((failure, i) => (
                  <li key={i} className="break-all">
                    {failure}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
