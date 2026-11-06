import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { RotateCcw } from 'lucide-react';

import { useEditorStore } from '../../../store/useEditorStore';
import { useEditorActions } from '../../../hooks/useEditorActions';
import { FilmSimulationSettings } from '../../../utils/adjustments';
import CollapsibleSection from '../../ui/CollapsibleSection';
import Dropdown from '../../ui/Dropdown';
import Slider, { SliderChangeEvent } from '../../ui/Slider';
import Switch from '../../ui/Switch';
import Text from '../../ui/Text';
import { TextVariants, TextWeights } from '../../../types/typography';

interface ProfileEntry {
  name: string;
  label: string;
  kind: string;
  channel_model?: string;
  development_times?: number[];
  target_print?: string;
}

// ── Parameter field descriptors ──────────────────────────────────────
// `path` is the dotted RuntimeParams path (snake_case), deep-merged into
// filmSimulation.params on top of the spektrafilm defaults. A Rust-side
// unit test (film_render.rs::tests) asserts every path used here exists
// in `RuntimeParams::default()`, so a typo fails CI instead of silently
// doing nothing (serde ignores unknown keys during the merge).
//
// Organized after the upstream spektrafilm GUI: MAIN / FILM / PRINT /
// ADVANCED / CONFIG tabs.

interface FieldContext {
  /** Development-time family of the selected film (minutes; empty = color). */
  filmDevTimes: readonly number[];
  /** Development-time family of the effective print paper. */
  paperDevTimes: readonly number[];
}

type TabId = 'main' | 'film' | 'print' | 'advanced' | 'config';

type SectionId =
  | 'exposure'
  | 'workflow'
  | 'cameraAdvanced'
  | 'cameraDiffusion'
  | 'development'
  | 'halation'
  | 'grain'
  | 'filmGlare'
  | 'enlarger'
  | 'enlargerDiffusion'
  | 'printDevelopment'
  | 'printGlare'
  | 'scanner'
  | 'dirCouplersAdvanced'
  | 'halationAdvanced'
  | 'grainAdvanced'
  | 'diffusionAdvanced'
  | 'colorManagement'
  | 'spectral'
  | 'engine';

/** Dotted field paths as they exist under editor.film.fields in en.json —
 *  keeps t() calls type-safe while descriptors stay loosely typed. */
type FilmFieldKey =
  `editor.film.fields.${keyof (typeof import('../../../i18n/locales/en.json'))['editor']['film']['fields']}`;

interface BaseField {
  path: string;
  /** Grey the control out while the boolean param at this path resolves false. */
  enabledWhenPath?: string;
  /** Hide the control entirely unless the predicate passes. */
  visibleWhen?: (ctx: FieldContext) => boolean;
}

interface BoolField extends BaseField {
  kind: 'bool';
  defaultValue: boolean;
}

interface NumField extends BaseField {
  kind: 'num';
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  integer?: boolean;
  suffix?: string;
}

interface ChoiceField extends BaseField {
  kind: 'choice';
  options: readonly { value: string; label: string }[];
  defaultValue: string;
}

interface VecComponent {
  label: string;
  min: number;
  max: number;
  step: number;
}

interface VecField extends BaseField {
  kind: 'vec';
  components: readonly VecComponent[];
  defaultValue: readonly number[];
}

interface OptionalNumField extends BaseField {
  kind: 'optionalNum';
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  suffix?: string;
  /** Dynamic range override (e.g. B&W development-time families). */
  range?: (ctx: FieldContext) => { min: number; max: number } | undefined;
}

type Field = BoolField | NumField | ChoiceField | VecField | OptionalNumField;

interface SectionDef {
  id: SectionId;
  fields: readonly Field[];
}

interface TabDef {
  id: TabId;
  sections: readonly SectionDef[];
}

// ── shared option lists ──────────────────────────────────────────────

const METERING_OPTIONS = [
  { value: 'average', label: 'Average' },
  { value: 'median', label: 'Median' },
  { value: 'center_weighted', label: 'Center-weighted' },
  { value: 'partial', label: 'Partial' },
  { value: 'matrix', label: 'Matrix' },
  { value: 'multi_zone', label: 'Multi-zone' },
  { value: 'highlight_weighted', label: 'Highlight-weighted' },
] as const;

const DIFFUSION_FAMILY_OPTIONS = [
  { value: 'black_pro_mist', label: 'Black Pro-Mist' },
  { value: 'pro_mist', label: 'Pro-Mist' },
  { value: 'glimmerglass', label: 'GlimmerGlass' },
  { value: 'cinebloom', label: 'Cinebloom' },
] as const;

const ENLARGER_ILLUMINANT_OPTIONS = [
  { value: 'TH-KG3', label: 'TH-KG3 (tungsten-halogen)' },
  { value: 'D50', label: 'D50' },
  { value: 'D55', label: 'D55' },
  { value: 'D65', label: 'D65' },
] as const;

const INPUT_GAMUT_OPTIONS = [
  { value: 'xy', label: 'xy (spectral locus)' },
  { value: 'off', label: 'Off' },
] as const;

