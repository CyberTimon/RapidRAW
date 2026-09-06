/**
 * Bridges the external control server (src-tauri/src/external_control.rs) to the editor.
 *
 * Inbound: `external-control-command` events carry one JSON message each from a connected
 * controller. They are interpreted here, on top of the same `setAdjustments` path the UI
 * sliders use, so undo history, auto-save, multi-select sync and live previews all behave
 * exactly as if the user had dragged a slider.
 *
 * Outbound: a throttled `state` snapshot is published whenever the adjustments, selected
 * image, view or history change, so a controller can show current values on its dials.
 *
 * Message vocabulary: docs/EXTERNAL_CONTROL_API.md
 */

import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import throttle from 'lodash.throttle';
import { useEditorStore } from '../store/useEditorStore';
import { useUIStore } from '../store/useUIStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { useEditorActions } from './useEditorActions';
import {
  CONTROL_PARAMS,
  EXTERNAL_CONTROL_COMMAND_EVENT,
  EXTERNAL_CONTROL_PROTOCOL,
  getControlParam,
  listControlActions,
  normalizeParamValue,
  readParamValue,
  runControlAction,
  snapshotParams,
  writePath,
} from '../utils/externalControl';

const PUBLISH_INTERVAL_MS = 33;
/** A dial that stops sending ticks for this long is considered released. */
const AUTO_TRACKING_RELEASE_MS = 180;

type ControlMessage = { type?: unknown; ref?: unknown; _seq?: unknown; [key: string]: unknown };

const publish = (message: Record<string, unknown>) => {
  invoke('external_control_publish', { message }).catch((err) => {
    console.warn('External control publish failed:', err);
  });
};

const buildState = () => {
  const editor = useEditorStore.getState();
  const ui = useUIStore.getState();
  const library = useLibraryStore.getState();
  const path = editor.selectedImage?.path ?? null;
  return {
    type: 'state',
    view: ui.activeView,
    image: path
      ? {
          path,
          name: path.split(/[\\/]/).pop() ?? path,
          isReady: !!editor.selectedImage?.isReady,
          rating: library.imageRatings[path] ?? 0,
        }
      : null,
    canUndo: editor.historyIndex > 0,
    canRedo: editor.historyIndex < editor.history.length - 1,
    showOriginal: editor.showOriginal,
    params: snapshotParams(editor.adjustments),
  };
};

