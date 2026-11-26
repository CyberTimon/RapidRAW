import { useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';
import { CheckCircle, Clapperboard, Film, FolderOpen, Link2, Link2Off, XCircle } from 'lucide-react';
import Button from '../../ui/Button';
import Dropdown from '../../ui/Dropdown';
import ExportButton from '../../ui/ExportButton';
import PanelSection from '../../ui/PanelSection';
import SegmentedControl from '../../ui/SegmentedControl';
import Text from '../../ui/Text';
import ValidatedNumberInput from '../../ui/ValidatedNumberInput';
import { useParsedTextField } from '../../ui/ColorField';
import { IconToggle } from '../../video/inspector/InspectorControls';
import { TextColors, TextVariants } from '../../../types/typography';
import { Invokes } from '../../../types/invokes';
import { editProject, ensureMedia, fileStem, isPlaceholderPath, useVideoStore } from '../../../store/useVideoStore';
import { withCanvasSize } from '../../../store/videoReframe';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { DynamicRange, RateControl, VideoExportPreset, VideoResolution } from '../../../types/video';
import {
  AUDIO_BITRATES,
  AUDIO_CODECS,
  DYNAMIC_RANGES,
  LOUDNESS_TARGETS,
  MAX_BITRATE_MBPS,
  MAX_EXPORT_SIZE,
  MIN_EXPORT_SIZE,
  ORIGINAL_FRAME_RATE,
  VIDEO_CODECS,
  VIDEO_CONTAINERS,
  VIDEO_EXPORT_PRESETS,
  VIDEO_QUALITIES,
  VIDEO_RESOLUTIONS,
  VideoExportTarget,
  VideoOutputOptions,
  applyVideoExportPreset,
  audioBitsPerSecond,
  cancelVideoExport,
  changeVideoExport,
  exportFrameRate,
  exportProjectVideo,
  exportVideos,
  isVideoExportBusy,
  loadVideoEncoders,
  outputCanvas,
  presetOf,
  rememberVideoExportSettings,
  restoreVideoExportSettings,
  supportsBitrate,
  supportsHdr,
  useVideoExportStore,
  videoBitsPerSecond,
} from '../../../store/videoExport';
import {
  allItems,
  canvasSize,
  even,
  fileName,
  mediaPathOf,
  sameRatio,
  sequenceDuration,
} from '../../../utils/video/model';
import {
  FRAME_RATES,
  formatDuration,
  formatTimecode,
  fpsValue,
  roundFps,
  secondsToTicks,
  ticksToSeconds,
} from '../../../utils/video/time';
import { formatBytes } from '../../../utils/formatBytes';

interface VideoExportSectionProps {
  target: VideoExportTarget;
  output: VideoOutputOptions;
  onExportStarted(folder: string | null): void;
  notice?: ReactNode;
  children?: ReactNode;
}

interface SourceSummary {
  width: number;
  height: number;
  fps: number;
  seconds: number;
  hasAudio: boolean;
}

const showInFolder = (path: string) => invoke(Invokes.ShowInFinder, { path }).catch(console.error);

const parseSize = (text: string) => {
  const value = Number(text.trim());
  return Number.isInteger(value) && value >= MIN_EXPORT_SIZE && value <= MAX_EXPORT_SIZE ? value : null;
};

const parseBitrate = (text: string) => {
  const value = Number(text.trim().replace(',', '.'));
  return Number.isFinite(value) && value > 0 && value <= MAX_BITRATE_MBPS ? value : null;
};

function FieldLabel({ children }: { children: string }) {
  return (
    <Text variant={TextVariants.label} className="mb-1 block">
      {children}
    </Text>
  );
}

export default function VideoExportSection({
  target,
  output,
  onExportStarted,
  notice,
  children,
}: VideoExportSectionProps) {
  const { t } = useTranslation();
  const settings = useVideoExportStore(
    useShallow((state) => ({
      preset: state.preset,
      codec: state.codec,
      container: state.container,
      rateControl: state.rateControl,
      quality: state.quality,
      bitrate: state.bitrate,
      resolution: state.resolution,
      width: state.width,
      height: state.height,
      lockAspect: state.lockAspect,
      frameRate: state.frameRate,
      audioCodec: state.audioCodec,
      audioBitrate: state.audioBitrate,
      dynamicRange: state.dynamicRange,
      loudness: state.loudness,
    })),
  );
  const { status, current, total, frame, frames, stage, label, outputs, errors, encoders, span } = useVideoExportStore(
    useShallow((state) => ({
      status: state.status,
      current: state.current,
      total: state.total,
      frame: state.frame,
      frames: state.frames,
      stage: state.stage,
      label: state.label,
      outputs: state.outputs,
      errors: state.errors,
      encoders: state.encoders,
      span: state.span,
    })),
  );
  const { preset, codec, container, rateControl, quality, resolution, lockAspect, frameRate, audioCodec } = settings;
  const savedSettings = useSettingsStore((state) => state.appSettings?.videoExport);
  const project = useVideoStore((state) => (target.kind === 'project' ? state.project : null));
  const sourcePaths = useMemo(
    () => (target.kind === 'project' ? (project?.media.map((media) => media.path) ?? []) : target.paths),
    [target, project?.media],
  );
  const hasHdrSource = useVideoStore((state) => sourcePaths.some((path) => state.media[path]?.hdr));
  const source = useVideoStore(
    useShallow((state): SourceSummary | null => {
      if (target.kind === 'project') {
        if (!project) return null;
        const range = span === 'range' ? project.range : null;
        return {
          width: project.settings.width,
          height: project.settings.height,
          fps: fpsValue(project.settings.fps),
          seconds: ticksToSeconds(range ? range.end - range.start : sequenceDuration(project)),
          hasAudio: allItems(project).some(
            (item) =>
              item.type === 'audio' ||
              (item.type === 'clip' && !item.muted && !!state.media[mediaPathOf(project, item) ?? '']?.hasAudio),
          ),
        };
      }
      const infos = target.paths.map((path) => state.media[path]);
      const first = infos[0];
      if (!first || first.width <= 0) return null;
      return {
        width: first.width,
        height: first.height,
        fps: first.fps,
        seconds: infos.reduce((sum, info) => sum + (info?.duration ?? 0), 0),
        hasAudio: infos.some((info) => info?.hasAudio),
      };
    }),
  );

  useEffect(() => loadVideoEncoders(), []);
  useEffect(() => restoreVideoExportSettings(savedSettings), [savedSettings]);
  useEffect(() => {
    const local = sourcePaths.filter((path) => !isPlaceholderPath(path));
    if (local.length > 0) void ensureMedia(local);
  }, [sourcePaths]);

  const ratio = source ? source.width / source.height : 16 / 9;
  const shownHeight = lockAspect ? even(settings.width / ratio) : settings.height;
  const widthField = useParsedTextField(settings.width, (width) => changeVideoExport({ width }), parseSize);
  const heightField = useParsedTextField(
    shownHeight,
    (height) => changeVideoExport(lockAspect ? { width: Math.round(height * ratio) } : { height }),
    parseSize,
  );
  const bitrateField = useParsedTextField(settings.bitrate, (bitrate) => changeVideoExport({ bitrate }), parseBitrate);

  const hdrCodecs = VIDEO_CODECS.filter((option) => supportsHdr(option.id, encoders)).map((option) => option.id);
  const isHdr = hasHdrSource && settings.dynamicRange !== 'sdr' && supportsHdr(codec, encoders);
  const changeDynamicRange = (next: DynamicRange) => {
    const switchCodec = next !== 'sdr' && !supportsHdr(codec, encoders) && hdrCodecs.length > 0;
    changeVideoExport({ dynamicRange: next, ...(switchCodec ? { codec: hdrCodecs[0] } : {}) });
  };
  const codecAvailable = (id: string) => !encoders || encoders.some((encoder) => encoder.codec === id);
  const presetSpec = presetOf(preset);
  const aspect = presetSpec?.aspect ? presetSpec.aspect.join(':') : '';
  const presetRatio = presetSpec?.aspect ? presetSpec.aspect[0] / presetSpec.aspect[1] : null;
  const canvasRatio =
    presetRatio !== null &&
    project &&
    target.kind === 'project' &&
    !sameRatio(project.settings.width / project.settings.height, presetRatio)
      ? presetRatio
      : null;
  const matchCanvas = (nextRatio: number) =>
    editProject((edited) =>
      withCanvasSize(edited, canvasSize(nextRatio, Math.min(edited.settings.width, edited.settings.height))),
    );

  const canvas = source ? outputCanvas(source.width, source.height, settings) : null;
  const explicitRate = exportFrameRate(frameRate);
  const maxFps = presetSpec?.maxFps ?? null;
  const sourceFps = source?.fps ?? 0;
  const outputFps = explicitRate
    ? fpsValue(explicitRate)
    : maxFps && sourceFps > maxFps
      ? sourceFps / Math.ceil(sourceFps / maxFps)
      : sourceFps;
  const bitrateSupported = supportsBitrate(codec);
  const usesBitrate = bitrateSupported && rateControl === 'bitrate';
  const estimatedBytes =
    canvas && source && outputFps > 0
      ? ((videoBitsPerSecond(settings, canvas.width * canvas.height * outputFps) +
          (source.hasAudio ? audioBitsPerSecond(settings) : 0)) *
          source.seconds) /
        8
      : null;

  const busy = isVideoExportBusy(status);
  const count = target.kind === 'videos' ? target.paths.length : 1;
  const canExport =
    (target.kind === 'videos' ? count > 0 : (project ? sequenceDuration(project) : 0) > 0) &&
    (resolution !== 'custom' || (widthField.parsed !== null && heightField.parsed !== null)) &&
    (!usesBitrate || bitrateField.parsed !== null);
  const itemProgress = frames > 0 ? Math.min(1, frame / frames) : 0;
  const overallProgress = total > 0 ? (current + itemProgress) / total : 0;
  const percent = Math.round(itemProgress * 100);

  const changeResolution = (next: VideoResolution) => {
    if (next === 'custom' && canvas) {
      changeVideoExport({ resolution: next, width: canvas.width, height: canvas.height });
    } else {
      changeVideoExport({ resolution: next });
    }
  };
  const changeRateControl = (next: RateControl) => {
    if (next === 'bitrate' && canvas && outputFps > 0) {
      const suggested = videoBitsPerSecond(
        { ...settings, rateControl: 'quality' },
        canvas.width * canvas.height * outputFps,
      );
      changeVideoExport({ rateControl: next, bitrate: Math.max(1, Math.round(suggested / 1e6)) });
    } else {
      changeVideoExport({ rateControl: next });
    }
  };
  const toggleLock = () =>
    changeVideoExport(lockAspect ? { lockAspect: false, height: shownHeight } : { lockAspect: true });

  const handleExport = async () => {
    const started =
      target.kind === 'project' ? await exportProjectVideo(output) : await exportVideos(target.paths, output);
    if (!started) return;
    onExportStarted(started.folder);
    rememberVideoExportSettings();
  };

  const summaryTitle =
    target.kind === 'project'
      ? `${project?.name ?? ''}.${container}`
      : count === 1
        ? `${fileStem(target.paths[0])}.${container}`
        : t('video.export.videoCount', { count });
  const summaryDetails =
    canvas && source
      ? [
          `${canvas.width} × ${canvas.height}`,
          outputFps > 0 ? t('video.export.fps', { fps: roundFps(outputFps) }) : null,
          formatDuration(secondsToTicks(source.seconds)),
        ]
          .filter(Boolean)
          .join(' · ')
      : null;

  return (
    <>
      <div className="grow overflow-y-auto p-3 space-y-8">
        {notice}
        <div className="flex items-center gap-3 px-3 py-2.5 rounded-md bg-surface">
          {target.kind === 'project' ? (
            <Clapperboard size={16} className="shrink-0 text-text-secondary" />
          ) : (
            <Film size={16} className="shrink-0 text-text-secondary" />
          )}
          <div className="min-w-0 flex-1">
            <Text color={TextColors.primary} className="truncate block">
              {summaryTitle}
            </Text>
            {summaryDetails && (
              <Text variant={TextVariants.small} className="truncate block tabular-nums">
                {summaryDetails}
              </Text>
            )}
          </div>
        </div>
        {target.kind === 'project' && project && sequenceDuration(project) <= 0 && (
          <Text variant={TextVariants.small}>{t('video.export.emptyTimeline')}</Text>
        )}

        <PanelSection title={t('video.export.sections.preset')}>
          <Dropdown<VideoExportPreset>
            className="w-full"
            options={[
              { value: 'custom', label: t('video.export.preset.custom') },
              ...VIDEO_EXPORT_PRESETS.map((entry) => ({
                value: entry.id,
                label: t(`video.export.preset.${entry.id}`),
                disabled: !codecAvailable(entry.settings.codec),
              })),
            ]}
            value={preset}
            disabled={busy}
            onChange={applyVideoExportPreset}
          />
          {presetSpec && (
            <Text variant={TextVariants.small}>
              {presetSpec.aspect && presetSpec.maxFps
                ? t('video.export.presetHint', { aspect, fps: presetSpec.maxFps })
                : t('video.export.archiveHint')}
            </Text>
          )}
          {canvasRatio !== null && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-surface">
              <Text variant={TextVariants.small} className="min-w-0">
                {t('video.export.aspectMismatch', { aspect })}
              </Text>
              <Button
                className="ml-auto shrink-0 py-1 px-2.5 text-xs"
                disabled={busy}
                onClick={() => matchCanvas(canvasRatio)}
              >
                {t('video.export.useAspect', { aspect })}
              </Button>
            </div>
          )}
        </PanelSection>

        <PanelSection title={t('video.export.sections.format')}>
          <SegmentedControl
            options={VIDEO_CODECS.map((option) => {
              const unavailable = !codecAvailable(option.id);
              const noHdr = isHdr && !supportsHdr(option.id, encoders);
              return {
                ...option,
                disabled: unavailable || noHdr,
                tooltip: unavailable
                  ? t('video.export.codecUnavailable')
                  : noHdr
                    ? t('video.export.codecNoHdr')
                    : undefined,
              };
            })}
            value={codec}
            disabled={busy}
            onChange={(value) => changeVideoExport({ codec: value })}
          />
          <div>
            <FieldLabel>{t('video.export.container')}</FieldLabel>
            <Dropdown
              className="w-full"
              options={VIDEO_CONTAINERS[codec].map((id) => ({ value: id, label: t(`video.export.containers.${id}`) }))}
              value={container}
              disabled={busy}
              onChange={(value) => changeVideoExport({ container: value })}
            />
          </div>
          {encoders?.some((encoder) => encoder.codec === codec && encoder.hardware) && (
            <Text variant={TextVariants.small}>{t('video.export.hardwareEncoding')}</Text>
          )}
        </PanelSection>

        <PanelSection title={t('video.export.sections.quality')}>
          {bitrateSupported && (
            <SegmentedControl<RateControl>
              options={[
                {
                  id: 'quality',
                  label: t('video.export.rateControl.quality'),
                  tooltip: t('video.export.rateControlHint.quality'),
                },
                {
                  id: 'bitrate',
                  label: t('video.export.rateControl.bitrate'),
                  tooltip: t('video.export.rateControlHint.bitrate'),
                },
              ]}
              value={rateControl}
              disabled={busy}
              onChange={changeRateControl}
            />
          )}
          {usesBitrate ? (
            <div className="flex items-center gap-2">
              <Text variant={TextVariants.label} className="flex-1">
                {t('video.export.bitrate')}
              </Text>
              <ValidatedNumberInput
                ariaLabel={t('video.export.bitrate')}
                disabled={busy}
                field={bitrateField}
                max={MAX_BITRATE_MBPS}
              />
              <Text variant={TextVariants.label}>{t('video.export.mbps')}</Text>
            </div>
          ) : (
            <SegmentedControl
              options={VIDEO_QUALITIES.map((id) => ({
                id,
                label: t(codec === 'proRes' ? `video.export.proResQuality.${id}` : `video.export.quality.${id}`),
              }))}
              value={quality}
              disabled={busy}
              onChange={(value) => changeVideoExport({ quality: value })}
            />
          )}
        </PanelSection>

        <PanelSection title={t('video.export.sections.resolution')}>
          <SegmentedControl
            options={VIDEO_RESOLUTIONS.map((id) => ({
              id,
              label:
                id === 'original'
                  ? t('video.export.original')
                  : id === 'custom'
                    ? t('video.export.preset.custom')
                    : `${id}p`,
            }))}
            value={resolution}
            disabled={busy}
            onChange={changeResolution}
          />
          {resolution === 'custom' && (
            <div className="flex items-center gap-2">
              <Text variant={TextVariants.label} className="flex-1">
                {t('video.export.size')}
              </Text>
              <ValidatedNumberInput
                ariaLabel={t('video.export.width')}
                disabled={busy}
                field={widthField}
                max={MAX_EXPORT_SIZE}
              />
              <IconToggle
                icon={lockAspect ? Link2 : Link2Off}
                label={t('video.export.lockAspect')}
                isActive={lockAspect}
                onClick={toggleLock}
              />
              <ValidatedNumberInput
                ariaLabel={t('video.export.height')}
                disabled={busy}
                field={heightField}
                max={MAX_EXPORT_SIZE}
              />
            </div>
          )}
        </PanelSection>

        <PanelSection title={t('video.export.sections.frameRate')}>
          <Dropdown
            className="w-full"
            options={[
              {
                value: ORIGINAL_FRAME_RATE,
                label:
                  sourceFps > 0
                    ? t('video.export.originalRate', { fps: roundFps(sourceFps) })
                    : t('video.export.original'),
              },
              ...FRAME_RATES.map((entry) => ({
                value: entry.label,
                label: t('video.export.fps', { fps: entry.label }),
              })),
            ]}
            value={frameRate}
            disabled={busy}
            onChange={(value) => changeVideoExport({ frameRate: value })}
          />
        </PanelSection>

        {project?.range && target.kind === 'project' && (
          <PanelSection title={t('video.export.sections.span')}>
            <SegmentedControl
              options={[
                { id: 'all' as const, label: t('video.export.span.all') },
                {
                  id: 'range' as const,
                  label: t('video.export.span.range', {
                    from: formatTimecode(project.range.start, project.settings.fps),
                    to: formatTimecode(project.range.end, project.settings.fps),
                  }),
                },
              ]}
              value={span}
              disabled={busy}
              onChange={(value) => useVideoExportStore.setState({ span: value })}
            />
          </PanelSection>
        )}

        {hasHdrSource && (
          <PanelSection title={t('video.export.sections.dynamicRange')}>
            <SegmentedControl
              options={DYNAMIC_RANGES.map((id) => ({
                id,
                label: t(`video.export.dynamicRange.${id}`),
                tooltip: t(`video.export.dynamicRangeHint.${id}`),
                disabled: id !== 'sdr' && hdrCodecs.length === 0,
              }))}
              value={settings.dynamicRange}
              disabled={busy}
              onChange={changeDynamicRange}
            />
          </PanelSection>
        )}

        <PanelSection title={t('video.export.sections.audio')}>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <FieldLabel>{t('video.export.audioCodec')}</FieldLabel>
              <Dropdown
                className="w-full"
                options={AUDIO_CODECS[container].map((id) => ({
                  value: id,
                  label: t(`video.export.audioCodecs.${id}`),
                }))}
                value={audioCodec}
                disabled={busy}
                onChange={(value) => changeVideoExport({ audioCodec: value })}
              />
            </div>
            {audioCodec !== 'pcm' && (
              <div>
                <FieldLabel>{t('video.export.bitrate')}</FieldLabel>
                <Dropdown
                  className="w-full"
                  options={AUDIO_BITRATES.map((value) => ({ value, label: t('video.export.kbps', { value }) }))}
                  value={settings.audioBitrate}
                  disabled={busy}
                  onChange={(value) => changeVideoExport({ audioBitrate: value })}
                />
              </div>
            )}
          </div>
        </PanelSection>

        <PanelSection title={t('video.export.sections.loudness')}>
          <SegmentedControl
            options={LOUDNESS_TARGETS.map((entry) => ({
              id: entry.id,
              label: entry.lufs === null ? t('video.export.loudness.off') : `−${Math.abs(entry.lufs)} LUFS`,
              tooltip: t(`video.export.loudnessHint.${entry.id}`),
            }))}
            value={settings.loudness}
            disabled={busy}
            onChange={(value) => changeVideoExport({ loudness: value })}
          />
        </PanelSection>

        {children}
      </div>

      <div className="p-3 border-t border-surface shrink-0 space-y-2">
        {busy && (
          <Text variant={TextVariants.small} className="truncate">
            {label}
          </Text>
        )}
        {!busy && outputs.length > 0 && (
          <button
            className="w-full flex items-center gap-2 text-left px-3 py-2 rounded-md bg-surface hover:bg-card-active transition-colors"
            onClick={() => showInFolder(outputs[outputs.length - 1])}
            data-tooltip={t('contextMenus.thumbnail.showExplorer')}
          >
            <CheckCircle size={14} className="text-green-400 shrink-0" />
            <Text variant={TextVariants.small} color={TextColors.primary} className="truncate">
              {outputs.length === 1 ? fileName(outputs[0]) : t('video.export.exported', { count: outputs.length })}
            </Text>
            <FolderOpen size={14} className="ml-auto shrink-0 text-text-secondary" />
          </button>
        )}
        {!busy &&
          errors.map(({ message, kept }) => {
            const Row = kept ? 'button' : 'div';
            return (
              <Row
                key={message}
                className={`w-full flex items-start gap-2 text-left px-3 py-2 rounded-md bg-surface${kept ? ' hover:bg-card-active transition-colors' : ''}`}
                onClick={kept ? () => showInFolder(kept) : undefined}
                data-tooltip={kept ? t('contextMenus.thumbnail.showExplorer') : undefined}
              >
                <XCircle size={14} className="text-red-400 shrink-0 mt-0.5" />
                <Text variant={TextVariants.small} className="break-words min-w-0">
                  {message}
                </Text>
                {kept && <FolderOpen size={14} className="ml-auto shrink-0 mt-0.5 text-text-secondary" />}
              </Row>
            );
          })}
        {!busy && estimatedBytes !== null && (
          <Text as="div" variant={TextVariants.small} color={TextColors.primary} className="text-center">
            {count > 1
              ? t('export.status.estimatedTotalSize', { size: formatBytes(estimatedBytes, t) })
              : t('export.status.estimatedSize', { size: formatBytes(estimatedBytes, t) })}
          </Text>
        )}
        <ExportButton
          status={status}
          progress={busy ? overallProgress : null}
          canExport={canExport}
          icon={Clapperboard}
          label={count > 1 ? t('video.export.buttonMultiple', { count }) : t('video.export.button')}
          progressLabel={
            stage === 'measuring'
              ? t('video.export.measuring', { percent })
              : stage === 'uploading'
                ? t('video.export.uploading', { percent })
                : total > 1
                  ? t('video.export.progressBatch', { current: current + 1, total, percent })
                  : t('video.export.progress', { percent })
          }
          onExport={() => void handleExport()}
          onCancel={cancelVideoExport}
        />
      </div>
    </>
  );
}
