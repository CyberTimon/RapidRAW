import { Suspense } from 'react';
import { useBloc } from '@blac/react';
import { AdjustmentsBloc } from '../../blocs/editor/AdjustmentsBloc.js';
import { CollapsibleSection } from '../../primitives/CollapsibleSection.js';
import { ExposureControls } from '../adjustments/ExposureControls.js';
import { ColorControls } from '../adjustments/ColorControls.js';
import { DetailControls } from '../adjustments/DetailControls.js';
import { EffectsControls } from '../adjustments/EffectsControls.js';
import { HSLControls } from '../adjustments/HSLControls.js';
import { ToneCurves } from '../adjustments/ToneCurves.js';
import { LensCorrections } from '../adjustments/LensCorrections.js';

function LoadingFallback() {
  return (
    <div className="h-20 flex items-center justify-center">
      <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

export function AdjustmentsPanel() {
  const [, bloc] = useBloc(AdjustmentsBloc);

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-2 space-y-2">
        <CollapsibleSection title="Basic" onReset={bloc.resetBasic}>
          <Suspense fallback={<LoadingFallback />}>
            <ExposureControls />
          </Suspense>
        </CollapsibleSection>

        <CollapsibleSection title="Tone Curve" onReset={bloc.resetCurves}>
          <Suspense fallback={<LoadingFallback />}>
            <ToneCurves />
          </Suspense>
        </CollapsibleSection>

        <CollapsibleSection title="Color" onReset={bloc.resetColor}>
          <Suspense fallback={<LoadingFallback />}>
            <ColorControls />
          </Suspense>
        </CollapsibleSection>

        <CollapsibleSection title="Color Mixer" onReset={bloc.resetHSL}>
          <Suspense fallback={<LoadingFallback />}>
            <HSLControls />
          </Suspense>
        </CollapsibleSection>

        <CollapsibleSection title="Detail" onReset={bloc.resetDetail}>
          <Suspense fallback={<LoadingFallback />}>
            <DetailControls />
          </Suspense>
        </CollapsibleSection>

        <CollapsibleSection title="Effects" onReset={bloc.resetEffects}>
          <Suspense fallback={<LoadingFallback />}>
            <EffectsControls />
          </Suspense>
        </CollapsibleSection>

        <CollapsibleSection title="Lens Corrections" defaultOpen={false}>
          <Suspense fallback={<LoadingFallback />}>
            <LensCorrections />
          </Suspense>
        </CollapsibleSection>
      </div>
    </div>
  );
}
