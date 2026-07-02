import { z } from 'zod';

import {
  type ArtifactHandleV1,
  artifactHandleV1Schema,
} from '../../../packages/rawengine-schema/src/artifactSchemas.ts';
import {
  focusStackAlignmentModeSchema,
  focusStackBlendMethodSchema,
  focusStackQualityPreferenceSchema,
  focusStackRetouchLayerPolicySchema,
  focusStackReviewOverlayModeSchema,
} from './focusStackUiSchemas';

export const focusStackOutputReviewDecisionSchema = z.enum(['editable_review_required', 'preview_only', 'blocked']);

export const focusStackOutputReviewWarningSchema = z.enum([
  'alignment_low_confidence',
  'focus_coverage_low',
  'high_memory_estimate',
  'human_review_required',
  'parallax_detected',
  'retouch_layer_required',
  'runtime_estimate_high',
  'source_order_unverified',
  'synthetic_runtime_only',
  'transition_halo_risk',
  'depth_map_preview_only',
  'unsupported_blend_method_preview_only',
  'retouch_layer_deferred',
]);
export const focusStackSourceContributionWarningStateSchema = z.enum(['artifact_review_required', 'clear']);
export const focusStackEditableHandoffStatusSchema = z.enum(['blocked', 'ready', 'review_required']);
export const focusStackHaloReviewStatusSchema = z.enum(['apply_ready', 'blocked', 'review_required']);
export const focusStackApplyReceiptStatusSchema = z.enum(['apply_ready', 'blocked', 'preview_only', 'review_required']);
export const focusStackAlignmentReviewStatusSchema = z.enum(['applied', 'not_requested', 'planned', 'review_required']);
export const focusStackRetouchSeedReasonCodeSchema = z.enum([
  'focus_coverage_low',
  'halo_risk',
  'low_confidence',
  'retouch_layer_required',
  'retouch_recommended',
]);
export const focusStackRetouchSeedAvailabilitySchema = z.enum(['available', 'unavailable']);
export const focusStackRetouchSeedStateSchema = z.enum(['current', 'stale', 'unknown']);

export const focusStackRetouchSeedMaskRegionSchema = z
  .object({
    cellCount: z.number().int().positive(),
    regionId: z.string().trim().min(1),
    risk: z.enum(['halo_risk', 'low_confidence', 'retouch_recommended']),
    sourceIndex: z.number().int().nonnegative(),
  })
  .strict();

export const focusStackRetouchSeedSourceCandidateSchema = z
  .object({
    contentHash: z.string().trim().min(1),
    coverageCellCount: z.number().int().positive(),
    graphRevision: z.string().trim().min(1),
    path: z.string().trim().min(1),
    regionIds: z.array(z.string().trim().min(1)).min(1),
    sourceIndex: z.number().int().nonnegative(),
  })
  .strict();

export const focusStackRetouchSeedSchema = z
  .object({
    acceptedDryRunPlanHash: z.string().trim().min(1),
    acceptedDryRunPlanId: z.string().trim().min(1),
    artifactId: z.string().trim().min(1),
    availability: focusStackRetouchSeedAvailabilitySchema,
    maskRegions: z.array(focusStackRetouchSeedMaskRegionSchema).min(1),
    outputContentHash: z.string().trim().min(1),
    previewContentHash: z.string().trim().min(1),
    reasonCodes: z.array(focusStackRetouchSeedReasonCodeSchema).min(1),
    sourceCandidates: z.array(focusStackRetouchSeedSourceCandidateSchema).min(1),
    staleReasons: z.array(focusStackRetouchSeedReasonCodeSchema),
    staleState: focusStackRetouchSeedStateSchema,
  })
  .strict();

export const focusStackBreathingCompensationSchema = z
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
  .strict();

const focusStackSourceRefSchema = z
  .object({
    contentHash: z.string().trim().min(1),
    graphRevision: z.string().trim().min(1),
    path: z.string().trim().min(1),
    sourceIndex: z.number().int().nonnegative(),
  })
  .strict();

