import { create } from 'zustand';
import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useShallow } from 'zustand/react/shallow';
import i18n from 'i18next';
import { toast } from 'react-toastify';
import { Invokes } from '../types/invokes';
import { Panel } from '../types/ui';
import { Caption, Captions } from '../types/video';
import { showError } from '../utils/errors';
import {
  DEFAULT_CAPTION_STYLE,
  SpokenWord,
  appendCaptions,
  captionLineLength,
  captionsFromWords,
  emptyCaptions,
  parseSubtitles,
} from '../utils/video/captions';
import { openedAt } from '../utils/video/nesting';
import { useUIStore } from './useUIStore';
import { editProject, getVideo, setPlayhead, setVideo } from './useVideoStore';
import { VideoTaskHandle, startVideoTask } from './videoJobs';

const SPEECH_MODEL = 'Speech Recognition';
const MIN_REPORTED_DOWNLOAD = 100_000_000;

interface CaptionJob {
  running: boolean;
  stage: 'download' | 'transcribe';
  progress: number;
}

export const editCaptions = (update: (captions: Captions) => Captions, mergeKey?: string) =>
  editProject((project) => ({ ...project, captions: update(project.captions ?? emptyCaptions()) }), mergeKey);

export const editCaptionItems = (update: (items: Array<Caption>) => Array<Caption>, mergeKey?: string) =>
  editCaptions((captions) => ({ ...captions, items: update(captions.items) }), mergeKey);

export const updateCaption = (id: string, patch: Partial<Caption>, mergeKey?: string) =>
  editCaptionItems(
    (items) => items.map((caption) => (caption.id === id ? { ...caption, ...patch } : caption)),
    mergeKey,
  );

export const selectCaption = (caption: Caption) => {
  const { selection, playhead } = getVideo();
  if (selection.length !== 1 || selection[0] !== caption.id) setVideo({ selection: [caption.id] });
  if (playhead < caption.start || playhead >= caption.start + caption.duration) setPlayhead(caption.start);
};

const useCaptionEditStore = create<{ id: string | null }>(() => ({ id: null }));

export const editCaptionText = (caption: Caption) => {
  selectCaption(caption);
  useUIStore.getState().setPanel(Panel.Captions);
  useCaptionEditStore.setState({ id: caption.id });
};

export const useCaptionEditRequest = (id: string) => useCaptionEditStore((state) => state.id === id);

export const clearCaptionEditRequest = () => useCaptionEditStore.setState({ id: null });

const useCaptionJobStore = create<CaptionJob>(() => ({ running: false, stage: 'transcribe', progress: 0 }));

const setCaptionJob = (job: Partial<CaptionJob>) => useCaptionJobStore.setState(job);

export const useCaptionJob = () => useCaptionJobStore(useShallow((state) => state));

const isTranscribing = () => useCaptionJobStore.getState().running;

const confirmReplace = (replace: () => void, append?: () => void) => {
  const count = getVideo().project?.captions?.items.length ?? 0;
  if (count === 0) {
    replace();
    return;
  }
  useUIStore.getState().setUI({
    confirmModalState: {
      isOpen: true,
      title: i18n.t('video.captions.replaceTitle'),
      message: i18n.t('video.captions.replaceMessage', { count }),
      confirmText: i18n.t('video.captions.replace'),
      confirmVariant: 'destructive',
      secondaryText: append && i18n.t('video.captions.append'),
      onConfirm: replace,
      onSecondary: append,
    },
  });
};

export const importCaptionFile = async (path: string) => {
  if (!getVideo().project || isTranscribing()) return;
  const text = await invoke<string>(Invokes.VideoReadSubtitles, { path }).catch((err) => {
    showError('video.captions.importFailed', err, { retry: () => void importCaptionFile(path) });
    return null;
  });
  if (text === null || !getVideo().project || isTranscribing()) return;
  const imported = parseSubtitles(text);
  if (imported.length === 0) {
    toast.error(i18n.t('video.captions.importEmpty'));
    return;
  }
  const apply = (append: boolean) =>
    editCaptions((current) => ({
      ...current,
      enabled: true,
      items: append ? appendCaptions(current.items, imported) : imported,
    }));
  confirmReplace(
    () => apply(false),
    () => apply(true),
  );
};

let activeRun = 0;
let activeTask: VideoTaskHandle | null = null;

const transcribeProject = async () => {
  const { project } = getVideo();
  if (!project || isTranscribing()) return;
  const run = ++activeRun;
  const isCurrent = () => run === activeRun;
  const task = startVideoTask('captions', project.name, cancelTranscription);
  activeTask = task;
  const report = (job: Partial<CaptionJob>) => {
    if (!isCurrent()) return;
    setCaptionJob(job);
    const { stage, progress } = useCaptionJobStore.getState();
    task.update({ progress: stage === 'download' ? null : progress });
  };
  setCaptionJob({ running: true, stage: 'transcribe', progress: 0 });
  const unlisten = await listen<{ name: string; current: number; total: number }>(
    'ai-model-download-progress',
    ({ payload }) => {
      if (payload.name === SPEECH_MODEL && payload.total >= MIN_REPORTED_DOWNLOAD)
        report({ stage: 'download', progress: payload.current / payload.total });
    },
  );
  const onProgress = new Channel<number>();
  onProgress.onmessage = (progress) => report({ stage: 'transcribe', progress });
  try {
    const isReady = await invoke<boolean>(Invokes.VideoSpeechModelReady).catch(() => true);
    if (!isReady) report({ stage: 'download' });
    const words = await invoke<Array<SpokenWord>>(Invokes.VideoTranscribe, { project, onProgress });
    if (!isCurrent()) return;
    if (words.length === 0) {
      task.finish('done');
      toast.info(i18n.t('video.captions.noSpeech'));
      return;
    }
    await document.fonts.ready;
    if (!isCurrent()) return;
    task.finish('done');
    editProject((latest) => {
      const target = openedAt(latest, project.open);
      const { settings, captions } = target;
      const lineLength = captionLineLength(settings.width, settings.height, captions?.style ?? DEFAULT_CAPTION_STYLE);
      const items = captionsFromWords(words, lineLength, settings.fps);
      return openedAt({ ...target, captions: { ...(captions ?? emptyCaptions()), enabled: true, items } }, latest.open);
    });
  } catch (err) {
    if (!isCurrent()) return;
    task.finish('failed', String(err));
    showError('video.captions.failed', err, { retry: generateCaptions });
  } finally {
    unlisten();
    if (isCurrent()) {
      activeTask = null;
      setCaptionJob({ running: false, stage: 'transcribe', progress: 0 });
    }
  }
};

export const generateCaptions = () => {
  if (!getVideo().project || isTranscribing()) return;
  confirmReplace(() => void transcribeProject());
};

export const cancelTranscription = () => {
  if (!isTranscribing()) return;
  activeRun++;
  activeTask?.finish('cancelled');
  activeTask = null;
  setCaptionJob({ running: false, stage: 'transcribe', progress: 0 });
  void invoke(Invokes.VideoCancelTranscription);
};
