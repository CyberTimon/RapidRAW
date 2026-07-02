import { z } from 'zod';

import {
  hdrDeghostingModeV1Schema,
  hdrMaskArtifactV1Schema,
} from '../../../packages/rawengine-schema/src/rawEngineSchemas';
import {
  focusStackBreathingCompensationSchema,
  focusStackRetouchSeedSchema,
} from '../focus-stack/focusStackOutputReviewSchemas';

export const derivedOutputFamilySchema = z.enum(['focus_stack', 'hdr', 'panorama', 'super_resolution']);
export const derivedOutputStoragePolicySchema = z.enum(['export_path', 'sidecar_artifact', 'temp_cache']);
export const derivedOutputOpenActionStateSchema = z.enum(['available', 'deferred', 'unavailable']);
export const derivedOutputStaleReasonSchema = z.enum([
  'accepted_dry_run_plan_changed',
  'output_artifact_changed',
  'recipe_hash_changed',
  'settings_hash_changed',
  'source_content_hash_changed',
  'source_graph_revision_changed',
  'source_order_changed',
  'source_set_changed',
]);

export const derivedOutputProvenanceSourceSchema = z
  .object({
    contentHash: z.string().trim().min(1),
    graphRevision: z.string().trim().min(1),
    order: z.number().int().nonnegative(),
    path: z.string().trim().min(1).optional(),
  })
  .strict();

const derivedOutputDimensionsSchema = z
  .object({
    height: z.number().int().positive(),
    width: z.number().int().positive(),
  })
  .strict();

const derivedOutputPanoramaMetadataSchema = z
  .object({
    boundary: z
      .object({
        crop: z
          .object({
            height: z.number().int().positive(),
            mode: z.string().trim().min(1),
            preCropHeight: z.number().int().positive(),
            preCropWidth: z.number().int().positive(),
            width: z.number().int().positive(),
            x: z.number().int().nonnegative(),
            y: z.number().int().nonnegative(),
          })
          .strict(),
        effectiveMode: z.enum(['auto_crop', 'manual_crop', 'transparent']),
        fillColor: z
          .object({
            alpha: z.number().min(0).max(1),
            blue: z.number().min(0).max(1),
            green: z.number().min(0).max(1),
            red: z.number().min(0).max(1),
          })
          .strict()
          .optional(),
        manualCropInsetsPercent: z
          .object({
            bottom: z.number().min(0).max(40),
            left: z.number().min(0).max(40),
            right: z.number().min(0).max(40),
            top: z.number().min(0).max(40),
          })
          .strict()
          .optional(),
        overlapFeatherPx: z.number().int().min(0).max(512).optional(),
        requestedMode: z.enum(['auto_crop', 'manual_crop', 'transparent']),
      })
      .strict(),
    previewDimensions: derivedOutputDimensionsSchema,
    projection: z
      .object({
        effective: z.enum(['rectilinear', 'cylindrical', 'spherical']),
        requested: z.enum(['rectilinear', 'cylindrical', 'spherical']),
      })
      .strict(),
    seamExposureCompensationPercent: z.number().int().min(0).max(100).optional(),
    sourceSetHash: z.string().trim().min(1),
  })
  .strict();

const derivedOutputHdrMetadataSchema = z
  .object({
    deghostMaskArtifactCount: z.number().int().nonnegative(),
    deghostMaskArtifacts: z.array(hdrMaskArtifactV1Schema),
    motionCoverageRatio: z.number().min(0).max(1),
    requestedDeghosting: hdrDeghostingModeV1Schema,
  })
  .strict()
  .superRefine((metadata, context) => {
    if (metadata.deghostMaskArtifactCount !== metadata.deghostMaskArtifacts.length) {
      context.addIssue({
        code: 'custom',
        message: 'HDR deghost mask artifact count must match artifact handles.',
        path: ['deghostMaskArtifactCount'],
      });
    }
  });

