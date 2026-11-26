import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Dropdown from './Dropdown';
import { FontWeight, loadFontWeights, loadSystemFonts } from '../../utils/fonts';

const SYSTEM_FONT = 'system-ui';
const FAVOURITES = [
  'Inter',
  'Arial',
  'Helvetica',
  'Georgia',
  'Times New Roman',
  'Courier New',
  'Verdana',
  'Impact',
  'Montserrat',
  'Roboto',
];

const useSystemFonts = () => {
  const [fonts, setFonts] = useState<Array<string> | null>(null);
  useEffect(() => {
    let active = true;
    loadSystemFonts().then((list) => active && setFonts(list));
    return () => {
      active = false;
    };
  }, []);
  return fonts;
};

export const useFontWeights = (family: string | null) => {
  const [weights, setWeights] = useState<Array<FontWeight> | null>(null);
  useEffect(() => {
    let active = true;
    loadFontWeights(family).then((loaded) => active && setWeights(loaded));
    return () => {
      active = false;
    };
  }, [family]);
  return weights;
};

interface FontPickerProps {
  value: string | null;
  onChange(font: string | null): void;
  systemOption?: boolean;
  className?: string;
}

export default function FontPicker({
  value,
  onChange,
  systemOption = true,
  className = 'w-full max-w-44',
}: FontPickerProps) {
  const { t } = useTranslation();
  const fonts = useSystemFonts();
  const options = useMemo(() => {
    const installed = fonts ?? [];
    const known = new Map(installed.map((family) => [family.toLowerCase(), family]));
    const favourites = FAVOURITES.flatMap((family) =>
      installed.length === 0 ? [family] : (known.get(family.toLowerCase()) ?? []),
    );
    const shown = new Set([...favourites, SYSTEM_FONT].map((family) => family.toLowerCase()));
    const current = value && !shown.has(value.toLowerCase()) && !known.has(value.toLowerCase()) ? [value] : [];
    const families = [...favourites, ...current, ...installed.filter((family) => !shown.has(family.toLowerCase()))];
    return [
      { value: '', label: t('ui.fontPicker.default') },
      ...(systemOption ? [{ value: SYSTEM_FONT, label: t('ui.fontPicker.system') }] : []),
      ...families.map((family) => ({ value: family, label: family })),
    ];
  }, [fonts, value, systemOption, t]);

  return (
    <Dropdown<string>
      className={className}
      searchable
      searchPlaceholder={t('ui.fontPicker.search')}
      options={options}
      value={value ?? ''}
      onChange={(font) => onChange(font || null)}
    />
  );
}
