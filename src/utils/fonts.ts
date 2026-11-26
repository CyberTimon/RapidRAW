import { invoke } from '@tauri-apps/api/core';
import { Invokes } from '../types/invokes';

const GENERIC_FAMILIES = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui'];
const PROBE_TEXT = 'mmmmmmmmmmlli1WQ@#';
const PROBE_FALLBACKS = ['monospace', 'serif'];
const PROBE_BATCH = 16;

export type FontWeight = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;

export const cssFontFamily = (font: string) =>
  GENERIC_FAMILIES.includes(font) ? font : `"${font.replace(/["\\]/g, '')}"`;

const renderableFonts = async (families: Array<string>) => {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return families;
  const width = (family: string) => {
    ctx.font = `72px ${family}`;
    return ctx.measureText(PROBE_TEXT).width;
  };
  const fallbacks = PROBE_FALLBACKS.map(width);
  const renderable: Array<string> = [];
  for (const [index, family] of families.entries()) {
    if (index > 0 && index % PROBE_BATCH === 0) await new Promise((resolve) => setTimeout(resolve));
    if (PROBE_FALLBACKS.some((fallback, at) => width(`${cssFontFamily(family)}, ${fallback}`) !== fallbacks[at])) {
      renderable.push(family);
    }
  }
  return renderable;
};

let systemFonts: Promise<Array<string>> | null = null;

export const loadSystemFonts = () => {
  systemFonts ??= invoke<Array<string>>(Invokes.SystemFonts)
    .then(renderableFonts)
    .catch((err) => {
      console.error('Font listing failed:', err);
      systemFonts = null;
      return [];
    });
  return systemFonts;
};

const fontWeights = new Map<string, Promise<Array<FontWeight>>>();

export const loadFontWeights = (family: string | null) => {
  const key = family ?? '';
  let weights = fontWeights.get(key);
  if (!weights) {
    weights = invoke<Array<FontWeight>>(Invokes.FontWeights, { family }).catch((err) => {
      console.error('Font weights failed:', err);
      fontWeights.delete(key);
      return [];
    });
    fontWeights.set(key, weights);
  }
  return weights;
};
