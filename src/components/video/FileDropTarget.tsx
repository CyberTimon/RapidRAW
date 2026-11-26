import { useEffect, useRef } from 'react';
import { useDndContext } from '@dnd-kit/core';
import { getCurrentWebview, type DragDropEvent } from '@tauri-apps/api/webview';
import { create } from 'zustand';
import { getDevicePixelRatio } from '../../utils/displayScale';
import { SUBTITLE_EXTENSIONS } from '../../utils/video/captions';
import { useUIStore } from '../../store/useUIStore';
import { addMediaToPool, isImportablePath, useVideoStore } from '../../store/useVideoStore';
import { importCaptionFile } from '../../store/videoCaptions';
import { currentPoolBin } from './mediaPool/poolView';
import { beginDropPreview, dropMediaOnTimeline, endDropPreview, moveDropPreview } from './timeline/drop';

type FileTarget = 'pool' | 'timeline' | null;

const isSubtitlePath = (path: string) =>
  SUBTITLE_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(`.${extension}`));

export const useFileDropTarget = create<{ target: FileTarget }>(() => ({ target: null }));

let media: Array<string> = [];

const setTarget = (target: FileTarget) => {
  const previous = useFileDropTarget.getState().target;
  if (target === previous) return;
  if (previous === 'timeline') endDropPreview();
  if (target === 'timeline') beginDropPreview({ type: 'library-image', paths: media });
  useFileDropTarget.setState({ target });
};

const handleDrag = (event: DragDropEvent, locate: (x: number, y: number) => FileTarget) => {
  if (event.type === 'leave') {
    setTarget(null);
    return;
  }
  if (event.type !== 'over') media = event.paths.filter(isImportablePath);
  const ratio = getDevicePixelRatio();
  const x = event.position.x / ratio;
  const y = event.position.y / ratio;
  const target = media.length > 0 ? locate(x, y) : null;
  setTarget(target);
  if (target === 'timeline') moveDropPreview(x, y);
  if (event.type !== 'drop') return;
  if (target === 'pool') void addMediaToPool(media, currentPoolBin());
  if (target === 'timeline') dropMediaOnTimeline(media, x, y);
  setTarget(null);
  const subtitles = event.paths.find(isSubtitlePath);
  if (subtitles) void importCaptionFile(subtitles);
};

export default function FileDropTarget() {
  const { droppableContainers } = useDndContext();
  const containers = useRef(droppableContainers);
  containers.current = droppableContainers;
  const inProject = useVideoStore((state) => state.session?.kind === 'project');
  const inEditor = useUIStore((state) => state.activeView === 'editor');
  const isActive = inProject && inEditor;

  useEffect(() => {
    if (!isActive) return;
    const locate = (x: number, y: number): FileTarget => {
      const hit = document.elementFromPoint(x, y);
      const contains = (id: string) => !!hit && !!containers.current.get(id)?.node.current?.contains(hit);
      return contains('video-media-pool') ? 'pool' : contains('video-timeline') ? 'timeline' : null;
    };
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => handleDrag(payload, locate));
    return () => {
      void unlisten.then((stop) => stop());
      setTarget(null);
    };
  }, [isActive]);

  return null;
}
