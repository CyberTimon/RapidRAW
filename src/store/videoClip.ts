import i18n from 'i18next';
import { toast } from 'react-toastify';
import { ClipSettings, Ticks } from '../types/video';
import { clipSettingsOf, sequenceDuration, trimRange } from '../utils/video/model';
import { frameTicks, snapTicks, ticksToSeconds } from '../utils/video/time';
import { debouncedSetHistory, useEditorStore } from './useEditorStore';
import { getVideo } from './useVideoStore';
import { pause } from './videoPlayback';

export type TrimEdge = 'in' | 'out';

const toSeconds = (ticks: Ticks) => Math.round(ticksToSeconds(ticks) * 1e6) / 1e6;

const isDefault = (settings: ClipSettings) =>
  settings.in === 0 && settings.out === null && settings.poster === null && !settings.muted;

const sameSettings = (a: ClipSettings, b: ClipSettings) =>
  a.in === b.in && a.out === b.out && a.poster === b.poster && a.muted === b.muted;

const clipContext = () => {
  const { session, project } = getVideo();
  if (session?.kind !== 'clip' || !project || useEditorStore.getState().selectedImage?.path !== session.path) {
    return null;
  }
  return { fps: project.settings.fps, duration: sequenceDuration(project) };
};

const updateClipSettings = (update: (current: ClipSettings) => ClipSettings, label: string) => {
  debouncedSetHistory.flush();
  useEditorStore.getState().setEditor((state) => {
    const current = clipSettingsOf(state.adjustments.video);
    const next = update(current);
    if (sameSettings(current, next)) return state;
    const adjustments = { ...state.adjustments, video: isDefault(next) ? null : next };
    debouncedSetHistory(adjustments, label);
    return { adjustments, ...(state.showOriginal ? { showOriginal: false, previewOverride: null } : {}) };
  });
  debouncedSetHistory.flush();
};

export const setTrim = (edge: TrimEdge, time: Ticks) => {
  const context = clipContext();
  if (!context) return;
  const { fps, duration } = context;
  const gap = frameTicks(fps);
  const snapped = Math.min(Math.max(0, snapTicks(time, fps)), duration);
  pause();
  updateClipSettings((current) => {
    const [start, end] = trimRange(current, duration);
    if (edge === 'in') {
      const next = Math.min(snapped, Math.max(0, duration - gap));
      return { ...current, in: toSeconds(next), out: end - next < gap ? null : current.out };
    }
    const next = Math.max(snapped, gap);
    return {
      ...current,
      out: next >= duration ? null : toSeconds(next),
      in: next - start < gap ? 0 : current.in,
    };
  }, i18n.t('video.clipBar.history.trim'));
};

export const setTrimPoint = (edge: TrimEdge) => {
  const context = clipContext();
  if (!context) return;
  const { playhead } = getVideo();
  setTrim(edge, edge === 'in' ? playhead : playhead + frameTicks(context.fps));
};

export const resetTrim = (edge: TrimEdge) => {
  if (!clipContext()) return;
  pause();
  updateClipSettings(
    (current) => (edge === 'in' ? { ...current, in: 0 } : { ...current, out: null }),
    i18n.t('video.clipBar.history.trim'),
  );
};

export const setPoster = () => {
  if (!clipContext()) return;
  const poster = toSeconds(getVideo().playhead);
  updateClipSettings((current) => ({ ...current, poster }), i18n.t('video.clipBar.thumbnailFrame'));
  toast.success(i18n.t('video.clipBar.thumbnailSet'));
};

export const toggleClipMute = () => {
  if (!clipContext()) return;
  const muted = !clipSettingsOf(useEditorStore.getState().adjustments.video).muted;
  updateClipSettings(
    (current) => ({ ...current, muted }),
    i18n.t(muted ? 'video.clipBar.mute' : 'video.clipBar.unmute'),
  );
};
