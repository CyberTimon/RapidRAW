import type { AutoOptions } from './types';

export function prepareAutoApplyOptions(options: AutoOptions, photoCount: number): AutoOptions {
  if (photoCount !== 1 || !options.skipEdited) return options;
  return { ...options, skipEdited: false };
}

export function resolveAutoPanelPaths(
  view: string,
  editorPath: string | undefined,
  selectedPaths: string[],
  libraryPath: string | null,
): string[] {
  if (view === 'editor') return editorPath ? [editorPath] : [];
  if (selectedPaths.length) return selectedPaths;
  return libraryPath ? [libraryPath] : [];
}

export function buildAutoWhiteBalanceOptions(options: AutoOptions): AutoOptions {
  return {
    ...options,
    controls: { ...options.controls, consistency: 0 },
    adjustments: {
      tone: false,
      whiteBalance: true,
      curves: false,
      presence: false,
      color: false,
      colorGrading: false,
      colorMixer: false,
    },
    whiteBalanceIntent: 'neutralize',
    skipEdited: false,
    groups: {},
  };
}
