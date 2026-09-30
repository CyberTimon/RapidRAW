import type { SubMask } from '../components/panel/right/Masks';
import type { Adjustments } from './adjustments';

// Immutable assets get a transport revision independent of their editable mask/patch ID.
// Older overlay work can therefore never overwrite the data acknowledged by a newer render.
const assetRevisions = new Map<string, { values: unknown[]; revision: string }>();
export function resetPreviewAssetRevisions() {
  assetRevisions.clear();
}
export function previewAssetRevision(id: string, values: unknown[]) {
  const cached = assetRevisions.get(id);
  if (cached && cached.values.length === values.length && values.every((value, i) => value === cached.values[i])) {
    return cached.revision;
  }
  // Two independent 32-bit content hashes keep identical bitmap data reusable
  // when selection parameters change, and give undo the original transport key.
  const content = JSON.stringify(values);
  let a = 2166136261;
  let b = 5381;
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    a = Math.imul(a ^ code, 16777619);
    b = Math.imul(b, 33) ^ code;
  }
  const revision = `${content.length}:${a >>> 0}:${b >>> 0}`;
  if (assetRevisions.size >= 128) assetRevisions.delete(assetRevisions.keys().next().value!);
  assetRevisions.set(id, { values, revision });
  return revision;
}

export function preparePreviewSubMasks(
  subMasks: SubMask[],
  cachedAssets: ReadonlySet<string>,
  sentAssets = new Set<string>(),
) {
  if (!Array.isArray(subMasks)) return subMasks;
  return subMasks.map((mask) => {
    const parameters = { ...mask.parameters };
    const previewAssetKey = `${mask.id}:mask:${previewAssetRevision(`${mask.id}:mask`, [parameters.mask_data_base64, parameters.maskDataBase64])}`;
    const previewAssetFields: string[] = [];
    for (const key of ['mask_data_base64', 'maskDataBase64'] as const) {
      if (mask.id && parameters[key] != null) {
        if (cachedAssets.has(previewAssetKey)) {
          parameters[key] = null;
          previewAssetFields.push(key);
        } else sentAssets.add(previewAssetKey);
      }
    }
    return { ...mask, previewAssetKey, previewAssetFields, parameters };
  });
}

// Keep immutable editor/history data shared until IPC serializes the payload.
// Cloning entire recipes here also copies multi-megabyte repair and mask assets.
export function preparePreviewAdjustments(adjustments: Adjustments, cachedAssets: ReadonlySet<string>) {
  const sentAssets = new Set<string>();
  const stripSubMasks = (subMasks: SubMask[]) => preparePreviewSubMasks(subMasks, cachedAssets, sentAssets);

  return {
    payload: {
      ...adjustments,
      inpaintHistory: undefined,
      masks: adjustments.masks?.map((mask) => ({ ...mask, subMasks: stripSubMasks(mask.subMasks) })),
      aiPatches: adjustments.aiPatches?.map((patch) => {
        let patchData = patch.patchData;
        const previewAssetFields: string[] = [];
        const previewAssetKey = patchData
          ? `${patch.id}:patch:${previewAssetRevision(`${patch.id}:patch`, [patchData.color, patchData.mask, patchData.offsetX, patchData.offsetY, patchData.width, patchData.height, patchData.isSrgbEncoded, patchData.generation])}`
          : undefined;
        if (patch.id && patchData && !patch.isLoading) {
          if (cachedAssets.has(previewAssetKey!)) {
            patchData = null;
            previewAssetFields.push('patchData');
          } else sentAssets.add(previewAssetKey!);
        }
        return {
          ...patch,
          patchData,
          previewAssetKey,
          previewAssetFields,
          generationOptions: patch.generationOptions && {
            ...patch.generationOptions,
            referenceImagesBase64: undefined,
          },
          subMasks: stripSubMasks(patch.subMasks),
        };
      }),
    },
    sentAssets,
  };
}

export interface PreviewAssetCacheStatus {
  cacheEpoch: number;
  retainedKeys: string[];
}

