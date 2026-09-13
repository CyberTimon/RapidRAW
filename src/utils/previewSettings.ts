import type { AppSettings } from '../components/ui/AppProperties';

export function previewSettingsKey(settings: AppSettings | null) {
  if (!settings) return '';
  return JSON.stringify([
    settings.smallThumbnailResolution ?? 480,
    settings.mediumThumbnailResolution ?? 1280,
    settings.alwaysDecodeRawThumbnails ?? false,
    settings.rawHighlightCompression,
    settings.linearRawMode,
    settings.rawPreprocessingColorNr,
    settings.rawPreprocessingSharpening,
    settings.applyPreprocessingToNonRaws,
    settings.tonemapperOverrideEnabled,
    settings.defaultRawTonemapper,
    settings.defaultNonRawTonemapper,
    settings.processingBackend,
  ]);
}
