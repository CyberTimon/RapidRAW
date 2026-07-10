import { useImageProcessing } from '../../hooks/useImageProcessing';

interface Props {
  transformWrapperRef: React.RefObject<any>;
  prevAdjustmentsRef: React.RefObject<any>;
  previewJobIdRef: React.RefObject<number>;
  latestRenderedJobIdRef: React.RefObject<number>;
  currentResRef: React.RefObject<number>;
  isAndroid: boolean;
}

export default function ImageProcessingManager(props: Props) {
  useImageProcessing(props.transformWrapperRef, props.prevAdjustmentsRef, {
    previewJobIdRef: props.previewJobIdRef,
    latestRenderedJobIdRef: props.latestRenderedJobIdRef,
    currentResRef: props.currentResRef,
  }, props.isAndroid);

  return null;
}
