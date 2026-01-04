import { useBloc } from '@blac/react';
import { AdjustmentsBloc } from '../../blocs/editor/AdjustmentsBloc.js';
import { Slider } from '../../primitives/Slider.js';

interface SectionProps {
  title: string;
  children: React.ReactNode;
  onReset?: () => void;
}

function Section({ title, children, onReset }: SectionProps) {
  return (
    <div className="p-2 bg-surface rounded-md">
      <div className="flex justify-between items-center mb-2">
        <p className="text-sm font-semibold text-text-primary">{title}</p>
        {onReset && (
          <button
            type="button"
            onClick={onReset}
            className="text-xs text-text-secondary hover:text-text-primary transition-colors"
          >
            Reset
          </button>
        )}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

export function DetailControls() {
  const [state, bloc] = useBloc(AdjustmentsBloc);
  const { adjustments } = state;

  const handleResetSharpening = () => {
    bloc.setSharpness(0);
  };

  const handleResetPresence = () => {
    bloc.setClarity(0);
    bloc.setDehaze(0);
    bloc.setTexture(0);
  };

  const handleResetNoiseReduction = () => {
    bloc.setNoiseReduction(0);
    bloc.setColorNoiseReduction(0);
  };

  return (
    <div className="space-y-4">
      <Section title="Sharpening" onReset={handleResetSharpening}>
        <Slider
          label="Sharpness"
          value={adjustments.sharpness}
          min={-100}
          max={100}
          step={1}
          onChange={bloc.setSharpness}
        />
      </Section>

      <Section title="Presence" onReset={handleResetPresence}>
        <Slider
          label="Clarity"
          value={adjustments.clarity}
          min={-100}
          max={100}
          step={1}
          onChange={bloc.setClarity}
        />
        <Slider
          label="Dehaze"
          value={adjustments.dehaze}
          min={-100}
          max={100}
          step={1}
          onChange={bloc.setDehaze}
        />
        <Slider
          label="Texture"
          value={adjustments.texture}
          min={-100}
          max={100}
          step={1}
          onChange={bloc.setTexture}
        />
      </Section>

      <Section title="Noise Reduction" onReset={handleResetNoiseReduction}>
        <Slider
          label="Luminance"
          value={adjustments.noiseReduction}
          min={0}
          max={100}
          step={1}
          onChange={bloc.setNoiseReduction}
        />
        <Slider
          label="Color"
          value={adjustments.colorNoiseReduction}
          min={0}
          max={100}
          step={1}
          onChange={bloc.setColorNoiseReduction}
        />
      </Section>
    </div>
  );
}