export const focusStackOutputReviewWorkflowSchema = z
  .object({
    alignmentMode: focusStackAlignmentModeSchema,
    artifactPath: z.string().min(1),
    applyReceipt: z
      .object({
        alignment: z
          .object({
            confidence: z.number().min(0).max(1).optional(),
            mode: focusStackAlignmentModeSchema,
            status: focusStackAlignmentReviewStatusSchema,
          })
          .strict(),
        artifactHandle: artifactHandleV1Schema,
        artifactPath: z.string().trim().min(1),
        outputPreviewDimensions: z
          .object({
            height: z.number().int().positive(),
            width: z.number().int().positive(),
          })
          .strict()
          .optional(),
        receiptId: z.string().trim().min(1),
        sharpnessQualitySummary: z
          .object({
            lowConfidenceCellRatio: z.number().min(0).max(1).optional(),
            qualityPreference: focusStackQualityPreferenceSchema,
            sharpnessCoverageRatio: z.number().min(0).max(1).optional(),
          })
          .strict()
          .optional(),
        sourceCount: z.number().int().min(2),
        status: focusStackApplyReceiptStatusSchema,
        warnings: z.array(focusStackOutputReviewWarningSchema),
      })
      .strict(),
    blendMethod: focusStackBlendMethodSchema,
    focusBreathingCompensation: focusStackBreathingCompensationSchema.optional(),
    decision: focusStackOutputReviewDecisionSchema,
    editableHandoff: z
      .object({
        artifactHash: z.string().trim().min(1),
        artifactId: z.string().trim().min(1),
        exportReviewArtifactId: z.string().trim().min(1),
        retouchedExportParity: z
          .object({
            comparedFields: z.array(z.string().trim().min(1)),
            exportReceiptHash: z.string().trim().min(1),
            meanAbsDelta: z.literal(0),
            parityProofHash: z.string().trim().min(1),
            previewStateHash: z.string().trim().min(1),
            status: z.literal('matched_retouched_sidecar_output'),
          })
          .strict()
          .optional(),
        status: focusStackEditableHandoffStatusSchema,
      })
      .strict(),
    haloRiskCellRatio: z.number().min(0).max(1),
    haloReview: z
      .object({
        artifactHash: z.string().trim().min(1).optional(),
        artifactId: z.string().trim().min(1),
        reviewStatus: focusStackHaloReviewStatusSchema,
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
    lowConfidenceCellRatio: z.number().min(0).max(1),
    proofLevel: z.literal('synthetic_runtime'),
    qualityPreference: focusStackQualityPreferenceSchema,
    retouchLayerPolicy: focusStackRetouchLayerPolicySchema,
    reviewOverlay: z
      .object({
        confidenceMarginThreshold: z.number().min(0).max(1),
        mode: focusStackReviewOverlayModeSchema,
        opacityPercent: z.number().int().min(25).max(100),
        sourceContributionSummary: z
          .array(
            z
              .object({
                sourceIndex: z.number().int().nonnegative(),
                winnerCellRatio: z.number().min(0).max(1),
              })
              .strict(),
          )
          .min(2),
        sourceContributionDetails: z
          .array(
            z
              .object({
                artifactId: z.string().min(1),
                confidencePercent: z.number().int().min(0).max(100),
                contributionRatio: z.number().min(0).max(1),
                coverageCellCount: z.number().int().positive(),
                sourceId: z.string().min(1),
                sourceIndex: z.number().int().nonnegative(),
                warningState: focusStackSourceContributionWarningStateSchema,
              })
              .strict(),
          )
          .min(2),
      })
      .strict(),
    retouchSeed: focusStackRetouchSeedSchema.optional(),
    sharpnessCoverageRatio: z.number().min(0).max(1),
    sourceCount: z.number().int().min(2),
    sourceRefs: z.array(focusStackSourceRefSchema).min(2),
    warningCodes: z.array(focusStackOutputReviewWarningSchema).min(1),
  })
  .strict()
  .superRefine((workflow, context) => {
    if (workflow.sourceRefs.length !== workflow.sourceCount) {
      context.addIssue({
        code: 'custom',
        message: 'Focus stack sourceRefs length must match sourceCount.',
        path: ['sourceRefs'],
      });
    }
    if (workflow.applyReceipt.sourceCount !== workflow.sourceCount) {
      context.addIssue({
        code: 'custom',
        message: 'Focus stack apply receipt sourceCount must match sourceCount.',
        path: ['applyReceipt', 'sourceCount'],
      });
    }
    if (workflow.applyReceipt.artifactPath !== workflow.artifactPath) {
      context.addIssue({
        code: 'custom',
        message: 'Focus stack apply receipt artifactPath must match artifactPath.',
        path: ['applyReceipt', 'artifactPath'],
      });
    }
  });

export type FocusStackOutputReviewWorkflow = z.infer<typeof focusStackOutputReviewWorkflowSchema>;
export type FocusStackOutputReviewArtifactHandle = ArtifactHandleV1;
