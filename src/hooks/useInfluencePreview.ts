import { useEffect } from 'react';
import { startPreviewPump } from '../utils/previewPump';
import { invoke } from '@tauri-apps/api/core';
import { useEditorStore } from '../store/useEditorStore';
import { useUIStore } from '../store/useUIStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useInfluencePreviewStore } from '../store/useInfluencePreviewStore';
import { prepareAdjustmentsPayload } from '../utils/backendPayload';
import { decodeInfluencePreview } from '../utils/influencePreviewProtocol';
import { curvePointProbe } from '../utils/curvePointProbe';
import { parametricCurveProbe } from '../utils/parametricCurveProbe';
let generation = Date.now() * 1000;
export function useInfluencePreview() {
  const target = useInfluencePreviewStore((s) => s.preview.target);
  const loaded = useInfluencePreviewStore((s) => s.loadedImageGeneration);
  const image = useEditorStore((s) => s.selectedImage?.path);
  const context = useEditorStore((s) =>
    [
      s.activeMaskContainerId,
      s.activeMaskId,
      s.activeAiPatchContainerId,
      s.activeAiSubMaskId,
      s.activeRelightLightId,
      s.compareView,
      !!s.previewOverride,
      s.isWbPickerActive,
    ].join('|'),
  );
  const panel = useUIStore((s) => s.activePanel);
  const view = useUIStore((s) => s.activeView);
  const settings = useSettingsStore((s) => s.appSettings);
  useEffect(() => {
    useInfluencePreviewStore.getState().endDrag();
  }, [image, loaded, context, panel, view, settings]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        useInfluencePreviewStore.getState().endDrag();
        return;
      }
      if (e.key !== 'Alt' && e.key !== 'Control') return;
      const state = useInfluencePreviewStore.getState();
      if (!state.drag) return;
      e.preventDefault();
      state.setAlt(e.altKey && !e.ctrlKey && !e.getModifierState('AltGraph'));
    };
    const end = () => useInfluencePreviewStore.getState().endDrag();
    const hidden = () => {
      if (document.hidden) end();
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('keyup', key, true);
    window.addEventListener('blur', end);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('keyup', key, true);
      window.removeEventListener('blur', end);
      document.removeEventListener('visibilitychange', hidden);
      end();
    };
  }, []);
  useEffect(() => {
    if (!target || loaded === null || !image || view !== 'editor') return;
    let live = true;
    let url: string | null = null;
    const renderSample = async (recipe: ReturnType<typeof useEditorStore.getState>['adjustments']) => {
      if (!live) return;
      const editor = useEditorStore.getState();
      if (editor.compareView !== 'off' || editor.previewOverride || editor.isWbPickerActive) return;
      const store = useInfluencePreviewStore;
      store.getState().dispatch({ type: 'recipeChanged' });
      store.getState().dispatch({ type: 'request', resolution: 960 });
      const identity = store.getState().preview.request;
      if (!identity) return;
      const transport = ++generation;
      const { payload } = prepareAdjustmentsPayload(recipe);
      const scopeId =
        (target.kind === 'parametric' || target.kind === 'curvePoint') && target.scope.kind === 'mask'
          ? target.scope.containerId
          : null;
      const scoped = scopeId ? recipe.masks.find((m) => m.id === scopeId)?.adjustments : recipe;
      const pointProbe =
        target.kind === 'curvePoint' ? curvePointProbe(scoped?.curves?.[target.channel], target.index) : null;
      const parametricProbe =
        target.kind === 'parametric'
          ? parametricCurveProbe(scoped?.parametricCurve?.[target.channel], target.parameter)
          : null;
      const baselineCurve = parametricProbe?.baseline ?? pointProbe?.baseline ?? null;
      const presentation = store.getState().drag?.presentation ?? 0;
      const coverageCurve = parametricProbe?.coverage ?? pointProbe?.coverage ?? null;
      try {
        const buffer = await invoke<ArrayBuffer>('request_influence_preview', {
          request: {
            imagePath: image,
            loadedImageGeneration: loaded,
            clientGeneration: transport,
            identity,
            target,
            targetResolution: 960,
            jsAdjustments: payload,
            presentation,
            coverageCurve,
            selectedControl: store.getState().drag?.control,
            baselineCurve,
          },
        });
        if (!live) return;
        const next = URL.createObjectURL(decodeInfluencePreview(buffer, identity, transport));
        const img = new Image();
        img.src = next;
        try {
          await img.decode();
        } catch (error) {
          URL.revokeObjectURL(next);
          throw error;
        }
        if (!live) {
          URL.revokeObjectURL(next);
          return;
        }
        if (store.getState().publish(identity, next)) {
          if (url) URL.revokeObjectURL(url);
          url = next;
        } else URL.revokeObjectURL(next);
      } catch (error) {
        if (live) {
          if (url) URL.revokeObjectURL(url);
          url = null;
          store.getState().endDrag();
          console.debug('Affected-area preview unavailable', error);
        }
      }
    };
    const stop = startPreviewPump(() => useEditorStore.getState().adjustments, renderSample, console.error);
    return () => {
      live = false;
      stop();
      if (url) URL.revokeObjectURL(url);
      useInfluencePreviewStore.getState().setTransport({ url: null });
      void invoke('cancel_influence_preview', { generation: ++generation, release: true }).catch(console.error);
    };
  }, [target, loaded, image, view]);
}
