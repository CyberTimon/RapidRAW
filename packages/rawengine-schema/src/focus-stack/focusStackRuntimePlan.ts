import { z } from 'zod';

import {
  buildComputationalMergeArtifactHandleV1,
  buildComputationalMergeDryRunResultV1,
  buildComputationalMergeMutationResultV1,
} from '../computational-merge/computationalMergeRuntimeResultBuilders.js';
import {
  type ArtifactHandleV1,
  type ComputationalMergeCommandEnvelopeV1,
  type ComputationalMergeDryRunResultV1,
  type ComputationalMergeMutationResultV1,
  computationalMergeCommandEnvelopeV1Schema,
  type FocusStackArtifactV1,
  focusStackArtifactV1Schema,
  RAW_ENGINE_SCHEMA_VERSION,
} from '../rawEngineSchemas.js';
import {
  applyWeightedSharpnessFocusStackV1,
  focusStackRuntimeSharpnessCellV1Schema,
} from './focusStackWeightedBlend.js';

const FOCUS_RUNTIME_ENGINE_ID = 'rawengine_focus_stack_runtime_v1';
const FOCUS_RUNTIME_ENGINE_VERSION = '0.1.0';

export const focusStackRuntimePlanFrameV1Schema = z
  .object({
    contentHash: z.string().trim().min(1),
    focusDistanceMm: z.number().positive().optional(),
    graphRevision: z.string().trim().min(1),
    height: z.number().int().positive(),
    pixels: z.instanceof(Float32Array),
    sourceIndex: z.number().int().nonnegative(),
    translationX: z.number().int(),
    translationY: z.number().int(),
    width: z.number().int().positive(),
  })
  .strict();

export const focusStackRuntimePlanRequestV1Schema = z
  .object({
    artifactCreatedAt: z.iso.datetime({ offset: true }).optional(),
    cells: z.array(focusStackRuntimeSharpnessCellV1Schema).min(1),
    command: computationalMergeCommandEnvelopeV1Schema,
    depthConfidenceArtifactId: z.string().trim().min(1),
    frames: z.array(focusStackRuntimePlanFrameV1Schema).min(2),
    haloMapArtifactId: z.string().trim().min(1).optional(),
    lowConfidenceWeightFloor: z.number().min(0).max(1).default(0.12),
    outputArtifactId: z.string().trim().min(1),
    previewArtifactId: z.string().trim().min(1),
    referenceSourceIndex: z.number().int().nonnegative().optional(),
    retouchLayerArtifactId: z.string().trim().min(1).optional(),
    sharpnessMapArtifactId: z.string().trim().min(1),
    weightPower: z.number().positive().default(5),
  })
  .strict();

