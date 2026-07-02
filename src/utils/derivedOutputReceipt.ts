import { deriveArtifactInvalidationReasons } from '../../packages/rawengine-schema/src/derivedArtifactInvalidation';
import {
  type DerivedOutputProvenanceSidecar,
  type DerivedOutputReceipt,
  type DerivedOutputStaleReason,
  derivedOutputProvenanceSidecarSchema,
  derivedOutputReceiptSchema,
} from '../schemas/computational-merge/derivedOutputReceiptSchemas';
import type { HdrEditableHandoffSummary, HdrMergeUiSettings } from '../schemas/computational-merge/hdrMergeUiSchemas';
import type { PanoramaSavedReviewSummary, PanoramaUiSettings } from '../schemas/computational-merge/panoramaUiSchemas';
import type { SuperResolutionOutputReviewWorkflow } from '../schemas/computational-merge/superResolutionOutputReviewSchemas';
import type { SuperResolutionUiSettings } from '../schemas/computational-merge/superResolutionUiSchemas';
import type { FocusStackOutputReviewWorkflow } from '../schemas/focus-stack/focusStackOutputReviewSchemas';
import type { FocusStackUiSettings } from '../schemas/focus-stack/focusStackUiSchemas';

type BuildReceiptInput = Omit<
  DerivedOutputReceipt,
  'provenanceSidecar' | 'receiptId' | 'settingsHash' | 'sourcePaths'
> & {
  provenanceSidecar?: {
    acceptedApplyId?: string;
    acceptedDryRunId?: string;
    focusStack?: DerivedOutputProvenanceSidecar['focusStack'];
    hdr?: DerivedOutputProvenanceSidecar['hdr'];
    panorama?: DerivedOutputProvenanceSidecar['panorama'];
    superResolution?: DerivedOutputProvenanceSidecar['superResolution'];
    warnings: string[];
  };
  settings: unknown;
  sourcePaths?: Array<string | undefined>;
};

const STALE_REASON_ORDER: ReadonlyArray<DerivedOutputStaleReason> = [
  'source_set_changed',
  'source_order_changed',
  'source_content_hash_changed',
  'source_graph_revision_changed',
  'settings_hash_changed',
  'recipe_hash_changed',
  'accepted_dry_run_plan_changed',
  'output_artifact_changed',
];

export const buildDerivedOutputReceipt = (input: BuildReceiptInput): DerivedOutputReceipt => {
  const settingsHash = hashStableJson(input.settings);
  const { settings: _settings, sourcePaths, ...receiptInput } = input;
  const receiptSourcePaths =
    sourcePaths !== undefined && sourcePaths.every((path): path is string => path !== undefined && path !== '')
      ? sourcePaths
      : undefined;
  const receiptId = `derived_output_${input.family}_${hashStableJson({
    family: input.family,
    outputArtifactId: input.outputArtifactId,
    outputContentHash: input.outputContentHash,
    settingsHash,
  }).replace(':', '_')}`;
  const baseReceipt = {
    ...receiptInput,
    ...(receiptSourcePaths === undefined ? {} : { sourcePaths: receiptSourcePaths }),
    receiptId,
    settingsHash,
  };
  return derivedOutputReceiptSchema.parse({
    ...baseReceipt,
    ...(input.outputPath === undefined
      ? {}
      : {
          provenanceSidecar: buildDerivedOutputProvenanceSidecar({
            family: input.family,
            outputContentHash: input.outputContentHash,
            outputPath: input.outputPath,
            receiptId,
            settingsHash,
            sourceContentHashes: input.sourceContentHashes,
            sourceGraphRevisions: input.sourceGraphRevisions,
            warnings: input.provenanceSidecar?.warnings ?? [],
            ...(input.sourcePaths === undefined ? {} : { sourcePaths: input.sourcePaths }),
            ...(input.provenanceSidecar?.panorama === undefined ? {} : { panorama: input.provenanceSidecar.panorama }),
            ...(input.provenanceSidecar?.acceptedApplyId === undefined
              ? {}
              : { acceptedApplyId: input.provenanceSidecar.acceptedApplyId }),
            ...(input.provenanceSidecar?.acceptedDryRunId === undefined
              ? {}
              : { acceptedDryRunId: input.provenanceSidecar.acceptedDryRunId }),
            ...(input.provenanceSidecar?.focusStack === undefined
              ? {}
              : { focusStack: input.provenanceSidecar.focusStack }),
            ...(input.provenanceSidecar?.hdr === undefined ? {} : { hdr: input.provenanceSidecar.hdr }),
            ...(input.provenanceSidecar?.superResolution === undefined
              ? {}
              : { superResolution: input.provenanceSidecar.superResolution }),
          }),
        }),
  });
};

