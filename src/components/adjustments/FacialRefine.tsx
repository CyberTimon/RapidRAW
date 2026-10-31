import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import { v4 as uuidv4 } from 'uuid';
import clsx from 'clsx';
import { Loader2, ScanFace, X } from 'lucide-react';
import Slider from '../ui/Slider';
import Switch from '../ui/Switch';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';
import { Adjustments, AiPatch } from '../../utils/adjustments';
import { Mask, SubMaskMode } from '../panel/right/Masks';
import { useEditorStore } from '../../store/useEditorStore';
import { selectAiModelDownloadStatus, useProcessStore } from '../../store/useProcessStore';

interface DetectedFace {
  centerX: number;
  centerY: number;
  thumbnail: string;
  width: number;
}

interface FacialRefineProps {
  adjustments: Adjustments;
  onDragStateChange?: (isDragging: boolean) => void;
  setAdjustments(adjustments: Partial<Adjustments> | ((prev: Adjustments) => Adjustments)): void;
}

const FACE_SLIDERS = [
  { key: 'intensity', defaultValue: 40 },
  { key: 'blemish', defaultValue: 50 },
  { key: 'shine', defaultValue: 40 },
  { key: 'evenTone', defaultValue: 35 },
  { key: 'texture', defaultValue: 75 },
  { key: 'eyes', defaultValue: 0 },
  { key: 'teeth', defaultValue: 0 },
] as const;

type FaceSliderKey = (typeof FACE_SLIDERS)[number]['key'];
type FaceSettings = Partial<Record<FaceSliderKey, number>>;

const REFINE_DEBOUNCE_MS = 150;

const faceParameters = (patch: AiPatch) => patch.subMasks[0]?.parameters ?? {};

const withFaceParameters = (patch: AiPatch, parameters: Record<string, unknown>): AiPatch => ({
  ...patch,
  subMasks: [{ ...patch.subMasks[0], parameters: { ...faceParameters(patch), ...parameters } }],
});

const isSameFace = (patch: AiPatch, face: DetectedFace) => {
  const center = faceParameters(patch).faceCenter;
  return !!center && Math.hypot(center.x - face.centerX, center.y - face.centerY) < face.width * 0.5;
};

// The backend only needs the edits that change the pixels faces are read from, so the
// heavy maps and Facial Refine's own patches stay out of the request.
const sourceAdjustments = (adjustments: Adjustments) => ({
  ...adjustments,
  aiPatches: (adjustments.aiPatches || []).filter((patch) => !patch.faceRefine),
  fogDepthMap: null,
  lensBlurDepthMap: null,
  lutData: null,
  masks: [],
  relightNormalMap: null,
});

const requestFacePatch = async (center: { x: number; y: number }, parameters: Record<string, unknown>) =>
  JSON.parse(
    await invoke<string>('generate_face_refine_patch', {
      currentAdjustments: sourceAdjustments(useEditorStore.getState().adjustments),
      faceCenter: [center.x, center.y],
      parameters,
    }),
  );

