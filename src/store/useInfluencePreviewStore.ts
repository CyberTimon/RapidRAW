import type { AltPreviewPresentation } from '../utils/altPreviewPolicy';
import type { InfluenceTarget } from '../utils/influencePreview';
import { create } from 'zustand';
import {
  initialInfluenceState,
  reduceInfluenceState,
  type InfluenceEvent,
  type InfluenceState,
} from '../utils/influencePreviewState';

interface InfluencePreviewStore {
  preview: InfluenceState;
  drag: { target: InfluenceTarget; presentation: AltPreviewPresentation; control?: string } | null;
  beginDrag(
    target: InfluenceTarget | null,
    alt: boolean,
    presentation?: AltPreviewPresentation,
    control?: string,
  ): void;
  endDrag(): void;
  setAlt(active: boolean): void;
  loadedImageGeneration: number | null;
  url: string | null;
  subcontrols: Record<string, string>;
  rememberSubcontrol(owner: string, key: string): void;
  publish(identity: import('../utils/influencePreviewState').InfluenceIdentity, url: string): boolean;
  setTransport(values: { loadedImageGeneration?: number | null; url?: string | null }): void;
  dispatch(event: InfluenceEvent): void;
}

/** Session-local. Never include this store in recipes, history or persistence. */
export const useInfluencePreviewStore = create<InfluencePreviewStore>((set) => ({
  preview: initialInfluenceState(),
  drag: null,
  beginDrag: (target, alt, presentation = 0, control) =>
    set((s) => ({
      drag: target ? { target, presentation, control } : null,
      url: null,
      preview:
        target && alt
          ? reduceInfluenceState(s.preview, { type: 'activate', target })
          : reduceInfluenceState(s.preview, { type: 'clear' }),
    })),
  endDrag: () => set((s) => ({ drag: null, url: null, preview: reduceInfluenceState(s.preview, { type: 'clear' }) })),
  setAlt: (active) =>
    set((s) =>
      (active && s.preview.target !== null) || (!active && s.preview.target === null)
        ? s
        : {
            url: null,
            preview:
              active && s.drag
                ? reduceInfluenceState(s.preview, { type: 'activate', target: s.drag.target })
                : reduceInfluenceState(s.preview, { type: 'clear' }),
          },
    ),
  loadedImageGeneration: null,
  url: null,
  subcontrols: {},
  rememberSubcontrol: (owner, key) =>
    set((s) => (s.subcontrols[owner] === key ? s : { subcontrols: { ...s.subcontrols, [owner]: key } })),
  publish: (identity, url) => {
    let accepted = false;
    set((s) => {
      const preview = reduceInfluenceState(s.preview, { type: 'resolved', identity });
      accepted = preview.result === identity;
      return accepted ? { preview, url } : s;
    });
    return accepted;
  },
  setTransport: (values) => set(values),
  dispatch: (event) => set((state) => ({ preview: reduceInfluenceState(state.preview, event) })),
}));
