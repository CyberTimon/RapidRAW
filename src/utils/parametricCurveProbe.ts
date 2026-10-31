import { DEFAULT_PARAMETRIC_CURVE_SETTINGS, type ParametricCurveSettings } from './adjustments';
import type { InfluenceTarget } from './influencePreview';
import { buildParametricPoints } from './curveMath';
import { curvePointProbe } from './curvePointProbe';

type Parameter = Extract<InfluenceTarget, { kind: 'parametric' }>['parameter'];

/** Split coverage follows the boundary, even when adjacent tonal adjustments are neutral. */
export function parametricCurveProbe(settings: Partial<ParametricCurveSettings> | undefined, parameter: Parameter) {
  const current = { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS, ...settings };
  if (parameter === 'split1' || parameter === 'split2' || parameter === 'split3') {
    const neutral = buildParametricPoints({
      ...DEFAULT_PARAMETRIC_CURVE_SETTINGS,
      split1: current.split1,
      split2: current.split2,
      split3: current.split3,
    });
    // These are the same knots used by the parametric curve compiler.
    return curvePointProbe(neutral, { split1: 2, split2: 3, split3: 4 }[parameter]);
  }
  return {
    baseline: buildParametricPoints({ ...current, [parameter]: 0 }),
    coverage: buildParametricPoints({ ...current, [parameter]: parameter === 'whiteLevel' ? -50 : 50 }),
  };
}
