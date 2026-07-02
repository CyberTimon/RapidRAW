import type { ArtifactHandleV1, FocusStackArtifactV1 } from '../../packages/rawengine-schema/src/rawEngineSchemas';
import type { FocusStackOutputReviewWorkflow } from '../schemas/focus-stack/focusStackOutputReviewSchemas';
import { focusStackOutputReviewWorkflowSchema } from '../schemas/focus-stack/focusStackOutputReviewSchemas';
import type { FocusStackUiSettings } from '../schemas/focus-stack/focusStackUiSchemas';

interface BuildFocusStackOutputReviewOptions {
  artifactPath: string;
  settings: FocusStackUiSettings;
  sourceCount: number;
  sourcePaths?: string[];
}

const sharpnessCoverageRatio = 1;
const lowConfidenceCellRatio = 0.08;
const haloRiskCellRatio = 0.14;
const haloSuppressionScale = 160;

export const buildFocusStackOutputReviewWorkflow = ({
  artifactPath,
  settings,
  sourceCount,
  sourcePaths = [],
}: BuildFocusStackOutputReviewOptions): FocusStackOutputReviewWorkflow => {
  const decision = settings.blendMethod === 'weighted_sharpness' ? 'editable_review_required' : 'preview_only';
  const warningCodes: FocusStackOutputReviewWorkflow['warningCodes'] =
    settings.blendMethod === 'weighted_sharpness'
      ? ['human_review_required', 'synthetic_runtime_only', 'transition_halo_risk', 'retouch_layer_deferred']
      : settings.blendMethod === 'depth_map'
        ? ['human_review_required', 'synthetic_runtime_only', 'transition_halo_risk', 'depth_map_preview_only']
        : [
            'human_review_required',
            'synthetic_runtime_only',
            'transition_halo_risk',
            'unsupported_blend_method_preview_only',
          ];
  const effectiveHaloRiskCellRatio = roundRatio(
    Math.max(0.03, haloRiskCellRatio * (1 - settings.haloSuppressionStrengthPercent / haloSuppressionScale)),
  );
  const artifactHandle = buildOutputArtifactHandle({
    artifactId: artifactPath,
    contentHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    dimensions: {
      height: settings.maxPreviewDimensionPx,
      width: settings.maxPreviewDimensionPx,
    },
  });
  const sharpnessSummary = buildSharpnessQualitySummary({
    lowConfidenceRatio: lowConfidenceCellRatio,
    qualityPreference: settings.qualityPreference,
    sharpnessCoverage: sharpnessCoverageRatio,
  });
  const status = decision === 'editable_review_required' ? 'review_required' : 'preview_only';

  return focusStackOutputReviewWorkflowSchema.parse({
    alignmentMode: settings.alignmentMode,
    artifactPath,
    applyReceipt: {
      alignment: {
        mode: settings.alignmentMode,
        status: settings.alignmentMode === 'none' ? 'not_requested' : 'planned',
      },
      artifactHandle,
      artifactPath,
      outputPreviewDimensions: artifactHandle.dimensions,
      receiptId: buildFocusStackApplyReceiptId({
        artifactHash: artifactHandle.contentHash,
        artifactId: artifactHandle.artifactId,
        sourceCount,
        warningCodes,
      }),
      sharpnessQualitySummary: sharpnessSummary,
      sourceCount,
      status,
      warnings: warningCodes,
    },
    blendMethod: settings.blendMethod,
    decision,
    editableHandoff: {
      artifactHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      artifactId: artifactPath,
      exportReviewArtifactId: `${artifactPath}:export-review`,
      retouchedExportParity:
        settings.retouchLayerPolicy === 'generate_retouch_layer'
          ? {
              comparedFields: [
                'acceptedDryRunPlan',
                'outputArtifact',
                'retouchLayerArtifact',
                'retouchLayerPolicy',
                'sharpnessSettings',
                'sourceState',
              ],
              exportReceiptHash: 'fnv1a32:00000000',
              meanAbsDelta: 0,
              parityProofHash: 'fnv1a32:00000000',
              previewStateHash: 'fnv1a32:00000000',
              status: 'matched_retouched_sidecar_output',
            }
          : undefined,
      status: 'review_required',
    },
    haloRiskCellRatio: effectiveHaloRiskCellRatio,
    haloReview: {
      artifactId: `${artifactPath}:halo-review`,
      reviewStatus: 'review_required',
      transitionRiskRegions: buildDefaultTransitionRiskRegions(sourceCount),
    },
    lowConfidenceCellRatio,
    proofLevel: 'synthetic_runtime',
    qualityPreference: settings.qualityPreference,
    retouchLayerPolicy: settings.retouchLayerPolicy,
    reviewOverlay: {
      confidenceMarginThreshold: 0.12,
      mode: settings.reviewOverlayMode,
      opacityPercent: settings.reviewOverlayOpacityPercent,
      sourceContributionDetails: buildSourceContributionDetails(sourceCount),
      sourceContributionSummary: buildSourceContributionSummary(sourceCount),
    },
    sharpnessCoverageRatio,
    sourceCount,
    sourceRefs: buildSourceRefs(sourceCount, sourcePaths),
    warningCodes,
  });
};

