import { useBloc } from '@blac/react';
import { AdjustmentsBloc } from '../../blocs/editor/AdjustmentsBloc.js';
import { Slider } from '../../primitives/Slider.js';
import type { ToneMapper } from '../../types/adjustments.js';

const TONE_MAPPER_OPTIONS: { id: ToneMapper; label: string }[] = [
  { id: 'none', label: 'Basic' },
  { id: 'agx', label: 'AgX' },
];

interface ToneMapperSwitchProps {
  selectedMapper: ToneMapper;
  onMapperChange: (mapper: ToneMapper) => void;
  exposureValue: number;
  onExposureChange: (value: number) => void;
  onReset: () => void;
}

function ToneMapperSwitch({
  selectedMapper,
  onMapperChange,
  exposureValue,
  onExposureChange,
  onReset,
}: ToneMapperSwitchProps) {
  return (
    <div className="group">
      <div className="flex justify-between items-center mb-2">
        <button
          type="button"
          onClick={onReset}
          className="text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
          title="Click to reset Tone Mapper and Exposure"
        >
          Tone Mapper
        </button>
      </div>
      <div className="w-full p-2 pb-1 bg-surface rounded-md">
        <div className="relative flex w-full">
          {TONE_MAPPER_OPTIONS.map((mapper) => (
            <button
              key={mapper.id}
              type="button"
              onClick={() => onMapperChange(mapper.id)}
              className={`
                relative flex-1 flex items-center justify-center gap-2 px-3 py-1.5 
                text-sm font-medium rounded-md transition-colors
                ${
                  selectedMapper === mapper.id
                    ? 'bg-accent text-white'
                    : 'text-text-primary hover:bg-surface-secondary'
                }
              `}
            >
              {mapper.label}
            </button>
          ))}
        </div>
        <div className="mt-2.5 px-1">
          <Slider
            label="Exposure"
            value={exposureValue}
            min={-5}
            max={5}
            step={0.01}
            onChange={onExposureChange}
            trackClassName="bg-surface-secondary"
          />
        </div>
      </div>
    </div>
  );
}

export function ExposureControls() {
  const [state, bloc] = useBloc(AdjustmentsBloc);
  const { adjustments } = state;

  const handleToneMapperReset = () => {
    bloc.setToneMapper('none');
    bloc.setExposure(0);
  };

  return (
    <div className="space-y-3">
      <Slider
        label="Brightness"
        value={adjustments.brightness}
        min={-5}
        max={5}
        step={0.01}
        onChange={bloc.setBrightness}
      />
      <Slider
        label="Contrast"
        value={adjustments.contrast}
        min={-100}
        max={100}
        step={1}
        onChange={bloc.setContrast}
      />
      <Slider
        label="Highlights"
        value={adjustments.highlights}
        min={-100}
        max={100}
        step={1}
        onChange={bloc.setHighlights}
      />
      <Slider
        label="Shadows"
        value={adjustments.shadows}
        min={-100}
        max={100}
        step={1}
        onChange={bloc.setShadows}
      />
      <Slider
        label="Whites"
        value={adjustments.whites}
        min={-100}
        max={100}
        step={1}
        onChange={bloc.setWhites}
      />
      <Slider
        label="Blacks"
        value={adjustments.blacks}
        min={-100}
        max={100}
        step={1}
        onChange={bloc.setBlacks}
      />

      <ToneMapperSwitch
        selectedMapper={adjustments.toneMapper}
        onMapperChange={bloc.setToneMapper}
        exposureValue={adjustments.exposure}
        onExposureChange={bloc.setExposure}
        onReset={handleToneMapperReset}
      />
    </div>
  );
}
