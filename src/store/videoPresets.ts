import { create } from 'zustand';
import { Panel } from '../types/ui';
import type { Adjustments } from '../utils/adjustments';
import { hasLook, locateItem } from '../utils/video/model';
import { editorTimeOf, getVideo, lookAt, useVideoStore } from './useVideoStore';
import { useUIStore } from './useUIStore';

export const usePresetSource = create<{ source: Adjustments | null }>(() => ({ source: null }));

export const clearPresetSource = () => usePresetSource.setState({ source: null });

useVideoStore.subscribe((state, previous) => {
  if (state.session !== previous.session) clearPresetSource();
});

export const savePresetFromItem = (itemId: string) => {
  const { project, playhead } = getVideo();
  const item = project ? locateItem(project, itemId)?.item : null;
  if (!project || !item || !hasLook(item)) return;
  usePresetSource.setState({ source: lookAt(project, item, editorTimeOf(project, item, playhead)) });
  useUIStore.getState().setPanel(Panel.Presets);
};