export const buildFocusStackOutputReviewFromArtifact = (
  artifact: FocusStackArtifactV1,
): FocusStackOutputReviewWorkflow => {
  const sourceRefs = artifact.sourceImageRefs.map((source, sourceIndex) => {
    const sourceState = artifact.sourceState.find((state) => state.sourceIndex === source.sourceIndex);
    return {
      contentHash: sourceState?.contentHash ?? hashStableJson({ path: source.imagePath, sourceIndex }),
      graphRevision: sourceState?.graphRevision ?? `focus_stack_source_${sourceIndex}`,
      path: source.imagePath,
      sourceIndex,
    };
  });
  const warningCodes: FocusStackOutputReviewWorkflow['warningCodes'] = uniqueWarnings([
    ...artifact.warningCodes,
    'human_review_required',
    'synthetic_runtime_only',
    'transition_halo_risk',
    ...(artifact.retouchLayerPolicy === 'generate_retouch_layer' ? ['retouch_layer_deferred' as const] : []),
  ]);
  const editableHandoffStatus = artifact.haloReview?.editableHandoffStatus ?? 'review_required';
  const haloReviewStatus = artifact.haloReview?.reviewStatus ?? 'review_required';
  const decision =
    haloReviewStatus === 'blocked'
      ? 'blocked'
      : artifact.blendMethod === 'weighted_sharpness'
        ? 'editable_review_required'
        : 'preview_only';
  const outputPreviewDimensions = artifact.previewArtifacts[0]?.dimensions ?? artifact.outputArtifact.dimensions;
  const sharpnessSummary = buildSharpnessQualitySummary({
    lowConfidenceRatio: artifact.haloReview?.lowConfidenceCellRatio,
    qualityPreference: artifact.qualityPreference,
    sharpnessCoverage: artifact.validationSummary.focusCoverageRatio,
  });
  const artifactPath = artifact.outputArtifact.artifactId;
  const sourceContributionSummary = buildSourceContributionSummaryFromArtifact(artifact);
  const sourceContributionDetails = buildSourceContributionDetailsFromArtifact(artifact, sourceContributionSummary);

  return focusStackOutputReviewWorkflowSchema.parse({
    alignmentMode: artifact.resolvedAlignmentMode,
    artifactPath,
    applyReceipt: {
      alignment: {
        ...(artifact.validationSummary.alignmentConfidence === undefined
          ? {}
          : { confidence: artifact.validationSummary.alignmentConfidence }),
        mode: artifact.resolvedAlignmentMode,
        status:
          haloReviewStatus === 'blocked'
            ? 'review_required'
            : artifact.resolvedAlignmentMode === 'none'
              ? 'not_requested'
              : 'applied',
      },
      artifactHandle: artifact.outputArtifact,
      artifactPath,
      ...(outputPreviewDimensions === undefined ? {} : { outputPreviewDimensions }),
      receiptId: buildFocusStackApplyReceiptId({
        artifactHash: artifact.outputArtifact.contentHash,
        artifactId: artifact.outputArtifact.artifactId,
        sourceCount: artifact.sourceImageRefs.length,
        warningCodes,
      }),
      sharpnessQualitySummary: sharpnessSummary,
      sourceCount: artifact.sourceImageRefs.length,
      status:
        editableHandoffStatus === 'blocked'
          ? 'blocked'
          : editableHandoffStatus === 'ready' && haloReviewStatus === 'apply_ready'
            ? 'apply_ready'
            : decision === 'preview_only'
              ? 'preview_only'
              : 'review_required',
      warnings: warningCodes,
    },
    blendMethod: artifact.blendMethod,
    decision,
    editableHandoff: {
      artifactHash: artifact.outputArtifact.contentHash,
      artifactId: artifact.outputArtifact.artifactId,
      exportReviewArtifactId: `${artifact.outputArtifact.artifactId}:export-review`,
      retouchedExportParity: artifact.retouchedExportParity,
      status: editableHandoffStatus,
    },
    focusBreathingCompensation: artifact.focusBreathingCompensation,
    haloRiskCellRatio: artifact.haloReview?.haloRiskCellRatio ?? haloRiskCellRatio,
    haloReview: {
      artifactHash: artifact.haloMapArtifact?.contentHash ?? artifact.haloReview?.artifactHash,
      artifactId: artifact.haloReview?.artifactId ?? `${artifact.outputArtifact.artifactId}:halo-review`,
      reviewStatus: haloReviewStatus,
      transitionRiskRegions:
        artifact.haloReview?.transitionRiskRegions ??
        buildDefaultTransitionRiskRegions(artifact.sourceImageRefs.length),
    },
    lowConfidenceCellRatio: artifact.haloReview?.lowConfidenceCellRatio ?? lowConfidenceCellRatio,
    proofLevel: 'synthetic_runtime',
    qualityPreference: artifact.qualityPreference,
    retouchLayerPolicy: artifact.retouchLayerPolicy,
    retouchSeed: artifact.retouchSeed,
    reviewOverlay: {
      confidenceMarginThreshold: 0.12,
      mode: 'halo_risk',
      opacityPercent: 70,
      sourceContributionDetails,
      sourceContributionSummary,
    },
    sharpnessCoverageRatio: artifact.validationSummary.focusCoverageRatio,
    sourceCount: artifact.sourceImageRefs.length,
    sourceRefs,
    warningCodes,
  });
};

