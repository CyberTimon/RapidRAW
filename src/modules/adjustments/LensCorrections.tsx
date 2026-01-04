import { useBloc } from '@blac/react';
import { AdjustmentsBloc } from '../../blocs/editor/AdjustmentsBloc.js';
import { Slider } from '../../primitives/Slider.js';

export function LensCorrections() {
  const [state, bloc] = useBloc(AdjustmentsBloc);
  const { lensCorrections } = state.adjustments;

  const handleReset = () => {
    bloc.setLensCorrections({
      distortion: 0,
      chromaticAberration: 0,
      vignetting: 0,
    });
  };

  return (
    <div className="p-2 bg-surface rounded-md">
      <div className="flex justify-between items-center mb-2">
        <p className="text-sm font-semibold text-text-primary">Lens Corrections</p>
        <button
          type="button"
          onClick={handleReset}
          className="text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          Reset
        </button>
      </div>
      <div className="space-y-2">
        <Slider
          label="Distortion"
          value={lensCorrections.distortion}
          min={-100}
          max={100}
          step={1}
          onChange={(value) => bloc.setLensCorrections({ distortion: value })}
        />
        <Slider
          label="Chromatic Aberration"
          value={lensCorrections.chromaticAberration}
          min={-100}
          max={100}
          step={1}
          onChange={(value) => bloc.setLensCorrections({ chromaticAberration: value })}
        />
        <Slider
          label="Vignetting"
          value={lensCorrections.vignetting}
          min={-100}
          max={100}
          step={1}
          onChange={(value) => bloc.setLensCorrections({ vignetting: value })}
        />
      </div>
    </div>
  );
}
