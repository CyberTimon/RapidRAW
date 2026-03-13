import { motion } from 'framer-motion';
import clsx from 'clsx';
import Slider from '../ui/Slider';
import { Adjustments, BasicAdjustment } from '../../utils/adjustments';
import { useEffect, useRef, useState } from 'react';

interface BasicAdjustmentsProps {
  adjustments: Adjustments;
  setAdjustments(adjustments: Partial<Adjustments>): any;
  isForMask?: boolean;
  onDragStateChange?: (isDragging: boolean) => void;
}

const toneMapperOptions = [
  { id: 'basic', label: 'Basic', title: 'Standard Tonemapping' },
  { id: 'agx', label: 'AgX', title: 'Film-like Tonemapping' },
];

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
  const [buttonRefs, setButtonRefs] = useState<Map<string, HTMLButtonElement>>(new Map());
  const [bubbleStyle, setBubbleStyle] = useState({});
  const containerRef = useRef<HTMLDivElement>(null);
  const isInitialAnimation = useRef(true);
  const [isLabelHovered, setIsLabelHovered] = useState(false);

  const handleReset = () => {
    onMapperChange('basic');
    onExposureChange(0);
  };

  useEffect(() => {
    const selectedButton = buttonRefs.get(selectedMapper);

    if (selectedButton && containerRef.current) {
      const targetStyle = {
        x: selectedButton.offsetLeft,
        width: selectedButton.offsetWidth,
      };

      if (isInitialAnimation.current && containerRef.current.offsetWidth > 0) {
        let initialX;
        if (selectedMapper === 'agx') {
          initialX = containerRef.current.offsetWidth;
        } else {
          initialX = -targetStyle.width;
        }

        setBubbleStyle({
          x: [initialX, targetStyle.x],
          width: targetStyle.width,
        });
        isInitialAnimation.current = false;
      } else {
        setBubbleStyle(targetStyle);
      }
    }
  }, [selectedMapper, buttonRefs]);

  return (
    <div className="group">
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
            Tone Mapper
          </span>
          <span
            aria-hidden={!isLabelHovered}
            className={`col-start-1 row-start-1 text-sm font-medium text-text-primary select-none transition-opacity duration-200 ease-in-out pointer-events-none ${
              isLabelHovered ? 'opacity-100' : 'opacity-0'
            }`}
          >
            Reset
          </span>
        </div>
      </div>
      <div className="w-full p-2 pb-1 bg-card-active rounded-md">
        <div ref={containerRef} className="relative flex w-full">
          <motion.div
            className="absolute top-0 bottom-0 z-0 bg-accent"
            style={{ borderRadius: 6 }}
            animate={bubbleStyle}
            transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
          />
          {toneMapperOptions.map((mapper) => (
            <button
              key={mapper.id}
              data-tooltip={mapper.title}
              ref={(el) => {
                if (el) {
                  const newRefs = new Map(buttonRefs);
                  if (newRefs.get(mapper.id) !== el) {
                    newRefs.set(mapper.id, el);
                    setButtonRefs(newRefs);
                  }
                }
              }}
              onClick={() => onMapperChange(mapper.id)}
              className={clsx(
                'relative flex-1 flex items-center justify-center gap-2 px-3 p-1.5 text-sm font-medium rounded-md transition-colors',
                {
                  'text-text-primary hover:bg-surface': selectedMapper !== mapper.id,
                  'text-button-text': selectedMapper === mapper.id,
                },
              )}
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              <span className="relative z-10 flex items-center">{mapper.label}</span>
            </button>
          ))}
        </div>
        <div className="mt-2.5 px-1">
          <Slider
            label="Exposure"
            max={5}
            min={-5}
            onChange={(value) => onExposureChange(value)}
            step={0.01}
            value={exposureValue}
            trackClassName="bg-surface"
            onDragStateChange={onDragStateChange}
          />
        </div>
      </div>
    </div>
  );
};

export default function BasicAdjustments({
  adjustments,
  setAdjustments,
  isForMask = false,
  onDragStateChange,
}: BasicAdjustmentsProps) {
  const handleAdjustmentChange = (key: BasicAdjustment, value: number) => {
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, [key]: value }));
  };

  const handleToneMapperChange = (mapper: string) => {
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      toneMapper: mapper as 'basic' | 'agx',
    }));
  };

  return (
    <div>
      <Slider
        label="Brightness"
        max={5}
        min={-5}
        onChange={(value) => handleAdjustmentChange(BasicAdjustment.Brightness, value)}
        step={0.01}
        value={adjustments.brightness}
        onDragStateChange={onDragStateChange}
      />
      <Slider
        label="Contrast"
        max={100}
        min={-100}
        onChange={(value) => handleAdjustmentChange(BasicAdjustment.Contrast, value)}
        step={1}
        value={adjustments.contrast}
        onDragStateChange={onDragStateChange}
      />
      <Slider
        label="Highlights"
        max={100}
        min={-100}
        onChange={(value) => handleAdjustmentChange(BasicAdjustment.Highlights, value)}
        step={1}
        value={adjustments.highlights}
        onDragStateChange={onDragStateChange}
      />
      <Slider
        label="Shadows"
        max={100}
        min={-100}
        onChange={(value) => handleAdjustmentChange(BasicAdjustment.Shadows, value)}
        step={1}
        value={adjustments.shadows}
        onDragStateChange={onDragStateChange}
      />
      <Slider
        label="Whites"
        max={100}
        min={-100}
        onChange={(value) => handleAdjustmentChange(BasicAdjustment.Whites, value)}
        step={1}
        value={adjustments.whites}
        onDragStateChange={onDragStateChange}
      />
      <Slider
        label="Blacks"
        max={100}
        min={-100}
        onChange={(value) => handleAdjustmentChange(BasicAdjustment.Blacks, value)}
        step={1}
        value={adjustments.blacks}
        onDragStateChange={onDragStateChange}
      />

      {isForMask ? (
        <Slider
          label="Exposure"
          max={5}
          min={-5}
          onChange={(value) => handleAdjustmentChange(BasicAdjustment.Exposure, value)}
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
    </div>
  );
}