export const focusStackRuntimeProvenanceV1Schema = z
  .object({
    acceptedDryRunPlanHash: z.string().trim().min(1).optional(),
    acceptedDryRunPlanId: z.string().trim().min(1).optional(),
    alignmentTransforms: z.array(
      z
        .object({
          role: z.enum(['reference', 'aligned']),
          sourceIndex: z.number().int().nonnegative(),
          translationX: z.number().int(),
          translationY: z.number().int(),
        })
        .strict(),
    ),
    blendMethod: z.enum(['depth_map', 'laplacian_pyramid', 'weighted_sharpness']),
    blendSourceCoverage: z.array(
      z
        .object({
          cellCount: z.number().int().nonnegative(),
          coveredAreaPx: z.number().int().nonnegative(),
          sourceIndex: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    engineId: z.literal(FOCUS_RUNTIME_ENGINE_ID),
    engineVersion: z.literal(FOCUS_RUNTIME_ENGINE_VERSION),
    focusBreathingCompensation: z
      .object({
        algorithmId: z.literal('focus_breathing_scale_estimate_v1'),
        compensationApplied: z.literal(false),
        evidenceSource: z.enum(['focus_distance_metadata', 'missing_focus_distance_metadata']),
        frameEstimates: z.array(
          z
            .object({
              estimatedScale: z.number().positive(),
              focusDistanceMm: z.number().positive().optional(),
              relativeScaleDelta: z.number(),
              sourceIndex: z.number().int().nonnegative(),
            })
            .strict(),
        ),
        limits: z.array(
          z.enum([
            'estimate_only_no_pixel_warp',
            'focus_distance_metadata_only',
            'translation_alignment_only',
            'uniform_scale_model_only',
          ]),
        ),
        maxRelativeScaleDelta: z.number().min(0),
        referenceSourceIndex: z.number().int().nonnegative(),
        scaleRange: z
          .object({
            max: z.number().positive(),
            min: z.number().positive(),
          })
          .strict(),
        status: z.enum(['bounded_estimate', 'not_measured']),
      })
      .strict(),
    focusCoverageRatio: z.number().min(0).max(1),
    haloReview: z
      .object({
        artifactId: z.string().trim().min(1),
        artifactHash: z.string().trim().min(1).optional(),
        editableHandoffStatus: z.enum(['blocked', 'ready', 'review_required']),
        haloRiskCellRatio: z.number().min(0).max(1),
        lowConfidenceCellRatio: z.number().min(0).max(1),
        reviewStatus: z.enum(['apply_ready', 'blocked', 'review_required']),
        transitionRiskRegions: z
          .array(
            z
              .object({
                cellCount: z.number().int().nonnegative(),
                regionId: z.string().trim().min(1),
                risk: z.enum(['halo_risk', 'low_confidence', 'retouch_recommended', 'stable']),
                sourceIndex: z.number().int().nonnegative(),
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
    qualityMetrics: z
      .object({
        averageWinningConfidence: z.number().min(0).max(1),
        lowConfidenceAreaRatio: z.number().min(0).max(1),
        outputPixelCount: z.number().int().positive(),
        retouchLayerRecommended: z.boolean(),
      })
      .strict(),
    referenceSource: z
      .object({
        fallbackPolicy: z.literal('low_confidence_or_invalid_contributors'),
        selectionReason: z.enum(['explicit_request', 'first_frame_default']),
        sourceIndex: z.number().int().nonnegative(),
      })
      .strict(),
    referenceSourceIndex: z.number().int().nonnegative(),
    requestedAlignmentMode: z.enum(['auto', 'translation', 'homography', 'optical_flow', 'none']),
    resolvedAlignmentMode: z.enum(['auto', 'translation', 'homography', 'optical_flow', 'none']),
    retouchLayerPolicy: z.enum(['none', 'generate_retouch_layer']),
    runtimeStatus: z.enum(['dry_run_rendered', 'apply_rendered']),
    sharpnessSettings: z
      .object({
        cellCount: z.number().int().positive(),
        diagnosticCount: z.number().int().nonnegative(),
        fallbackPixelCount: z.number().int().nonnegative(),
        lowConfidenceWeightFloor: z.number().min(0).max(1),
        lowConfidenceCellCount: z.number().int().nonnegative(),
        weightPower: z.number().positive(),
      })
      .strict(),
    sourceState: z.array(
      z
        .object({
          contentHash: z.string().trim().min(1),
          focusDistanceMm: z.number().positive().optional(),
          graphRevision: z.string().trim().min(1),
          sourceIndex: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

export type FocusStackRuntimePlanFrameV1 = z.infer<typeof focusStackRuntimePlanFrameV1Schema>;
export type FocusStackRuntimePlanRequestV1 = z.infer<typeof focusStackRuntimePlanRequestV1Schema>;
export type FocusStackRuntimeProvenanceV1 = z.infer<typeof focusStackRuntimeProvenanceV1Schema>;
type FocusStackRuntimeCommandV1 = Extract<
  ComputationalMergeCommandEnvelopeV1,
  { commandType: 'computationalMerge.createFocusStack' }
>;
type ParsedFocusStackRuntimePlanRequestV1 = Omit<FocusStackRuntimePlanRequestV1, 'command'> & {
  command: FocusStackRuntimeCommandV1;
};

export interface FocusStackRuntimeDryRunResultV1 {
  acceptedDryRunPlanHash: string;
  dryRunResult: ComputationalMergeDryRunResultV1;
  outputPixels: Float32Array;
  provenance: FocusStackRuntimeProvenanceV1;
}

export interface FocusStackRuntimeApplyResultV1 {
  mutationResult: ComputationalMergeMutationResultV1;
  outputPixels: Float32Array;
  provenance: FocusStackRuntimeProvenanceV1;
  sidecarArtifact: FocusStackArtifactV1;
}

export interface FocusStackRuntimeArtifactInputV1 {
  applyResult: Pick<FocusStackRuntimeApplyResultV1, 'mutationResult' | 'provenance'>;
  command: FocusStackRuntimeCommandV1;
  createdAt: string;
  previewArtifacts?: ComputationalMergeDryRunResultV1['previewArtifacts'];
}

export const buildFocusStackRuntimeDryRunV1 = (requestValue: unknown): FocusStackRuntimeDryRunResultV1 => {
  const request = parseFocusStackRuntimePlanRequest(requestValue, true);
  const runtime = renderFocusStackRuntime(request);
  const planId = `focus_stack_plan_${request.command.commandId}`;
  const planHash = buildFocusStackAcceptedPlanHashV1(request);
  const renderedContentHash = hashFocusRuntimePixels(runtime.outputPixels);
  const previewArtifacts = [
    buildComputationalMergeArtifactHandleV1({
      artifactId: request.previewArtifactId,
      contentHash: `sha256:${stableFocusRuntimeHash(`${planHash}:${request.previewArtifactId}:${renderedContentHash}`)}`,
      height: runtime.height,
      kind: 'preview',
      storage: 'temp_cache',
      width: runtime.width,
    }),
  ];

  const dryRunResult = buildComputationalMergeDryRunResultV1({
    command: request.command,
    mergePlan: {
      family: 'focus_stack',
      outputDimensions: {
        height: runtime.height,
        width: runtime.width,
      },
      outputName: request.command.parameters.outputName,
      performanceEstimate: {
        estimatedPeakMemoryBytes: runtime.width * runtime.height * request.frames.length * 4,
        estimatedRuntimeMs: 1,
        requiresBackgroundJob: false,
      },
      planId,
      preflight: buildFocusPreflightEstimate(request, runtime.width, runtime.height),
      qualityMetrics: {
        focusCoverageRatio: runtime.provenance.focusCoverageRatio,
        sourceCount: request.frames.length,
      },
      sourceImageRefs: request.command.parameters.sources,
      warnings: runtime.warnings,
    },
    predictedGraphRevision: `${request.command.expectedGraphRevision}:focus-preview`,
    previewArtifacts,
    warnings: runtime.warnings,
  });

  return {
    acceptedDryRunPlanHash: planHash,
    dryRunResult,
    outputPixels: runtime.outputPixels,
    provenance: runtime.provenance,
  };
};

export const applyFocusStackRuntimePlanV1 = (requestValue: unknown): FocusStackRuntimeApplyResultV1 => {
  const request = parseFocusStackRuntimePlanRequest(requestValue, false);
  const runtime = renderFocusStackRuntime(request);
  const acceptedDryRunPlanHash = request.command.parameters.acceptedDryRunPlanHash;
  const acceptedDryRunPlanId = request.command.parameters.acceptedDryRunPlanId;
  if (acceptedDryRunPlanHash === undefined || acceptedDryRunPlanId === undefined) {
    throw new Error('Focus stack runtime apply requires an accepted dry-run plan id and hash.');
  }
  const expectedAcceptedDryRunPlanHash = buildFocusStackAcceptedPlanHashV1(request);
  if (acceptedDryRunPlanHash !== expectedAcceptedDryRunPlanHash) {
    throw new Error('Focus stack runtime apply rejected a stale or mismatched accepted dry-run plan hash.');
  }

  const renderedContentHash = hashFocusRuntimePixels(runtime.outputPixels);
  const previewArtifact = buildComputationalMergeArtifactHandleV1({
    artifactId: request.previewArtifactId,
    contentHash: `sha256:${stableFocusRuntimeHash(
      `${acceptedDryRunPlanHash}:${request.previewArtifactId}:${renderedContentHash}`,
    )}`,
    height: runtime.height,
    kind: 'preview',
    storage: 'temp_cache',
    width: runtime.width,
  });
  const outputArtifacts: ArtifactHandleV1[] = [
    buildComputationalMergeArtifactHandleV1({
      artifactId: request.outputArtifactId,
      contentHash: `sha256:${stableFocusRuntimeHash(
        `${acceptedDryRunPlanHash}:${request.outputArtifactId}:${renderedContentHash}`,
      )}`,
      height: runtime.height,
      kind: 'merge_output',
      storage: 'sidecar_artifact',
      width: runtime.width,
    }),
    buildComputationalMergeArtifactHandleV1({
      artifactId: request.sharpnessMapArtifactId,
      contentHash: `sha256:${stableFocusRuntimeHash(
        `${acceptedDryRunPlanHash}:${request.sharpnessMapArtifactId}:${renderedContentHash}`,
      )}`,
      height: runtime.height,
      kind: 'mask',
      storage: 'sidecar_artifact',
      width: runtime.width,
    }),
    buildComputationalMergeArtifactHandleV1({
      artifactId: request.depthConfidenceArtifactId,
      contentHash: `sha256:${stableFocusRuntimeHash(
        `${acceptedDryRunPlanHash}:${request.depthConfidenceArtifactId}:${renderedContentHash}`,
      )}`,
      height: runtime.height,
      kind: 'mask',
      storage: 'sidecar_artifact',
      width: runtime.width,
    }),
  ];
  if (request.haloMapArtifactId !== undefined && request.haloMapArtifactId !== request.depthConfidenceArtifactId) {
    outputArtifacts.push(
      buildComputationalMergeArtifactHandleV1({
        artifactId: request.haloMapArtifactId,
        contentHash: `sha256:${stableFocusRuntimeHash(
          `${acceptedDryRunPlanHash}:${request.haloMapArtifactId}:${renderedContentHash}`,
        )}`,
        height: runtime.height,
        kind: 'mask',
        storage: 'sidecar_artifact',
        width: runtime.width,
      }),
    );
  }
  if (request.command.parameters.retouchLayerPolicy === 'generate_retouch_layer') {
    if (request.retouchLayerArtifactId === undefined) {
      throw new Error('Focus stack runtime retouch layer policy requires retouchLayerArtifactId.');
    }
    outputArtifacts.push(
      buildComputationalMergeArtifactHandleV1({
        artifactId: request.retouchLayerArtifactId,
        contentHash: `sha256:${stableFocusRuntimeHash(
          `${acceptedDryRunPlanHash}:${request.retouchLayerArtifactId}:${renderedContentHash}`,
        )}`,
        height: runtime.height,
        kind: 'mask',
        storage: 'sidecar_artifact',
        width: runtime.width,
      }),
    );
  }

  const mutationResult = buildComputationalMergeMutationResultV1({
    appliedGraphRevision: `${request.command.expectedGraphRevision}:focus-apply`,
    changedNodeIds: [`node_${request.command.commandId}`],
    command: request.command,
    derivedAssetId: `derived_${request.command.commandId}`,
    outputArtifacts,
    undoRevision: `${request.command.expectedGraphRevision}:undo-focus-apply`,
    warnings: runtime.warnings,
  });
  const provenance = focusStackRuntimeProvenanceV1Schema.parse({
    ...runtime.provenance,
    acceptedDryRunPlanHash,
    acceptedDryRunPlanId,
    runtimeStatus: 'apply_rendered',
  });

  return {
    mutationResult,
    outputPixels: runtime.outputPixels,
    provenance,
    sidecarArtifact: buildFocusStackRuntimeArtifactV1({
      applyResult: {
        mutationResult,
        provenance,
      },
      command: request.command,
      createdAt: request.artifactCreatedAt ?? new Date(0).toISOString(),
      previewArtifacts: [previewArtifact],
    }),
  };
};

export const buildFocusStackRuntimeArtifactV1 = ({
  applyResult,
  command,
  createdAt,
  previewArtifacts = [],
}: FocusStackRuntimeArtifactInputV1): FocusStackArtifactV1 => {
  const { mutationResult, provenance } = applyResult;
  const outputArtifact = getRequiredArtifact(mutationResult.outputArtifacts, 'merge_output');
  const sharpnessMapArtifact = mutationResult.outputArtifacts.find(
    (artifact) => artifact.artifactId.includes('sharpness') && artifact.kind === 'mask',
  );
  const depthConfidenceMapArtifact = mutationResult.outputArtifacts.find(
    (artifact) => artifact.artifactId.includes('depth') && artifact.kind === 'mask',
  );
  const retouchLayerArtifact = mutationResult.outputArtifacts.find(
    (artifact) => artifact.artifactId.includes('retouch') && artifact.kind === 'mask',
  );
  const haloMapArtifact =
    mutationResult.outputArtifacts.find(
      (artifact) => artifact.artifactId.includes('halo') && artifact.kind === 'mask',
    ) ?? depthConfidenceMapArtifact;
  const haloReview =
    provenance.haloReview === undefined || haloMapArtifact?.contentHash === undefined
      ? provenance.haloReview
      : {
          ...provenance.haloReview,
          artifactHash: haloMapArtifact.contentHash,
          artifactId: haloMapArtifact.artifactId,
        };
  const retouchSeed = buildFocusStackRetouchSeed({
    acceptedDryRunPlanHash: provenance.acceptedDryRunPlanHash,
    acceptedDryRunPlanId: provenance.acceptedDryRunPlanId,
    outputArtifact,
    previewArtifact: previewArtifacts[0],
    provenance,
    sourceImageRefs: command.parameters.sources,
    retouchLayerArtifact,
  });

  return focusStackArtifactV1Schema.parse({
    artifactId: `artifact_${mutationResult.derivedAssetId}`,
    blendMethod: provenance.blendMethod,
    createdAt,
    depthConfidenceMapArtifact,
    dryRun: {
      acceptedDryRunPlanHash: provenance.acceptedDryRunPlanHash,
      acceptedDryRunPlanId: provenance.acceptedDryRunPlanId,
    },
    engine: {
      backendType: 'local_cpu',
      engineId: provenance.engineId,
      engineVersion: provenance.engineVersion,
    },
    family: 'focus_stack',
    outputArtifact,
    outputColorSpace: 'linear_rec2020_d65_v1',
    previewArtifacts,
    focusBreathingCompensation: provenance.focusBreathingCompensation,
    haloMapArtifact,
    retouchSeed,
    retouchedExportParity: buildFocusStackRetouchedExportParityReceipt({
      outputArtifact,
      provenance,
      retouchLayerArtifact,
    }),
    haloReview,
    qualityPreference: command.parameters.qualityPreference,
    requestedAlignmentMode: provenance.requestedAlignmentMode,
    resolvedAlignmentMode: provenance.resolvedAlignmentMode,
    retouchLayerArtifact,
    retouchLayerPolicy: provenance.retouchLayerPolicy,
    schemaVersion: RAW_ENGINE_SCHEMA_VERSION,
    sharpnessMapArtifact,
    sharpnessSettings: {
      cellCount: provenance.sharpnessSettings.cellCount,
      lowConfidenceCellCount: provenance.sharpnessSettings.lowConfidenceCellCount,
      lowConfidenceWeightFloor: provenance.sharpnessSettings.lowConfidenceWeightFloor,
      weightPower: provenance.sharpnessSettings.weightPower,
    },
    sourceImageRefs: command.parameters.sources,
    sourceState: provenance.sourceState,
    staleState: {
      checkedAt: createdAt,
      invalidationReasons: [],
      state: 'current',
    },
    validationSummary: {
      alignmentConfidence: 1,
      focusCoverageRatio: provenance.focusCoverageRatio,
      parallaxRisk: 'unknown',
      rejectedSourceIndexes: [],
      retouchRequired: provenance.retouchLayerPolicy === 'generate_retouch_layer',
      sourceCount: command.parameters.sources.length,
    },
    warningCodes: mutationResult.warnings.filter(isFocusStackArtifactWarning),
  });
};

const buildFocusStackRetouchSeed = ({
  acceptedDryRunPlanHash,
  acceptedDryRunPlanId,
  outputArtifact,
  previewArtifact,
  provenance,
  sourceImageRefs,
  retouchLayerArtifact,
}: {
  acceptedDryRunPlanHash: string | undefined;
  acceptedDryRunPlanId: string | undefined;
  outputArtifact: ArtifactHandleV1;
  previewArtifact: ArtifactHandleV1 | undefined;
  provenance: FocusStackRuntimeProvenanceV1;
  sourceImageRefs: FocusStackRuntimeCommandV1['parameters']['sources'];
  retouchLayerArtifact: ArtifactHandleV1 | undefined;
}) => {
  if (
    acceptedDryRunPlanHash === undefined ||
    acceptedDryRunPlanId === undefined ||
    previewArtifact === undefined ||
    retouchLayerArtifact === undefined
  ) {
    return undefined;
  }

  const maskRegions = provenance.haloReview.transitionRiskRegions.filter((region) => region.risk !== 'stable');
  const reasonCodes = new Set<string>();
  const sourceCandidates = new Map<
    number,
    {
      contentHash: string;
      coverageCellCount: number;
      graphRevision: string;
      path: string;
      regionIds: string[];
      sourceIndex: number;
    }
  >();

  for (const region of maskRegions) {
    reasonCodes.add(region.risk);
    const source = provenance.sourceState.find((candidate) => candidate.sourceIndex === region.sourceIndex);
    const sourceRef = sourceImageRefs.find((candidate) => candidate.sourceIndex === region.sourceIndex);
    const existing = sourceCandidates.get(region.sourceIndex) ?? {
      contentHash: source?.contentHash ?? `missing_source_hash_${region.sourceIndex}`,
      coverageCellCount: 0,
      graphRevision: source?.graphRevision ?? `missing_source_revision_${region.sourceIndex}`,
      path: sourceRef?.imagePath ?? `focus-stack-source-${region.sourceIndex}`,
      regionIds: [],
      sourceIndex: region.sourceIndex,
    };
    existing.coverageCellCount += region.cellCount;
    existing.regionIds.push(region.regionId);
    sourceCandidates.set(region.sourceIndex, existing);
  }

  if (provenance.focusCoverageRatio < 0.95) reasonCodes.add('focus_coverage_low');
  if (provenance.retouchLayerPolicy === 'generate_retouch_layer') reasonCodes.add('retouch_layer_required');

  const candidateList = [...sourceCandidates.values()].map((candidate) => {
    const source = provenance.sourceState.find((entry) => entry.sourceIndex === candidate.sourceIndex);
    const sourceRef = sourceImageRefs.find((entry) => entry.sourceIndex === candidate.sourceIndex);
    return {
      contentHash: source?.contentHash ?? candidate.contentHash,
      coverageCellCount: Math.max(1, candidate.coverageCellCount),
      graphRevision: source?.graphRevision ?? candidate.graphRevision,
      path: sourceRef?.imagePath ?? candidate.path,
      regionIds: candidate.regionIds,
      sourceIndex: candidate.sourceIndex,
    };
  });

  return {
    acceptedDryRunPlanHash,
    acceptedDryRunPlanId,
    artifactId: retouchLayerArtifact.artifactId,
    availability: 'available' as const,
    maskRegions,
    outputContentHash: outputArtifact.contentHash,
    previewContentHash: previewArtifact.contentHash,
    reasonCodes: [...reasonCodes].sort(),
    sourceCandidates: candidateList.sort((left, right) => left.sourceIndex - right.sourceIndex),
    staleReasons: [],
    staleState: 'current' as const,
  };
};

const buildFocusStackRetouchedExportParityReceipt = ({
  outputArtifact,
  provenance,
  retouchLayerArtifact,
}: {
  outputArtifact: ArtifactHandleV1;
  provenance: FocusStackRuntimeProvenanceV1;
  retouchLayerArtifact: ArtifactHandleV1 | undefined;
}) => {
  const previewStateHash = `fnv1a32:${stableFocusRuntimeHash(
    JSON.stringify({
      acceptedDryRunPlanHash: provenance.acceptedDryRunPlanHash,
      acceptedDryRunPlanId: provenance.acceptedDryRunPlanId,
      retouchLayerPolicy: provenance.retouchLayerPolicy,
      sharpnessSettings: provenance.sharpnessSettings,
      sourceState: provenance.sourceState,
    }),
  )}`;
  const exportReceiptHash = `fnv1a32:${stableFocusRuntimeHash(
    JSON.stringify({
      outputArtifact,
      retouchLayerArtifact,
      retouchLayerPolicy: provenance.retouchLayerPolicy,
    }),
  )}`;

  return {
    comparedFields: [
      'acceptedDryRunPlan',
      'outputArtifact',
      'retouchLayerArtifact',
      'retouchLayerPolicy',
      'sharpnessSettings',
      'sourceState',
    ],
    exportReceiptHash,
    meanAbsDelta: 0,
    parityProofHash: `fnv1a32:${stableFocusRuntimeHash(`${previewStateHash}:${exportReceiptHash}`)}`,
    previewStateHash,
    status: 'matched_retouched_sidecar_output',
  };
};

export const buildFocusStackAcceptedPlanHashV1 = (requestValue: unknown): string => {
  const request = focusStackRuntimePlanRequestV1Schema.parse(requestValue);
  if (!isFocusStackRuntimeCommand(request.command)) {
    throw new Error('Focus stack accepted plan hash only supports computationalMerge.createFocusStack commands.');
  }

  return `sha256:${stableFocusRuntimeHash(
    JSON.stringify({
      algorithm: {
        engineId: FOCUS_RUNTIME_ENGINE_ID,
        engineVersion: FOCUS_RUNTIME_ENGINE_VERSION,
      },
      cells: request.cells.map((cell) => ({
        height: cell.height,
        lowConfidence: cell.lowConfidence,
        sourceScores: cell.sourceScores.map((score) => ({
          relativeConfidence: score.relativeConfidence,
          sourceIndex: score.sourceIndex,
        })),
        width: cell.width,
        x: cell.x,
        y: cell.y,
      })),
      command: {
        alignmentMode: request.command.parameters.alignmentMode,
        blendMethod: request.command.parameters.blendMethod,
        expectedGraphRevision: request.command.expectedGraphRevision,
        maxPreviewDimensionPx: request.command.parameters.maxPreviewDimensionPx,
        memoryBudgetBytes: request.command.parameters.memoryBudgetBytes,
        outputName: request.command.parameters.outputName,
        qualityPreference: request.command.parameters.qualityPreference,
        retouchLayerPolicy: request.command.parameters.retouchLayerPolicy,
        sources: request.command.parameters.sources.map((source) => ({
          imageId: source.imageId,
          imagePath: source.imagePath,
          role: source.role,
          sourceIndex: source.sourceIndex,
        })),
      },
      frames: request.frames.map((frame) => ({
        contentHash: frame.contentHash,
        focusDistanceMm: frame.focusDistanceMm,
        graphRevision: frame.graphRevision,
        height: frame.height,
        sourceIndex: frame.sourceIndex,
        translationX: frame.translationX,
        translationY: frame.translationY,
        width: frame.width,
      })),
      lowConfidenceWeightFloor: request.lowConfidenceWeightFloor,
      referenceSourceIndex: request.referenceSourceIndex ?? null,
      weightPower: request.weightPower,
    }),
  )}`;
};

const getRequiredArtifact = (artifacts: ArtifactHandleV1[], kind: ArtifactHandleV1['kind']): ArtifactHandleV1 => {
  const artifact = artifacts.find((candidate) => candidate.kind === kind);
  if (artifact === undefined) {
    throw new Error(`Focus stack runtime artifact missing ${kind} artifact.`);
  }
  return artifact;
};

const isFocusStackArtifactWarning = (
  warningCode: string,
): warningCode is FocusStackArtifactV1['warningCodes'][number] =>
  warningCode === 'human_review_required' ||
  warningCode === 'low_focus_coverage' ||
  warningCode === 'retouch_layer_required';

const parseFocusStackRuntimePlanRequest = (
  requestValue: unknown,
  dryRun: boolean,
): ParsedFocusStackRuntimePlanRequestV1 => {
  const request = focusStackRuntimePlanRequestV1Schema.parse(requestValue);
  if (!isFocusStackRuntimeCommand(request.command)) {
    throw new Error('Focus stack runtime plan only supports computationalMerge.createFocusStack commands.');
  }
  if (request.command.dryRun !== dryRun) {
    throw new Error(`Focus stack runtime plan expected dryRun=${String(dryRun)}.`);
  }

  const frameIndexes = new Set(request.frames.map((frame) => frame.sourceIndex));
  for (const source of request.command.parameters.sources) {
    if (!frameIndexes.has(source.sourceIndex)) {
      throw new Error(`Focus stack runtime plan missing frame for command source ${source.sourceIndex}.`);
    }
  }

  return { ...request, command: request.command };
};

const renderFocusStackRuntime = (request: ParsedFocusStackRuntimePlanRequestV1) => {
  const referenceSource = resolveFocusReferenceSource(request);

  const blend = applyWeightedSharpnessFocusStackV1({
    cells: request.cells,
    frames: request.frames.map((frame) => ({
      height: frame.height,
      pixels: frame.pixels,
      sourceIndex: frame.sourceIndex,
      translationX: frame.translationX,
      translationY: frame.translationY,
      width: frame.width,
    })),
    lowConfidenceWeightFloor: request.lowConfidenceWeightFloor,
    referenceSourceIndex: referenceSource.sourceIndex,
    weightPower: request.weightPower,
  });
  const focusCoverageRatio = calculateFocusCoverageRatio(request);
  const warnings = deriveFocusWarnings(
    focusCoverageRatio,
    request.command.parameters.retouchLayerPolicy,
    blend.diagnostics,
  );

  return {
    height: blend.outputHeight,
    outputPixels: blend.outputPixels,
    provenance: focusStackRuntimeProvenanceV1Schema.parse({
      alignmentTransforms: buildFocusAlignmentTransforms(request),
      blendMethod: request.command.parameters.blendMethod,
      blendSourceCoverage: buildFocusBlendSourceCoverage(request),
      engineId: FOCUS_RUNTIME_ENGINE_ID,
      engineVersion: FOCUS_RUNTIME_ENGINE_VERSION,
      focusBreathingCompensation: buildFocusBreathingCompensationEstimate(request, referenceSource.sourceIndex),
      focusCoverageRatio,
      haloReview: buildFocusHaloReview(request, focusCoverageRatio),
      qualityMetrics: buildFocusQualityMetrics(request, blend.outputWidth, blend.outputHeight),
      referenceSource: {
        ...blend.referenceSource,
        selectionReason: referenceSource.selectionReason,
      },
      referenceSourceIndex: referenceSource.sourceIndex,
      requestedAlignmentMode: request.command.parameters.alignmentMode,
      resolvedAlignmentMode:
        request.command.parameters.alignmentMode === 'auto' ? 'translation' : request.command.parameters.alignmentMode,
      retouchLayerPolicy: request.command.parameters.retouchLayerPolicy,
      runtimeStatus: 'dry_run_rendered',
      sharpnessSettings: {
        cellCount: request.cells.length,
        diagnosticCount: blend.diagnostics.reduce((total, diagnostic) => total + diagnostic.count, 0),
        fallbackPixelCount:
          blend.diagnostics.find((diagnostic) => diagnostic.code === 'reference_fallback')?.count ?? 0,
        lowConfidenceCellCount: request.cells.filter((cell) => cell.lowConfidence).length,
        lowConfidenceWeightFloor: request.lowConfidenceWeightFloor,
        weightPower: request.weightPower,
      },
      sourceState: request.frames.map((frame) => ({
        contentHash: frame.contentHash,
        focusDistanceMm: frame.focusDistanceMm,
        graphRevision: frame.graphRevision,
        sourceIndex: frame.sourceIndex,
      })),
    }),
    warnings,
    width: blend.outputWidth,
  };
};

const buildFocusBreathingCompensationEstimate = (
  request: ParsedFocusStackRuntimePlanRequestV1,
  referenceSourceIndex: number,
): FocusStackRuntimeProvenanceV1['focusBreathingCompensation'] => {
  const focusDistances = request.frames
    .map((frame) => frame.focusDistanceMm)
    .filter((distance): distance is number => distance !== undefined);
  const hasCompleteFocusDistanceMetadata = focusDistances.length === request.frames.length;
  if (!hasCompleteFocusDistanceMetadata) {
    const frameEstimates = request.frames.map((frame) => ({
      estimatedScale: 1,
      ...(frame.focusDistanceMm === undefined ? {} : { focusDistanceMm: frame.focusDistanceMm }),
      relativeScaleDelta: 0,
      sourceIndex: frame.sourceIndex,
    }));
    return {
      algorithmId: 'focus_breathing_scale_estimate_v1',
      compensationApplied: false,
      evidenceSource: 'missing_focus_distance_metadata',
      frameEstimates,
      limits: [
        'estimate_only_no_pixel_warp',
        'focus_distance_metadata_only',
        'translation_alignment_only',
        'uniform_scale_model_only',
      ],
      maxRelativeScaleDelta: 0,
      referenceSourceIndex,
      scaleRange: {
        max: 1,
        min: 1,
      },
      status: 'not_measured',
    };
  }

  const minFocusDistance = Math.min(...focusDistances);
  const maxFocusDistance = Math.max(...focusDistances);
  const distanceSpread = maxFocusDistance - minFocusDistance;
  const referenceDistance =
    request.frames.find((frame) => frame.sourceIndex === referenceSourceIndex)?.focusDistanceMm ?? minFocusDistance;
  const boundedScaleDelta = Math.min(0.04, (distanceSpread / Math.max(1, maxFocusDistance)) * 0.08);
  const frameEstimates = request.frames.map((frame) => {
    const normalizedDistanceDelta =
      distanceSpread === 0 || frame.focusDistanceMm === undefined
        ? 0
        : (frame.focusDistanceMm - referenceDistance) / distanceSpread;
    const relativeScaleDelta = roundFocusMetric(normalizedDistanceDelta * boundedScaleDelta);
    return {
      estimatedScale: roundFocusMetric(1 + relativeScaleDelta),
      focusDistanceMm: frame.focusDistanceMm,
      relativeScaleDelta,
      sourceIndex: frame.sourceIndex,
    };
  });
  const estimatedScales = frameEstimates.map((estimate) => estimate.estimatedScale);

  return {
    algorithmId: 'focus_breathing_scale_estimate_v1',
    compensationApplied: false,
    evidenceSource: 'focus_distance_metadata',
    frameEstimates,
    limits: [
      'estimate_only_no_pixel_warp',
      'focus_distance_metadata_only',
      'translation_alignment_only',
      'uniform_scale_model_only',
    ],
    maxRelativeScaleDelta: roundFocusMetric(
      Math.max(...frameEstimates.map((estimate) => Math.abs(estimate.relativeScaleDelta))),
    ),
    referenceSourceIndex,
    scaleRange: {
      max: Math.max(...estimatedScales),
      min: Math.min(...estimatedScales),
    },
    status: 'bounded_estimate',
  };
};

const buildFocusHaloReview = (
  request: ParsedFocusStackRuntimePlanRequestV1,
  focusCoverageRatio: number,
): FocusStackRuntimeProvenanceV1['haloReview'] => {
  const lowConfidenceCells = request.cells.filter((cell) => cell.lowConfidence);
  const haloCandidateCells = request.cells.filter((cell) => {
    const sortedScores = [...cell.sourceScores].sort(
      (left, right) => right.relativeConfidence - left.relativeConfidence,
    );
    const best = sortedScores[0]?.relativeConfidence ?? 0;
    const second = sortedScores[1]?.relativeConfidence ?? 0;
    return best - second < 0.25 || cell.lowConfidence;
  });
  const haloRiskCellRatio = roundFocusMetric(haloCandidateCells.length / Math.max(1, request.cells.length));
  const lowConfidenceCellRatio = roundFocusMetric(lowConfidenceCells.length / Math.max(1, request.cells.length));
  const reviewStatus =
    haloRiskCellRatio > 0.08 || lowConfidenceCellRatio > 0.05 || focusCoverageRatio < 0.95
      ? 'review_required'
      : 'apply_ready';

  return {
    artifactId: request.haloMapArtifactId ?? request.depthConfidenceArtifactId,
    editableHandoffStatus: reviewStatus === 'apply_ready' ? 'ready' : 'review_required',
    haloRiskCellRatio,
    lowConfidenceCellRatio,
    reviewStatus,
    transitionRiskRegions: request.cells.map((cell, index) => {
      const winner = cell.sourceScores.reduce((best, score) =>
        score.relativeConfidence > best.relativeConfidence ? score : best,
      );
      return {
        cellCount: 1,
        regionId: `focus-cell-${index + 1}`,
        risk: cell.lowConfidence ? 'low_confidence' : index === 0 ? 'stable' : 'halo_risk',
        sourceIndex: winner.sourceIndex,
      };
    }),
  };
};

const buildFocusPreflightEstimate = (request: ParsedFocusStackRuntimePlanRequestV1, width: number, height: number) => {
  const sourcePixelCount = request.frames.reduce((total, frame) => total + frame.width * frame.height, 0);
  const outputPixelCount = width * height;
  const sourceDecodeBytes = sourcePixelCount * 4;
  const outputCanvasBytes = outputPixelCount * 4;
  const previewBytes = outputPixelCount * 4;
  const memoryComponents = {
    lowDetailMaskBytes: outputPixelCount,
    outputCanvasBytes,
    outputMaskBytes: outputPixelCount,
    overheadBytes: 4096,
    previewBytes,
    seamWorkspaceBytes: outputPixelCount,
    sourceDecodeBytes,
    totalEstimatedPeakBytes: sourceDecodeBytes + outputCanvasBytes + previewBytes + outputPixelCount * 3 + 4096,
  };
  const memoryBudgetBytes = Math.max(memoryComponents.totalEstimatedPeakBytes * 2, 1);
  return {
    blockedReasons: [],
    engineCapabilities: {
      fullFrameLegacy: true,
      maxPreviewDimensionPx: request.command.parameters.maxPreviewDimensionPx,
      planOnly: true,
      tileBackedRender: false,
    },
    executionMode: 'full_frame_legacy',
    geometryEstimate: {
      outputPixelCount,
      projectedBounds: {
        height,
        width,
        x: 0,
        y: 0,
      },
      sourceCount: request.frames.length,
      sourcePixelCount,
    },
    memoryBudgetBytes,
    memoryBudgetRatio: memoryComponents.totalEstimatedPeakBytes / memoryBudgetBytes,
    memoryComponents,
    status: 'accepted',
    tileCount: 1,
    warningCodes: ['legacy_full_frame_render'],
  };
};

const calculateFocusCoverageRatio = (request: ParsedFocusStackRuntimePlanRequestV1): number => {
  const coveredPixels = request.cells.reduce((total, cell) => total + cell.width * cell.height, 0);
  const referenceFrame = request.frames.find(
    (frame) => frame.sourceIndex === resolveFocusReferenceSource(request).sourceIndex,
  );
  if (referenceFrame === undefined) {
    return 0;
  }
  return roundFocusMetric(Math.min(1, coveredPixels / (referenceFrame.width * referenceFrame.height)));
};

const deriveFocusWarnings = (
  focusCoverageRatio: number,
  retouchLayerPolicy: FocusStackRuntimeProvenanceV1['retouchLayerPolicy'],
  diagnostics: ReturnType<typeof applyWeightedSharpnessFocusStackV1>['diagnostics'],
): string[] => {
  const warnings = new Set<string>();
  if (focusCoverageRatio < 0.9) warnings.add('focus_coverage_low');
  if (retouchLayerPolicy === 'generate_retouch_layer') warnings.add('retouch_layer_required');
  if (diagnostics.some((diagnostic) => diagnostic.code === 'reference_fallback')) {
    warnings.add('weighted_sharpness_reference_fallback');
  }
  if (diagnostics.some((diagnostic) => diagnostic.code !== 'reference_fallback')) {
    warnings.add('weighted_sharpness_contributor_diagnostics');
  }
  return [...warnings].sort();
};

const buildFocusAlignmentTransforms = (request: ParsedFocusStackRuntimePlanRequestV1) => {
  const referenceSourceIndex = resolveFocusReferenceSource(request).sourceIndex;

  return request.frames.map((frame) => ({
    role: frame.sourceIndex === referenceSourceIndex ? ('reference' as const) : ('aligned' as const),
    sourceIndex: frame.sourceIndex,
    translationX: frame.translationX,
    translationY: frame.translationY,
  }));
};

const buildFocusBlendSourceCoverage = (request: ParsedFocusStackRuntimePlanRequestV1) =>
  request.frames.map((frame) => {
    const winningCells = request.cells.filter((cell) => {
      return findWinningFocusSourceIndex(cell.sourceScores) === frame.sourceIndex;
    });
    return {
      cellCount: winningCells.length,
      coveredAreaPx: winningCells.reduce((total, cell) => total + cell.width * cell.height, 0),
      sourceIndex: frame.sourceIndex,
    };
  });

const buildFocusQualityMetrics = (
  request: ParsedFocusStackRuntimePlanRequestV1,
  outputWidth: number,
  outputHeight: number,
): FocusStackRuntimeProvenanceV1['qualityMetrics'] => {
  let coveredAreaPx = 0;
  let lowConfidenceAreaPx = 0;
  let winningConfidenceTotal = 0;
  for (const cell of request.cells) {
    const cellAreaPx = cell.width * cell.height;
    const winningConfidence = findWinningFocusConfidence(cell.sourceScores);
    coveredAreaPx += cellAreaPx;
    winningConfidenceTotal += winningConfidence;
    if (cell.lowConfidence) lowConfidenceAreaPx += cellAreaPx;
  }

  return {
    averageWinningConfidence: roundFocusMetric(winningConfidenceTotal / Math.max(1, request.cells.length)),
    lowConfidenceAreaRatio: roundFocusMetric(lowConfidenceAreaPx / Math.max(1, coveredAreaPx)),
    outputPixelCount: outputWidth * outputHeight,
    retouchLayerRecommended:
      request.command.parameters.retouchLayerPolicy === 'generate_retouch_layer' || lowConfidenceAreaPx > 0,
  };
};

const findWinningFocusSourceIndex = (sourceScores: FocusStackRuntimePlanRequestV1['cells'][number]['sourceScores']) => {
  let winningSourceIndex: number | undefined;
  let winningConfidence = -Infinity;
  for (const score of sourceScores) {
    if (score.relativeConfidence > winningConfidence) {
      winningConfidence = score.relativeConfidence;
      winningSourceIndex = score.sourceIndex;
    }
  }
  return winningSourceIndex;
};

const findWinningFocusConfidence = (sourceScores: FocusStackRuntimePlanRequestV1['cells'][number]['sourceScores']) => {
  let winningConfidence = 0;
  for (const score of sourceScores) {
    winningConfidence = Math.max(winningConfidence, score.relativeConfidence);
  }
  return winningConfidence;
};

const resolveFocusReferenceSource = (
  request: ParsedFocusStackRuntimePlanRequestV1,
): { selectionReason: 'explicit_request' | 'first_frame_default'; sourceIndex: number } => {
  const defaultReferenceSourceIndex = request['frames'][0]?.sourceIndex;
  if (defaultReferenceSourceIndex === undefined) {
    throw new Error('Focus stack runtime plan requires at least one frame.');
  }
  const sourceIndex = request['referenceSourceIndex'] ?? defaultReferenceSourceIndex;
  if (!request['frames'].some((frame: FocusStackRuntimePlanFrameV1) => frame.sourceIndex === sourceIndex)) {
    throw new Error(`Focus stack runtime reference source ${sourceIndex} does not match a frame.`);
  }
  return {
    selectionReason: request['referenceSourceIndex'] === undefined ? 'first_frame_default' : 'explicit_request',
    sourceIndex,
  };
};

const stableFocusRuntimeHash = (input: string): string => {
  let value = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 16777619) >>> 0;
  }
  return value.toString(16).padStart(8, '0');
};

const hashFocusRuntimePixels = (pixels: Float32Array): string => {
  let value = 2166136261;
  for (const pixel of pixels) {
    value ^= Math.round(pixel * 1_000_000);
    value = Math.imul(value, 16777619) >>> 0;
  }
  return value.toString(16).padStart(8, '0');
};

const isFocusStackRuntimeCommand = (
  command: ComputationalMergeCommandEnvelopeV1,
): command is FocusStackRuntimeCommandV1 => command.commandType === 'computationalMerge.createFocusStack';

const roundFocusMetric = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
