import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';

import { useEditorStore } from '../../../store/useEditorStore';
import { useEditorActions } from '../../../hooks/useEditorActions';
import { FilmSimulationSettings } from '../../../utils/adjustments';
import CollapsibleSection from '../../ui/CollapsibleSection';
import Dropdown from '../../ui/Dropdown';
import Slider from '../../ui/Slider';
import Switch from '../../ui/Switch';
import Text from '../../ui/Text';
import { TextVariants } from '../../../types/typography';

interface ProfileEntry {
  name: string;
  label: string;
  kind: string;
  targetPrint?: string;
  target_print?: string;
}

// ── Parameter field descriptors ──────────────────────────────────────
// `path` is the dotted RuntimeParams path (snake_case), merged into
// filmSimulation.params and applied on top of spektrafilm defaults.
// `as const` keeps every id/path a literal type so i18n keys type-check.

const SECTIONS = [
  {
    id: 'exposure',
    fields: [
      { kind: 'bool', path: 'camera.auto_exposure', defaultValue: true },
      { kind: 'num', path: 'camera.exposure_compensation_ev', min: -5, max: 5, step: 0.1, defaultValue: 0 },
      { kind: 'bool', path: 'enlarger.print_exposure_compensation', defaultValue: true },
      { kind: 'num', path: 'enlarger.print_exposure', min: 0.05, max: 8, step: 0.02, defaultValue: 1 },
    ],
  },
  {
    id: 'development',
    fields: [
      { kind: 'num', path: 'film_render.density_curve_gamma', min: 0.3, max: 2, step: 0.05, defaultValue: 1 },
      { kind: 'bool', path: 'film_render.dir_couplers.active', defaultValue: true },
      { kind: 'num', path: 'film_render.dir_couplers.amount', min: 0, max: 3, step: 0.05, defaultValue: 1 },
      { kind: 'num', path: 'film_render.dir_couplers.inhibition_samelayer', min: 0, max: 3, step: 0.05, defaultValue: 1 },
      { kind: 'num', path: 'film_render.dir_couplers.inhibition_interlayer', min: 0, max: 3, step: 0.05, defaultValue: 1 },
      { kind: 'num', path: 'film_render.dir_couplers.diffusion_size_um', min: 0, max: 60, step: 1, defaultValue: 20 },
    ],
  },
  {
    id: 'halation',
    fields: [
      { kind: 'bool', path: 'film_render.halation.active', defaultValue: true },
      { kind: 'num', path: 'film_render.halation.scatter_amount', min: 0, max: 3, step: 0.05, defaultValue: 1 },
      { kind: 'num', path: 'film_render.halation.scatter_spatial_scale', min: 0, max: 4, step: 0.1, defaultValue: 1 },
      { kind: 'num', path: 'film_render.halation.halation_amount', min: 0, max: 3, step: 0.05, defaultValue: 1 },
      { kind: 'num', path: 'film_render.halation.halation_spatial_scale', min: 0, max: 4, step: 0.1, defaultValue: 1 },
      { kind: 'num', path: 'film_render.halation.boost_ev', min: 0, max: 4, step: 0.25, defaultValue: 0 },
    ],
  },
  {
    id: 'grain',
    fields: [
      { kind: 'bool', path: 'film_render.grain.active', defaultValue: true },
      { kind: 'bool', path: 'film_render.grain.sublayers_active', defaultValue: true },
      { kind: 'num', path: 'film_render.grain.particle_area_um2', min: 0.05, max: 2, step: 0.05, defaultValue: 0.2 },
      { kind: 'num', path: 'film_render.grain.blur', min: 0, max: 2, step: 0.05, defaultValue: 0.65 },
    ],
  },
  {
    id: 'diffusion',
    fields: [
      { kind: 'bool', path: 'camera.diffusion_filter.active', defaultValue: false },
      {
        kind: 'choice',
        path: 'camera.diffusion_filter.filter_family',
        options: [
          { value: 'black_pro_mist', label: 'Black Pro-Mist' },
          { value: 'pro_mist', label: 'Pro-Mist' },
          { value: 'glimmerglass', label: 'GlimmerGlass' },
          { value: 'cinebloom', label: 'Cinebloom' },
        ],
        defaultValue: 'black_pro_mist',
      },
      { kind: 'num', path: 'camera.diffusion_filter.strength', min: 0, max: 2, step: 0.125, defaultValue: 0.5 },
      { kind: 'num', path: 'camera.diffusion_filter.halo_warmth', min: -1.5, max: 1.5, step: 0.05, defaultValue: 0 },
      { kind: 'bool', path: 'enlarger.diffusion_filter.active', defaultValue: false },
      { kind: 'num', path: 'enlarger.diffusion_filter.strength', min: 0, max: 2, step: 0.125, defaultValue: 0.5 },
    ],
  },
  {
    id: 'enlarger',
    fields: [
      { kind: 'num', path: 'enlarger.y_filter_shift', min: -200, max: 200, step: 1, defaultValue: 0 },
      { kind: 'num', path: 'enlarger.m_filter_shift', min: -200, max: 200, step: 1, defaultValue: 0 },
      { kind: 'num', path: 'enlarger.preflash_exposure', min: 0, max: 2, step: 0.01, defaultValue: 0 },
    ],
  },
  {
    id: 'printChemistry',
    fields: [
      { kind: 'bool', path: 'print_render.density_curves_morph.active', defaultValue: false },
      { kind: 'num', path: 'print_render.density_curves_morph.gamma_factor', min: 0.5, max: 2, step: 0.05, defaultValue: 1 },
      { kind: 'num', path: 'print_render.density_curves_morph.developer_exhaustion', min: 0, max: 1, step: 0.02, defaultValue: 0 },
      { kind: 'bool', path: 'print_render.glare.active', defaultValue: true },
      { kind: 'num', path: 'print_render.glare.percent', min: 0, max: 0.5, step: 0.01, defaultValue: 0.03 },
    ],
  },
  {
    id: 'scanner',
    fields: [
      { kind: 'bool', path: 'io.scan_film', defaultValue: false },
      { kind: 'bool', path: 'scanner.white_correction', defaultValue: false },
      { kind: 'num', path: 'scanner.white_level', min: 0, max: 1, step: 0.005, defaultValue: 0.98 },
      { kind: 'bool', path: 'scanner.black_correction', defaultValue: false },
      { kind: 'num', path: 'scanner.black_level', min: 0, max: 1, step: 0.005, defaultValue: 0.01 },
    ],
  },
  {
    id: 'colorManagement',
    fields: [
      { kind: 'bool', path: 'io.input_gamut_compress.active', defaultValue: true },
      {
        kind: 'choice',
        path: 'io.output_gamut_compress.algorithm',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'cam16ucs', label: 'CAM16-UCS' },
          { value: 'oklch', label: 'Oklch' },
          { value: 'oklrab', label: 'Oklrab' },
          { value: 'aces_rgc', label: 'ACES RGC' },
        ],
        defaultValue: 'cam16ucs',
      },
      {
        kind: 'choice',
        path: 'settings.rgb_to_raw_method',
        options: [
          { value: 'hanatos2025', label: 'Hanatos 2025 (spectral)' },
          { value: 'mallett2019', label: 'Mallett 2019 (fast)' },
        ],
        defaultValue: 'hanatos2025',
      },
    ],
  },
] as const;

