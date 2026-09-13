import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import Switch from '../components/ui/Switch';
import { ADVANCED_ADJUSTMENTS, PRIMARY_ADJUSTMENTS, type AutoAdjustmentFamilies } from './types';

type FamilyKey = keyof AutoAdjustmentFamilies;
const FAMILY_TRANSLATION_KEYS: Record<FamilyKey, string> = {
  tone: 'modals.copyPaste.groups.tone',
  whiteBalance: 'modals.copyPaste.groups.whiteBalance',
  curves: 'modals.copyPaste.groups.curves',
  presence: 'modals.copyPaste.groups.presence',
  color: 'editor.adjustments.sections.color',
  colorGrading: 'modals.copyPaste.groups.colorGrading',
  colorMixer: 'modals.copyPaste.groups.colorMixer',
};

function FamilyToggle({
  family,
  value,
  disabled,
  onChange,
}: {
  family: FamilyKey;
  value: AutoAdjustmentFamilies;
  disabled: boolean;
  onChange: (value: AutoAdjustmentFamilies) => void;
}) {
  const { t } = useTranslation();
  const label = t(FAMILY_TRANSLATION_KEYS[family]);

  return (
    <Switch
      checked={value[family]}
      className="min-h-9 gap-2 py-1"
      disabled={disabled}
      label={label}
      onChange={(checked) => onChange({ ...value, [family]: checked })}
    />
  );
}

export default memo(function AutoAdjustmentPicker({
  value,
  disabled,
  onChange,
}: {
  value: AutoAdjustmentFamilies;
  disabled: boolean;
  onChange: (value: AutoAdjustmentFamilies) => void;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <div className="grid grid-cols-2 gap-x-3">
        {PRIMARY_ADJUSTMENTS.map((family) => (
          <FamilyToggle key={family} family={family} value={value} disabled={disabled} onChange={onChange} />
        ))}
      </div>
      <details>
        <summary className="cursor-pointer py-1.5 text-text-secondary">{t('export.sections.advanced')}</summary>
        <div className="grid grid-cols-2 gap-x-3">
          {ADVANCED_ADJUSTMENTS.map((family) => (
            <FamilyToggle key={family} family={family} value={value} disabled={disabled} onChange={onChange} />
          ))}
        </div>
      </details>
    </div>
  );
});
