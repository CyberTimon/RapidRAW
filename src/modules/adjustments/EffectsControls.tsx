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

export function EffectsControls() {
  const [state, bloc] = useBloc(AdjustmentsBloc);
  const { adjustments } = state;
  const { vignette, grain } = adjustments;

  const handleResetVignette = () => {
    bloc.setVignette({
      amount: 0,
      midpoint: 50,
      roundness: 0,
      feather: 50,
    });
  };

  const handleResetGrain = () => {
    bloc.setGrain({
      amount: 0,
      size: 25,
      roughness: 50,
    });
  };

  return (
    <div className="space-y-4">
      <Section title="Vignette" onReset={handleResetVignette}>
        <Slider
          label="Amount"
          value={vignette.amount}
          min={-100}
          max={100}
          step={1}
          onChange={(value) => bloc.setVignette({ amount: value })}
        />
        <Slider
          label="Midpoint"
          value={vignette.midpoint}
          min={0}
          max={100}
          step={1}
          onChange={(value) => bloc.setVignette({ midpoint: value })}
        />
        <Slider
          label="Roundness"
          value={vignette.roundness}
          min={-100}
          max={100}
          step={1}
          onChange={(value) => bloc.setVignette({ roundness: value })}
        />
        <Slider
          label="Feather"
          value={vignette.feather}
          min={0}
          max={100}
          step={1}
          onChange={(value) => bloc.setVignette({ feather: value })}
        />
      </Section>

      <Section title="Grain" onReset={handleResetGrain}>
        <Slider
          label="Amount"
          value={grain.amount}
          min={0}
          max={100}
          step={1}
          onChange={(value) => bloc.setGrain({ amount: value })}
        />
        <Slider
          label="Size"
          value={grain.size}
          min={0}
          max={100}
          step={1}
          onChange={(value) => bloc.setGrain({ size: value })}
        />
        <Slider
          label="Roughness"
          value={grain.roughness}
          min={0}
          max={100}
          step={1}
          onChange={(value) => bloc.setGrain({ roughness: value })}
        />
      </Section>
    </div>
  );
}
