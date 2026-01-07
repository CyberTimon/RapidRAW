import { useBloc } from '@blac/react';
import { AdjustmentsBloc } from '../../blocs/editor/AdjustmentsBloc.js';
import { Slider } from '../../primitives/Slider.js';
import { usePreviewRequest } from '../../hooks/usePreviewRequest.js';

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

export function ColorControls() {
  const [state, bloc] = useBloc(AdjustmentsBloc);
  const { adjustments } = state;
  const { requestPreview } = usePreviewRequest();

  const handleResetWhiteBalance = () => {
    bloc.setTemperature(0);
    bloc.setTint(0);
    requestPreview();
  };

  const handleResetPresence = () => {
    bloc.setVibrance(0);
    bloc.setSaturation(0);
    requestPreview();
  };

  return (
    <div className="space-y-4">
      <Section title="White Balance" onReset={handleResetWhiteBalance}>
        <Slider
          label="Temperature"
          value={adjustments.temperature}
          min={-100}
          max={100}
          step={1}
          onChange={bloc.setTemperature}
          onChangeEnd={requestPreview}
        />
        <Slider
          label="Tint"
          value={adjustments.tint}
          min={-100}
          max={100}
          step={1}
          onChange={bloc.setTint}
          onChangeEnd={requestPreview}
        />
      </Section>

      <Section title="Presence" onReset={handleResetPresence}>
        <Slider
          label="Vibrance"
          value={adjustments.vibrance}
          min={-100}
          max={100}
          step={1}
          onChange={bloc.setVibrance}
          onChangeEnd={requestPreview}
        />
        <Slider
          label="Saturation"
          value={adjustments.saturation}
          min={-100}
          max={100}
          step={1}
          onChange={bloc.setSaturation}
          onChangeEnd={requestPreview}
        />
      </Section>
    </div>
  );
}