export function useExternalControl() {
  const { setAdjustments } = useEditorActions();
  const setAdjustmentsRef = useRef(setAdjustments);
  setAdjustmentsRef.current = setAdjustments;

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    // Last command sequence number handled; the server stamps `_seq` so a
    // duplicate event delivery is dropped rather than applied twice.
    let lastSeq = 0;
    let autoReleaseTimer: ReturnType<typeof setTimeout> | null = null;
    // Set while a client holds explicit tracking; auto-release is suspended then.
    let explicitTracking = false;

    const setDragging = (dragging: boolean) => {
      if (useEditorStore.getState().isSliderDragging !== dragging) {
        useEditorStore.getState().setEditor({ isSliderDragging: dragging });
      }
    };

    const touchAutoTracking = () => {
      if (explicitTracking) return;
      setDragging(true);
      if (autoReleaseTimer) clearTimeout(autoReleaseTimer);
      autoReleaseTimer = setTimeout(() => {
        autoReleaseTimer = null;
        if (!explicitTracking) setDragging(false);
      }, AUTO_TRACKING_RELEASE_MS);
    };

    const reply = (request: ControlMessage, body: Record<string, unknown>) => {
      publish(request.ref !== undefined ? { ...body, ref: request.ref } : body);
    };

    const fail = (request: ControlMessage, message: string) => reply(request, { type: 'error', message });

    const canEdit = () => {
      const editor = useEditorStore.getState();
      return !!editor.selectedImage?.isReady && useUIStore.getState().activeView === 'editor';
    };

    const applyParam = (request: ControlMessage, compute: (current: number) => number) => {
      const param = getControlParam(request.param);
      if (!param) return fail(request, `unknown param: ${String(request.param)}`);
      if (!canEdit()) return reply(request, { type: 'ignored', reason: 'no image open in editor' });
      touchAutoTracking();
      setAdjustmentsRef.current((prev) => {
        const next = normalizeParamValue(param, compute(readParamValue(prev, param)));
        return writePath(prev, param.path, next);
      });
    };

    const handle = (msg: ControlMessage) => {
      switch (msg.type) {
        case 'set': {
          const value = Number(msg.value);
          if (!Number.isFinite(value)) return fail(msg, 'set requires a numeric value');
          return applyParam(msg, () => value);
        }
        case 'adjust': {
          const delta = Number(msg.delta);
          if (!Number.isFinite(delta)) return fail(msg, 'adjust requires a numeric delta');
          return applyParam(msg, (current) => current + delta);
        }
        case 'step': {
          // Dial tick: signed number of native steps (1 == one slider step).
          const ticks = Number(msg.ticks ?? 1);
          if (!Number.isFinite(ticks)) return fail(msg, 'step requires numeric ticks');
          const param = getControlParam(msg.param);
          if (!param) return fail(msg, `unknown param: ${String(msg.param)}`);
          const multiplier = Number(msg.multiplier ?? 1);
          return applyParam(
            msg,
            (current) => current + ticks * param.step * (Number.isFinite(multiplier) ? multiplier : 1),
          );
        }
        case 'reset': {
          const param = getControlParam(msg.param);
          if (!param) return fail(msg, `unknown param: ${String(msg.param)}`);
          return applyParam(msg, () => param.default);
        }
        case 'tracking': {
          explicitTracking = msg.active === true;
          if (autoReleaseTimer) {
            clearTimeout(autoReleaseTimer);
            autoReleaseTimer = null;
          }
          setDragging(explicitTracking);
          return;
        }
        case 'action': {
          const result = runControlAction(msg.id);
          if (result === 'unknown') return fail(msg, `unknown action: ${String(msg.id)}`);
          if (result === 'unavailable') return fail(msg, 'actions are not available yet');
          return reply(msg, { type: 'action-result', action: msg.id, result });
        }
        case 'get_state':
          return reply(msg, buildState());
        case 'get_params':
          return reply(msg, {
            type: 'params',
            protocol: EXTERNAL_CONTROL_PROTOCOL,
            params: CONTROL_PARAMS.map(({ id, group, min, max, step, default: def }) => ({
              id,
              group,
              min,
              max,
              step,
              default: def,
            })),
          });
        case 'get_actions':
          return reply(msg, { type: 'actions', actions: listControlActions() });
        default:
          return fail(msg, `unknown message type: ${String(msg.type)}`);
      }
    };

    listen<ControlMessage>(EXTERNAL_CONTROL_COMMAND_EVENT, (event) => {
      if (!active) return;
      const msg = event.payload;
      if (!msg || typeof msg !== 'object') return;
      if (typeof msg._seq === 'number') {
        if (msg._seq <= lastSeq) return;
        lastSeq = msg._seq;
      }
      try {
        handle(msg);
      } catch (err) {
        console.error('External control command failed:', err);
        fail(msg, `command failed: ${err}`);
      }
    }).then((fn) => {
      if (active) unlisten = fn;
      else fn();
    });

    // State publishing.
    const publishState = throttle(() => publish(buildState()), PUBLISH_INTERVAL_MS, { leading: true, trailing: true });

    let lastEditorSig: unknown[] = [];
    const unsubEditor = useEditorStore.subscribe((s) => {
      const sig = [
        s.adjustments,
        s.selectedImage?.path,
        s.selectedImage?.isReady,
        s.historyIndex,
        s.history.length,
        s.showOriginal,
      ];
      if (sig.some((v, i) => v !== lastEditorSig[i])) {
        lastEditorSig = sig;
        publishState();
      }
    });
    let lastView = useUIStore.getState().activeView;
    const unsubUI = useUIStore.subscribe((s) => {
      if (s.activeView !== lastView) {
        lastView = s.activeView;
        publishState();
      }
    });
    let lastRatings = useLibraryStore.getState().imageRatings;
    const unsubLibrary = useLibraryStore.subscribe((s) => {
      if (s.imageRatings !== lastRatings) {
        lastRatings = s.imageRatings;
        publishState();
      }
    });
    publishState();

    return () => {
      active = false;
      if (unlisten) unlisten();
      if (autoReleaseTimer) clearTimeout(autoReleaseTimer);
      publishState.cancel();
      unsubEditor();
      unsubUI();
      unsubLibrary();
    };
  }, []);
}