const OUTPUT_GAMUT_OPTIONS = [
  { value: 'cam16ucs', label: 'CAM16-UCS' },
  { value: 'oklch', label: 'Oklch' },
  { value: 'oklrab', label: 'Oklrab' },
  { value: 'aces_rgc', label: 'ACES RGC' },
  { value: 'off', label: 'Off' },
] as const;

const RGB_TO_RAW_OPTIONS = [
  { value: 'hanatos2025', label: 'Hanatos 2025 (spectral)' },
  { value: 'mallett2019', label: 'Mallett 2019 (fast)' },
] as const;

// ── component-label helpers ──────────────────────────────────────────

const rgb = (min: number, max: number, step: number): readonly VecComponent[] => [
  { label: 'R', min, max, step },
  { label: 'G', min, max, step },
  { label: 'B', min, max, step },
];

const KNEE_COMPONENTS: readonly VecComponent[] = [
  { label: 'thr', min: 0, max: 0.99, step: 0.01 },
  { label: 'lim', min: 0.5, max: 10, step: 0.1 },
  { label: 'pow', min: 0.5, max: 10, step: 0.1 },
];

/** The six fine-tuning sliders shared by both diffusion filters. */
const diffusionTuning = (prefix: string, enabledWhenPath: string): readonly NumField[] =>
  (['core_intensity', 'core_size', 'halo_intensity', 'halo_size', 'bloom_intensity', 'bloom_size'] as const).map(
    (name) => ({
      kind: 'num' as const,
      path: `${prefix}.${name}`,
      min: 0,
      max: 2,
      step: 0.05,
      defaultValue: 1,
      enabledWhenPath,
    }),
  );

// ── tabs ─────────────────────────────────────────────────────────────