export const markFocusStackOutputReviewApplyReady = (
  review: FocusStackOutputReviewWorkflow,
): FocusStackOutputReviewWorkflow =>
  focusStackOutputReviewWorkflowSchema.parse({
    ...review,
    applyReceipt: {
      ...review.applyReceipt,
      alignment: {
        ...review.applyReceipt.alignment,
        status: review.applyReceipt.alignment.mode === 'none' ? 'not_requested' : 'applied',
      },
      status: 'apply_ready',
    },
    editableHandoff: {
      ...review.editableHandoff,
      status: 'ready',
    },
    haloReview: {
      ...review.haloReview,
      reviewStatus: 'apply_ready',
    },
  });

const buildSourceRefs = (sourceCount: number, sourcePaths: string[]): FocusStackOutputReviewWorkflow['sourceRefs'] =>
  Array.from({ length: sourceCount }, (_value, sourceIndex) => {
    const path = sourcePaths[sourceIndex] ?? `focus-stack-source-${sourceIndex}`;
    return {
      contentHash: hashStableJson({ path, sourceIndex }),
      graphRevision: `focus_stack_source_${sourceIndex}`,
      path,
      sourceIndex,
    };
  });

const buildSourceContributionSummary = (
  sourceCount: number,
): FocusStackOutputReviewWorkflow['reviewOverlay']['sourceContributionSummary'] => {
  const baseRatio = 1 / sourceCount;
  return Array.from({ length: sourceCount }, (_value, sourceIndex) => ({
    sourceIndex,
    winnerCellRatio:
      sourceIndex === sourceCount - 1 ? roundRatio(1 - baseRatio * (sourceCount - 1)) : roundRatio(baseRatio),
  }));
};