export const deriveDerivedOutputReceiptState = ({
  current,
  receipt,
}: {
  current: DerivedOutputReceipt;
  receipt: DerivedOutputReceipt;
}): DerivedOutputReceipt => {
  const reasons = new Set<DerivedOutputStaleReason>(
    deriveArtifactInvalidationReasons(
      {
        outputArtifact: {
          contentHash: receipt.outputContentHash,
        },
        sourceState: toSourceState(receipt),
      },
      {
        outputContentHash: current.outputContentHash,
        sourceState: toSourceState(current),
      },
    ),
  );

  if (receipt.sourceContentHashes.join('\n') !== current.sourceContentHashes.join('\n')) {
    reasons.add(receipt.sourceCount === current.sourceCount ? 'source_order_changed' : 'source_set_changed');
  }
  if (receipt.sourceGraphRevisions.join('\n') !== current.sourceGraphRevisions.join('\n')) {
    reasons.add(receipt.sourceCount === current.sourceCount ? 'source_order_changed' : 'source_set_changed');
  }
  if (receipt.settingsHash !== current.settingsHash) reasons.add('settings_hash_changed');
  if (receipt.recipeHash !== current.recipeHash) reasons.add('recipe_hash_changed');
  if (
    receipt.acceptedDryRunPlanHash !== current.acceptedDryRunPlanHash ||
    receipt.acceptedDryRunPlanId !== current.acceptedDryRunPlanId
  ) {
    reasons.add('accepted_dry_run_plan_changed');
  }

  const staleReasons = STALE_REASON_ORDER.filter((reason) => reasons.has(reason));
  return derivedOutputReceiptSchema.parse({
    ...receipt,
    staleReasons: staleReasons.length > 0 ? staleReasons : undefined,
    staleState: staleReasons.length > 0 ? 'stale' : receipt.staleState === 'unknown' ? 'unknown' : 'current',
  });
};

const toSourceState = (receipt: DerivedOutputReceipt) =>
  receipt.sourceContentHashes.map((contentHash, sourceIndex) => ({
    contentHash,
    graphRevision: receipt.sourceGraphRevisions[sourceIndex] ?? '',
    sourceIndex,
  }));

export const buildDerivedOutputProvenanceSidecarPath = (outputPath: string): string => `${outputPath}.rrdata`;