const TABS: readonly TabDef[] = [
  {
    id: 'main',
    sections: [
      {
        id: 'exposure',
        fields: [
          { kind: 'bool', path: 'camera.auto_exposure', defaultValue: true },
          {
            kind: 'choice',
            path: 'camera.auto_exposure_method',
            options: METERING_OPTIONS,
            defaultValue: 'center_weighted',
            enabledWhenPath: 'camera.auto_exposure',
          },
          {
            kind: 'num',
            path: 'camera.exposure_compensation_ev',
            min: -5,
            max: 5,
            step: 0.1,
            defaultValue: 0,
            suffix: 'EV',
          },
          { kind: 'bool', path: 'enlarger.print_exposure_compensation', defaultValue: true },
          { kind: 'bool', path: 'enlarger.normalize_print_exposure', defaultValue: true },
          { kind: 'num', path: 'enlarger.print_exposure', min: 0.05, max: 8, step: 0.02, defaultValue: 1 },
        ],
      },
      {
        id: 'workflow',
        fields: [{ kind: 'bool', path: 'io.scan_film', defaultValue: false }],
      },
    ],
  },
  {
    id: 'film',
    sections: [
      {
        id: 'cameraDiffusion',
        fields: [
          { kind: 'bool', path: 'camera.diffusion_filter.active', defaultValue: false },
          {
            kind: 'choice',
            path: 'camera.diffusion_filter.filter_family',
            options: DIFFUSION_FAMILY_OPTIONS,
            defaultValue: 'black_pro_mist',
            enabledWhenPath: 'camera.diffusion_filter.active',
          },
          {
            kind: 'num',
            path: 'camera.diffusion_filter.strength',
            min: 0,
            max: 2,
            step: 0.125,
            defaultValue: 0.5,
            enabledWhenPath: 'camera.diffusion_filter.active',
          },
          {
            kind: 'num',
            path: 'camera.diffusion_filter.spatial_scale',
            min: 0.25,
            max: 4,
            step: 0.05,
            defaultValue: 1,
            enabledWhenPath: 'camera.diffusion_filter.active',
          },
          {
            kind: 'num',
            path: 'camera.diffusion_filter.halo_warmth',
            min: -1.5,
            max: 1.5,
            step: 0.05,
            defaultValue: 0,
            enabledWhenPath: 'camera.diffusion_filter.active',
          },
        ],
      },
      {
        id: 'development',
        fields: [
          { kind: 'num', path: 'film_render.density_curve_gamma', min: 0.3, max: 2, step: 0.05, defaultValue: 1 },
          {
            kind: 'optionalNum',
            path: 'film_render.development_time',
            min: 1,
            max: 20,
            step: 0.25,
            defaultValue: 6.5,
            suffix: 'min',
            visibleWhen: (ctx) => ctx.filmDevTimes.length > 1,
            range: (ctx) =>
              ctx.filmDevTimes.length > 1
                ? { min: Math.min(...ctx.filmDevTimes), max: Math.max(...ctx.filmDevTimes) }
                : undefined,
          },
          { kind: 'bool', path: 'film_render.dir_couplers.active', defaultValue: true },
          {
            kind: 'num',
            path: 'film_render.dir_couplers.amount',
            min: 0,
            max: 3,
            step: 0.05,
            defaultValue: 1,
            enabledWhenPath: 'film_render.dir_couplers.active',
          },
          {
            kind: 'num',
            path: 'film_render.dir_couplers.inhibition_samelayer',
            min: 0,
            max: 3,
            step: 0.05,
            defaultValue: 1,
            enabledWhenPath: 'film_render.dir_couplers.active',
          },
          {
            kind: 'num',
            path: 'film_render.dir_couplers.inhibition_interlayer',
            min: 0,
            max: 3,
            step: 0.05,
            defaultValue: 1,
            enabledWhenPath: 'film_render.dir_couplers.active',
          },
          {
            kind: 'num',
            path: 'film_render.dir_couplers.diffusion_size_um',
            min: 0,
            max: 60,
            step: 1,
            defaultValue: 20,
            suffix: 'µm',
            enabledWhenPath: 'film_render.dir_couplers.active',
          },
        ],
      },
      {
        id: 'halation',
        fields: [
          { kind: 'bool', path: 'film_render.halation.active', defaultValue: true },
          {
            kind: 'num',
            path: 'film_render.halation.scatter_amount',
            min: 0,
            max: 3,
            step: 0.05,
            defaultValue: 1,
            enabledWhenPath: 'film_render.halation.active',
          },
          {
            kind: 'num',
            path: 'film_render.halation.scatter_spatial_scale',
            min: 0,
            max: 4,
            step: 0.1,
            defaultValue: 1,
            enabledWhenPath: 'film_render.halation.active',
          },
          {
            kind: 'num',
            path: 'film_render.halation.halation_amount',
            min: 0,
            max: 3,
            step: 0.05,
            defaultValue: 1,
            enabledWhenPath: 'film_render.halation.active',
          },
          {
            kind: 'num',
            path: 'film_render.halation.halation_spatial_scale',
            min: 0,
            max: 4,
            step: 0.1,
            defaultValue: 1,
            enabledWhenPath: 'film_render.halation.active',
          },
          {
            kind: 'num',
            path: 'film_render.halation.boost_ev',
            min: 0,
            max: 4,
            step: 0.25,
            defaultValue: 0,
            suffix: 'EV',
            enabledWhenPath: 'film_render.halation.active',
          },
        ],
      },
      {
        id: 'grain',
        fields: [
          { kind: 'bool', path: 'film_render.grain.active', defaultValue: true },
          {
            kind: 'bool',
            path: 'film_render.grain.sublayers_active',
            defaultValue: true,
            enabledWhenPath: 'film_render.grain.active',
          },
          {
            kind: 'num',
            path: 'film_render.grain.agx_particle_area_um2',
            min: 0.05,
            max: 2,
            step: 0.05,
            defaultValue: 0.2,
            suffix: 'µm²',
            enabledWhenPath: 'film_render.grain.active',
          },
          {
            kind: 'num',
            path: 'film_render.grain.blur',
            min: 0,
            max: 2,
            step: 0.05,
            defaultValue: 0.65,
            enabledWhenPath: 'film_render.grain.active',
          },
        ],
      },
      {
        id: 'filmGlare',
        fields: [
          { kind: 'bool', path: 'film_render.glare.active', defaultValue: true },
          {
            kind: 'num',
            path: 'film_render.glare.percent',
            min: 0,
            max: 0.5,
            step: 0.01,
            defaultValue: 0.03,
            enabledWhenPath: 'film_render.glare.active',
          },
          {
            kind: 'num',
            path: 'film_render.glare.roughness',
            min: 0,
            max: 1,
            step: 0.05,
            defaultValue: 0.7,
            enabledWhenPath: 'film_render.glare.active',
          },
          {
            kind: 'num',
            path: 'film_render.glare.blur',
            min: 0,
            max: 2,
            step: 0.05,
            defaultValue: 0.5,
            enabledWhenPath: 'film_render.glare.active',
          },
        ],
      },
    ],
  },
  {
    id: 'print',
    sections: [
      {
        id: 'enlarger',
        fields: [
          { kind: 'choice', path: 'enlarger.illuminant', options: ENLARGER_ILLUMINANT_OPTIONS, defaultValue: 'TH-KG3' },
          { kind: 'num', path: 'enlarger.y_filter_shift', min: -200, max: 200, step: 1, defaultValue: 0, suffix: 'CC' },
          { kind: 'num', path: 'enlarger.m_filter_shift', min: -200, max: 200, step: 1, defaultValue: 0, suffix: 'CC' },
          { kind: 'num', path: 'enlarger.preflash_exposure', min: 0, max: 2, step: 0.01, defaultValue: 0 },
          {
            kind: 'num',
            path: 'enlarger.preflash_y_filter_shift',
            min: -200,
            max: 200,
            step: 1,
            defaultValue: 0,
            suffix: 'CC',
          },
          {
            kind: 'num',
            path: 'enlarger.preflash_m_filter_shift',
            min: -200,
            max: 200,
            step: 1,
            defaultValue: 0,
            suffix: 'CC',
          },
          { kind: 'num', path: 'enlarger.lens_blur', min: 0, max: 10, step: 0.1, defaultValue: 0 },
        ],
      },
      {
        id: 'enlargerDiffusion',
        fields: [
          { kind: 'bool', path: 'enlarger.diffusion_filter.active', defaultValue: false },
          {
            kind: 'choice',
            path: 'enlarger.diffusion_filter.filter_family',
            options: DIFFUSION_FAMILY_OPTIONS,
            defaultValue: 'black_pro_mist',
            enabledWhenPath: 'enlarger.diffusion_filter.active',
          },
          {
            kind: 'num',
            path: 'enlarger.diffusion_filter.strength',
            min: 0,
            max: 2,
            step: 0.125,
            defaultValue: 0.5,
            enabledWhenPath: 'enlarger.diffusion_filter.active',
          },
          {
            kind: 'num',
            path: 'enlarger.diffusion_filter.spatial_scale',
            min: 0.25,
            max: 4,
            step: 0.05,
            defaultValue: 1,
            enabledWhenPath: 'enlarger.diffusion_filter.active',
          },
          {
            kind: 'num',
            path: 'enlarger.diffusion_filter.halo_warmth',
            min: -1.5,
            max: 1.5,
            step: 0.05,
            defaultValue: 0,
            enabledWhenPath: 'enlarger.diffusion_filter.active',
          },
        ],
      },
      {
        id: 'printDevelopment',
        fields: [
          { kind: 'num', path: 'print_render.density_curve_gamma', min: 0.3, max: 2, step: 0.05, defaultValue: 1 },
          {
            kind: 'optionalNum',
            path: 'print_render.development_time',
            min: 1,
            max: 20,
            step: 0.25,
            defaultValue: 5,
            suffix: 'min',
            visibleWhen: (ctx) => ctx.paperDevTimes.length > 1,
            range: (ctx) =>
              ctx.paperDevTimes.length > 1
                ? { min: Math.min(...ctx.paperDevTimes), max: Math.max(...ctx.paperDevTimes) }
                : undefined,
          },
          { kind: 'bool', path: 'print_render.density_curves_morph.active', defaultValue: false },
          {
            kind: 'num',
            path: 'print_render.density_curves_morph.gamma_factor',
            min: 0.5,
            max: 2,
            step: 0.05,
            defaultValue: 1,
            enabledWhenPath: 'print_render.density_curves_morph.active',
          },
          {
            kind: 'num',
            path: 'print_render.density_curves_morph.gamma_factor_fast',
            min: 0.5,
            max: 2,
            step: 0.05,
            defaultValue: 1,
            enabledWhenPath: 'print_render.density_curves_morph.active',
          },
          {
            kind: 'num',
            path: 'print_render.density_curves_morph.gamma_factor_slow',
            min: 0.5,
            max: 2,
            step: 0.05,
            defaultValue: 1,
            enabledWhenPath: 'print_render.density_curves_morph.active',
          },
          {
            kind: 'num',
            path: 'print_render.density_curves_morph.gamma_factor_red',
            min: 0.5,
            max: 2,
            step: 0.05,
            defaultValue: 1,
            enabledWhenPath: 'print_render.density_curves_morph.active',
          },
          {
            kind: 'num',
            path: 'print_render.density_curves_morph.gamma_factor_green',
            min: 0.5,
            max: 2,
            step: 0.05,
            defaultValue: 1,
            enabledWhenPath: 'print_render.density_curves_morph.active',
          },
          {
            kind: 'num',
            path: 'print_render.density_curves_morph.gamma_factor_blue',
            min: 0.5,
            max: 2,
            step: 0.05,
            defaultValue: 1,
            enabledWhenPath: 'print_render.density_curves_morph.active',
          },
          {
            kind: 'num',
            path: 'print_render.density_curves_morph.developer_exhaustion',
            min: 0,
            max: 1,
            step: 0.02,
            defaultValue: 0,
            enabledWhenPath: 'print_render.density_curves_morph.active',
          },
        ],
      },
      {
        id: 'printGlare',
        fields: [
          { kind: 'bool', path: 'print_render.glare.active', defaultValue: true },
          {
            kind: 'num',
            path: 'print_render.glare.percent',
            min: 0,
            max: 0.5,
            step: 0.01,
            defaultValue: 0.03,
            enabledWhenPath: 'print_render.glare.active',
          },
          {
            kind: 'num',
            path: 'print_render.glare.roughness',
            min: 0,
            max: 1,
            step: 0.05,
            defaultValue: 0.7,
            enabledWhenPath: 'print_render.glare.active',
          },
          {
            kind: 'num',
            path: 'print_render.glare.blur',
            min: 0,
            max: 2,
            step: 0.05,
            defaultValue: 0.5,
            enabledWhenPath: 'print_render.glare.active',
          },
        ],
      },
      {
        id: 'scanner',
        fields: [
          { kind: 'bool', path: 'scanner.white_correction', defaultValue: false },
          {
            kind: 'num',
            path: 'scanner.white_level',
            min: 0,
            max: 1,
            step: 0.005,
            defaultValue: 0.98,
            enabledWhenPath: 'scanner.white_correction',
          },
          { kind: 'bool', path: 'scanner.black_correction', defaultValue: false },
          {
            kind: 'num',
            path: 'scanner.black_level',
            min: 0,
            max: 1,
            step: 0.005,
            defaultValue: 0.01,
            enabledWhenPath: 'scanner.black_correction',
          },
          { kind: 'num', path: 'scanner.lens_blur', min: 0, max: 10, step: 0.1, defaultValue: 0 },
          {
            kind: 'vec',
            path: 'scanner.unsharp_mask',
            components: [
              { label: 'σ', min: 0, max: 3, step: 0.05 },
              { label: 'amt', min: 0, max: 3, step: 0.05 },
            ],
            defaultValue: [0.7, 0.7],
          },
        ],
      },
    ],
  },
  {
    id: 'advanced',
    sections: [
      {
        id: 'cameraAdvanced',
        fields: [
          { kind: 'num', path: 'camera.lens_blur_um', min: 0, max: 50, step: 0.5, defaultValue: 0, suffix: 'µm' },
          { kind: 'num', path: 'camera.film_format_mm', min: 8, max: 120, step: 1, defaultValue: 35, suffix: 'mm' },
          {
            kind: 'vec',
            path: 'camera.filter_uv',
            components: [
              { label: 'amt', min: 0, max: 1, step: 0.05 },
              { label: 'nm', min: 300, max: 500, step: 1 },
              { label: 'w', min: 1, max: 50, step: 1 },
            ],
            defaultValue: [0, 410, 8],
          },
          {
            kind: 'vec',
            path: 'camera.filter_ir',
            components: [
              { label: 'amt', min: 0, max: 1, step: 0.05 },
              { label: 'nm', min: 500, max: 800, step: 1 },
              { label: 'w', min: 1, max: 60, step: 1 },
            ],
            defaultValue: [0, 675, 15],
          },
        ],
      },
      {
        id: 'dirCouplersAdvanced',
        fields: [
          {
            kind: 'vec',
            path: 'film_render.dir_couplers.gamma_samelayer_rgb',
            components: rgb(0, 1, 0.001),
            defaultValue: [0.341, 0.324, 0.273],
            enabledWhenPath: 'film_render.dir_couplers.active',
          },
          {
            kind: 'vec',
            path: 'film_render.dir_couplers.gamma_interlayer_r_to_gb',
            components: [
              { label: '→G', min: 0, max: 1, step: 0.001 },
              { label: '→B', min: 0, max: 1, step: 0.001 },
            ],
            defaultValue: [0.355, 0.305],
            enabledWhenPath: 'film_render.dir_couplers.active',
          },
          {
            kind: 'vec',
            path: 'film_render.dir_couplers.gamma_interlayer_g_to_rb',
            components: [
              { label: '→R', min: 0, max: 1, step: 0.001 },
              { label: '→B', min: 0, max: 1, step: 0.001 },
            ],
            defaultValue: [0.154, 0.358],
            enabledWhenPath: 'film_render.dir_couplers.active',
          },
          {
            kind: 'vec',
            path: 'film_render.dir_couplers.gamma_interlayer_b_to_rg',
            components: [
              { label: '→R', min: 0, max: 1, step: 0.001 },
              { label: '→G', min: 0, max: 1, step: 0.001 },
            ],
            defaultValue: [0.171, 0.225],
            enabledWhenPath: 'film_render.dir_couplers.active',
          },
          {
            kind: 'num',
            path: 'film_render.dir_couplers.diffusion_tail_um',
            min: 0,
            max: 1000,
            step: 5,
            defaultValue: 200,
            suffix: 'µm',
            enabledWhenPath: 'film_render.dir_couplers.active',
          },
          {
            kind: 'num',
            path: 'film_render.dir_couplers.diffusion_tail_weight',
            min: 0,
            max: 1,
            step: 0.01,
            defaultValue: 0.06,
            enabledWhenPath: 'film_render.dir_couplers.active',
          },
        ],
      },
      {
        id: 'halationAdvanced',
        fields: [
          {
            kind: 'vec',
            path: 'film_render.halation.scatter_core_um',
            components: rgb(0, 20, 0.1),
            defaultValue: [2.2, 2.0, 1.6],
            enabledWhenPath: 'film_render.halation.active',
          },
          {
            kind: 'vec',
            path: 'film_render.halation.scatter_tail_um',
            components: rgb(0, 50, 0.1),
            defaultValue: [9.3, 9.7, 9.1],
            enabledWhenPath: 'film_render.halation.active',
          },
          {
            kind: 'vec',
            path: 'film_render.halation.scatter_tail_weight',
            components: rgb(0, 1, 0.01),
            defaultValue: [0.78, 0.65, 0.67],
            enabledWhenPath: 'film_render.halation.active',
          },
          {
            kind: 'num',
            path: 'film_render.halation.boost_range',
            min: 0,
            max: 1,
            step: 0.05,
            defaultValue: 0.3,
            enabledWhenPath: 'film_render.halation.active',
          },
          {
            kind: 'num',
            path: 'film_render.halation.protect_ev',
            min: 0,
            max: 10,
            step: 0.1,
            defaultValue: 4,
            suffix: 'EV',
            enabledWhenPath: 'film_render.halation.active',
          },
          {
            kind: 'vec',
            path: 'film_render.halation.halation_strength',
            components: rgb(0, 0.5, 0.005),
            defaultValue: [0.05, 0.015, 0.0],
            enabledWhenPath: 'film_render.halation.active',
          },
          {
            kind: 'vec',
            path: 'film_render.halation.halation_first_sigma_um',
            components: rgb(1, 200, 1),
            defaultValue: [65, 65, 65],
            enabledWhenPath: 'film_render.halation.active',
          },
          {
            kind: 'num',
            path: 'film_render.halation.halation_n_bounces',
            min: 1,
            max: 6,
            step: 1,
            defaultValue: 3,
            integer: true,
            enabledWhenPath: 'film_render.halation.active',
          },
          {
            kind: 'num',
            path: 'film_render.halation.halation_bounce_decay',
            min: 0,
            max: 1,
            step: 0.05,
            defaultValue: 0.5,
            enabledWhenPath: 'film_render.halation.active',
          },
          {
            kind: 'bool',
            path: 'film_render.halation.halation_renormalize',
            defaultValue: true,
            enabledWhenPath: 'film_render.halation.active',
          },
        ],
      },
      {
        id: 'grainAdvanced',
        fields: [
          {
            kind: 'vec',
            path: 'film_render.grain.agx_particle_scale',
            components: rgb(0.1, 5, 0.05),
            defaultValue: [1.6, 1.6, 3.2],
            enabledWhenPath: 'film_render.grain.active',
          },
          {
            kind: 'vec',
            path: 'film_render.grain.agx_particle_scale_layers',
            components: rgb(0.1, 5, 0.05),
            defaultValue: [2.0, 1.0, 0.5],
            enabledWhenPath: 'film_render.grain.active',
          },
          {
            kind: 'vec',
            path: 'film_render.grain.density_min',
            components: rgb(0, 0.5, 0.005),
            defaultValue: [0.03, 0.03, 0.03],
            enabledWhenPath: 'film_render.grain.active',
          },
          {
            kind: 'vec',
            path: 'film_render.grain.uniformity',
            components: rgb(0, 1, 0.005),
            defaultValue: [0.97, 0.99, 0.97],
            enabledWhenPath: 'film_render.grain.active',
          },
          {
            kind: 'num',
            path: 'film_render.grain.blur_dye_clouds_um',
            min: 0,
            max: 10,
            step: 0.1,
            defaultValue: 1,
            suffix: 'µm',
            enabledWhenPath: 'film_render.grain.active',
          },
          {
            kind: 'vec',
            path: 'film_render.grain.micro_structure',
            components: [
              { label: 'amt', min: 0, max: 1, step: 0.01 },
              { label: 'µm', min: 1, max: 100, step: 1 },
            ],
            defaultValue: [0.2, 30],
            enabledWhenPath: 'film_render.grain.active',
          },
          {
            kind: 'num',
            path: 'film_render.grain.n_sub_layers',
            min: 1,
            max: 4,
            step: 1,
            defaultValue: 1,
            integer: true,
            enabledWhenPath: 'film_render.grain.active',
          },
        ],
      },
      {
        id: 'diffusionAdvanced',
        fields: [
          ...diffusionTuning('camera.diffusion_filter', 'camera.diffusion_filter.active'),
          ...diffusionTuning('enlarger.diffusion_filter', 'enlarger.diffusion_filter.active'),
        ],
      },
      {
        id: 'colorManagement',
        fields: [
          {
            kind: 'choice',
            path: 'io.input_gamut_compress.algorithm',
            options: INPUT_GAMUT_OPTIONS,
            defaultValue: 'xy',
          },
          {
            kind: 'vec',
            path: 'io.input_gamut_compress.knee',
            components: KNEE_COMPONENTS,
            defaultValue: [0, 1, 6],
          },
          {
            kind: 'choice',
            path: 'io.output_gamut_compress.algorithm',
            options: OUTPUT_GAMUT_OPTIONS,
            defaultValue: 'cam16ucs',
          },
          {
            kind: 'vec',
            path: 'io.output_gamut_compress.knee',
            components: KNEE_COMPONENTS,
            defaultValue: [0, 1, 6],
          },
          {
            kind: 'vec',
            path: 'io.output_gamut_compress.lightness_compression',
            components: [
              { label: 'thr', min: 0, max: 1, step: 0.05 },
              { label: 'lim', min: 0.5, max: 2, step: 0.05 },
              { label: 'pow', min: 0.5, max: 5, step: 0.1 },
            ],
            defaultValue: [0.7, 1.0, 2.2],
          },
        ],
      },
    ],
  },
  {
    id: 'config',
    sections: [
      {
        id: 'spectral',
        fields: [
          {
            kind: 'choice',
            path: 'settings.rgb_to_raw_method',
            options: RGB_TO_RAW_OPTIONS,
            defaultValue: 'hanatos2025',
          },
          { kind: 'bool', path: 'settings.use_cat16', defaultValue: true },
          { kind: 'bool', path: 'settings.apply_hanatos2025_adaptation_window', defaultValue: true },
          { kind: 'bool', path: 'settings.apply_hanatos2025_adaptation_surface', defaultValue: false },
          {
            kind: 'num',
            path: 'settings.spectral_gaussian_blur',
            min: 0,
            max: 10,
            step: 0.1,
            defaultValue: 0,
            suffix: 'nm',
          },
        ],
      },
      {
        id: 'engine',
        fields: [
          { kind: 'bool', path: 'settings.use_enlarger_lut', defaultValue: false },
          { kind: 'bool', path: 'settings.use_scanner_lut', defaultValue: false },
          { kind: 'num', path: 'settings.lut_resolution', min: 9, max: 65, step: 2, defaultValue: 17, integer: true },
          { kind: 'bool', path: 'settings.use_fast_stats', defaultValue: false },
          { kind: 'bool', path: 'settings.neutral_print_filters_from_database', defaultValue: true },
        ],
      },
    ],
  },
];

