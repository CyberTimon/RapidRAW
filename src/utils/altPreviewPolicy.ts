import type { InfluenceTarget } from './influencePreview';
/** Wire values are shared with the diagnostic compositor: difference, tone, colour, coverage. */
export type AltPreviewPresentation = 0 | 1 | 2 | 3;
export function altPreviewPolicy(target: InfluenceTarget, control?: string): AltPreviewPresentation {
  switch (target.kind) {
    case 'hsl':
    case 'grading':
      return 2;
    case 'monochromeMix':
      return 1;
    case 'curvePoint':
    case 'parametric':
      return target.channel === 'luma' ? 1 : 2;
    case 'scalar':
      if (
        ['clarity', 'dehaze', 'structure', 'sharpness', 'glowAmount', 'halationAmount', 'flareAmount'].includes(
          target.control,
        )
      )
        return 0;
      return ['temperature', 'tint', 'hue', 'saturation', 'vibrance'].includes(target.control) ? 2 : 1;
    case 'parameter':
      return target.control === 'relightAmbient' ? 1 : 0;
    case 'light':
      return control?.endsWith('|temperature') || control?.endsWith('|tint')
        ? 2
        : control?.endsWith('|intensity')
          ? 1
          : 3;
    case 'effect':
      if (target.effect === 'vignette') return control === 'vignetteAmount' ? 1 : 3;
      if (target.effect === 'centre') return 1;
      if (target.effect === 'fog')
        return control === 'fogGlow'
          ? 0
          : ['fogTemperature', 'fogTint'].includes(control ?? '')
            ? 2
            : control === 'fogAmount'
              ? 1
              : 3;
      return 0;
    default:
      return 0;
  }
}
