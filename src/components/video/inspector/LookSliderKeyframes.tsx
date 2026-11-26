import { ReactNode, useMemo } from 'react';
import { AdjustmentItem, ClipItem, VideoProject } from '../../../types/video';
import { SliderKeyframeContext, SliderKeyframes } from '../../../context/SliderKeyframeContext';
import { useVideoStore } from '../../../store/useVideoStore';
import { liveLookValue, subscribeLiveLook } from '../../../store/videoLiveLook';
import { INITIAL_ADJUSTMENTS } from '../../../utils/adjustments';
import { isAnimatablePath } from '../../../utils/video/lookAnimation';
import { KeyframeControls } from './InspectorControls';
import { useEditorLookItem, useLookKeyframes } from './LookKeyframes';

function LookValueKeyframe({
  item,
  project,
  paths,
}: {
  item: ClipItem | AdjustmentItem;
  project: VideoProject;
  paths: Array<string>;
}) {
  const keyframes = useLookKeyframes(item, project, paths);
  if (!paths.every((path) => isAnimatablePath(keyframes.look ?? INITIAL_ADJUSTMENTS, path))) return null;
  return (
    <div className="absolute top-0 right-14 h-5 pr-1 flex items-center">
      <KeyframeControls
        animated={keyframes.animated}
        onKey={keyframes.onKey}
        onPrevious={keyframes.onPrevious}
        onNext={keyframes.onNext}
        onToggle={() => keyframes.toggle(keyframes.onKey)}
        ease={keyframes.ease}
      />
    </div>
  );
}

function SliderKeyframe({ paths }: { paths: Array<string> }) {
  const target = useEditorLookItem();
  return target && <LookValueKeyframe item={target.item} project={target.project} paths={paths} />;
}

export default function LookSliderKeyframes({ prefix = '', children }: { prefix?: string; children: ReactNode }) {
  const isProject = useVideoStore((state) => state.session?.kind === 'project');
  const keyframes = useMemo<SliderKeyframes | null>(
    () =>
      isProject
        ? {
            render: (keys) => <SliderKeyframe paths={[keys].flat().map((key) => `${prefix}${key}`)} />,
            subscribe: subscribeLiveLook,
            valueOf: (key) => liveLookValue(`${prefix}${key}`),
          }
        : null,
    [isProject, prefix],
  );
  return <SliderKeyframeContext.Provider value={keyframes}>{children}</SliderKeyframeContext.Provider>;
}