const buildSourceContributionSummaryFromArtifact = (
  artifact: FocusStackArtifactV1,
): FocusStackOutputReviewWorkflow['reviewOverlay']['sourceContributionSummary'] => {
  const transitionRiskRegions = artifact.haloReview?.transitionRiskRegions ?? [];
  if (transitionRiskRegions.length === 0) {
    return buildSourceContributionSummary(artifact.sourceImageRefs.length);
  }

  const totalCellCount = transitionRiskRegions.reduce((total, region) => total + region.cellCount, 0);
  if (totalCellCount <= 0) {
    return buildSourceContributionSummary(artifact.sourceImageRefs.length);
  }

  const coverageBySourceIndex = new Map<number, number>();
  for (const region of transitionRiskRegions) {
    coverageBySourceIndex.set(
      region.sourceIndex,
      (coverageBySourceIndex.get(region.sourceIndex) ?? 0) + region.cellCount,
    );
  }

  return artifact.sourceImageRefs.map((source) => ({
    sourceIndex: source.sourceIndex,
    winnerCellRatio: roundRatio((coverageBySourceIndex.get(source.sourceIndex) ?? 0) / totalCellCount),
  }));
};

const buildSourceContributionDetails = (
  sourceCount: number,
): FocusStackOutputReviewWorkflow['reviewOverlay']['sourceContributionDetails'] =>
  buildSourceContributionSummary(sourceCount).map((source) => {
    const coverageCellCount = Math.max(1, Math.round(source.winnerCellRatio * sourceCount * 12));
    const confidencePercent = Math.max(62, Math.round((1 - lowConfidenceCellRatio) * 100 - source.sourceIndex * 2));
    return {
      artifactId: `artifact_focus_source_${source.sourceIndex + 1}_contribution`,
      confidencePercent,
      contributionRatio: source.winnerCellRatio,
      coverageCellCount,
      sourceId: `S${source.sourceIndex + 1}`,
      sourceIndex: source.sourceIndex,
      warningState: confidencePercent < 70 ? 'artifact_review_required' : 'clear',
    };
  });