export const buildDerivedOutputProvenanceSidecar = ({
  acceptedApplyId,
  acceptedDryRunId,
  family,
  outputContentHash,
  outputPath,
  panorama,
  receiptId,
  settingsHash,
  sourceContentHashes,
  sourceGraphRevisions,
  sourcePaths = [],
  superResolution,
  warnings,
  focusStack,
  hdr,
}: {
  acceptedApplyId?: string;
  acceptedDryRunId?: string;
  focusStack?: DerivedOutputProvenanceSidecar['focusStack'];
  family: DerivedOutputReceipt['family'];
  hdr?: DerivedOutputProvenanceSidecar['hdr'];
  outputContentHash: string;
  outputPath: string;
  receiptId: string;
  settingsHash: string;
  sourceContentHashes: string[];
  sourceGraphRevisions: string[];
  sourcePaths?: Array<string | undefined>;
  panorama?: DerivedOutputProvenanceSidecar['panorama'];
  superResolution?: DerivedOutputProvenanceSidecar['superResolution'];
  warnings: string[];
}): DerivedOutputProvenanceSidecar =>
  derivedOutputProvenanceSidecarSchema.parse({
    ...(acceptedApplyId === undefined ? {} : { acceptedApplyId }),
    ...(acceptedDryRunId === undefined ? {} : { acceptedDryRunId }),
    app: {
      buildVersion: '1.5.8',
      id: 'io.github.CyberTimon.RapidRAW',
      name: 'RapidRAW',
    },
    output: {
      contentHash: outputContentHash,
      path: outputPath,
    },
    receipt: {
      family,
      receiptId,
    },
    schemaVersion: 1,
    settingsHash,
    sidecarPath: buildDerivedOutputProvenanceSidecarPath(outputPath),
    sourceState: sourceContentHashes.map((contentHash, order) => ({
      contentHash,
      graphRevision: sourceGraphRevisions[order] ?? `missing_source_revision_${order}`,
      order,
      ...(sourcePaths[order] === undefined || sourcePaths[order] === '' ? {} : { path: sourcePaths[order] }),
    })),
    ...(focusStack === undefined ? {} : { focusStack }),
    ...(hdr === undefined ? {} : { hdr }),
    ...(panorama === undefined ? {} : { panorama }),
    ...(superResolution === undefined ? {} : { superResolution }),
    warnings: [...new Set(warnings)].sort(),
  });

export const buildHdrDerivedOutputReceipt = ({
  acceptedDryRunPlanHash,
  acceptedDryRunPlanId,
  handoff,
  settings,
}: {
  acceptedDryRunPlanHash?: string | undefined;
  acceptedDryRunPlanId?: string | undefined;
  handoff: HdrEditableHandoffSummary;
  settings: HdrMergeUiSettings;
}): DerivedOutputReceipt => {
  const outputContentHash =
    handoff.runtimeSidecarReceipt?.output.contentHash ?? handoff.previewExportParity.parityProofHash;
  const hdrMetadata =
    handoff.runtimeSidecarReceipt === undefined
      ? undefined
      : {
          deghostMaskArtifactCount: handoff.runtimeSidecarReceipt.deghost.maskArtifacts?.length ?? 0,
          deghostMaskArtifacts: handoff.runtimeSidecarReceipt.deghost.maskArtifacts ?? [],
          motionCoverageRatio: handoff.runtimeSidecarReceipt.deghost.motionCoverageRatio,
          requestedDeghosting: handoff.runtimeSidecarReceipt.deghost.requestedDeghosting,
        };

  return buildDerivedOutputReceipt({
    acceptedDryRunPlanHash,
    acceptedDryRunPlanId,
    family: 'hdr',
    openInEditorAction: {
      label: 'Open HDR output',
      path: handoff.outputPath,
      state: 'available',
    },
    outputArtifactId: handoff.editableDerivedAssetId,
    outputContentHash,
    outputPath: handoff.outputPath,
    ...(hdrMetadata === undefined ? {} : { hdr: hdrMetadata }),
    provenanceSidecar: {
      acceptedApplyId: handoff.editableDerivedAssetId,
      acceptedDryRunId: handoff.previewExportParity.exportReceiptHash,
      ...(hdrMetadata === undefined ? {} : { hdr: hdrMetadata }),
      warnings: handoff.warningCodes,
    },
    settings,
    sourcePaths: handoff.sourceRefs.map((source) => source.contentState.replace(/^path:/u, '')),
    sourceContentHashes: handoff.sourceRefs.map((source) => source.contentHash),
    sourceCount: handoff.sourceCount,
    sourceGraphRevisions: handoff.sourceRefs.map((source) => source.graphRevision),
    staleReasons: undefined,
    staleState: 'current',
    storagePolicy: 'export_path',
  });
};