export function previewMissingAssetKeys(error: unknown): string[] | null {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : String(error);
  const prefix = 'PREVIEW_ASSET_MISSING:';
  const start = message.indexOf(prefix);
  if (start < 0) return null;
  try {
    const detail: unknown = JSON.parse(message.slice(start + prefix.length));
    if (!detail || typeof detail !== 'object' || !('missingKeys' in detail)) return null;
    const keys = (detail as { missingKeys: unknown }).missingKeys;
    return Array.isArray(keys) && keys.every((key) => typeof key === 'string') ? keys : null;
  } catch {
    return null;
  }
}

// A cache lookup may race eviction after the frontend acknowledged an asset.
// Retry only once, with inline pixels from the still-current immutable recipe.
export async function retryMissingPreviewAssets<T>(
  send: (forceInline: boolean) => Promise<T>,
  isCurrent: () => boolean,
  forgetMissing: (keys: string[]) => void,
): Promise<T> {
  try {
    return await send(false);
  } catch (error) {
    const missing = previewMissingAssetKeys(error);
    if (missing === null || !isCurrent()) throw error;
    forgetMissing(missing);
    return send(true);
  }
}

export function interactivePreviewResolution(target: number, quality?: string) {
  // Zoom detail is restored on release. Full quality remains an explicit opt-in.
  return quality === 'full' ? target : Math.min(target, 1920);
}

/** A refinement becomes runnable only after quiet time and the matching quick pass. */
export class PreviewRefinementScheduler<T> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: { request: T; quiet: boolean; quickComplete: boolean; armedAt: number } | null = null;

  constructor(
    private readonly delayMs: number,
    private readonly enqueueDetail: (request: T) => void,
    private readonly onQuiet?: (request: T, elapsedMs: number) => void,
  ) {}

  schedule(request: T, quickComplete: boolean) {
    this.clear();
    this.pending = { request, quiet: false, quickComplete, armedAt: performance.now() };
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.pending || this.pending.request !== request) return;
      this.pending.quiet = true;
      this.onQuiet?.(request, performance.now() - this.pending.armedAt);
      this.flush();
    }, this.delayMs);
  }

  quickCompleted(request: T) {
    if (!this.pending || this.pending.request !== request) return;
    this.pending.quickComplete = true;
    this.flush();
  }

  clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }

  private flush() {
    if (!this.pending?.quiet || !this.pending.quickComplete) return;
    const request = this.pending.request;
    this.pending = null;
    this.enqueueDetail(request);
  }
}

/** One running render and one replaceable pending request, including final renders. */
export class PreviewPipeline<T> {
  private pending: T | null = null;
  private running = false;
  private generation = 0;
  private revision = 0;

  constructor(private readonly render: (request: T, isLatest: () => boolean) => Promise<void>) {}

  enqueue(request: T) {
    this.revision += 1;
    this.pending = request;
    this.flush();
  }

  clear() {
    this.pending = null;
    this.generation += 1;
  }

  private flush() {
    if (this.running || this.pending === null) return;
    const request = this.pending;
    const generation = this.generation;
    const revision = this.revision;
    this.pending = null;
    this.running = true;
    // Errors must release the slot too; the renderer owns user-facing reporting.
    void Promise.resolve()
      .then(() =>
        generation === this.generation
          ? this.render(request, () => generation === this.generation && revision === this.revision)
          : undefined,
      )
      .catch(() => {})
      .finally(() => {
        this.running = false;
        this.flush();
      });
  }
}

const clippingViews = {
  on: new WeakMap<Adjustments, Adjustments>(),
  off: new WeakMap<Adjustments, Adjustments>(),
};

/**
 * Returns the adjustments to render with the editor's clipping overlay. The
 * overlay is view state, so it never enters the saved edit. Results are cached
 * per input so identity-based preview deduplication still works.
 */
export function withClippingOverlay(adjustments: Adjustments, showClipping: boolean): Adjustments {
  const current = (adjustments as Adjustments & { showClipping?: boolean }).showClipping === true;
  if (current === showClipping) return adjustments;
  const views = showClipping ? clippingViews.on : clippingViews.off;
  let view = views.get(adjustments);
  if (!view) {
    view = { ...adjustments, showClipping } as Adjustments;
    views.set(adjustments, view);
  }
  return view;
}
