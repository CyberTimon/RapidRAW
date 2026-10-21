import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import Waveform from './Waveform';
import { Adjustments } from '../../../utils/adjustments';
import { useEditorStore } from '../../../store/useEditorStore';

interface ConnectedWaveformProps {
  setDisplayMode(mode: string): void;
  setAdjustments(value: (prev: Adjustments) => Adjustments): void;
  theme?: string;
}

export default function ConnectedWaveform({ setDisplayMode, setAdjustments, theme }: ConnectedWaveformProps) {
  const { waveform, histogram, activeWaveformChannel, showClipping } = useEditorStore(
    useShallow((state) => ({
      waveform: state.waveform,
      histogram: state.histogram,
      activeWaveformChannel: state.activeWaveformChannel,
      showClipping: state.adjustments.showClipping || false,
    })),
  );

  const onToggleClipping = useCallback(() => {
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      showClipping: !prev.showClipping,
    }));
  }, [setAdjustments]);

  return (
    <Waveform
      waveformData={waveform || null}
      histogram={histogram}
      displayMode={activeWaveformChannel || 'luma'}
      setDisplayMode={setDisplayMode}
      showClipping={showClipping}
      onToggleClipping={onToggleClipping}
      theme={theme}
    />
  );
}