/** Default values of every boolean field, for `enabledWhenPath` resolution. */
const BOOL_DEFAULTS = new Map<string, boolean>();
for (const tab of TABS) {
  for (const section of tab.sections) {
    for (const f of section.fields) {
      if (f.kind === 'bool') {
        BOOL_DEFAULTS.set(f.path, f.defaultValue);
      }
    }
  }
}

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

/** Remove a dotted path and prune objects left empty (restores the
 *  spektrafilm default for the removed subtree). */
function deletePath(obj: Record<string, unknown>, path: string): Record<string, unknown> {
  const keys = path.split('.');
  const root: Record<string, unknown> = { ...obj };
  const nodes: Record<string, unknown>[] = [root];
  for (let i = 0; i < keys.length - 1; i++) {
    const next = { ...((nodes[i][keys[i]] as Record<string, unknown> | undefined) ?? {}) };
    nodes[i][keys[i]] = next;
    nodes.push(next);
  }
  delete nodes[nodes.length - 1][keys[keys.length - 1]];
  for (let i = keys.length - 1; i > 0; i--) {
    if (Object.keys(nodes[i]).length > 0) {
      break;
    }
    delete nodes[i - 1][keys[i - 1]];
  }
  return root;
}

const sliderValue = (e: SliderChangeEvent): number => Number(e.target.value);

