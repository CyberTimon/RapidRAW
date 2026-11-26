import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { AudioLines, Download, Ellipsis, FileUp, Plus, Trash2 } from 'lucide-react';
import FontPicker from '../ui/FontPicker';
import Slider from '../ui/Slider';
import Switch from '../ui/Switch';
import PanelHeader from '../ui/PanelHeader';
import Text from '../ui/Text';
import { TextColors } from '../../types/typography';
import { OPTION_SEPARATOR } from '../../types/ui';
import { Invokes } from '../../types/invokes';
import { Caption, CaptionStyle } from '../../types/video';
import { useContextMenu } from '../../context/ContextMenuContext';
import { getVideo, setPlayhead, useProjectFps, useVideoStore } from '../../store/useVideoStore';
import {
  cancelTranscription,
  clearCaptionEditRequest,
  editCaptionItems,
  editCaptionText,
  editCaptions,
  generateCaptions,
  importCaptionFile,
  selectCaption,
  useCaptionEditRequest,
  useCaptionJob,
} from '../../store/videoCaptions';
import {
  DEFAULT_CAPTION_STYLE,
  SUBTITLE_EXTENSIONS,
  captionAt,
  captionRoom,
  formatSrt,
  formatVtt,
  sortedCaptions,
} from '../../utils/video/captions';
import { minItemDuration } from '../../utils/video/edit';
import { formatTimecode, secondsToTicks, snapTicks } from '../../utils/video/time';
import { showError } from '../../utils/errors';
import { ActionButton, AutoTextArea, ColorRow, FieldRow, InspectorSection } from './inspector/InspectorControls';
import { JobProgress } from './TrackControls';
import { useCaptionText } from './CaptionInspector';

const CAPTION_SECONDS = 2;

