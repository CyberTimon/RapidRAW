import { useBloc } from '@blac/react';
import {
  FlipHorizontal,
  FlipVertical,
  RectangleHorizontal,
  RectangleVertical,
  RotateCcw,
  RotateCw,
  Ruler,
  X,
} from 'lucide-react';
import { CropBloc, CROP_PRESETS, type CropPreset } from '../../blocs/editor/CropBloc.js';
import { EditorBloc } from '../../blocs/editor/EditorBloc.js';
import { AdjustmentsBloc } from '../../blocs/editor/AdjustmentsBloc.js';
import { Slider } from '../../primitives/Slider.js';

function AspectRatioGrid() {
  const [, cropBloc] = useBloc(CropBloc);
  const activePreset = cropBloc.getActivePreset();

  return (
    <div className="grid grid-cols-3 gap-2">
      {CROP_PRESETS.map((preset: CropPreset) => (
        <button
          key={preset.name}
          type="button"
          className={`
            px-2 py-1.5 text-sm rounded-md transition-colors
            ${activePreset?.name === preset.name
              ? 'bg-accent text-white'
              : 'bg-surface hover:bg-surface-hover text-text-primary'
            }
          `}
          onClick={() => cropBloc.applyPreset(preset)}
        >
          {preset.name}
        </button>
      ))}
    </div>
  );
}

function CustomRatioInput() {
  const [state, cropBloc] = useBloc(CropBloc);
  const isCustomActive = cropBloc.isCustomActive();

  const handleApply = () => {
    cropBloc.applyCustomRatio();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleApply();
      (e.target as HTMLInputElement).blur();
    }
  };

  return (
    <div className="mt-3">
      <button
        type="button"
        className={`
          w-full px-2 py-1.5 text-sm rounded-md transition-colors
          ${isCustomActive
            ? 'bg-accent text-white'
            : 'bg-surface hover:bg-surface-hover text-text-primary'
          }
        `}
        onClick={() => {
          const imageRatio = cropBloc.getEffectiveOriginalRatio();
          let newRatio = 1.618;
          if (imageRatio && imageRatio < 1) {
            newRatio = 1 / 1.618;
          }
          cropBloc.setAspectRatio(newRatio);
        }}
      >
        Custom
      </button>
      <div
        className={`
          mt-2 bg-surface p-2 rounded-md transition-opacity
          ${isCustomActive ? 'opacity-100' : 'opacity-50 pointer-events-none'}
        `}
      >
        <div className="flex items-center justify-center gap-2">
          <input
            type="number"
            min="0"
            placeholder="W"
            value={state.customWidth}
            onChange={(e) => cropBloc.setCustomRatio(e.target.value, state.customHeight)}
            onBlur={handleApply}
            onKeyDown={handleKeyDown}
            className="w-full bg-bg-primary text-center rounded-md p-1 border border-surface focus:border-accent focus:outline-none text-text-primary"
          />
          <X size={16} className="text-text-tertiary flex-shrink-0" />
          <input
            type="number"
            min="0"
            placeholder="H"
            value={state.customHeight}
            onChange={(e) => cropBloc.setCustomRatio(state.customWidth, e.target.value)}
            onBlur={handleApply}
            onKeyDown={handleKeyDown}
            className="w-full bg-bg-primary text-center rounded-md p-1 border border-surface focus:border-accent focus:outline-none text-text-primary"
          />
        </div>
      </div>
    </div>
  );
}

function AspectRatioSection() {
  const [, cropBloc] = useBloc(CropBloc);
  const isOrientationDisabled = cropBloc.isOrientationToggleDisabled();
  const orientation = cropBloc.getOrientation();

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm font-semibold text-text-primary">Aspect Ratio</p>
        <button
          type="button"
          className="p-1.5 rounded-md hover:bg-surface disabled:text-text-tertiary disabled:cursor-not-allowed"
          disabled={isOrientationDisabled}
          onClick={() => cropBloc.toggleOrientation()}
          title="Switch Orientation"
        >
          {orientation === 'vertical' ? (
            <RectangleVertical size={16} />
          ) : (
            <RectangleHorizontal size={16} />
          )}
        </button>
      </div>
      <AspectRatioGrid />
      <CustomRatioInput />
    </div>
  );
}

