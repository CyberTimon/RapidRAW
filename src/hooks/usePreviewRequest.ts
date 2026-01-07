import { useCallback } from 'react';
import { useBlocActions } from '@blac/react';
import { PreviewBloc } from '../blocs/editor/PreviewBloc';

export function usePreviewRequest() {
  const previewBloc = useBlocActions(PreviewBloc);

  const requestPreview = useCallback(() => {
    previewBloc.requestPreview();
  }, [previewBloc]);

  const requestPreviewImmediate = useCallback(() => {
    previewBloc.requestPreview(true);
  }, [previewBloc]);

  return { requestPreview, requestPreviewImmediate };
}
