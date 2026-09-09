import { memo, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { CONTROL_SPECS, type Controls } from './types';
export default memo(function AutoControls({
  value,
  disabled,
  onChange,
}: {
  value: Controls;
  disabled: boolean;
  onChange: (value: Controls) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="grid gap-2">
      {CONTROL_SPECS.map(({ key, min, max, step }) => (
        <div key={key} className="grid grid-cols-[8rem_1fr_2.5rem] items-center gap-2">
          <label htmlFor={`${id}-${key}`}>{t(`sceneAuto.controls.${key}`)}</label>
          <input
            id={`${id}-${key}`}
            type="range"
            min={min}
            max={max}
            step={step}
            value={value[key]}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, [key]: Number(e.target.value) })}
            className="w-full accent-current"
          />
          <output htmlFor={`${id}-${key}`} className="text-right tabular-nums">
            {Math.round(value[key] * 100)}
          </output>
        </div>
      ))}
    </div>
  );
});