const CaptionRow = memo(function CaptionRow({
  caption,
  isActive,
  isSelected,
}: {
  caption: Caption;
  isActive: boolean;
  isSelected: boolean;
}) {
  const { t } = useTranslation();
  const fps = useProjectFps();
  const rowRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const text = useCaptionText(caption);
  const isEditRequested = useCaptionEditRequest(caption.id);
  useEffect(() => {
    if (isActive || isSelected) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [isActive, isSelected]);
  useEffect(() => {
    if (!isEditRequested) return;
    clearCaptionEditRequest();
    textRef.current?.focus();
    textRef.current?.select();
  }, [isEditRequested]);
  return (
    <div
      ref={rowRef}
      className={clsx(
        'group rounded-md px-2.5 py-2 transition-colors',
        isActive || isSelected ? 'bg-card-active' : 'bg-surface hover:bg-card-active',
        isSelected && 'ring-1 ring-accent',
      )}
      onClick={() => selectCaption(caption)}
    >
      <div className="flex items-center gap-2 mb-1">
        <button
          className="text-[11px] tabular-nums text-text-secondary hover:text-text-primary"
          onClick={() => setPlayhead(caption.start)}
        >
          {formatTimecode(caption.start, fps)} – {formatTimecode(caption.start + caption.duration, fps)}
        </button>
        <button
          className="ml-auto p-1 rounded text-text-secondary opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity"
          onClick={(event) => {
            event.stopPropagation();
            editCaptionItems((items) => items.filter((item) => item.id !== caption.id));
          }}
          data-tooltip={t('video.captions.delete')}
          aria-label={t('video.captions.delete')}
        >
          <Trash2 size={13} />
        </button>
      </div>
      <AutoTextArea
        ref={textRef}
        className="w-full bg-transparent text-sm text-text-primary leading-snug outline-hidden"
        rows={1}
        value={text.value}
        onFocus={() => selectCaption(caption)}
        onChange={(event) => text.onChange(event.target.value)}
        onBlur={text.onBlur}
      />
    </div>
  );
});

function CaptionStyleSection() {
  const { t } = useTranslation();
  const style = useVideoStore((s) => s.project?.captions?.style ?? DEFAULT_CAPTION_STYLE);
  const setStyle = (patch: Partial<CaptionStyle>, key: string) =>
    editCaptions((current) => ({ ...current, style: { ...current.style, ...patch } }), `captionStyle:${key}`);
  return (
    <InspectorSection id="captions-style" title={t('video.captions.style')}>
      <FieldRow label={t('video.inspector.font')}>
        <FontPicker value={style.font ?? null} onChange={(font) => setStyle({ font }, 'font')} />
      </FieldRow>
      <Slider
        label={t('video.captions.size')}
        min={2}
        max={12}
        step={0.5}
        value={style.size * 100}
        defaultValue={DEFAULT_CAPTION_STYLE.size * 100}
        suffix="%"
        onChange={(event) => setStyle({ size: Number(event.target.value) / 100 }, 'size')}
      />
      <Slider
        label={t('video.captions.position')}
        min={-50}
        max={50}
        step={1}
        value={Math.round(style.y * 100)}
        defaultValue={DEFAULT_CAPTION_STYLE.y * 100}
        suffix="%"
        onChange={(event) => setStyle({ y: Number(event.target.value) / 100 }, 'y')}
      />
      <ColorRow
        label={t('video.captions.color')}
        value={style.color}
        onChange={(color) => setStyle({ color }, 'color')}
      />
      <div className="flex flex-col gap-3 pt-2">
        <Switch label={t('video.captions.bold')} checked={style.bold} onChange={(bold) => setStyle({ bold }, 'bold')} />
        <Switch
          label={t('video.captions.backdrop')}
          checked={style.backdrop}
          onChange={(backdrop) => setStyle({ backdrop }, 'backdrop')}
        />
      </div>
    </InspectorSection>
  );
}

export default function CaptionsPanel() {
  const { t } = useTranslation();
  const { showContextMenu } = useContextMenu();
  const captions = useVideoStore((s) => s.project?.captions ?? null);
  const selection = useVideoStore((s) => s.selection);
  const fps = useProjectFps();
  const minimum = minItemDuration(fps);
  const captionItems = captions?.items;
  const items = useMemo(() => sortedCaptions(captionItems ?? []), [captionItems]);
  const activeId = useVideoStore((s) => captionAt(items, s.playhead)?.id);
  const canAdd = useVideoStore((s) => captionRoom(items, snapTicks(s.playhead, fps)) >= minimum);
  const job = useCaptionJob();
  const [isModelReady, setIsModelReady] = useState(true);
  useEffect(() => {
    if (job.running) return;
    let alive = true;
    invoke<boolean>(Invokes.VideoSpeechModelReady)
      .then((ready) => alive && setIsModelReady(ready))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [job.running]);
  const percent = Math.round(job.progress * 100);

  const addCaption = () => {
    const start = snapTicks(getVideo().playhead, fps);
    const room = captionRoom(items, start);
    if (room < minimum) return;
    const caption: Caption = {
      id: crypto.randomUUID(),
      start,
      duration: Math.min(room, snapTicks(secondsToTicks(CAPTION_SECONDS), fps)),
      text: t('video.captions.newCaption'),
    };
    editCaptions((current) => ({ ...current, enabled: true, items: [...current.items, caption] }));
    editCaptionText(caption);
  };

  const importFile = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: t('video.captions.subtitles'), extensions: SUBTITLE_EXTENSIONS }],
    });
    if (typeof selected === 'string') await importCaptionFile(selected);
  };

  const writeFile = (path: string, contents: string): Promise<void> =>
    invoke<void>(Invokes.VideoWriteSubtitles, { path, contents }).catch((err) =>
      showError('video.captions.exportFailed', err, { retry: () => void writeFile(path, contents) }),
    );

  const exportFile = async (format: 'srt' | 'vtt') => {
    const target = await save({
      filters: [{ name: t('video.captions.subtitles'), extensions: [format] }],
      defaultPath: `captions.${format}`,
    });
    if (!target) return;
    await writeFile(target, format === 'srt' ? formatSrt(items) : formatVtt(items));
  };

  const openMenu = (event: React.MouseEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    showContextMenu(rect.left, rect.bottom + 4, [
      { icon: FileUp, label: t('video.captions.import'), disabled: job.running, onClick: () => void importFile() },
      { type: OPTION_SEPARATOR },
      {
        icon: Download,
        label: t('video.captions.exportSrt'),
        disabled: items.length === 0,
        onClick: () => void exportFile('srt'),
      },
      {
        icon: Download,
        label: t('video.captions.exportVtt'),
        disabled: items.length === 0,
        onClick: () => void exportFile('vtt'),
      },
    ]);
  };

  return (
    <div className="flex flex-col h-full">
      <PanelHeader title={t('video.captions.title')}>
        {items.length > 0 && (
          <Switch
            label={t('video.captions.show')}
            checked={captions?.enabled ?? false}
            onChange={(enabled) => editCaptions((current) => ({ ...current, enabled }))}
          />
        )}
        <button
          className="p-2 rounded-full hover:bg-surface transition-colors"
          onClick={openMenu}
          data-tooltip={t('video.captions.files')}
          aria-label={t('video.captions.files')}
        >
          <Ellipsis size={18} />
        </button>
      </PanelHeader>
      <div className="grow overflow-y-auto custom-scrollbar p-3 space-y-4">
        <div className="space-y-2">
          {job.running ? (
            <div className="h-9 flex flex-col justify-center">
              <JobProgress
                label={
                  job.stage === 'download'
                    ? t('video.captions.downloading', { percent })
                    : t('video.captions.transcribing', { percent })
                }
                progress={job.progress}
                onCancel={cancelTranscription}
              />
            </div>
          ) : (
            <ActionButton
              icon={AudioLines}
              label={t('video.captions.generate')}
              tooltip={[t('video.captions.generateHint'), !isModelReady && t('video.captions.modelHint')]
                .filter(Boolean)
                .join(' ')}
              onClick={generateCaptions}
            />
          )}
          <ActionButton
            icon={Plus}
            label={t('video.captions.add')}
            disabled={job.running || !canAdd}
            onClick={addCaption}
          />
        </div>
        {items.length === 0 ? (
          <Text color={TextColors.secondary} className="block text-center px-2 py-4">
            {t('video.captions.empty')}
          </Text>
        ) : (
          <>
            <CaptionStyleSection />
            <div className="space-y-1.5">
              {items.map((caption) => (
                <CaptionRow
                  key={caption.id}
                  caption={caption}
                  isActive={caption.id === activeId}
                  isSelected={selection.includes(caption.id)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
