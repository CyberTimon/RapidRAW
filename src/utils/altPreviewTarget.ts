import {
  SCALAR_CONTROLS,
  GLOBAL_PARAMETERS,
  isInfluenceTarget,
  type InfluenceTarget,
  type InfluenceScope,
} from './influencePreview';
/** Explicit eligibility keeps unclassified controls in their ordinary editing mode. */
export function altPreviewTarget(
  control: string | undefined,
  scope: InfluenceScope,
  owner: string,
  subcontrols: Record<string, string>,
): InfluenceTarget | null {
  let target: unknown = null;
  if (
    control &&
    (SCALAR_CONTROLS as readonly string[]).includes(control) &&
    (scope.kind === 'mask' ||
      [
        'exposure',
        'brightness',
        'contrast',
        'hue',
        'saturation',
        'vibrance',
        'highlights',
        'shadows',
        'whites',
        'blacks',
        'sharpness',
        'clarity',
        'structure',
        'dehaze',
        'glowAmount',
        'halationAmount',
        'flareAmount',
      ].includes(control))
  )
    target = { kind: 'scalar', control: control, scope };
  if (control?.startsWith('hsl.'))
    target = {
      kind: 'hsl',
      band: subcontrols[owner + ':colorMixer'] ?? 'reds',
      component: control.slice(4),
      scope,
    };
  if (control?.startsWith('curvePoint.')) {
    const [, channel, index] = control.split('.');
    target = { kind: 'curvePoint', channel: channel, index: Number(index), scope };
  }
  if (scope.kind === 'global' && control?.startsWith('mono.'))
    target = { kind: 'monochromeMix', band: control.slice(5) };
  if (control?.startsWith('parametric.'))
    target = {
      kind: 'parametric',
      channel: subcontrols[owner + ':curves'] ?? 'luma',
      parameter: control.slice(11),
      scope,
    };
  if (scope.kind === 'global' && control === 'centré') target = { kind: 'effect', effect: 'centre' };
  if (scope.kind === 'global' && control?.startsWith('light.'))
    target = { kind: 'light', lightId: control.slice(6).split('|')[0] };
  if (scope.kind === 'global' && control?.startsWith('vignette')) target = { kind: 'effect', effect: 'vignette' };
  if (scope.kind === 'global' && control?.startsWith('fog')) target = { kind: 'effect', effect: 'fog' };
  if (scope.kind === 'global' && control?.startsWith('lensBlur')) target = { kind: 'effect', effect: 'lensBlur' };
  if (control?.startsWith('grading.') && !control.startsWith('grading.global'))
    target = { kind: 'grading', range: control.slice(8).split('.')[0], scope };
  if (
    control &&
    (GLOBAL_PARAMETERS as readonly string[]).includes(control) &&
    scope.kind === 'global' &&
    control.startsWith('relight')
  )
    target = { kind: 'parameter', control: control };

  return target && isInfluenceTarget(target) ? target : null;
}
