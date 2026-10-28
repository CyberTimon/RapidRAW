import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { FolderOpen, Plus, Trash2 } from 'lucide-react';
import Button from '../../ui/Button';
import Dropdown, { OptionItem } from '../../ui/Dropdown';
import Input from '../../ui/Input';
import Text from '../../ui/Text';
import { TextVariants } from '../../../types/typography';
import { AppSettings, EditInApp, EditInMode } from '../../ui/AppProperties';
import { useOsPlatform } from '../../../hooks/useOsPlatform';

interface EditInAppsSettingsProps {
  appSettings: AppSettings | null;
  onSettingsChange(settings: AppSettings): void | Promise<void>;
}

const patchAt = (apps: EditInApp[], index: number, patch: Partial<EditInApp>) =>
  apps.map((app, i) => (i === index ? { ...app, ...patch } : app));

export default function EditInAppsSettings({ appSettings, onSettingsChange }: EditInAppsSettingsProps) {
  const { t } = useTranslation();
  const osPlatform = useOsPlatform();
  const [apps, setApps] = useState<EditInApp[]>(appSettings?.editInApps ?? []);

  useEffect(() => {
    setApps(appSettings?.editInApps ?? []);
  }, [appSettings?.editInApps]);

  const modeOptions = useMemo<OptionItem<EditInMode>[]>(
    () => [
      { value: EditInMode.Original, label: t('settings.processing.editIn.modes.original') },
      { value: EditInMode.Rendered, label: t('settings.processing.editIn.modes.rendered') },
    ],
    [t],
  );

  const commit = (next: EditInApp[]) => {
    setApps(next);
    if (appSettings) onSettingsChange({ ...appSettings, editInApps: next });
  };

  const renderField = (index: number, field: 'name' | 'path' | 'args', placeholder: string, className?: string) => (
    <Input
      className={className}
      value={apps[index][field]}
      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
        setApps((prev) => patchAt(prev, index, { [field]: e.target.value }))
      }
      onBlur={() => commit(apps)}
      onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e.stopPropagation()}
      placeholder={placeholder}
      bgClassName="bg-surface"
    />
  );

  const pickExecutable = async () => {
    const selected = await openDialog({
      multiple: false,
      filters:
        osPlatform === 'windows' ? [{ name: t('settings.processing.editIn.executable'), extensions: ['exe'] }] : [],
    });
    return typeof selected === 'string' ? selected : null;
  };

  const handleAdd = async () => {
    const path = await pickExecutable();
    if (!path) return;
    const name = (path.split(/[\\/]/).pop() ?? path).replace(/\.(exe|app)$/i, '');
    commit([...apps, { name, path, args: '', mode: EditInMode.Original }]);
  };

  const handleBrowse = async (index: number) => {
    const path = await pickExecutable();
    if (path) commit(patchAt(apps, index, { path }));
  };

  return (
    <div className="space-y-4">
      <Text variant={TextVariants.small}>{t('settings.processing.editIn.description')}</Text>
      {apps.map((app, index) => (
        <div key={index} className="p-4 bg-bg-primary rounded-lg border border-border-color space-y-3">
          <div className="flex items-center gap-2">
            {renderField(index, 'name', t('settings.processing.editIn.name'), 'grow')}
            <Dropdown
              className="w-56"
              onChange={(mode: EditInMode) => commit(patchAt(apps, index, { mode }))}
              options={modeOptions}
              value={app.mode}
              triggerClassName="bg-surface"
            />
            <button
              onClick={() => commit(apps.filter((_, i) => i !== index))}
              className="p-2 text-text-secondary hover:text-red-400 hover:bg-surface rounded-md transition-colors"
              data-tooltip={t('settings.processing.editIn.remove')}
            >
              <Trash2 size={18} />
            </button>
          </div>
          <div className="flex items-center gap-2">
            {renderField(index, 'path', t('settings.processing.editIn.path'), 'grow')}
            <button
              onClick={() => handleBrowse(index)}
              className="p-2 text-text-secondary hover:text-text-primary hover:bg-surface rounded-md transition-colors"
              data-tooltip={t('settings.processing.editIn.browse')}
            >
              <FolderOpen size={18} />
            </button>
          </div>
          {renderField(index, 'args', t('settings.processing.editIn.args'))}
        </div>
      ))}
      <Button onClick={handleAdd}>
        <Plus size={16} />
        {t('settings.processing.editIn.add')}
      </Button>
    </div>
  );
}