export const derivedOutputProvenanceSidecarSchema = z
  .object({
    acceptedApplyId: z.string().trim().min(1).optional(),
    acceptedDryRunId: z.string().trim().min(1).optional(),
    app: z
      .object({
        buildVersion: z.string().trim().min(1),
        id: z.literal('io.github.CyberTimon.RapidRAW'),
        name: z.literal('RapidRAW'),
      })
      .strict(),
    output: z
      .object({
        contentHash: z.string().trim().min(1),
        path: z.string().trim().min(1),
      })
      .strict(),
    receipt: z
      .object({
        family: derivedOutputFamilySchema,
        receiptId: z.string().trim().min(1),
      })
      .strict(),
    schemaVersion: z.literal(1),
    settingsHash: z.string().trim().min(1),
    sidecarPath: z.string().trim().min(1),
    sourceState: z.array(derivedOutputProvenanceSourceSchema).min(1),
    focusStack: z
      .object({
        breathingCompensation: focusStackBreathingCompensationSchema.optional(),
        retouchSeed: focusStackRetouchSeedSchema.optional(),
      })
      .strict()
      .refine((metadata) => metadata.breathingCompensation !== undefined || metadata.retouchSeed !== undefined, {
        message: 'Focus stack receipt metadata requires breathing compensation or retouch seed evidence.',
      })
      .optional(),
    hdr: derivedOutputHdrMetadataSchema.optional(),
    panorama: derivedOutputPanoramaMetadataSchema.optional(),
    superResolution: z
      .object({
        registrationMetrics: z
          .object({
            algorithmId: z.literal('output_lattice_phase_residual_v1'),
            averageConfidence: z.number().min(0).max(1),
            averageResidualPx: z.number().min(0),
            maxResidualPx: z.number().min(0),
            measuredSubpixelFrameCount: z.number().int().nonnegative(),
          })
          .strict(),
        supportMap: z
          .object({
            artifactId: z.string().trim().min(1),
            coverageRatio: z.number().min(0).max(1),
            effectiveScale: z.number().min(1).max(4),
            requestedScale: z.number().min(1.1).max(4),
            reviewStatus: z.enum(['apply_ready', 'blocked', 'review_required']),
            weakSupportRatio: z.number().min(0).max(1),
          })
          .strict(),
      })
      .strict()
      .optional(),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict()
  .superRefine((sidecar, context) => {
    const sourceOrders = new Set<number>();
    for (const [index, source] of sidecar.sourceState.entries()) {
      if (source.order !== index) {
        context.addIssue({
          code: 'custom',
          message: 'Derived output provenance source order must match array order.',
          path: ['sourceState', index, 'order'],
        });
      }
      if (sourceOrders.has(source.order)) {
        context.addIssue({
          code: 'custom',
          message: 'Derived output provenance source order must be unique.',
          path: ['sourceState', index, 'order'],
        });
      }
      sourceOrders.add(source.order);
    }
  });

export const derivedOutputReceiptSchema = z
  .object({
    family: derivedOutputFamilySchema,
    acceptedDryRunPlanHash: z.string().trim().min(1).optional(),
    acceptedDryRunPlanId: z.string().trim().min(1).optional(),
    openInEditorAction: z
      .object({
        label: z.string().trim().min(1),
        path: z.string().trim().min(1).optional(),
        state: derivedOutputOpenActionStateSchema,
      })
      .strict(),
    outputArtifactId: z.string().trim().min(1),
    outputContentHash: z.string().trim().min(1),
    outputPath: z.string().trim().min(1).optional(),
    focusStack: z
      .object({
        breathingCompensation: focusStackBreathingCompensationSchema.optional(),
        retouchSeed: focusStackRetouchSeedSchema.optional(),
      })
      .strict()
      .refine((metadata) => metadata.breathingCompensation !== undefined || metadata.retouchSeed !== undefined, {
        message: 'Focus stack sidecar metadata requires breathing compensation or retouch seed evidence.',
      })
      .optional(),
    hdr: derivedOutputHdrMetadataSchema.optional(),
    panorama: derivedOutputPanoramaMetadataSchema.optional(),
    previewDimensions: derivedOutputDimensionsSchema.optional(),
    recipeHash: z.string().trim().min(1).optional(),
    provenanceSidecar: derivedOutputProvenanceSidecarSchema.optional(),
    receiptId: z.string().trim().min(1),
    settingsHash: z.string().trim().min(1),
    sourceContentHashes: z.array(z.string().trim().min(1)).min(1),
    sourceCount: z.number().int().positive(),
    sourceGraphRevisions: z.array(z.string().trim().min(1)).min(1),
    sourcePaths: z.array(z.string().trim().min(1)).optional(),
    staleReasons: z.array(derivedOutputStaleReasonSchema).optional(),
    staleState: z.enum(['current', 'stale', 'unknown']),
    storagePolicy: derivedOutputStoragePolicySchema,
    warningCodes: z.array(z.string().trim().min(1)).optional(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.sourceContentHashes.length !== receipt.sourceCount) {
      context.addIssue({
        code: 'custom',
        message: 'Derived output sourceContentHashes length must match sourceCount.',
        path: ['sourceContentHashes'],
      });
    }
    if (receipt.sourceGraphRevisions.length !== receipt.sourceCount) {
      context.addIssue({
        code: 'custom',
        message: 'Derived output sourceGraphRevisions length must match sourceCount.',
        path: ['sourceGraphRevisions'],
      });
    }
    if (receipt.sourcePaths !== undefined && receipt.sourcePaths.length !== receipt.sourceCount) {
      context.addIssue({
        code: 'custom',
        message: 'Derived output sourcePaths length must match sourceCount.',
        path: ['sourcePaths'],
      });
    }
    if (receipt.openInEditorAction.state === 'available' && receipt.openInEditorAction.path === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Available derived output open actions require a path.',
        path: ['openInEditorAction', 'path'],
      });
    }
    if (receipt.staleState === 'stale' && (receipt.staleReasons?.length ?? 0) === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Stale derived output receipts require at least one stale reason.',
        path: ['staleReasons'],
      });
    }
    if (receipt.staleState !== 'stale' && receipt.staleReasons !== undefined && receipt.staleReasons.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'Current derived output receipts must not carry stale reasons.',
        path: ['staleReasons'],
      });
    }
    if (receipt.provenanceSidecar !== undefined) {
      if (receipt.outputPath === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Derived output provenance sidecars require an output path.',
          path: ['provenanceSidecar'],
        });
      }
      if (receipt.provenanceSidecar.receipt.receiptId !== receipt.receiptId) {
        context.addIssue({
          code: 'custom',
          message: 'Derived output provenance sidecar receipt id must match receipt.',
          path: ['provenanceSidecar', 'receipt', 'receiptId'],
        });
      }
      if (receipt.provenanceSidecar.receipt.family !== receipt.family) {
        context.addIssue({
          code: 'custom',
          message: 'Derived output provenance sidecar family must match receipt.',
          path: ['provenanceSidecar', 'receipt', 'family'],
        });
      }
      if (receipt.provenanceSidecar.output.contentHash !== receipt.outputContentHash) {
        context.addIssue({
          code: 'custom',
          message: 'Derived output provenance sidecar output hash must match receipt.',
          path: ['provenanceSidecar', 'output', 'contentHash'],
        });
      }
      if (receipt.provenanceSidecar.output.path !== receipt.outputPath) {
        context.addIssue({
          code: 'custom',
          message: 'Derived output provenance sidecar output path must match receipt.',
          path: ['provenanceSidecar', 'output', 'path'],
        });
      }
      if (receipt.provenanceSidecar.settingsHash !== receipt.settingsHash) {
        context.addIssue({
          code: 'custom',
          message: 'Derived output provenance sidecar settings hash must match receipt.',
          path: ['provenanceSidecar', 'settingsHash'],
        });
      }
      if (receipt.provenanceSidecar.sourceState.length !== receipt.sourceCount) {
        context.addIssue({
          code: 'custom',
          message: 'Derived output provenance sidecar source count must match receipt.',
          path: ['provenanceSidecar', 'sourceState'],
        });
      }
      if (receipt.panorama !== undefined && receipt.provenanceSidecar.panorama !== undefined) {
        const receiptPanorama = JSON.stringify(receipt.panorama);
        const sidecarPanorama = JSON.stringify(receipt.provenanceSidecar.panorama);
        if (receiptPanorama !== sidecarPanorama) {
          context.addIssue({
            code: 'custom',
            message: 'Derived output panorama sidecar metadata must match receipt.',
            path: ['provenanceSidecar', 'panorama'],
          });
        }
      }
      if (receipt.focusStack !== undefined && receipt.provenanceSidecar.focusStack !== undefined) {
        const receiptFocusStack = JSON.stringify(receipt.focusStack);
        const sidecarFocusStack = JSON.stringify(receipt.provenanceSidecar.focusStack);
        if (receiptFocusStack !== sidecarFocusStack) {
          context.addIssue({
            code: 'custom',
            message: 'Derived output focus stack sidecar metadata must match receipt.',
            path: ['provenanceSidecar', 'focusStack'],
          });
        }
      }
      if (receipt.hdr !== undefined && receipt.provenanceSidecar.hdr !== undefined) {
        const receiptHdr = JSON.stringify(receipt.hdr);
        const sidecarHdr = JSON.stringify(receipt.provenanceSidecar.hdr);
        if (receiptHdr !== sidecarHdr) {
          context.addIssue({
            code: 'custom',
            message: 'Derived output HDR sidecar metadata must match receipt.',
            path: ['provenanceSidecar', 'hdr'],
          });
        }
      }
    }
  });

export type DerivedOutputReceipt = z.infer<typeof derivedOutputReceiptSchema>;
export type DerivedOutputStaleReason = z.infer<typeof derivedOutputStaleReasonSchema>;
export type DerivedOutputProvenanceSidecar = z.infer<typeof derivedOutputProvenanceSidecarSchema>;
