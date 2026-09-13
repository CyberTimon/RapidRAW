import { useEffect, useMemo, useState } from 'react';
import { RotateCcw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AppSettings } from '../components/ui/AppProperties';
import { KEYBIND_DEFINITIONS, KEYBIND_SECTIONS, type CommandId } from './definitions';
import { effectiveCombo, profileOverrides, conflictingCommands, type ShortcutProfile } from './profiles';
import { formatKeyCode, normalizeCombo } from '../utils/keyboardUtils';
import CropPreferences from '../crop/CropPreferences';

interface Props {
  settings: AppSettings;
  osPlatform: string;
  save: (settings: AppSettings) => Promise<void>;
}
export default function ShortcutSettings({ settings, osPlatform, save }: Props) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [section, setSection] = useState('');
  const [recording, setRecording] = useState<CommandId | null>(null);
  const [conflict, setConflict] = useState<{ action: CommandId; combo: string[] } | null>(null);
  const [error, setError] = useState('');
  const [resetting, setResetting] = useState(false);
  const overrides = profileOverrides(settings);
  const saveOverrides = (next: Record<string, string[]>) =>
    save({ ...settings, [settings.shortcutProfile === 'lightroom' ? 'lightroomKeybinds' : 'keybinds']: next });
  const assign = (action: CommandId, combo: string[]) => {
    if (conflictingCommands(action, combo, settings).length) setConflict({ action, combo });
    else void saveOverrides({ ...overrides, [action]: combo });
  };
  useEffect(() => {
    if (!recording) return;
    const handler = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.isComposing || event.repeat) return;
      if (event.code === 'Escape') {
        setRecording(null);
        return;
      }
      const combo = normalizeCombo(event, osPlatform);
      if (!combo.length || ['ctrl', 'alt', 'shift'].includes(combo.at(-1)!)) return;
      if (osPlatform === 'macos' && event.metaKey && ['KeyQ', 'KeyH', 'KeyM'].includes(event.code)) {
        setError(t('shortcuts.reserved'));
        return;
      }
      assign(recording, combo);
      setRecording(null);
      setError('');
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [recording, settings, osPlatform]);
  const definitions = useMemo(
    () =>
      KEYBIND_DEFINITIONS.filter(
        (def) =>
          (!section || def.section === section) &&
          `${t(def.description as never)} ${effectiveCombo(def, settings)
            .map((key) => formatKeyCode(key, osPlatform))
            .join(' ')}`
            .toLocaleLowerCase()
            .includes(search.toLocaleLowerCase()),
      ),
    [search, section, settings, osPlatform, t],
  );
  const selectProfile = (profile: ShortcutProfile) => {
    setRecording(null);
    setConflict(null);
    void save({ ...settings, shortcutProfile: profile });
  };
  return (
    <section className="space-y-5" aria-label={t('settings.controls.keyboardTitle')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-3">
          <span>{t('shortcuts.profile')}</span>
          <select
            className="bg-bg-primary text-text-primary rounded p-2"
            value={settings.shortcutProfile ?? 'rapidraw'}
            onChange={(e) => selectProfile(e.target.value as ShortcutProfile)}
          >
            <option value="rapidraw">{t('shortcuts.rapidraw')}</option>
            <option value="lightroom">{t('shortcuts.lightroom')}</option>
          </select>
        </label>
        <button
          className="rounded px-2 py-1 hover:bg-surface"
          onClick={() => {
            setRecording(null);
            setConflict(null);
            void save({
              ...settings,
              shortcutProfile: 'lightroom',
              cropDragMode: 'photo',
              cropOverlay: 'thirds',
              cropRotationGrid: 'selected',
            });
          }}
        >
          {t('shortcuts.useLightroom')}
        </button>
      </div>
      <CropPreferences settings={settings} save={save} />
      <div className="flex gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('shortcuts.search')}
          aria-label={t('shortcuts.search')}
          className="min-w-0 flex-1 rounded bg-bg-primary p-2"
        />
        <select
          aria-label={t('shortcuts.category')}
          value={section}
          onChange={(e) => setSection(e.target.value)}
          className="rounded bg-bg-primary p-2"
        >
          <option value="">{t('shortcuts.all')}</option>
          {KEYBIND_SECTIONS.map((s) => (
            <option key={s.id} value={s.id}>
              {t(s.label as never)}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p role="alert" className="text-text-primary">
          {error}
        </p>
      )}
      {conflict && (
        <div role="alert" className="space-y-2">
          <p>
            {t('shortcuts.conflict', {
              actions: conflictingCommands(conflict.action, conflict.combo, settings)
                .map((def) => t(def.description as never))
                .join(', '),
            })}
          </p>
          <button
            className="px-2 py-1 rounded bg-surface mr-2"
            onClick={() => {
              const next = { ...overrides, [conflict.action]: conflict.combo };
              for (const def of conflictingCommands(conflict.action, conflict.combo, settings)) next[def.action] = [];
              void saveOverrides(next);
              setConflict(null);
            }}
          >
            {t('shortcuts.reassign')}
          </button>
          <button onClick={() => setConflict(null)}>{t('shortcuts.cancel')}</button>
        </div>
      )}
      <div className="space-y-1">
        {definitions.map((def) => {
          const combo = effectiveCombo(def, settings);
          const conflicting = conflictingCommands(def.action, combo, settings).length > 0;
          return (
            <div key={def.action} className="flex items-center gap-2 py-1">
              <span className="flex-1 min-w-0">
                {t(def.description as never)}
                {conflicting && <span className="ml-2 text-text-secondary">{t('shortcuts.conflicting')}</span>}
              </span>
              <button
                className="shrink-0 px-2 py-1 rounded bg-bg-primary focus-visible:outline-2"
                aria-label={t('shortcuts.record', { action: t(def.description as never) })}
                onClick={() => {
                  setRecording(def.action);
                  setError('');
                }}
              >
                {recording === def.action
                  ? t('settings.controls.pressKey')
                  : combo.length
                    ? combo.map((key) => formatKeyCode(key, osPlatform)).join(' + ')
                    : t('settings.controls.notAssigned')}
              </button>
              <button
                className="p-1 hover:bg-surface rounded"
                aria-label={t('shortcuts.clear', { action: t(def.description as never) })}
                onClick={() => void saveOverrides({ ...overrides, [def.action]: [] })}
              >
                <X size={14} />
              </button>
              <button
                className="p-1 hover:bg-surface rounded"
                aria-label={t('shortcuts.reset', { action: t(def.description as never) })}
                disabled={overrides[def.action] === undefined}
                onClick={() => {
                  const next = { ...overrides };
                  delete next[def.action];
                  void saveOverrides(next);
                }}
              >
                <RotateCcw size={14} />
              </button>
            </div>
          );
        })}
        {!definitions.length && <p className="text-text-secondary">{t('shortcuts.noResults')}</p>}
      </div>
      {resetting ? (
        <div className="flex items-center gap-3">
          <span>{t('shortcuts.resetProfileConfirm')}</span>
          <button
            onClick={() => {
              void saveOverrides({});
              setResetting(false);
            }}
          >
            {t('shortcuts.resetProfile')}
          </button>
          <button onClick={() => setResetting(false)}>{t('shortcuts.cancel')}</button>
        </div>
      ) : (
        <button className="text-text-secondary" onClick={() => setResetting(true)}>
          {t('shortcuts.resetProfile')}
        </button>
      )}
    </section>
  );
}
