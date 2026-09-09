import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import AutoControls from './AutoControls';
import { SCENES, type AutoOptions, type LightingGroup, type Scene } from './types';
export default memo(function AutoGroups({
  groups,
  options,
  disabled,
  onChange,
}: {
  groups: LightingGroup[];
  options: AutoOptions;
  disabled: boolean;
  onChange: (options: AutoOptions) => void;
}) {
  const { t } = useTranslation();
  return (
    <details>
      <summary className="cursor-pointer py-2">{t('sceneAuto.groups', { count: groups.length })}</summary>
      <div className="grid gap-3">
        {groups.map((group, index) => {
          const override = options.groups[group.id] || {};
          const update = (value: typeof override) =>
            onChange({ ...options, groups: { ...options.groups, [group.id]: { ...override, ...value } } });
          return (
            <details key={group.id}>
              <summary className="cursor-pointer py-1">
                {t('sceneAuto.group', {
                  index: index + 1,
                  count: group.paths.length,
                  scene: t(`sceneAuto.scenes.${override.scene || group.scene}`),
                })}
              </summary>
              <div className="grid gap-2 py-2">
                <label className="flex items-center justify-between gap-2">
                  {t('sceneAuto.lighting')}
                  <select
                    disabled={disabled}
                    value={override.scene || ''}
                    className="bg-surface rounded p-1"
                    onChange={(e) => update({ scene: (e.target.value || undefined) as Scene | undefined })}
                  >
                    <option value="">{t('sceneAuto.detected')}</option>
                    {SCENES.map((scene) => (
                      <option key={scene} value={scene}>
                        {t(`sceneAuto.scenes.${scene}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center justify-between gap-2">
                  {t('sceneAuto.reference')}
                  <select
                    disabled={disabled}
                    value={override.referencePath || ''}
                    className="bg-surface rounded p-1 max-w-48"
                    onChange={(e) => update({ referencePath: e.target.value || undefined })}
                  >
                    <option value="">{t('sceneAuto.automatic')}</option>
                    {group.paths.map((path) => (
                      <option key={path} value={path}>
                        {path.split(/[\\/]/).pop()}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex gap-2 items-center">
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={!!override.controls}
                    onChange={(e) => update({ controls: e.target.checked ? { ...options.controls } : undefined })}
                  />
                  {t('sceneAuto.overrideControls')}
                </label>
                {override.controls ? (
                  <AutoControls
                    value={override.controls}
                    disabled={disabled}
                    onChange={(controls) => update({ controls })}
                  />
                ) : null}
              </div>
            </details>
          );
        })}
      </div>
    </details>
  );
});