export default function FilmPanel() {
  const { t } = useTranslation();
  const adjustments = useEditorStore((s) => s.adjustments);
  const selectedImage = useEditorStore((s) => s.selectedImage);
  const { setAdjustments } = useEditorActions();

  const [films, setFilms] = useState<ProfileEntry[]>([]);
  const [papers, setPapers] = useState<ProfileEntry[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>('main');
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    exposure: true,
  });

  useEffect(() => {
    invoke<{ films: ProfileEntry[]; papers: ProfileEntry[] }>('list_film_profiles')
      .then((r) => {
        setFilms(r.films);
        setPapers(r.papers);
      })
      .catch((e) => console.error('list_film_profiles failed:', e));
  }, []);

  const fs: FilmSimulationSettings = adjustments.filmSimulation;
  const params = (fs.params ?? {}) as Record<string, unknown>;

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

  const resetSection = useCallback(
    (section: SectionDef) => {
      setAdjustments((prev) => {
        let next = { ...(prev.filmSimulation.params ?? {}) };
        for (const f of section.fields) {
          next = deletePath(next, f.path);
        }
        return {
          ...prev,
          filmSimulation: { ...prev.filmSimulation, params: next },
        };
      });
    },
    [setAdjustments],
  );

  const fieldCtx: FieldContext = useMemo(() => {
    const film = films.find((f) => f.name === fs.filmStock);
    const paperName = fs.printPaper || film?.target_print || '';
    const paper = papers.find((p) => p.name === paperName);
    return {
      filmDevTimes: film?.development_times ?? [],
      paperDevTimes: paper?.development_times ?? [],
    };
  }, [films, papers, fs.filmStock, fs.printPaper]);

  const filmOptions = useMemo(() => films.map((f) => ({ value: f.name, label: f.label })), [films]);
  const paperOptions = useMemo(
    () => [{ value: '', label: t('editor.film.autoPaper') }, ...papers.map((p) => ({ value: p.name, label: p.label }))],
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

  const isFieldEnabled = (f: Field): boolean => {
    if (!f.enabledWhenPath) {
      return true;
    }
    const v = getPath(params, f.enabledWhenPath);
    return Boolean(v === undefined ? (BOOL_DEFAULTS.get(f.enabledWhenPath) ?? false) : v);
  };

  const sectionOverridden = (section: SectionDef): boolean =>
    section.fields.some((f) => {
      const v = getPath(params, f.path);
      return v !== undefined && v !== null;
    });

  const renderField = (f: Field) => {
    if (f.visibleWhen && !f.visibleWhen(fieldCtx)) {
      return null;
    }
    const disabled = !isFieldEnabled(f);
    const label = t(`editor.film.fields.${f.path}` as FilmFieldKey);

    switch (f.kind) {
      case 'bool': {
        const v = getPath(params, f.path);
        return (
          <Switch
            key={f.path}
            checked={v === undefined ? f.defaultValue : Boolean(v)}
            disabled={disabled}
            label={label}
            onChange={(nv) => updateParam(f.path, nv)}
          />
        );
      }
      case 'choice': {
        const v = getPath(params, f.path);
        return (
          <div key={f.path} className={clsx('flex flex-col gap-1.5', disabled && 'opacity-50 pointer-events-none')}>
            <Text variant={TextVariants.label}>{label}</Text>
            <Dropdown
              disabled={disabled}
              options={f.options.map((o) => ({ value: o.value, label: o.label }))}
              value={v === undefined ? f.defaultValue : String(v)}
              onChange={(nv) => updateParam(f.path, nv)}
            />
          </div>
        );
      }
      case 'vec': {
        const raw = getPath(params, f.path);
        const current: readonly unknown[] = Array.isArray(raw) ? raw : f.defaultValue;
        return (
          <div key={f.path} className="flex flex-col gap-1">
            <Text variant={TextVariants.label}>{label}</Text>
            <div className={clsx('grid gap-x-2', f.components.length === 2 ? 'grid-cols-2' : 'grid-cols-3')}>
              {f.components.map((c, i) => (
                <Slider
                  key={c.label}
                  defaultValue={f.defaultValue[i]}
                  disabled={disabled}
                  label={c.label}
                  max={c.max}
                  min={c.min}
                  onChange={(e) => {
                    const next = f.defaultValue.map((d, j) => {
                      const cv = current[j];
                      return cv === undefined || cv === null ? d : Number(cv);
                    });
                    next[i] = sliderValue(e);
                    updateParam(f.path, next);
                  }}
                  step={c.step}
                  value={(() => {
                    const cv = current[i];
                    return cv === undefined || cv === null ? f.defaultValue[i] : Number(cv);
                  })()}
                />
              ))}
            </div>
          </div>
        );
      }
      case 'optionalNum': {
        const raw = getPath(params, f.path);
        const active = raw !== undefined && raw !== null;
        const range = f.range?.(fieldCtx) ?? { min: f.min, max: f.max };
        return (
          <div key={f.path} className="flex flex-col gap-1">
            <Switch
              checked={active}
              disabled={disabled}
              label={label}
              onChange={(v) => updateParam(f.path, v ? f.defaultValue : null)}
            />
            <Slider
              defaultValue={f.defaultValue}
              disabled={disabled || !active}
              label={t('editor.film.manualValue')}
              max={range.max}
              min={range.min}
              onChange={(e) => updateParam(f.path, sliderValue(e))}
              step={f.step}
              suffix={f.suffix}
              value={active ? Number(raw) : f.defaultValue}
            />
          </div>
        );
      }
      default: {
        const v = getPath(params, f.path);
        return (
          <Slider
            key={f.path}
            defaultValue={f.defaultValue}
            disabled={disabled}
            label={label}
            max={f.max}
            min={f.min}
            onChange={(e) => {
              const nv = sliderValue(e);
              updateParam(f.path, f.integer ? Math.round(nv) : nv);
            }}
            step={f.step}
            suffix={f.suffix}
            value={v === undefined || v === null ? f.defaultValue : Number(v)}
          />
        );
      }
    }
  };

  const tab = TABS.find((tb) => tb.id === activeTab) ?? TABS[0];

  return (
    <div className="flex flex-col h-full">
      <div className="grow overflow-y-scroll p-3 flex flex-col gap-3">
        <Switch checked={fs.enabled} label={t('editor.film.enable')} onChange={(v) => update({ enabled: v })} />

        <div className={clsx('flex flex-col gap-3', !fs.enabled && 'opacity-50 pointer-events-none')}>
          <div className="flex bg-surface rounded-lg p-1 gap-1 sticky top-0 z-10">
            {TABS.map((tb) => (
              <button
                key={tb.id}
                type="button"
                onClick={() => setActiveTab(tb.id)}
                className={clsx(
                  'flex-1 rounded-md px-1 py-1.5 text-center transition-colors duration-150',
                  activeTab === tb.id
                    ? 'bg-card-active text-text-primary'
                    : 'text-text-secondary hover:bg-card-active/60',
                )}
              >
                <Text
                  as="span"
                  variant={TextVariants.label}
                  weight={activeTab === tb.id ? TextWeights.semibold : TextWeights.medium}
                >
                  {t(`editor.film.tabs.${tb.id}`)}
                </Text>
              </button>
            ))}
          </div>

          {tab.id === 'main' && (
            <>
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
            </>
          )}

          {tab.sections.map((section) => (
            <CollapsibleSection
              key={section.id}
              title={t(`editor.film.sections.${section.id}`)}
              titleVariant={TextVariants.heading}
              titleWeight={TextWeights.semibold}
              isOpen={!!openSections[section.id]}
              isContentVisible={true}
              canToggleVisibility={false}
              onToggle={() => setOpenSections((prev) => ({ ...prev, [section.id]: !prev[section.id] }))}
            >
              <div className="flex flex-col gap-2.5 pt-1">
                {sectionOverridden(section) && (
                  <div className="flex justify-end -mt-1">
                    <button
                      type="button"
                      onClick={() => resetSection(section)}
                      className="flex items-center gap-1 text-[11px] text-text-secondary hover:text-accent transition-colors"
                    >
                      <RotateCcw size={11} />
                      {t('editor.film.resetSection')}
                    </button>
                  </div>
                )}
                {section.fields.map(renderField)}
              </div>
            </CollapsibleSection>
          ))}
        </div>
      </div>

      <div className="shrink-0 p-3 border-t border-border-color">
        <button
          type="button"
          onClick={() => update({ params: {} })}
          className="w-full flex items-center justify-center gap-2 rounded-md border border-border-color bg-surface px-3 py-2 text-sm text-text-primary hover:bg-card-active transition-colors"
        >
          <RotateCcw size={14} />
          {t('editor.film.resetAll')}
        </button>
      </div>
    </div>
  );
}
