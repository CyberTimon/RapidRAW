import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Caption } from '../../types/video';
import { getVideo, useProjectFps } from '../../store/useVideoStore';
import { updateCaption } from '../../store/videoCaptions';
import { captionLimits } from '../../utils/video/captions';
import { minItemDuration } from '../../utils/video/edit';
import { InspectorSection, TextBox, TimecodeRow } from './inspector/InspectorControls';

export const useCaptionText = (caption: Caption) => {
  const [blank, setBlank] = useState<string | null>(null);
  return {
    value: blank ?? caption.text,
    onChange: (text: string) => {
      const isBlank = !text.trim();
      setBlank(isBlank ? text : null);
      if (!isBlank) updateCaption(caption.id, { text }, `caption:${caption.id}`);
    },
    onBlur: () => setBlank(null),
  };
};

export default function CaptionInspector({ caption }: { caption: Caption }) {
  const { t } = useTranslation();
  const fps = useProjectFps();
  const text = useCaptionText(caption);
  const minimum = minItemDuration(fps);
  const end = caption.start + caption.duration;
  const limits = () => captionLimits(getVideo().project?.captions?.items ?? [], caption.id);

  const setStart = (value: number) => {
    const start = Math.min(end - minimum, Math.max(limits().earliest, value));
    if (start !== caption.start) updateCaption(caption.id, { start, duration: end - start });
  };

  const setEnd = (value: number) => {
    const next = Math.max(caption.start + minimum, Math.min(limits().latest, value));
    if (next !== end) updateCaption(caption.id, { duration: next - caption.start });
  };

  return (
    <>
      <InspectorSection id="caption" title={t('video.inspector.text')}>
        <TextBox value={text.value} onChange={text.onChange} onBlur={text.onBlur} />
      </InspectorSection>
      <InspectorSection id="timing" title={t('video.inspector.timing')}>
        <TimecodeRow label={t('video.inspector.start')} value={caption.start} fps={fps} onChange={setStart} />
        <TimecodeRow label={t('video.inspector.end')} value={end} fps={fps} onChange={setEnd} />
      </InspectorSection>
    </>
  );
}