type Field = (typeof SECTIONS)[number]['fields'][number];

// ── helpers ──────────────────────────────────────────────────────────

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const keys = path.split('.');
  const root = { ...obj };
  let cursor = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const next = { ...((cursor[keys[i]] as Record<string, unknown> | undefined) ?? {}) };
    cursor[keys[i]] = next;
    cursor = next;
  }
  cursor[keys[keys.length - 1]] = value;
  return root;
}

export default function FilmPanel() {
  const { t } = useTranslation();
  const adjustments = useEditorStore((s) => s.adjustments);
  const selectedImage = useEditorStore((s) => s.selectedImage);
  const { setAdjustments } = useEditorActions();

  const [films, setFilms] = useState<ProfileEntry[]>([]);
  const [papers, setPapers] = useState<ProfileEntry[]>([]);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({ exposure: true });

  useEffect(() => {
    invoke<{ films: ProfileEntry[]; papers: ProfileEntry[] }>('list_film_profiles')
      .then((r) => {
        setFilms(r.films);
        setPapers(r.papers);
      })
      .catch((e) => console.error('list_film_profiles failed:', e));
  }, []);

  const fs: FilmSimulationSettings = adjustments.filmSimulation;

  const update = useCallback(
    (patch: Partial<FilmSimulationSettings>) => {
      setAdjustments((prev) => ({
        ...prev,
        filmSimulation: { ...prev.filmSimulation, ...patch },
      }));
    },
    [setAdjustments],
  );

  const updateParam = useCallback(
    (path: string, value: unknown) => {
      setAdjustments((prev) => ({
        ...prev,
        filmSimulation: {
          ...prev.filmSimulation,
          params: setPath(prev.filmSimulation.params ?? {}, path, value),
        },
      }));
    },
    [setAdjustments],
  );

  const filmOptions = useMemo(
    () => films.map((f) => ({ value: f.name, label: f.label })),
    [films],
  );
  const paperOptions = useMemo(
    () => [
      { value: '', label: t('editor.film.autoPaper') },
      ...papers.map((p) => ({ value: p.name, label: p.label })),
    ],
    [papers, t],
  );

  if (!selectedImage) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <Text variant={TextVariants.label} className="text-center text-text-secondary">
          {t('editor.ai.noImageSelected')}
        </Text>
      </div>
    );
  }

  const fieldValue = (f: Field) => {
    const v = getPath(fs.params ?? {}, f.path);
    return v === undefined ? f.defaultValue : v;
  };

  return (
    <div className="flex flex-col h-full">
      <div className="grow overflow-y-scroll p-3 flex flex-col gap-3">
        <Switch
          checked={fs.enabled}
          label={t('editor.film.enable')}
          onChange={(v) => update({ enabled: v })}
        />

        <div className={clsx('flex flex-col gap-3', !fs.enabled && 'opacity-50 pointer-events-none')}>
          <div className="flex flex-col gap-1.5">
            <Text variant={TextVariants.label}>{t('editor.film.filmStock')}</Text>
            <Dropdown
              options={filmOptions}
              value={fs.filmStock}
              onChange={(v) => update({ filmStock: v })}
              searchPlaceholder={t('editor.film.searchStock')}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Text variant={TextVariants.label}>{t('editor.film.printPaper')}</Text>
            <Dropdown
              options={paperOptions}
              value={fs.printPaper}
              onChange={(v) => update({ printPaper: v })}
              searchPlaceholder={t('editor.film.searchPaper')}
            />
          </div>

          {SECTIONS.map((section) => (
            <CollapsibleSection
              key={section.id}
              title={t(`editor.film.sections.${section.id}`)}
              isOpen={!!openSections[section.id]}
              isContentVisible={true}
              canToggleVisibility={false}
              onToggle={() =>
                setOpenSections((prev) => ({ ...prev, [section.id]: !prev[section.id] }))
              }
            >
              <div className="flex flex-col gap-2.5 pt-1">
                {section.fields.map((f) => {
                  if (f.kind === 'bool') {
                    return (
                      <Switch
                        key={f.path}
                        checked={!!fieldValue(f)}
                        label={t(`editor.film.fields.${f.path}`)}
                        onChange={(v) => updateParam(f.path, v)}
                      />
                    );
                  }
                  if (f.kind === 'choice') {
                    return (
                      <div key={f.path} className="flex flex-col gap-1.5">
                        <Text variant={TextVariants.label}>{t(`editor.film.fields.${f.path}`)}</Text>
                        <Dropdown
                          options={f.options.map((o) => ({ value: o.value, label: o.label }))}
                          value={String(fieldValue(f))}
                          onChange={(v) => updateParam(f.path, v)}
                        />
                      </div>
                    );
                  }
                  return (
                    <Slider
                      key={f.path}
                      label={t(`editor.film.fields.${f.path}`)}
                      min={f.min}
                      max={f.max}
                      step={f.step}
                      value={Number(fieldValue(f))}
                      onChange={(e) => updateParam(f.path, parseFloat((e as { target: { value: string } }).target.value))}
                    />
                  );
                })}
              </div>
            </CollapsibleSection>
          ))}
        </div>
      </div>
    </div>
  );
}