export const buildPanoramaDerivedOutputReceipt = ({
  acceptedDryRunPlanHash,
  acceptedDryRunPlanId,
  review,
  settings,
}: {
  acceptedDryRunPlanHash?: string | undefined;
  acceptedDryRunPlanId?: string | undefined;
  review: PanoramaSavedReviewSummary;
  settings: PanoramaUiSettings;
}): DerivedOutputReceipt =>
  buildDerivedOutputReceipt({
    acceptedDryRunPlanHash,
    acceptedDryRunPlanId,
    family: 'panorama',
    openInEditorAction: {
      label: 'Open panorama output',
      path: review.outputPath,
      state: 'available',
    },
    outputArtifactId: `artifact_panorama_${hashStableJson(review.outputPath).replace(':', '_')}`,
    outputContentHash: hashStableJson({
      boundaryFillColor: review.boundaryFillColor,
      boundaryMode: review.boundaryMode,
      crop: review.crop,
      outputDimensions: review.outputDimensions,
      outputPath: review.outputPath,
      projection: review.projection,
      exposureNormalizationSummary: review.exposureNormalizationSummary,
      seamReview: review.seamReview,
      sourceContribution: review.sourceContribution,
    }),
    outputPath: review.outputPath,
    panorama: buildPanoramaReceiptMetadata({ review, settings }),
    previewDimensions: buildPanoramaPreviewDimensions(review.outputDimensions, settings.maxPreviewDimensionPx),
    provenanceSidecar: {
      acceptedApplyId: review.outputPath,
      acceptedDryRunId: review.seamReview.policy,
      panorama: buildPanoramaReceiptMetadata({ review, settings }),
      warnings: review.warningCodes,
    },
    settings,
    sourcePaths: review.sourceRefs.map((source) => source.path),
    sourceContentHashes: review.sourceRefs.map((source) => source.contentHash),
    sourceCount: review.sourceCount,
    sourceGraphRevisions: review.sourceRefs.map((source) => source.graphRevision),
    staleReasons: undefined,
    staleState: 'current',
    storagePolicy: 'export_path',
    warningCodes: review.warningCodes,
  });

const buildPanoramaReceiptMetadata = ({
  review,
  settings,
}: {
  review: PanoramaSavedReviewSummary;
  settings: PanoramaUiSettings;
}): NonNullable<DerivedOutputReceipt['panorama']> => ({
  boundary: {
    crop: review.crop,
    effectiveMode: review.boundaryMode,
    ...(review.boundaryFillColor === undefined ? {} : { fillColor: review.boundaryFillColor }),
    manualCropInsetsPercent: settings.manualCropInsetsPercent,
    overlapFeatherPx: settings.overlapFeatherPx,
    requestedMode: settings.boundaryMode,
  },
  previewDimensions: buildPanoramaPreviewDimensions(review.outputDimensions, settings.maxPreviewDimensionPx),
  projection: {
    effective: review.projection,
    requested: settings.projection,
  },
  seamExposureCompensationPercent: settings.seamExposureCompensationPercent,
  sourceSetHash: hashStableJson(
    review.sourceRefs.map((source) => ({
      contentHash: source.contentHash,
      graphRevision: source.graphRevision,
      path: source.path,
      sourceIndex: source.sourceIndex,
    })),
  ),
});

const buildPanoramaPreviewDimensions = (
  outputDimensions: PanoramaSavedReviewSummary['outputDimensions'],
  maxPreviewDimensionPx: number,
): NonNullable<DerivedOutputReceipt['previewDimensions']> => {
  const scale = Math.min(1, maxPreviewDimensionPx / Math.max(outputDimensions.width, outputDimensions.height));
  return {
    height: Math.max(1, Math.round(outputDimensions.height * scale)),
    width: Math.max(1, Math.round(outputDimensions.width * scale)),
  };
};