export default function FacialRefine({ adjustments, setAdjustments, onDragStateChange }: FacialRefineProps) {
  const { t } = useTranslation();
  const [isDetecting, setIsDetecting] = useState(false);
  const [selectedFaceId, setSelectedFaceId] = useState<string | null>(null);
  const [busyFaces, setBusyFaces] = useState<Set<string>>(new Set());
  // Slider edits live here until their result is ready, so the image is only reprocessed
  // once per change, when the settings and the retouched face are committed together.
  const [drafts, setDrafts] = useState<Record<string, FaceSettings>>({});
  const aiModelDownloadStatus = useProcessStore(selectAiModelDownloadStatus);

  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const queue = useRef<Promise<void>>(Promise.resolve());
  const queued = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const faces = (adjustments.aiPatches || []).filter((patch) => patch.faceRefine);
  const selectedFace = faces.find((face) => face.id === selectedFaceId) ?? faces[0];

  useEffect(() => {
    const pendingTimers = timers.current;
    return () => pendingTimers.forEach((timer) => clearTimeout(timer));
  }, []);

  const reportFailure = useCallback(
    (err: unknown) => toast.error(t('adjustments.effects.facialRefineFailed', { error: String(err) })),
    [t],
  );

  const refineFace = useCallback(
    async (id: string) => {
      const patch = useEditorStore.getState().adjustments.aiPatches?.find((p) => p.id === id);
      if (!patch) return;

      const used = { ...draftsRef.current[id] };
      const parameters = { ...faceParameters(patch), ...used };
      setBusyFaces((prev) => new Set(prev).add(id));
      try {
        const patchData = await requestFacePatch(parameters.faceCenter, parameters);
        useEditorStore.getState().patchesSentToBackend.delete(id);
        setAdjustments((prev: Adjustments) => ({
          ...prev,
          aiPatches: (prev.aiPatches || []).map((p) =>
            p.id === id ? { ...withFaceParameters(p, used), patchData } : p,
          ),
        }));
        // Anything moved again while this was running stays pending for the next pass.
        setDrafts((prev) => {
          const remaining = { ...prev[id] };
          (Object.keys(used) as FaceSliderKey[]).forEach((key) => {
            if (remaining[key] === used[key]) delete remaining[key];
          });
          const next = { ...prev };
          if (Object.keys(remaining).length > 0) next[id] = remaining;
          else delete next[id];
          return next;
        });
      } catch (err) {
        reportFailure(err);
      } finally {
        setBusyFaces((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [reportFailure, setAdjustments],
  );

  // Faces are refined one after another, each from the settings it has when its turn comes.
  const requestRefine = useCallback(
    (id: string) => {
      if (queued.current.has(id)) return;
      queued.current.add(id);
      queue.current = queue.current.then(() => {
        queued.current.delete(id);
        return refineFace(id);
      });
    },
    [refineFace],
  );

  const scheduleRefine = (id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.set(
      id,
      setTimeout(() => requestRefine(id), REFINE_DEBOUNCE_MS),
    );
  };

  const handleDetect = async () => {
    setIsDetecting(true);
    try {
      const current = useEditorStore.getState().adjustments;
      const detected = await invoke<DetectedFace[]>('detect_faces_for_refine', {
        currentAdjustments: sourceAdjustments(current),
      });
      if (detected.length === 0) {
        toast.info(t('adjustments.effects.facialRefineNoFaces'));
        return;
      }

      const existing = (current.aiPatches || []).filter((p) => p.faceRefine);
      const nextFaces: AiPatch[] = [];
      for (const [index, face] of detected.entries()) {
        const location = { faceCenter: { x: face.centerX, y: face.centerY }, thumbnail: face.thumbnail };
        const name = t('adjustments.effects.facialRefineFace', { index: index + 1 });
        const known = existing.find((patch) => isSameFace(patch, face));
        if (known) {
          nextFaces.push({ ...withFaceParameters(known, location), name });
          continue;
        }

        const parameters: Record<string, unknown> = { lines: [], ...location };
        FACE_SLIDERS.forEach((slider) => (parameters[slider.key] = slider.defaultValue));
        nextFaces.push({
          id: uuidv4(),
          faceRefine: true,
          invert: false,
          isLoading: false,
          name,
          patchData: await requestFacePatch(location.faceCenter, parameters),
          prompt: '',
          visible: true,
          subMasks: [
            {
              id: uuidv4(),
              invert: false,
              mode: SubMaskMode.Additive,
              opacity: 100,
              parameters,
              type: Mask.Retouch,
              visible: true,
            },
          ],
        });
      }

      // Every new face is committed at once, and face patches stay last so they are
      // applied on top of every other edit.
      const { patchesSentToBackend } = useEditorStore.getState();
      nextFaces.forEach((face) => patchesSentToBackend.delete(face.id));
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        aiPatches: [...(prev.aiPatches || []).filter((p) => !p.faceRefine), ...nextFaces],
      }));
      if (!nextFaces.some((face) => face.id === selectedFaceId)) {
        setSelectedFaceId(nextFaces[0].id);
      }
    } catch (err) {
      reportFailure(err);
    } finally {
      setIsDetecting(false);
    }
  };

  const handleSliderChange = (face: AiPatch, key: FaceSliderKey, value: number) => {
    setDrafts((prev) => ({ ...prev, [face.id]: { ...prev[face.id], [key]: value } }));
    scheduleRefine(face.id);
  };

  const handleToggleFace = (face: AiPatch, visible: boolean) => {
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      aiPatches: (prev.aiPatches || []).map((patch) => (patch.id === face.id ? { ...patch, visible } : patch)),
    }));
    if (visible && !face.patchData) scheduleRefine(face.id);
  };

  const handleRemoveFace = (id: string) => {
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      aiPatches: (prev.aiPatches || []).filter((patch) => patch.id !== id),
    }));
  };

  const settingOf = (face: AiPatch, key: FaceSliderKey, defaultValue: number): number =>
    drafts[face.id]?.[key] ?? faceParameters(face)[key] ?? defaultValue;

  const handleApplyToAll = (source: AiPatch) => {
    const shared: FaceSettings = {};
    FACE_SLIDERS.forEach((slider) => (shared[slider.key] = settingOf(source, slider.key, slider.defaultValue)));

    const others = faces.filter((face) => face.id !== source.id);
    setDrafts((prev) => {
      const next = { ...prev };
      others.forEach((face) => (next[face.id] = { ...shared }));
      return next;
    });
    others.forEach((face) => scheduleRefine(face.id));
  };

  return (
    <div className="space-y-3">
      <button
        className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-bg-primary hover:bg-card-active text-text-primary transition-colors disabled:opacity-50"
        disabled={isDetecting}
        onClick={handleDetect}
      >
        {isDetecting ? <Loader2 size={16} className="animate-spin shrink-0" /> : <ScanFace size={16} />}
        <Text variant={TextVariants.label}>
          {isDetecting
            ? t('adjustments.effects.facialRefineDetecting')
            : faces.length > 0
              ? t('adjustments.effects.facialRefineRedetect')
              : t('adjustments.effects.facialRefineDetect')}
        </Text>
      </button>

      {isDetecting && aiModelDownloadStatus && (
        <Text variant={TextVariants.small} className="text-accent text-center block">
          {t('editor.masks.settings.aiModelDownloading')}
          {aiModelDownloadStatus}
        </Text>
      )}

      {faces.length === 0 && !isDetecting && (
        <Text variant={TextVariants.small} className="text-text-secondary block px-1">
          {t('adjustments.effects.facialRefineHint')}
        </Text>
      )}

      {faces.length > 0 && selectedFace && (
        <>
          <div className="flex flex-wrap gap-2 p-2 rounded-md bg-bg-primary">
            {faces.map((face) => (
              <button
                key={face.id}
                aria-label={face.name}
                data-tooltip={face.name}
                className={clsx(
                  'relative w-12 h-12 rounded-full overflow-hidden ring-2 transition-all',
                  face.id === selectedFace.id ? 'ring-accent' : 'ring-transparent hover:ring-card-active',
                  !face.visible && 'opacity-40 grayscale',
                )}
                onClick={() => setSelectedFaceId(face.id)}
              >
                <img
                  alt={face.name}
                  className="w-full h-full object-cover"
                  draggable={false}
                  src={faceParameters(face).thumbnail}
                />
                {busyFaces.has(face.id) && (
                  <span className="absolute inset-0 flex items-center justify-center bg-black/50">
                    <Loader2 size={16} className="animate-spin text-white" />
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <div className="grow">
              <Switch
                checked={selectedFace.visible}
                label={selectedFace.name}
                onChange={(visible: boolean) => handleToggleFace(selectedFace, visible)}
              />
            </div>
            <button
              aria-label={t('adjustments.effects.facialRefineRemove')}
              className="p-1 rounded-md text-text-secondary hover:text-red-500 transition-colors"
              data-tooltip={t('adjustments.effects.facialRefineRemove')}
              onClick={() => handleRemoveFace(selectedFace.id)}
            >
              <X size={16} />
            </button>
          </div>

          <div className={clsx('transition-opacity', !selectedFace.visible && 'opacity-50 pointer-events-none')}>
            {FACE_SLIDERS.map((slider) => (
              <Slider
                key={`${selectedFace.id}-${slider.key}`}
                defaultValue={slider.defaultValue}
                fillOrigin="min"
                label={t(`adjustments.effects.facialRefineParams.${slider.key}`)}
                max={100}
                min={0}
                onChange={(e: any) => handleSliderChange(selectedFace, slider.key, parseInt(e.target.value, 10))}
                onDragStateChange={onDragStateChange}
                step={1}
                value={settingOf(selectedFace, slider.key, slider.defaultValue)}
              />
            ))}
          </div>

          {faces.length > 1 && (
            <button
              className="w-full px-3 py-2 rounded-md bg-bg-primary hover:bg-card-active text-text-primary transition-colors"
              onClick={() => handleApplyToAll(selectedFace)}
            >
              <Text variant={TextVariants.label}>{t('adjustments.effects.facialRefineApplyToAll')}</Text>
            </button>
          )}
        </>
      )}
    </div>
  );
}
