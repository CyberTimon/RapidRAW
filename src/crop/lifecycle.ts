import { notifyCropCommit } from './commit';
import { useEditorStore } from '../store/useEditorStore';
import { useUIStore } from '../store/useUIStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { debouncedSave, debouncedSetHistory } from '../hooks/useEditorActions';
import { Panel } from '../components/ui/AppProperties';

let gesture: { cancel: () => void; accept: () => void } | null = null;
export function registerCropGesture(cancel: (() => void) | null, accept?: () => void) {
  gesture = cancel ? { cancel, accept: accept ?? cancel } : null;
}
export function cancelCropGesture() {
  if (!gesture) return false;
  const current = gesture;
  gesture = null;
  current.cancel();
  return true;
}
function acceptCropGesture() {
  const current = gesture;
  gesture = null;
  current?.accept();
}

export function finishCropSession(accept = true) {
  if (accept) acceptCropGesture();
  else cancelCropGesture();
  debouncedSetHistory.flush();
  const before = useEditorStore.getState();
  if (!before.cropSession) return;
  before.finishCrop(accept);
  const after = useEditorStore.getState();
  if (accept && after.selectedImage?.path === before.cropSession.path) {
    notifyCropCommit(after.selectedImage.path, after.adjustments, {
      ...after.adjustments,
      ...before.cropSession.original,
    });
    debouncedSave(after.selectedImage.path, after.adjustments);
    return debouncedSave.flush();
  }
}

export function installCropLifecycle() {
  let transitioning = false;
  const sync = () => {
    if (transitioning) return;
    transitioning = true;
    try {
      const ui = useUIStore.getState();
      const editor = useEditorStore.getState();
      const active = ui.activeView === 'editor' && ui.activePanel === Panel.Crop && editor.selectedImage?.isReady;
      if (!active && editor.cropSession) finishCropSession();
      else if (active && !editor.cropSession) {
        debouncedSetHistory.flush();
        editor.beginCrop();
        const mode = useSettingsStore.getState().appSettings?.cropOverlay;
        if (mode) editor.setEditor({ overlayMode: mode });
      }
    } finally {
      transitioning = false;
    }
  };
  const ui = useUIStore.subscribe(sync);
  // Only image identity/readiness changes can start a session; draft updates cannot restart a cancelled session.
  const editor = useEditorStore.subscribe((next, previous) => {
    if (next.selectedImage !== previous.selectedImage) sync();
  });
  const settings = useSettingsStore.subscribe((next, previous) => {
    if (next.appSettings?.cropOverlay !== previous.appSettings?.cropOverlay) {
      useEditorStore.getState().setEditor({ overlayMode: next.appSettings?.cropOverlay ?? 'thirds' });
    }
  });
  sync();
  return () => {
    ui();
    editor();
    settings();
    cancelCropGesture();
  };
}