function RotationSection() {
  const [state, cropBloc] = useBloc(CropBloc);

  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold text-text-primary">Rotation</p>
      <div className="flex justify-between items-center">
        <span className="font-mono text-lg text-text-primary">
          {state.rotation.toFixed(1)}°
        </span>
        <button
          type="button"
          className="p-1.5 rounded-full hover:bg-surface"
          onClick={() => cropBloc.resetRotation()}
          title="Reset Rotation"
        >
          <RotateCcw size={14} />
        </button>
      </div>
      <Slider
        value={state.rotation}
        min={-45}
        max={45}
        step={0.1}
        onChange={(value) => cropBloc.setRotation(value)}
      />
    </div>
  );
}

function ToolsSection() {
  const [state, cropBloc] = useBloc(CropBloc);
  const [, adjustmentsBloc] = useBloc(AdjustmentsBloc);

  const handleRotateLeft = () => {
    cropBloc.rotateLeft();
    adjustmentsBloc.setRotation(0);
  };

  const handleRotateRight = () => {
    cropBloc.rotateRight();
    adjustmentsBloc.setRotation(0);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm font-semibold text-text-primary">Tools</p>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          className="flex flex-col items-center justify-center p-3 rounded-lg bg-surface text-text-secondary hover:bg-surface-hover hover:text-text-primary"
          onClick={handleRotateLeft}
        >
          <RotateCcw size={20} />
          <span className="text-xs mt-1.5">Rotate Left</span>
        </button>
        <button
          type="button"
          className="flex flex-col items-center justify-center p-3 rounded-lg bg-surface text-text-secondary hover:bg-surface-hover hover:text-text-primary"
          onClick={handleRotateRight}
        >
          <RotateCw size={20} />
          <span className="text-xs mt-1.5">Rotate Right</span>
        </button>
        <button
          type="button"
          className={`
            flex flex-col items-center justify-center p-3 rounded-lg transition-colors
            ${state.flipHorizontal
              ? 'bg-accent text-white'
              : 'bg-surface text-text-secondary hover:bg-surface-hover hover:text-text-primary'
            }
          `}
          onClick={() => {
            cropBloc.toggleFlipHorizontal();
            adjustmentsBloc.toggleFlipHorizontal();
          }}
        >
          <FlipHorizontal size={20} />
          <span className="text-xs mt-1.5">Flip Horiz</span>
        </button>
        <button
          type="button"
          className={`
            flex flex-col items-center justify-center p-3 rounded-lg transition-colors
            ${state.flipVertical
              ? 'bg-accent text-white'
              : 'bg-surface text-text-secondary hover:bg-surface-hover hover:text-text-primary'
            }
          `}
          onClick={() => {
            cropBloc.toggleFlipVertical();
            adjustmentsBloc.toggleFlipVertical();
          }}
        >
          <FlipVertical size={20} />
          <span className="text-xs mt-1.5">Flip Vert</span>
        </button>
        <button
          type="button"
          className={`
            flex flex-col items-center justify-center p-3 rounded-lg transition-colors col-span-2
            ${state.isStraightenActive
              ? 'bg-accent text-white'
              : 'bg-surface text-text-secondary hover:bg-surface-hover hover:text-text-primary'
            }
          `}
          onClick={() => cropBloc.toggleStraighten()}
        >
          <Ruler size={20} />
          <span className="text-xs mt-1.5">
            {state.isStraightenActive ? 'Cancel Straighten' : 'Straighten'}
          </span>
        </button>
      </div>
    </div>
  );
}

export function CropPanel() {
  const [editorState] = useBloc(EditorBloc);
  const [, cropBloc] = useBloc(CropBloc);

  const hasImage = !!editorState.selectedImage;

  const handleReset = () => {
    cropBloc.reset();
  };

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 flex justify-between items-center flex-shrink-0 border-b border-border">
        <h2 className="text-lg font-bold text-text-primary">Crop & Transform</h2>
        <button
          type="button"
          className="p-2 rounded-full hover:bg-surface transition-colors"
          onClick={handleReset}
          title="Reset All"
        >
          <RotateCcw size={18} />
        </button>
      </div>

      <div className="flex-grow overflow-y-auto p-4 text-text-secondary space-y-6">
        {hasImage ? (
          <>
            <AspectRatioSection />
            <RotationSection />
            <ToolsSection />
          </>
        ) : (
          <p className="text-center text-text-tertiary mt-4">No image selected.</p>
        )}
      </div>
    </div>
  );
}