const buildSourceContributionDetailsFromArtifact = (
  artifact: FocusStackArtifactV1,
  sourceContributionSummary: FocusStackOutputReviewWorkflow['reviewOverlay']['sourceContributionSummary'],
): FocusStackOutputReviewWorkflow['reviewOverlay']['sourceContributionDetails'] => {
  const transitionRiskRegions = artifact.haloReview?.transitionRiskRegions ?? [];
  const lowConfidenceRatio = artifact.haloReview?.lowConfidenceCellRatio ?? lowConfidenceCellRatio;
  if (transitionRiskRegions.length === 0) {
    return buildSourceContributionDetails(artifact.sourceImageRefs.length);
  }

  const totalCellCount = transitionRiskRegions.reduce((total, region) => total + region.cellCount, 0);
  const regionRiskBySourceIndex = new Map<number, Set<string>>();
  const coverageBySourceIndex = new Map<number, number>();

  for (const region of transitionRiskRegions) {
    coverageBySourceIndex.set(
      region.sourceIndex,
      (coverageBySourceIndex.get(region.sourceIndex) ?? 0) + region.cellCount,
    );
    const existing = regionRiskBySourceIndex.get(region.sourceIndex) ?? new Set<string>();
    existing.add(region.risk);
    regionRiskBySourceIndex.set(region.sourceIndex, existing);
  }

  return artifact.sourceImageRefs.map((source, index) => {
    const coverageCellCount = Math.max(1, coverageBySourceIndex.get(source.sourceIndex) ?? 0);
    const contributionRatio =
      sourceContributionSummary.find((candidate) => candidate.sourceIndex === source.sourceIndex)?.winnerCellRatio ??
      roundRatio(coverageCellCount / Math.max(1, totalCellCount));
    const sourceRisks = regionRiskBySourceIndex.get(source.sourceIndex) ?? new Set<string>();
    const warningState =
      sourceRisks.has('halo_risk') || sourceRisks.has('low_confidence') || sourceRisks.has('retouch_recommended')
        ? 'artifact_review_required'
        : 'clear';
    const confidencePenalty = sourceRisks.has('low_confidence') ? 18 : sourceRisks.has('halo_risk') ? 10 : 4;
    const confidencePercent = Math.max(
      62,
      Math.min(100, Math.round((1 - lowConfidenceRatio) * 100 - confidencePenalty - index * 2)),
    );

    return {
      artifactId: `artifact_focus_source_${source.sourceIndex + 1}_contribution`,
      confidencePercent,
      contributionRatio,
      coverageCellCount,
      sourceId: `S${source.sourceIndex + 1}`,
      sourceIndex: source.sourceIndex,
      warningState,
    };
  });
};

const buildDefaultTransitionRiskRegions = (
  sourceCount: number,
): FocusStackOutputReviewWorkflow['haloReview']['transitionRiskRegions'] =>
  Array.from({ length: sourceCount }, (_value, sourceIndex) => ({
    cellCount: 1,
    regionId: `focus-region-${sourceIndex + 1}`,
    risk: sourceIndex === 0 ? 'stable' : sourceIndex === 1 ? 'low_confidence' : 'halo_risk',
    sourceIndex,
  }));

const roundRatio = (value: number): number => Number(value.toFixed(6));

const buildOutputArtifactHandle = ({
  artifactId,
  contentHash,
  dimensions,
}: {
  artifactId: string;
  contentHash: string;
  dimensions: NonNullable<ArtifactHandleV1['dimensions']>;
}): ArtifactHandleV1 => ({
  artifactId,
  contentHash,
  dimensions,
  kind: 'merge_output',
  storage: 'sidecar_artifact',
});

const buildSharpnessQualitySummary = ({
  lowConfidenceRatio,
  qualityPreference,
  sharpnessCoverage,
}: {
  lowConfidenceRatio?: number | undefined;
  qualityPreference: FocusStackOutputReviewWorkflow['qualityPreference'];
  sharpnessCoverage?: number | undefined;
}): NonNullable<FocusStackOutputReviewWorkflow['applyReceipt']['sharpnessQualitySummary']> => ({
  ...(lowConfidenceRatio === undefined ? {} : { lowConfidenceCellRatio: roundRatio(lowConfidenceRatio) }),
  qualityPreference,
  ...(sharpnessCoverage === undefined ? {} : { sharpnessCoverageRatio: roundRatio(sharpnessCoverage) }),
});

const buildFocusStackApplyReceiptId = ({
  artifactHash,
  artifactId,
  sourceCount,
  warningCodes,
}: {
  artifactHash?: string | undefined;
  artifactId: string;
  sourceCount: number;
  warningCodes: FocusStackOutputReviewWorkflow['warningCodes'];
}): string =>
  `focus_stack_apply_${hashStableJson({
    artifactHash,
    artifactId,
    sourceCount,
    warningCodes,
  }).replace(':', '_')}`;

const uniqueWarnings = (
  warningCodes: FocusStackOutputReviewWorkflow['warningCodes'],
): FocusStackOutputReviewWorkflow['warningCodes'] => [...new Set(warningCodes)];

const hashStableJson = (value: unknown): string => `fnv1a32:${fnv1a32(stableJson(value))}`;

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
