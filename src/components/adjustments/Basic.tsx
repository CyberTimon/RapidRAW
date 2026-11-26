import SegmentedControl from '../ui/SegmentedControl';
import Slider from '../ui/Slider';
import { Adjustments, BasicAdjustment } from '../../utils/adjustments';
import { useState, useMemo, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { areSectionPropsEqual } from '../../utils/adjustments';

interface BasicAdjustmentsProps {
  adjustments: Adjustments;
  setAdjustments(adjustments: Partial<Adjustments>): any;
  isForMask?: boolean;
  onDragStateChange?: (isDragging: boolean) => void;
  appSettings?: any;
}

interface ToneMapperSwitchProps {
  selectedMapper: string;
  onMapperChange: (mapper: string) => void;
  exposureValue: number;
  onExposureChange: (value: number) => void;
  onDragStateChange?: (isDragging: boolean) => void;
}

const ToneMapperSwitch = ({
  selectedMapper,
  onMapperChange,
  exposureValue,
  onExposureChange,
  onDragStateChange,
}: ToneMapperSwitchProps) => {
  const { t } = useTranslation();
  const [isLabelHovered, setIsLabelHovered] = useState(false);

  const toneMapperOptions = useMemo(
    () => [
      {
        id: 'basic',
        label: t('adjustments.basic.mappers.basic'),
        tooltip: t('adjustments.basic.mappers.basicDesc'),
      },
      {
        id: 'agx',
        label: t('adjustments.basic.mappers.agx'),
        tooltip: t('adjustments.basic.mappers.agxDesc'),
      },
    ],
    [t],
  );

  const handleReset = () => {
    onMapperChange('basic');
    onExposureChange(0);
  };

  return (
    <div className="group mb-3">
      <div className="flex justify-between items-center mb-2">
        <div
          className="grid cursor-pointer"
          onClick={handleReset}
          onDoubleClick={handleReset}
          onMouseEnter={() => setIsLabelHovered(true)}
          onMouseLeave={() => setIsLabelHovered(false)}
        >
          <span
            aria-hidden={isLabelHovered}
            className={`col-start-1 row-start-1 text-sm font-medium text-text-secondary select-none transition-opacity duration-200 ease-in-out ${
              isLabelHovered ? 'opacity-0' : 'opacity-100'
            }`}
          >
            {t('adjustments.basic.toneMapper')}
          </span>
          <span
            aria-hidden={!isLabelHovered}
            className={`col-start-1 row-start-1 text-sm font-medium text-text-primary select-none transition-opacity duration-200 ease-in-out pointer-events-none ${
              isLabelHovered ? 'opacity-100' : 'opacity-0'
            }`}
          >
            {t('adjustments.basic.reset')}
          </span>
        </div>
      </div>
      <div className="w-full p-2 pb-1 bg-card-active rounded-md">
        <SegmentedControl
          variant="embedded"
          options={toneMapperOptions}
          value={selectedMapper}
          onChange={onMapperChange}
        />
        <div className="mt-2.5 px-1">
          <Slider
            label={t('adjustments.basic.exposure')}
            max={5}
            min={-5}
            onChange={(e: any) => onExposureChange(parseFloat(e.target.value))}
            speedEditId={BasicAdjustment.Exposure}
            step={0.01}
            resetKey="exposure"
            value={exposureValue}
            trackClassName="bg-surface"
            onDragStateChange={onDragStateChange}
          />
        </div>
      </div>
    </div>
  );
};

function BasicAdjustments({
  adjustments,
  setAdjustments,
  isForMask = false,
  onDragStateChange,
  appSettings,
}: BasicAdjustmentsProps) {
  const { t } = useTranslation();

  const handleAdjustmentChange = (key: BasicAdjustment, value: any) => {
    const numericValue = parseFloat(value);
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, [key]: numericValue }));
  };

  const handleToneMapperChange = (mapper: string) => {
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      toneMapper: mapper as 'basic' | 'agx',
    }));
  };

  const hideTonemapper = isForMask || appSettings?.tonemapperOverrideEnabled;

  return (
    <div>
      {hideTonemapper ? (
        <Slider
          resetKey="exposure"
          label={t('adjustments.basic.exposure')}
          max={5}
          min={-5}
          onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Exposure, e.target.value)}
          speedEditId={BasicAdjustment.Exposure}
          step={0.01}
          value={adjustments.exposure}
          onDragStateChange={onDragStateChange}
        />
      ) : (
        <ToneMapperSwitch
          selectedMapper={adjustments.toneMapper || 'agx'}
          onMapperChange={handleToneMapperChange}
          exposureValue={adjustments.exposure}
          onExposureChange={(value) => handleAdjustmentChange(BasicAdjustment.Exposure, value)}
          onDragStateChange={onDragStateChange}
        />
      )}
      <Slider
        resetKey="contrast"
        label={t('adjustments.basic.contrast')}
        max={100}
        min={-100}
        onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Contrast, e.target.value)}
        speedEditId={BasicAdjustment.Contrast}
        step={1}
        value={adjustments.contrast}
        onDragStateChange={onDragStateChange}
      />
      <Slider
        resetKey="highlights"
        label={t('adjustments.basic.highlights')}
        max={100}
        min={-100}
        onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Highlights, e.target.value)}
        speedEditId={BasicAdjustment.Highlights}
        step={1}
        value={adjustments.highlights}
        onDragStateChange={onDragStateChange}
      />
      <Slider
        resetKey="shadows"
        label={t('adjustments.basic.shadows')}
        max={100}
        min={-100}
        onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Shadows, e.target.value)}
        speedEditId={BasicAdjustment.Shadows}
        step={1}
        value={adjustments.shadows}
        onDragStateChange={onDragStateChange}
      />
      <Slider
        resetKey="whites"
        label={t('adjustments.basic.whites')}
        max={100}
        min={-100}
        onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Whites, e.target.value)}
        speedEditId={BasicAdjustment.Whites}
        step={1}
        value={adjustments.whites}
        onDragStateChange={onDragStateChange}
      />
      <Slider
        resetKey="blacks"
        label={t('adjustments.basic.blacks')}
        max={100}
        min={-100}
        onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Blacks, e.target.value)}
        speedEditId={BasicAdjustment.Blacks}
        step={1}
        value={adjustments.blacks}
        onDragStateChange={onDragStateChange}
      />
      <Slider
        resetKey="brightness"
        label={t('adjustments.basic.brightness')}
        max={5}
        min={-5}
        onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Brightness, e.target.value)}
        step={0.01}
        value={adjustments.brightness}
        onDragStateChange={onDragStateChange}
      />
    </div>
  );
}

export default memo(BasicAdjustments, areSectionPropsEqual('basic'));