export const buildFocusStackDerivedOutputReceipt = ({
  acceptedDryRunPlanHash,
  acceptedDryRunPlanId,
  review,
  settings,
}: {
  acceptedDryRunPlanHash?: string | undefined;
  acceptedDryRunPlanId?: string | undefined;
  review: FocusStackOutputReviewWorkflow;
  settings: FocusStackUiSettings;
}): DerivedOutputReceipt => {
  const focusStackMetadata = buildFocusStackReceiptMetadata(review);

  return buildDerivedOutputReceipt({
    acceptedDryRunPlanHash,
    acceptedDryRunPlanId,
    family: 'focus_stack',
    openInEditorAction: {
      label: 'Open focus stack output',
      ...(review.applyReceipt.status === 'apply_ready' ? { path: review.artifactPath } : {}),
      state: review.applyReceipt.status === 'apply_ready' ? 'available' : 'unavailable',
    },
    outputArtifactId: review.editableHandoff.artifactId,
    outputContentHash: review.editableHandoff.artifactHash,
    ...(focusStackMetadata === undefined ? {} : { focusStack: focusStackMetadata }),
    ...(review.applyReceipt.status === 'apply_ready'
      ? {
          outputPath: review.artifactPath,
          provenanceSidecar: {
            acceptedApplyId: review.editableHandoff.artifactId,
            acceptedDryRunId: review.editableHandoff.exportReviewArtifactId,
            ...(focusStackMetadata === undefined ? {} : { focusStack: focusStackMetadata }),
            warnings: review.warningCodes,
          },
        }
      : {}),
    settings,
    sourcePaths: review.sourceRefs.map((source) => source.path),
    sourceContentHashes: review.sourceRefs.map((source) => source.contentHash),
    sourceCount: review.sourceCount,
    sourceGraphRevisions: review.sourceRefs.map((source) => source.graphRevision),
    staleReasons: undefined,
    staleState: review.applyReceipt.status === 'apply_ready' ? 'current' : 'unknown',
    storagePolicy: 'sidecar_artifact',
  });
};

const buildFocusStackReceiptMetadata = (review: FocusStackOutputReviewWorkflow): DerivedOutputReceipt['focusStack'] => {
  if (review.focusBreathingCompensation === undefined && review.retouchSeed === undefined) return undefined;

  return {
    ...(review.focusBreathingCompensation === undefined
      ? {}
      : { breathingCompensation: review.focusBreathingCompensation }),
    ...(review.retouchSeed === undefined ? {} : { retouchSeed: review.retouchSeed }),
  };
};

export const buildSuperResolutionDerivedOutputReceipt = ({
  acceptedDryRunPlanHash,
  acceptedDryRunPlanId,
  review,
  settings,
}: {
  acceptedDryRunPlanHash?: string | undefined;
  acceptedDryRunPlanId?: string | undefined;
  review: SuperResolutionOutputReviewWorkflow;
  settings: SuperResolutionUiSettings;
}): DerivedOutputReceipt =>
  buildDerivedOutputReceipt({
    acceptedDryRunPlanHash,
    acceptedDryRunPlanId,
    family: 'super_resolution',
    openInEditorAction: {
      label: 'Open super-resolution output',
      state: review.editableGate === 'ready' ? 'available' : 'unavailable',
      ...(review.editableGate === 'ready' ? { path: review.artifactPath } : {}),
    },
    outputArtifactId: review.outputArtifactId,
    outputContentHash: review.outputArtifactHash,
    ...(review.editableGate === 'ready'
      ? {
          outputPath: review.artifactPath,
          provenanceSidecar: {
            acceptedApplyId: review.outputArtifactId,
            acceptedDryRunId: review.supportMap.artifactId,
            ...(review.registrationMetrics === null
              ? {}
              : {
                  superResolution: {
                    registrationMetrics: review.registrationMetrics,
                    supportMap: {
                      artifactId: review.supportMap.artifactId,
                      coverageRatio: review.supportMap.coverageRatio,
                      effectiveScale: review.supportMap.effectiveScale,
                      requestedScale: review.supportMap.requestedScale,
                      reviewStatus: review.supportMap.reviewStatus,
                      weakSupportRatio: review.supportMap.weakSupportRatio,
                    },
                  },
                }),
            warnings: review.warningCodes,
          },
        }
      : {}),
    settings,
    sourcePaths: review.sourceRefs.map((source) => source.path),
    sourceContentHashes: review.sourceRefs.map((source) => source.contentHash),
    sourceCount: review.sourceCount,
    sourceGraphRevisions: review.sourceRefs.map((source) => source.graphRevision),
    staleReasons: undefined,
    staleState: review.staleState,
    storagePolicy: 'sidecar_artifact',
  });

export const hashStableJson = (value: unknown): string => `fnv1a32:${fnv1a32(stableJson(value))}`;

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const fnv1a32 = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};
