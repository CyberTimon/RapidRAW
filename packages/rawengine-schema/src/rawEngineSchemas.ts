import { z } from 'zod';

import { createAppServerCommandSchemasV1 } from './appServerCommandSchemas.js';
import { artifactHandleV1Schema } from './artifactSchemas.js';
import { panoramaHomographyDltDiagnosticsV1Schema } from './panorama/panoramaHomographyDiagnostics.js';
import { createToneColorSchemasV1 } from './toneColorSchemas.js';

export type { ArtifactHandleV1 } from './artifactSchemas.js';
export { artifactHandleV1Schema, negativeLabPositiveArtifactHandleV1Schema } from './artifactSchemas.js';

export const RAW_ENGINE_SCHEMA_VERSION = 1;

export const ActorKind = {
  Agent: 'agent',
  Batch: 'batch',
  Cli: 'cli',
  Plugin: 'plugin',
  Server: 'server',
  Test: 'test',
  Ui: 'ui',
} as const;

export const actorKindSchema = z.enum([
  ActorKind.Agent,
  ActorKind.Batch,
  ActorKind.Cli,
  ActorKind.Plugin,
  ActorKind.Server,
  ActorKind.Test,
  ActorKind.Ui,
]);

export const ApprovalClass = {
  BatchApply: 'batch_apply',
  CloudService: 'cloud_service',
  EditApply: 'edit_apply',
  ExpensiveJob: 'expensive_job',
  ExternalModel: 'external_model',
  FileMutation: 'file_mutation',
  GenerativeEdit: 'generative_edit',
  ModelSupplyChain: 'model_supply_chain',
  PreviewOnly: 'preview_only',
  SafeRead: 'safe_read',
  UnsafeImport: 'unsafe_import',
} as const;

export const approvalClassSchema = z.enum([
  ApprovalClass.SafeRead,
  ApprovalClass.PreviewOnly,
  ApprovalClass.EditApply,
  ApprovalClass.BatchApply,
  ApprovalClass.FileMutation,
  ApprovalClass.ExternalModel,
  ApprovalClass.CloudService,
  ApprovalClass.GenerativeEdit,
  ApprovalClass.ExpensiveJob,
  ApprovalClass.UnsafeImport,
  ApprovalClass.ModelSupplyChain,
]);

export const approvalStateSchema = z.enum(['not_required', 'pending', 'approved', 'denied']);

export const rawEngineActorSchema = z
  .object({
    id: z.string().trim().min(1),
    kind: actorKindSchema,
    sessionId: z.string().trim().min(1).optional(),
  })
  .strict();

export const rawEngineTargetKindSchema = z.enum([
  'project',
  'image',
  'virtual_copy',
  'layer',
  'mask',
  'artifact',
  'roll',
  'export',
]);

export const rawEngineTargetSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    imagePath: z.string().trim().min(1).optional(),
    kind: rawEngineTargetKindSchema,
    virtualCopyId: z.string().trim().min(1).nullable().optional(),
  })
  .strict()
  .refine((target) => target.id !== undefined || target.imagePath !== undefined, {
    message: 'Target requires an id or imagePath.',
  });

export const approvalRequirementSchema = z
  .object({
    approvalClass: approvalClassSchema,
    reason: z.string().trim().min(1),
    recordId: z.string().trim().min(1).optional(),
    state: approvalStateSchema,
  })
  .strict();

export const commandEnvelopeV1Schema = z
  .object({
    actor: rawEngineActorSchema,
    approval: approvalRequirementSchema,
    commandId: z.string().trim().min(1),
    commandType: z.string().trim().min(1),
    correlationId: z.string().trim().min(1),
    dryRun: z.boolean(),
    expectedGraphRevision: z.string().trim().min(1).optional(),
    idempotencyKey: z.string().trim().min(1).optional(),
    parameters: z.record(z.string(), z.unknown()),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    target: rawEngineTargetSchema,
  })
  .strict();

export const queryEnvelopeV1Schema = z
  .object({
    actor: rawEngineActorSchema,
    correlationId: z.string().trim().min(1),
    parameters: z.record(z.string(), z.unknown()),
    queryId: z.string().trim().min(1),
    queryType: z.string().trim().min(1),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    target: rawEngineTargetSchema,
  })
  .strict();

export const rawEngineToolKindSchema = z.enum(['read', 'preview', 'dry_run', 'apply', 'export', 'job']);

export const rawEngineToolDefinitionV1Schema = z
  .object({
    approvalClass: approvalClassSchema,
    inputSchemaName: z.string().trim().min(1),
    mutates: z.boolean(),
    outputSchemaName: z.string().trim().min(1),
    requiresDryRun: z.boolean(),
    returnsArtifactHandles: z.boolean(),
    toolKind: rawEngineToolKindSchema,
    toolName: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/u),
  })
  .strict();

export const rawEngineToolRegistryV1Schema = z
  .object({
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    tools: z.array(rawEngineToolDefinitionV1Schema).min(1),
  })
  .strict();

export const rawEngineColorDomainV1Schema = z.enum([
  'camera_linear_rgb',
  'acescg_linear_v1',
  'scene_referred_lut_input',
  'display_referred_rgb',
  'display_profile_output',
  'negative_acquisition_rgb',
  'derived_artifact_source',
]);

export const rawEngineWorkingColorSpaceV1Schema = z.enum(['acescg_linear_v1']);

export const rawEngineSceneToDisplayTransformV1Schema = z.enum(['rawengine_agx_v1', 'rawengine_basic_v1']);

export const rawEngineOutputProfileV1Schema = z.enum(['srgb', 'display_p3']);

export const rawEngineRenderBitDepthV1Schema = z.union([z.literal(8), z.literal(16), z.literal(32)]);

export const rawEngineRenderingIntentV1Schema = z.enum(['relative_colorimetric', 'perceptual', 'scene_referred']);

export const rawEngineWhitePointXyV1Schema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  })
  .strict();

export const rawEngineChromaticAdaptationMethodV1Schema = z.enum([
  'bradford_v1',
  'identity_same_white_v1',
  'unsupported_or_unknown_v1',
]);

export const rawEngineChromaticAdaptationStatusV1Schema = z.enum([
  'schema_only',
  'math_validated',
  'applied_preview',
  'applied_render',
  'skipped',
  'blocked',
]);

export const rawEngineChromaticAdaptationV1Schema = z
  .object({
    method: rawEngineChromaticAdaptationMethodV1Schema,
    sourceWhitePoint: rawEngineWhitePointXyV1Schema,
    status: rawEngineChromaticAdaptationStatusV1Schema,
    targetWhitePoint: rawEngineWhitePointXyV1Schema,
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict()
  .superRefine((adaptation, context) => {
    const sameWhitePoint =
      adaptation.sourceWhitePoint.x === adaptation.targetWhitePoint.x &&
      adaptation.sourceWhitePoint.y === adaptation.targetWhitePoint.y;

    if (adaptation.method === 'identity_same_white_v1' && !sameWhitePoint) {
      context.addIssue({
        code: 'custom',
        message: 'Identity chromatic adaptation requires matching source and target white points.',
        path: ['method'],
      });
    }

    if (adaptation.method === 'unsupported_or_unknown_v1' && adaptation.status !== 'blocked') {
      context.addIssue({
        code: 'custom',
        message: 'Unsupported chromatic adaptation must be blocked.',
        path: ['status'],
      });
    }

    if (adaptation.status === 'schema_only' && adaptation.warnings.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Schema-only chromatic adaptation requires at least one warning.',
        path: ['warnings'],
      });
    }

    if (adaptation.status === 'blocked' && adaptation.warnings.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Blocked chromatic adaptation requires at least one warning.',
        path: ['warnings'],
      });
    }
  });

export const rawEngineRenderTargetV1Schema = z
  .object({
    bitDepth: rawEngineRenderBitDepthV1Schema,
    embedIcc: z.boolean(),
    intent: rawEngineRenderingIntentV1Schema,
    outputProfile: rawEngineOutputProfileV1Schema,
    viewTransform: rawEngineSceneToDisplayTransformV1Schema,
  })
  .strict();

export const rawEngineGamutMappingDestinationV1Schema = z.enum(['srgb', 'display_p3', 'scene_referred']);

export const rawEngineGamutMappingMethodV1Schema = z.enum([
  'none_scene_referred_v1',
  'relative_colorimetric_clip_fallback_v1',
  'perceptual_oklab_chroma_reduce_export_v1',
  'perceptual_oklch_chroma_reduce_planned_v1',
]);

export const rawEngineGamutMappingStatusV1Schema = z.enum([
  'schema_only',
  'cpu_reference_planned',
  'export_runtime_applied',
]);

export const rawEngineGamutMappingWarningCodeV1Schema = z.enum([
  'output_gamut_high_component_v1',
  'output_gamut_mapping_not_runtime_applied_v1',
  'output_gamut_negative_component_v1',
  'output_gamut_preview_not_runtime_applied_v1',
  'output_gamut_perceptual_cpu_reference_v1',
  'output_gamut_perceptual_intent_unproven_v1',
]);

export const rawEngineRgbTripletV1Schema = z.tuple([z.number(), z.number(), z.number()]);

export const rawEngineGamutMappingPolicyV1Schema = z
  .object({
    destination: rawEngineGamutMappingDestinationV1Schema,
    intent: rawEngineRenderingIntentV1Schema,
    method: rawEngineGamutMappingMethodV1Schema,
    status: rawEngineGamutMappingStatusV1Schema,
    warnings: z.array(rawEngineGamutMappingWarningCodeV1Schema),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.status === 'schema_only' && !policy.warnings.includes('output_gamut_mapping_not_runtime_applied_v1')) {
      context.addIssue({
        code: 'custom',
        message: 'Schema-only gamut mapping must warn that runtime application is not proven.',
        path: ['warnings'],
      });
    }

    if (
      policy.intent === 'perceptual' &&
      policy.status !== 'export_runtime_applied' &&
      !policy.warnings.includes('output_gamut_perceptual_intent_unproven_v1')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Perceptual gamut mapping must remain warning-gated until runtime proof exists.',
        path: ['warnings'],
      });
    }

    if (
      policy.status === 'export_runtime_applied' &&
      !policy.warnings.includes('output_gamut_preview_not_runtime_applied_v1')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Export-applied gamut mapping must disclose that preview/display application is not proven.',
        path: ['warnings'],
      });
    }

    if (policy.destination === 'scene_referred' && policy.method !== 'none_scene_referred_v1') {
      context.addIssue({
        code: 'custom',
        message: 'Scene-referred policy must not apply an output gamut map.',
        path: ['method'],
      });
    }

    if (policy.destination !== 'scene_referred' && policy.method === 'none_scene_referred_v1') {
      context.addIssue({
        code: 'custom',
        message: 'Output destinations require an explicit gamut mapping method.',
        path: ['method'],
      });
    }
  });

export const rawEngineGamutMappingFixtureCaseV1Schema = z
  .object({
    destinationLinearRgbBeforeMap: rawEngineRgbTripletV1Schema,
    expectedClassification: z.enum(['in_gamut', 'high_component', 'negative_component', 'mixed_out_of_gamut']),
    id: z.string().regex(/^gamut\.[a-z0-9.-]+\.v[0-9]+$/u),
    notes: z.string().trim().min(1),
    policy: rawEngineGamutMappingPolicyV1Schema,
  })
  .strict();

export const rawEngineGamutMappingFixtureManifestV1Schema = z
  .object({
    $schema: z.url(),
    cases: z.array(rawEngineGamutMappingFixtureCaseV1Schema).min(1),
    issue: z.literal(94),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    snapshotDate: z.iso.date(),
    validationMode: z.literal('schema_fixture_contract'),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = manifest.cases.map((testCase) => testCase.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', message: 'Gamut mapping fixture IDs must be unique.', path: ['cases'] });
    }
  });

export const rawEngineColorPipelineContextV1Schema = z
  .object({
    chromaticAdaptation: rawEngineChromaticAdaptationV1Schema,
    gamutMapping: rawEngineGamutMappingPolicyV1Schema.optional(),
    inputDomain: rawEngineColorDomainV1Schema,
    operationDomain: rawEngineColorDomainV1Schema,
    renderTarget: rawEngineRenderTargetV1Schema.optional(),
    sceneToDisplayTransform: rawEngineSceneToDisplayTransformV1Schema.optional(),
    workingSpace: rawEngineWorkingColorSpaceV1Schema,
  })
  .strict()
  .superRefine((contextValue, context) => {
    if (contextValue.operationDomain === 'display_referred_rgb' && contextValue.sceneToDisplayTransform === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Display-referred operations require an explicit scene-to-display transform.',
        path: ['sceneToDisplayTransform'],
      });
    }
  });

export const previewScopeKindV1Schema = z.enum(['histogram', 'waveform', 'rgb_parade', 'vectorscope']);

export const previewScopeChannelV1Schema = z.enum(['red', 'green', 'blue', 'luma', 'rgb']);

export const previewScopeRenderBasisV1Schema = z.enum([
  'editor_preview',
  'working_rgb',
  'display_referred',
  'export_preview',
]);

export const previewScopeSoftProofWarningCodeV1Schema = z.enum([
  'export_profile_transform_applied',
  'export_profile_transform_missing',
  'gamut_warning_available',
  'render_target_matches_export_recipe',
]);

export const previewScopeSoftProofMetadataV1Schema = z
  .object({
    basis: z.literal('export_preview'),
    bitDepth: rawEngineRenderBitDepthV1Schema,
    embedIcc: z.boolean(),
    outputProfile: rawEngineOutputProfileV1Schema,
    renderingIntent: rawEngineRenderingIntentV1Schema,
    transformApplied: z.boolean(),
    transformPolicyFingerprint: z
      .string()
      .trim()
      .regex(/^sha256:/u),
    viewTransform: rawEngineSceneToDisplayTransformV1Schema,
    warningCodes: z.array(previewScopeSoftProofWarningCodeV1Schema),
  })
  .strict()
  .superRefine((metadata, context) => {
    if (metadata.transformApplied && !metadata.warningCodes.includes('export_profile_transform_applied')) {
      context.addIssue({
        code: 'custom',
        message: 'Applied export-preview scope transforms must report export_profile_transform_applied.',
        path: ['warningCodes'],
      });
    }
    if (!metadata.transformApplied && !metadata.warningCodes.includes('export_profile_transform_missing')) {
      context.addIssue({
        code: 'custom',
        message: 'Missing export-preview scope transforms must report export_profile_transform_missing.',
        path: ['warningCodes'],
      });
    }
  });

export const previewScopeQueryV1Schema = queryEnvelopeV1Schema
  .extend({
    parameters: z
      .object({
        binCount: z.number().int().min(16).max(4096),
        includeScopes: z.array(previewScopeKindV1Schema).min(1),
        maxDimensionPx: z.number().int().positive().max(8192),
        renderBasis: previewScopeRenderBasisV1Schema,
        renderTarget: rawEngineRenderTargetV1Schema.optional(),
        sourceArtifactId: z.string().trim().min(1).optional(),
        workingSpace: rawEngineWorkingColorSpaceV1Schema,
      })
      .strict(),
    queryType: z.literal('preview.scopes.read'),
    target: rawEngineTargetSchema.safeExtend({ kind: z.literal('image') }).strict(),
  })
  .strict()
  .superRefine((query, context) => {
    if (query.parameters.renderBasis === 'export_preview' && query.parameters.renderTarget === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Export-preview scope queries require an explicit render target.',
        path: ['parameters', 'renderTarget'],
      });
    }
  });

export const previewHistogramChannelV1Schema = z
  .object({
    bins: z.array(z.number().nonnegative()).min(1),
    channel: previewScopeChannelV1Schema,
    clippedHighRatio: z.number().min(0).max(1),
    clippedLowRatio: z.number().min(0).max(1),
    percentile01: z.number().min(0).max(1),
    percentile99: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((channel, context) => {
    if (channel.percentile01 > channel.percentile99) {
      context.addIssue({
        code: 'custom',
        message: 'Histogram percentile01 must be less than or equal to percentile99.',
        path: ['percentile01'],
      });
    }
  });

export const previewHistogramScopeV1Schema = z
  .object({
    binCount: z.number().int().min(16).max(4096),
    channels: z.array(previewHistogramChannelV1Schema).min(1),
  })
  .strict()
  .superRefine((histogram, context) => {
    const seenChannels = new Set<string>();

    histogram.channels.forEach((channel, index) => {
      if (channel.bins.length !== histogram.binCount) {
        context.addIssue({
          code: 'custom',
          message: 'Histogram channel bin length must match binCount.',
          path: ['channels', index, 'bins'],
        });
      }

      if (seenChannels.has(channel.channel)) {
        context.addIssue({
          code: 'custom',
          message: 'Histogram channels must be unique.',
          path: ['channels', index, 'channel'],
        });
      }

      seenChannels.add(channel.channel);
    });
  });

export const previewRasterScopeV1Schema = z
  .object({
    artifact: artifactHandleV1Schema,
    channel: z.enum(['red', 'green', 'blue', 'luma', 'rgb', 'parade', 'vectorscope']),
    encodedFormat: z.enum(['rgba_u8_base64', 'png_base64', 'artifact_handle']),
    height: z.number().int().positive(),
    width: z.number().int().positive(),
  })
  .strict();

export const previewScopeResultV1Schema = z
  .object({
    colorManaged: z.boolean(),
    colorPipeline: rawEngineColorPipelineContextV1Schema,
    histogram: previewHistogramScopeV1Schema.optional(),
    queryId: z.string().trim().min(1),
    renderBasis: previewScopeRenderBasisV1Schema,
    rgbParade: previewRasterScopeV1Schema.optional(),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    softProof: previewScopeSoftProofMetadataV1Schema.optional(),
    sourceArtifactId: z.string().trim().min(1).optional(),
    sourceImagePath: z.string().trim().min(1),
    vectorscope: previewRasterScopeV1Schema.optional(),
    warnings: z.array(z.string().trim().min(1)),
    waveform: previewRasterScopeV1Schema.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.histogram === undefined &&
      result.waveform === undefined &&
      result.rgbParade === undefined &&
      result.vectorscope === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Preview scope results require at least one scope payload.',
        path: ['histogram'],
      });
    }

    if (result.rgbParade !== undefined && result.rgbParade.channel !== 'parade') {
      context.addIssue({
        code: 'custom',
        message: 'RGB parade payloads must use the parade channel.',
        path: ['rgbParade', 'channel'],
      });
    }

    if (result.vectorscope !== undefined && result.vectorscope.channel !== 'vectorscope') {
      context.addIssue({
        code: 'custom',
        message: 'Vectorscope payloads must use the vectorscope channel.',
        path: ['vectorscope', 'channel'],
      });
    }

    if (result.renderBasis === 'export_preview') {
      if (result.softProof === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Export-preview scope results require soft-proof metadata.',
          path: ['softProof'],
        });
      }
      if (result.colorPipeline.renderTarget === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Export-preview scope results require color pipeline render target metadata.',
          path: ['colorPipeline', 'renderTarget'],
        });
      }
    }
  });

export const exportImageFormatV1Schema = z.enum(['jpeg', 'png', 'tiff']);

export const exportColorSpaceV1Schema = z.enum(['srgb', 'display_p3', 'adobe_rgb', 'prophoto_rgb']);

export const exportResizeModeV1Schema = z.enum(['original', 'fit_long_edge', 'fit_box']);

export const exportCommandEnvelopeV1Schema = commandEnvelopeV1Schema
  .extend({
    commandType: z.enum(['export.planFiles', 'export.writeFiles']),
    parameters: z
      .object({
        acceptedExportPlanHash: z.string().trim().min(1).optional(),
        acceptedExportPlanId: z.string().trim().min(1).optional(),
        bitDepth: z.union([z.literal(8), z.literal(16)]),
        colorSpace: exportColorSpaceV1Schema,
        destinationDirectory: z.string().trim().min(1).optional(),
        fileNamePattern: z.string().trim().min(1),
        format: exportImageFormatV1Schema,
        includeMetadata: z.boolean(),
        jpegQuality: z.number().int().min(1).max(100).optional(),
        maxHeightPx: z.number().int().positive().optional(),
        maxLongEdgePx: z.number().int().positive().optional(),
        maxWidthPx: z.number().int().positive().optional(),
        outputSharpening: z.enum(['none', 'screen', 'matte_paper', 'glossy_paper']),
        renderTarget: rawEngineRenderTargetV1Schema,
        resizeMode: exportResizeModeV1Schema,
      })
      .strict(),
    target: rawEngineTargetSchema.safeExtend({ kind: z.literal('image') }).strict(),
  })
  .strict()
  .superRefine((command, context) => {
    if (command.parameters.format === 'jpeg' && command.parameters.bitDepth !== 8) {
      context.addIssue({
        code: 'custom',
        message: 'JPEG exports must use 8-bit output.',
        path: ['parameters', 'bitDepth'],
      });
    }

    if (command.parameters.format !== 'jpeg' && command.parameters.jpegQuality !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Only JPEG exports may include jpegQuality.',
        path: ['parameters', 'jpegQuality'],
      });
    }

    if (command.parameters.resizeMode === 'fit_long_edge' && command.parameters.maxLongEdgePx === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'fit_long_edge exports require maxLongEdgePx.',
        path: ['parameters', 'maxLongEdgePx'],
      });
    }

    if (
      command.parameters.resizeMode === 'fit_box' &&
      (command.parameters.maxWidthPx === undefined || command.parameters.maxHeightPx === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'fit_box exports require maxWidthPx and maxHeightPx.',
        path: ['parameters'],
      });
    }

    if (command.dryRun) {
      if (command.commandType !== 'export.planFiles') {
        context.addIssue({
          code: 'custom',
          message: 'Export dry-run commands must use export.planFiles.',
          path: ['commandType'],
        });
      }

      if (command.approval.approvalClass !== ApprovalClass.PreviewOnly) {
        context.addIssue({
          code: 'custom',
          message: 'Export dry-run commands require preview-only approval classification.',
          path: ['approval', 'approvalClass'],
        });
      }

      if (command.parameters.acceptedExportPlanId !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Export dry-run commands must not accept an existing export plan id.',
          path: ['parameters', 'acceptedExportPlanId'],
        });
      }
    } else {
      if (command.commandType !== 'export.writeFiles') {
        context.addIssue({
          code: 'custom',
          message: 'Export write commands must use export.writeFiles.',
          path: ['commandType'],
        });
      }

      if (command.approval.approvalClass !== ApprovalClass.FileMutation) {
        context.addIssue({
          code: 'custom',
          message: 'Export write commands require file-mutation approval classification.',
          path: ['approval', 'approvalClass'],
        });
      }

      if (command.approval.state !== 'approved') {
        context.addIssue({
          code: 'custom',
          message: 'Export write commands require approved user approval.',
          path: ['approval', 'state'],
        });
      }

      if (command.parameters.destinationDirectory === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Export write commands require a destination directory.',
          path: ['parameters', 'destinationDirectory'],
        });
      }

      if (command.parameters.acceptedExportPlanId === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Export write commands require an accepted export plan id.',
          path: ['parameters', 'acceptedExportPlanId'],
        });
      }

      if (command.parameters.acceptedExportPlanHash === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Export write commands require an accepted export plan hash.',
          path: ['parameters', 'acceptedExportPlanHash'],
        });
      }
    }
  });

export const exportPlannedFileV1Schema = z
  .object({
    artifactId: z.string().trim().min(1),
    estimatedBytes: z.number().int().positive().optional(),
    fileName: z.string().trim().min(1),
    format: exportImageFormatV1Schema,
  })
  .strict();

export const exportDryRunResultV1Schema = z
  .object({
    commandId: z.string().trim().min(1),
    commandType: z.literal('export.planFiles'),
    correlationId: z.string().trim().min(1),
    exportPlanHash: z.string().trim().min(1),
    exportPlanId: z.string().trim().min(1),
    plannedFiles: z.array(exportPlannedFileV1Schema).min(1),
    previewArtifacts: z.array(artifactHandleV1Schema),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sourceGraphRevision: z.string().trim().min(1),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict();

export const exportApplyResultV1Schema = z
  .object({
    commandId: z.string().trim().min(1),
    commandType: z.literal('export.writeFiles'),
    correlationId: z.string().trim().min(1),
    exportPlanHash: z.string().trim().min(1),
    exportPlanId: z.string().trim().min(1),
    outputArtifacts: z.array(artifactHandleV1Schema).min(1),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    writtenFiles: z.array(z.string().trim().min(1)).min(1),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict();

const projectLibraryPathSchema = z.string().trim().min(1);

export type ProjectLibraryFolderNodeV1 = {
  children: ProjectLibraryFolderNodeV1[];
  hasSubdirs: boolean;
  imageCount: number;
  isDir: true;
  name: string;
  path: string;
};

export const projectLibraryFolderNodeV1Schema: z.ZodType<ProjectLibraryFolderNodeV1> = z.lazy(() =>
  z
    .object({
      children: z.array(projectLibraryFolderNodeV1Schema),
      hasSubdirs: z.boolean(),
      imageCount: z.number().int().nonnegative(),
      isDir: z.literal(true),
      name: z.string().trim().min(1),
      path: projectLibraryPathSchema,
    })
    .strict(),
);

export type ProjectLibraryAlbumNodeV1 =
  | {
      icon?: string | undefined;
      id: string;
      images: string[];
      name: string;
      type: 'album';
    }
  | {
      children: ProjectLibraryAlbumNodeV1[];
      icon?: string | undefined;
      id: string;
      name: string;
      type: 'group';
    };

export const projectLibraryAlbumNodeV1Schema: z.ZodType<ProjectLibraryAlbumNodeV1> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z
      .object({
        icon: z.string().trim().min(1).optional(),
        id: z.string().trim().min(1),
        images: z.array(projectLibraryPathSchema),
        name: z.string().trim().min(1),
        type: z.literal('album'),
      })
      .strict(),
    z
      .object({
        children: z.array(projectLibraryAlbumNodeV1Schema),
        icon: z.string().trim().min(1).optional(),
        id: z.string().trim().min(1),
        name: z.string().trim().min(1),
        type: z.literal('group'),
      })
      .strict(),
  ]),
);

export const projectLibraryImageRefV1Schema = z
  .object({
    exif: z.record(z.string(), z.string()).nullable(),
    isEdited: z.boolean(),
    isVirtualCopy: z.boolean(),
    modified: z.number().nonnegative(),
    path: projectLibraryPathSchema,
    rating: z.number().int().min(0).max(5),
    tags: z.array(z.string().trim().min(1)).nullable(),
  })
  .strict();

export const projectLibraryFilterCriteriaV1Schema = z
  .object({
    colors: z.array(z.string().trim().min(1)),
    editedStatus: z.enum(['all', 'editedOnly', 'uneditedOnly']).optional(),
    rating: z.number().int().min(0).max(5),
    rawStatus: z.enum(['all', 'nonRawOnly', 'rawOnly', 'rawOverNonRaw']),
  })
  .strict();

export const projectLibrarySortCriteriaV1Schema = z
  .object({
    key: z.string().trim().min(1),
    label: z.string().trim().min(1).optional(),
    order: z.enum(['asc', 'desc']),
  })
  .strict();

export const projectLibrarySnapshotQueryV1Schema = queryEnvelopeV1Schema
  .extend({
    parameters: z
      .object({
        currentFolderPath: projectLibraryPathSchema.nullable().optional(),
        expandedFolders: z.array(projectLibraryPathSchema),
        includeAlbums: z.boolean(),
        includeImageList: z.boolean(),
        includePinnedFolders: z.boolean(),
        rootPaths: z.array(projectLibraryPathSchema),
        showImageCounts: z.boolean(),
      })
      .strict(),
    queryType: z.literal('project.library.snapshot'),
    target: rawEngineTargetSchema.safeExtend({ kind: z.literal('project') }).strict(),
  })
  .strict();

export const projectLibrarySnapshotV1Schema = z
  .object({
    activeAlbumId: z.string().trim().min(1).nullable(),
    albums: z.array(projectLibraryAlbumNodeV1Schema),
    currentFolderPath: projectLibraryPathSchema.nullable(),
    filterCriteria: projectLibraryFilterCriteriaV1Schema,
    folders: z.array(projectLibraryFolderNodeV1Schema),
    imageList: z.array(projectLibraryImageRefV1Schema),
    libraryActivePath: projectLibraryPathSchema.nullable(),
    multiSelectedPaths: z.array(projectLibraryPathSchema),
    pinnedFolders: z.array(projectLibraryFolderNodeV1Schema),
    rootPaths: z.array(projectLibraryPathSchema),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sortCriteria: projectLibrarySortCriteriaV1Schema,
  })
  .strict();

export const projectLibraryCommandTypeV1Schema = z.enum([
  'project.library.createAlbum',
  'project.library.createGroup',
  'project.library.renameAlbumItem',
  'project.library.addImagesToAlbum',
  'project.library.removeImagesFromAlbum',
]);

const projectLibraryCommandBaseV1Schema = z.object({
  actor: rawEngineActorSchema,
  approval: approvalRequirementSchema,
  commandId: z.string().trim().min(1),
  correlationId: z.string().trim().min(1),
  dryRun: z.boolean(),
  expectedLibraryRevision: z.string().trim().min(1).optional(),
  idempotencyKey: z.string().trim().min(1).optional(),
  schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
  target: rawEngineTargetSchema.safeExtend({ kind: z.literal('project') }).strict(),
});

export const projectLibraryCommandEnvelopeV1Schema = z
  .discriminatedUnion('commandType', [
    projectLibraryCommandBaseV1Schema
      .extend({
        commandType: z.literal('project.library.createAlbum'),
        parameters: z
          .object({
            icon: z.string().trim().min(1).optional(),
            name: z.string().trim().min(1),
            parentGroupId: z.string().trim().min(1).nullable(),
          })
          .strict(),
      })
      .strict(),
    projectLibraryCommandBaseV1Schema
      .extend({
        commandType: z.literal('project.library.createGroup'),
        parameters: z
          .object({
            icon: z.string().trim().min(1).optional(),
            name: z.string().trim().min(1),
            parentGroupId: z.string().trim().min(1).nullable(),
          })
          .strict(),
      })
      .strict(),
    projectLibraryCommandBaseV1Schema
      .extend({
        commandType: z.literal('project.library.renameAlbumItem'),
        parameters: z
          .object({
            itemId: z.string().trim().min(1),
            name: z.string().trim().min(1),
          })
          .strict(),
      })
      .strict(),
    projectLibraryCommandBaseV1Schema
      .extend({
        commandType: z.literal('project.library.addImagesToAlbum'),
        parameters: z
          .object({
            albumId: z.string().trim().min(1),
            imagePaths: z.array(projectLibraryPathSchema).min(1),
          })
          .strict(),
      })
      .strict(),
    projectLibraryCommandBaseV1Schema
      .extend({
        commandType: z.literal('project.library.removeImagesFromAlbum'),
        parameters: z
          .object({
            albumId: z.string().trim().min(1),
            imagePaths: z.array(projectLibraryPathSchema).min(1),
          })
          .strict(),
      })
      .strict(),
  ])
  .superRefine((command, context) => {
    if (!command.dryRun && command.approval.state !== 'approved') {
      context.addIssue({
        code: 'custom',
        message: 'Mutating project library commands require approved file-mutation approval before execution.',
        path: ['approval', 'state'],
      });
    }

    if (command.approval.approvalClass !== ApprovalClass.FileMutation) {
      context.addIssue({
        code: 'custom',
        message: 'Project library commands require file-mutation approval classification.',
        path: ['approval', 'approvalClass'],
      });
    }
  });

export const projectLibraryMutationResultV1Schema = z
  .object({
    albumTree: z.array(projectLibraryAlbumNodeV1Schema),
    commandId: z.string().trim().min(1),
    commandType: projectLibraryCommandTypeV1Schema,
    correlationId: z.string().trim().min(1),
    dryRun: z.boolean(),
    mutates: z.boolean(),
    resultingLibraryRevision: z.string().trim().min(1).optional(),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.dryRun && result.mutates) {
      context.addIssue({
        code: 'custom',
        message: 'Dry-run project library results must not mutate library state.',
        path: ['mutates'],
      });
    }

    if (!result.dryRun && result.resultingLibraryRevision === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Applied project library mutations require a resulting library revision.',
        path: ['resultingLibraryRevision'],
      });
    }
  });

export const editGraphNodeKindV1Schema = z.enum([
  'legacy_adjustments',
  'preset_fragment',
  'layer_adjustment',
  'mask_operation',
  'negative_lab_operation',
  'agent_command',
]);

export const editGraphCommandTypeV1Schema = z.enum([
  'editGraph.applyParameterPatch',
  'editGraph.applyPresetFragment',
  'editGraph.undo',
  'editGraph.redo',
  'editGraph.revertToRevision',
]);

export const editGraphParameterPatchOperationV1Schema = z
  .object({
    nodeId: z.string().trim().min(1).nullable(),
    op: z.enum(['add', 'replace', 'remove']),
    path: z.string().trim().min(1),
    previousValue: z.unknown().optional(),
    value: z.unknown().optional(),
  })
  .strict()
  .superRefine((operation, context) => {
    if (operation.op !== 'remove' && operation.value === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Add and replace parameter patch operations require a value.',
        path: ['value'],
      });
    }
  });

export const editGraphNodeV1Schema = z
  .object({
    createdAt: z.iso.datetime({ offset: true }),
    createdBy: rawEngineActorSchema,
    enabled: z.boolean(),
    id: z.string().trim().min(1),
    inputRevision: z.string().trim().min(1).nullable(),
    kind: editGraphNodeKindV1Schema,
    label: z.string().trim().min(1),
    outputRevision: z.string().trim().min(1),
    parameters: z.record(z.string(), z.unknown()),
    sourceCommandId: z.string().trim().min(1).optional(),
  })
  .strict();

export const editGraphHistoryEntryV1Schema = z
  .object({
    actor: rawEngineActorSchema,
    commandId: z.string().trim().min(1),
    commandType: editGraphCommandTypeV1Schema,
    createdAt: z.iso.datetime({ offset: true }),
    graphRevision: z.string().trim().min(1),
    label: z.string().trim().min(1),
  })
  .strict();

export const editGraphSnapshotQueryV1Schema = queryEnvelopeV1Schema
  .extend({
    parameters: z
      .object({
        includeDisabledNodes: z.boolean(),
        includeHistory: z.boolean(),
        maxHistoryEntries: z.number().int().positive().max(500),
      })
      .strict(),
    queryType: z.literal('editGraph.snapshot'),
    target: rawEngineTargetSchema.safeExtend({ kind: z.enum(['image', 'virtual_copy']) }).strict(),
  })
  .strict();

export const editGraphSnapshotV1Schema = z
  .object({
    activeHistoryIndex: z.number().int().min(-1),
    graphId: z.string().trim().min(1),
    graphRevision: z.string().trim().min(1),
    history: z.array(editGraphHistoryEntryV1Schema),
    imagePath: z.string().trim().min(1),
    nodes: z.array(editGraphNodeV1Schema),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    virtualCopyId: z.string().trim().min(1).nullable(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.activeHistoryIndex >= snapshot.history.length) {
      context.addIssue({
        code: 'custom',
        message: 'Active history index must point at an existing history entry or be -1.',
        path: ['activeHistoryIndex'],
      });
    }
  });

const editGraphCommandBaseV1Schema = z.object({
  actor: rawEngineActorSchema,
  approval: approvalRequirementSchema,
  commandId: z.string().trim().min(1),
  correlationId: z.string().trim().min(1),
  dryRun: z.boolean(),
  expectedGraphRevision: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1).optional(),
  schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
  target: rawEngineTargetSchema.safeExtend({ kind: z.enum(['image', 'virtual_copy']) }).strict(),
});

export const editGraphCommandEnvelopeV1Schema = z
  .discriminatedUnion('commandType', [
    editGraphCommandBaseV1Schema
      .extend({
        commandType: z.literal('editGraph.applyParameterPatch'),
        parameters: z
          .object({
            label: z.string().trim().min(1),
            operations: z.array(editGraphParameterPatchOperationV1Schema).min(1),
          })
          .strict(),
      })
      .strict(),
    editGraphCommandBaseV1Schema
      .extend({
        commandType: z.literal('editGraph.applyPresetFragment'),
        parameters: z
          .object({
            fragmentId: z.string().trim().min(1).optional(),
            layerId: z.string().trim().min(1).nullable(),
            parameterOverrides: z.record(z.string(), z.unknown()),
            presetId: z.string().trim().min(1),
            strength: z.number().min(0).max(1),
          })
          .strict(),
      })
      .strict(),
    editGraphCommandBaseV1Schema
      .extend({
        commandType: z.literal('editGraph.undo'),
        parameters: z
          .object({
            steps: z.number().int().positive().max(100),
          })
          .strict(),
      })
      .strict(),
    editGraphCommandBaseV1Schema
      .extend({
        commandType: z.literal('editGraph.redo'),
        parameters: z
          .object({
            steps: z.number().int().positive().max(100),
          })
          .strict(),
      })
      .strict(),
    editGraphCommandBaseV1Schema
      .extend({
        commandType: z.literal('editGraph.revertToRevision'),
        parameters: z
          .object({
            graphRevision: z.string().trim().min(1),
          })
          .strict(),
      })
      .strict(),
  ])
  .superRefine((command, context) => {
    if (command.dryRun) {
      if (command.approval.approvalClass !== ApprovalClass.PreviewOnly) {
        context.addIssue({
          code: 'custom',
          message: 'Dry-run edit graph commands require preview-only approval classification.',
          path: ['approval', 'approvalClass'],
        });
      }

      return;
    }

    if (command.approval.approvalClass !== ApprovalClass.EditApply) {
      context.addIssue({
        code: 'custom',
        message: 'Applied edit graph commands require edit-apply approval classification.',
        path: ['approval', 'approvalClass'],
      });
    }

    if (command.approval.state !== 'approved') {
      context.addIssue({
        code: 'custom',
        message: 'Applied edit graph commands require approved user approval before execution.',
        path: ['approval', 'state'],
      });
    }
  });

export const editGraphParameterDiffV1Schema = z
  .object({
    nodeId: z.string().trim().min(1).nullable(),
    path: z.string().trim().min(1),
    previousValue: z.unknown().optional(),
    value: z.unknown().optional(),
  })
  .strict();

export const editGraphDryRunResultV1Schema = z
  .object({
    commandId: z.string().trim().min(1),
    commandType: editGraphCommandTypeV1Schema,
    correlationId: z.string().trim().min(1),
    dryRun: z.literal(true),
    mutates: z.literal(false),
    parameterDiff: z.array(editGraphParameterDiffV1Schema),
    predictedGraphRevision: z.string().trim().min(1),
    previewArtifacts: z.array(artifactHandleV1Schema),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sourceGraphRevision: z.string().trim().min(1),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict();

export const editGraphMutationResultV1Schema = z
  .object({
    appliedGraphRevision: z.string().trim().min(1),
    changedNodeIds: z.array(z.string().trim().min(1)),
    commandId: z.string().trim().min(1),
    commandType: editGraphCommandTypeV1Schema,
    correlationId: z.string().trim().min(1),
    dryRun: z.literal(false),
    mutates: z.literal(true),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sourceGraphRevision: z.string().trim().min(1),
    undoRevision: z.string().trim().min(1),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict();

export const detailDeblurPsfV1Schema = z.enum(['gaussian']);

export const detailDeblurControlsV1Schema = z
  .object({
    enabled: z.boolean(),
    psf: detailDeblurPsfV1Schema,
    sigmaPx: z.number().min(0.45).max(1.35),
    strength: z.number().min(0).max(1),
  })
  .strict();

export const detailDeblurUiControlsV1Schema = z
  .object({
    deblurEnabled: z.boolean(),
    deblurSigmaPx: z.number().min(0.45).max(1.35),
    deblurStrength: z.number().int().min(0).max(100),
  })
  .strict();

export const toDetailDeblurControlsV1 = (
  controls: z.infer<typeof detailDeblurUiControlsV1Schema>,
): z.infer<typeof detailDeblurControlsV1Schema> => ({
  enabled: controls.deblurEnabled,
  psf: 'gaussian',
  sigmaPx: controls.deblurSigmaPx,
  strength: controls.deblurEnabled ? controls.deblurStrength / 100 : 0,
});

export const detailDeblurSkipReasonV1Schema = z.enum([
  'disabled',
  'unsupported_psf',
  'sigma_out_of_range',
  'noise_too_high',
  'saturated_edge_risk',
  'invalid_dimensions',
  'memory_budget_exceeded',
  'non_finite_input',
  'preview_not_wired',
  'export_not_wired',
  'cpu_reference_unavailable',
]);

export const detailDeblurRuntimeStatusV1Schema = z.enum([
  'contract_only',
  'ui_api_wired',
  'cpu_reference_only',
  'preview_export_not_wired',
  'applied_preview',
  'applied_export',
  'preview_export_parity',
  'skipped',
  'blocked',
]);

export const detailDeblurApplyStatusV1Schema = z.enum([
  'not_requested',
  'not_executed',
  'applied',
  'skipped',
  'blocked',
]);

export const detailDeblurLimitationV1Schema = z.enum([
  'preview_export_parity',
  'real_raw_quality',
  'gpu_parity',
  'e2e_workflow',
  'runtime_image_change',
]);

export const detailDeblurRuntimeStateV1Schema = z
  .object({
    applyStatus: detailDeblurApplyStatusV1Schema,
    doesNotProve: z.array(detailDeblurLimitationV1Schema),
    effectiveControls: detailDeblurControlsV1Schema,
    orderedAfter: z.literal('scene_linear_denoise'),
    orderedBefore: z.literal('capture_sharpen'),
    runtimeStatus: detailDeblurRuntimeStatusV1Schema,
    skipReason: detailDeblurSkipReasonV1Schema.optional(),
    stage: z.literal('scene_linear_post_denoise'),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict()
  .superRefine((state, context) => {
    if ((state.applyStatus === 'skipped' || state.applyStatus === 'blocked') && state.skipReason === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Skipped or blocked deblur results require a skipReason.',
        path: ['skipReason'],
      });
    }

    if (state.runtimeStatus === 'ui_api_wired' && !state.doesNotProve.includes('preview_export_parity')) {
      context.addIssue({
        code: 'custom',
        message: 'UI/API-only deblur status must not imply preview/export parity.',
        path: ['doesNotProve'],
      });
    }
  });

export const detailDeblurCommandTypeV1Schema = z.enum(['detailDeblur.dryRunControls', 'detailDeblur.applyControls']);

const detailImageCommandBaseV1Schema = z.object({
  actor: rawEngineActorSchema,
  approval: approvalRequirementSchema,
  commandId: z.string().trim().min(1),
  correlationId: z.string().trim().min(1),
  dryRun: z.boolean(),
  expectedGraphRevision: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1).optional(),
  schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
  target: rawEngineTargetSchema.safeExtend({ kind: z.enum(['image', 'virtual_copy']) }).strict(),
});

const refinePreviewApplyApproval = (
  command: { approval: z.infer<typeof approvalRequirementSchema>; dryRun: boolean },
  context: z.RefinementCtx,
  featureLabel: string,
) => {
  if (command.dryRun) {
    if (command.approval.approvalClass !== ApprovalClass.PreviewOnly) {
      context.addIssue({
        code: 'custom',
        message: `Dry-run ${featureLabel} commands require preview-only approval classification.`,
        path: ['approval', 'approvalClass'],
      });
    }

    return;
  }

  if (command.approval.approvalClass !== ApprovalClass.EditApply) {
    context.addIssue({
      code: 'custom',
      message: `Applied ${featureLabel} commands require edit-apply approval classification.`,
      path: ['approval', 'approvalClass'],
    });
  }

  if (command.approval.state !== 'approved') {
    context.addIssue({
      code: 'custom',
      message: `Applied ${featureLabel} commands require approved user approval before execution.`,
      path: ['approval', 'state'],
    });
  }
};

export const detailDeblurCommandEnvelopeV1Schema = z
  .discriminatedUnion('commandType', [
    detailImageCommandBaseV1Schema
      .extend({
        commandType: z.literal('detailDeblur.dryRunControls'),
        dryRun: z.literal(true),
        parameters: detailDeblurControlsV1Schema,
      })
      .strict(),
    detailImageCommandBaseV1Schema
      .extend({
        commandType: z.literal('detailDeblur.applyControls'),
        dryRun: z.literal(false),
        parameters: detailDeblurControlsV1Schema,
      })
      .strict(),
  ])
  .superRefine((command, context) => {
    refinePreviewApplyApproval(command, context, 'deblur');
  });

export const detailDeblurDryRunResultV1Schema = z
  .object({
    commandId: z.string().trim().min(1),
    commandType: z.literal('detailDeblur.dryRunControls'),
    correlationId: z.string().trim().min(1),
    dryRun: z.literal(true),
    mutates: z.literal(false),
    parameterDiff: z.array(editGraphParameterDiffV1Schema),
    predictedGraphRevision: z.string().trim().min(1),
    previewArtifacts: z.array(artifactHandleV1Schema).length(0),
    runtime: detailDeblurRuntimeStateV1Schema,
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sourceGraphRevision: z.string().trim().min(1),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict();

export const detailDenoiseControlsV1Schema = z
  .object({
    chromaStrength: z.number().min(0).max(1),
    lumaStrength: z.number().min(0).max(1),
  })
  .strict();

export const detailDenoiseUiControlsV1Schema = z
  .object({
    colorNoiseReduction: z.number().int().min(0).max(100),
    lumaNoiseReduction: z.number().int().min(0).max(100),
  })
  .strict();

export const toDetailDenoiseControlsV1 = (
  controls: z.infer<typeof detailDenoiseUiControlsV1Schema>,
): z.infer<typeof detailDenoiseControlsV1Schema> => ({
  chromaStrength: controls.colorNoiseReduction / 100,
  lumaStrength: controls.lumaNoiseReduction / 100,
});

export const detailDenoiseSkipReasonV1Schema = z.enum([
  'disabled',
  'preview_export_not_proven',
  'preview_not_wired',
  'runtime_not_available',
]);

export const detailDenoiseRuntimeStatusV1Schema = z.enum([
  'schema_only',
  'ui_api_wired',
  'runtime_apply_capable',
  'preview_export_parity',
  'e2e_proven',
]);

export const detailDenoiseApplyStatusV1Schema = z.enum(['not_requested', 'not_executed', 'applied', 'blocked']);

export const detailDenoiseLimitationV1Schema = z.enum([
  'e2e_workflow',
  'gpu_parity',
  'preview_export_parity',
  'real_raw_quality',
]);

export const detailDenoiseRuntimeStateV1Schema = z
  .object({
    applyStatus: detailDenoiseApplyStatusV1Schema,
    doesNotProve: z.array(detailDenoiseLimitationV1Schema),
    effectiveControls: detailDenoiseControlsV1Schema,
    mutates: z.boolean(),
    orderedAfter: z.literal('demosaic'),
    orderedBefore: z.literal('scene_linear_deblur'),
    runtimeStatus: detailDenoiseRuntimeStatusV1Schema,
    skipReason: detailDenoiseSkipReasonV1Schema.optional(),
    stage: z.literal('scene_linear_denoise'),
  })
  .strict()
  .superRefine((runtime, context) => {
    if (runtime.applyStatus !== 'applied' && runtime.skipReason === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Skipped or blocked denoise results require a skipReason.',
        path: ['skipReason'],
      });
    }

    if (runtime.runtimeStatus === 'ui_api_wired' && !runtime.doesNotProve.includes('preview_export_parity')) {
      context.addIssue({
        code: 'custom',
        message: 'UI/API-only denoise status must not imply preview/export parity.',
        path: ['doesNotProve'],
      });
    }
  });

export const detailDenoiseCommandTypeV1Schema = z.enum(['detailDenoise.dryRunControls', 'detailDenoise.applyControls']);

export const detailDenoiseCommandEnvelopeV1Schema = z
  .discriminatedUnion('commandType', [
    detailImageCommandBaseV1Schema
      .extend({
        commandType: z.literal('detailDenoise.dryRunControls'),
        dryRun: z.literal(true),
        parameters: detailDenoiseControlsV1Schema,
      })
      .strict(),
    detailImageCommandBaseV1Schema
      .extend({
        commandType: z.literal('detailDenoise.applyControls'),
        dryRun: z.literal(false),
        parameters: detailDenoiseControlsV1Schema,
      })
      .strict(),
  ])
  .superRefine((command, context) => {
    refinePreviewApplyApproval(command, context, 'denoise');
  });

export const detailDenoiseDryRunResultV1Schema = z
  .object({
    commandId: z.string().trim().min(1),
    commandType: z.literal('detailDenoise.dryRunControls'),
    correlationId: z.string().trim().min(1),
    dryRun: z.literal(true),
    mutates: z.literal(false),
    runtime: detailDenoiseRuntimeStateV1Schema,
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict();

export const detailEffectsPatchV1Schema = z
  .object({
    chromaticAberrationBlueYellow: z.number().min(-100).max(100).optional(),
    chromaticAberrationRedCyan: z.number().min(-100).max(100).optional(),
    clarity: z.number().min(-100).max(100).optional(),
    colorNoiseReduction: z.number().min(0).max(100).optional(),
    deblurEnabled: z.boolean().optional(),
    deblurSigmaPx: z.number().min(0.45).max(1.35).optional(),
    deblurStrength: z.number().min(0).max(100).optional(),
    dehaze: z.number().min(-100).max(100).optional(),
    dustSpotMinRadiusPx: z.number().int().min(1).max(12).optional(),
    dustSpotOverlayEnabled: z.boolean().optional(),
    dustSpotSensitivity: z.number().int().min(0).max(100).optional(),
    flareAmount: z.number().min(0).max(100).optional(),
    glowAmount: z.number().min(0).max(100).optional(),
    grainAmount: z.number().min(0).max(100).optional(),
    grainRoughness: z.number().min(0).max(100).optional(),
    grainSize: z.number().min(0).max(100).optional(),
    halationAmount: z.number().min(0).max(100).optional(),
    localContrastHaloGuard: z.number().min(0).max(100).optional(),
    localContrastMidtoneMask: z.number().min(0).max(100).optional(),
    localContrastRadiusPx: z.number().min(4).max(96).optional(),
    lumaNoiseReduction: z.number().min(0).max(100).optional(),
    sharpness: z.number().min(-100).max(100).optional(),
    sharpnessThreshold: z.number().min(0).max(80).optional(),
    structure: z.number().min(-100).max(100).optional(),
    vignetteAmount: z.number().min(-100).max(100).optional(),
    vignetteFeather: z.number().min(0).max(100).optional(),
    vignetteMidpoint: z.number().min(0).max(100).optional(),
    vignetteRoundness: z.number().min(-100).max(100).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'At least one detail/effects adjustment is required.',
  });

const detailEffectsApplyPatchV1Schema = detailEffectsPatchV1Schema.extend({
  acceptedDryRunPlanHash: z.string().trim().min(1),
  acceptedDryRunPlanId: z.string().trim().min(1),
});

export const detailEffectsCommandTypeV1Schema = z.enum([
  'detailEffects.dryRunAdjustments',
  'detailEffects.applyAdjustments',
]);

export const detailEffectsCommandEnvelopeV1Schema = z
  .discriminatedUnion('commandType', [
    detailImageCommandBaseV1Schema
      .extend({
        commandType: z.literal('detailEffects.dryRunAdjustments'),
        dryRun: z.literal(true),
        parameters: detailEffectsPatchV1Schema,
      })
      .strict(),
    detailImageCommandBaseV1Schema
      .extend({
        commandType: z.literal('detailEffects.applyAdjustments'),
        dryRun: z.literal(false),
        parameters: detailEffectsApplyPatchV1Schema,
      })
      .strict(),
  ])
  .superRefine((command, context) => {
    refinePreviewApplyApproval(command, context, 'detail/effects');
  });

export const detailEffectsDryRunResultV1Schema = z
  .object({
    commandId: z.string().trim().min(1),
    commandType: z.literal('detailEffects.dryRunAdjustments'),
    correlationId: z.string().trim().min(1),
    dryRun: z.literal(true),
    dryRunPlanHash: z.string().trim().min(1),
    dryRunPlanId: z.string().trim().min(1),
    mutates: z.literal(false),
    parameterDiff: z.array(editGraphParameterDiffV1Schema).min(1),
    predictedGraphRevision: z.string().trim().min(1),
    previewArtifacts: z.array(artifactHandleV1Schema).length(0),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sourceGraphRevision: z.string().trim().min(1),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict();

export const detailEffectsMutationResultV1Schema = z
  .object({
    appliedGraphRevision: z.string().trim().min(1),
    changedNodeIds: z.array(z.string().trim().min(1)).min(1),
    commandId: z.string().trim().min(1),
    commandType: z.literal('detailEffects.applyAdjustments'),
    correlationId: z.string().trim().min(1),
    dryRun: z.literal(false),
    dryRunPlanHash: z.string().trim().min(1),
    dryRunPlanId: z.string().trim().min(1),
    mutates: z.literal(true),
    provenanceEntryIds: z.array(z.string().trim().min(1)).min(1),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sourceGraphRevision: z.string().trim().min(1),
    undoRevision: z.string().trim().min(1),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict();

export const lensProfileDistortionParamsV1Schema = z
  .object({
    k1: z.number().min(-10).max(10),
    k2: z.number().min(-10).max(10),
    k3: z.number().min(-10).max(10),
    model: z.number().int().min(0).max(10),
    tca_vb: z.number().min(-10).max(10),
    tca_vr: z.number().min(-10).max(10),
    vig_k1: z.number().min(-10).max(10),
    vig_k2: z.number().min(-10).max(10),
    vig_k3: z.number().min(-10).max(10),
  })
  .strict();

export const lensProfilePatchV1Schema = z
  .object({
    lensCorrectionMode: z.enum(['auto', 'manual']).optional(),
    lensDistortionAmount: z.number().int().min(0).max(200).optional(),
    lensDistortionEnabled: z.boolean().optional(),
    lensDistortionParams: lensProfileDistortionParamsV1Schema.nullable().optional(),
    lensMaker: z.string().trim().min(1).max(160).nullable().optional(),
    lensModel: z.string().trim().min(1).max(240).nullable().optional(),
    lensTcaAmount: z.number().int().min(0).max(200).optional(),
    lensTcaEnabled: z.boolean().optional(),
    lensVignetteAmount: z.number().int().min(0).max(200).optional(),
    lensVignetteEnabled: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'At least one lens/profile adjustment is required.',
  })
  .refine((patch) => patch.lensModel === undefined || patch.lensMaker !== null, {
    message: 'Lens model cannot be set while lens maker is explicitly cleared.',
  });

const lensProfileApplyPatchV1Schema = lensProfilePatchV1Schema.extend({
  acceptedDryRunPlanHash: z.string().trim().min(1),
  acceptedDryRunPlanId: z.string().trim().min(1),
});

export const lensProfileCommandTypeV1Schema = z.enum(['lensProfile.dryRunCorrection', 'lensProfile.applyCorrection']);

export const lensProfileCommandEnvelopeV1Schema = z
  .discriminatedUnion('commandType', [
    detailImageCommandBaseV1Schema
      .extend({
        commandType: z.literal('lensProfile.dryRunCorrection'),
        dryRun: z.literal(true),
        parameters: lensProfilePatchV1Schema,
      })
      .strict(),
    detailImageCommandBaseV1Schema
      .extend({
        commandType: z.literal('lensProfile.applyCorrection'),
        dryRun: z.literal(false),
        parameters: lensProfileApplyPatchV1Schema,
      })
      .strict(),
  ])
  .superRefine((command, context) => {
    refinePreviewApplyApproval(command, context, 'lens/profile');
  });

export const lensProfileDryRunResultV1Schema = z
  .object({
    commandId: z.string().trim().min(1),
    commandType: z.literal('lensProfile.dryRunCorrection'),
    correlationId: z.string().trim().min(1),
    dryRun: z.literal(true),
    dryRunPlanHash: z.string().trim().min(1),
    dryRunPlanId: z.string().trim().min(1),
    mutates: z.literal(false),
    parameterDiff: z.array(editGraphParameterDiffV1Schema).min(1),
    predictedGraphRevision: z.string().trim().min(1),
    previewArtifacts: z.array(artifactHandleV1Schema).length(0),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sourceGraphRevision: z.string().trim().min(1),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict();

export const lensProfileMutationResultV1Schema = z
  .object({
    appliedGraphRevision: z.string().trim().min(1),
    changedNodeIds: z.array(z.string().trim().min(1)).min(1),
    commandId: z.string().trim().min(1),
    commandType: z.literal('lensProfile.applyCorrection'),
    correlationId: z.string().trim().min(1),
    dryRun: z.literal(false),
    dryRunPlanHash: z.string().trim().min(1),
    dryRunPlanId: z.string().trim().min(1),
    mutates: z.literal(true),
    provenanceEntryIds: z.array(z.string().trim().min(1)).min(1),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sourceGraphRevision: z.string().trim().min(1),
    undoRevision: z.string().trim().min(1),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict();

export const {
  toneColorBalanceRgbRangeV1Schema,
  toneColorBlackWhiteMixerWeightsV1Schema,
  toneColorChannelMixerRowV1Schema,
  toneColorChannelV1Schema,
  toneColorCommandEnvelopeV1Schema,
  toneColorCommandTypeV1Schema,
  toneColorCurvePointV1Schema,
  toneColorDryRunResultV1Schema,
  toneColorHslBandV1Schema,
  toneColorMutationResultV1Schema,
  toneColorParameterDiffV1Schema,
  toneColorWheelV1Schema,
} = createToneColorSchemasV1({
  approvalClass: ApprovalClass,
  approvalRequirementSchema,
  rawEngineActorSchema,
  rawEngineColorPipelineContextV1Schema,
  schemaVersion: RAW_ENGINE_SCHEMA_VERSION,
  toneColorTargetSchema: rawEngineTargetSchema.safeExtend({ kind: z.enum(['image', 'virtual_copy']) }).strict(),
});

export const layerMaskCommandTypeV1Schema = z.enum([
  'layerMask.createLayer',
  'layerMask.setLayerOpacity',
  'layerMask.setLayerVisibility',
  'layerMask.renameLayer',
  'layerMask.duplicateLayer',
  'layerMask.deleteLayer',
  'layerMask.moveLayer',
  'layerMask.updateRetouchSource',
  'layerMask.updateRetouchRemoveSource',
  'layerMask.attachMask',
  'layerMask.applyLayerAdjustment',
  'layerMask.createBrushMask',
  'layerMask.createGradientMask',
  'layerMask.createRangeMask',
  'layerMask.combineMasks',
  'layerMask.refineMask',
]);

export const layerMaskBlendModeV1Schema = z.enum([
  'normal',
  'multiply',
  'screen',
  'overlay',
  'soft_light',
  'hue',
  'saturation',
  'luminosity',
  'color',
]);

export const layerMaskPointV1Schema = z
  .object({
    pressure: z.number().min(0).max(1).optional(),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  })
  .strict();

export const layerMaskBrushStrokeV1Schema = z
  .object({
    flow: z.number().min(0).max(1),
    hardness: z.number().min(0).max(1),
    mode: z.enum(['paint', 'erase']),
    points: z.array(layerMaskPointV1Schema).min(2).max(4096),
    radiusPx: z.number().positive().max(2000),
    strokeId: z.string().trim().min(1),
  })
  .strict();

export const layerMaskGradientV1Schema = z.discriminatedUnion('gradientKind', [
  z
    .object({
      end: layerMaskPointV1Schema,
      feather: z.number().min(0).max(1),
      gradientKind: z.literal('linear'),
      invert: z.boolean(),
      start: layerMaskPointV1Schema,
    })
    .strict(),
  z
    .object({
      center: layerMaskPointV1Schema,
      feather: z.number().min(0).max(1),
      gradientKind: z.literal('radial'),
      invert: z.boolean(),
      radiusX: z.number().positive().max(1),
      radiusY: z.number().positive().max(1),
    })
    .strict(),
]);

export const layerMaskRangeSelectionV1Schema = z.discriminatedUnion('rangeKind', [
  z
    .object({
      feather: z.number().min(0).max(1),
      maxLuma: z.number().min(0).max(1),
      minLuma: z.number().min(0).max(1),
      rangeKind: z.literal('luminance'),
    })
    .strict()
    .superRefine((range, context) => {
      if (range.minLuma >= range.maxLuma) {
        context.addIssue({
          code: 'custom',
          message: 'Luminance range masks require minLuma below maxLuma.',
          path: ['minLuma'],
        });
      }
    }),
  z
    .object({
      centerHueDegrees: z.number().min(0).lt(360),
      feather: z.number().min(0).max(1),
      hueToleranceDegrees: z.number().positive().max(180),
      maxLuma: z.number().min(0).max(1),
      maxSaturation: z.number().min(0).max(1),
      minLuma: z.number().min(0).max(1),
      minSaturation: z.number().min(0).max(1),
      rangeKind: z.literal('color'),
    })
    .strict()
    .superRefine((range, context) => {
      if (range.minSaturation >= range.maxSaturation) {
        context.addIssue({
          code: 'custom',
          message: 'Color range masks require minSaturation below maxSaturation.',
          path: ['minSaturation'],
        });
      }

      if (range.minLuma >= range.maxLuma) {
        context.addIssue({
          code: 'custom',
          message: 'Color range masks require minLuma below maxLuma.',
          path: ['minLuma'],
        });
      }
    }),
]);

export const layerMaskRefinementParametersV1Schema = z
  .object({
    density: z.number().min(0).max(1),
    edgeContrast: z.number().min(0).max(1),
    edgeShiftPx: z.number().min(-512).max(512),
    featherPx: z.number().min(0).max(4096),
    smoothness: z.number().min(0).max(1),
  })
  .strict();

const retouchLayerRuntimeProvenanceV1Schema = z
  .object({
    algorithmId: z.enum(['local_clone_v1', 'local_heal_v1', 'local_patch_fill_v1']),
    changedPixelCount: z.number().int().nonnegative(),
    editableLayer: z.literal(true),
    featherRadiusPx: z.number().min(0).max(4096).optional(),
    maskAlphaHash: z.string().regex(/^fnv1a32:[0-9a-f]{8}$/u),
    mode: z.enum(['clone', 'heal', 'remove']),
    outputHash: z.string().regex(/^fnv1a32:[0-9a-f]{8}$/u),
    outputSampleHash: z
      .string()
      .regex(/^fnv1a32:[0-9a-f]{8}$/u)
      .optional(),
    proofSource: z.enum(['mask_aware_retouch_runtime_fixture_v1', 'negative_lab_candidate_acceptance_v1']),
    provenanceVersion: z.literal(1),
    radiusPx: z.number().positive().max(4096).optional(),
    resolvedSourcePoint: layerMaskPointV1Schema.optional(),
    sourcePoint: layerMaskPointV1Schema.optional(),
    sourceSampleHash: z
      .string()
      .regex(/^fnv1a32:[0-9a-f]{8}$/u)
      .optional(),
    targetMaskId: z.string().trim().min(1).optional(),
    targetPoint: layerMaskPointV1Schema,
  })
  .strict();

export const layerMaskCloneSourceV1Schema = z
  .object({
    alignmentErrorPx: z.number().min(0).optional(),
    candidateProvenance: z
      .object({
        algorithmId: z.literal('local_heal_v1'),
        candidateId: z.string().trim().min(1),
        candidateKind: z.enum(['dust_spot', 'emulsion_scratch']),
        changedPixelCount: z.number().int().positive(),
        confidence: z.number().min(0).max(1),
        confidenceSemantics: z.literal('ranking_score_v1'),
        origin: z.literal('negative_lab_dust_candidate'),
        outputHash: z.string().regex(/^fnv1a32:[0-9a-f]{8}$/u),
        outputSampleHash: z.string().regex(/^fnv1a32:[0-9a-f]{8}$/u),
        sourceFrameId: z.string().trim().min(1),
        sourceSampleHash: z.string().regex(/^fnv1a32:[0-9a-f]{8}$/u),
        statusAtAcceptance: z.enum(['acknowledged', 'ignored', 'pending']),
      })
      .strict()
      .optional(),
    featherRadiusPx: z.number().min(0).max(4096).optional(),
    provenance: retouchLayerRuntimeProvenanceV1Schema.optional(),
    radiusPx: z.number().positive().max(4096).optional(),
    retouchMode: z.enum(['clone', 'heal']).optional(),
    rotationDegrees: z.number().min(-180).max(180),
    scale: z.number().min(0.1).max(10),
    sourcePoint: layerMaskPointV1Schema,
    targetPoint: layerMaskPointV1Schema,
  })
  .strict();

export const layerMaskRemoveSourceV1Schema = z
  .object({
    featherRadiusPx: z.number().min(0).max(4096).optional(),
    generator: z.literal('local_patch_fill_v1'),
    generatorVersion: z.literal(1),
    provenance: retouchLayerRuntimeProvenanceV1Schema.optional(),
    radiusPx: z.number().positive().max(4096).optional(),
    resolvedSourcePoint: layerMaskPointV1Schema.optional(),
    searchRadiusMultiplier: z.number().min(1).max(12),
    seed: z.number().int().min(0).max(0xffffffff),
    status: z.enum(['fallback_unchanged', 'needs_regeneration', 'ready', 'stale']).optional(),
    targetMaskId: z.string().trim().min(1),
  })
  .strict();

const layerMaskCommandBaseV1Schema = z.object({
  actor: rawEngineActorSchema,
  approval: approvalRequirementSchema,
  commandId: z.string().trim().min(1),
  correlationId: z.string().trim().min(1),
  dryRun: z.boolean(),
  expectedGraphRevision: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1).optional(),
  schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
  target: rawEngineTargetSchema.safeExtend({ kind: z.enum(['image', 'virtual_copy']) }).strict(),
});

export const layerMaskCommandEnvelopeV1Schema = z
  .discriminatedUnion('commandType', [
    layerMaskCommandBaseV1Schema
      .extend({
        commandType: z.literal('layerMask.createLayer'),
        parameters: z
          .object({
            blendMode: layerMaskBlendModeV1Schema,
            layerId: z.string().trim().min(1).optional(),
            layerName: z.string().trim().min(1),
            opacity: z.number().min(0).max(1),
            position: z.enum(['top', 'bottom', 'above_layer', 'below_layer']),
            referenceLayerId: z.string().trim().min(1).optional(),
            retouchCloneSource: layerMaskCloneSourceV1Schema.optional(),
            retouchRemoveSource: layerMaskRemoveSourceV1Schema.optional(),
            visible: z.boolean(),
          })
          .strict()
          .superRefine((parameters, context) => {
            if (
              ['above_layer', 'below_layer'].includes(parameters.position) &&
              parameters.referenceLayerId === undefined
            ) {
              context.addIssue({
                code: 'custom',
                message: 'Relative layer insertion requires referenceLayerId.',
                path: ['referenceLayerId'],
              });
            }
            if (parameters.retouchCloneSource !== undefined && parameters.retouchRemoveSource !== undefined) {
              context.addIssue({
                code: 'custom',
                message: 'Layer cannot have both clone/heal and remove retouch sources.',
                path: ['retouchRemoveSource'],
              });
            }
          }),
      })
      .strict(),
    layerMaskCommandBaseV1Schema
      .extend({
        commandType: z.literal('layerMask.setLayerOpacity'),
        parameters: z
          .object({
            layerId: z.string().trim().min(1),
            opacity: z.number().min(0).max(1),
            visible: z.boolean().optional(),
          })
          .strict(),
      })
      .strict(),
    layerMaskCommandBaseV1Schema
      .extend({
        commandType: z.literal('layerMask.setLayerVisibility'),
        parameters: z
          .object({
            layerId: z.string().trim().min(1),
            visible: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    layerMaskCommandBaseV1Schema
      .extend({
        commandType: z.literal('layerMask.renameLayer'),
        parameters: z
          .object({
            layerId: z.string().trim().min(1),
            layerName: z.string().trim().min(1),
          })
          .strict(),
      })
      .strict(),
    layerMaskCommandBaseV1Schema
      .extend({
        commandType: z.literal('layerMask.duplicateLayer'),
        parameters: z
          .object({
            layerId: z.string().trim().min(1),
            newLayerId: z.string().trim().min(1).optional(),
            newLayerName: z.string().trim().min(1).optional(),
            position: z.enum(['above_source', 'below_source']),
          })
          .strict(),
      })
      .strict(),
    layerMaskCommandBaseV1Schema
      .extend({
        commandType: z.literal('layerMask.deleteLayer'),
        parameters: z
          .object({
            layerId: z.string().trim().min(1),
          })
          .strict(),
      })
      .strict(),
    layerMaskCommandBaseV1Schema
      .extend({
        commandType: z.literal('layerMask.moveLayer'),
        parameters: z
          .object({
            layerId: z.string().trim().min(1),
            position: z.enum(['top', 'bottom', 'above_layer', 'below_layer']),
            referenceLayerId: z.string().trim().min(1).optional(),
          })
          .strict()
          .superRefine((parameters, context) => {
            if (
              ['above_layer', 'below_layer'].includes(parameters.position) &&
              parameters.referenceLayerId === undefined
            ) {
              context.addIssue({
                code: 'custom',
                message: 'Relative layer movement requires referenceLayerId.',
                path: ['referenceLayerId'],
              });
            }
          }),
      })
      .strict(),
    layerMaskCommandBaseV1Schema
      .extend({
        commandType: z.literal('layerMask.updateRetouchSource'),
        parameters: z
          .object({
            layerId: z.string().trim().min(1),
            retouchCloneSource: layerMaskCloneSourceV1Schema,
          })
          .strict(),
      })
      .strict(),
    layerMaskCommandBaseV1Schema
      .extend({
        commandType: z.literal('layerMask.updateRetouchRemoveSource'),
        parameters: z
          .object({
            layerId: z.string().trim().min(1),
            retouchRemoveSource: layerMaskRemoveSourceV1Schema,
          })
          .strict(),
      })
      .strict(),
    layerMaskCommandBaseV1Schema
      .extend({
        commandType: z.literal('layerMask.attachMask'),
        parameters: z
          .object({
            layerId: z.string().trim().min(1),
            maskId: z.string().trim().min(1),
            replaceExisting: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    layerMaskCommandBaseV1Schema
      .extend({
        commandType: z.literal('layerMask.applyLayerAdjustment'),
        parameters: z
          .object({
            adjustmentKind: z.enum(['tone_color', 'negative_lab', 'custom']),
            adjustmentParameters: z.record(z.string(), z.unknown()),
            layerId: z.string().trim().min(1),
          })
          .strict(),
      })
      .strict(),
    layerMaskCommandBaseV1Schema
      .extend({
        commandType: z.literal('layerMask.createBrushMask'),
        parameters: z
          .object({
            baseMaskId: z.string().trim().min(1).optional(),
            maskName: z.string().trim().min(1),
            strokes: z.array(layerMaskBrushStrokeV1Schema).min(1),
          })
          .strict(),
      })
      .strict(),
    layerMaskCommandBaseV1Schema
      .extend({
        commandType: z.literal('layerMask.createGradientMask'),
        parameters: z
          .object({
            gradient: layerMaskGradientV1Schema,
            maskName: z.string().trim().min(1),
          })
          .strict(),
      })
      .strict(),
    layerMaskCommandBaseV1Schema
      .extend({
        commandType: z.literal('layerMask.createRangeMask'),
        parameters: z
          .object({
            maskName: z.string().trim().min(1),
            selection: layerMaskRangeSelectionV1Schema,
            source: z.enum(['preview_pixels', 'working_rgb', 'display_referred']),
          })
          .strict(),
      })
      .strict(),
    layerMaskCommandBaseV1Schema
      .extend({
        commandType: z.literal('layerMask.combineMasks'),
        parameters: z
          .object({
            combineMode: z.enum(['add', 'subtract', 'intersect']),
            maskName: z.string().trim().min(1),
            sourceMaskIds: z.array(z.string().trim().min(1)).min(2),
          })
          .strict()
          .superRefine((parameters, context) => {
            const uniqueMaskIds = new Set(parameters.sourceMaskIds);
            if (uniqueMaskIds.size !== parameters.sourceMaskIds.length) {
              context.addIssue({
                code: 'custom',
                message: 'Mask combination commands require unique source mask IDs.',
                path: ['sourceMaskIds'],
              });
            }
          }),
      })
      .strict(),
    layerMaskCommandBaseV1Schema
      .extend({
        commandType: z.literal('layerMask.refineMask'),
        parameters: z
          .object({
            maskId: z.string().trim().min(1),
            refinement: layerMaskRefinementParametersV1Schema,
          })
          .strict(),
      })
      .strict(),
  ])
  .superRefine((command, context) => {
    if (command.dryRun) {
      if (command.approval.approvalClass !== ApprovalClass.PreviewOnly) {
        context.addIssue({
          code: 'custom',
          message: 'Dry-run layer/mask commands require preview-only approval classification.',
          path: ['approval', 'approvalClass'],
        });
      }

      return;
    }

    if (command.approval.approvalClass !== ApprovalClass.EditApply) {
      context.addIssue({
        code: 'custom',
        message: 'Applied layer/mask commands require edit-apply approval classification.',
        path: ['approval', 'approvalClass'],
      });
    }

    if (command.approval.state !== 'approved') {
      context.addIssue({
        code: 'custom',
        message: 'Applied layer/mask commands require approved user approval before execution.',
        path: ['approval', 'state'],
      });
    }
  });

export const layerMaskParameterDiffV1Schema = z
  .object({
    entityId: z.string().trim().min(1).nullable(),
    entityKind: z.enum(['layer', 'mask', 'layer_stack']),
    path: z.string().trim().min(1),
    previousValue: z.unknown().optional(),
    value: z.unknown().optional(),
  })
  .strict();

export const layerMaskDryRunResultV1Schema = z
  .object({
    commandId: z.string().trim().min(1),
    commandType: layerMaskCommandTypeV1Schema,
    correlationId: z.string().trim().min(1),
    dryRun: z.literal(true),
    maskArtifacts: z.array(artifactHandleV1Schema),
    mutates: z.literal(false),
    parameterDiff: z.array(layerMaskParameterDiffV1Schema),
    predictedGraphRevision: z.string().trim().min(1),
    previewArtifacts: z.array(artifactHandleV1Schema),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sourceGraphRevision: z.string().trim().min(1),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict();

export const layerMaskMutationResultV1Schema = z
  .object({
    appliedGraphRevision: z.string().trim().min(1),
    changedLayerIds: z.array(z.string().trim().min(1)),
    changedMaskIds: z.array(z.string().trim().min(1)),
    changedNodeIds: z.array(z.string().trim().min(1)),
    commandId: z.string().trim().min(1),
    commandType: layerMaskCommandTypeV1Schema,
    correlationId: z.string().trim().min(1),
    dryRun: z.literal(false),
    maskArtifacts: z.array(artifactHandleV1Schema).optional(),
    maskProvenance: z
      .object({
        baseMaskHash: z.string().trim().min(1),
        contentHash: z.string().trim().min(1),
        coverageSum: z.number().min(0),
        pressurePointCount: z.number().int().min(0),
        pressureUsed: z.boolean(),
        strokeCount: z.number().int().min(1),
      })
      .strict()
      .optional(),
    mutates: z.literal(true),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sourceGraphRevision: z.string().trim().min(1),
    undoRevision: z.string().trim().min(1),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict();

export const panoramaProjectionSchema = z.enum(['rectilinear', 'cylindrical', 'spherical', 'planar']);

export const panoramaProjectionSupportSchema = z.enum(['implemented_current_engine', 'schema_only_deferred']);

export const panoramaProjectionSettingsV1Schema = z
  .object({
    deferredReason: z.string().trim().min(1).optional(),
    effectiveProjection: panoramaProjectionSchema,
    horizontalFovDegrees: z.number().positive().max(360).optional(),
    inputFocalLength35mmEquivalentMm: z.number().positive().optional(),
    requestedProjection: panoramaProjectionSchema,
    support: panoramaProjectionSupportSchema,
    verticalFovDegrees: z.number().positive().max(180).optional(),
  })
  .strict()
  .refine((settings) => settings.support === 'implemented_current_engine' || settings.deferredReason !== undefined, {
    message: 'Deferred projection settings require deferredReason.',
    path: ['deferredReason'],
  })
  .refine((settings) => settings.support !== 'implemented_current_engine' || settings.deferredReason === undefined, {
    message: 'Implemented projection settings must not include deferredReason.',
    path: ['deferredReason'],
  });

export const panoramaBoundaryModeSchema = z.enum(['auto_crop', 'transparent', 'manual_crop', 'deferred_fill']);

export const panoramaBoundarySupportSchema = z.enum(['implemented_current_engine', 'schema_only_deferred']);

export const panoramaWarningCodeSchema = z.enum([
  'source_excluded',
  'insufficient_features',
  'ambiguous_matches',
  'weak_alignment',
  'low_overlap_confidence',
  'parallax_seam_warning',
  'low_inlier_count',
  'high_memory_estimate',
  'memory_budget_exceeded',
  'missing_lens_correction',
  'exposure_mismatch',
  'projection_runtime_deferred',
  'boundary_runtime_deferred',
  'cancellation_not_supported',
]);

export const panoramaEngineCapabilitiesV1Schema = z
  .object({
    adaptiveSeamFeather: z.boolean(),
    autoCrop: z.boolean(),
    bundleAdjustment: z.boolean(),
    cylindricalProjection: z.boolean(),
    exposureNormalization: z.boolean(),
    planarHomography: z.boolean(),
    tiledRender: z.boolean(),
  })
  .strict();

export const panoramaEngineV1Schema = z
  .object({
    capabilities: panoramaEngineCapabilitiesV1Schema,
    engineId: z.literal('rapidraw_homography_seam_v0'),
    qualityTier: z.enum(['legacy_local_preview', 'validated_planar_v1']),
  })
  .strict();

export const panoramaBackendIdV1Schema = z.enum([
  'rapidraw_homography_seam_v0',
  'opencv_stitching_spike',
  'hugin_reference_tool',
]);

export const panoramaBackendSeamMethodV1Schema = z.enum([
  'adaptive_dp_feather_v1',
  'overwrite_fallback',
  'opencv_graph_cut_color',
  'opencv_graph_cut_color_grad',
  'opencv_dp_color',
  'opencv_dp_color_grad',
  'opencv_voronoi',
]);

export const panoramaBackendBlendModeV1Schema = z.enum(['overwrite', 'feather', 'multi_band']);

export const panoramaBackendExposureModeV1Schema = z.enum([
  'none',
  'planned',
  'gain_offset_v1',
  'opencv_gain',
  'opencv_gain_blocks',
  'opencv_channels',
  'opencv_channels_blocks',
]);

export const panoramaInvalidationReasonV1Schema = z.enum([
  'alignment_settings_changed',
  'boundary_settings_changed',
  'engine_version_changed',
  'exposure_settings_changed',
  'output_artifact_changed',
  'projection_settings_changed',
  'source_content_hash_changed',
  'source_graph_revision_changed',
  'source_order_changed',
  'source_set_changed',
]);

export const panoramaStaleStateV1Schema = z.enum(['current', 'stale', 'unknown']);

type SourceIndexRef = { sourceIndex: number };

type DuplicateKeyValue = number | string;

interface DuplicateFieldIssueOptions<TItem, TValue extends DuplicateKeyValue> {
  context: z.RefinementCtx;
  getPath: (index: number, item: TItem) => Array<number | string>;
  getValue: (item: TItem) => TValue;
  items: ReadonlyArray<TItem>;
  message: string;
  normalize?: (value: TValue) => DuplicateKeyValue;
}

const normalizeEnglishKey = (value: string): string => value.toLocaleLowerCase('en-US');

const addDuplicateFieldIssues = <TItem, TValue extends DuplicateKeyValue>({
  context,
  getPath,
  getValue,
  items,
  message,
  normalize,
}: DuplicateFieldIssueOptions<TItem, TValue>): void => {
  const seen = new Set<DuplicateKeyValue>();

  for (const [index, item] of items.entries()) {
    const value = getValue(item);
    const key = normalize?.(value) ?? value;

    if (seen.has(key)) {
      context.addIssue({
        code: 'custom',
        message,
        path: getPath(index, item),
      });
    }

    seen.add(key);
  }
};

interface SourceStateCoverageOptions<TSourceRef extends SourceIndexRef, TSourceState extends SourceIndexRef> {
  context: z.RefinementCtx;
  coverageMessage: string;
  path: Array<string | number>;
  referenceMessage: string;
  sourceImageRefs: Array<TSourceRef>;
  sourceStates: Array<TSourceState>;
  uniqueMessage: string;
}

const validateSourceStateCoverage = <TSourceRef extends SourceIndexRef, TSourceState extends SourceIndexRef>({
  context,
  coverageMessage,
  path,
  referenceMessage,
  sourceImageRefs,
  sourceStates,
  uniqueMessage,
}: SourceStateCoverageOptions<TSourceRef, TSourceState>): void => {
  const sourceIndexes = new Set(sourceImageRefs.map((source) => source.sourceIndex));
  const stateIndexes = new Set<number>();

  for (const [index, sourceState] of sourceStates.entries()) {
    if (stateIndexes.has(sourceState.sourceIndex)) {
      context.addIssue({
        code: 'custom',
        message: uniqueMessage,
        path: [...path, index, 'sourceIndex'],
      });
    }

    stateIndexes.add(sourceState.sourceIndex);

    if (!sourceIndexes.has(sourceState.sourceIndex)) {
      context.addIssue({
        code: 'custom',
        message: referenceMessage,
        path: [...path, index, 'sourceIndex'],
      });
    }
  }

  if (stateIndexes.size !== sourceIndexes.size) {
    context.addIssue({
      code: 'custom',
      message: coverageMessage,
      path,
    });
  }
};

const panoramaSourceStateV1Schema = z
  .object({
    contentHash: z.string().trim().min(1),
    graphRevision: z.string().trim().min(1),
    sourceIndex: z.number().int().nonnegative(),
  })
  .strict();

const validatePanoramaSourceState = (
  sourceImageRefs: Array<{ sourceIndex: number }>,
  sourceStates: Array<z.infer<typeof panoramaSourceStateV1Schema>>,
  context: z.RefinementCtx,
  path: Array<string | number>,
) => {
  validateSourceStateCoverage({
    context,
    coverageMessage: 'Panorama source state entries must cover every source image.',
    path,
    referenceMessage: 'Panorama source state entries must reference sourceImageRefs.',
    sourceImageRefs,
    sourceStates,
    uniqueMessage: 'Panorama source state entries require unique source indexes.',
  });
};

export const panoramaBackendCapabilityReportV1Schema = z
  .object({
    backendId: panoramaBackendIdV1Schema,
    backendVersion: z.string().trim().min(1),
    capabilities: panoramaEngineCapabilitiesV1Schema,
    ciPolicy: z
      .object({
        defaultRequiredCiAllowed: z.boolean(),
        requiredCiBlockers: z.array(z.string().trim().min(1)),
        suggestedCiTier: z.enum(['required_pr', 'nightly', 'manual_spike']),
      })
      .strict(),
    limits: z
      .object({
        maxRecommendedOutputPixels: z.number().int().positive(),
        maxRecommendedPeakMemoryBytes: z.number().int().positive(),
        maxRecommendedSourceCount: z.number().int().positive(),
      })
      .strict(),
    macosPackagingStatus: z.enum(['not_required', 'bundled', 'system_dependency_spike', 'unproven']),
    qualityTier: z.enum(['legacy_local_preview', 'validated_planar_v1', 'optional_spike', 'reference_only']),
    runtimeRequirements: z
      .object({
        externalLibraries: z.array(z.string().trim().min(1)),
        requiresExternalLibraries: z.boolean(),
        requiresNetworkAtRuntime: z.literal(false),
      })
      .strict(),
    schemaBoundary: z
      .object({
        backendTypesLeakIntoArtifacts: z.literal(false),
        rawEngineCapabilityNamesOnly: z.literal(true),
      })
      .strict(),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    status: z.enum(['default_enabled', 'optional_spike', 'reference_only', 'disabled']),
    supportedBlendModes: z.array(panoramaBackendBlendModeV1Schema).min(1),
    supportedBoundaryModes: z.array(panoramaBoundaryModeSchema).min(1),
    supportedExposureModes: z.array(panoramaBackendExposureModeV1Schema).min(1),
    supportedProjections: z.array(panoramaProjectionSchema).min(1),
    supportedSeamMethods: z.array(panoramaBackendSeamMethodV1Schema).min(1),
    warnings: z.array(
      z.enum(['backend_types_must_not_escape', 'external_dependency', 'packaging_unproven', 'required_ci_not_ready']),
    ),
  })
  .strict()
  .superRefine((report, context) => {
    if (
      report.runtimeRequirements.requiresExternalLibraries &&
      report.runtimeRequirements.externalLibraries.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Backends that require external libraries must list them.',
        path: ['runtimeRequirements', 'externalLibraries'],
      });
    }

    if (
      !report.runtimeRequirements.requiresExternalLibraries &&
      report.runtimeRequirements.externalLibraries.length > 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Backends without external library requirements must not list external libraries.',
        path: ['runtimeRequirements', 'externalLibraries'],
      });
    }

    if (report.runtimeRequirements.requiresExternalLibraries && report.macosPackagingStatus === 'not_required') {
      context.addIssue({
        code: 'custom',
        message: 'External-library backends need a macOS packaging status.',
        path: ['macosPackagingStatus'],
      });
    }

    if (
      report.ciPolicy.defaultRequiredCiAllowed &&
      report.runtimeRequirements.requiresExternalLibraries &&
      report.macosPackagingStatus !== 'bundled'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'External-library backends may enter required CI only after bundled packaging is proven.',
        path: ['ciPolicy', 'defaultRequiredCiAllowed'],
      });
    }

    if (report.status === 'default_enabled' && !report.ciPolicy.defaultRequiredCiAllowed) {
      context.addIssue({
        code: 'custom',
        message: 'Default-enabled panorama backends must be allowed in required CI.',
        path: ['status'],
      });
    }

    if (
      report.backendId === 'rapidraw_homography_seam_v0' &&
      !report.supportedSeamMethods.includes('adaptive_dp_feather_v1')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'The legacy RapidRaw backend must advertise adaptive seam feathering.',
        path: ['supportedSeamMethods'],
      });
    }
  });

export const panoramaSourceImageRefV1Schema = z
  .object({
    colorSpaceHint: z.string().trim().min(1).optional(),
    imageId: z.string().trim().min(1).optional(),
    imagePath: z.string().trim().min(1),
    lensCorrectionState: z.enum(['unknown', 'not_applied', 'applied', 'required_before_stitch']),
    rawDefaultsApplied: z.boolean(),
    sourceIndex: z.number().int().nonnegative(),
    virtualCopyId: z.string().trim().min(1).nullable().optional(),
  })
  .strict();

export const panoramaCropV1Schema = z
  .object({
    height: z.number().int().positive(),
    mode: z.enum(['none', 'auto', 'manual']),
    width: z.number().int().positive(),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
  })
  .strict();

export const panoramaBoundarySettingsV1Schema = z
  .object({
    crop: panoramaCropV1Schema,
    deferredReason: z.string().trim().min(1).optional(),
    effectiveMode: panoramaBoundaryModeSchema,
    fillColor: z
      .object({
        alpha: z.number().min(0).max(1),
        blue: z.number().min(0).max(1),
        green: z.number().min(0).max(1),
        red: z.number().min(0).max(1),
      })
      .strict()
      .optional(),
    requestedMode: panoramaBoundaryModeSchema,
    support: panoramaBoundarySupportSchema,
  })
  .strict()
  .refine((settings) => settings.support === 'implemented_current_engine' || settings.deferredReason !== undefined, {
    message: 'Deferred boundary settings require deferredReason.',
    path: ['deferredReason'],
  })
  .refine((settings) => settings.support !== 'implemented_current_engine' || settings.deferredReason === undefined, {
    message: 'Implemented boundary settings must not include deferredReason.',
    path: ['deferredReason'],
  });

export const panoramaPairwiseMatchV1Schema = z
  .object({
    fromSourceIndex: z.number().int().nonnegative(),
    homography3x3: z.tuple([
      z.number(),
      z.number(),
      z.number(),
      z.number(),
      z.number(),
      z.number(),
      z.number(),
      z.number(),
      z.number(),
    ]),
    homographyDiagnostics: panoramaHomographyDltDiagnosticsV1Schema.optional(),
    inliers: z.number().int().nonnegative(),
    matchQuality: z.enum(['accepted', 'weak', 'rejected']),
    reprojectionErrorPx: z.number().nonnegative().optional(),
    toSourceIndex: z.number().int().nonnegative(),
  })
  .strict();

export const panoramaAlignmentV1Schema = z
  .object({
    algorithmId: z.literal('rapidraw_fast9_brief_ransac_v1'),
    downscaleMaxDimensionPx: z.number().int().positive(),
    globalHomographyCount: z.number().int().nonnegative(),
    localOptimization: z
      .object({
        algorithmId: z.literal('deterministic_inlier_mean_refinement_v1'),
        boundedIterationCount: z.number().int().nonnegative(),
        deterministicTieBreak: z.literal('first_max_consensus_lowest_match_index'),
        refinedModelType: z.literal('translation_xy'),
        support: z.literal('synthetic_translation_metadata_only'),
      })
      .strict()
      .optional(),
    minimumInliersForConnection: z.number().int().positive(),
    pairwiseMatches: z.array(panoramaPairwiseMatchV1Schema),
    ransacSeed: z.number().int().nonnegative().optional(),
    ransacInlierThresholdPx: z.number().positive(),
    ransacIterations: z.number().int().positive(),
  })
  .strict();

export const panoramaExposureNormalizationV1Schema = z
  .object({
    appliedGainCount: z.number().int().nonnegative().optional(),
    appliedLuminanceGains: z
      .array(
        z
          .object({
            gain: z.number().positive(),
            sourceIndex: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .optional(),
    compensationStrengthPercent: z.number().int().min(0).max(100).optional(),
    deferredReason: z.string().trim().min(1).optional(),
    mode: z.enum(['none', 'planned', 'gain_offset_v1', 'scalar_overlap_luminance_gain_v1']),
    overlapMetrics: z
      .object({
        channelRatioDeltaAfter: z.number().nonnegative().optional(),
        channelRatioDeltaBefore: z.number().nonnegative().optional(),
        clippingIncreaseRatio: z.number().nonnegative().optional(),
        medianLogLuminanceDeltaAfter: z.number().nonnegative().optional(),
        medianLogLuminanceDeltaBefore: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
    perSourceCorrections: z
      .array(
        z
          .object({
            exposureEv: z.number(),
            sourceIndex: z.number().int().nonnegative(),
            temperatureShift: z.number().optional(),
            tintShift: z.number().optional(),
          })
          .strict(),
      )
      .optional(),
    skippedReason: z.enum(['insufficient_overlap', 'low_confidence_alignment', 'not_requested']).optional(),
    support: z.enum(['implemented_current_engine', 'schema_only_deferred']),
  })
  .strict()
  .refine((settings) => settings.support === 'implemented_current_engine' || settings.deferredReason !== undefined, {
    message: 'Deferred exposure normalization requires deferredReason.',
    path: ['deferredReason'],
  })
  .refine((settings) => settings.support !== 'implemented_current_engine' || settings.deferredReason === undefined, {
    message: 'Implemented exposure normalization must not include deferredReason.',
    path: ['deferredReason'],
  })
  .refine(
    (settings) =>
      settings.mode !== 'scalar_overlap_luminance_gain_v1' ||
      (settings.support === 'implemented_current_engine' &&
        settings.appliedGainCount !== undefined &&
        settings.appliedGainCount > 0 &&
        settings.appliedLuminanceGains !== undefined &&
        settings.appliedLuminanceGains.length === settings.appliedGainCount),
    {
      message: 'Scalar overlap gain metadata requires implemented support and applied gain details.',
      path: ['appliedLuminanceGains'],
    },
  );

export const panoramaSeamPolicyV1Schema = z
  .object({
    featherWidthPx: z.number().positive(),
    lowDetailFeatherMultiplier: z.number().positive(),
    mode: z.enum(['adaptive_dp_feather_v1', 'overwrite_fallback']),
  })
  .strict();

export const panoramaValidationMetricsV1Schema = z
  .object({
    estimatedPeakMemoryBytes: z.number().int().nonnegative().optional(),
    excludedSourceCount: z.number().int().nonnegative(),
    overlapCoverageRatio: z.number().min(0).max(1).optional(),
    outputHeight: z.number().int().positive(),
    outputWidth: z.number().int().positive(),
    reprojectionP95Px: z.number().nonnegative().optional(),
    reprojectionRmsPx: z.number().nonnegative().optional(),
    seamEnergy: z.number().nonnegative().optional(),
    sourceCount: z.number().int().positive(),
    stitchedSourceCount: z.number().int().positive(),
    tileCount: z.number().int().positive().optional(),
  })
  .strict();

export const panoramaArtifactV1Schema = z
  .object({
    alignment: panoramaAlignmentV1Schema,
    artifactId: z.string().trim().min(1),
    boundaryMode: panoramaBoundaryModeSchema,
    boundarySettings: panoramaBoundarySettingsV1Schema,
    createdAt: z.iso.datetime({ offset: true }),
    crop: panoramaCropV1Schema,
    excludedSources: z
      .array(
        z
          .object({
            reason: panoramaWarningCodeSchema,
            sourceIndex: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .default([]),
    engine: panoramaEngineV1Schema,
    exposureNormalization: panoramaExposureNormalizationV1Schema,
    lensCorrectionPolicy: z.enum(['unchanged', 'required_before_stitch', 'applied_before_stitch', 'deferred']),
    operationId: z.string().trim().min(1),
    operationVersion: z.literal(1),
    outputArtifacts: z.array(artifactHandleV1Schema),
    outputColorSpace: z.string().trim().min(1),
    previewArtifacts: z.array(artifactHandleV1Schema),
    projection: panoramaProjectionSchema,
    projectionSettings: panoramaProjectionSettingsV1Schema,
    provenance: z
      .object({
        commandId: z.string().trim().min(1).optional(),
        graphRevision: z.string().trim().min(1).optional(),
        runtimeStatus: z.enum(['schema_only', 'dry_run_planned', 'rendered']),
      })
      .strict(),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    seamPolicy: panoramaSeamPolicyV1Schema,
    sourceImageRefs: z.array(panoramaSourceImageRefV1Schema).min(2),
    sourceState: z.array(panoramaSourceStateV1Schema).min(2),
    staleState: z
      .object({
        checkedAt: z.iso.datetime({ offset: true }).optional(),
        invalidationReasons: z.array(panoramaInvalidationReasonV1Schema),
        state: panoramaStaleStateV1Schema,
      })
      .strict(),
    validationMetrics: panoramaValidationMetricsV1Schema,
    warnings: z.array(panoramaWarningCodeSchema),
  })
  .strict()
  .superRefine((artifact, context) => {
    if (artifact.projection !== artifact.projectionSettings.effectiveProjection) {
      context.addIssue({
        code: 'custom',
        message: 'projection must match projectionSettings.effectiveProjection.',
        path: ['projection'],
      });
    }

    if (artifact.boundaryMode !== artifact.boundarySettings.effectiveMode) {
      context.addIssue({
        code: 'custom',
        message: 'boundaryMode must match boundarySettings.effectiveMode.',
        path: ['boundaryMode'],
      });
    }

    if (JSON.stringify(artifact.crop) !== JSON.stringify(artifact.boundarySettings.crop)) {
      context.addIssue({
        code: 'custom',
        message: 'crop must match boundarySettings.crop.',
        path: ['crop'],
      });
    }

    if (artifact.validationMetrics.sourceCount !== artifact.sourceImageRefs.length) {
      context.addIssue({
        code: 'custom',
        message: 'validationMetrics.sourceCount must match sourceImageRefs length.',
        path: ['validationMetrics', 'sourceCount'],
      });
    }

    if (artifact.validationMetrics.excludedSourceCount !== artifact.excludedSources.length) {
      context.addIssue({
        code: 'custom',
        message: 'validationMetrics.excludedSourceCount must match excludedSources length.',
        path: ['validationMetrics', 'excludedSourceCount'],
      });
    }

    if (
      artifact.validationMetrics.stitchedSourceCount + artifact.validationMetrics.excludedSourceCount >
      artifact.validationMetrics.sourceCount
    ) {
      context.addIssue({
        code: 'custom',
        message: 'stitchedSourceCount plus excludedSourceCount cannot exceed sourceCount.',
        path: ['validationMetrics', 'stitchedSourceCount'],
      });
    }

    if (artifact.provenance.runtimeStatus === 'rendered' && artifact.outputArtifacts.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Rendered panorama artifacts require at least one output artifact.',
        path: ['outputArtifacts'],
      });
    }

    if (artifact.provenance.runtimeStatus !== 'rendered' && artifact.outputArtifacts.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'Only rendered panorama artifacts may include durable output artifacts.',
        path: ['outputArtifacts'],
      });
    }

    if (artifact.staleState.state === 'current' && artifact.staleState.invalidationReasons.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'Current panorama artifacts must not include invalidation reasons.',
        path: ['staleState', 'invalidationReasons'],
      });
    }

    if (artifact.staleState.state === 'stale' && artifact.staleState.invalidationReasons.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Stale panorama artifacts require invalidation reasons.',
        path: ['staleState', 'invalidationReasons'],
      });
    }

    const sourceIndices = new Set<number>();
    for (const [sourceIndex, source] of artifact.sourceImageRefs.entries()) {
      if (sourceIndices.has(source.sourceIndex)) {
        context.addIssue({
          code: 'custom',
          message: 'sourceImageRefs sourceIndex values must be unique.',
          path: ['sourceImageRefs', sourceIndex, 'sourceIndex'],
        });
      }

      sourceIndices.add(source.sourceIndex);
    }

    validatePanoramaSourceState(artifact.sourceImageRefs, artifact.sourceState, context, ['sourceState']);

    if (
      artifact.projectionSettings.support === 'implemented_current_engine' &&
      ['rectilinear', 'planar'].includes(artifact.projectionSettings.effectiveProjection) &&
      !artifact.engine.capabilities.planarHomography
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Implemented rectilinear or planar projection requires planarHomography capability.',
        path: ['engine', 'capabilities', 'planarHomography'],
      });
    }

    if (
      artifact.projectionSettings.support === 'implemented_current_engine' &&
      artifact.projectionSettings.effectiveProjection === 'cylindrical' &&
      !artifact.engine.capabilities.cylindricalProjection
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Implemented cylindrical projection requires cylindricalProjection capability.',
        path: ['engine', 'capabilities', 'cylindricalProjection'],
      });
    }

    if (
      artifact.projectionSettings.support === 'implemented_current_engine' &&
      artifact.projectionSettings.effectiveProjection === 'spherical'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Spherical projection is schema-only until an engine capability is added.',
        path: ['projectionSettings', 'support'],
      });
    }

    if (
      artifact.boundarySettings.support === 'implemented_current_engine' &&
      artifact.boundarySettings.effectiveMode === 'auto_crop' &&
      !artifact.engine.capabilities.autoCrop
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Implemented auto-crop boundary mode requires autoCrop capability.',
        path: ['engine', 'capabilities', 'autoCrop'],
      });
    }

    if (
      artifact.boundarySettings.support === 'implemented_current_engine' &&
      artifact.boundarySettings.effectiveMode === 'deferred_fill'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Deferred fill must remain schema-only until a fill engine capability exists.',
        path: ['boundarySettings', 'support'],
      });
    }

    if (
      artifact.exposureNormalization.support === 'implemented_current_engine' &&
      !artifact.engine.capabilities.exposureNormalization
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Implemented exposure normalization requires exposureNormalization capability.',
        path: ['engine', 'capabilities', 'exposureNormalization'],
      });
    }
  });

export const computationalMergeFamilyV1Schema = z.enum(['panorama', 'hdr', 'focus_stack', 'super_resolution']);

export const computationalMergeCommandTypeV1Schema = z.enum([
  'computationalMerge.createPanorama',
  'computationalMerge.createHdr',
  'computationalMerge.createFocusStack',
  'computationalMerge.createSuperResolution',
]);

export const computationalMergeSourceRoleV1Schema = z.enum(['panorama_tile', 'hdr_bracket', 'focus_slice', 'sr_frame']);

export const computationalMergeSourceImageRefV1Schema = z
  .object({
    colorSpaceHint: z.string().trim().min(1).optional(),
    exposureEv: z.number().optional(),
    exposureWeightMultiplier: z.number().positive().optional(),
    focusDistanceMm: z.number().positive().optional(),
    imageId: z.string().trim().min(1).optional(),
    imagePath: z.string().trim().min(1),
    rawDefaultsApplied: z.boolean(),
    role: computationalMergeSourceRoleV1Schema,
    sourceIndex: z.number().int().nonnegative(),
    virtualCopyId: z.string().trim().min(1).nullable().optional(),
  })
  .strict();

export const computationalMergeAlignmentModeV1Schema = z.enum([
  'auto',
  'translation',
  'homography',
  'optical_flow',
  'none',
]);

export const computationalMergeQualityPreferenceV1Schema = z.enum(['preview', 'balanced', 'best']);

export const superResolutionModeV1Schema = z.enum(['single_image', 'multi_image']);
export const superResolutionReconstructionModeV1Schema = z.enum(['model_detail', 'optical_flow']);

export const superResolutionDetailPolicyV1Schema = z.enum(['conservative', 'balanced', 'aggressive_preview_only']);

export const superResolutionDecisionStatusV1Schema = z.enum([
  'eligible_for_apply',
  'preview_only',
  'blocked',
  'downgraded',
]);

export const superResolutionWarningCodeV1Schema = z.enum([
  'aggressive_preview_only',
  'effective_scale_downgraded',
  'high_memory_estimate',
  'human_review_required',
  'low_alignment_confidence',
  'low_overlap_coverage',
  'motion_detected',
  'runtime_estimate_high',
  'texture_risk',
]);

export const superResolutionBlockCodeV1Schema = z.enum([
  'aggressive_detail_preview_only',
  'alignment_confidence_too_low',
  'alignment_required',
  'human_review_failed',
  'insufficient_overlap',
  'memory_budget_exceeded',
  'missing_accepted_dry_run',
  'source_graph_changed',
  'source_hash_changed',
  'unsupported_detail_policy',
]);

export const superResolutionReviewStatusV1Schema = z.enum(['not_required', 'pending', 'passed', 'failed']);

export const superResolutionInvalidationReasonV1Schema = z.enum([
  'alignment_settings_changed',
  'detail_policy_changed',
  'engine_version_changed',
  'model_version_changed',
  'output_artifact_changed',
  'reconstruction_mode_changed',
  'scale_changed',
  'source_content_hash_changed',
  'source_graph_revision_changed',
  'source_set_changed',
]);

export const superResolutionStaleStateV1Schema = z.enum(['current', 'stale', 'unknown']);

export const computationalMergeOutputDimensionsV1Schema = z
  .object({
    height: z.number().int().positive(),
    width: z.number().int().positive(),
  })
  .strict();

export const computationalMergePreflightStatusV1Schema = z.enum([
  'accepted',
  'warning',
  'blocked_plan_only',
  'blocked_tile_runtime_deferred',
]);

export const computationalMergeExecutionModeV1Schema = z.enum(['full_frame_legacy', 'plan_only', 'tile_backed_render']);

export const computationalMergePreflightWarningCodeV1Schema = z.enum([
  'geometry_estimate_low_confidence',
  'geometry_overclaim_guardrail',
  'high_memory_estimate',
  'legacy_full_frame_render',
  'graph_disconnected',
  'memory_budget_exceeded',
  'multi_row_runtime_deferred',
  'grid_like_geometry_unverified',
  'single_row_geometry_low_confidence',
  'source_geometry_unverified',
  'tile_runtime_deferred',
  'tiled_render_required',
]);

export const computationalMergeProjectedBoundsV1Schema = z
  .object({
    height: z.number().int().positive(),
    width: z.number().int().positive(),
    x: z.number().int(),
    y: z.number().int(),
  })
  .strict();

export const computationalMergeGeometryEstimateV1Schema = z
  .object({
    outputPixelCount: z.number().int().positive(),
    projectedBounds: computationalMergeProjectedBoundsV1Schema,
    sourceCount: z.number().int().positive(),
    sourcePixelCount: z.number().int().positive(),
  })
  .strict();

export const computationalMergeMemoryComponentsV1Schema = z
  .object({
    lowDetailMaskBytes: z.number().int().nonnegative(),
    outputCanvasBytes: z.number().int().nonnegative(),
    outputMaskBytes: z.number().int().nonnegative(),
    overheadBytes: z.number().int().nonnegative(),
    previewBytes: z.number().int().nonnegative(),
    seamWorkspaceBytes: z.number().int().nonnegative(),
    sourceDecodeBytes: z.number().int().nonnegative(),
    totalEstimatedPeakBytes: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((components, context) => {
    const summedBytes =
      components.lowDetailMaskBytes +
      components.outputCanvasBytes +
      components.outputMaskBytes +
      components.overheadBytes +
      components.previewBytes +
      components.seamWorkspaceBytes +
      components.sourceDecodeBytes;

    if (components.totalEstimatedPeakBytes !== summedBytes) {
      context.addIssue({
        code: 'custom',
        message: 'totalEstimatedPeakBytes must equal the sum of memory component estimates.',
        path: ['totalEstimatedPeakBytes'],
      });
    }
  });

export const computationalMergeEngineCapabilitiesV1Schema = z
  .object({
    fullFrameLegacy: z.boolean(),
    maxPreviewDimensionPx: z.number().int().positive().max(8192),
    planOnly: z.literal(true),
    tileBackedRender: z.boolean(),
  })
  .strict();

export const computationalMergePreflightEstimateV1Schema = z
  .object({
    blockedReasons: z.array(z.string().trim().min(1)),
    engineCapabilities: computationalMergeEngineCapabilitiesV1Schema,
    executionMode: computationalMergeExecutionModeV1Schema,
    geometryEstimate: computationalMergeGeometryEstimateV1Schema,
    memoryBudgetBytes: z.number().int().positive(),
    memoryBudgetRatio: z.number().nonnegative(),
    memoryComponents: computationalMergeMemoryComponentsV1Schema,
    sourceGeometry: z
      .object({
        blockedReasons: z.array(z.string().trim().min(1)),
        columnCountEstimate: z.number().int().positive(),
        connectedComponentCount: z.number().int().positive(),
        graphConnectivity: z
          .object({
            connectedSourceCount: z.number().int().nonnegative(),
            disconnectedSourceCount: z.number().int().nonnegative(),
            edgeCount: z.number().int().nonnegative(),
            isConnected: z.boolean(),
          })
          .strict(),
        layout: z.enum(['grid_like', 'multi_row_candidate', 'single_row', 'unknown']),
        layoutConfidence: z
          .object({
            columnConfidence: z.number().min(0).max(1),
            overallConfidence: z.number().min(0).max(1),
            rowConfidence: z.number().min(0).max(1),
          })
          .strict(),
        selectedComponent: z
          .object({
            sourceCount: z.number().int().positive(),
            sourceIndices: z.array(z.number().int().nonnegative()),
          })
          .strict(),
        rowCountEstimate: z.number().int().positive(),
        support: z.enum(['blocked_requires_multi_row_solver', 'implemented_current_engine', 'unverified']),
        verticalSpanPx: z.number().int().nonnegative(),
        horizontalSpanPx: z.number().int().nonnegative(),
        warningCodes: z.array(computationalMergePreflightWarningCodeV1Schema),
      })
      .strict()
      .optional(),
    status: computationalMergePreflightStatusV1Schema,
    tileCount: z.number().int().positive(),
    warningCodes: z.array(computationalMergePreflightWarningCodeV1Schema),
  })
  .strict()
  .superRefine((preflight, context) => {
    const expectedRatio = preflight.memoryComponents.totalEstimatedPeakBytes / preflight.memoryBudgetBytes;
    if (Math.abs(preflight.memoryBudgetRatio - expectedRatio) > 0.000001) {
      context.addIssue({
        code: 'custom',
        message: 'memoryBudgetRatio must equal totalEstimatedPeakBytes divided by memoryBudgetBytes.',
        path: ['memoryBudgetRatio'],
      });
    }

    if (preflight.status === 'accepted' && preflight.blockedReasons.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'Accepted preflight plans must not include blocked reasons.',
        path: ['blockedReasons'],
      });
    }

    if (preflight.status.startsWith('blocked_') && preflight.blockedReasons.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Blocked preflight plans require at least one blocked reason.',
        path: ['blockedReasons'],
      });
    }

    if (
      preflight.status === 'blocked_tile_runtime_deferred' &&
      !preflight.warningCodes.includes('tile_runtime_deferred')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Tile-runtime-deferred preflight plans require the tile_runtime_deferred warning code.',
        path: ['warningCodes'],
      });
    }

    if (preflight.executionMode === 'tile_backed_render' && preflight.tileCount < 2) {
      context.addIssue({
        code: 'custom',
        message: 'Tile-backed preflight plans require at least two tiles.',
        path: ['tileCount'],
      });
    }

    if (preflight.executionMode !== 'tile_backed_render' && preflight.tileCount !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'Non-tiled preflight plans must use a tileCount of 1.',
        path: ['tileCount'],
      });
    }
  });

export const computationalMergePerformanceEstimateV1Schema = z
  .object({
    estimatedPeakMemoryBytes: z.number().int().nonnegative(),
    estimatedRuntimeMs: z.number().int().nonnegative(),
    requiresBackgroundJob: z.boolean(),
  })
  .strict();

export const computationalMergeQualityMetricsV1Schema = z
  .object({
    alignmentConfidence: z.number().min(0).max(1).optional(),
    deghostingRisk: z.enum(['none', 'low', 'medium', 'high']).optional(),
    expectedDetailGainRatio: z.number().positive().optional(),
    focusCoverageRatio: z.number().min(0).max(1).optional(),
    overlapCoverageRatio: z.number().min(0).max(1).optional(),
    sourceCount: z.number().int().positive(),
  })
  .strict();

export const computationalMergePlanV1Schema = z
  .object({
    family: computationalMergeFamilyV1Schema,
    outputDimensions: computationalMergeOutputDimensionsV1Schema,
    outputName: z.string().trim().min(1),
    performanceEstimate: computationalMergePerformanceEstimateV1Schema,
    planId: z.string().trim().min(1),
    preflight: computationalMergePreflightEstimateV1Schema,
    qualityMetrics: computationalMergeQualityMetricsV1Schema,
    sourceImageRefs: z.array(computationalMergeSourceImageRefV1Schema).min(2),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict()
  .superRefine((plan, context) => {
    const sourceIndexes = new Set(plan.sourceImageRefs.map((source) => source.sourceIndex));
    if (sourceIndexes.size !== plan.sourceImageRefs.length) {
      context.addIssue({
        code: 'custom',
        message: 'Computational merge plans require unique source indexes.',
        path: ['sourceImageRefs'],
      });
    }

    if (plan.preflight.geometryEstimate.sourceCount !== plan.sourceImageRefs.length) {
      context.addIssue({
        code: 'custom',
        message: 'Preflight sourceCount must match sourceImageRefs length.',
        path: ['preflight', 'geometryEstimate', 'sourceCount'],
      });
    }

    if (
      plan.preflight.geometryEstimate.outputPixelCount !==
      plan.outputDimensions.height * plan.outputDimensions.width
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Preflight outputPixelCount must match outputDimensions.',
        path: ['preflight', 'geometryEstimate', 'outputPixelCount'],
      });
    }

    if (
      plan.preflight.geometryEstimate.projectedBounds.height !== plan.outputDimensions.height ||
      plan.preflight.geometryEstimate.projectedBounds.width !== plan.outputDimensions.width
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Preflight projected bounds must match outputDimensions.',
        path: ['preflight', 'geometryEstimate', 'projectedBounds'],
      });
    }
  });

const computationalMergeCommandBaseV1Schema = z.object({
  actor: rawEngineActorSchema,
  approval: approvalRequirementSchema,
  commandId: z.string().trim().min(1),
  correlationId: z.string().trim().min(1),
  dryRun: z.boolean(),
  expectedGraphRevision: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1).optional(),
  schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
  target: rawEngineTargetSchema.safeExtend({ kind: z.enum(['image', 'project']) }).strict(),
});

const computationalMergeSourcesSchema = z
  .array(computationalMergeSourceImageRefV1Schema)
  .min(2)
  .superRefine((sources, context) => {
    const sourceIndexes = new Set(sources.map((source) => source.sourceIndex));
    if (sourceIndexes.size !== sources.length) {
      context.addIssue({
        code: 'custom',
        message: 'Computational merge commands require unique source indexes.',
      });
    }
  });

const superResolutionSourcesSchema = z
  .array(computationalMergeSourceImageRefV1Schema)
  .min(1)
  .superRefine((sources, context) => {
    const sourceIndexes = new Set(sources.map((source) => source.sourceIndex));
    if (sourceIndexes.size !== sources.length) {
      context.addIssue({
        code: 'custom',
        message: 'Super-resolution commands require unique source indexes.',
      });
    }
  });

const computationalMergeAcceptedDryRunSchema = z.object({
  acceptedDryRunPlanHash: z.string().trim().min(1).optional(),
  acceptedDryRunPlanId: z.string().trim().min(1).optional(),
});

const validateComputationalMergeSourceRole = (
  sources: Array<ComputationalMergeSourceImageRefV1>,
  expectedRole: ComputationalMergeSourceRoleV1,
  context: z.RefinementCtx,
) => {
  sources.forEach((source, sourceIndex) => {
    if (source.role !== expectedRole) {
      context.addIssue({
        code: 'custom',
        message: `Computational merge ${expectedRole} operations require every source to use the ${expectedRole} role.`,
        path: ['sources', sourceIndex, 'role'],
      });
    }
  });
};

export const computationalMergeCommandEnvelopeV1Schema = z
  .discriminatedUnion('commandType', [
    computationalMergeCommandBaseV1Schema
      .extend({
        commandType: z.literal('computationalMerge.createPanorama'),
        parameters: z
          .object({
            ...computationalMergeAcceptedDryRunSchema.shape,
            blendMode: z.enum(['feather', 'multi_band']).optional(),
            boundaryMode: panoramaBoundaryModeSchema,
            exposureNormalization: z.enum(['none', 'auto']),
            lensCorrectionPolicy: z.enum(['unchanged', 'required_before_stitch', 'applied_before_stitch']),
            manualCropInsetsPercent: z
              .object({
                bottom: z.number().min(0).max(40),
                left: z.number().min(0).max(40),
                right: z.number().min(0).max(40),
                top: z.number().min(0).max(40),
              })
              .strict()
              .superRefine((insets, context) => {
                if (insets.left + insets.right > 80) {
                  context.addIssue({
                    code: 'custom',
                    message: 'Horizontal panorama crop insets cannot exceed 80%.',
                  });
                }
                if (insets.top + insets.bottom > 80) {
                  context.addIssue({
                    code: 'custom',
                    message: 'Vertical panorama crop insets cannot exceed 80%.',
                  });
                }
              })
              .optional(),
            maxPreviewDimensionPx: z.number().int().positive().max(8192),
            memoryBudgetBytes: z.number().int().positive().optional(),
            overlapFeatherPx: z.number().int().min(0).max(512).optional(),
            outputName: z.string().trim().min(1),
            projection: panoramaProjectionSchema,
            qualityPreference: computationalMergeQualityPreferenceV1Schema,
            seamExposureCompensationPercent: z.number().int().min(0).max(100).default(100),
            sources: computationalMergeSourcesSchema,
          })
          .strict()
          .superRefine((parameters, context) => {
            validateComputationalMergeSourceRole(parameters.sources, 'panorama_tile', context);
          }),
      })
      .strict(),
    computationalMergeCommandBaseV1Schema
      .extend({
        commandType: z.literal('computationalMerge.createHdr'),
        parameters: z
          .object({
            ...computationalMergeAcceptedDryRunSchema.shape,
            alignmentMode: computationalMergeAlignmentModeV1Schema,
            bracketValidation: z.enum(['required', 'warn', 'disabled']),
            deghostConfidenceMapVisible: z.boolean().default(false),
            deghostRegionIntensityPercent: z.number().int().min(0).max(100).default(65),
            deghosting: z.enum(['off', 'low', 'medium', 'high']),
            maxPreviewDimensionPx: z.number().int().positive().max(8192),
            mergeStrategy: z.enum(['scene_linear_radiance', 'exposure_fusion_preview']),
            outputName: z.string().trim().min(1),
            qualityPreference: computationalMergeQualityPreferenceV1Schema,
            sources: computationalMergeSourcesSchema,
            toneMapPreview: z.boolean(),
            toneMappingPreset: z
              .enum(['custom', 'natural', 'highlight_detail', 'interior_lift', 'fast_preview'])
              .optional(),
          })
          .strict()
          .superRefine((parameters, context) => {
            validateComputationalMergeSourceRole(parameters.sources, 'hdr_bracket', context);

            if (parameters.bracketValidation !== 'required') return;

            const exposureValues = parameters.sources
              .map((source) => source.exposureEv)
              .filter((exposureEv) => exposureEv !== undefined);
            const uniqueExposureValues = new Set(exposureValues);
            if (exposureValues.length !== parameters.sources.length || uniqueExposureValues.size < 2) {
              context.addIssue({
                code: 'custom',
                message: 'Required HDR bracket validation needs exposureEv on every source and at least two exposures.',
                path: ['sources'],
              });
            }
          }),
      })
      .strict(),
    computationalMergeCommandBaseV1Schema
      .extend({
        commandType: z.literal('computationalMerge.createFocusStack'),
        parameters: z
          .object({
            ...computationalMergeAcceptedDryRunSchema.shape,
            alignmentMode: computationalMergeAlignmentModeV1Schema,
            blendMethod: z.enum(['depth_map', 'laplacian_pyramid', 'weighted_sharpness']),
            haloSuppressionStrengthPercent: z.number().int().min(0).max(100).optional(),
            maxPreviewDimensionPx: z.number().int().positive().max(8192),
            memoryBudgetBytes: z.number().int().positive().optional(),
            outputName: z.string().trim().min(1),
            qualityPreference: computationalMergeQualityPreferenceV1Schema,
            retouchLayerPolicy: z.enum(['none', 'generate_retouch_layer']),
            sources: computationalMergeSourcesSchema,
          })
          .strict()
          .superRefine((parameters, context) => {
            validateComputationalMergeSourceRole(parameters.sources, 'focus_slice', context);
          }),
      })
      .strict(),
    computationalMergeCommandBaseV1Schema
      .extend({
        commandType: z.literal('computationalMerge.createSuperResolution'),
        parameters: z
          .object({
            ...computationalMergeAcceptedDryRunSchema.shape,
            alignmentMode: computationalMergeAlignmentModeV1Schema,
            detailPolicy: superResolutionDetailPolicyV1Schema,
            maxPreviewDimensionPx: z.number().int().positive().max(8192),
            mode: superResolutionModeV1Schema,
            outputName: z.string().trim().min(1),
            outputScale: z.number().min(1.1).max(4),
            qualityPreference: computationalMergeQualityPreferenceV1Schema,
            reconstructionMode: superResolutionReconstructionModeV1Schema.default('model_detail'),
            sources: superResolutionSourcesSchema,
          })
          .strict()
          .superRefine((parameters, context) => {
            validateComputationalMergeSourceRole(parameters.sources, 'sr_frame', context);

            if (parameters.mode === 'single_image') {
              if (parameters.sources.length !== 1) {
                context.addIssue({
                  code: 'custom',
                  message: 'Single-image super-resolution requires exactly one source image.',
                  path: ['sources'],
                });
              }

              if (parameters.alignmentMode !== 'none') {
                context.addIssue({
                  code: 'custom',
                  message: 'Single-image super-resolution must not request multi-frame alignment.',
                  path: ['alignmentMode'],
                });
              }
            }

            if (parameters.mode === 'multi_image') {
              if (parameters.sources.length < 2) {
                context.addIssue({
                  code: 'custom',
                  message: 'Multi-image super-resolution requires at least two source images.',
                  path: ['sources'],
                });
              }

              if (parameters.alignmentMode === 'none') {
                context.addIssue({
                  code: 'custom',
                  message: 'Multi-image super-resolution requires an alignment mode.',
                  path: ['alignmentMode'],
                });
              }
            }
          }),
      })
      .strict(),
  ])
  .superRefine((command, context) => {
    if (command.dryRun) {
      if (command.approval.approvalClass !== ApprovalClass.PreviewOnly) {
        context.addIssue({
          code: 'custom',
          message: 'Dry-run computational merge commands require preview-only approval classification.',
          path: ['approval', 'approvalClass'],
        });
      }

      return;
    }

    if (command.approval.approvalClass !== ApprovalClass.EditApply) {
      context.addIssue({
        code: 'custom',
        message: 'Applied computational merge commands require edit-apply approval classification.',
        path: ['approval', 'approvalClass'],
      });
    }

    if (command.approval.state !== 'approved') {
      context.addIssue({
        code: 'custom',
        message: 'Applied computational merge commands require approved user approval before execution.',
        path: ['approval', 'state'],
      });
    }

    if (
      command.commandType === 'computationalMerge.createSuperResolution' &&
      command.parameters.detailPolicy === 'aggressive_preview_only'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Aggressive super-resolution detail policy is preview-only and cannot be applied.',
        path: ['parameters', 'detailPolicy'],
      });
    }

    if (
      command.commandType === 'computationalMerge.createSuperResolution' &&
      command.parameters.outputScale > 1 &&
      command.parameters.mode === 'multi_image' &&
      command.parameters.alignmentMode === 'none'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Applied super-resolution commands above 1x require an alignment mode.',
        path: ['parameters', 'alignmentMode'],
      });
    }

    if (!command.parameters.acceptedDryRunPlanId) {
      context.addIssue({
        code: 'custom',
        message: 'Applied computational merge commands require an accepted dry-run plan id.',
        path: ['parameters', 'acceptedDryRunPlanId'],
      });
    }

    if (!command.parameters.acceptedDryRunPlanHash) {
      context.addIssue({
        code: 'custom',
        message: 'Applied computational merge commands require an accepted dry-run plan hash.',
        path: ['parameters', 'acceptedDryRunPlanHash'],
      });
    }
  });

export const computationalMergeDryRunResultV1Schema = z
  .object({
    commandId: z.string().trim().min(1),
    commandType: computationalMergeCommandTypeV1Schema,
    correlationId: z.string().trim().min(1),
    dryRun: z.literal(true),
    mergePlan: computationalMergePlanV1Schema,
    mutates: z.literal(false),
    predictedGraphRevision: z.string().trim().min(1),
    previewArtifacts: z.array(artifactHandleV1Schema),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sourceGraphRevision: z.string().trim().min(1),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict();

export const computationalMergeMutationResultV1Schema = z
  .object({
    appliedGraphRevision: z.string().trim().min(1),
    changedNodeIds: z.array(z.string().trim().min(1)),
    commandId: z.string().trim().min(1),
    commandType: computationalMergeCommandTypeV1Schema,
    correlationId: z.string().trim().min(1),
    derivedAssetId: z.string().trim().min(1),
    dryRun: z.literal(false),
    mutates: z.literal(true),
    outputArtifacts: z.array(artifactHandleV1Schema).min(1),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sourceGraphRevision: z.string().trim().min(1),
    undoRevision: z.string().trim().min(1),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict();

export const computationalMergeDerivedSourceReceiptIdentityV1Schema = z
  .object({
    acceptedDryRunPlanHash: z.string().trim().min(1),
    acceptedDryRunPlanId: z.string().trim().min(1),
    family: computationalMergeFamilyV1Schema,
    openInEditorAction: z
      .object({
        path: z.string().trim().min(1).optional(),
        state: z.enum(['available', 'deferred', 'unavailable']),
      })
      .strict(),
    outputArtifactId: z.string().trim().min(1),
    outputContentHash: z.string().trim().min(1),
    outputPath: z.string().trim().min(1).optional(),
    provenanceSidecarPath: z.string().trim().min(1).optional(),
    receiptId: z.string().trim().min(1),
    settingsHash: z.string().trim().min(1),
    sourceGraphRevisions: z.array(z.string().trim().min(1)).min(1),
    staleReasons: z.array(z.string().trim().min(1)).optional(),
    staleState: z.enum(['current', 'stale', 'unknown']),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.openInEditorAction.state === 'available' && receipt.openInEditorAction.path === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Available computational derived-source receipts require an open path.',
        path: ['openInEditorAction', 'path'],
      });
    }
    if (receipt.staleState === 'stale' && (receipt.staleReasons?.length ?? 0) === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Stale computational derived-source receipts require stale reasons.',
        path: ['staleReasons'],
      });
    }
  });

const computationalMergeFamilyForCommandType = (
  commandType: z.infer<typeof computationalMergeCommandTypeV1Schema>,
): z.infer<typeof computationalMergeFamilyV1Schema> => {
  switch (commandType) {
    case 'computationalMerge.createFocusStack':
      return 'focus_stack';
    case 'computationalMerge.createHdr':
      return 'hdr';
    case 'computationalMerge.createPanorama':
      return 'panorama';
    case 'computationalMerge.createSuperResolution':
      return 'super_resolution';
  }
};

export const computationalMergeDerivedSourceOpenRequestV1Schema = z
  .object({
    actor: rawEngineActorSchema,
    approval: approvalRequirementSchema,
    command: computationalMergeCommandEnvelopeV1Schema,
    correlationId: z.string().trim().min(1),
    currentGraphRevision: z.string().trim().min(1),
    mutationResult: computationalMergeMutationResultV1Schema,
    receipt: computationalMergeDerivedSourceReceiptIdentityV1Schema,
    requestId: z.string().trim().min(1),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.approval.approvalClass !== ApprovalClass.EditApply) {
      context.addIssue({
        code: 'custom',
        message: 'Opening computational derived sources requires edit-apply approval classification.',
        path: ['approval', 'approvalClass'],
      });
    }

    if (request.approval.state !== 'approved') {
      context.addIssue({
        code: 'custom',
        message: 'Opening computational derived sources requires approved user approval.',
        path: ['approval', 'state'],
      });
    }

    if (request.command.dryRun) {
      context.addIssue({
        code: 'custom',
        message: 'Computational derived-source open requests must reference an applied command.',
        path: ['command', 'dryRun'],
      });
    }

    if (request.command.commandType !== request.mutationResult.commandType) {
      context.addIssue({
        code: 'custom',
        message: 'Computational derived-source open requests must match the mutation command type.',
        path: ['mutationResult', 'commandType'],
      });
    }

    const family = computationalMergeFamilyForCommandType(request.command.commandType);
    if (request.receipt.family !== family) {
      context.addIssue({
        code: 'custom',
        message: 'Computational derived-source receipt family must match the applied command family.',
        path: ['receipt', 'family'],
      });
    }

    if (request.receipt.acceptedDryRunPlanId !== request.command.parameters.acceptedDryRunPlanId) {
      context.addIssue({
        code: 'custom',
        message: 'Computational derived-source receipt must identify the approved dry-run plan id.',
        path: ['receipt', 'acceptedDryRunPlanId'],
      });
    }

    if (request.receipt.acceptedDryRunPlanHash !== request.command.parameters.acceptedDryRunPlanHash) {
      context.addIssue({
        code: 'custom',
        message: 'Computational derived-source receipt must identify the approved dry-run plan hash.',
        path: ['receipt', 'acceptedDryRunPlanHash'],
      });
    }

    if (request.receipt.staleState !== 'current') {
      context.addIssue({
        code: 'custom',
        message: 'Computational derived-source receipts must be current before apply/open mutation.',
        path: ['receipt', 'staleState'],
      });
    }

    if (request.currentGraphRevision !== request.mutationResult.appliedGraphRevision) {
      context.addIssue({
        code: 'custom',
        message: 'Computational derived-source open requests require the current graph revision to match apply output.',
        path: ['currentGraphRevision'],
      });
    }

    if (request.receipt.outputArtifactId !== request.mutationResult.derivedAssetId) {
      context.addIssue({
        code: 'custom',
        message: 'Computational derived-source receipt output artifact must match the applied derived asset.',
        path: ['receipt', 'outputArtifactId'],
      });
    }

    if (
      !request.mutationResult.outputArtifacts.some(
        (artifact) => artifact.contentHash === request.receipt.outputContentHash,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Computational derived-source receipt output hash must match an applied output artifact.',
        path: ['receipt', 'outputContentHash'],
      });
    }

    if (request.receipt.openInEditorAction.state !== 'available') {
      context.addIssue({
        code: 'custom',
        message: 'Computational derived-source receipts must expose an available open action.',
        path: ['receipt', 'openInEditorAction', 'state'],
      });
    }
  });

export const computationalMergeDerivedSourceOpenResultV1Schema = z
  .object({
    appliedGraphRevision: z.string().trim().min(1),
    derivedSourceId: z.string().trim().min(1),
    family: computationalMergeFamilyV1Schema,
    mutates: z.literal(true),
    openPath: z.string().trim().min(1),
    outputArtifactId: z.string().trim().min(1),
    provenanceSidecarPath: z.string().trim().min(1).optional(),
    receiptId: z.string().trim().min(1),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sourceMutationCommandId: z.string().trim().min(1),
  })
  .strict();

export const hdrCapabilityLevelV1Schema = z.enum(['schema_only', 'plan_only', 'dry_run_only', 'runtime_apply_capable']);

export const hdrMergeWarningCodeV1Schema = z.enum([
  'alignment_cropped_edges',
  'alignment_low_confidence',
  'bracket_order_inferred',
  'bracket_spacing_irregular',
  'camera_or_lens_mismatch',
  'capture_time_gap_large',
  'clipped_reference_frame',
  'deghost_mask_generated',
  'dimensions_match_but_raw_geometry_unverified',
  'exposure_metadata_missing',
  'high_memory_estimate',
  'highlight_recovery_limited',
  'human_review_required',
  'iso_metadata_missing',
  'legacy_full_frame_render',
  'motion_detected',
  'noise_risk_in_shadow_recovery',
  'runtime_estimate_high',
  'tone_mapped_preview_only',
  'white_balance_mismatch',
]);

export const hdrMergeBlockCodeV1Schema = z.enum([
  'alignment_failed',
  'apply_requires_accepted_dry_run',
  'apply_requires_approval',
  'dimension_mismatch',
  'duplicate_exposure_values',
  'memory_budget_exceeded',
  'missing_required_exposure_metadata',
  'not_a_bracket',
  'raw_geometry_mismatch',
  'runtime_not_available',
  'source_count_too_low',
  'source_files_unreadable',
  'unsupported_source_format',
]);

export const hdrBracketDetectionMethodV1Schema = z.enum([
  'caller_declared_ev',
  'luminance_estimate',
  'manual_order',
  'metadata_exposure_compensation',
  'metadata_exposure_time_iso_aperture',
]);

export const hdrMotionRiskV1Schema = z.enum(['none', 'low', 'medium', 'high']);

export const hdrDeghostingModeV1Schema = z.enum(['off', 'low', 'medium', 'high']);

export const hdrMaskArtifactKindV1Schema = z.enum(['deghost_selection', 'motion_probability', 'rejected_pixel_map']);

export const hdrMergeInvalidationReasonV1Schema = z.enum([
  'alignment_settings_changed',
  'bracket_metadata_changed',
  'deghosting_settings_changed',
  'engine_version_changed',
  'merge_strategy_changed',
  'output_artifact_changed',
  'source_content_hash_changed',
  'source_graph_revision_changed',
  'source_order_changed',
  'source_set_changed',
  'tone_map_preview_settings_changed',
]);

export const hdrMergeStaleStateV1Schema = z.enum(['current', 'stale', 'unknown']);

export const hdrBracketSourceMetadataV1Schema = z
  .object({
    aperture: z.number().positive().optional(),
    bitDepth: z.number().int().positive().optional(),
    cameraMake: z.string().trim().min(1).optional(),
    cameraModel: z.string().trim().min(1).optional(),
    captureTimestamp: z.iso.datetime({ offset: true }).optional(),
    cfaPattern: z.string().trim().min(1).optional(),
    contentHash: z.string().trim().min(1).optional(),
    cropFactor: z.number().positive().optional(),
    declaredExposureEv: z.number().optional(),
    exposureCompensationEv: z.number().optional(),
    exposureTimeSeconds: z.number().positive().optional(),
    focalLengthMm: z.number().positive().optional(),
    graphRevision: z.string().trim().min(1).optional(),
    height: z.number().int().positive(),
    imageId: z.string().trim().min(1).optional(),
    imagePath: z.string().trim().min(1),
    iso: z.number().positive().optional(),
    lensModel: z.string().trim().min(1).optional(),
    lensProfileId: z.string().trim().min(1).optional(),
    rawActiveArea: z
      .object({
        height: z.number().int().positive(),
        width: z.number().int().positive(),
        x: z.number().int().nonnegative(),
        y: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    rawBlackLevelKnown: z.boolean(),
    rawOrientation: z.enum(['normal', 'rotated_90', 'rotated_180', 'rotated_270']).optional(),
    rawWhiteLevelKnown: z.boolean(),
    resolvedBracketRole: z.enum(['over_exposed', 'reference', 'under_exposed', 'unknown']),
    resolvedExposureEv: z.number(),
    sourceIndex: z.number().int().nonnegative(),
    virtualCopyId: z.string().trim().min(1).nullable().optional(),
    whiteBalanceComparable: z.boolean(),
    width: z.number().int().positive(),
  })
  .strict();

export const hdrBracketDetectionResultV1Schema = z
  .object({
    accepted: z.boolean(),
    blockCodes: z.array(hdrMergeBlockCodeV1Schema),
    bracketSpanEv: z.number().nonnegative(),
    detectionConfidence: z.number().min(0).max(1),
    detectionMethod: hdrBracketDetectionMethodV1Schema,
    referenceSourceIndex: z.number().int().nonnegative(),
    sourceMetadata: z.array(hdrBracketSourceMetadataV1Schema).min(2),
    warningCodes: z.array(hdrMergeWarningCodeV1Schema),
  })
  .strict()
  .superRefine((detection, context) => {
    const sourceIndexes = new Set(detection.sourceMetadata.map((source) => source.sourceIndex));
    if (!sourceIndexes.has(detection.referenceSourceIndex)) {
      context.addIssue({
        code: 'custom',
        message: 'HDR bracket referenceSourceIndex must reference a source metadata entry.',
        path: ['referenceSourceIndex'],
      });
    }

    const exposureValues = new Set(detection.sourceMetadata.map((source) => source.resolvedExposureEv));
    if (detection.accepted && exposureValues.size < 2) {
      context.addIssue({
        code: 'custom',
        message: 'Accepted HDR bracket detection requires at least two distinct resolved exposure values.',
        path: ['sourceMetadata'],
      });
    }

    if (detection.accepted && detection.blockCodes.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'Accepted HDR bracket detection must not include block codes.',
        path: ['blockCodes'],
      });
    }

    if (!detection.accepted && detection.blockCodes.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Rejected HDR bracket detection requires at least one block code.',
        path: ['blockCodes'],
      });
    }
  });

export const hdrAlignmentTransformV1Schema = z
  .object({
    confidence: z.number().min(0).max(1),
    cropBounds: computationalMergeProjectedBoundsV1Schema.optional(),
    inlierRatio: z.number().min(0).max(1).optional(),
    matrix3x3: z.array(z.number()).length(9).optional(),
    sourceIndex: z.number().int().nonnegative(),
    transformType: z.enum(['homography', 'identity', 'similarity', 'translation']),
    translationPx: z
      .object({
        x: z.number(),
        y: z.number(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const hdrAlignmentSummaryV1Schema = z
  .object({
    alignmentConfidence: z.number().min(0).max(1),
    referenceSourceIndex: z.number().int().nonnegative(),
    rejectedSourceIndexes: z.array(z.number().int().nonnegative()),
    requestedAlignmentMode: computationalMergeAlignmentModeV1Schema,
    resolvedAlignmentMode: computationalMergeAlignmentModeV1Schema,
    transforms: z.array(hdrAlignmentTransformV1Schema).min(2),
  })
  .strict()
  .superRefine((alignment, context) => {
    const transformIndexes = new Set(alignment.transforms.map((transform) => transform.sourceIndex));
    if (!transformIndexes.has(alignment.referenceSourceIndex)) {
      context.addIssue({
        code: 'custom',
        message: 'HDR alignment referenceSourceIndex must reference a transform source.',
        path: ['referenceSourceIndex'],
      });
    }

    for (const [index, rejectedSourceIndex] of alignment.rejectedSourceIndexes.entries()) {
      if (!transformIndexes.has(rejectedSourceIndex)) {
        context.addIssue({
          code: 'custom',
          message: 'HDR rejected alignment source indexes must reference a transform source.',
          path: ['rejectedSourceIndexes', index],
        });
      }
    }
  });

export const hdrMaskArtifactV1Schema = z
  .object({
    artifact: artifactHandleV1Schema,
    encodedMeaning: z.enum(['f32_probability', 'u8_0_255_probability', 'u8_binary']),
    height: z.number().int().positive(),
    kind: hdrMaskArtifactKindV1Schema,
    sourceIndexes: z.array(z.number().int().nonnegative()).min(1),
    width: z.number().int().positive(),
  })
  .strict();

export const hdrDeghostingSummaryV1Schema = z
  .object({
    confidenceMapVisible: z.boolean().optional(),
    masks: z.array(hdrMaskArtifactV1Schema),
    motionCoverageRatio: z.number().min(0).max(1),
    motionRisk: hdrMotionRiskV1Schema,
    referenceSourceIndex: z.number().int().nonnegative(),
    regionIntensityPercent: z.number().int().min(0).max(100).optional(),
    requestedDeghosting: hdrDeghostingModeV1Schema,
    resolvedDeghosting: hdrDeghostingModeV1Schema,
  })
  .strict();

export const hdrHighlightRecoveryMetricsV1Schema = z
  .object({
    clippedInputPixelRatioBySource: z
      .array(
        z
          .object({
            clippedHighRatio: z.number().min(0).max(1),
            nearClippedHighRatio: z.number().min(0).max(1),
            sourceIndex: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(2),
    highlightDetailGainRatio: z.number().nonnegative(),
    recoveredHighlightPixelRatio: z.number().min(0).max(1),
    shadowNoiseAmplificationRisk: z.enum(['high', 'low', 'medium', 'unknown']),
    unrecoveredClippedPixelRatio: z.number().min(0).max(1),
  })
  .strict();

const hdrSourceStateV1Schema = z
  .object({
    contentHash: z.string().trim().min(1),
    exposureWeightMultiplier: z.number().positive().optional(),
    graphRevision: z.string().trim().min(1),
    resolvedExposureEv: z.number(),
    sourceIndex: z.number().int().nonnegative(),
  })
  .strict();

const validateHdrSourceState = (
  sourceImageRefs: Array<ComputationalMergeSourceImageRefV1>,
  sourceStates: Array<z.infer<typeof hdrSourceStateV1Schema>>,
  context: z.RefinementCtx,
  path: Array<string | number>,
) => {
  validateSourceStateCoverage({
    context,
    coverageMessage: 'HDR source state entries must cover every source image.',
    path,
    referenceMessage: 'HDR source state entries must reference sourceImageRefs.',
    sourceImageRefs,
    sourceStates,
    uniqueMessage: 'HDR source state entries require unique source indexes.',
  });
};

export const hdrRuntimeSidecarReceiptV1Schema = z
  .object({
    acceptedDryRunPlanHash: z.string().trim().min(1).optional(),
    acceptedDryRunPlanId: z.string().trim().min(1).optional(),
    alignment: z
      .object({
        confidence: z.number().min(0).max(1),
        maxRmsError: z.number().nonnegative(),
        mode: computationalMergeAlignmentModeV1Schema,
        transformCount: z.number().int().positive(),
      })
      .strict(),
    bracket: z
      .object({
        accepted: z.boolean(),
        detectionConfidence: z.number().min(0).max(1),
        exposureSpreadEv: z.number().nonnegative(),
        referenceSourceIndex: z.number().int().nonnegative(),
        sourceCount: z.number().int().min(2),
        sourceRoles: z
          .array(
            z
              .object({
                exposureEv: z.number(),
                role: z.enum(['over_exposed', 'reference', 'under_exposed']),
                sourceIndex: z.number().int().nonnegative(),
              })
              .strict(),
          )
          .min(2),
      })
      .strict(),
    deghost: z
      .object({
        averageConfidence: z.number().min(0).max(1),
        maskArtifacts: z.array(hdrMaskArtifactV1Schema).optional(),
        maxConfidence: z.number().min(0).max(1),
        motionCoverageRatio: z.number().min(0).max(1),
        motionPixelCount: z.number().int().nonnegative(),
        regionIntensityPercent: z.number().int().min(0).max(100),
        requestedDeghosting: hdrDeghostingModeV1Schema,
      })
      .strict(),
    handoff: z
      .object({
        editableDerivedAssetId: z.string().trim().min(1),
        openInEditorPath: z.string().trim().min(1).optional(),
        route: z.literal('computational_merge_derived_source'),
      })
      .strict(),
    mergeMethod: z.string().trim().min(1).optional(),
    mergeVersion: z.string().trim().min(1).optional(),
    measurementSource: z.literal('hdr_runtime_apply'),
    output: z
      .object({
        artifactId: z.string().trim().min(1),
        contentHash: z.string().trim().min(1),
        dimensions: z
          .object({
            height: z.number().int().positive(),
            width: z.number().int().positive(),
          })
          .strict(),
      })
      .strict(),
    receiptKind: z.literal('hdr_runtime_sidecar_receipt'),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    warningCodes: z.array(hdrMergeWarningCodeV1Schema).optional(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.bracket.sourceRoles.length !== receipt.bracket.sourceCount) {
      context.addIssue({
        code: 'custom',
        message: 'HDR runtime sidecar receipt source role count must match bracket source count.',
        path: ['bracket', 'sourceRoles'],
      });
    }
  });

export const hdrMergeArtifactV1Schema = z
  .object({
    alignment: hdrAlignmentSummaryV1Schema,
    artifactId: z.string().trim().min(1),
    blockCodes: z.array(hdrMergeBlockCodeV1Schema),
    bracketDetection: hdrBracketDetectionResultV1Schema,
    createdAt: z.iso.datetime({ offset: true }),
    deghosting: hdrDeghostingSummaryV1Schema,
    dryRun: z
      .object({
        acceptedDryRunPlanHash: z.string().trim().min(1),
        acceptedDryRunPlanId: z.string().trim().min(1),
      })
      .strict(),
    editableDerivedAssetId: z.string().trim().min(1).optional(),
    engine: z
      .object({
        backendType: z.enum(['legacy_image_hdr', 'local_cpu', 'local_gpu', 'schema_only']),
        capabilityLevel: hdrCapabilityLevelV1Schema,
        engineId: z.string().trim().min(1),
        engineVersion: z.string().trim().min(1),
      })
      .strict(),
    family: z.literal('hdr'),
    highlightRecovery: hdrHighlightRecoveryMetricsV1Schema,
    mergeStrategy: z.enum(['exposure_fusion_preview', 'scene_linear_radiance']),
    outputArtifact: artifactHandleV1Schema,
    outputColorSpace: z.string().trim().min(1),
    outputEncoding: z.enum(['display_referred_preview', 'scene_linear_float', 'scene_linear_half_float']),
    outputName: z.string().trim().min(1),
    previewArtifacts: z.array(artifactHandleV1Schema),
    previewToneMapped: z.boolean(),
    runtimeSidecarReceipt: hdrRuntimeSidecarReceiptV1Schema.optional(),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sourceImageRefs: z.array(computationalMergeSourceImageRefV1Schema).min(2),
    sourceState: z.array(hdrSourceStateV1Schema).min(2),
    staleState: z
      .object({
        checkedAt: z.iso.datetime({ offset: true }).optional(),
        invalidationReasons: z.array(hdrMergeInvalidationReasonV1Schema),
        state: hdrMergeStaleStateV1Schema,
      })
      .strict(),
    warningCodes: z.array(hdrMergeWarningCodeV1Schema),
    workingColorSpace: z.string().trim().min(1),
  })
  .strict()
  .superRefine((artifact, context) => {
    for (const [sourceIndex, source] of artifact.sourceImageRefs.entries()) {
      if (source.role !== 'hdr_bracket') {
        context.addIssue({
          code: 'custom',
          message: 'HDR artifacts require every source to use the hdr_bracket role.',
          path: ['sourceImageRefs', sourceIndex, 'role'],
        });
      }
    }

    if (artifact.outputArtifact.kind !== 'merge_output' || artifact.outputArtifact.storage !== 'sidecar_artifact') {
      context.addIssue({
        code: 'custom',
        message: 'HDR artifacts must reference a durable merge output sidecar artifact.',
        path: ['outputArtifact'],
      });
    }

    if (artifact.mergeStrategy === 'scene_linear_radiance' && artifact.outputEncoding === 'display_referred_preview') {
      context.addIssue({
        code: 'custom',
        message: 'Scene-linear HDR artifacts must not store only display-referred preview output.',
        path: ['outputEncoding'],
      });
    }

    if (artifact.staleState.state === 'current' && artifact.staleState.invalidationReasons.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'Current HDR artifacts must not include invalidation reasons.',
        path: ['staleState', 'invalidationReasons'],
      });
    }

    if (artifact.staleState.state === 'stale' && artifact.staleState.invalidationReasons.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Stale HDR artifacts require invalidation reasons.',
        path: ['staleState', 'invalidationReasons'],
      });
    }

    if (artifact.blockCodes.length > 0 && artifact.engine.capabilityLevel === 'runtime_apply_capable') {
      context.addIssue({
        code: 'custom',
        message: 'Runtime-apply-capable HDR artifacts must not include apply-blocking codes.',
        path: ['blockCodes'],
      });
    }

    validateHdrSourceState(artifact.sourceImageRefs, artifact.sourceState, context, ['sourceState']);
  });

export const negativeLabSampleRectV1Schema = z
  .object({
    height: z.number().positive(),
    width: z.number().positive(),
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
  })
  .strict();

export const negativeLabDensityRgbV1Schema = z
  .object({
    b: z.number().min(0).max(4),
    g: z.number().min(0).max(4),
    r: z.number().min(0).max(4),
  })
  .strict();

export const negativeLabRollFrameRoleV1Schema = z.enum(['base_fog_anchor', 'color_balance_anchor', 'density_anchor']);

export const negativeLabRollSessionArtifactV1Schema = z
  .object({
    anchorFrames: z
      .array(
        z
          .object({
            frameId: z.string().trim().min(1),
            path: z.string().trim().min(1),
            role: negativeLabRollFrameRoleV1Schema,
          })
          .strict(),
      )
      .min(1),
    appServerCommandVisibility: z
      .object({
        applyToolName: z.literal('negativelab.apply_planned_command'),
        commandNames: z
          .array(
            z.enum([
              'negative.lab.accept_batch_dry_run_plan',
              'negative.lab.build_accepted_batch_apply',
              'negative.lab.build_batch_dry_run_summary',
              'negative.lab.build_conversion_plan',
              'negative.lab.build_frame_health_report',
              'negative.lab.build_qc_proof_report',
            ]),
          )
          .min(1),
        previewToolName: z.literal('negativelab.preview_conversion'),
      })
      .strict(),
    createdAt: z.iso.datetime({ offset: true }),
    family: z.literal('negative_lab_roll_session'),
    migrationPolicy: z
      .object({
        currentShape: z.literal('negative_lab_roll_session_v1'),
        forwardCompatibleRead: z.literal(true),
        migrationNotes: z.array(z.string().trim().min(1)),
        preserveUnknownFields: z.literal(true),
      })
      .strict(),
    mutationSafety: z
      .object({
        acceptedDryRunPlanHash: z.string().regex(/^fnv1a32:[a-f0-9]{8}$/u),
        acceptedDryRunPlanId: z.string().regex(/^negative_lab_batch_plan_[a-f0-9]{8}$/u),
        requiresAcceptedDryRunPlan: z.literal(true),
      })
      .strict(),
    perFrameOverrides: z
      .array(
        z
          .object({
            baseFogSampleId: z.string().trim().min(1).nullable(),
            exposureOffsetStops: z.number().min(-5).max(5),
            frameId: z.string().trim().min(1),
            path: z.string().trim().min(1),
            presetId: z.string().trim().min(1),
          })
          .strict(),
      )
      .min(1),
    positiveVariantProvenance: z
      .array(
        z
          .object({
            acceptedDryRunPlanHash: z.string().regex(/^fnv1a32:[a-f0-9]{8}$/u),
            acceptedDryRunPlanId: z.string().regex(/^negative_lab_batch_plan_[a-f0-9]{8}$/u),
            commandId: z.string().trim().min(1),
            outputArtifactId: z.string().trim().min(1),
            sourceFrameId: z.string().trim().min(1),
            variantId: z.string().trim().min(1),
          })
          .strict(),
      )
      .min(1),
    rollId: z.string().regex(/^negative_lab_roll_[a-z0-9_]+$/u),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sessionId: z.string().regex(/^negative_lab_session_[a-z0-9_]+$/u),
    sharedBaseFogSamples: z
      .array(
        z
          .object({
            confidence: z.number().min(0).max(1),
            densityRgb: negativeLabDensityRgbV1Schema,
            frameId: z.string().trim().min(1).nullable(),
            rect: negativeLabSampleRectV1Schema,
            sampleId: z.string().trim().min(1),
          })
          .strict(),
      )
      .min(1),
    sourceImagePaths: z.array(z.string().trim().min(1)).min(1),
  })
  .strict()
  .superRefine((session, context) => {
    const sourcePaths = new Set(session.sourceImagePaths);
    const sampleIds = new Set(session.sharedBaseFogSamples.map((sample) => sample.sampleId));
    const frameIds = new Set(session.perFrameOverrides.map((frame) => frame.frameId));

    for (const [index, frame] of session.perFrameOverrides.entries()) {
      if (!sourcePaths.has(frame.path)) {
        context.addIssue({
          code: 'custom',
          message: 'Negative Lab frame overrides must reference a source image path.',
          path: ['perFrameOverrides', index, 'path'],
        });
      }

      if (frame.baseFogSampleId !== null && !sampleIds.has(frame.baseFogSampleId)) {
        context.addIssue({
          code: 'custom',
          message: 'Negative Lab frame overrides must reference a shared base/fog sample.',
          path: ['perFrameOverrides', index, 'baseFogSampleId'],
        });
      }
    }

    for (const [index, anchor] of session.anchorFrames.entries()) {
      if (!frameIds.has(anchor.frameId) || !sourcePaths.has(anchor.path)) {
        context.addIssue({
          code: 'custom',
          message: 'Negative Lab anchor frames must reference persisted roll frames.',
          path: ['anchorFrames', index],
        });
      }
    }

    for (const [index, variant] of session.positiveVariantProvenance.entries()) {
      if (!frameIds.has(variant.sourceFrameId)) {
        context.addIssue({
          code: 'custom',
          message: 'Negative Lab positive variants must reference persisted roll frames.',
          path: ['positiveVariantProvenance', index, 'sourceFrameId'],
        });
      }

      if (
        variant.acceptedDryRunPlanId !== session.mutationSafety.acceptedDryRunPlanId ||
        variant.acceptedDryRunPlanHash !== session.mutationSafety.acceptedDryRunPlanHash
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Negative Lab positive variants require the accepted dry-run identity.',
          path: ['positiveVariantProvenance', index],
        });
      }
    }
  });

export const focusStackBlendMethodV1Schema = z.enum(['depth_map', 'laplacian_pyramid', 'weighted_sharpness']);

export const focusStackRetouchLayerPolicyV1Schema = z.enum(['none', 'generate_retouch_layer']);

export const focusStackWarningCodeV1Schema = z.enum([
  'alignment_low_confidence',
  'focus_coverage_low',
  'high_memory_estimate',
  'human_review_required',
  'parallax_detected',
  'retouch_layer_required',
  'runtime_estimate_high',
  'source_order_unverified',
]);

export const focusStackInvalidationReasonV1Schema = z.enum([
  'alignment_settings_changed',
  'blend_method_changed',
  'engine_version_changed',
  'output_artifact_changed',
  'retouch_layer_changed',
  'source_content_hash_changed',
  'source_graph_revision_changed',
  'source_order_changed',
  'source_set_changed',
]);

export const focusStackStaleStateV1Schema = z.enum(['current', 'stale', 'unknown']);

const focusStackRetouchSeedReasonCodeV1Schema = z.enum([
  'focus_coverage_low',
  'halo_risk',
  'low_confidence',
  'retouch_layer_required',
  'retouch_recommended',
]);

const focusStackRetouchSeedStateV1Schema = z.enum(['current', 'stale', 'unknown']);

const focusStackRetouchSeedMaskRegionV1Schema = z
  .object({
    cellCount: z.number().int().positive(),
    regionId: z.string().trim().min(1),
    risk: z.enum(['halo_risk', 'low_confidence', 'retouch_recommended']),
    sourceIndex: z.number().int().nonnegative(),
  })
  .strict();

const focusStackRetouchSeedSourceCandidateV1Schema = z
  .object({
    contentHash: z.string().trim().min(1),
    coverageCellCount: z.number().int().positive(),
    graphRevision: z.string().trim().min(1),
    path: z.string().trim().min(1),
    regionIds: z.array(z.string().trim().min(1)).min(1),
    sourceIndex: z.number().int().nonnegative(),
  })
  .strict();

const focusStackRetouchSeedV1Schema = z
  .object({
    acceptedDryRunPlanHash: z.string().trim().min(1),
    acceptedDryRunPlanId: z.string().trim().min(1),
    artifactId: z.string().trim().min(1),
    availability: z.enum(['available', 'unavailable']),
    maskRegions: z.array(focusStackRetouchSeedMaskRegionV1Schema).min(1),
    outputContentHash: z.string().trim().min(1),
    previewContentHash: z.string().trim().min(1),
    reasonCodes: z.array(focusStackRetouchSeedReasonCodeV1Schema).min(1),
    sourceCandidates: z.array(focusStackRetouchSeedSourceCandidateV1Schema).min(1),
    staleReasons: z.array(focusStackRetouchSeedReasonCodeV1Schema),
    staleState: focusStackRetouchSeedStateV1Schema,
  })
  .strict();

const focusStackSourceStateV1Schema = z
  .object({
    contentHash: z.string().trim().min(1),
    focusDistanceMm: z.number().positive().optional(),
    graphRevision: z.string().trim().min(1),
    sourceIndex: z.number().int().nonnegative(),
  })
  .strict();

const validateFocusStackSourceState = (
  sourceImageRefs: Array<ComputationalMergeSourceImageRefV1>,
  sourceStates: Array<z.infer<typeof focusStackSourceStateV1Schema>>,
  context: z.RefinementCtx,
  path: Array<string | number>,
) => {
  validateSourceStateCoverage({
    context,
    coverageMessage: 'Focus stack source state entries must cover every source image.',
    path,
    referenceMessage: 'Focus stack source state entry must reference a source image index.',
    sourceImageRefs,
    sourceStates,
    uniqueMessage: 'Focus stack source state entries require unique source indexes.',
  });
};

const focusStackSharpnessSettingsV1Schema = z
  .object({
    cellCount: z.number().int().positive(),
    lowConfidenceCellCount: z.number().int().nonnegative(),
    lowConfidenceWeightFloor: z.number().min(0).max(1),
    weightPower: z.number().positive(),
  })
  .strict();

const focusStackBreathingCompensationV1Schema = z
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

const focusStackExportParityHashV1Schema = z.string().regex(/^fnv1a32:[a-f0-9]{8}$/u);

const focusStackRetouchedExportParityV1Schema = z
  .object({
    comparedFields: z.array(
      z.enum([
        'acceptedDryRunPlan',
        'outputArtifact',
        'retouchLayerArtifact',
        'retouchLayerPolicy',
        'sharpnessSettings',
        'sourceState',
      ]),
    ),
    exportReceiptHash: focusStackExportParityHashV1Schema,
    meanAbsDelta: z.literal(0),
    parityProofHash: focusStackExportParityHashV1Schema,
    previewStateHash: focusStackExportParityHashV1Schema,
    status: z.literal('matched_retouched_sidecar_output'),
  })
  .strict();

export const focusStackArtifactV1Schema = z
  .object({
    artifactId: z.string().trim().min(1),
    blendMethod: focusStackBlendMethodV1Schema,
    createdAt: z.iso.datetime({ offset: true }),
    depthConfidenceMapArtifact: artifactHandleV1Schema.optional(),
    dryRun: z
      .object({
        acceptedDryRunPlanHash: z.string().trim().min(1),
        acceptedDryRunPlanId: z.string().trim().min(1),
      })
      .strict(),
    engine: z
      .object({
        backendType: z.enum(['local_cpu', 'local_gpu', 'schema_only']),
        engineId: z.string().trim().min(1),
        engineVersion: z.string().trim().min(1),
      })
      .strict(),
    family: z.literal('focus_stack'),
    focusBreathingCompensation: focusStackBreathingCompensationV1Schema.optional(),
    outputArtifact: artifactHandleV1Schema,
    outputColorSpace: z.string().trim().min(1),
    previewArtifacts: z.array(artifactHandleV1Schema),
    haloMapArtifact: artifactHandleV1Schema.optional(),
    retouchedExportParity: focusStackRetouchedExportParityV1Schema.optional(),
    retouchSeed: focusStackRetouchSeedV1Schema.optional(),
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
      .strict()
      .optional(),
    qualityPreference: computationalMergeQualityPreferenceV1Schema,
    requestedAlignmentMode: computationalMergeAlignmentModeV1Schema,
    resolvedAlignmentMode: computationalMergeAlignmentModeV1Schema,
    retouchLayerArtifact: artifactHandleV1Schema.optional(),
    retouchLayerPolicy: focusStackRetouchLayerPolicyV1Schema,
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sharpnessMapArtifact: artifactHandleV1Schema.optional(),
    sharpnessSettings: focusStackSharpnessSettingsV1Schema,
    sourceImageRefs: z.array(computationalMergeSourceImageRefV1Schema).min(2),
    sourceState: z.array(focusStackSourceStateV1Schema).min(2),
    staleState: z
      .object({
        checkedAt: z.iso.datetime({ offset: true }).optional(),
        invalidationReasons: z.array(focusStackInvalidationReasonV1Schema),
        state: focusStackStaleStateV1Schema,
      })
      .strict(),
    validationSummary: z
      .object({
        actualPeakMemoryBytes: z.number().int().nonnegative().optional(),
        actualRuntimeMs: z.number().int().nonnegative().optional(),
        alignmentConfidence: z.number().min(0).max(1).optional(),
        focusCoverageRatio: z.number().min(0).max(1),
        parallaxRisk: z.enum(['unknown', 'low', 'medium', 'high']),
        rejectedSourceIndexes: z.array(z.number().int().nonnegative()),
        retouchRequired: z.boolean(),
        sourceCount: z.number().int().positive(),
      })
      .strict(),
    warningCodes: z.array(focusStackWarningCodeV1Schema),
  })
  .strict()
  .superRefine((artifact, context) => {
    for (const [sourceIndex, source] of artifact.sourceImageRefs.entries()) {
      if (source.role !== 'focus_slice') {
        context.addIssue({
          code: 'custom',
          message: 'Focus stack artifacts require every source to use the focus_slice role.',
          path: ['sourceImageRefs', sourceIndex, 'role'],
        });
      }
    }

    if (artifact.outputArtifact.kind !== 'merge_output' || artifact.outputArtifact.storage !== 'sidecar_artifact') {
      context.addIssue({
        code: 'custom',
        message: 'Focus stack artifacts must reference a durable merge output sidecar artifact.',
        path: ['outputArtifact'],
      });
    }

    if (artifact.retouchLayerPolicy === 'generate_retouch_layer' && artifact.retouchLayerArtifact === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Generated focus stack retouch layers require a retouchLayerArtifact.',
        path: ['retouchLayerArtifact'],
      });
    }

    if (artifact.retouchLayerPolicy === 'none' && artifact.retouchLayerArtifact !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Focus stack artifacts without retouch layers must not include retouchLayerArtifact.',
        path: ['retouchLayerArtifact'],
      });
    }

    if (artifact.staleState.state === 'current' && artifact.staleState.invalidationReasons.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'Current focus stack artifacts must not include invalidation reasons.',
        path: ['staleState', 'invalidationReasons'],
      });
    }

    if (artifact.staleState.state === 'stale' && artifact.staleState.invalidationReasons.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Stale focus stack artifacts require invalidation reasons.',
        path: ['staleState', 'invalidationReasons'],
      });
    }

    if (artifact.validationSummary.sourceCount !== artifact.sourceImageRefs.length) {
      context.addIssue({
        code: 'custom',
        message: 'Focus stack validation sourceCount must match sourceImageRefs length.',
        path: ['validationSummary', 'sourceCount'],
      });
    }

    const sourceIndexes = new Set(artifact.sourceImageRefs.map((source) => source.sourceIndex));
    for (const [index, rejectedSourceIndex] of artifact.validationSummary.rejectedSourceIndexes.entries()) {
      if (!sourceIndexes.has(rejectedSourceIndex)) {
        context.addIssue({
          code: 'custom',
          message: 'Rejected focus stack source indexes must reference a source image.',
          path: ['validationSummary', 'rejectedSourceIndexes', index],
        });
      }
    }

    validateFocusStackSourceState(artifact.sourceImageRefs, artifact.sourceState, context, ['sourceState']);
  });

const superResolutionSourceStateV1Schema = z
  .object({
    contentHash: z.string().trim().min(1),
    graphRevision: z.string().trim().min(1),
    sourceIndex: z.number().int().nonnegative(),
  })
  .strict();

const validateSuperResolutionSourceState = (
  sourceImageRefs: Array<ComputationalMergeSourceImageRefV1>,
  sourceStates: Array<z.infer<typeof superResolutionSourceStateV1Schema>>,
  context: z.RefinementCtx,
  path: Array<string | number>,
) => {
  validateSourceStateCoverage({
    context,
    coverageMessage: 'Super-resolution source state entries must cover every source image.',
    path,
    referenceMessage: 'Super-resolution source state entries must reference sourceImageRefs.',
    sourceImageRefs,
    sourceStates,
    uniqueMessage: 'Super-resolution source state entries require unique source indexes.',
  });
};

const validateUniqueSuperResolutionSourceState = (
  sourceStates: Array<z.infer<typeof superResolutionSourceStateV1Schema>>,
  context: z.RefinementCtx,
  path: Array<string | number>,
) => {
  const stateIndexes = new Set<number>();

  for (const [index, sourceState] of sourceStates.entries()) {
    if (stateIndexes.has(sourceState.sourceIndex)) {
      context.addIssue({
        code: 'custom',
        message: 'Super-resolution source state entries require unique source indexes.',
        path: [...path, index, 'sourceIndex'],
      });
    }

    stateIndexes.add(sourceState.sourceIndex);
  }
};

export const superResolutionDryRunSummaryV1Schema = z
  .object({
    blockCodes: z.array(superResolutionBlockCodeV1Schema),
    commandId: z.string().trim().min(1),
    decisionStatus: superResolutionDecisionStatusV1Schema,
    detailPolicy: superResolutionDetailPolicyV1Schema,
    effectiveOutputScale: z.number().min(1).max(4),
    estimatedOutputDimensions: computationalMergeOutputDimensionsV1Schema,
    humanReviewStatus: superResolutionReviewStatusV1Schema,
    localConfidenceMapArtifact: artifactHandleV1Schema.optional(),
    planHash: z.string().trim().min(1),
    planId: z.string().trim().min(1),
    qualityPreference: computationalMergeQualityPreferenceV1Schema,
    requestedAlignmentMode: computationalMergeAlignmentModeV1Schema,
    requestedOutputScale: z.number().min(1.1).max(4),
    resolvedAlignmentMode: computationalMergeAlignmentModeV1Schema,
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sourceState: z.array(superResolutionSourceStateV1Schema).min(2),
    validationSummary: z
      .object({
        alignmentConfidence: z.number().min(0).max(1).optional(),
        expectedDetailGainRatio: z.number().positive().optional(),
        falseDetailRisk: z.enum(['unknown', 'low', 'medium', 'high']),
        overlapCoverageRatio: z.number().min(0).max(1).optional(),
        sourceCount: z.number().int().positive(),
      })
      .strict(),
    warningCodes: z.array(superResolutionWarningCodeV1Schema),
  })
  .strict()
  .superRefine((summary, context) => {
    validateUniqueSuperResolutionSourceState(summary.sourceState, context, ['sourceState']);

    if (summary.effectiveOutputScale > summary.requestedOutputScale) {
      context.addIssue({
        code: 'custom',
        message: 'Effective SR scale cannot exceed requested scale.',
        path: ['effectiveOutputScale'],
      });
    }

    if (summary.decisionStatus === 'eligible_for_apply' && summary.blockCodes.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'Eligible SR dry-run summaries must not include block codes.',
        path: ['blockCodes'],
      });
    }

    if (summary.decisionStatus === 'blocked' && summary.blockCodes.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Blocked SR dry-run summaries require at least one block code.',
        path: ['blockCodes'],
      });
    }

    if (
      summary.decisionStatus === 'downgraded' &&
      !summary.warningCodes.includes('effective_scale_downgraded') &&
      summary.effectiveOutputScale < summary.requestedOutputScale
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Downgraded SR summaries require the effective_scale_downgraded warning code.',
        path: ['warningCodes'],
      });
    }

    if (
      summary.detailPolicy === 'aggressive_preview_only' &&
      summary.decisionStatus !== 'preview_only' &&
      summary.decisionStatus !== 'blocked'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Aggressive SR detail policy can only produce preview-only or blocked summaries.',
        path: ['decisionStatus'],
      });
    }

    if (summary.validationSummary.sourceCount !== summary.sourceState.length) {
      context.addIssue({
        code: 'custom',
        message: 'SR validation sourceCount must match source state length.',
        path: ['validationSummary', 'sourceCount'],
      });
    }
  });

export const superResolutionArtifactV1Schema = z
  .object({
    artifactId: z.string().trim().min(1),
    createdAt: z.iso.datetime({ offset: true }),
    decisionStatus: superResolutionDecisionStatusV1Schema,
    detailPolicy: superResolutionDetailPolicyV1Schema,
    dryRun: z
      .object({
        acceptedDryRunPlanHash: z.string().trim().min(1),
        acceptedDryRunPlanId: z.string().trim().min(1),
      })
      .strict(),
    engine: z
      .object({
        backendType: z.enum(['local_cpu', 'local_gpu', 'local_model', 'schema_only']),
        engineId: z.string().trim().min(1),
        engineVersion: z.string().trim().min(1),
        model: z
          .object({
            modelId: z.string().trim().min(1),
            modelVersion: z.string().trim().min(1),
          })
          .strict()
          .optional(),
      })
      .strict(),
    family: z.literal('super_resolution'),
    outputArtifact: artifactHandleV1Schema,
    outputColorSpace: z.string().trim().min(1),
    previewArtifacts: z.array(artifactHandleV1Schema),
    measuredReview: z
      .object({
        detailGainRatio: z.number().positive(),
        detailReviewRegions: z
          .array(
            z
              .object({
                baselineSharpnessScore: z.number().min(0),
                improvementRatio: z.number().min(0),
                label: z.string().trim().min(1),
                reconstructedSharpnessScore: z.number().min(0),
                regionId: z.string().trim().min(1),
                reviewStatus: z.enum(['accepted', 'needs_review', 'rejected']),
              })
              .strict(),
          )
          .length(3),
        downscaleReconstructionError: z.number().min(0),
        falseDetailRisk: z.enum(['low', 'medium', 'high']),
        falseDetailRiskScore: z.number().min(0).max(1),
      })
      .strict()
      .optional(),
    supportMap: z
      .object({
        artifactId: z.string().trim().min(1),
        coverageRatio: z.number().min(0).max(1),
        downgradeReason: z.string().trim().min(1).optional(),
        effectiveScale: z.number().min(1).max(4),
        requestedScale: z.number().min(1.1).max(4),
        reviewStatus: z.enum(['apply_ready', 'blocked', 'review_required']),
        weakSupportRatio: z.number().min(0).max(1),
      })
      .strict()
      .optional(),
    qualityPreference: computationalMergeQualityPreferenceV1Schema,
    requestedAlignmentMode: computationalMergeAlignmentModeV1Schema,
    reconstructionMode: superResolutionReconstructionModeV1Schema,
    requestedOutputScale: z.number().min(1.1).max(4),
    resolvedAlignmentMode: computationalMergeAlignmentModeV1Schema,
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sourceImageRefs: z.array(computationalMergeSourceImageRefV1Schema).min(2),
    sourceState: z.array(superResolutionSourceStateV1Schema).min(2),
    staleState: z
      .object({
        checkedAt: z.iso.datetime({ offset: true }).optional(),
        invalidationReasons: z.array(superResolutionInvalidationReasonV1Schema),
        state: superResolutionStaleStateV1Schema,
      })
      .strict(),
    validationSummary: z
      .object({
        actualPeakMemoryBytes: z.number().int().nonnegative().optional(),
        actualRuntimeMs: z.number().int().nonnegative().optional(),
        alignmentConfidence: z.number().min(0).max(1).optional(),
        downscaleReconstructionError: z.number().min(0).optional(),
        expectedDetailGainRatio: z.number().positive().optional(),
        falseDetailRiskScore: z.number().min(0).max(1).optional(),
        falseDetailRisk: z.enum(['unknown', 'low', 'medium', 'high']),
        humanReviewStatus: superResolutionReviewStatusV1Schema,
        overlapCoverageRatio: z.number().min(0).max(1).optional(),
        registrationMetrics: z
          .object({
            algorithmId: z.literal('output_lattice_phase_residual_v1'),
            averageConfidence: z.number().min(0).max(1),
            averageResidualPx: z.number().min(0),
            maxResidualPx: z.number().min(0),
            measuredSubpixelFrameCount: z.number().int().nonnegative(),
          })
          .strict()
          .optional(),
        sourceCount: z.number().int().positive(),
      })
      .strict(),
    warningCodes: z.array(superResolutionWarningCodeV1Schema),
  })
  .strict()
  .superRefine((artifact, context) => {
    if (artifact.detailPolicy === 'aggressive_preview_only') {
      context.addIssue({
        code: 'custom',
        message: 'Final SR derived artifacts must not use aggressive preview-only detail policy.',
        path: ['detailPolicy'],
      });
    }

    if (artifact.decisionStatus === 'blocked' || artifact.decisionStatus === 'preview_only') {
      context.addIssue({
        code: 'custom',
        message: 'Final SR derived artifacts require an apply-eligible decision status.',
        path: ['decisionStatus'],
      });
    }

    if (artifact.outputArtifact.kind !== 'merge_output' || artifact.outputArtifact.storage !== 'sidecar_artifact') {
      context.addIssue({
        code: 'custom',
        message: 'Final SR derived artifacts must reference a durable merge output sidecar artifact.',
        path: ['outputArtifact'],
      });
    }

    if (artifact.engine.backendType === 'local_model' && artifact.engine.model === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Model-backed SR artifacts require model provenance.',
        path: ['engine', 'model'],
      });
    }

    if (artifact.engine.backendType !== 'local_model' && artifact.engine.model !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Non-model SR artifacts must not include model provenance.',
        path: ['engine', 'model'],
      });
    }

    if (artifact.staleState.state === 'current' && artifact.staleState.invalidationReasons.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'Current SR artifacts must not include invalidation reasons.',
        path: ['staleState', 'invalidationReasons'],
      });
    }

    if (artifact.staleState.state === 'stale' && artifact.staleState.invalidationReasons.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Stale SR artifacts require invalidation reasons.',
        path: ['staleState', 'invalidationReasons'],
      });
    }

    if (artifact.validationSummary.sourceCount !== artifact.sourceImageRefs.length) {
      context.addIssue({
        code: 'custom',
        message: 'SR artifact validation sourceCount must match sourceImageRefs length.',
        path: ['validationSummary', 'sourceCount'],
      });
    }

    validateSuperResolutionSourceState(artifact.sourceImageRefs, artifact.sourceState, context, ['sourceState']);
  });

const filmPercentSchema = z.number().min(0).max(100);
const filmUnitIntervalSchema = z.number().min(0).max(1);

export const filmRenderDomainV1Schema = z.enum([
  'scene_referred_linear',
  'negative_lab_positive',
  'working_rgb',
  'display_referred',
]);

export const filmHalationAlgorithmV1Schema = z.enum([
  'legacy_rapidraw_red_fringe_v0',
  'spectral_highlight_halation_v1',
]);

export const filmHalationBlendModeV1Schema = z.enum([
  'screen_warmth_preserving',
  'linear_add_limited',
  'soft_light_tint',
]);

export const filmHalationQualityModeV1Schema = z.enum(['preview_fast', 'export_reference']);

export const filmHalationRenderStageV1Schema = z.enum([
  'creative_highlight_transport_before_glow',
  'layer_local_after_color',
  'schema_only_deferred',
]);

export const filmHalationRendererSupportV1Schema = z.enum([
  'implemented_current_engine',
  'partially_implemented_current_engine',
  'schema_only_deferred',
]);

export const filmHalationSourceChannelV1Schema = z.enum(['luminance', 'red_weighted_luminance', 'highlight_energy']);

export const filmHalationThresholdRolloffV1Schema = z.enum(['smoothstep', 'filmic_soft_knee']);

export const filmHalationWarningCodeV1Schema = z.enum([
  'creative_not_physical_spectral_model',
  'display_referred_input',
  'renderer_path_deferred',
  'renderer_path_partial',
]);

export const filmHalationModelV1Schema = z
  .object({
    algorithm: filmHalationAlgorithmV1Schema,
    blendMode: filmHalationBlendModeV1Schema,
    compatibleScopes: z.array(z.enum(['global', 'layer', 'mask'])).min(1),
    geometry: z
      .object({
        coreRadiusPx: z.number().min(0).max(256),
        edgeProtection: filmUnitIntervalSchema,
        fringeRadiusPx: z.number().min(0).max(512),
        radiusUnit: z.literal('working_pixels'),
      })
      .strict(),
    intensity: z
      .object({
        amount: z.number().min(0.01).max(100),
        highlightRolloff: filmPercentSchema,
      })
      .strict(),
    maskBehavior: z
      .object({
        application: z.enum(['source_only', 'composite_only', 'source_and_composite']),
        avoidLayerDoubleCounting: z.boolean(),
        expandSourceBeforeMask: z.boolean(),
      })
      .strict(),
    modelId: z
      .string()
      .trim()
      .regex(/^film\.halation\.[a-z0-9_]+\.v[0-9]+$/u),
    modelVersion: z.string().trim().min(1),
    qualityPolicy: z
      .object({
        exportMode: filmHalationQualityModeV1Schema,
        maxExportRadiusPx: z.number().min(1).max(512),
        maxPreviewRadiusPx: z.number().min(1).max(256),
        previewMode: filmHalationQualityModeV1Schema,
      })
      .strict(),
    renderDomain: filmRenderDomainV1Schema,
    renderStage: filmHalationRenderStageV1Schema,
    rendererSupport: filmHalationRendererSupportV1Schema,
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    deterministic: z
      .object({
        deterministicReplay: z.boolean(),
        stochasticInputs: z.boolean(),
      })
      .strict(),
    sourceIsolation: z
      .object({
        protectClippedHighlights: z.boolean(),
        rolloff: filmHalationThresholdRolloffV1Schema,
        sourceChannel: filmHalationSourceChannelV1Schema,
        thresholdEnd: filmUnitIntervalSchema,
        thresholdStart: filmUnitIntervalSchema,
      })
      .strict(),
    spectralBias: z
      .object({
        blueGain: z.number().min(0).max(2),
        greenGain: z.number().min(0).max(2),
        orangeGain: z.number().min(0).max(2),
        redGain: z.number().min(0).max(2),
      })
      .strict(),
    warningCodes: z.array(filmHalationWarningCodeV1Schema),
  })
  .strict()
  .superRefine((model, context) => {
    if (model.sourceIsolation.thresholdStart >= model.sourceIsolation.thresholdEnd) {
      context.addIssue({
        code: 'custom',
        message: 'Film halation thresholdStart must be lower than thresholdEnd.',
        path: ['sourceIsolation', 'thresholdEnd'],
      });
    }

    if (model.geometry.fringeRadiusPx < model.geometry.coreRadiusPx) {
      context.addIssue({
        code: 'custom',
        message: 'Film halation fringeRadiusPx must be greater than or equal to coreRadiusPx.',
        path: ['geometry', 'fringeRadiusPx'],
      });
    }

    if (model.qualityPolicy.maxPreviewRadiusPx > model.qualityPolicy.maxExportRadiusPx) {
      context.addIssue({
        code: 'custom',
        message: 'Film halation preview radius cap must not exceed export radius cap.',
        path: ['qualityPolicy', 'maxPreviewRadiusPx'],
      });
    }

    if (model.qualityPolicy.maxExportRadiusPx < model.geometry.fringeRadiusPx) {
      context.addIssue({
        code: 'custom',
        message: 'Film halation export radius cap must cover the configured fringe radius.',
        path: ['qualityPolicy', 'maxExportRadiusPx'],
      });
    }

    if (model.compatibleScopes.includes('mask') && !model.maskBehavior.avoidLayerDoubleCounting) {
      context.addIssue({
        code: 'custom',
        message: 'Mask-compatible film halation must avoid layer double-counting.',
        path: ['maskBehavior', 'avoidLayerDoubleCounting'],
      });
    }

    if (!model.deterministic.deterministicReplay || model.deterministic.stochasticInputs) {
      context.addIssue({
        code: 'custom',
        message: 'Film halation v1 must be deterministic and must not declare stochastic inputs.',
        path: ['deterministic'],
      });
    }

    if (model.renderDomain === 'display_referred' && !model.warningCodes.includes('display_referred_input')) {
      context.addIssue({
        code: 'custom',
        message: 'Display-referred film halation requires an explicit display-referred warning.',
        path: ['warningCodes'],
      });
    }

    if (model.rendererSupport === 'schema_only_deferred' && !model.warningCodes.includes('renderer_path_deferred')) {
      context.addIssue({
        code: 'custom',
        message: 'Schema-only film halation requires a deferred renderer warning.',
        path: ['warningCodes'],
      });
    }

    if (
      model.rendererSupport === 'partially_implemented_current_engine' &&
      !model.warningCodes.includes('renderer_path_partial')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Partially implemented film halation requires a partial renderer warning.',
        path: ['warningCodes'],
      });
    }

    const warmGain = model.spectralBias.redGain + model.spectralBias.orangeGain;
    const coolGain = model.spectralBias.greenGain + model.spectralBias.blueGain;

    if (model.intensity.amount > 0 && warmGain <= 0) {
      context.addIssue({
        code: 'custom',
        message: 'Enabled film halation requires red or orange spectral contribution.',
        path: ['spectralBias'],
      });
    }

    if (model.intensity.amount > 0 && warmGain <= coolGain) {
      context.addIssue({
        code: 'custom',
        message: 'Film halation spectral bias must remain warmer than green/blue leakage.',
        path: ['spectralBias'],
      });
    }

    if (model.algorithm === 'legacy_rapidraw_red_fringe_v0' && model.rendererSupport !== 'implemented_current_engine') {
      context.addIssue({
        code: 'custom',
        message: 'Legacy RapidRaw halation maps to the implemented current engine.',
        path: ['rendererSupport'],
      });
    }

    if (
      model.algorithm === 'spectral_highlight_halation_v1' &&
      model.rendererSupport === 'implemented_current_engine'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Spectral highlight halation is not fully implemented by the current renderer.',
        path: ['rendererSupport'],
      });
    }
  });

export const filmGlowAlgorithmV1Schema = z.enum(['legacy_rapidraw_glow_bloom_v0', 'luminance_bloom_glow_v1']);

export const filmBlackAndWhiteAlgorithmV1Schema = z.enum([
  'legacy_rapidraw_desaturate_v0',
  'channel_mixer_filter_response_v1',
]);

export const filmBlackAndWhiteFilterPresetV1Schema = z.enum([
  'none',
  'yellow_filter',
  'orange_filter',
  'red_filter',
  'green_filter',
  'blue_filter',
  'custom',
]);

export const filmBlackAndWhiteResponseFamilyV1Schema = z.enum([
  'panchromatic_style',
  'orthochromatic_style',
  'infrared_style',
  'generic_monochrome_style',
]);

export const filmBlackAndWhiteRenderStageV1Schema = z.enum([
  'creative_monochrome_before_halation',
  'layer_local_after_color',
  'schema_only_deferred',
]);

export const filmBlackAndWhiteRendererSupportV1Schema = z.enum([
  'implemented_current_engine',
  'partially_implemented_current_engine',
  'schema_only_deferred',
]);

export const filmBlackAndWhiteToningModeV1Schema = z.enum(['none', 'paper_tint', 'split_tone']);

export const filmBlackAndWhiteWarningCodeV1Schema = z.enum([
  'creative_not_measured_stock_response',
  'display_referred_input',
  'not_stock_measured_response',
  'renderer_path_deferred',
  'renderer_path_partial',
  'toning_not_measured_paper',
]);

export const filmBlackAndWhiteModelV1Schema = z
  .object({
    algorithm: filmBlackAndWhiteAlgorithmV1Schema,
    channelMixer: z
      .object({
        blueWeight: z.number().min(-2).max(2),
        greenWeight: z.number().min(-2).max(2),
        normalizeLuminance: z.boolean(),
        redWeight: z.number().min(-2).max(2),
      })
      .strict(),
    compatibleScopes: z.array(z.enum(['global', 'layer', 'mask'])).min(1),
    deterministic: z
      .object({
        deterministicReplay: z.boolean(),
        stochasticInputs: z.boolean(),
      })
      .strict(),
    filterResponse: z
      .object({
        customHueDegrees: z.number().min(0).max(360).optional(),
        preset: filmBlackAndWhiteFilterPresetV1Schema,
        strength: filmPercentSchema,
      })
      .strict(),
    luminanceCurve: z
      .object({
        blackPoint: z.number().min(0).max(1),
        contrast: filmPercentSchema,
        midtoneLift: z.number().min(-100).max(100),
        shoulder: filmPercentSchema,
        toe: filmPercentSchema,
        whitePoint: z.number().min(0).max(1),
      })
      .strict(),
    maskBehavior: z
      .object({
        application: z.enum(['source_only', 'composite_only', 'source_and_composite']),
        avoidLayerDoubleCounting: z.boolean(),
      })
      .strict(),
    modelId: z
      .string()
      .trim()
      .regex(/^film\.bw\.[a-z0-9_]+\.v[0-9]+$/u),
    modelVersion: z.string().trim().min(1),
    renderDomain: filmRenderDomainV1Schema,
    renderStage: filmBlackAndWhiteRenderStageV1Schema,
    rendererSupport: filmBlackAndWhiteRendererSupportV1Schema,
    responseFamily: filmBlackAndWhiteResponseFamilyV1Schema,
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    toning: z
      .object({
        balance: z.number().min(-100).max(100),
        highlightHueDegrees: z.number().min(0).max(360).optional(),
        mode: filmBlackAndWhiteToningModeV1Schema,
        paperHueDegrees: z.number().min(0).max(360).optional(),
        paperSaturation: z.number().min(0).max(1).optional(),
        shadowHueDegrees: z.number().min(0).max(360).optional(),
        strength: filmPercentSchema,
      })
      .strict(),
    warningCodes: z.array(filmBlackAndWhiteWarningCodeV1Schema),
  })
  .strict()
  .superRefine((model, context) => {
    const mixerMagnitude =
      Math.abs(model.channelMixer.redWeight) +
      Math.abs(model.channelMixer.greenWeight) +
      Math.abs(model.channelMixer.blueWeight);

    if (mixerMagnitude === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Black-and-white channel mixer requires at least one non-zero channel weight.',
        path: ['channelMixer'],
      });
    }

    if (model.luminanceCurve.blackPoint >= model.luminanceCurve.whitePoint) {
      context.addIssue({
        code: 'custom',
        message: 'Black-and-white luminance curve requires blackPoint below whitePoint.',
        path: ['luminanceCurve'],
      });
    }

    if (model.filterResponse.preset === 'none' && model.filterResponse.strength > 0) {
      context.addIssue({
        code: 'custom',
        message: 'Black-and-white filter response preset none requires zero strength.',
        path: ['filterResponse', 'strength'],
      });
    }

    if (model.filterResponse.preset === 'custom' && model.filterResponse.customHueDegrees === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Custom black-and-white filter response requires customHueDegrees.',
        path: ['filterResponse', 'customHueDegrees'],
      });
    }

    if (model.filterResponse.preset !== 'custom' && model.filterResponse.customHueDegrees !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Only custom black-and-white filter response may include customHueDegrees.',
        path: ['filterResponse', 'customHueDegrees'],
      });
    }

    if (model.toning.mode === 'none' && model.toning.strength > 0) {
      context.addIssue({
        code: 'custom',
        message: 'Black-and-white toning strength requires a toning mode.',
        path: ['toning', 'strength'],
      });
    }

    if (model.toning.mode === 'paper_tint') {
      if (model.toning.paperHueDegrees === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Paper-tint black-and-white model requires paperHueDegrees.',
          path: ['toning', 'paperHueDegrees'],
        });
      }

      if (model.toning.paperSaturation === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Paper-tint black-and-white model requires paperSaturation.',
          path: ['toning', 'paperSaturation'],
        });
      }
    }

    if (model.toning.mode === 'split_tone') {
      if (model.toning.shadowHueDegrees === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Split-tone black-and-white model requires shadowHueDegrees.',
          path: ['toning', 'shadowHueDegrees'],
        });
      }

      if (model.toning.highlightHueDegrees === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Split-tone black-and-white model requires highlightHueDegrees.',
          path: ['toning', 'highlightHueDegrees'],
        });
      }

      if (model.toning.strength === 0) {
        context.addIssue({
          code: 'custom',
          message: 'Split-tone black-and-white model requires non-zero toning strength.',
          path: ['toning', 'strength'],
        });
      }
    }

    if (model.toning.mode !== 'paper_tint' && model.toning.paperHueDegrees !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Only paper-tint black-and-white model may include paperHueDegrees.',
        path: ['toning', 'paperHueDegrees'],
      });
    }

    if (model.toning.mode !== 'paper_tint' && model.toning.paperSaturation !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Only paper-tint black-and-white model may include paperSaturation.',
        path: ['toning', 'paperSaturation'],
      });
    }

    if (model.compatibleScopes.includes('mask') && !model.maskBehavior.avoidLayerDoubleCounting) {
      context.addIssue({
        code: 'custom',
        message: 'Mask-compatible black-and-white model must avoid layer double-counting.',
        path: ['maskBehavior', 'avoidLayerDoubleCounting'],
      });
    }

    if (!model.deterministic.deterministicReplay || model.deterministic.stochasticInputs) {
      context.addIssue({
        code: 'custom',
        message: 'Black-and-white model v1 must be deterministic and must not declare stochastic inputs.',
        path: ['deterministic'],
      });
    }

    if (model.renderDomain === 'display_referred' && !model.warningCodes.includes('display_referred_input')) {
      context.addIssue({
        code: 'custom',
        message: 'Display-referred black-and-white model requires an explicit display-referred warning.',
        path: ['warningCodes'],
      });
    }

    if (model.rendererSupport === 'schema_only_deferred' && !model.warningCodes.includes('renderer_path_deferred')) {
      context.addIssue({
        code: 'custom',
        message: 'Schema-only black-and-white model requires a deferred renderer warning.',
        path: ['warningCodes'],
      });
    }

    if (
      model.rendererSupport === 'partially_implemented_current_engine' &&
      !model.warningCodes.includes('renderer_path_partial')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Partially implemented black-and-white model requires a partial renderer warning.',
        path: ['warningCodes'],
      });
    }

    if (!model.warningCodes.includes('creative_not_measured_stock_response')) {
      context.addIssue({
        code: 'custom',
        message: 'Generic black-and-white response family requires a measured-stock disclaimer warning.',
        path: ['warningCodes'],
      });
    }

    if (model.toning.mode !== 'none' && !model.warningCodes.includes('toning_not_measured_paper')) {
      context.addIssue({
        code: 'custom',
        message: 'Black-and-white toning requires a paper/process disclaimer warning.',
        path: ['warningCodes'],
      });
    }

    if (model.algorithm === 'legacy_rapidraw_desaturate_v0' && model.rendererSupport !== 'implemented_current_engine') {
      context.addIssue({
        code: 'custom',
        message: 'Legacy RapidRaw desaturation maps to the implemented current engine.',
        path: ['rendererSupport'],
      });
    }

    if (
      model.algorithm === 'channel_mixer_filter_response_v1' &&
      model.rendererSupport === 'implemented_current_engine'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Channel mixer filter response is not fully implemented by the current renderer.',
        path: ['rendererSupport'],
      });
    }
  });

export const filmGlowBlendModeV1Schema = z.enum([
  'screen_luminance_preserving',
  'linear_add_limited',
  'soft_light_lift',
]);

export const filmGlowBlurStrategyV1Schema = z.enum(['separable_gaussian', 'mip_pyramid', 'cpu_reference_deferred']);

export const filmGlowQualityModeV1Schema = z.enum(['preview_fast', 'export_reference']);

export const filmGlowRenderStageV1Schema = z.enum([
  'creative_bloom_after_halation',
  'layer_local_after_color',
  'schema_only_deferred',
]);

export const filmGlowRendererSupportV1Schema = z.enum([
  'implemented_current_engine',
  'partially_implemented_current_engine',
  'schema_only_deferred',
]);

export const filmGlowSourceChannelV1Schema = z.enum(['luminance', 'max_rgb', 'highlight_energy']);

export const filmGlowThresholdRolloffV1Schema = z.enum(['smoothstep', 'filmic_soft_knee']);

export const filmGlowTintModeV1Schema = z.enum(['neutral_preserve_hue', 'subtle_warmth', 'subtle_cool']);

export const filmGlowWarningCodeV1Schema = z.enum([
  'clipping_risk',
  'display_referred_input',
  'renderer_path_deferred',
  'renderer_path_partial',
  'wide_radius_performance_risk',
  'wide_radius_preview_approximation',
]);

export const filmGlowModelV1Schema = z
  .object({
    algorithm: filmGlowAlgorithmV1Schema,
    blendMode: filmGlowBlendModeV1Schema,
    blurPolicy: z
      .object({
        exportStrategy: filmGlowBlurStrategyV1Schema,
        previewStrategy: filmGlowBlurStrategyV1Schema,
        radiusPx: z.number().min(0.5).max(512),
        radiusUnit: z.literal('working_pixels'),
      })
      .strict(),
    compatibleScopes: z.array(z.enum(['global', 'layer', 'mask'])).min(1),
    deterministic: z
      .object({
        deterministicReplay: z.boolean(),
        stochasticInputs: z.boolean(),
      })
      .strict(),
    highlightPreservation: z
      .object({
        localContrastRetention: filmUnitIntervalSchema,
        protectClippedHighlights: z.boolean(),
        shoulderCompression: filmUnitIntervalSchema,
      })
      .strict(),
    intensity: z
      .object({
        bloomAmount: filmPercentSchema,
        glowAmount: filmPercentSchema,
        opacity: z.number().min(0.01).max(100),
      })
      .strict(),
    maskBehavior: z
      .object({
        application: z.enum(['source_only', 'composite_only', 'source_and_composite']),
        avoidLayerDoubleCounting: z.boolean(),
        expandSourceBeforeMask: z.boolean(),
        stabilizeMaskEdgesBeforeBlur: z.boolean(),
      })
      .strict(),
    modelId: z
      .string()
      .trim()
      .regex(/^film\.glow\.[a-z0-9_]+\.v[0-9]+$/u),
    modelVersion: z.string().trim().min(1),
    qualityPolicy: z
      .object({
        exportMode: filmGlowQualityModeV1Schema,
        maxExportRadiusPx: z.number().min(1).max(512),
        maxPreviewRadiusPx: z.number().min(1).max(256),
        previewMode: filmGlowQualityModeV1Schema,
      })
      .strict(),
    renderDomain: filmRenderDomainV1Schema,
    renderStage: filmGlowRenderStageV1Schema,
    rendererSupport: filmGlowRendererSupportV1Schema,
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sourceIsolation: z
      .object({
        rolloff: filmGlowThresholdRolloffV1Schema,
        sourceChannel: filmGlowSourceChannelV1Schema,
        thresholdEnd: filmUnitIntervalSchema,
        thresholdStart: filmUnitIntervalSchema,
      })
      .strict(),
    tintPolicy: z
      .object({
        mode: filmGlowTintModeV1Schema,
        saturationScale: z.number().min(0).max(2),
        tintStrength: filmUnitIntervalSchema,
      })
      .strict(),
    warningCodes: z.array(filmGlowWarningCodeV1Schema),
  })
  .strict()
  .superRefine((model, context) => {
    if (model.sourceIsolation.thresholdStart >= model.sourceIsolation.thresholdEnd) {
      context.addIssue({
        code: 'custom',
        message: 'Film glow thresholdStart must be lower than thresholdEnd.',
        path: ['sourceIsolation', 'thresholdEnd'],
      });
    }

    if (model.intensity.bloomAmount === 0 && model.intensity.glowAmount === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Film glow model requires bloom or glow contribution.',
        path: ['intensity'],
      });
    }

    if (model.qualityPolicy.maxPreviewRadiusPx > model.qualityPolicy.maxExportRadiusPx) {
      context.addIssue({
        code: 'custom',
        message: 'Film glow preview radius cap must not exceed export radius cap.',
        path: ['qualityPolicy', 'maxPreviewRadiusPx'],
      });
    }

    if (model.qualityPolicy.maxExportRadiusPx < model.blurPolicy.radiusPx) {
      context.addIssue({
        code: 'custom',
        message: 'Film glow export radius cap must cover the configured blur radius.',
        path: ['qualityPolicy', 'maxExportRadiusPx'],
      });
    }

    if (model.blurPolicy.radiusPx > 256 && !model.warningCodes.includes('wide_radius_performance_risk')) {
      context.addIssue({
        code: 'custom',
        message: 'Wide-radius film glow requires an explicit performance-risk warning.',
        path: ['warningCodes'],
      });
    }

    if (
      model.blurPolicy.radiusPx > model.qualityPolicy.maxPreviewRadiusPx &&
      !model.warningCodes.includes('wide_radius_preview_approximation')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Film glow preview radius approximation requires an explicit warning.',
        path: ['warningCodes'],
      });
    }

    if (
      model.blendMode === 'linear_add_limited' &&
      model.intensity.opacity > 70 &&
      !model.warningCodes.includes('clipping_risk')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'High-opacity additive film glow requires an explicit clipping-risk warning.',
        path: ['warningCodes'],
      });
    }

    if (model.compatibleScopes.includes('mask') && !model.maskBehavior.avoidLayerDoubleCounting) {
      context.addIssue({
        code: 'custom',
        message: 'Mask-compatible film glow must avoid layer double-counting.',
        path: ['maskBehavior', 'avoidLayerDoubleCounting'],
      });
    }

    if (model.compatibleScopes.includes('mask') && !model.maskBehavior.stabilizeMaskEdgesBeforeBlur) {
      context.addIssue({
        code: 'custom',
        message: 'Mask-compatible film glow must stabilize mask edges before blur.',
        path: ['maskBehavior', 'stabilizeMaskEdgesBeforeBlur'],
      });
    }

    if (!model.deterministic.deterministicReplay || model.deterministic.stochasticInputs) {
      context.addIssue({
        code: 'custom',
        message: 'Film glow v1 must be deterministic and must not declare stochastic inputs.',
        path: ['deterministic'],
      });
    }

    if (model.renderDomain === 'display_referred' && !model.warningCodes.includes('display_referred_input')) {
      context.addIssue({
        code: 'custom',
        message: 'Display-referred film glow requires an explicit display-referred warning.',
        path: ['warningCodes'],
      });
    }

    if (model.rendererSupport === 'schema_only_deferred' && !model.warningCodes.includes('renderer_path_deferred')) {
      context.addIssue({
        code: 'custom',
        message: 'Schema-only film glow requires a deferred renderer warning.',
        path: ['warningCodes'],
      });
    }

    if (
      model.rendererSupport === 'partially_implemented_current_engine' &&
      !model.warningCodes.includes('renderer_path_partial')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Partially implemented film glow requires a partial renderer warning.',
        path: ['warningCodes'],
      });
    }

    if (model.algorithm === 'legacy_rapidraw_glow_bloom_v0' && model.rendererSupport !== 'implemented_current_engine') {
      context.addIssue({
        code: 'custom',
        message: 'Legacy RapidRaw glow maps to the implemented current engine.',
        path: ['rendererSupport'],
      });
    }

    if (model.algorithm === 'luminance_bloom_glow_v1' && model.rendererSupport === 'implemented_current_engine') {
      context.addIssue({
        code: 'custom',
        message: 'Luminance bloom/glow is not fully implemented by the current renderer.',
        path: ['rendererSupport'],
      });
    }
  });

export const filmGrainAlgorithmV1Schema = z.enum(['legacy_rapidraw_luma_noise_v0', 'procedural_luma_chroma_noise_v1']);

export const filmGrainIsoPresetV1Schema = z.enum([
  'iso_50',
  'iso_100',
  'iso_200',
  'iso_400',
  'iso_800',
  'iso_1600',
  'iso_3200',
  'custom',
]);

export const filmGrainRenderStageV1Schema = z.enum([
  'creative_final_after_glow',
  'layer_local_after_color',
  'schema_only_deferred',
]);

export const filmGrainRendererSupportV1Schema = z.enum([
  'implemented_current_engine',
  'partially_implemented_current_engine',
  'schema_only_deferred',
]);

export const filmGrainSeedPolicyV1Schema = z
  .object({
    mode: z.enum(['stable_per_image', 'stable_per_variant', 'explicit_seed', 'random_per_render']),
    seed: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.mode === 'explicit_seed' && policy.seed === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Explicit film grain seed policy requires a seed.',
        path: ['seed'],
      });
    }

    if (policy.mode !== 'explicit_seed' && policy.seed !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Only explicit film grain seed policy may include a seed.',
        path: ['seed'],
      });
    }
  });

export const filmGrainToneBandV1Schema = z
  .object({
    amountScale: z.number().min(0).max(2),
    endLuma: filmUnitIntervalSchema,
    startLuma: filmUnitIntervalSchema,
  })
  .strict()
  .refine((band) => band.startLuma < band.endLuma, {
    message: 'Film grain tone band startLuma must be lower than endLuma.',
    path: ['endLuma'],
  });

export const filmGrainModelV1Schema = z
  .object({
    algorithm: filmGrainAlgorithmV1Schema,
    channelSeparation: z
      .object({
        chromaAmount: filmUnitIntervalSchema,
        chromaCorrelation: filmUnitIntervalSchema,
        lumaAmount: filmUnitIntervalSchema,
      })
      .strict(),
    compatibleScopes: z.array(z.enum(['global', 'layer', 'mask'])).min(1),
    intensity: z
      .object({
        amount: filmPercentSchema,
        roughness: filmPercentSchema,
        size: filmPercentSchema,
      })
      .strict(),
    isoPreset: filmGrainIsoPresetV1Schema,
    modelId: z
      .string()
      .trim()
      .regex(/^film\.grain\.[a-z0-9_]+\.v[0-9]+$/u),
    modelVersion: z.string().trim().min(1),
    renderStage: filmGrainRenderStageV1Schema,
    rendererSupport: filmGrainRendererSupportV1Schema,
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    seedPolicy: filmGrainSeedPolicyV1Schema,
    toneResponse: z
      .object({
        highlight: filmGrainToneBandV1Schema,
        midtoneAmountScale: z.number().min(0).max(2),
        protectClippedHighlights: z.boolean(),
        shadow: filmGrainToneBandV1Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine((model, context) => {
    if (model.channelSeparation.lumaAmount === 0 && model.channelSeparation.chromaAmount === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Film grain model requires luma or chroma grain contribution.',
        path: ['channelSeparation'],
      });
    }

    if (model.algorithm === 'legacy_rapidraw_luma_noise_v0' && model.rendererSupport !== 'implemented_current_engine') {
      context.addIssue({
        code: 'custom',
        message: 'Legacy RapidRaw grain maps to the implemented current engine.',
        path: ['rendererSupport'],
      });
    }

    if (
      model.algorithm === 'procedural_luma_chroma_noise_v1' &&
      model.rendererSupport === 'implemented_current_engine'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Procedural luma/chroma grain is not fully implemented by the current renderer.',
        path: ['rendererSupport'],
      });
    }
  });

export const negativeInputModeSchema = z.enum([
  'camera_raw',
  'camera_tiff',
  'flatbed_tiff',
  'lab_tiff',
  'lab_jpeg',
  'contact_sheet',
  'unknown',
]);

export const negativePixelBasisSchema = z.enum([
  'camera_raw_rgb',
  'camera_rendered',
  'scanner_rgb',
  'lab_rendered_rgb',
  'display_rgb',
  'unknown',
]);

export const negativeAcquisitionConfidenceSchema = z.enum(['high', 'medium', 'low', 'blocked']);

export const negativeWarningSeveritySchema = z.enum(['info', 'warning', 'error', 'blocking']);

export const negativeWarningCodeSchema = z.enum([
  'unknown_input_mode',
  'unknown_pixel_basis',
  'unknown_input_profile',
  'assumed_display_profile',
  'display_referred_input',
  'lossy_input',
  'low_bit_depth_input',
  'suspected_lab_correction',
  'suspected_pre_inversion',
  'suspected_auto_exposure',
  'suspected_auto_color',
  'suspected_auto_contrast',
  'suspected_sharpening',
  'suspected_ir_cleaning',
  'missing_visible_base',
  'cropped_no_border',
  'frame_detection_low_confidence',
  'irregular_frame_spacing',
  'overlapping_frame_candidates',
  'clipped_base_channel',
  'uneven_illumination',
  'mixed_frame_input_modes',
  'contact_sheet_requires_split',
  'profile_mismatch',
  'low_acquisition_confidence',
]);

export const negativeProcessFamilySchema = z.enum([
  'c41_color_negative',
  'black_and_white_silver_negative',
  'chromogenic_black_and_white_negative',
  'ecn2_color_negative',
  'e6_slide_helper',
  'redscale_or_creative_negative',
  'unknown',
]);

export const negativeLabSupportedProcessFamilyV1Schema = z.enum([
  'c41_color_negative',
  'black_and_white_silver_negative',
]);

export const negativeWarningV1Schema = z
  .object({
    blocksAutomation: z.boolean(),
    code: negativeWarningCodeSchema,
    evidence: z.string().trim().min(1),
    frameIds: z.array(z.string().trim().min(1)).optional(),
    scope: z.enum(['session', 'frame', 'profile']),
    severity: negativeWarningSeveritySchema,
  })
  .strict();

export const negativeLabProcessProfileClassSchema = z.enum([
  'generic_process',
  'stock_family_starting_point',
  'measured_project_profile',
  'user_profile',
  'reference_mapping',
]);

export const negativeLabLegalNamingStatusSchema = z.enum([
  'generic_safe_name',
  'descriptive_stock_family',
  'legal_review_required',
  'approved_exact_stock_name',
]);

export const negativeLabProfileMeasurementSourceSchema = z.enum([
  'generic_engineered_starting_point',
  'project_owned_measurement',
  'user_supplied_measurement',
  'research_reference_metadata_only',
]);

export const negativeLabDensityCurvePointV1Schema = z
  .object({
    inputDensity: z.number().min(0),
    outputLinear: z.number().min(0),
  })
  .strict();

export const negativeLabDensityCurveV1Schema = z
  .object({
    channel: z.enum(['red', 'green', 'blue', 'luminance']),
    interpolation: z.enum(['linear', 'monotone_cubic']),
    points: z.array(negativeLabDensityCurvePointV1Schema).min(2),
  })
  .strict()
  .superRefine((curve, context) => {
    const [firstPoint, ...remainingPoints] = curve.points;
    if (firstPoint === undefined) return;

    let previous = firstPoint;
    for (const [offset, current] of remainingPoints.entries()) {
      const index = offset + 1;

      if (current.inputDensity <= previous.inputDensity) {
        context.addIssue({
          code: 'custom',
          message: 'Density curve inputDensity values must be strictly increasing.',
          path: ['points', index, 'inputDensity'],
        });
      }

      if (current.outputLinear < previous.outputLinear) {
        context.addIssue({
          code: 'custom',
          message: 'Density curve outputLinear values must be monotonic non-decreasing.',
          path: ['points', index, 'outputLinear'],
        });
      }

      previous = current;
    }
  });

export const negativeLabDensityNormalizationProfileV1Schema = z
  .object({
    algorithmId: z.literal('density_normalization_v1'),
    anchorPolicy: z.enum(['roll_anchor_frames', 'selected_frames', 'per_frame_only']),
    channelBalanceWeights: z
      .object({
        blue: z.number().min(0).max(1),
        green: z.number().min(0).max(1),
        red: z.number().min(0).max(1),
      })
      .strict(),
    densityAim: z
      .object({
        highlightDensity: z.number().min(0),
        midtoneDensity: z.number().min(0),
        shadowDensity: z.number().min(0),
      })
      .strict(),
    exposureReferenceDensity: z.number().min(0),
    normalizationProfileId: z.string().trim().min(1),
    profileVersion: z.string().trim().min(1),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    supportedProcessFamilies: z.array(negativeLabSupportedProcessFamilyV1Schema).min(1),
  })
  .strict()
  .superRefine((profile, context) => {
    const { highlightDensity, midtoneDensity, shadowDensity } = profile.densityAim;
    if (!(highlightDensity < midtoneDensity && midtoneDensity < shadowDensity)) {
      context.addIssue({
        code: 'custom',
        message: 'Density normalization aims must progress highlight < midtone < shadow.',
        path: ['densityAim'],
      });
    }

    const channelWeightTotal =
      profile.channelBalanceWeights.red + profile.channelBalanceWeights.green + profile.channelBalanceWeights.blue;
    if (Math.abs(channelWeightTotal - 1) > 0.001) {
      context.addIssue({
        code: 'custom',
        message: 'Density normalization channel weights must sum to 1.',
        path: ['channelBalanceWeights'],
      });
    }
  });

export const negativeLabProcessProfileV1Schema = z
  .object({
    colorMode: z.enum(['color_negative_rgb', 'black_and_white_luminance']),
    curveModelId: z.literal('process_profile_monotonic_v1'),
    densityCurves: z.array(negativeLabDensityCurveV1Schema).min(1),
    normalizationProfileId: z.string().trim().min(1),
    processFamily: negativeLabSupportedProcessFamilyV1Schema,
    profileClass: negativeLabProcessProfileClassSchema,
    profileId: z.string().trim().min(1),
    profileVersion: z.string().trim().min(1),
    provenance: z
      .object({
        claimsPolicy: z.enum(['generic_starting_point_only', 'measured_profile', 'reference_metadata_only']),
        fixtureIds: z.array(z.string().trim().min(1)),
        legalNamingStatus: negativeLabLegalNamingStatusSchema,
        measurementSource: negativeLabProfileMeasurementSourceSchema,
      })
      .strict(),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    touchedParameters: z
      .object({
        creativeRendering: z.array(z.string().trim().min(1)),
        objectiveInversion: z.array(z.string().trim().min(1)),
        semiObjectiveNormalization: z.array(z.string().trim().min(1)),
      })
      .strict(),
    warningCodes: z.array(negativeWarningCodeSchema),
  })
  .strict()
  .superRefine((profile, context) => {
    if (profile.profileClass === 'measured_project_profile' && profile.provenance.fixtureIds.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Measured project profiles require at least one fixture ID.',
        path: ['provenance', 'fixtureIds'],
      });
    }

    if (
      profile.profileClass === 'measured_project_profile' &&
      profile.provenance.measurementSource !== 'project_owned_measurement'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Measured project profiles must use project-owned measurement provenance.',
        path: ['provenance', 'measurementSource'],
      });
    }

    if (profile.colorMode === 'black_and_white_luminance') {
      const nonLuminanceCurve = profile.densityCurves.find((curve) => curve.channel !== 'luminance');
      if (nonLuminanceCurve !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Black-and-white process profiles must use luminance density curves only.',
          path: ['densityCurves'],
        });
      }
    }
  });

export const negativeLabPerChannelInversionCurveSetSourceV1Schema = z.enum([
  'process_profile_reference',
  'roll_objective_override',
  'frame_objective_override',
  'measured_project_profile',
  'user_expert_override',
]);

export const negativeLabPerChannelInversionCurveSetScopeV1Schema = z.enum([
  'process_profile',
  'roll',
  'selected_frames',
  'single_frame',
]);

export const negativeLabPerChannelInversionCurveSetV1Schema = z
  .object({
    algorithmId: z.literal('per_channel_inversion_curves_v1'),
    colorMode: z.enum(['color_negative_rgb', 'black_and_white_luminance']),
    curveSetId: z.string().trim().min(1),
    curveSetSource: negativeLabPerChannelInversionCurveSetSourceV1Schema,
    curveSetVersion: z.string().trim().min(1),
    densityCurves: z.array(negativeLabDensityCurveV1Schema).min(1),
    operationClass: z.literal('objective'),
    operationStage: z.literal('objective_inversion'),
    processFamily: negativeLabSupportedProcessFamilyV1Schema,
    provenance: z
      .object({
        legalNamingStatus: negativeLabLegalNamingStatusSchema,
        measurementSource: negativeLabProfileMeasurementSourceSchema,
        notes: z.string().trim().min(1).optional(),
        sourceFixtureIds: z.array(z.string().trim().min(1)),
        sourceProcessProfileId: z.string().trim().min(1).optional(),
        sourceProcessProfileVersion: z.string().trim().min(1).optional(),
      })
      .strict(),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    scope: z
      .object({
        frameSelection: z.lazy(() => negativeLabFrameSelectionV1Schema).optional(),
        scopeKind: negativeLabPerChannelInversionCurveSetScopeV1Schema,
        sessionId: z.string().trim().min(1).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((curveSet, context) => {
    const channels = curveSet.densityCurves.map((curve) => curve.channel);
    const uniqueChannels = new Set(channels);
    if (uniqueChannels.size !== channels.length) {
      context.addIssue({
        code: 'custom',
        message: 'Per-channel inversion curve sets must not repeat a channel.',
        path: ['densityCurves'],
      });
    }

    if (curveSet.colorMode === 'color_negative_rgb') {
      const requiredChannels = ['red', 'green', 'blue'] as const;
      const missingChannels = requiredChannels.filter((channel) => !uniqueChannels.has(channel));
      if (missingChannels.length > 0 || uniqueChannels.has('luminance')) {
        context.addIssue({
          code: 'custom',
          message: 'Color negative inversion curve sets must contain red, green, and blue curves only.',
          path: ['densityCurves'],
        });
      }
    }

    if (curveSet.colorMode === 'black_and_white_luminance') {
      if (uniqueChannels.size !== 1 || !uniqueChannels.has('luminance')) {
        context.addIssue({
          code: 'custom',
          message: 'Black-and-white inversion curve sets must contain one luminance curve.',
          path: ['densityCurves'],
        });
      }
    }

    const hasSourceProfile =
      curveSet.provenance.sourceProcessProfileId !== undefined &&
      curveSet.provenance.sourceProcessProfileVersion !== undefined;
    if (curveSet.curveSetSource === 'process_profile_reference' && !hasSourceProfile) {
      context.addIssue({
        code: 'custom',
        message: 'Process-profile curve references require source profile ID and version provenance.',
        path: ['provenance'],
      });
    }

    if (curveSet.curveSetSource === 'process_profile_reference' && curveSet.scope.scopeKind !== 'process_profile') {
      context.addIssue({
        code: 'custom',
        message: 'Process-profile curve references must use process_profile scope.',
        path: ['scope', 'scopeKind'],
      });
    }

    if (
      ['roll_objective_override', 'frame_objective_override', 'user_expert_override'].includes(
        curveSet.curveSetSource,
      ) &&
      curveSet.scope.sessionId === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Session-scoped inversion curve overrides require a session ID.',
        path: ['scope', 'sessionId'],
      });
    }

    if (
      ['selected_frames', 'single_frame'].includes(curveSet.scope.scopeKind) &&
      curveSet.scope.frameSelection === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Frame-scoped inversion curve sets require a frame selection.',
        path: ['scope', 'frameSelection'],
      });
    }
  });

const negativeLabGenericPresetIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\.v[0-9]+$/u);

const negativeLabPresetHumanTextSchema = z.string().trim().min(1).max(280);

const unsafeGenericPresetClaimPattern =
  /\b(?:adobe|capture one|dehancer|ektachrome|ektar|exact|fujifilm|fuji|gold|identical|ilford|kodak|lightroom|mastin|manufacturer[ -]?approved|negative lab pro|nlp|official|portra|rni|tri-x|t-max|vsco)\b/iu;

export const negativeLabBuiltInPresetTierSchema = z.enum([
  'generic_builtin',
  'stock_family_reference',
  'measured_project_profile',
  'user_profile',
]);

export const negativeLabBuiltInPresetFilmClassSchema = z.enum(['color_negative', 'black_and_white_silver']);

export const negativeLabPresetProfileRefV1Schema = z
  .object({
    colorMode: z.enum(['color_negative_rgb', 'black_and_white_luminance']),
    normalizationProfileId: z.string().trim().min(1),
    normalizationProfileVersion: z.string().trim().min(1),
    processFamily: negativeLabSupportedProcessFamilyV1Schema,
    processProfileId: z.string().trim().min(1),
    processProfileVersion: z.string().trim().min(1),
  })
  .strict();

export const negativeLabBuiltInPresetV1Schema = z
  .object({
    claimLevel: z.enum(['generic_starting_point_only', 'reference_metadata_only', 'measured_profile']),
    deprecatedBy: negativeLabGenericPresetIdSchema.optional(),
    description: negativeLabPresetHumanTextSchema,
    displayName: negativeLabPresetHumanTextSchema,
    filmClass: negativeLabBuiltInPresetFilmClassSchema,
    intendedInputModes: z.array(negativeInputModeSchema).min(1),
    intent: z.enum(['neutral', 'portrait', 'high_speed', 'saturated', 'classic_bw', 'fine_grain_bw', 'ortho_bw']),
    legalNamingStatus: negativeLabLegalNamingStatusSchema,
    legalReviewStatus: z.enum(['not_required_generic', 'required_before_exact_name', 'approved']),
    normalizationProfileId: z.string().trim().min(1),
    normalizationProfileVersion: z.string().trim().min(1),
    presetId: negativeLabGenericPresetIdSchema,
    presetTier: negativeLabBuiltInPresetTierSchema,
    presetVersion: z.string().trim().min(1),
    processFamily: negativeLabSupportedProcessFamilyV1Schema,
    processProfileId: z.string().trim().min(1),
    processProfileVersion: z.string().trim().min(1),
    provenance: z
      .object({
        claimsPolicy: z.literal('generic_starting_point_only'),
        fixtureIds: z.array(z.string().trim().min(1)),
        legalNote: negativeLabPresetHumanTextSchema,
        measurementSource: negativeLabProfileMeasurementSourceSchema,
        sourceProfileIds: z.array(z.string().trim().min(1)),
      })
      .strict(),
    requiredWarningCodes: z.array(negativeWarningCodeSchema),
    scanAssumptions: z.array(negativeLabPresetHumanTextSchema).min(1),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    touchedParameters: z
      .object({
        creativeRendering: z.array(z.string().trim().min(1)),
        objectiveInversion: z.array(z.string().trim().min(1)),
        semiObjectiveNormalization: z.array(z.string().trim().min(1)),
      })
      .strict(),
  })
  .strict()
  .superRefine((preset, context) => {
    const humanFacingText = [
      preset.displayName,
      preset.description,
      preset.intent,
      preset.provenance.legalNote,
      ...preset.scanAssumptions,
    ].join(' ');

    if (unsafeGenericPresetClaimPattern.test(humanFacingText)) {
      context.addIssue({
        code: 'custom',
        message: 'Generic built-in presets must not use manufacturer, stock, competitor, or exact-emulation claims.',
        path: ['displayName'],
      });
    }

    if (unsafeGenericPresetClaimPattern.test(preset.presetId)) {
      context.addIssue({
        code: 'custom',
        message: 'Generic built-in preset IDs must not contain manufacturer or stock identifiers.',
        path: ['presetId'],
      });
    }

    if (preset.presetTier === 'generic_builtin' && preset.legalNamingStatus !== 'generic_safe_name') {
      context.addIssue({
        code: 'custom',
        message: 'Generic built-in presets must use generic-safe naming status.',
        path: ['legalNamingStatus'],
      });
    }

    if (
      preset.presetTier === 'generic_builtin' &&
      preset.provenance.measurementSource !== 'generic_engineered_starting_point'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Generic built-in presets must use generic engineered provenance, not measured-profile provenance.',
        path: ['provenance', 'measurementSource'],
      });
    }

    if (preset.touchedParameters.creativeRendering.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'Generic built-in presets must not declare creative rendering defaults before that schema exists.',
        path: ['touchedParameters', 'creativeRendering'],
      });
    }

    if (preset.intendedInputModes.includes('lab_jpeg')) {
      const requiredLabJpegWarnings = ['lossy_input', 'low_acquisition_confidence'] as const;
      for (const warningCode of requiredLabJpegWarnings) {
        if (!preset.requiredWarningCodes.includes(warningCode)) {
          context.addIssue({
            code: 'custom',
            message: 'Generic presets that allow lab JPEG input must require lossy-input and confidence warnings.',
            path: ['requiredWarningCodes'],
          });
        }
      }

      const labJpegAssumptionText = preset.scanAssumptions.join(' ');
      if (!/\breview\b/iu.test(labJpegAssumptionText)) {
        context.addIssue({
          code: 'custom',
          message: 'Generic presets that allow lab JPEG input must tell callers to review the rendered source.',
          path: ['scanAssumptions'],
        });
      }
    }
  });

export const negativeLabBuiltInPresetCatalogV1Schema = z
  .object({
    catalogId: negativeLabGenericPresetIdSchema,
    catalogVersion: z.string().trim().min(1),
    presets: z.array(negativeLabBuiltInPresetV1Schema).min(1),
    processProfileRefs: z.array(negativeLabPresetProfileRefV1Schema).min(1),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
  })
  .strict()
  .superRefine((catalog, context) => {
    addDuplicateFieldIssues({
      context,
      getPath: (index) => ['presets', index, 'presetId'],
      getValue: (preset) => preset.presetId,
      items: catalog.presets,
      message: 'Built-in preset catalog must not contain duplicate preset IDs.',
    });
    addDuplicateFieldIssues({
      context,
      getPath: (index) => ['presets', index, 'displayName'],
      getValue: (preset) => preset.displayName,
      items: catalog.presets,
      message: 'Built-in preset catalog must not contain duplicate display names.',
      normalize: normalizeEnglishKey,
    });

    const profileRefs = new Map<string, z.infer<typeof negativeLabPresetProfileRefV1Schema>>();

    for (const profileRef of catalog.processProfileRefs) {
      profileRefs.set(`${profileRef.processProfileId}@${profileRef.processProfileVersion}`, profileRef);
    }

    for (const [index, preset] of catalog.presets.entries()) {
      const profileRef = profileRefs.get(`${preset.processProfileId}@${preset.processProfileVersion}`);
      if (profileRef === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Built-in presets must reference a known process profile in the catalog.',
          path: ['presets', index, 'processProfileId'],
        });
        continue;
      }

      if (profileRef.processFamily !== preset.processFamily) {
        context.addIssue({
          code: 'custom',
          message: 'Built-in preset process family must match the referenced process profile.',
          path: ['presets', index, 'processFamily'],
        });
      }

      if (
        profileRef.normalizationProfileId !== preset.normalizationProfileId ||
        profileRef.normalizationProfileVersion !== preset.normalizationProfileVersion
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Built-in preset normalization profile must match the referenced process profile defaults.',
          path: ['presets', index, 'normalizationProfileId'],
        });
      }

      if (preset.filmClass === 'black_and_white_silver' && profileRef.colorMode !== 'black_and_white_luminance') {
        context.addIssue({
          code: 'custom',
          message: 'Black-and-white silver presets must reference luminance process profiles.',
          path: ['presets', index, 'filmClass'],
        });
      }

      if (preset.filmClass === 'color_negative' && profileRef.colorMode !== 'color_negative_rgb') {
        context.addIssue({
          code: 'custom',
          message: 'Color negative presets must reference RGB color process profiles.',
          path: ['presets', index, 'filmClass'],
        });
      }
    }
  });

export const negativeLabStockRegistryProcessFamilyV1Schema = z.enum([
  'black_and_white_silver_negative',
  'c41_color_negative',
  'ecn2_cinema_negative',
  'e6_color_reversal',
]);

export const negativeLabStockRegistryCategoryV1Schema = z.enum([
  'black_and_white',
  'cinema_negative',
  'color_negative',
  'color_reversal',
]);

export const negativeLabStockRegistryAvailabilityV1Schema = z.enum([
  'archival_common',
  'current_common',
  'specialty_or_region_limited',
]);

export const negativeLabStockRegistryClaimTierV1Schema = z.enum([
  'generic_family_starting_point',
  'reference_mapping_only',
  'measured_profile_required',
]);

export const negativeLabStockRegistryLegalNamingStatusV1Schema = z.enum([
  'descriptive_generic_only',
  'named_stock_reference_only',
  'legal_review_required',
]);

export const negativeLabStockRegistryFixtureStatusV1Schema = z.enum([
  'metadata_only',
  'fixture_needed',
  'measured_fixture_available',
]);

export const negativeLabStockRegistryProfileStatusV1Schema = z.enum([
  'measured',
  'heuristic',
  'placeholder',
  'needs_fixture',
]);

export const negativeLabStockRegistryIdV1Schema = z
  .string()
  .trim()
  .regex(/^negative_lab\.stock_family\.[a-z0-9_]+\.v[0-9]+$/u);

export const negativeLabStockRegistryEntryV1Schema = z
  .object({
    availability: negativeLabStockRegistryAvailabilityV1Schema,
    category: negativeLabStockRegistryCategoryV1Schema,
    claimTier: negativeLabStockRegistryClaimTierV1Schema,
    colorResponseNotes: z.string().trim().min(1).max(220),
    contrastCurveDescriptor: z.string().trim().min(1).max(120),
    fixtureStatus: negativeLabStockRegistryFixtureStatusV1Schema,
    genericPresetId: negativeLabGenericPresetIdSchema.nullable(),
    grainModelDescriptor: z.string().trim().min(1).max(120),
    isoClass: z.string().trim().min(1).max(80),
    legalNamingStatus: negativeLabStockRegistryLegalNamingStatusV1Schema,
    processFamily: negativeLabStockRegistryProcessFamilyV1Schema,
    profileStatus: negativeLabStockRegistryProfileStatusV1Schema,
    provenance: z
      .object({
        legalNote: z.string().trim().min(1).max(220),
        measurementSource: z.enum([
          'generic_engineered_starting_point',
          'project_owned_measurement',
          'research_reference_metadata_only',
        ]),
        sourceReferences: z.array(z.string().trim().min(1)).min(1),
      })
      .strict(),
    registryId: negativeLabStockRegistryIdV1Schema,
    sourceReferences: z.array(z.string().trim().min(1)).min(1),
    stockFamilyDescriptor: z.string().trim().min(1).max(120),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.claimTier === 'generic_family_starting_point' && entry.genericPresetId === null) {
      context.addIssue({
        code: 'custom',
        message: 'Generic stock-family starting points require a generic preset mapping.',
        path: ['genericPresetId'],
      });
    }

    if (entry.claimTier !== 'generic_family_starting_point' && entry.genericPresetId !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Reference-only or measured-required stock entries must not map to runtime presets yet.',
        path: ['genericPresetId'],
      });
    }

    if (entry.legalNamingStatus !== 'descriptive_generic_only' && entry.claimTier === 'generic_family_starting_point') {
      context.addIssue({
        code: 'custom',
        message: 'Runtime generic stock-family mappings must use descriptive generic naming.',
        path: ['legalNamingStatus'],
      });
    }

    if (entry.fixtureStatus === 'measured_fixture_available' && entry.profileStatus !== 'measured') {
      context.addIssue({
        code: 'custom',
        message: 'Measured stock fixtures must report measured registry status.',
        path: ['profileStatus'],
      });
    }

    if (entry.profileStatus === 'measured' && entry.provenance.measurementSource !== 'project_owned_measurement') {
      context.addIssue({
        code: 'custom',
        message: 'Measured stock registry entries require project-owned measurement provenance.',
        path: ['provenance', 'measurementSource'],
      });
    }

    if (
      entry.profileStatus === 'heuristic' &&
      (entry.claimTier !== 'generic_family_starting_point' ||
        entry.fixtureStatus !== 'fixture_needed' ||
        entry.provenance.measurementSource !== 'generic_engineered_starting_point')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Heuristic stock-family rows must be generic runtime starting points awaiting fixtures.',
        path: ['profileStatus'],
      });
    }

    if (
      entry.profileStatus === 'placeholder' &&
      (entry.claimTier === 'generic_family_starting_point' || entry.fixtureStatus !== 'metadata_only')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Placeholder stock-family rows must remain metadata-only and non-runtime.',
        path: ['profileStatus'],
      });
    }

    if (
      entry.profileStatus === 'needs_fixture' &&
      (entry.claimTier === 'generic_family_starting_point' || entry.fixtureStatus !== 'metadata_only')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Needs-fixture stock-family rows must remain metadata-only and non-runtime.',
        path: ['profileStatus'],
      });
    }

    if (entry.provenance.sourceReferences.join('\n') !== entry.sourceReferences.join('\n')) {
      context.addIssue({
        code: 'custom',
        message: 'Registry provenance source references must mirror the top-level source references.',
        path: ['provenance', 'sourceReferences'],
      });
    }
  });

export const negativeLabStockRegistryV1Schema = z
  .object({
    entries: z.array(negativeLabStockRegistryEntryV1Schema).min(1),
    registryId: z.literal('negative_lab_stock_registry'),
    registryVersion: z.string().trim().min(1),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
  })
  .strict()
  .superRefine((registry, context) => {
    const ids = new Set<string>();
    const requiredCategories = ['black_and_white', 'cinema_negative', 'color_negative', 'color_reversal'] as const;

    for (const [index, entry] of registry.entries.entries()) {
      if (ids.has(entry.registryId)) {
        context.addIssue({
          code: 'custom',
          message: 'Negative Lab stock registry entries must be unique.',
          path: ['entries', index, 'registryId'],
        });
      }
      ids.add(entry.registryId);
    }

    for (const category of requiredCategories) {
      if (!registry.entries.some((entry) => entry.category === category)) {
        context.addIssue({
          code: 'custom',
          message: `Negative Lab stock registry requires ${category} coverage.`,
          path: ['entries'],
        });
      }
    }
  });

const negativeLabPresetPolicyIdSchema = z
  .string()
  .trim()
  .regex(/^negative_lab\.preset_policy\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\.v[0-9]+$/u);

export const negativeLabPresetMetadataPolicyClaimLevelV1Schema = z.enum([
  'generic_starting_point_only',
  'stock_family_reference_metadata',
  'measured_project_profile',
  'licensed_exact_profile',
  'user_supplied_profile',
  'blocked_or_unsupported',
]);

export const negativeLabPresetMetadataPolicyTierV1Schema = z.enum([
  'generic_builtin',
  'stock_family_reference',
  'measured_project_profile',
  'licensed_profile',
  'user_profile',
  'blocked',
]);

export const negativeLabPresetMetadataLegalReviewStatusV1Schema = z.enum([
  'not_required_generic',
  'required_before_ui',
  'approved',
  'blocked',
]);

export const negativeLabPresetMetadataUiContextV1Schema = z.enum([
  'negative_lab_workspace',
  'preset_browser',
  'app_server_tool',
  'export_sidecar',
  'admin_review_queue',
]);

export const negativeLabPresetMetadataPolicyV1Schema = z
  .object({
    allowedClaims: z
      .object({
        competitorCompatibilityClaim: z.boolean(),
        exactStockName: z.boolean(),
        manufacturerEndorsement: z.boolean(),
        manufacturerName: z.boolean(),
        measuredBehavior: z.boolean(),
        officialProfile: z.boolean(),
      })
      .strict(),
    allowedInputModes: z.array(negativeInputModeSchema).min(1),
    allowedUiContexts: z.array(negativeLabPresetMetadataUiContextV1Schema).min(1),
    claimLevel: negativeLabPresetMetadataPolicyClaimLevelV1Schema,
    displayCopy: z
      .object({
        disclosure: negativeLabPresetHumanTextSchema,
        label: negativeLabPresetHumanTextSchema,
      })
      .strict(),
    legalNamingStatus: negativeLabLegalNamingStatusSchema,
    legalReviewStatus: negativeLabPresetMetadataLegalReviewStatusV1Schema,
    policyId: negativeLabPresetPolicyIdSchema,
    policyVersion: z.string().trim().min(1),
    presetTier: negativeLabPresetMetadataPolicyTierV1Schema,
    prohibitedClaimPhrases: z.array(z.string().trim().min(1)).min(1),
    requiredWarnings: z.array(negativeWarningCodeSchema),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sourceRequirements: z
      .object({
        fixtureIds: z.array(z.string().trim().min(1)),
        legalReviewIssue: z.string().trim().min(1).optional(),
        licenseRecordIds: z.array(z.string().trim().min(1)),
        reviewedAt: z
          .string()
          .trim()
          .regex(/^\d{4}-\d{2}-\d{2}$/u)
          .optional(),
        reviewer: z.string().trim().min(1).optional(),
        sourceCitationIds: z.array(z.string().trim().min(1)),
      })
      .strict(),
    supportedProcessFamilies: z.array(negativeLabSupportedProcessFamilyV1Schema).min(1),
  })
  .strict()
  .superRefine((policy, context) => {
    const addPolicyIssue = (message: string, path: Array<string | number>) => {
      context.addIssue({ code: 'custom', message, path });
    };

    const hasLegalReviewRecord =
      policy.sourceRequirements.legalReviewIssue !== undefined &&
      policy.sourceRequirements.reviewedAt !== undefined &&
      policy.sourceRequirements.reviewer !== undefined;

    if (policy.claimLevel === 'generic_starting_point_only' || policy.presetTier === 'generic_builtin') {
      if (policy.claimLevel !== 'generic_starting_point_only' || policy.presetTier !== 'generic_builtin') {
        addPolicyIssue('Generic preset metadata policies must pair generic tier with generic claim level.', [
          'claimLevel',
        ]);
      }

      if (policy.legalNamingStatus !== 'generic_safe_name') {
        addPolicyIssue('Generic preset metadata policies must use generic-safe naming status.', ['legalNamingStatus']);
      }

      if (policy.legalReviewStatus !== 'not_required_generic') {
        addPolicyIssue('Generic preset metadata policies must not require legal review.', ['legalReviewStatus']);
      }

      const genericDisallowedClaims = [
        policy.allowedClaims.competitorCompatibilityClaim,
        policy.allowedClaims.exactStockName,
        policy.allowedClaims.manufacturerEndorsement,
        policy.allowedClaims.manufacturerName,
        policy.allowedClaims.measuredBehavior,
        policy.allowedClaims.officialProfile,
      ];
      if (genericDisallowedClaims.some(Boolean)) {
        addPolicyIssue(
          'Generic preset metadata policies must not allow exact, manufacturer, measured, or official claims.',
          ['allowedClaims'],
        );
      }
    }

    if (policy.claimLevel === 'stock_family_reference_metadata') {
      if (policy.presetTier !== 'stock_family_reference') {
        addPolicyIssue('Stock-family reference policies must use the stock-family reference tier.', ['presetTier']);
      }

      if (policy.legalNamingStatus !== 'descriptive_stock_family') {
        addPolicyIssue('Stock-family reference policies must use descriptive stock-family naming.', [
          'legalNamingStatus',
        ]);
      }

      if (policy.sourceRequirements.sourceCitationIds.length === 0) {
        addPolicyIssue('Stock-family reference policies require source citations.', [
          'sourceRequirements',
          'sourceCitationIds',
        ]);
      }

      if (policy.allowedClaims.exactStockName || policy.allowedClaims.manufacturerEndorsement) {
        addPolicyIssue('Stock-family reference policies must not allow exact stock or endorsement claims.', [
          'allowedClaims',
        ]);
      }
    }

    if (policy.claimLevel === 'measured_project_profile') {
      if (policy.presetTier !== 'measured_project_profile') {
        addPolicyIssue('Measured project policies must use the measured-project tier.', ['presetTier']);
      }

      if (!policy.allowedClaims.measuredBehavior) {
        addPolicyIssue('Measured project policies must allow measured-behavior claims.', [
          'allowedClaims',
          'measuredBehavior',
        ]);
      }

      if (policy.sourceRequirements.fixtureIds.length === 0) {
        addPolicyIssue('Measured project policies require fixture IDs.', ['sourceRequirements', 'fixtureIds']);
      }
    }

    if (policy.claimLevel === 'licensed_exact_profile') {
      if (policy.presetTier !== 'licensed_profile') {
        addPolicyIssue('Licensed exact policies must use the licensed-profile tier.', ['presetTier']);
      }

      if (policy.legalNamingStatus !== 'approved_exact_stock_name') {
        addPolicyIssue('Licensed exact policies require approved exact-stock naming.', ['legalNamingStatus']);
      }

      if (policy.legalReviewStatus !== 'approved' || !hasLegalReviewRecord) {
        addPolicyIssue('Licensed exact policies require approved legal review metadata.', ['legalReviewStatus']);
      }

      if (policy.sourceRequirements.licenseRecordIds.length === 0) {
        addPolicyIssue('Licensed exact policies require license record IDs.', [
          'sourceRequirements',
          'licenseRecordIds',
        ]);
      }
    }

    if (policy.claimLevel === 'user_supplied_profile' && policy.presetTier !== 'user_profile') {
      addPolicyIssue('User supplied policies must use the user-profile tier.', ['presetTier']);
    }

    if (policy.claimLevel === 'blocked_or_unsupported') {
      if (policy.presetTier !== 'blocked' || policy.legalReviewStatus !== 'blocked') {
        addPolicyIssue('Blocked preset policies must use blocked tier and blocked review status.', ['presetTier']);
      }

      if (policy.allowedUiContexts.some((contextName) => contextName !== 'admin_review_queue')) {
        addPolicyIssue('Blocked preset policies may only appear in the admin review queue.', ['allowedUiContexts']);
      }
    }

    if (policy.allowedClaims.manufacturerEndorsement && policy.claimLevel !== 'licensed_exact_profile') {
      addPolicyIssue('Manufacturer endorsement claims require a licensed exact policy.', [
        'allowedClaims',
        'manufacturerEndorsement',
      ]);
    }

    if (policy.allowedClaims.officialProfile || policy.allowedClaims.competitorCompatibilityClaim) {
      addPolicyIssue(
        'Official-profile and competitor-compatibility claims are not allowed in RawEngine preset metadata.',
        ['allowedClaims'],
      );
    }
  });

export const negativeLabPresetMetadataPolicyCatalogV1Schema = z
  .object({
    catalogId: negativeLabPresetPolicyIdSchema,
    catalogVersion: z.string().trim().min(1),
    policies: z.array(negativeLabPresetMetadataPolicyV1Schema).min(1),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
  })
  .strict()
  .superRefine((catalog, context) => {
    addDuplicateFieldIssues({
      context,
      getPath: (index) => ['policies', index, 'policyId'],
      getValue: (policy) => policy.policyId,
      items: catalog.policies,
      message: 'Preset metadata policy catalog must not contain duplicate policy IDs.',
    });
    addDuplicateFieldIssues({
      context,
      getPath: (index) => ['policies', index, 'displayCopy', 'label'],
      getValue: (policy) => policy.displayCopy.label,
      items: catalog.policies,
      message: 'Preset metadata policy catalog must not contain duplicate display labels.',
      normalize: normalizeEnglishKey,
    });
  });

const filmLookRecipeIdSchema = z
  .string()
  .trim()
  .regex(/^film_look\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\.v[0-9]+$/u);

const filmLookHumanTextSchema = z.string().trim().min(1).max(280);

export const filmLookRecipeCategoryV1Schema = z.enum([
  'color_clean',
  'color_warm',
  'color_cool',
  'color_contrast',
  'color_fade',
  'black_and_white',
]);

export const filmLookClaimLevelV1Schema = z.enum([
  'generic_engineered',
  'stock_family_reference_metadata',
  'measured_project_profile',
  'licensed_exact_profile',
  'user_supplied_profile',
]);

export const filmLookProvenanceV1Schema = z
  .object({
    claimLevel: filmLookClaimLevelV1Schema,
    fixtureIds: z.array(z.string().trim().min(1)),
    legalNamingStatus: negativeLabLegalNamingStatusSchema,
    legalNote: filmLookHumanTextSchema,
    licenseRecordIds: z.array(z.string().trim().min(1)),
    measurementSource: negativeLabProfileMeasurementSourceSchema,
    sourceCitationIds: z.array(z.string().trim().min(1)),
    sourceProfileIds: z.array(z.string().trim().min(1)),
  })
  .strict();

export const filmLookNodeKindV1Schema = z.enum([
  'tone_curve',
  'color_matrix',
  'channel_mixer',
  'split_tone',
  'grain',
  'halation',
  'glow',
  'black_and_white_mixer',
  'lut_reference',
]);

export const filmLookNodeStageV1Schema = z.enum([
  'creative_color_rendering',
  'texture_rendering',
  'output_conditioning',
]);

const filmLookNodeParameterValueV1Schema = z.union([
  z.boolean(),
  z.number(),
  z.string().trim().min(1),
  z.array(z.number()).min(1),
]);

export const filmLookNodeV1Schema = z
  .object({
    enabledByDefault: z.boolean(),
    nodeId: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u),
    nodeKind: filmLookNodeKindV1Schema,
    parameters: z.record(z.string(), filmLookNodeParameterValueV1Schema),
    renderStage: filmLookNodeStageV1Schema,
  })
  .strict();

export const filmLookRecipeV1Schema = z
  .object({
    category: filmLookRecipeCategoryV1Schema,
    deprecatedBy: filmLookRecipeIdSchema.optional(),
    description: filmLookHumanTextSchema,
    displayName: filmLookHumanTextSchema,
    intendedInputModes: z.array(z.enum(['raw_photo', 'rendered_photo', 'negative_lab_positive'])).min(1),
    lookId: filmLookRecipeIdSchema,
    lookVersion: z.string().trim().min(1),
    nodes: z.array(filmLookNodeV1Schema).min(1),
    provenance: filmLookProvenanceV1Schema,
    renderDomain: filmRenderDomainV1Schema,
    requiredWarnings: z.array(
      z.enum(['creative_not_exact_emulation', 'display_referred_input', 'requires_user_review']),
    ),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    strengthDefault: z.number().min(0).max(100),
  })
  .strict()
  .superRefine((look, context) => {
    const humanFacingText = [look.displayName, look.description, look.category, look.provenance.legalNote].join(' ');

    if (look.provenance.claimLevel === 'generic_engineered') {
      if (unsafeGenericPresetClaimPattern.test(humanFacingText) || unsafeGenericPresetClaimPattern.test(look.lookId)) {
        context.addIssue({
          code: 'custom',
          message:
            'Generic built-in film looks must not use manufacturer, stock, competitor, or exact-emulation claims.',
          path: ['displayName'],
        });
      }

      if (look.provenance.legalNamingStatus !== 'generic_safe_name') {
        context.addIssue({
          code: 'custom',
          message: 'Generic built-in film looks must use generic-safe naming status.',
          path: ['provenance', 'legalNamingStatus'],
        });
      }

      if (look.provenance.measurementSource !== 'generic_engineered_starting_point') {
        context.addIssue({
          code: 'custom',
          message: 'Generic built-in film looks must use generic engineered provenance.',
          path: ['provenance', 'measurementSource'],
        });
      }

      if (look.provenance.licenseRecordIds.length > 0 || look.provenance.sourceCitationIds.length > 0) {
        context.addIssue({
          code: 'custom',
          message: 'Generic built-in film looks must not imply licensed or source-measured provenance.',
          path: ['provenance'],
        });
      }
    }

    addDuplicateFieldIssues({
      context,
      getPath: (index) => ['nodes', index, 'nodeId'],
      getValue: (node) => node.nodeId,
      items: look.nodes,
      message: 'Film look recipes must not contain duplicate node IDs.',
    });

    for (const [index, node] of look.nodes.entries()) {
      if (node.nodeKind === 'lut_reference' && node.parameters['assetId'] === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'LUT reference nodes require an assetId parameter.',
          path: ['nodes', index, 'parameters'],
        });
      }
    }
  });

export const filmLookCatalogV1Schema = z
  .object({
    catalogId: filmLookRecipeIdSchema,
    catalogVersion: z.string().trim().min(1),
    looks: z.array(filmLookRecipeV1Schema).min(1),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
  })
  .strict()
  .superRefine((catalog, context) => {
    addDuplicateFieldIssues({
      context,
      getPath: (index) => ['looks', index, 'lookId'],
      getValue: (look) => look.lookId,
      items: catalog.looks,
      message: 'Film look catalog must not contain duplicate look IDs.',
    });
    addDuplicateFieldIssues({
      context,
      getPath: (index) => ['looks', index, 'displayName'],
      getValue: (look) => look.displayName,
      items: catalog.looks,
      message: 'Film look catalog must not contain duplicate display names.',
      normalize: normalizeEnglishKey,
    });
  });

const contentHashSchema = z
  .string()
  .trim()
  .regex(/^sha256:[a-f0-9]{64}$/u);
const isoDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/u);
const negativeLabFixtureIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u);

export const negativeLabSampleGeometryV1Schema = z
  .object({
    coordinateSpace: z.enum(['source_asset_pixels', 'frame_pixels_after_crop', 'normalized_frame']),
    height: z.number().positive().optional(),
    kind: z.enum(['rect', 'polygon']),
    points: z.array(z.object({ x: z.number(), y: z.number() }).strict()).optional(),
    width: z.number().positive().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  })
  .strict()
  .superRefine((geometry, context) => {
    if (geometry.kind === 'rect') {
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        if (geometry[key] === undefined) {
          context.addIssue({
            code: 'custom',
            message: `Rect sample geometry requires ${key}.`,
            path: [key],
          });
        }
      }
    }

    if (geometry.kind === 'polygon' && (geometry.points === undefined || geometry.points.length < 3)) {
      context.addIssue({
        code: 'custom',
        message: 'Polygon sample geometry requires at least three points.',
        path: ['points'],
      });
    }
  });

export const negativeLabFixtureStateV1Schema = z.enum([
  'candidate',
  'review_pending',
  'approved_metadata_only',
  'approved_smoke',
  'approved_numeric',
  'approved_profile_measurement',
  'deprecated',
  'blocked',
]);

export const negativeLabFixtureTierV1Schema = z.enum([
  'synthetic_numeric',
  'synthetic_visual',
  'project_owned_scan',
  'permissive_public_scan',
  'licensed_scan',
  'local_private_scan',
  'registry_metadata_only',
]);

export const negativeLabFixtureRoleV1Schema = z.enum([
  'density_math_reference',
  'warning_stability',
  'ui_overlay_smoke',
  'roll_consistency',
  'profile_measurement',
  'stock_reference_mapping',
]);

export const negativeLabFixtureValidationUseV1Schema = z.enum([
  'schema_roundtrip',
  'ui_overlay_smoke',
  'density_math_reference',
  'warning_stability',
  'roll_consistency',
  'profile_measurement',
  'stock_reference_mapping',
  'marketing_screenshot',
]);

export const negativeLabFixtureDistributionV1Schema = z.enum([
  'none',
  'private_local_only',
  'private_ci_only',
  'public_repo',
  'release_artifact',
]);

export const negativeLabFixtureWarningCodeV1Schema = z.enum([
  'missing_fixture_license',
  'unknown_fixture_rights',
  'fixture_payload_not_public',
  'fixture_setup_unknown',
  'fixture_stock_unverified',
  'fixture_process_unverified',
  'fixture_auto_correction_unknown',
  'fixture_profile_claim_disallowed',
  'fixture_derivative_not_allowed',
  'fixture_review_expired',
]);

export const negativeLabFixtureSourceV1Schema = z
  .object({
    copyrightOwner: z.string().trim().min(1),
    licenseName: z.string().trim().min(1).optional(),
    licenseUrl: z.url().optional(),
    redistributionEvidence: z.string().trim().min(1).optional(),
    sourceKind: z.enum([
      'project_owned',
      'generated_synthetic',
      'permissive_public',
      'licensed_third_party',
      'local_private',
      'registry_metadata_only',
    ]),
    sourceUrl: z.url().optional(),
  })
  .strict()
  .superRefine((source, context) => {
    if (
      ['permissive_public', 'licensed_third_party'].includes(source.sourceKind) &&
      (source.sourceUrl === undefined ||
        source.licenseName === undefined ||
        source.redistributionEvidence === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Public or licensed fixture sources require a source URL, license name, and redistribution evidence.',
        path: ['sourceUrl'],
      });
    }
  });

export const negativeLabCleanRoomProvenanceV1Schema = z
  .object({
    cleanRoomPolicy: z.literal('rawengine_owned_clean_room_v1'),
    externalConceptReferences: z.array(z.string().trim().min(1)),
    implementationOwner: z.literal('RawEngine project'),
    negPyArtifactUse: z.literal('none'),
    sourceArtifactBasis: z.enum([
      'rawengine_generated_synthetic_math_fixture',
      'rawengine_local_private_metadata',
      'rawengine_project_owned_scan_metadata',
      'rawengine_registry_metadata',
      'rawengine_private_ci_metadata',
    ]),
    thirdPartyCodeCopied: z.literal(false),
    thirdPartyConstantsCopied: z.literal(false),
    thirdPartyDocsCopied: z.literal(false),
    thirdPartyTestVectorsCopied: z.literal(false),
  })
  .strict()
  .superRefine((provenance, context) => {
    if (!provenance.externalConceptReferences.includes('NegPy concepts only')) {
      context.addIssue({
        code: 'custom',
        message: 'Negative Lab clean-room provenance must record NegPy as concepts-only inspiration.',
        path: ['externalConceptReferences'],
      });
    }
  });

export const negativeLabMeasuredProfileEvidenceV1Schema = z
  .object({
    baseFogSampleCount: z.number().int().positive(),
    claimPolicy: z.enum(['process_family_profile_no_stock_claim', 'named_stock_profile_requires_license_review']),
    deltaE: z
      .object({
        max: z.number().min(0),
        mean: z.number().min(0),
        percentile95: z.number().min(0),
      })
      .strict(),
    measurementDate: isoDateSchema,
    measurementReportHash: contentHashSchema,
    measurementSoftware: z.string().trim().min(1),
    operator: z.string().trim().min(1),
    profileId: z
      .string()
      .trim()
      .regex(/^negative_lab\.measured\.[a-z0-9_]+\.[a-z0-9_]+\.v[0-9]+$/u),
    sourceFixtureIds: z.array(negativeLabFixtureIdSchema).min(1),
    targetReference: z
      .object({
        id: z.string().trim().min(1),
        patchCount: z.number().int().min(12),
        referenceHash: contentHashSchema,
        type: z.enum(['it8_transparency', 'colorchecker_sg', 'step_wedge', 'project_synthetic_target']),
      })
      .strict(),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (evidence.deltaE.mean > evidence.deltaE.percentile95 || evidence.deltaE.percentile95 > evidence.deltaE.max) {
      context.addIssue({
        code: 'custom',
        message: 'Measured profile Delta E summary must be ordered mean <= p95 <= max.',
        path: ['deltaE'],
      });
    }
  });

export const negativeLabFixtureManifestEntryV1Schema = z
  .object({
    allowedDistribution: negativeLabFixtureDistributionV1Schema,
    allowedValidationUses: z.array(negativeLabFixtureValidationUseV1Schema),
    autoCorrectionBakedIn: z.enum(['known_absent', 'known_present', 'unknown']),
    baseFogSampleRegions: z.array(negativeLabSampleGeometryV1Schema),
    bitDepth: z.number().int().positive(),
    captureProfile: z.string().trim().min(1),
    colorProfile: z.string().trim().min(1),
    contentHash: contentHashSchema.optional(),
    cleanRoomProvenance: negativeLabCleanRoomProvenanceV1Schema,
    derivativeDistributionAllowed: z.boolean(),
    developmentNotes: z.string().trim().min(1),
    developmentProcessKnown: z.boolean(),
    disallowedValidationUses: z.array(negativeLabFixtureValidationUseV1Schema),
    expectedFixtureWarningCodes: z.array(negativeLabFixtureWarningCodeV1Schema),
    expectedNegativeWarningCodes: z.array(negativeWarningCodeSchema),
    fileFormat: z.enum(['raw', 'dng', 'tiff', 'jpeg', 'png', 'json', 'synthetic_generated']),
    filmStockDisplayName: z.string().trim().min(1),
    filmStockKnown: z.boolean(),
    filmStockSource: z.string().trim().min(1),
    fixtureId: negativeLabFixtureIdSchema,
    fixtureRole: negativeLabFixtureRoleV1Schema,
    frameFormat: z.string().trim().min(1),
    generatorId: z.string().trim().min(1).optional(),
    lens: z.string().trim().min(1),
    lightSource: z.string().trim().min(1),
    lossyCompression: z.boolean(),
    measurementClaimAllowed: z.boolean(),
    measuredProfileEvidence: negativeLabMeasuredProfileEvidenceV1Schema.optional(),
    negativeFixtureTier: negativeLabFixtureTierV1Schema,
    payloadAccess: z.enum([
      'metadata_only',
      'generated_in_repo',
      'committed_public_payload',
      'private_ci_payload',
      'local_only_payload',
    ]),
    processFamily: negativeProcessFamilySchema,
    profileClaimAllowed: z.boolean(),
    rejectedSampleRegions: z.array(negativeLabSampleGeometryV1Schema),
    reviewIssue: z.string().trim().min(1).optional(),
    reviewedAt: isoDateSchema.optional(),
    reviewer: z.string().trim().min(1).optional(),
    rollOrSheetIdentifier: z.string().trim().min(1),
    scanInputMode: negativeInputModeSchema,
    scannerOrCamera: z.string().trim().min(1),
    scannerSoftware: z.string().trim().min(1),
    scannerSoftwareSettingsKnown: z.boolean(),
    source: negativeLabFixtureSourceV1Schema,
    state: negativeLabFixtureStateV1Schema,
    targetOrStepWedgePresent: z.boolean(),
  })
  .strict()
  .superRefine((fixture, context) => {
    const approvedStates = [
      'approved_metadata_only',
      'approved_smoke',
      'approved_numeric',
      'approved_profile_measurement',
    ];
    if (approvedStates.includes(fixture.state)) {
      for (const key of ['reviewIssue', 'reviewedAt', 'reviewer'] as const) {
        if (fixture[key] === undefined) {
          context.addIssue({
            code: 'custom',
            message: 'Approved negative-lab fixtures require review issue, reviewer, and review date.',
            path: [key],
          });
        }
      }
    }

    if (
      fixture.allowedDistribution === 'public_repo' &&
      (!fixture.derivativeDistributionAllowed || fixture.contentHash === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Public fixture distribution requires derivative rights and a content hash.',
        path: ['allowedDistribution'],
      });
    }

    if (
      fixture.source.sourceKind === 'generated_synthetic' &&
      fixture.cleanRoomProvenance.sourceArtifactBasis !== 'rawengine_generated_synthetic_math_fixture'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Generated synthetic Negative Lab fixtures must use RawEngine-owned synthetic math provenance.',
        path: ['cleanRoomProvenance', 'sourceArtifactBasis'],
      });
    }

    if (
      fixture.source.sourceKind !== 'generated_synthetic' &&
      fixture.cleanRoomProvenance.sourceArtifactBasis === 'rawengine_generated_synthetic_math_fixture'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Non-synthetic Negative Lab fixtures must not claim synthetic math fixture provenance.',
        path: ['cleanRoomProvenance', 'sourceArtifactBasis'],
      });
    }

    if (
      fixture.payloadAccess === 'committed_public_payload' &&
      (fixture.allowedDistribution !== 'public_repo' || fixture.contentHash === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Committed public fixture payloads require public distribution rights and a content hash.',
        path: ['payloadAccess'],
      });
    }

    if (fixture.scanInputMode === 'lab_jpeg') {
      for (const warningCode of ['lossy_input', 'low_acquisition_confidence'] as const) {
        if (!fixture.expectedNegativeWarningCodes.includes(warningCode)) {
          context.addIssue({
            code: 'custom',
            message: 'Lab JPEG fixtures must declare lossy-input and low-confidence expected warnings.',
            path: ['expectedNegativeWarningCodes'],
          });
        }
      }
    }

    if (fixture.allowedValidationUses.includes('profile_measurement')) {
      const profileEligibleTier = ['project_owned_scan', 'licensed_scan'].includes(fixture.negativeFixtureTier);
      if (
        fixture.state !== 'approved_profile_measurement' ||
        !profileEligibleTier ||
        !fixture.targetOrStepWedgePresent ||
        fixture.measuredProfileEvidence === undefined ||
        !fixture.measurementClaimAllowed ||
        !fixture.profileClaimAllowed
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Profile measurement fixtures require approved measured state, eligible source tier, target data, and claim approval.',
          path: ['allowedValidationUses'],
        });
      }
    }

    if (
      (fixture.state === 'approved_profile_measurement' ||
        fixture.measurementClaimAllowed ||
        fixture.profileClaimAllowed) &&
      fixture.measuredProfileEvidence === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Measured profile state or claim approval requires measured-profile evidence.',
        path: ['measuredProfileEvidence'],
      });
    }

    if (fixture.profileClaimAllowed && !fixture.measurementClaimAllowed) {
      context.addIssue({
        code: 'custom',
        message: 'Profile claim approval requires measurement claim approval.',
        path: ['profileClaimAllowed'],
      });
    }

    if (
      fixture.measuredProfileEvidence?.claimPolicy === 'named_stock_profile_requires_license_review' &&
      (!fixture.filmStockKnown ||
        fixture.source.sourceKind === 'generated_synthetic' ||
        fixture.source.sourceKind === 'registry_metadata_only' ||
        fixture.reviewIssue === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Named-stock measured profiles require known stock, non-synthetic source, and review issue.',
        path: ['measuredProfileEvidence', 'claimPolicy'],
      });
    }

    for (const validationUse of fixture.allowedValidationUses) {
      if (fixture.disallowedValidationUses.includes(validationUse)) {
        context.addIssue({
          code: 'custom',
          message: 'Fixture validation uses cannot be both allowed and disallowed.',
          path: ['allowedValidationUses'],
        });
      }
    }
  });

export const negativeLabFixtureManifestV1Schema = z
  .object({
    entries: z.array(negativeLabFixtureManifestEntryV1Schema).min(1),
    manifestId: z.string().trim().min(1),
    manifestVersion: z.string().trim().min(1),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
  })
  .strict()
  .superRefine((manifest, context) => {
    addDuplicateFieldIssues({
      context,
      getPath: (index) => ['entries', index, 'fixtureId'],
      getValue: (fixture) => fixture.fixtureId,
      items: manifest.entries,
      message: 'Negative-lab fixture manifests must not contain duplicate fixture IDs.',
    });
  });

const normalizedScoreSchema = z.number().min(0).max(1);

export const negativeAcquisitionProfileV1Schema = z
  .object({
    acquisitionConfidence: negativeAcquisitionConfidenceSchema,
    autoColorSuspected: z.boolean(),
    autoContrastSuspected: z.boolean(),
    autoExposureSuspected: z.boolean(),
    bitDepth: z.number().int().positive().optional(),
    captureDeviceName: z.string().trim().min(1).optional(),
    captureDeviceType: z.enum(['camera', 'flatbed_scanner', 'lab_scanner', 'unknown']),
    channelClippingScore: normalizedScoreSchema,
    compressionArtifactScore: normalizedScoreSchema,
    compressionKind: z.enum(['none', 'lossless', 'lossy', 'unknown']),
    createdFrom: z.string().trim().min(1),
    diffuserOrHolderNotes: z.string().trim().min(1).optional(),
    dustRemovalSuspected: z.boolean(),
    embeddedProfileSummary: z.string().trim().min(1).optional(),
    fileFormat: z.enum(['raw', 'dng', 'tiff', 'png', 'jpeg', 'unknown']),
    filmHolderType: z.string().trim().min(1).optional(),
    frameSpacingState: z.enum(['single_frame', 'regular_strip', 'irregular_strip', 'contact_sheet', 'unknown']),
    inputMode: negativeInputModeSchema,
    inputProfileId: z.string().trim().min(1).optional(),
    inputProfileSource: z.enum([
      'explicit_project_profile',
      'embedded_icc',
      'raw_decoder_camera_profile',
      'generic_assumption',
      'assumed_display_profile',
      'unknown',
    ]),
    inputProfileVersion: z.string().trim().min(1).optional(),
    irCleaningSuspected: z.boolean(),
    lensModel: z.string().trim().min(1).optional(),
    lightSourceCct: z.number().int().positive().optional(),
    lightSourceConfidence: negativeAcquisitionConfidenceSchema,
    lightSourceType: z.enum(['led_panel', 'flash', 'enlarger', 'scanner', 'lab_unknown', 'unknown']),
    pixelBasis: negativePixelBasisSchema,
    preInversionSuspected: z.boolean(),
    profileConfidence: negativeAcquisitionConfidenceSchema,
    profileId: z.string().trim().min(1),
    rebateOrBorderState: z.enum(['visible', 'partially_visible', 'cropped_out', 'unknown']),
    reviewedAt: z.string().trim().min(1).optional(),
    scannerOrCameraModel: z.string().trim().min(1).optional(),
    scannerSoftware: z.string().trim().min(1).optional(),
    scannerSoftwareVersion: z.string().trim().min(1).optional(),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sharpeningSuspected: z.boolean(),
    unevenIlluminationScore: normalizedScoreSchema,
    visibleBaseState: z.enum(['visible', 'partially_visible', 'not_visible', 'unknown']),
    warnings: z.array(negativeWarningV1Schema),
  })
  .strict();

export const negativeLabInputProfileKindV1Schema = z.enum([
  'camera_raw_input',
  'camera_scan_input',
  'scanner_input',
  'lab_rendered_input',
  'manual_assumption',
]);

export const negativeLabInputProfileSourceV1Schema = z.enum([
  'embedded_icc',
  'camera_dcp',
  'scanner_icc',
  'raw_decoder_camera_profile',
  'user_assigned_icc',
  'generated_synthetic_profile',
  'assumed_display_profile',
  'unknown',
]);

export const negativeLabInputProfileV1Schema = z
  .object({
    acquisitionConfidence: negativeAcquisitionConfidenceSchema,
    captureDeviceType: z.enum(['camera', 'flatbed_scanner', 'film_scanner', 'lab_scanner', 'unknown']),
    colorSpaceEncoding: z.enum([
      'camera_raw_native',
      'linear_rgb',
      'scanner_rgb',
      'lab_rendered_rgb',
      'display_referred_rgb',
      'unknown',
    ]),
    defaultInputMode: negativeInputModeSchema,
    description: z.string().trim().min(1),
    displayName: z.string().trim().min(1),
    expectedPixelBasis: negativePixelBasisSchema,
    fileExtensions: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[a-z0-9]+$/u),
      )
      .min(1),
    inputProfileKind: negativeLabInputProfileKindV1Schema,
    inputProfileSource: negativeLabInputProfileSourceV1Schema,
    profileConfidence: negativeAcquisitionConfidenceSchema,
    profileId: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\.v[0-9]+$/u),
    profileVersion: z.string().trim().min(1),
    provenance: z
      .object({
        contentHash: z.string().trim().min(1).optional(),
        legalNote: z.string().trim().min(1),
        sourceDescription: z.string().trim().min(1),
      })
      .strict(),
    requiredWarningCodes: z.array(negativeWarningCodeSchema),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    supportedInputModes: z.array(negativeInputModeSchema).min(1),
    supportedProcessFamilies: z.array(negativeLabSupportedProcessFamilyV1Schema).min(1),
  })
  .strict()
  .superRefine((profile, context) => {
    if (!profile.supportedInputModes.includes(profile.defaultInputMode)) {
      context.addIssue({
        code: 'custom',
        message: 'Default input mode must be included in supported input modes.',
        path: ['defaultInputMode'],
      });
    }

    if (
      profile.inputProfileKind === 'camera_raw_input' &&
      (profile.defaultInputMode !== 'camera_raw' || profile.colorSpaceEncoding === 'display_referred_rgb')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Camera raw input profiles must default to camera_raw and must not be display-referred.',
        path: ['inputProfileKind'],
      });
    }

    if (profile.inputProfileKind === 'lab_rendered_input') {
      const requiredWarnings = ['lossy_input', 'low_acquisition_confidence'] as const;
      for (const warningCode of requiredWarnings) {
        if (!profile.requiredWarningCodes.includes(warningCode)) {
          context.addIssue({
            code: 'custom',
            message: 'Lab-rendered input profiles must require lossy-input and confidence warnings.',
            path: ['requiredWarningCodes'],
          });
        }
      }
    }

    if (
      profile.profileConfidence === 'high' &&
      ['assumed_display_profile', 'unknown'].includes(profile.inputProfileSource)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'High-confidence input profiles require explicit profile source metadata.',
        path: ['inputProfileSource'],
      });
    }
  });

export const negativeLabInputProfileCatalogV1Schema = z
  .object({
    catalogId: z.string().trim().min(1),
    catalogVersion: z.string().trim().min(1),
    profiles: z.array(negativeLabInputProfileV1Schema).min(1),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
  })
  .strict()
  .superRefine((catalog, context) => {
    addDuplicateFieldIssues({
      context,
      getPath: (index) => ['profiles', index, 'profileId'],
      getValue: (profile) => profile.profileId,
      items: catalog.profiles,
      message: 'Input profile catalog must not contain duplicate profile IDs.',
    });
    addDuplicateFieldIssues({
      context,
      getPath: (index) => ['profiles', index, 'displayName'],
      getValue: (profile) => profile.displayName,
      items: catalog.profiles,
      message: 'Input profile catalog must not contain duplicate display names.',
      normalize: normalizeEnglishKey,
    });
  });

export const negativeFrameRecordV1Schema = z
  .object({
    acquisitionOverrideProfileId: z.string().trim().min(1).optional(),
    baseSampleIds: z.array(z.string().trim().min(1)),
    borderState: z.enum(['visible', 'partial', 'cropped', 'unknown']),
    contentHash: z.string().trim().min(1),
    conversionCommandIds: z.array(z.string().trim().min(1)),
    crop: z
      .object({
        height: z.number().positive(),
        rotationDegrees: z.number(),
        width: z.number().positive(),
        x: z.number(),
        y: z.number(),
      })
      .strict()
      .optional(),
    frameId: z.string().trim().min(1),
    frameIndex: z.number().int().nonnegative(),
    positiveVariantIds: z.array(z.string().trim().min(1)),
    qcStatus: z.enum(['needs_review', 'approved', 'approved_with_warnings', 'rejected', 'excluded_from_export']),
    sourcePath: z.string().trim().min(1),
    warningCodes: z.array(negativeWarningCodeSchema),
  })
  .strict();

export const negativeRollSessionV1Schema = z
  .object({
    acquisitionProfileId: z.string().trim().min(1),
    acquisitionWarnings: z.array(negativeWarningV1Schema),
    anchorFrameIds: z.array(z.string().trim().min(1)),
    conversionWarnings: z.array(negativeWarningV1Schema),
    frameRecords: z.array(negativeFrameRecordV1Schema).min(1),
    inputMode: negativeInputModeSchema,
    perFrameOverrideIds: z.array(z.string().trim().min(1)),
    pixelBasis: negativePixelBasisSchema,
    processFamily: negativeProcessFamilySchema,
    provenanceEntryIds: z.array(z.string().trim().min(1)),
    qcStatus: z.enum(['needs_review', 'approved', 'approved_with_warnings', 'rejected', 'excluded_from_export']),
    rollDefaultCommandIds: z.array(z.string().trim().min(1)),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sessionId: z.string().trim().min(1),
    sharedBaseSampleIds: z.array(z.string().trim().min(1)),
    sourceFileIds: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

const nonEmptyIdArraySchema = z.array(z.string().trim().min(1)).min(1);

export const NEGATIVE_LAB_COMMAND_TYPES = [
  'negativeLab.createSession',
  'negativeLab.updateBaseSamples',
  'negativeLab.estimateBaseFog',
  'negativeLab.setConversionRecipe',
  'negativeLab.planRollNormalization',
  'negativeLab.createPositiveVariant',
  'negativeLab.setFrameQcStatus',
  'negativeLab.applyFrameCrop',
] as const;

export const negativeLabCommandTypeSchema = z.enum(NEGATIVE_LAB_COMMAND_TYPES);

const negativeLabFrameQcStatusSchema = z.enum([
  'needs_review',
  'approved',
  'approved_with_warnings',
  'rejected',
  'excluded_from_export',
]);

export const negativeLabOperationStageSchema = z.enum([
  'acquisition',
  'calibration',
  'objective_inversion',
  'semi_objective_normalization',
  'creative_rendering',
  'output_generation',
  'quality_control',
]);

export const negativeLabOperationClassSchema = z.enum([
  'acquisition',
  'calibration',
  'objective',
  'semi_objective',
  'creative',
  'output',
  'quality_control',
]);

const negativeLabCommandStageByType: Readonly<
  Record<z.infer<typeof negativeLabCommandTypeSchema>, z.infer<typeof negativeLabOperationStageSchema>>
> = {
  'negativeLab.applyFrameCrop': 'acquisition',
  'negativeLab.createPositiveVariant': 'output_generation',
  'negativeLab.createSession': 'acquisition',
  'negativeLab.estimateBaseFog': 'calibration',
  'negativeLab.planRollNormalization': 'semi_objective_normalization',
  'negativeLab.setConversionRecipe': 'objective_inversion',
  'negativeLab.setFrameQcStatus': 'quality_control',
  'negativeLab.updateBaseSamples': 'calibration',
};

const negativeLabOperationClassByStage: Readonly<
  Record<z.infer<typeof negativeLabOperationStageSchema>, z.infer<typeof negativeLabOperationClassSchema>>
> = {
  acquisition: 'acquisition',
  calibration: 'calibration',
  creative_rendering: 'creative',
  objective_inversion: 'objective',
  output_generation: 'output',
  quality_control: 'quality_control',
  semi_objective_normalization: 'semi_objective',
};

const negativeLabMutatingApprovalClasses: ReadonlyArray<z.infer<typeof approvalClassSchema>> = [
  'batch_apply',
  'edit_apply',
  'file_mutation',
];

export const negativeLabFrameSelectionV1Schema = z
  .object({
    excludeFrameIds: z.array(z.string().trim().min(1)),
    frameIds: z.array(z.string().trim().min(1)),
    mode: z.enum(['all', 'selected', 'by_warning', 'by_qc_state']),
    qcStatuses: z.array(negativeLabFrameQcStatusSchema),
    warningCodes: z.array(negativeWarningCodeSchema),
  })
  .strict();

export const negativeLabSourceAssetRefV1Schema = z
  .object({
    contentHash: z.string().trim().min(1).optional(),
    fileRole: z.enum(['negative_scan', 'contact_sheet', 'calibration_target', 'reference']),
    originalPathRedacted: z.boolean(),
    sourceFileId: z.string().trim().min(1),
  })
  .strict();

export const negativeLabFrameDetectionRequestV1Schema = z
  .object({
    borderPolicy: z.enum(['require_visible_border', 'prefer_visible_border', 'allow_cropped']),
    contactSheetHandling: z.enum(['defer', 'suggest_frames']),
    detectionSensitivity: z.enum(['conservative', 'balanced', 'aggressive']),
    mode: z.enum(['none', 'suggest_only', 'manual_seed']),
    preserveOriginalOrientation: z.boolean(),
  })
  .strict();

export const negativeLabDetectedFrameCropV1Schema = z
  .object({
    height: z.number().positive(),
    rotationDegrees: z.number(),
    width: z.number().positive(),
    x: z.number().min(0),
    y: z.number().min(0),
  })
  .strict();

export const negativeLabFrameBorderMetricsV1Schema = z
  .object({
    borderConfidence: negativeAcquisitionConfidenceSchema,
    borderState: z.enum(['visible', 'partial', 'cropped', 'unknown']),
    rebateTextDetected: z.boolean(),
    sprocketHoleDetected: z.boolean(),
    visibleBorderPx: z
      .object({
        bottom: z.number().min(0),
        left: z.number().min(0),
        right: z.number().min(0),
        top: z.number().min(0),
      })
      .strict(),
  })
  .strict();

export const negativeLabDetectedFrameV1Schema = z
  .object({
    borderMetrics: negativeLabFrameBorderMetricsV1Schema,
    contentHash: z.string().trim().min(1).optional(),
    crop: negativeLabDetectedFrameCropV1Schema,
    detectionConfidence: negativeAcquisitionConfidenceSchema,
    frameId: z.string().trim().min(1),
    frameIndex: z.number().int().nonnegative(),
    needsManualReview: z.boolean(),
    sourceFileId: z.string().trim().min(1),
    warningCodes: z.array(negativeWarningCodeSchema),
  })
  .strict();

export const negativeLabRejectedFrameCandidateV1Schema = z
  .object({
    candidateId: z.string().trim().min(1),
    crop: negativeLabDetectedFrameCropV1Schema,
    reason: z.enum(['too_small', 'overlap_duplicate', 'low_edge_confidence', 'manual_rejected']),
    sourceFileId: z.string().trim().min(1),
  })
  .strict();

export const negativeLabFrameDetectionResultV1Schema = z
  .object({
    algorithm: z
      .object({
        algorithmId: z.literal('frame_split_border_detect_v1'),
        algorithmVersion: z.literal(1),
        deterministicSeed: z.number().int().nonnegative().optional(),
      })
      .strict(),
    detectedFrames: z.array(negativeLabDetectedFrameV1Schema).min(1),
    detectionRunId: z.string().trim().min(1),
    inputRequest: negativeLabFrameDetectionRequestV1Schema,
    rejectedCandidates: z.array(negativeLabRejectedFrameCandidateV1Schema),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sessionId: z.string().trim().min(1).optional(),
    sourceFileIds: z.array(z.string().trim().min(1)).min(1),
    warnings: z.array(negativeWarningV1Schema),
  })
  .strict()
  .superRefine((result, context) => {
    const seenFrameIds = new Set<string>();
    for (const [index, frame] of result.detectedFrames.entries()) {
      if (seenFrameIds.has(frame.frameId)) {
        context.addIssue({
          code: 'custom',
          message: 'Detected frame IDs must be unique within a detection result.',
          path: ['detectedFrames', index, 'frameId'],
        });
      }
      seenFrameIds.add(frame.frameId);

      if (!result.sourceFileIds.includes(frame.sourceFileId)) {
        context.addIssue({
          code: 'custom',
          message: 'Detected frame sourceFileId must be listed in sourceFileIds.',
          path: ['detectedFrames', index, 'sourceFileId'],
        });
      }
    }
  });

export const negativeLabQcOverlayKindSchema = z.enum([
  'frame_boundary',
  'base_sample',
  'clipping',
  'density_sample',
  'dust_candidate',
  'warning_badge',
  'scratch_candidate',
  'roll_consistency_delta',
]);

export const negativeLabQcOverlayV1Schema = z
  .object({
    frameId: z.string().trim().min(1),
    geometry: negativeLabSampleGeometryV1Schema,
    label: z.string().trim().min(1),
    overlayId: z.string().trim().min(1),
    overlayKind: negativeLabQcOverlayKindSchema,
    severity: negativeWarningSeveritySchema,
    warningCodes: z.array(negativeWarningCodeSchema),
  })
  .strict();

export const negativeLabRollConsistencyFrameMetricV1Schema = z
  .object({
    densityDelta: z.number().min(0),
    exposureDeltaEv: z.number(),
    frameId: z.string().trim().min(1),
    warningCodes: z.array(negativeWarningCodeSchema),
    whiteBalanceDelta: z.number().min(0),
    withinTolerance: z.boolean(),
  })
  .strict();

export const negativeLabRollConsistencyMetricsV1Schema = z
  .object({
    anchorFrameIds: nonEmptyIdArraySchema,
    densityDeltaTolerance: z.number().min(0),
    exposureDeltaToleranceEv: z.number().min(0),
    frameMetrics: z.array(negativeLabRollConsistencyFrameMetricV1Schema).min(1),
    metricVersion: z.literal(1),
    whiteBalanceDeltaTolerance: z.number().min(0),
  })
  .strict()
  .superRefine((metrics, context) => {
    const seenFrameIds = new Set<string>();
    for (const [index, metric] of metrics.frameMetrics.entries()) {
      if (seenFrameIds.has(metric.frameId)) {
        context.addIssue({
          code: 'custom',
          message: 'Roll consistency frame metrics must use unique frame IDs.',
          path: ['frameMetrics', index, 'frameId'],
        });
      }
      seenFrameIds.add(metric.frameId);
    }
  });

export const negativeLabRollBatchWorkflowStageV1Schema = z.enum([
  'frame_detection_review',
  'base_fog_sampling',
  'conversion_recipe',
  'roll_normalization',
  'positive_variant_creation',
  'qc_review',
]);

export const negativeLabRollBatchWorkflowStagePlanV1Schema = z
  .object({
    commandIds: z.array(z.string().trim().min(1)),
    commandType: negativeLabCommandTypeSchema.optional(),
    dryRunPlanIds: z.array(z.string().trim().min(1)),
    requiredBeforeStages: z.array(negativeLabRollBatchWorkflowStageV1Schema),
    stage: negativeLabRollBatchWorkflowStageV1Schema,
    status: z.enum(['planned', 'dry_run_ready', 'applied', 'blocked']),
    warningCodes: z.array(negativeWarningCodeSchema),
  })
  .strict();

export const negativeLabRollBatchWorkflowV1Schema = z
  .object({
    anchorFrameIds: nonEmptyIdArraySchema,
    batchPolicy: z
      .object({
        autoApplyEligible: z.boolean(),
        baseStrategy: z.enum(['roll_shared_base', 'anchor_frame_base', 'per_frame_base']),
        includeRejectedFrames: z.boolean(),
        maxPerFrameExposureDeltaEv: z.number().nonnegative(),
        maxWhiteBalanceDelta: z.number().nonnegative(),
        normalizationMode: z.enum(['exposure_only', 'white_balance_only', 'density_and_balance']),
        preserveCreativeAdjustments: z.boolean(),
      })
      .strict(),
    expectedArtifactPurposes: z.array(
      z.enum([
        'objective_positive_preview',
        'density_map',
        'base_sample_overlay',
        'clipping_overlay',
        'warning_report',
        'parameter_diff',
        'qc_contact_sheet',
      ]),
    ),
    frameSelection: negativeLabFrameSelectionV1Schema,
    processFamily: negativeLabSupportedProcessFamilyV1Schema,
    qcProofId: z.string().trim().min(1).optional(),
    rollConsistencyPreview: negativeLabRollConsistencyMetricsV1Schema,
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sessionId: z.string().trim().min(1),
    stagePlans: z.array(negativeLabRollBatchWorkflowStagePlanV1Schema).min(1),
    workflowId: z.string().trim().min(1),
    workflowVersion: z.string().trim().min(1),
  })
  .strict()
  .superRefine((workflow, context) => {
    const selectedFrameIds =
      workflow.frameSelection.mode === 'selected' ? new Set(workflow.frameSelection.frameIds) : undefined;
    const seenStages = new Set<z.infer<typeof negativeLabRollBatchWorkflowStageV1Schema>>();

    if (workflow.batchPolicy.includeRejectedFrames) {
      context.addIssue({
        code: 'custom',
        message: 'Roll batch workflows must not include rejected frames.',
        path: ['batchPolicy', 'includeRejectedFrames'],
      });
    }

    for (const [index, anchorFrameId] of workflow.anchorFrameIds.entries()) {
      if (selectedFrameIds !== undefined && !selectedFrameIds.has(anchorFrameId)) {
        context.addIssue({
          code: 'custom',
          message: 'Roll batch anchor frames must be included in the selected frame set.',
          path: ['anchorFrameIds', index],
        });
      }
    }

    for (const [index, metric] of workflow.rollConsistencyPreview.frameMetrics.entries()) {
      if (selectedFrameIds !== undefined && !selectedFrameIds.has(metric.frameId)) {
        context.addIssue({
          code: 'custom',
          message: 'Roll consistency preview metrics must be included in the selected frame set.',
          path: ['rollConsistencyPreview', 'frameMetrics', index, 'frameId'],
        });
      }
    }

    for (const [index, stagePlan] of workflow.stagePlans.entries()) {
      if (seenStages.has(stagePlan.stage)) {
        context.addIssue({
          code: 'custom',
          message: 'Roll batch workflow stages must be unique.',
          path: ['stagePlans', index, 'stage'],
        });
      }
      seenStages.add(stagePlan.stage);

      if (stagePlan.status === 'applied' && stagePlan.commandIds.length === 0) {
        context.addIssue({
          code: 'custom',
          message: 'Applied roll batch workflow stages require command IDs.',
          path: ['stagePlans', index, 'commandIds'],
        });
      }

      if (stagePlan.status === 'dry_run_ready' && stagePlan.dryRunPlanIds.length === 0) {
        context.addIssue({
          code: 'custom',
          message: 'Dry-run-ready roll batch workflow stages require dry-run plan IDs.',
          path: ['stagePlans', index, 'dryRunPlanIds'],
        });
      }

      if (stagePlan.commandType !== undefined && !stagePlan.commandIds.every((commandId) => commandId.length > 0)) {
        context.addIssue({
          code: 'custom',
          message: 'Command-backed roll batch workflow stages require non-empty command IDs.',
          path: ['stagePlans', index, 'commandIds'],
        });
      }
    }

    const stageSet = new Set(workflow.stagePlans.map((stagePlan) => stagePlan.stage));
    for (const requiredStage of [
      'base_fog_sampling',
      'conversion_recipe',
      'roll_normalization',
      'qc_review',
    ] as const) {
      if (!stageSet.has(requiredStage)) {
        context.addIssue({
          code: 'custom',
          message: 'Roll batch workflow is missing a required consistency stage.',
          path: ['stagePlans'],
        });
      }
    }

    if (workflow.qcProofId !== undefined && !stageSet.has('qc_review')) {
      context.addIssue({
        code: 'custom',
        message: 'Roll batch workflows with a QC proof must include the QC review stage.',
        path: ['qcProofId'],
      });
    }
  });

export const negativeLabQcPositiveVariantV1Schema = z
  .object({
    frameId: z.string().trim().min(1),
    operationId: z.string().trim().min(1),
    outputArtifact: artifactHandleV1Schema,
    outputIntent: z.enum(['proof_preview', 'editable_positive', 'export_ready_preview']),
    sourceContentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    sourcePath: z.string().trim().min(1),
    warnings: z.array(negativeWarningV1Schema),
  })
  .strict()
  .superRefine((variant, context) => {
    if (variant.outputArtifact.contentHash === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Negative Lab QC positive variants must include output artifact content hashes.',
        path: ['outputArtifact', 'contentHash'],
      });
    }

    if (variant.outputArtifact.kind !== 'export' && variant.outputArtifact.kind !== 'preview') {
      context.addIssue({
        code: 'custom',
        message: 'Negative Lab QC positive variants must link preview or export artifacts.',
        path: ['outputArtifact', 'kind'],
      });
    }
  });

export const negativeLabQcProofArtifactV1Schema = z
  .object({
    contactSheet: z
      .object({
        artifact: artifactHandleV1Schema,
        columns: z.number().int().positive(),
        rows: z.number().int().positive(),
      })
      .strict(),
    frameIds: z.array(z.string().trim().min(1)).min(1),
    frameStates: z
      .array(
        z
          .object({
            contactSheetSlot: z.number().int().positive(),
            frameId: z.string().trim().min(1),
            included: z.boolean(),
            proofState: z.enum(['included', 'excluded', 'rejected']),
            qcDecision: z.enum(['approved', 'pending', 'rejected']),
          })
          .strict(),
      )
      .min(1),
    generatedAt: z.string().trim().min(1),
    overlays: z.array(negativeLabQcOverlayV1Schema),
    positiveVariants: z.array(negativeLabQcPositiveVariantV1Schema).min(1),
    proofId: z.string().trim().min(1),
    rollConsistency: negativeLabRollConsistencyMetricsV1Schema,
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sessionId: z.string().trim().min(1),
    warnings: z.array(negativeWarningV1Schema),
  })
  .strict()
  .superRefine((proof, context) => {
    const frameIds = new Set(proof.frameIds);
    if (frameIds.size !== proof.frameIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'QC proof frameIds must be unique.',
        path: ['frameIds'],
      });
    }

    const frameStateFrameIds = new Set<string>();
    for (const [index, frameState] of proof.frameStates.entries()) {
      if (!frameIds.has(frameState.frameId)) {
        context.addIssue({
          code: 'custom',
          message: 'QC frame state frameId must be included in proof frameIds.',
          path: ['frameStates', index, 'frameId'],
        });
      }

      if (frameStateFrameIds.has(frameState.frameId)) {
        context.addIssue({
          code: 'custom',
          message: 'QC frame states must be unique per frame.',
          path: ['frameStates', index, 'frameId'],
        });
      }
      frameStateFrameIds.add(frameState.frameId);

      if (!frameState.included && frameState.qcDecision !== 'rejected' && frameState.proofState !== 'excluded') {
        context.addIssue({
          code: 'custom',
          message: 'Excluded QC frame states must use the excluded proof state.',
          path: ['frameStates', index, 'proofState'],
        });
      }

      if (frameState.qcDecision === 'rejected' && frameState.proofState !== 'rejected') {
        context.addIssue({
          code: 'custom',
          message: 'Rejected QC decisions must use the rejected proof state.',
          path: ['frameStates', index, 'proofState'],
        });
      }
    }

    if (frameStateFrameIds.size !== frameIds.size) {
      context.addIssue({
        code: 'custom',
        message: 'QC frame states must cover every proof frameId.',
        path: ['frameStates'],
      });
    }

    for (const [index, overlay] of proof.overlays.entries()) {
      if (!frameIds.has(overlay.frameId)) {
        context.addIssue({
          code: 'custom',
          message: 'QC overlay frameId must be included in proof frameIds.',
          path: ['overlays', index, 'frameId'],
        });
      }
    }

    const positiveVariantFrameIds = new Set<string>();
    for (const [index, variant] of proof.positiveVariants.entries()) {
      if (!frameIds.has(variant.frameId)) {
        context.addIssue({
          code: 'custom',
          message: 'QC positive variant frameId must be included in proof frameIds.',
          path: ['positiveVariants', index, 'frameId'],
        });
      }

      if (positiveVariantFrameIds.has(variant.frameId)) {
        context.addIssue({
          code: 'custom',
          message: 'QC positive variants must be unique per frame.',
          path: ['positiveVariants', index, 'frameId'],
        });
      }
      positiveVariantFrameIds.add(variant.frameId);
    }

    for (const [index, metric] of proof.rollConsistency.frameMetrics.entries()) {
      if (!frameIds.has(metric.frameId)) {
        context.addIssue({
          code: 'custom',
          message: 'Roll consistency metric frameId must be included in proof frameIds.',
          path: ['rollConsistency', 'frameMetrics', index, 'frameId'],
        });
      }
    }
  });

export const negativeLabBaseSampleRegionV1Schema = z
  .object({
    frameId: z.string().trim().min(1),
    geometry: negativeLabSampleGeometryV1Schema,
    regionId: z.string().trim().min(1).optional(),
    role: z.enum(['base_fog', 'rebate', 'leader', 'manual_neutral_reference']),
  })
  .strict();

export const negativeLabBaseSampleStatusV1Schema = z.enum(['candidate', 'accepted', 'rejected']);

export const negativeLabBaseSampleRejectionReasonV1Schema = z.enum([
  'dust',
  'rebate_text',
  'sprocket',
  'scratch',
  'light_leak',
  'clipped_channel',
  'uneven_illumination',
  'manual',
]);

export const negativeLabBaseSampleChannelStatsV1Schema = z
  .object({
    clippingFraction: z.number().min(0).max(1),
    max: z.number().min(0),
    mean: z.number().min(0),
    median: z.number().min(0),
    min: z.number().min(0),
    sampleCount: z.number().int().positive(),
    standardDeviation: z.number().min(0),
  })
  .strict()
  .superRefine((stats, context) => {
    if (!(stats.min <= stats.median && stats.median <= stats.max)) {
      context.addIssue({
        code: 'custom',
        message: 'Base sample channel stats must satisfy min <= median <= max.',
        path: ['median'],
      });
    }

    if (!(stats.min <= stats.mean && stats.mean <= stats.max)) {
      context.addIssue({
        code: 'custom',
        message: 'Base sample channel stats must satisfy min <= mean <= max.',
        path: ['mean'],
      });
    }
  });

export const negativeLabBaseSampleStatsV1Schema = z
  .object({
    blue: negativeLabBaseSampleChannelStatsV1Schema,
    green: negativeLabBaseSampleChannelStatsV1Schema,
    red: negativeLabBaseSampleChannelStatsV1Schema,
  })
  .strict();

export const negativeLabBaseSampleRecordV1Schema = z
  .object({
    confidence: negativeAcquisitionConfidenceSchema,
    measuredAt: z.string().trim().min(1),
    rejectionReason: negativeLabBaseSampleRejectionReasonV1Schema.optional(),
    sampleId: z.string().trim().min(1),
    sampleRegion: negativeLabBaseSampleRegionV1Schema,
    sampleScope: z.enum(['frame', 'roll', 'selected_frames']),
    sampleStats: negativeLabBaseSampleStatsV1Schema.optional(),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    status: negativeLabBaseSampleStatusV1Schema,
    warningCodes: z.array(negativeWarningCodeSchema),
  })
  .strict()
  .superRefine((sample, context) => {
    if (sample.status === 'accepted' && sample.sampleStats === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Accepted base samples require measured channel statistics.',
        path: ['sampleStats'],
      });
    }

    if (sample.status === 'rejected' && sample.rejectionReason === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Rejected base samples require a rejection reason.',
        path: ['rejectionReason'],
      });
    }

    if (sample.status !== 'rejected' && sample.rejectionReason !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Only rejected base samples may include a rejection reason.',
        path: ['rejectionReason'],
      });
    }
  });

export const negativeLabBaseFogEstimateV1Schema = z
  .object({
    algorithm: z
      .object({
        algorithmId: z.literal('base_fog_scalar_rgb_v1'),
        algorithmVersion: z.literal(1),
        outlierPolicy: z.enum(['mad_v1', 'none']),
        statistic: z.enum(['median', 'trimmed_mean']),
      })
      .strict(),
    baseDensity: z
      .object({
        blue: z.number().min(0),
        green: z.number().min(0),
        red: z.number().min(0),
      })
      .strict(),
    baseRgb: z
      .object({
        blue: z.number().positive(),
        green: z.number().positive(),
        red: z.number().positive(),
      })
      .strict(),
    confidence: negativeAcquisitionConfidenceSchema,
    estimateId: z.string().trim().min(1),
    estimatedAt: z.string().trim().min(1),
    frameSelection: negativeLabFrameSelectionV1Schema,
    rejectedSampleIds: z.array(z.string().trim().min(1)),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sessionId: z.string().trim().min(1),
    sourceSampleIds: nonEmptyIdArraySchema,
    scope: z.enum(['frame', 'roll', 'selected_frames']),
    warningCodes: z.array(negativeWarningCodeSchema),
  })
  .strict()
  .superRefine((estimate, context) => {
    const sourceSampleIds = new Set(estimate.sourceSampleIds);
    if (sourceSampleIds.size !== estimate.sourceSampleIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Base/fog estimates must not repeat source sample IDs.',
        path: ['sourceSampleIds'],
      });
    }

    const rejectedSampleIds = new Set(estimate.rejectedSampleIds);
    if (rejectedSampleIds.size !== estimate.rejectedSampleIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Base/fog estimates must not repeat rejected sample IDs.',
        path: ['rejectedSampleIds'],
      });
    }

    for (const [index, sampleId] of estimate.rejectedSampleIds.entries()) {
      if (sourceSampleIds.has(sampleId)) {
        context.addIssue({
          code: 'custom',
          message: 'Rejected base samples cannot also be source samples for an estimate.',
          path: ['rejectedSampleIds', index],
        });
      }
    }

    if (estimate.scope === 'frame' && estimate.frameSelection.frameIds.length !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'Frame-scoped base/fog estimates must select exactly one frame.',
        path: ['frameSelection', 'frameIds'],
      });
    }

    const confidenceWarningCodes: ReadonlyArray<z.infer<typeof negativeWarningCodeSchema>> = [
      'clipped_base_channel',
      'uneven_illumination',
      'low_acquisition_confidence',
      'missing_visible_base',
    ];
    const hasConfidenceWarning = estimate.warningCodes.some((warningCode) =>
      confidenceWarningCodes.includes(warningCode),
    );
    if (estimate.confidence === 'high' && hasConfidenceWarning) {
      context.addIssue({
        code: 'custom',
        message: 'High-confidence base/fog estimates cannot include confidence-lowering warning codes.',
        path: ['confidence'],
      });
    }
  });

export const negativeLabPreviewRequestV1Schema = z
  .object({
    artifactPurposes: z.array(
      z.enum([
        'objective_positive_preview',
        'density_map',
        'base_sample_overlay',
        'clipping_overlay',
        'warning_report',
        'parameter_diff',
      ]),
    ),
    includePreview: z.boolean(),
    maxEdgePx: z.number().int().positive().optional(),
  })
  .strict();

export const negativeLabOutputTransformRefV1Schema = z
  .object({
    chromaticAdaptation: z.enum(['bradford', 'cat16', 'none_declared']).optional(),
    renderingIntent: z.enum(['scene_referred', 'relative_colorimetric', 'perceptual']).optional(),
    transformId: z.enum([
      'rawengine_scene_linear_v1',
      'linear_rec2020_d65_v1',
      'acescg_ap1_d60_v1',
      'linear_prophoto_rgb_d50_v1',
    ]),
  })
  .strict();

export const negativeLabCreateSessionParametersV1Schema = z
  .object({
    acquisitionProfileId: z.string().trim().min(1).optional(),
    frameDetectionRequest: negativeLabFrameDetectionRequestV1Schema,
    inputMode: negativeInputModeSchema,
    notes: z.string().trim().min(1).optional(),
    pixelBasis: negativePixelBasisSchema,
    processFamily: negativeLabSupportedProcessFamilyV1Schema,
    sessionKind: z.enum(['single_frame', 'roll', 'contact_sheet']),
    sourceAssets: z.array(negativeLabSourceAssetRefV1Schema).min(1),
  })
  .strict();

export const negativeLabUpdateBaseSamplesParametersV1Schema = z
  .object({
    frameSelection: negativeLabFrameSelectionV1Schema,
    rejectionReason: negativeLabBaseSampleRejectionReasonV1Schema.optional(),
    sampleEditMode: z.enum(['add', 'replace', 'accept', 'reject', 'remove']),
    sampleRecords: z.array(negativeLabBaseSampleRecordV1Schema).optional(),
    sampleRegions: z.array(negativeLabBaseSampleRegionV1Schema).min(1),
    sessionId: z.string().trim().min(1),
  })
  .strict()
  .superRefine((parameters, context) => {
    if (parameters.sampleEditMode === 'reject' && parameters.rejectionReason === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Rejecting base samples requires a rejection reason.',
        path: ['rejectionReason'],
      });
    }

    if (parameters.sampleRecords !== undefined) {
      const sampleIds = new Set<string>();
      for (const [index, sampleRecord] of parameters.sampleRecords.entries()) {
        if (sampleIds.has(sampleRecord.sampleId)) {
          context.addIssue({
            code: 'custom',
            message: 'Base sample update commands must not repeat sample IDs.',
            path: ['sampleRecords', index, 'sampleId'],
          });
        }
        sampleIds.add(sampleRecord.sampleId);
      }
    }
  });

export const negativeLabEstimateBaseFogParametersV1Schema = z
  .object({
    estimator: z
      .object({
        algorithmId: z.literal('base_fog_scalar_rgb_v1'),
        minimumAcceptedSamples: z.number().int().positive().optional(),
        outlierPolicy: z.enum(['mad_v1', 'none']),
        scope: z.enum(['frame', 'roll', 'selected_frames']),
        sourceSampleIds: nonEmptyIdArraySchema,
        statistic: z.enum(['median', 'trimmed_mean']),
      })
      .strict(),
    frameSelection: negativeLabFrameSelectionV1Schema,
    sessionId: z.string().trim().min(1),
  })
  .strict()
  .superRefine((parameters, context) => {
    const sourceSampleIds = new Set(parameters.estimator.sourceSampleIds);
    if (sourceSampleIds.size !== parameters.estimator.sourceSampleIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Base/fog estimation source sample IDs must be unique.',
        path: ['estimator', 'sourceSampleIds'],
      });
    }

    if (parameters.estimator.scope === 'frame' && parameters.frameSelection.frameIds.length !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'Frame-scoped base/fog estimation must select exactly one frame.',
        path: ['frameSelection', 'frameIds'],
      });
    }
  });

export const negativeLabSetConversionRecipeParametersV1Schema = z
  .object({
    baseStrategy: z
      .object({
        baseEstimateId: z.string().trim().min(1).optional(),
        baseSampleIds: z.array(z.string().trim().min(1)),
        mode: z.enum(['existing_base_estimate', 'manual_samples', 'roll_shared', 'profile_default_low_confidence']),
      })
      .strict(),
    conversionModel: z
      .object({
        algorithmId: z.enum(['density_rgb_v1', 'negative_density_print_v2']),
        algorithmVersion: z.union([z.literal(1), z.literal(2)]),
        densityMax: z.number().positive(),
        epsilonPolicyId: z.literal('density_epsilon_v1'),
        negativeDensityTolerance: z.number().nonnegative(),
      })
      .strict(),
    densityPrintCurve: z
      .object({
        contrastGrade: z.number().min(0.5).max(2),
        densityOffset: z.number().min(-0.5).max(0.5),
        midtoneShape: z.number().min(-1).max(1),
        outputTag: z.enum(['preview_display', 'export_linear']),
        schemaVersion: z.literal(1),
        shoulderStrength: z.number().min(0).max(1),
        targetBlackDensity: z.number().min(1.1).max(2.4),
        targetWhiteDensity: z.number().min(0).max(0.25),
        toeStrength: z.number().min(0).max(1),
      })
      .strict()
      .optional(),
    curveModel: z
      .object({
        curveFamily: z.enum(['process_profile_monotonic_v1', 'parametric_monotonic_v1']),
        inversionCurveSet: negativeLabPerChannelInversionCurveSetV1Schema.optional(),
        inversionCurveSetPolicy: z
          .enum(['use_process_profile_curves', 'use_curve_set_override', 'expert_override'])
          .optional(),
        normalizationProfileId: z.string().trim().min(1).optional(),
        normalizationProfileVersion: z.string().trim().min(1).optional(),
        processProfileId: z.string().trim().min(1).optional(),
        processProfileVersion: z.string().trim().min(1).optional(),
      })
      .strict(),
    frameSelection: negativeLabFrameSelectionV1Schema,
    inputCharacterization: z
      .object({
        channelBasis: z.enum(['camera_rgb', 'scanner_rgb', 'rendered_rgb', 'unknown']),
        confidence: z.enum([
          'declared_linear_scan_rgb',
          'profiled_acquisition',
          'approximate_rendered_rgb',
          'low_confidence',
        ]),
        pixelBasis: z.literal('linear_scan_rgb'),
      })
      .strict(),
    neutralization: z
      .object({
        mode: z.enum(['none', 'neutral_sample', 'skin_sample', 'manual_rgb_balance']),
        sampleIds: z.array(z.string().trim().min(1)),
      })
      .strict(),
    outputIntent: z.enum(['editable_positive', 'proof_preview', 'export_ready_preview']),
    outputTransformRef: negativeLabOutputTransformRefV1Schema.optional(),
    previewRequest: negativeLabPreviewRequestV1Schema,
    processFamily: negativeLabSupportedProcessFamilyV1Schema,
    sessionId: z.string().trim().min(1),
  })
  .strict()
  .superRefine((recipe, context) => {
    if (recipe.conversionModel.algorithmId === 'density_rgb_v1' && recipe.conversionModel.algorithmVersion !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'density_rgb_v1 recipes must declare algorithmVersion 1.',
        path: ['conversionModel', 'algorithmVersion'],
      });
    }

    if (
      recipe.conversionModel.algorithmId === 'negative_density_print_v2' &&
      recipe.conversionModel.algorithmVersion !== 2
    ) {
      context.addIssue({
        code: 'custom',
        message: 'negative_density_print_v2 recipes must declare algorithmVersion 2.',
        path: ['conversionModel', 'algorithmVersion'],
      });
    }

    if (recipe.conversionModel.algorithmId === 'negative_density_print_v2' && recipe.densityPrintCurve === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'negative_density_print_v2 recipes require versioned densityPrintCurve params.',
        path: ['densityPrintCurve'],
      });
    }

    if (recipe.conversionModel.algorithmId === 'density_rgb_v1' && recipe.densityPrintCurve !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'density_rgb_v1 recipes must not carry v2 densityPrintCurve params.',
        path: ['densityPrintCurve'],
      });
    }

    const { inversionCurveSet, inversionCurveSetPolicy } = recipe.curveModel;
    if (
      ['use_curve_set_override', 'expert_override'].includes(inversionCurveSetPolicy ?? '') &&
      inversionCurveSet === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Inversion curve override policies require an inversion curve set.',
        path: ['curveModel', 'inversionCurveSet'],
      });
    }

    if (inversionCurveSet !== undefined && inversionCurveSet.processFamily !== recipe.processFamily) {
      context.addIssue({
        code: 'custom',
        message: 'Inversion curve set process family must match the conversion recipe process family.',
        path: ['curveModel', 'inversionCurveSet', 'processFamily'],
      });
    }
  });

export const negativeLabPlanRollNormalizationParametersV1Schema = z
  .object({
    anchorFrameIds: nonEmptyIdArraySchema,
    frameSelection: negativeLabFrameSelectionV1Schema,
    normalizationMode: z.enum(['exposure_only', 'white_balance_only', 'density_and_balance']),
    normalizationProfileId: z.string().trim().min(1).optional(),
    normalizationProfileVersion: z.string().trim().min(1).optional(),
    previewRequest: negativeLabPreviewRequestV1Schema,
    preserveCreativeAdjustments: z.boolean(),
    sessionId: z.string().trim().min(1),
  })
  .strict();

export const negativeLabCreatePositiveVariantParametersV1Schema = z
  .object({
    conversionRecipeId: z.string().trim().min(1),
    frameSelection: negativeLabFrameSelectionV1Schema,
    inheritRollDefaults: z.boolean(),
    onNameConflict: z.enum(['fail', 'create_unique']),
    outputTransformRef: negativeLabOutputTransformRefV1Schema,
    positiveVariantName: z.string().trim().min(1).optional(),
    sessionId: z.string().trim().min(1),
    variantNameSource: z.enum(['user_supplied', 'generated_generic']),
  })
  .strict();

export const negativeLabSetFrameQcStatusParametersV1Schema = z
  .object({
    acknowledgedWarningCodes: z.array(negativeWarningCodeSchema),
    frameId: z.string().trim().min(1),
    notes: z.string().trim().min(1).optional(),
    qcStatus: negativeLabFrameQcStatusSchema,
    sessionId: z.string().trim().min(1),
  })
  .strict();

export const negativeLabFrameCropEditV1Schema = z
  .object({
    borderConfidence: negativeAcquisitionConfidenceSchema,
    borderState: z.enum(['visible', 'partial', 'cropped', 'unknown']),
    crop: negativeLabDetectedFrameCropV1Schema,
    cropSource: z.enum(['detected_frame', 'manual_override', 'imported_metadata']),
    detectionFrameId: z.string().trim().min(1).optional(),
    editMode: z.enum(['accept_detected', 'manual_override', 'reject_detected']),
    frameId: z.string().trim().min(1),
    notes: z.string().trim().min(1).optional(),
    sourceFileId: z.string().trim().min(1),
    warningCodes: z.array(negativeWarningCodeSchema),
  })
  .strict()
  .superRefine((edit, context) => {
    if (edit.editMode === 'accept_detected' && edit.cropSource !== 'detected_frame') {
      context.addIssue({
        code: 'custom',
        message: 'Accepted detected crops must use detected-frame crop source.',
        path: ['cropSource'],
      });
    }

    if (edit.editMode === 'manual_override' && edit.cropSource === 'detected_frame') {
      context.addIssue({
        code: 'custom',
        message: 'Manual crop overrides must not be recorded as detected-frame crops.',
        path: ['cropSource'],
      });
    }

    if (edit.editMode === 'reject_detected' && edit.notes === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Rejected detected crops require notes for review provenance.',
        path: ['notes'],
      });
    }

    if (edit.cropSource === 'detected_frame' && edit.detectionFrameId === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Detected-frame crop edits require the source detection frame ID.',
        path: ['detectionFrameId'],
      });
    }
  });

export const negativeLabApplyFrameCropParametersV1Schema = z
  .object({
    cropEdits: z.array(negativeLabFrameCropEditV1Schema).min(1),
    detectionRunId: z.string().trim().min(1).optional(),
    frameSelection: negativeLabFrameSelectionV1Schema,
    sessionId: z.string().trim().min(1),
  })
  .strict()
  .superRefine((parameters, context) => {
    const frameIds = new Set<string>();
    for (const [index, edit] of parameters.cropEdits.entries()) {
      if (frameIds.has(edit.frameId)) {
        context.addIssue({
          code: 'custom',
          message: 'Frame crop commands must not contain duplicate frame IDs.',
          path: ['cropEdits', index, 'frameId'],
        });
      }
      frameIds.add(edit.frameId);

      if (edit.cropSource === 'detected_frame' && parameters.detectionRunId === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Detected-frame crop edits require a detectionRunId on the command.',
          path: ['detectionRunId'],
        });
      }
    }
  });

export const negativeLabApplyPlanRequestV1Schema = z
  .object({
    acknowledgedWarningCodes: z.array(negativeWarningCodeSchema),
    acceptedDryRunPlanHash: z.string().trim().min(1),
    approval: approvalRequirementSchema,
    commandId: z.string().trim().min(1),
    dryRunPlanId: z.string().trim().min(1),
    expectedSessionRevision: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.approval.approvalClass !== ApprovalClass.EditApply) {
      context.addIssue({
        code: 'custom',
        message: 'Negative Lab apply requests require edit-apply approval classification.',
        path: ['approval', 'approvalClass'],
      });
    }

    if (request.approval.state !== 'approved') {
      context.addIssue({
        code: 'custom',
        message: 'Negative Lab apply requests require approved user approval.',
        path: ['approval', 'state'],
      });
    }
  });

export const negativeLabCreateSessionCommandV1Schema = commandEnvelopeV1Schema
  .extend({
    commandType: z.literal('negativeLab.createSession'),
    parameters: negativeLabCreateSessionParametersV1Schema,
  })
  .strict();

export const negativeLabUpdateBaseSamplesCommandV1Schema = commandEnvelopeV1Schema
  .extend({
    commandType: z.literal('negativeLab.updateBaseSamples'),
    parameters: negativeLabUpdateBaseSamplesParametersV1Schema,
  })
  .strict();

export const negativeLabEstimateBaseFogCommandV1Schema = commandEnvelopeV1Schema
  .extend({
    commandType: z.literal('negativeLab.estimateBaseFog'),
    parameters: negativeLabEstimateBaseFogParametersV1Schema,
  })
  .strict();

export const negativeLabSetConversionRecipeCommandV1Schema = commandEnvelopeV1Schema
  .extend({
    commandType: z.literal('negativeLab.setConversionRecipe'),
    parameters: negativeLabSetConversionRecipeParametersV1Schema,
  })
  .strict();

export const negativeLabPlanRollNormalizationCommandV1Schema = commandEnvelopeV1Schema
  .extend({
    commandType: z.literal('negativeLab.planRollNormalization'),
    parameters: negativeLabPlanRollNormalizationParametersV1Schema,
  })
  .strict();

export const negativeLabCreatePositiveVariantCommandV1Schema = commandEnvelopeV1Schema
  .extend({
    commandType: z.literal('negativeLab.createPositiveVariant'),
    parameters: negativeLabCreatePositiveVariantParametersV1Schema,
  })
  .strict();

export const negativeLabSetFrameQcStatusCommandV1Schema = commandEnvelopeV1Schema
  .extend({
    commandType: z.literal('negativeLab.setFrameQcStatus'),
    parameters: negativeLabSetFrameQcStatusParametersV1Schema,
  })
  .strict();

export const negativeLabApplyFrameCropCommandV1Schema = commandEnvelopeV1Schema
  .extend({
    commandType: z.literal('negativeLab.applyFrameCrop'),
    parameters: negativeLabApplyFrameCropParametersV1Schema,
  })
  .strict();

export const negativeLabCommandEnvelopeV1Schema = z.discriminatedUnion('commandType', [
  negativeLabCreateSessionCommandV1Schema,
  negativeLabUpdateBaseSamplesCommandV1Schema,
  negativeLabEstimateBaseFogCommandV1Schema,
  negativeLabSetConversionRecipeCommandV1Schema,
  negativeLabPlanRollNormalizationCommandV1Schema,
  negativeLabCreatePositiveVariantCommandV1Schema,
  negativeLabSetFrameQcStatusCommandV1Schema,
  negativeLabApplyFrameCropCommandV1Schema,
]);

export const negativeLabChangeSetV1Schema = z
  .object({
    artifactHandles: z.array(artifactHandleV1Schema),
    createdPositiveVariantIds: z.array(z.string().trim().min(1)),
    provenanceEntryIds: z.array(z.string().trim().min(1)),
    updatedFrameIds: z.array(z.string().trim().min(1)),
    updatedSessionId: z.string().trim().min(1),
    warningCodes: z.array(negativeWarningCodeSchema),
  })
  .strict();

export const negativeLabRuntimeProofV1Schema = z
  .object({
    acceptedSuggestionSummary: z
      .object({
        acceptedFrameCount: z.number().int().nonnegative(),
        confidenceThreshold: z.number().min(0).max(1),
        exposureOffsetEvRange: z
          .object({
            max: z.number(),
            min: z.number(),
          })
          .strict(),
        source: z.literal('rawengine_runtime_preview_summary_v1'),
        state: z.enum(['suggested_only', 'accepted_into_plan']),
        warningCodes: z.array(negativeWarningCodeSchema),
      })
      .strict(),
    algorithm: z
      .object({
        algorithmId: z.enum(['density_rgb_v1', 'negative_density_print_v2']),
        algorithmVersion: z.union([z.literal(1), z.literal(2)]),
        densityMax: z.number().positive(),
        epsilonPolicyId: z.literal('density_epsilon_v1'),
        negativeDensityTolerance: z.number().nonnegative(),
      })
      .strict(),
    previewExportArtifactParity: z
      .object({
        dimensionsMatch: z.boolean(),
        exportArtifactIds: z.array(z.string().trim().min(1)),
        parityHash: z.string().regex(/^sha256:[A-Za-z0-9:_-]+$/u),
        previewArtifactIds: z.array(z.string().trim().min(1)),
        storageTransition: z.literal('temp_cache_to_sidecar_artifact'),
        warningCodes: z.array(negativeWarningCodeSchema),
      })
      .strict(),
    printCurveParams: z
      .object({
        contrastGrade: z.number().min(0.5).max(2),
        densityOffset: z.number().min(-0.5).max(0.5),
        midtoneShape: z.number().min(-1).max(1),
        outputTag: z.enum(['preview_display', 'export_linear']),
        schemaVersion: z.literal(1),
        shoulderStrength: z.number().min(0).max(1),
        targetBlackDensity: z.number().min(1.1).max(2.4),
        targetWhiteDensity: z.number().min(0).max(0.25),
        toeStrength: z.number().min(0).max(1),
      })
      .strict()
      .nullable(),
    scanMetricsSummary: z
      .object({
        densityRangeUnclamped: z.number().nonnegative(),
        frameCount: z.number().int().nonnegative(),
        p50AnchorDensity: z.number(),
        sampleCount: z.number().int().nonnegative(),
        texturalDensityRangeP10P90: z.number().nonnegative(),
        warningCodes: z.array(negativeWarningCodeSchema),
      })
      .strict(),
    schemaVersion: z.literal(1),
    selectedCrosstalkProvenance: z
      .object({
        applied: z.boolean(),
        profileId: z.string().trim().min(1),
        provenance: z.enum(['rawengine_identity', 'rawengine_process_profile']),
        provenanceHash: z.string().regex(/^fnv1a32:[a-f0-9]{8}$/u),
        strength: z.number().min(0).max(1),
      })
      .strict(),
    runtimePreview: z
      .object({
        baseFogSampleSummary: z
          .object({
            clippedFraction: z.number().min(0).max(1),
            confidence: z.number().min(0).max(1),
            densityRange: z.number().min(0),
            densityRgb: negativeLabDensityRgbV1Schema,
            meanRgb: z
              .object({
                b: z.number().min(0).max(1),
                g: z.number().min(0).max(1),
                r: z.number().min(0).max(1),
              })
              .strict(),
            sampleCount: z.number().int().positive(),
            sampleRect: negativeLabSampleRectV1Schema,
            source: z.enum([
              'runtime_estimate_negative_base_fog',
              'recipe_default_base_fog',
              'requested_base_fog_sample_rect',
              'deterministic_edge_safe_default_rect',
            ]),
            warningCodes: z.array(negativeWarningCodeSchema),
          })
          .strict(),
        densityCurveSummary: z
          .object({
            curveFamily: z.enum(['process_profile_monotonic_v1', 'parametric_monotonic_v1']),
            densityMax: z.number().positive(),
            normalizationProfileId: z.string().trim().min(1).nullable(),
            outputTag: z.enum(['preview_display', 'export_linear']),
            processProfileId: z.string().trim().min(1).nullable(),
          })
          .strict(),
        dryRunMode: z.literal('runtime_preview_non_mutating'),
        planHash: z.string().regex(/^sha256:[A-Za-z0-9:_-]+$/u),
        previewArtifactHandle: artifactHandleV1Schema,
        previewContentHash: z.string().regex(/^sha256:[A-Za-z0-9:_-]+$/u),
        previewRenderer: z.enum([
          'tauri_preview_negative_conversion',
          'rawengine_density_preview_runtime',
          'rawengine_negative_lab_runtime_preview_v1',
        ]),
        renderedPositivePreview: z.literal(true),
        sourceImageIdentity: z
          .object({
            frameIds: z.array(z.string().trim().min(1)).min(1),
            imagePath: z.string().trim().min(1),
            sessionId: z.string().trim().min(1),
          })
          .strict(),
      })
      .strict(),
    warningCodes: z.array(negativeWarningCodeSchema),
  })
  .strict()
  .superRefine((proof, context) => {
    if (
      !proof.previewExportArtifactParity.previewArtifactIds.includes(
        proof.runtimePreview.previewArtifactHandle.artifactId,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Negative Lab runtime preview proof must reference a declared preview artifact.',
        path: ['runtimePreview', 'previewArtifactHandle'],
      });
    }

    if (proof.runtimePreview.previewArtifactHandle.kind !== 'preview') {
      context.addIssue({
        code: 'custom',
        message: 'Negative Lab runtime preview proof requires a preview artifact handle.',
        path: ['runtimePreview', 'previewArtifactHandle', 'kind'],
      });
    }

    if (proof.runtimePreview.previewArtifactHandle.storage !== 'temp_cache') {
      context.addIssue({
        code: 'custom',
        message: 'Negative Lab dry-run preview artifacts must stay in temp cache.',
        path: ['runtimePreview', 'previewArtifactHandle', 'storage'],
      });
    }
  });

export const negativeLabDryRunResultV1Schema = z
  .object({
    changeSet: negativeLabChangeSetV1Schema,
    dryRunPlanId: z.string().trim().min(1),
    commandId: z.string().trim().min(1),
    commandType: negativeLabCommandTypeSchema,
    correlationId: z.string().trim().min(1),
    numericMetrics: z.record(z.string(), z.number()),
    proof: negativeLabRuntimeProofV1Schema.optional(),
    previewArtifacts: z.array(artifactHandleV1Schema),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    warnings: z.array(negativeWarningV1Schema),
  })
  .strict();

export const negativeLabPositiveOutputReceiptV1Schema = z
  .object({
    acceptedDryRunPlanHash: z.string().regex(/^sha256:[A-Za-z0-9:_-]+$/u),
    acceptedDryRunPlanId: z.string().trim().min(1),
    conversionBundleContentHash: z.string().regex(/^sha256:[A-Za-z0-9:_-]+$/u),
    conversionBundlePath: z.string().trim().min(1),
    dimensions: z.object({ height: z.number().int().positive(), width: z.number().int().positive() }).strict(),
    outputArtifact: artifactHandleV1Schema,
    outputPath: z.string().trim().min(1),
    path: z.string().trim().min(1),
    positiveVariantId: z.string().trim().min(1),
    provenanceEntryIds: z.array(z.string().trim().min(1)).min(1),
    replayPlanHash: z.string().regex(/^sha256:[A-Za-z0-9:_-]+$/u),
    sidecarPath: z.string().trim().min(1),
    sourceImageRef: z.string().trim().min(1),
    sourcePath: z.string().trim().min(1),
  })
  .strict()
  .superRefine((receipt, context) => {
    const outputName = receipt.outputPath.split(/[\\/]/u).at(-1);
    const sourceName = receipt.sourcePath.split(/[\\/]/u).at(-1);
    if (receipt.outputPath === receipt.sourcePath || outputName === sourceName) {
      context.addIssue({
        code: 'custom',
        message: 'Negative Lab positive output receipt must not overwrite the source negative.',
        path: ['outputPath'],
      });
    }

    if (receipt.path !== receipt.outputPath) {
      context.addIssue({
        code: 'custom',
        message: 'Negative Lab positive output receipt editor path must match output path.',
        path: ['path'],
      });
    }

    if (receipt.outputArtifact.kind !== 'export') {
      context.addIssue({
        code: 'custom',
        message: 'Negative Lab positive output receipt must reference an export artifact.',
        path: ['outputArtifact', 'kind'],
      });
    }
  });

export const negativeLabApplyResultV1Schema = z
  .object({
    appliedGraphRevision: z.string().trim().min(1),
    changeSet: negativeLabChangeSetV1Schema,
    commandId: z.string().trim().min(1),
    commandType: negativeLabCommandTypeSchema,
    correlationId: z.string().trim().min(1),
    dryRunCommandId: z.string().trim().min(1).optional(),
    noOverwritePolicy: z.literal('never_overwrite_original'),
    positiveOutputReceipts: z.array(negativeLabPositiveOutputReceiptV1Schema).min(1),
    proof: negativeLabRuntimeProofV1Schema.optional(),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sessionId: z.string().trim().min(1),
    warnings: z.array(negativeWarningV1Schema),
  })
  .strict();

export const aiToolProviderClassV1Schema = z.enum(['local_model', 'self_hosted_connector', 'cloud_service']);

export const aiToolCapabilityV1Schema = z.enum([
  'subject_mask',
  'foreground_mask',
  'person_mask',
  'sky_mask',
  'depth_mask',
  'inpaint',
  'denoise',
  'enhance',
]);

export const aiToolPromptPolicyV1Schema = z.enum(['none', 'operator_prompt', 'system_generated']);

export const aiToolSourcePixelDisclosureV1Schema = z.enum(['local_only', 'may_leave_machine']);

export const aiEnhancementCapabilityV1Schema = z.enum(['inpaint', 'denoise', 'enhance']);

export const aiEnhancementQualityPreferenceV1Schema = z.enum(['preview', 'balanced', 'best']);

export const aiSidecarProvenanceEntryV1Schema = z
  .object({
    acceptedDryRunPlanHash: z.string().trim().min(1),
    acceptedDryRunPlanId: z.string().trim().min(1),
    approvalClass: approvalClassSchema,
    approvalRecordId: z.string().trim().min(1),
    capability: aiToolCapabilityV1Schema.or(aiEnhancementCapabilityV1Schema),
    commandId: z.string().trim().min(1),
    commandType: z.enum(['ai.mask.applySubject', 'ai.enhancement.apply']),
    correlationId: z.string().trim().min(1),
    modelHash: z.string().trim().min(1).optional(),
    modelId: z.string().trim().min(1),
    modelVersion: z.string().trim().min(1).optional(),
    outputArtifactIds: z.array(z.string().trim().min(1)).min(1),
    promptHash: z.string().trim().min(1).optional(),
    promptPolicy: aiToolPromptPolicyV1Schema,
    provenanceEntryId: z.string().trim().min(1),
    providerClass: aiToolProviderClassV1Schema,
    providerId: z.string().trim().min(1),
    qualityPreference: aiEnhancementQualityPreferenceV1Schema.optional(),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    settingsHash: z.string().trim().min(1),
    sourceContentHash: z.string().trim().min(1),
    sourceGraphRevision: z.string().trim().min(1),
    sourcePixelDisclosure: aiToolSourcePixelDisclosureV1Schema,
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.approvalClass !== ApprovalClass.GenerativeEdit) {
      context.addIssue({
        code: 'custom',
        message: 'AI sidecar provenance entries are written by approved generative apply commands.',
        path: ['approvalClass'],
      });
    }

    if (entry.providerClass === 'cloud_service' && entry.sourcePixelDisclosure === 'local_only') {
      context.addIssue({
        code: 'custom',
        message: 'Cloud AI provenance must disclose that source pixels may leave the machine.',
        path: ['sourcePixelDisclosure'],
      });
    }

    if (entry.promptPolicy === 'operator_prompt' && entry.promptHash === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Operator-prompt AI provenance requires a prompt hash instead of raw prompt text.',
        path: ['promptHash'],
      });
    }

    if (entry.commandType === 'ai.mask.applySubject' && entry.qualityPreference !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'AI mask provenance must not include enhancement quality preference.',
        path: ['qualityPreference'],
      });
    }
  });

export const aiToolCommandEnvelopeV1Schema = commandEnvelopeV1Schema
  .extend({
    commandType: z.enum(['ai.mask.generateSubject', 'ai.mask.applySubject']),
    parameters: z
      .object({
        acceptedDryRunPlanHash: z.string().trim().min(1).optional(),
        acceptedDryRunPlanId: z.string().trim().min(1).optional(),
        cachePolicy: z.enum(['reuse_allowed', 'force_refresh']),
        capability: aiToolCapabilityV1Schema,
        maskName: z.string().trim().min(1),
        maxPreviewDimensionPx: z.number().int().min(256).max(8192),
        modelHash: z.string().trim().min(1).optional(),
        modelId: z.string().trim().min(1),
        modelVersion: z.string().trim().min(1).optional(),
        promptPolicy: aiToolPromptPolicyV1Schema,
        providerClass: aiToolProviderClassV1Schema,
        providerId: z.string().trim().min(1),
        sourceContentHash: z.string().trim().min(1),
        sourcePixelDisclosure: aiToolSourcePixelDisclosureV1Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine((command, context) => {
    if (
      command.parameters.providerClass === 'cloud_service' &&
      command.parameters.sourcePixelDisclosure === 'local_only'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Cloud AI providers must disclose that source pixels may leave the machine.',
        path: ['parameters', 'sourcePixelDisclosure'],
      });
    }

    if (command.dryRun) {
      if (command.commandType !== 'ai.mask.generateSubject') {
        context.addIssue({
          code: 'custom',
          message: 'AI dry-run commands must use ai.mask.generateSubject.',
          path: ['commandType'],
        });
      }

      if (command.approval.approvalClass !== ApprovalClass.ExternalModel) {
        context.addIssue({
          code: 'custom',
          message: 'AI dry-run commands require external-model approval classification.',
          path: ['approval', 'approvalClass'],
        });
      }

      if (command.parameters.acceptedDryRunPlanId !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'AI dry-run commands must not accept an existing dry-run plan id.',
          path: ['parameters', 'acceptedDryRunPlanId'],
        });
      }
    } else {
      if (command.commandType !== 'ai.mask.applySubject') {
        context.addIssue({
          code: 'custom',
          message: 'AI apply commands must use ai.mask.applySubject.',
          path: ['commandType'],
        });
      }

      if (command.approval.approvalClass !== ApprovalClass.GenerativeEdit) {
        context.addIssue({
          code: 'custom',
          message: 'AI apply commands require generative-edit approval classification.',
          path: ['approval', 'approvalClass'],
        });
      }

      if (command.approval.state !== 'approved') {
        context.addIssue({
          code: 'custom',
          message: 'AI apply commands require approved user approval.',
          path: ['approval', 'state'],
        });
      }

      if (command.parameters.acceptedDryRunPlanId === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'AI apply commands require an accepted dry-run plan id.',
          path: ['parameters', 'acceptedDryRunPlanId'],
        });
      }

      if (command.parameters.acceptedDryRunPlanHash === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'AI apply commands require an accepted dry-run plan hash.',
          path: ['parameters', 'acceptedDryRunPlanHash'],
        });
      }
    }
  });

export const aiToolDryRunResultV1Schema = z
  .object({
    commandId: z.string().trim().min(1),
    commandType: z.literal('ai.mask.generateSubject'),
    correlationId: z.string().trim().min(1),
    dryRunPlanHash: z.string().trim().min(1),
    dryRunPlanId: z.string().trim().min(1),
    maskArtifacts: z.array(artifactHandleV1Schema).min(1),
    maskCoverageRatio: z.number().positive().max(1),
    maskPreviewRows: z.array(z.string().regex(/^[0-9a-f]+$/u)).min(1),
    modelId: z.string().trim().min(1),
    modelVersion: z.string().trim().min(1).optional(),
    previewArtifacts: z.array(artifactHandleV1Schema),
    providerClass: aiToolProviderClassV1Schema,
    providerId: z.string().trim().min(1),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sourceContentHash: z.string().trim().min(1),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict();

export const aiEnhancementCommandEnvelopeV1Schema = commandEnvelopeV1Schema
  .extend({
    commandType: z.enum(['ai.enhancement.dryRun', 'ai.enhancement.apply']),
    parameters: z
      .object({
        acceptedDryRunPlanHash: z.string().trim().min(1).optional(),
        acceptedDryRunPlanId: z.string().trim().min(1).optional(),
        cachePolicy: z.enum(['reuse_allowed', 'force_refresh']),
        capability: aiEnhancementCapabilityV1Schema,
        maxPreviewDimensionPx: z.number().int().min(256).max(8192),
        modelHash: z.string().trim().min(1).optional(),
        modelId: z.string().trim().min(1),
        modelVersion: z.string().trim().min(1).optional(),
        prompt: z.string().trim().min(1).optional(),
        promptPolicy: aiToolPromptPolicyV1Schema,
        providerClass: aiToolProviderClassV1Schema,
        providerId: z.string().trim().min(1),
        qualityPreference: aiEnhancementQualityPreferenceV1Schema,
        regionMaskArtifactId: z.string().trim().min(1).optional(),
        sourceContentHash: z.string().trim().min(1),
        sourcePixelDisclosure: aiToolSourcePixelDisclosureV1Schema,
        strength: z.number().min(0).max(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((command, context) => {
    if (
      command.parameters.providerClass === 'cloud_service' &&
      command.parameters.sourcePixelDisclosure === 'local_only'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Cloud AI providers must disclose that source pixels may leave the machine.',
        path: ['parameters', 'sourcePixelDisclosure'],
      });
    }

    if (command.parameters.promptPolicy === 'operator_prompt' && command.parameters.prompt === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Operator-prompt AI enhancement commands require a prompt.',
        path: ['parameters', 'prompt'],
      });
    }

    if (command.parameters.promptPolicy === 'none' && command.parameters.prompt !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Prompt-free AI enhancement commands must not include prompt text.',
        path: ['parameters', 'prompt'],
      });
    }

    if (command.parameters.capability === 'inpaint' && command.parameters.regionMaskArtifactId === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'AI inpaint enhancement commands require a region mask artifact.',
        path: ['parameters', 'regionMaskArtifactId'],
      });
    }

    if (command.dryRun) {
      if (command.commandType !== 'ai.enhancement.dryRun') {
        context.addIssue({
          code: 'custom',
          message: 'AI enhancement dry-run commands must use ai.enhancement.dryRun.',
          path: ['commandType'],
        });
      }

      if (command.approval.approvalClass !== ApprovalClass.ExternalModel) {
        context.addIssue({
          code: 'custom',
          message: 'AI enhancement dry-run commands require external-model approval classification.',
          path: ['approval', 'approvalClass'],
        });
      }

      if (command.parameters.acceptedDryRunPlanId !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'AI enhancement dry-run commands must not accept an existing dry-run plan id.',
          path: ['parameters', 'acceptedDryRunPlanId'],
        });
      }
    } else {
      if (command.commandType !== 'ai.enhancement.apply') {
        context.addIssue({
          code: 'custom',
          message: 'AI enhancement apply commands must use ai.enhancement.apply.',
          path: ['commandType'],
        });
      }

      if (command.approval.approvalClass !== ApprovalClass.GenerativeEdit) {
        context.addIssue({
          code: 'custom',
          message: 'AI enhancement apply commands require generative-edit approval classification.',
          path: ['approval', 'approvalClass'],
        });
      }

      if (command.approval.state !== 'approved') {
        context.addIssue({
          code: 'custom',
          message: 'AI enhancement apply commands require approved user approval.',
          path: ['approval', 'state'],
        });
      }

      if (command.parameters.acceptedDryRunPlanId === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'AI enhancement apply commands require an accepted dry-run plan id.',
          path: ['parameters', 'acceptedDryRunPlanId'],
        });
      }

      if (command.parameters.acceptedDryRunPlanHash === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'AI enhancement apply commands require an accepted dry-run plan hash.',
          path: ['parameters', 'acceptedDryRunPlanHash'],
        });
      }
    }
  });

export const aiEnhancementDryRunResultV1Schema = z
  .object({
    commandId: z.string().trim().min(1),
    commandType: z.literal('ai.enhancement.dryRun'),
    correlationId: z.string().trim().min(1),
    dryRunPlanHash: z.string().trim().min(1),
    dryRunPlanId: z.string().trim().min(1),
    enhancementArtifacts: z.array(artifactHandleV1Schema).min(1),
    modelId: z.string().trim().min(1),
    modelVersion: z.string().trim().min(1).optional(),
    previewArtifacts: z.array(artifactHandleV1Schema).min(1),
    providerClass: aiToolProviderClassV1Schema,
    providerId: z.string().trim().min(1),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sourceContentHash: z.string().trim().min(1),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict();

export const aiEnhancementApplyResultV1Schema = z
  .object({
    appliedGraphRevision: z.string().trim().min(1),
    changedEditNodeIds: z.array(z.string().trim().min(1)).min(1),
    commandId: z.string().trim().min(1),
    commandType: z.literal('ai.enhancement.apply'),
    correlationId: z.string().trim().min(1),
    dryRunPlanHash: z.string().trim().min(1),
    dryRunPlanId: z.string().trim().min(1),
    outputArtifacts: z.array(artifactHandleV1Schema).min(1),
    provenanceEntryIds: z.array(z.string().trim().min(1)).min(1),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sourceGraphRevision: z.string().trim().min(1),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict();

export const aiToolApplyResultV1Schema = z
  .object({
    appliedGraphRevision: z.string().trim().min(1),
    changedMaskIds: z.array(z.string().trim().min(1)).min(1),
    commandId: z.string().trim().min(1),
    commandType: z.literal('ai.mask.applySubject'),
    correlationId: z.string().trim().min(1),
    dryRunPlanHash: z.string().trim().min(1),
    dryRunPlanId: z.string().trim().min(1),
    outputArtifacts: z.array(artifactHandleV1Schema).min(1),
    provenanceEntryIds: z.array(z.string().trim().min(1)).min(1),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sourceGraphRevision: z.string().trim().min(1),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict();

export const rawEngineImageGetPreviewRequestV1Schema = z
  .object({
    expectedRecipeHash: z.string().trim().min(1).optional(),
    requestId: z.string().trim().min(1),
  })
  .strict();

export const rawEngineAgentPreviewRenderRequestV1Schema = z
  .object({
    crop: z
      .object({
        height: z.number().positive().max(1),
        width: z.number().positive().max(1),
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
      })
      .strict()
      .optional(),
    expectedRecipeHash: z.string().trim().min(1).optional(),
    longEdgePx: z.number().int().min(256).max(2048).default(1536),
    maxPixelCount: z.number().int().min(65_536).max(4_194_304).default(4_194_304),
    purpose: z.enum(['detail_review', 'initial_context', 'refresh']).default('refresh'),
    quality: z.number().min(0.5).max(0.95).default(0.86),
    requestId: z.string().trim().min(1),
    sourceToolName: z.string().trim().min(1).default('rawengine.agent.preview.render'),
    turn: z.number().int().positive().default(1),
    zoom: z
      .object({
        centerX: z.number().min(0).max(1),
        centerY: z.number().min(0).max(1),
        scale: z.number().min(1).max(8),
      })
      .strict()
      .optional(),
  })
  .strict();

const rawEngineAppServerKnownInputSchemas = {
  AgentPreviewRenderRequestV1: rawEngineAgentPreviewRenderRequestV1Schema,
  AiEnhancementCommandEnvelopeV1: aiEnhancementCommandEnvelopeV1Schema,
  AiToolCommandEnvelopeV1: aiToolCommandEnvelopeV1Schema,
  CommandEnvelopeV1: commandEnvelopeV1Schema,
  ComputationalMergeCommandEnvelopeV1: computationalMergeCommandEnvelopeV1Schema,
  ComputationalMergeDerivedSourceOpenRequestV1: computationalMergeDerivedSourceOpenRequestV1Schema,
  DetailDeblurCommandEnvelopeV1: detailDeblurCommandEnvelopeV1Schema,
  DetailDenoiseCommandEnvelopeV1: detailDenoiseCommandEnvelopeV1Schema,
  DetailEffectsCommandEnvelopeV1: detailEffectsCommandEnvelopeV1Schema,
  LensProfileCommandEnvelopeV1: lensProfileCommandEnvelopeV1Schema,
  EditGraphCommandEnvelopeV1: editGraphCommandEnvelopeV1Schema,
  EditGraphSnapshotQueryV1: editGraphSnapshotQueryV1Schema,
  ExportCommandEnvelopeV1: exportCommandEnvelopeV1Schema,
  LayerMaskCommandEnvelopeV1: layerMaskCommandEnvelopeV1Schema,
  NegativeLabApplyPlanRequestV1: negativeLabApplyPlanRequestV1Schema,
  NegativeLabCommandEnvelopeV1: negativeLabCommandEnvelopeV1Schema,
  PreviewScopeQueryV1: previewScopeQueryV1Schema,
  ProjectLibraryCommandEnvelopeV1: projectLibraryCommandEnvelopeV1Schema,
  ProjectLibrarySnapshotQueryV1: projectLibrarySnapshotQueryV1Schema,
  QueryEnvelopeV1: queryEnvelopeV1Schema,
  RawEngineImageGetPreviewRequestV1: rawEngineImageGetPreviewRequestV1Schema,
  ToneColorCommandEnvelopeV1: toneColorCommandEnvelopeV1Schema,
} as const;

export const {
  rawEngineAppServerProtocolV1Schema,
  rawEngineAppServerToolCallV1Schema,
  rawEngineAppServerToolCallValidationV1Schema,
  rawEngineAppServerTransportV1Schema,
} = createAppServerCommandSchemasV1({
  approvalRequirementSchema,
  knownInputSchemas: rawEngineAppServerKnownInputSchemas,
  rawEngineToolKindSchema,
  rawEngineToolRegistryV1Schema,
  schemaVersion: RAW_ENGINE_SCHEMA_VERSION,
});

export const rawEngineAgentReplayNoOverwritePolicyV1Schema = z.literal('never_overwrite_original');

export const rawEngineAgentReplayAuditParameterDiffV1Schema = z
  .object({
    path: z.string().trim().min(1),
    previousValue: z.unknown().optional(),
    value: z.unknown().optional(),
  })
  .strict();

export const rawEngineAgentReplayAuditLogV1Schema = z
  .object({
    affectedArtifactIds: z.array(z.string().trim().min(1)),
    affectedImageIds: z.array(z.string().trim().min(1)).min(1),
    noOverwritePolicy: rawEngineAgentReplayNoOverwritePolicyV1Schema,
    parameterDiff: z.array(rawEngineAgentReplayAuditParameterDiffV1Schema).min(1),
    rollbackPoint: z
      .object({
        graphRevision: z.string().trim().min(1),
        undoRevision: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
    toolCall: z
      .object({
        inputSchemaName: z.string().trim().min(1),
        toolKind: rawEngineToolKindSchema,
        toolName: z
          .string()
          .trim()
          .regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/u),
      })
      .strict(),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict();

export const rawEngineAgentReplayStepV1Schema = z
  .object({
    auditLog: rawEngineAgentReplayAuditLogV1Schema,
    approval: approvalRequirementSchema,
    deterministic: z.boolean(),
    dryRun: z.boolean(),
    input: z.unknown(),
    inputContentHash: z.string().trim().min(1),
    inputSchemaName: z.string().trim().min(1),
    mutates: z.boolean(),
    output: z.unknown(),
    outputContentHash: z.string().trim().min(1),
    outputSchemaName: z.string().trim().min(1),
    prerequisiteStepIds: z.array(z.string().trim().min(1)),
    resultingGraphRevision: z.string().trim().min(1).optional(),
    sourceGraphRevision: z.string().trim().min(1).optional(),
    stepId: z.string().trim().min(1),
    toolKind: rawEngineToolKindSchema,
    toolName: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/u),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict()
  .superRefine((step, context) => {
    if (step.dryRun && step.mutates) {
      context.addIssue({
        code: 'custom',
        message: 'Replay dry-run steps must not be marked as mutating.',
        path: ['mutates'],
      });
    }

    if (step.dryRun && step.resultingGraphRevision !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Replay dry-run steps must not claim a resulting graph revision.',
        path: ['resultingGraphRevision'],
      });
    }

    if (step.mutates && step.approval.state !== 'approved') {
      context.addIssue({
        code: 'custom',
        message: 'Replay mutation steps require approved user approval.',
        path: ['approval', 'state'],
      });
    }

    if (step.mutates && step.resultingGraphRevision === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Replay mutation steps require a resulting graph revision.',
        path: ['resultingGraphRevision'],
      });
    }

    if (
      step.mutates &&
      step.sourceGraphRevision !== undefined &&
      step.resultingGraphRevision === step.sourceGraphRevision
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Replay mutation steps must advance the graph revision.',
        path: ['resultingGraphRevision'],
      });
    }

    if (step.auditLog.toolCall.toolName !== step.toolName) {
      context.addIssue({
        code: 'custom',
        message: 'Replay audit log tool name must match the step tool name.',
        path: ['auditLog', 'toolCall', 'toolName'],
      });
    }

    if (step.auditLog.toolCall.toolKind !== step.toolKind) {
      context.addIssue({
        code: 'custom',
        message: 'Replay audit log tool kind must match the step tool kind.',
        path: ['auditLog', 'toolCall', 'toolKind'],
      });
    }

    if (step.auditLog.toolCall.inputSchemaName !== step.inputSchemaName) {
      context.addIssue({
        code: 'custom',
        message: 'Replay audit log input schema must match the step input schema.',
        path: ['auditLog', 'toolCall', 'inputSchemaName'],
      });
    }

    if (step.mutates && step.auditLog.rollbackPoint === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Replay mutation audit logs require a rollback point.',
        path: ['auditLog', 'rollbackPoint'],
      });
    }

    if (step.auditLog.warnings.length !== step.warnings.length) {
      context.addIssue({
        code: 'custom',
        message: 'Replay audit log warnings must mirror step warnings.',
        path: ['auditLog', 'warnings'],
      });
    }
  });

export const rawEngineAgentReplayFixtureV1Schema = z
  .object({
    actor: rawEngineActorSchema,
    deterministicReplayHash: z.string().trim().min(1),
    finalGraphRevision: z.string().trim().min(1).optional(),
    initialGraphRevision: z.string().trim().min(1).optional(),
    registry: rawEngineToolRegistryV1Schema,
    replayId: z.string().trim().min(1),
    replayKind: z.enum(['agent_tool_replay']),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    steps: z.array(rawEngineAgentReplayStepV1Schema).min(1),
    target: rawEngineTargetSchema,
    validationProfile: z.enum(['schema_contract', 'golden_replay', 'visual_regression']),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict()
  .superRefine((fixture, context) => {
    const seenStepIds = new Set<string>();
    let lastResultingGraphRevision: string | undefined;

    fixture.steps.forEach((step, stepIndex) => {
      if (seenStepIds.has(step.stepId)) {
        context.addIssue({
          code: 'custom',
          message: 'Replay step ids must be unique.',
          path: ['steps', stepIndex, 'stepId'],
        });
      }

      for (const prerequisiteStepId of step.prerequisiteStepIds) {
        if (!seenStepIds.has(prerequisiteStepId)) {
          context.addIssue({
            code: 'custom',
            message: 'Replay prerequisite steps must reference earlier steps.',
            path: ['steps', stepIndex, 'prerequisiteStepIds'],
          });
        }
      }

      const toolDefinition = fixture.registry.tools.find((tool) => tool.toolName === step.toolName);

      if (toolDefinition === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Replay steps must reference registered RawEngine tools.',
          path: ['steps', stepIndex, 'toolName'],
        });
      } else {
        if (toolDefinition.toolKind !== step.toolKind) {
          context.addIssue({
            code: 'custom',
            message: 'Replay step tool kind must match the registered tool definition.',
            path: ['steps', stepIndex, 'toolKind'],
          });
        }

        if (toolDefinition.inputSchemaName !== step.inputSchemaName) {
          context.addIssue({
            code: 'custom',
            message: 'Replay step input schema must match the registered tool definition.',
            path: ['steps', stepIndex, 'inputSchemaName'],
          });
        }

        if (toolDefinition.outputSchemaName !== step.outputSchemaName) {
          context.addIssue({
            code: 'custom',
            message: 'Replay step output schema must match the registered tool definition.',
            path: ['steps', stepIndex, 'outputSchemaName'],
          });
        }

        if (toolDefinition.approvalClass !== step.approval.approvalClass) {
          context.addIssue({
            code: 'custom',
            message: 'Replay step approval class must match the registered tool definition.',
            path: ['steps', stepIndex, 'approval', 'approvalClass'],
          });
        }

        if (toolDefinition.mutates !== step.mutates) {
          context.addIssue({
            code: 'custom',
            message: 'Replay step mutation flag must match the registered tool definition.',
            path: ['steps', stepIndex, 'mutates'],
          });
        }

        if (toolDefinition.mutates && toolDefinition.requiresDryRun && step.prerequisiteStepIds.length === 0) {
          context.addIssue({
            code: 'custom',
            message: 'Replay steps for tools that require dry-run plans must reference a prerequisite dry-run step.',
            path: ['steps', stepIndex, 'prerequisiteStepIds'],
          });
        }
      }

      if (step.resultingGraphRevision !== undefined) {
        lastResultingGraphRevision = step.resultingGraphRevision;
      }

      seenStepIds.add(step.stepId);
    });

    if (
      fixture.finalGraphRevision !== undefined &&
      lastResultingGraphRevision !== undefined &&
      fixture.finalGraphRevision !== lastResultingGraphRevision
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Replay final graph revision must match the last mutation step.',
        path: ['finalGraphRevision'],
      });
    }
  });

export const negativeLabConversionOperationArtifactPurposeV1Schema = z.enum([
  'objective_positive_preview',
  'density_map',
  'base_sample_overlay',
  'clipping_overlay',
  'warning_report',
  'parameter_diff',
  'qc_contact_sheet',
  'editable_positive_variant',
  'export_ready_positive',
]);

export const negativeLabConversionOperationParameterRefsV1Schema = z
  .object({
    acquisitionProfileId: z.string().trim().min(1).optional(),
    baseEstimateId: z.string().trim().min(1).optional(),
    baseSampleIds: z.array(z.string().trim().min(1)),
    conversionRecipeId: z.string().trim().min(1).optional(),
    curveSetId: z.string().trim().min(1).optional(),
    dryRunPlanId: z.string().trim().min(1).optional(),
    inputProfileId: z.string().trim().min(1).optional(),
    normalizationProfileId: z.string().trim().min(1).optional(),
    outputTransformId: z.string().trim().min(1).optional(),
    positiveVariantIds: z.array(z.string().trim().min(1)),
    processProfileId: z.string().trim().min(1).optional(),
    qcProofId: z.string().trim().min(1).optional(),
  })
  .strict();

export const negativeLabConversionOperationProvenanceV1Schema = z
  .object({
    actor: rawEngineActorSchema,
    commandId: z.string().trim().min(1),
    correlationId: z.string().trim().min(1),
    createdAt: z.string().trim().min(1),
    dryRunCommandId: z.string().trim().min(1).optional(),
    idempotencyKey: z.string().trim().min(1).optional(),
    localOnly: z.boolean(),
    source: z.enum(['ui', 'app_server_agent', 'cli', 'batch']),
  })
  .strict();

export const negativeLabConversionOperationV1Schema = z
  .object({
    approvalClass: approvalClassSchema,
    artifactPurposes: z.array(negativeLabConversionOperationArtifactPurposeV1Schema),
    changeSet: negativeLabChangeSetV1Schema.optional(),
    commandType: negativeLabCommandTypeSchema,
    expectedGraphRevision: z.string().trim().min(1).optional(),
    frameSelection: negativeLabFrameSelectionV1Schema,
    mutates: z.boolean(),
    operationClass: negativeLabOperationClassSchema,
    operationId: z.string().trim().min(1),
    operationStage: negativeLabOperationStageSchema,
    outputArtifacts: z.array(artifactHandleV1Schema),
    parameterRefs: negativeLabConversionOperationParameterRefsV1Schema,
    provenance: negativeLabConversionOperationProvenanceV1Schema,
    resultGraphRevision: z.string().trim().min(1).optional(),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sessionId: z.string().trim().min(1),
    sourceGraphRevision: z.string().trim().min(1),
    warnings: z.array(negativeWarningV1Schema),
  })
  .strict()
  .superRefine((operation, context) => {
    const expectedStage = negativeLabCommandStageByType[operation.commandType];
    if (operation.operationStage !== expectedStage) {
      context.addIssue({
        code: 'custom',
        message: 'Negative Lab operation stage must match the command type.',
        path: ['operationStage'],
      });
    }

    const expectedClass = negativeLabOperationClassByStage[operation.operationStage];
    if (operation.operationClass !== expectedClass) {
      context.addIssue({
        code: 'custom',
        message: 'Negative Lab operation class must match the operation stage.',
        path: ['operationClass'],
      });
    }

    if (operation.mutates) {
      if (!negativeLabMutatingApprovalClasses.includes(operation.approvalClass)) {
        context.addIssue({
          code: 'custom',
          message: 'Mutating Negative Lab operations require an apply-class approval.',
          path: ['approvalClass'],
        });
      }

      if (operation.changeSet === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Mutating Negative Lab operations require a change set.',
          path: ['changeSet'],
        });
      }

      if (operation.resultGraphRevision === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Mutating Negative Lab operations require a result graph revision.',
          path: ['resultGraphRevision'],
        });
      }
    } else {
      if (operation.changeSet !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Dry-run Negative Lab operations must not include an applied change set.',
          path: ['changeSet'],
        });
      }

      if (operation.resultGraphRevision !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Dry-run Negative Lab operations must not include a result graph revision.',
          path: ['resultGraphRevision'],
        });
      }
    }

    if (operation.commandType === 'negativeLab.setConversionRecipe') {
      const { conversionRecipeId, curveSetId, processProfileId } = operation.parameterRefs;
      if (conversionRecipeId === undefined && curveSetId === undefined && processProfileId === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Conversion recipe operations require a recipe, curve-set, or process-profile reference.',
          path: ['parameterRefs'],
        });
      }
    }

    if (operation.commandType === 'negativeLab.createPositiveVariant') {
      if (operation.parameterRefs.positiveVariantIds.length === 0) {
        context.addIssue({
          code: 'custom',
          message: 'Positive variant creation operations require positive variant IDs.',
          path: ['parameterRefs', 'positiveVariantIds'],
        });
      }

      if (operation.outputArtifacts.length === 0) {
        context.addIssue({
          code: 'custom',
          message: 'Positive variant creation operations require output artifacts.',
          path: ['outputArtifacts'],
        });
      }
    }
  });

export const negativeLabPositiveVariantProvenanceV1Schema = z
  .object({
    acknowledgedWarningCodes: z.array(negativeWarningCodeSchema),
    acquisitionProfileId: z.string().trim().min(1),
    applyCommandId: z.string().trim().min(1),
    baseSampleIds: nonEmptyIdArraySchema,
    conversionCommandId: z.string().trim().min(1),
    conversionRecipeId: z.string().trim().min(1),
    createdAt: z.string().trim().min(1),
    createdBy: rawEngineActorSchema,
    dryRunPlanId: z.string().trim().min(1),
    graphRevision: z.string().trim().min(1),
    inheritedRollDefaults: z.boolean(),
    outputIntent: z.enum(['editable_positive', 'proof_preview', 'export_ready_preview']),
    outputTransformRef: negativeLabOutputTransformRefV1Schema,
    positiveVariantId: z.string().trim().min(1),
    previewArtifactHandles: z.array(artifactHandleV1Schema),
    processFamily: negativeLabSupportedProcessFamilyV1Schema,
    provenanceEntryIds: nonEmptyIdArraySchema,
    rollSessionId: z.string().trim().min(1),
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    sourceContentHash: z.string().trim().min(1),
    sourceFileId: z.string().trim().min(1),
    sourceFrameId: z.string().trim().min(1),
    variantName: z.string().trim().min(1),
    variantNameSource: z.enum(['user_supplied', 'generated_generic']),
    warningCodes: z.array(negativeWarningCodeSchema),
  })
  .strict();

export const aiAppServerExecutionModeV1Schema = z.enum(['capability_read', 'dry_run_command', 'apply_dry_run_plan']);

export const aiAppServerAuditEventV1Schema = z.enum([
  'ai_tool_capability_requested',
  'ai_tool_capability_completed',
  'ai_tool_dry_run_requested',
  'ai_tool_dry_run_completed',
  'ai_tool_apply_requested',
  'ai_tool_apply_completed',
]);

export const aiAppServerToolDefinitionV1Schema = z
  .object({
    allowedCapabilities: z.array(aiToolCapabilityV1Schema).min(1),
    allowedProviderClasses: z.array(aiToolProviderClassV1Schema).min(1),
    approvalClass: approvalClassSchema,
    auditEvents: z.array(aiAppServerAuditEventV1Schema).min(1),
    description: z.string().trim().min(1),
    executionMode: aiAppServerExecutionModeV1Schema,
    inputSchemaName: z.string().trim().min(1),
    localOnly: z.boolean(),
    mutates: z.boolean(),
    outputSchemaName: z.string().trim().min(1),
    recordsProvenance: z.boolean(),
    requiresDryRunPlan: z.boolean(),
    returnsArtifactHandles: z.boolean(),
    toolName: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/u),
  })
  .strict()
  .superRefine((tool, context) => {
    if (tool.localOnly && tool.allowedProviderClasses.includes('cloud_service')) {
      context.addIssue({
        code: 'custom',
        message: 'Local-only AI app-server tools must not allow cloud-service providers.',
        path: ['allowedProviderClasses'],
      });
    }

    if ((tool.mutates || tool.returnsArtifactHandles) && !tool.recordsProvenance) {
      context.addIssue({
        code: 'custom',
        message: 'AI app-server tools that mutate or return artifacts must record provenance.',
        path: ['recordsProvenance'],
      });
    }

    if (tool.executionMode === 'dry_run_command') {
      if (!['AiEnhancementCommandEnvelopeV1', 'AiToolCommandEnvelopeV1'].includes(tool.inputSchemaName)) {
        context.addIssue({
          code: 'custom',
          message: 'AI dry-run app-server tools must accept an AI command envelope.',
          path: ['inputSchemaName'],
        });
      }

      if (tool.inputSchemaName === 'AiToolCommandEnvelopeV1' && tool.outputSchemaName !== 'AiToolDryRunResultV1') {
        context.addIssue({
          code: 'custom',
          message: 'AI mask dry-run app-server tools must return AiToolDryRunResultV1.',
          path: ['outputSchemaName'],
        });
      }

      if (
        tool.inputSchemaName === 'AiEnhancementCommandEnvelopeV1' &&
        tool.outputSchemaName !== 'AiEnhancementDryRunResultV1'
      ) {
        context.addIssue({
          code: 'custom',
          message: 'AI enhancement dry-run app-server tools must return AiEnhancementDryRunResultV1.',
          path: ['outputSchemaName'],
        });
      }

      if (tool.mutates) {
        context.addIssue({
          code: 'custom',
          message: 'AI dry-run app-server tools must not mutate project state.',
          path: ['mutates'],
        });
      }

      if (tool.requiresDryRunPlan) {
        context.addIssue({
          code: 'custom',
          message: 'AI dry-run app-server tools create dry-run plans and must not require one.',
          path: ['requiresDryRunPlan'],
        });
      }

      if (tool.approvalClass !== ApprovalClass.ExternalModel) {
        context.addIssue({
          code: 'custom',
          message: 'AI dry-run app-server tools require external-model approval classification.',
          path: ['approvalClass'],
        });
      }
    }

    if (tool.executionMode === 'apply_dry_run_plan') {
      if (!['AiEnhancementCommandEnvelopeV1', 'AiToolCommandEnvelopeV1'].includes(tool.inputSchemaName)) {
        context.addIssue({
          code: 'custom',
          message: 'AI apply app-server tools must accept an AI command envelope.',
          path: ['inputSchemaName'],
        });
      }

      if (tool.inputSchemaName === 'AiToolCommandEnvelopeV1' && tool.outputSchemaName !== 'AiToolApplyResultV1') {
        context.addIssue({
          code: 'custom',
          message: 'AI mask apply app-server tools must return AiToolApplyResultV1.',
          path: ['outputSchemaName'],
        });
      }

      if (
        tool.inputSchemaName === 'AiEnhancementCommandEnvelopeV1' &&
        tool.outputSchemaName !== 'AiEnhancementApplyResultV1'
      ) {
        context.addIssue({
          code: 'custom',
          message: 'AI enhancement apply app-server tools must return AiEnhancementApplyResultV1.',
          path: ['outputSchemaName'],
        });
      }

      if (!tool.mutates) {
        context.addIssue({
          code: 'custom',
          message: 'AI apply app-server tools must be marked as mutating.',
          path: ['mutates'],
        });
      }

      if (!tool.requiresDryRunPlan) {
        context.addIssue({
          code: 'custom',
          message: 'AI apply app-server tools must require a prior dry-run plan.',
          path: ['requiresDryRunPlan'],
        });
      }

      if (tool.approvalClass !== ApprovalClass.GenerativeEdit) {
        context.addIssue({
          code: 'custom',
          message: 'AI apply app-server tools require generative-edit approval classification.',
          path: ['approvalClass'],
        });
      }
    }
  });

export const aiAppServerToolManifestV1Schema = z
  .object({
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    serverRuntime: z.literal('openai_app_server'),
    tools: z.array(aiAppServerToolDefinitionV1Schema).min(1),
  })
  .strict();

export const negativeLabAppServerExecutionModeSchema = z.enum(['dry_run_command', 'apply_dry_run_plan']);

export const negativeLabAppServerAuditEventSchema = z.enum([
  'negative_lab_dry_run_requested',
  'negative_lab_dry_run_completed',
  'negative_lab_apply_requested',
  'negative_lab_apply_completed',
]);

export const negativeLabAppServerToolDefinitionV1Schema = z
  .object({
    allowedCommandTypes: z.array(negativeLabCommandTypeSchema).min(1),
    approvalClass: approvalClassSchema,
    auditEvents: z.array(negativeLabAppServerAuditEventSchema).min(1),
    description: z.string().trim().min(1),
    executionMode: negativeLabAppServerExecutionModeSchema,
    inputSchemaName: z.string().trim().min(1),
    localOnly: z.boolean(),
    mutates: z.boolean(),
    outputSchemaName: z.string().trim().min(1),
    recordsProvenance: z.boolean(),
    requiresDryRunPlan: z.boolean(),
    returnsArtifactHandles: z.boolean(),
    toolName: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/u),
  })
  .strict()
  .superRefine((tool, context) => {
    if (tool.executionMode === 'dry_run_command') {
      if (tool.inputSchemaName !== 'NegativeLabCommandEnvelopeV1') {
        context.addIssue({
          code: 'custom',
          message: 'Negative Lab dry-run app-server tools must accept NegativeLabCommandEnvelopeV1.',
          path: ['inputSchemaName'],
        });
      }

      if (tool.outputSchemaName !== 'NegativeLabDryRunResultV1') {
        context.addIssue({
          code: 'custom',
          message: 'Negative Lab dry-run app-server tools must return NegativeLabDryRunResultV1.',
          path: ['outputSchemaName'],
        });
      }

      if (tool.mutates) {
        context.addIssue({
          code: 'custom',
          message: 'Negative Lab dry-run app-server tools must not mutate project state.',
          path: ['mutates'],
        });
      }

      if (tool.requiresDryRunPlan) {
        context.addIssue({
          code: 'custom',
          message: 'Negative Lab dry-run app-server tools create dry-run plans and must not require one.',
          path: ['requiresDryRunPlan'],
        });
      }
    }

    if (tool.executionMode === 'apply_dry_run_plan') {
      if (tool.inputSchemaName !== 'NegativeLabApplyPlanRequestV1') {
        context.addIssue({
          code: 'custom',
          message: 'Negative Lab apply app-server tools must accept NegativeLabApplyPlanRequestV1.',
          path: ['inputSchemaName'],
        });
      }

      if (tool.outputSchemaName !== 'NegativeLabApplyResultV1') {
        context.addIssue({
          code: 'custom',
          message: 'Negative Lab apply app-server tools must return NegativeLabApplyResultV1.',
          path: ['outputSchemaName'],
        });
      }

      if (!tool.mutates) {
        context.addIssue({
          code: 'custom',
          message: 'Negative Lab apply app-server tools must be marked as mutating.',
          path: ['mutates'],
        });
      }

      if (!tool.requiresDryRunPlan) {
        context.addIssue({
          code: 'custom',
          message: 'Negative Lab apply app-server tools must require a prior dry-run plan.',
          path: ['requiresDryRunPlan'],
        });
      }
    }

    if (tool.mutates && tool.approvalClass !== ApprovalClass.EditApply) {
      context.addIssue({
        code: 'custom',
        message: 'Mutating Negative Lab app-server tools require edit-apply approval.',
        path: ['approvalClass'],
      });
    }

    if ((tool.mutates || tool.returnsArtifactHandles) && !tool.recordsProvenance) {
      context.addIssue({
        code: 'custom',
        message: 'Negative Lab app-server tools that mutate or return artifacts must record provenance.',
        path: ['recordsProvenance'],
      });
    }
  });

export const negativeLabAppServerToolManifestV1Schema = z
  .object({
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    serverRuntime: z.literal('openai_app_server'),
    tools: z.array(negativeLabAppServerToolDefinitionV1Schema).min(1),
  })
  .strict();

export const computationalMergeAppServerExecutionModeV1Schema = z.enum([
  'apply_dry_run_plan',
  'dry_run_command',
  'open_derived_source',
]);

export const computationalMergeAppServerAuditEventV1Schema = z.enum([
  'computational_merge_dry_run_requested',
  'computational_merge_dry_run_completed',
  'computational_merge_apply_requested',
  'computational_merge_apply_completed',
  'computational_merge_derived_source_open_requested',
  'computational_merge_derived_source_open_completed',
]);

export const computationalMergeAppServerToolDefinitionV1Schema = z
  .object({
    allowedCommandTypes: z.array(computationalMergeCommandTypeV1Schema).min(1),
    approvalClass: approvalClassSchema,
    auditEvents: z.array(computationalMergeAppServerAuditEventV1Schema).min(1),
    description: z.string().trim().min(1),
    executionMode: computationalMergeAppServerExecutionModeV1Schema,
    inputSchemaName: z.string().trim().min(1),
    localOnly: z.boolean(),
    mutates: z.boolean(),
    outputSchemaName: z.string().trim().min(1),
    recordsProvenance: z.boolean(),
    requiresDryRunPlan: z.boolean(),
    returnsArtifactHandles: z.boolean(),
    toolName: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/u),
  })
  .strict()
  .superRefine((tool, context) => {
    if (!tool.localOnly) {
      context.addIssue({
        code: 'custom',
        message: 'Computational merge app-server tools must be local-only for source RAW access and provenance.',
        path: ['localOnly'],
      });
    }

    if (tool.executionMode === 'dry_run_command') {
      if (tool.inputSchemaName !== 'ComputationalMergeCommandEnvelopeV1') {
        context.addIssue({
          code: 'custom',
          message: 'Computational merge dry-run app-server tools must accept ComputationalMergeCommandEnvelopeV1.',
          path: ['inputSchemaName'],
        });
      }

      if (tool.outputSchemaName !== 'ComputationalMergeDryRunResultV1') {
        context.addIssue({
          code: 'custom',
          message: 'Computational merge dry-run app-server tools must return ComputationalMergeDryRunResultV1.',
          path: ['outputSchemaName'],
        });
      }

      if (tool.mutates) {
        context.addIssue({
          code: 'custom',
          message: 'Computational merge dry-run app-server tools must not mutate project state.',
          path: ['mutates'],
        });
      }

      if (tool.requiresDryRunPlan) {
        context.addIssue({
          code: 'custom',
          message: 'Computational merge dry-run app-server tools create dry-run plans and must not require one.',
          path: ['requiresDryRunPlan'],
        });
      }

      if (tool.approvalClass !== ApprovalClass.PreviewOnly) {
        context.addIssue({
          code: 'custom',
          message: 'Computational merge dry-run app-server tools require preview-only approval classification.',
          path: ['approvalClass'],
        });
      }
    }

    if (tool.executionMode === 'apply_dry_run_plan') {
      if (tool.inputSchemaName !== 'ComputationalMergeCommandEnvelopeV1') {
        context.addIssue({
          code: 'custom',
          message: 'Computational merge apply app-server tools must accept ComputationalMergeCommandEnvelopeV1.',
          path: ['inputSchemaName'],
        });
      }

      if (tool.outputSchemaName !== 'ComputationalMergeMutationResultV1') {
        context.addIssue({
          code: 'custom',
          message: 'Computational merge apply app-server tools must return ComputationalMergeMutationResultV1.',
          path: ['outputSchemaName'],
        });
      }

      if (!tool.mutates) {
        context.addIssue({
          code: 'custom',
          message: 'Computational merge apply app-server tools must be marked as mutating.',
          path: ['mutates'],
        });
      }

      if (!tool.requiresDryRunPlan) {
        context.addIssue({
          code: 'custom',
          message: 'Computational merge apply app-server tools must require a prior dry-run plan.',
          path: ['requiresDryRunPlan'],
        });
      }

      if (tool.approvalClass !== ApprovalClass.EditApply) {
        context.addIssue({
          code: 'custom',
          message: 'Computational merge apply app-server tools require edit-apply approval classification.',
          path: ['approvalClass'],
        });
      }
    }

    if (tool.executionMode === 'open_derived_source') {
      if (tool.inputSchemaName !== 'ComputationalMergeDerivedSourceOpenRequestV1') {
        context.addIssue({
          code: 'custom',
          message: 'Computational merge derived-source tools must accept ComputationalMergeDerivedSourceOpenRequestV1.',
          path: ['inputSchemaName'],
        });
      }

      if (tool.outputSchemaName !== 'ComputationalMergeDerivedSourceOpenResultV1') {
        context.addIssue({
          code: 'custom',
          message: 'Computational merge derived-source tools must return ComputationalMergeDerivedSourceOpenResultV1.',
          path: ['outputSchemaName'],
        });
      }

      if (!tool.mutates) {
        context.addIssue({
          code: 'custom',
          message: 'Computational merge derived-source tools must be marked as mutating.',
          path: ['mutates'],
        });
      }

      if (!tool.requiresDryRunPlan) {
        context.addIssue({
          code: 'custom',
          message: 'Computational merge derived-source tools must require the accepted dry-run plan receipt.',
          path: ['requiresDryRunPlan'],
        });
      }

      if (tool.approvalClass !== ApprovalClass.EditApply) {
        context.addIssue({
          code: 'custom',
          message: 'Computational merge derived-source tools require edit-apply approval classification.',
          path: ['approvalClass'],
        });
      }
    }

    if ((tool.mutates || tool.returnsArtifactHandles) && !tool.recordsProvenance) {
      context.addIssue({
        code: 'custom',
        message: 'Computational merge app-server tools that mutate or return artifacts must record provenance.',
        path: ['recordsProvenance'],
      });
    }
  });

export const computationalMergeAppServerToolManifestV1Schema = z
  .object({
    schemaVersion: z.literal(RAW_ENGINE_SCHEMA_VERSION),
    serverRuntime: z.literal('openai_app_server'),
    tools: z.array(computationalMergeAppServerToolDefinitionV1Schema).min(1),
  })
  .strict();

export type ActorKind = z.infer<typeof actorKindSchema>;
export type AiAppServerAuditEventV1 = z.infer<typeof aiAppServerAuditEventV1Schema>;
export type AiAppServerExecutionModeV1 = z.infer<typeof aiAppServerExecutionModeV1Schema>;
export type AiAppServerToolDefinitionV1 = z.infer<typeof aiAppServerToolDefinitionV1Schema>;
export type AiAppServerToolManifestV1 = z.infer<typeof aiAppServerToolManifestV1Schema>;
export type AiEnhancementApplyResultV1 = z.infer<typeof aiEnhancementApplyResultV1Schema>;
export type AiEnhancementCapabilityV1 = z.infer<typeof aiEnhancementCapabilityV1Schema>;
export type AiEnhancementCommandEnvelopeV1 = z.infer<typeof aiEnhancementCommandEnvelopeV1Schema>;
export type AiEnhancementDryRunResultV1 = z.infer<typeof aiEnhancementDryRunResultV1Schema>;
export type AiEnhancementQualityPreferenceV1 = z.infer<typeof aiEnhancementQualityPreferenceV1Schema>;
export type AiToolApplyResultV1 = z.infer<typeof aiToolApplyResultV1Schema>;
export type AiToolCapabilityV1 = z.infer<typeof aiToolCapabilityV1Schema>;
export type AiToolCommandEnvelopeV1 = z.infer<typeof aiToolCommandEnvelopeV1Schema>;
export type AiToolDryRunResultV1 = z.infer<typeof aiToolDryRunResultV1Schema>;
export type AiToolPromptPolicyV1 = z.infer<typeof aiToolPromptPolicyV1Schema>;
export type AiToolProviderClassV1 = z.infer<typeof aiToolProviderClassV1Schema>;
export type AiToolSourcePixelDisclosureV1 = z.infer<typeof aiToolSourcePixelDisclosureV1Schema>;
export type ApprovalClass = z.infer<typeof approvalClassSchema>;
export type ApprovalRequirementV1 = z.infer<typeof approvalRequirementSchema>;
export type CommandEnvelopeV1 = z.infer<typeof commandEnvelopeV1Schema>;
export type RawEngineColorDomainV1 = z.infer<typeof rawEngineColorDomainV1Schema>;
export type RawEngineColorPipelineContextV1 = z.infer<typeof rawEngineColorPipelineContextV1Schema>;
export type RawEngineGamutMappingDestinationV1 = z.infer<typeof rawEngineGamutMappingDestinationV1Schema>;
export type RawEngineGamutMappingFixtureCaseV1 = z.infer<typeof rawEngineGamutMappingFixtureCaseV1Schema>;
export type RawEngineGamutMappingFixtureManifestV1 = z.infer<typeof rawEngineGamutMappingFixtureManifestV1Schema>;
export type RawEngineGamutMappingMethodV1 = z.infer<typeof rawEngineGamutMappingMethodV1Schema>;
export type RawEngineGamutMappingPolicyV1 = z.infer<typeof rawEngineGamutMappingPolicyV1Schema>;
export type RawEngineGamutMappingStatusV1 = z.infer<typeof rawEngineGamutMappingStatusV1Schema>;
export type RawEngineGamutMappingWarningCodeV1 = z.infer<typeof rawEngineGamutMappingWarningCodeV1Schema>;
export type RawEngineOutputProfileV1 = z.infer<typeof rawEngineOutputProfileV1Schema>;
export type RawEngineRenderBitDepthV1 = z.infer<typeof rawEngineRenderBitDepthV1Schema>;
export type RawEngineRenderingIntentV1 = z.infer<typeof rawEngineRenderingIntentV1Schema>;
export type RawEngineRenderTargetV1 = z.infer<typeof rawEngineRenderTargetV1Schema>;
export type RawEngineSceneToDisplayTransformV1 = z.infer<typeof rawEngineSceneToDisplayTransformV1Schema>;
export type RawEngineWorkingColorSpaceV1 = z.infer<typeof rawEngineWorkingColorSpaceV1Schema>;
export type ComputationalMergeAlignmentModeV1 = z.infer<typeof computationalMergeAlignmentModeV1Schema>;
export type ComputationalMergeAppServerAuditEventV1 = z.infer<typeof computationalMergeAppServerAuditEventV1Schema>;
export type ComputationalMergeAppServerExecutionModeV1 = z.infer<
  typeof computationalMergeAppServerExecutionModeV1Schema
>;
export type ComputationalMergeAppServerToolDefinitionV1 = z.infer<
  typeof computationalMergeAppServerToolDefinitionV1Schema
>;
export type ComputationalMergeAppServerToolManifestV1 = z.infer<typeof computationalMergeAppServerToolManifestV1Schema>;
export type ComputationalMergeCommandEnvelopeV1 = z.infer<typeof computationalMergeCommandEnvelopeV1Schema>;
export type ComputationalMergeCommandTypeV1 = z.infer<typeof computationalMergeCommandTypeV1Schema>;
export type ComputationalMergeDerivedSourceOpenRequestV1 = z.infer<
  typeof computationalMergeDerivedSourceOpenRequestV1Schema
>;
export type ComputationalMergeDerivedSourceOpenResultV1 = z.infer<
  typeof computationalMergeDerivedSourceOpenResultV1Schema
>;
export type ComputationalMergeDerivedSourceReceiptIdentityV1 = z.infer<
  typeof computationalMergeDerivedSourceReceiptIdentityV1Schema
>;
export type ComputationalMergeDryRunResultV1 = z.infer<typeof computationalMergeDryRunResultV1Schema>;
export type ComputationalMergeEngineCapabilitiesV1 = z.infer<typeof computationalMergeEngineCapabilitiesV1Schema>;
export type ComputationalMergeExecutionModeV1 = z.infer<typeof computationalMergeExecutionModeV1Schema>;
export type ComputationalMergeFamilyV1 = z.infer<typeof computationalMergeFamilyV1Schema>;
export type ComputationalMergeGeometryEstimateV1 = z.infer<typeof computationalMergeGeometryEstimateV1Schema>;
export type ComputationalMergeMemoryComponentsV1 = z.infer<typeof computationalMergeMemoryComponentsV1Schema>;
export type ComputationalMergeMutationResultV1 = z.infer<typeof computationalMergeMutationResultV1Schema>;
export type ComputationalMergeOutputDimensionsV1 = z.infer<typeof computationalMergeOutputDimensionsV1Schema>;
export type ComputationalMergePerformanceEstimateV1 = z.infer<typeof computationalMergePerformanceEstimateV1Schema>;
export type ComputationalMergePlanV1 = z.infer<typeof computationalMergePlanV1Schema>;
export type ComputationalMergePreflightEstimateV1 = z.infer<typeof computationalMergePreflightEstimateV1Schema>;
export type ComputationalMergePreflightStatusV1 = z.infer<typeof computationalMergePreflightStatusV1Schema>;
export type ComputationalMergePreflightWarningCodeV1 = z.infer<typeof computationalMergePreflightWarningCodeV1Schema>;
export type ComputationalMergeProjectedBoundsV1 = z.infer<typeof computationalMergeProjectedBoundsV1Schema>;
export type ComputationalMergeQualityMetricsV1 = z.infer<typeof computationalMergeQualityMetricsV1Schema>;
export type ComputationalMergeQualityPreferenceV1 = z.infer<typeof computationalMergeQualityPreferenceV1Schema>;
export type ComputationalMergeSourceImageRefV1 = z.infer<typeof computationalMergeSourceImageRefV1Schema>;
export type ComputationalMergeSourceRoleV1 = z.infer<typeof computationalMergeSourceRoleV1Schema>;
export type HdrAlignmentSummaryV1 = z.infer<typeof hdrAlignmentSummaryV1Schema>;
export type HdrBracketDetectionMethodV1 = z.infer<typeof hdrBracketDetectionMethodV1Schema>;
export type HdrBracketDetectionResultV1 = z.infer<typeof hdrBracketDetectionResultV1Schema>;
export type HdrBracketSourceMetadataV1 = z.infer<typeof hdrBracketSourceMetadataV1Schema>;
export type HdrCapabilityLevelV1 = z.infer<typeof hdrCapabilityLevelV1Schema>;
export type HdrDeghostingModeV1 = z.infer<typeof hdrDeghostingModeV1Schema>;
export type HdrDeghostingSummaryV1 = z.infer<typeof hdrDeghostingSummaryV1Schema>;
export type HdrHighlightRecoveryMetricsV1 = z.infer<typeof hdrHighlightRecoveryMetricsV1Schema>;
export type HdrMaskArtifactV1 = z.infer<typeof hdrMaskArtifactV1Schema>;
export type HdrMergeArtifactV1 = z.infer<typeof hdrMergeArtifactV1Schema>;
export type HdrMergeBlockCodeV1 = z.infer<typeof hdrMergeBlockCodeV1Schema>;
export type HdrMergeInvalidationReasonV1 = z.infer<typeof hdrMergeInvalidationReasonV1Schema>;
export type HdrMergeStaleStateV1 = z.infer<typeof hdrMergeStaleStateV1Schema>;
export type HdrMergeWarningCodeV1 = z.infer<typeof hdrMergeWarningCodeV1Schema>;
export type HdrMotionRiskV1 = z.infer<typeof hdrMotionRiskV1Schema>;
export type HdrRuntimeSidecarReceiptV1 = z.infer<typeof hdrRuntimeSidecarReceiptV1Schema>;
export type NegativeLabDensityRgbV1 = z.infer<typeof negativeLabDensityRgbV1Schema>;
export type NegativeLabRollFrameRoleV1 = z.infer<typeof negativeLabRollFrameRoleV1Schema>;
export type NegativeLabRollSessionArtifactV1 = z.infer<typeof negativeLabRollSessionArtifactV1Schema>;
export type NegativeLabSampleRectV1 = z.infer<typeof negativeLabSampleRectV1Schema>;
export type FocusStackArtifactV1 = z.infer<typeof focusStackArtifactV1Schema>;
export type FocusStackBlendMethodV1 = z.infer<typeof focusStackBlendMethodV1Schema>;
export type FocusStackInvalidationReasonV1 = z.infer<typeof focusStackInvalidationReasonV1Schema>;
export type FocusStackRetouchLayerPolicyV1 = z.infer<typeof focusStackRetouchLayerPolicyV1Schema>;
export type FocusStackStaleStateV1 = z.infer<typeof focusStackStaleStateV1Schema>;
export type FocusStackWarningCodeV1 = z.infer<typeof focusStackWarningCodeV1Schema>;
export type SuperResolutionArtifactV1 = z.infer<typeof superResolutionArtifactV1Schema>;
export type SuperResolutionBlockCodeV1 = z.infer<typeof superResolutionBlockCodeV1Schema>;
export type SuperResolutionDecisionStatusV1 = z.infer<typeof superResolutionDecisionStatusV1Schema>;
export type SuperResolutionDetailPolicyV1 = z.infer<typeof superResolutionDetailPolicyV1Schema>;
export type SuperResolutionDryRunSummaryV1 = z.infer<typeof superResolutionDryRunSummaryV1Schema>;
export type SuperResolutionInvalidationReasonV1 = z.infer<typeof superResolutionInvalidationReasonV1Schema>;
export type SuperResolutionModeV1 = z.infer<typeof superResolutionModeV1Schema>;
export type SuperResolutionReconstructionModeV1 = z.infer<typeof superResolutionReconstructionModeV1Schema>;
export type SuperResolutionReviewStatusV1 = z.infer<typeof superResolutionReviewStatusV1Schema>;
export type SuperResolutionStaleStateV1 = z.infer<typeof superResolutionStaleStateV1Schema>;
export type SuperResolutionWarningCodeV1 = z.infer<typeof superResolutionWarningCodeV1Schema>;
export type EditGraphCommandEnvelopeV1 = z.infer<typeof editGraphCommandEnvelopeV1Schema>;
export type EditGraphCommandTypeV1 = z.infer<typeof editGraphCommandTypeV1Schema>;
export type EditGraphDryRunResultV1 = z.infer<typeof editGraphDryRunResultV1Schema>;
export type EditGraphHistoryEntryV1 = z.infer<typeof editGraphHistoryEntryV1Schema>;
export type EditGraphMutationResultV1 = z.infer<typeof editGraphMutationResultV1Schema>;
export type EditGraphNodeKindV1 = z.infer<typeof editGraphNodeKindV1Schema>;
export type EditGraphNodeV1 = z.infer<typeof editGraphNodeV1Schema>;
export type EditGraphParameterDiffV1 = z.infer<typeof editGraphParameterDiffV1Schema>;
export type EditGraphParameterPatchOperationV1 = z.infer<typeof editGraphParameterPatchOperationV1Schema>;
export type EditGraphSnapshotQueryV1 = z.infer<typeof editGraphSnapshotQueryV1Schema>;
export type EditGraphSnapshotV1 = z.infer<typeof editGraphSnapshotV1Schema>;
export type DetailDeblurApplyStatusV1 = z.infer<typeof detailDeblurApplyStatusV1Schema>;
export type DetailDeblurCommandEnvelopeV1 = z.infer<typeof detailDeblurCommandEnvelopeV1Schema>;
export type DetailDeblurCommandTypeV1 = z.infer<typeof detailDeblurCommandTypeV1Schema>;
export type DetailDeblurControlsV1 = z.infer<typeof detailDeblurControlsV1Schema>;
export type DetailDeblurDryRunResultV1 = z.infer<typeof detailDeblurDryRunResultV1Schema>;
export type DetailDeblurLimitationV1 = z.infer<typeof detailDeblurLimitationV1Schema>;
export type DetailDeblurPsfV1 = z.infer<typeof detailDeblurPsfV1Schema>;
export type DetailDeblurRuntimeStateV1 = z.infer<typeof detailDeblurRuntimeStateV1Schema>;
export type DetailDeblurRuntimeStatusV1 = z.infer<typeof detailDeblurRuntimeStatusV1Schema>;
export type DetailDeblurSkipReasonV1 = z.infer<typeof detailDeblurSkipReasonV1Schema>;
export type DetailDeblurUiControlsV1 = z.infer<typeof detailDeblurUiControlsV1Schema>;
export type DetailDenoiseApplyStatusV1 = z.infer<typeof detailDenoiseApplyStatusV1Schema>;
export type DetailDenoiseCommandEnvelopeV1 = z.infer<typeof detailDenoiseCommandEnvelopeV1Schema>;
export type DetailDenoiseCommandTypeV1 = z.infer<typeof detailDenoiseCommandTypeV1Schema>;
export type DetailDenoiseControlsV1 = z.infer<typeof detailDenoiseControlsV1Schema>;
export type DetailDenoiseDryRunResultV1 = z.infer<typeof detailDenoiseDryRunResultV1Schema>;
export type DetailDenoiseLimitationV1 = z.infer<typeof detailDenoiseLimitationV1Schema>;
export type DetailDenoiseRuntimeStateV1 = z.infer<typeof detailDenoiseRuntimeStateV1Schema>;
export type DetailDenoiseRuntimeStatusV1 = z.infer<typeof detailDenoiseRuntimeStatusV1Schema>;
export type DetailDenoiseSkipReasonV1 = z.infer<typeof detailDenoiseSkipReasonV1Schema>;
export type DetailDenoiseUiControlsV1 = z.infer<typeof detailDenoiseUiControlsV1Schema>;
export type DetailEffectsCommandEnvelopeV1 = z.infer<typeof detailEffectsCommandEnvelopeV1Schema>;
export type DetailEffectsCommandTypeV1 = z.infer<typeof detailEffectsCommandTypeV1Schema>;
export type DetailEffectsDryRunResultV1 = z.infer<typeof detailEffectsDryRunResultV1Schema>;
export type DetailEffectsMutationResultV1 = z.infer<typeof detailEffectsMutationResultV1Schema>;
export type DetailEffectsPatchV1 = z.infer<typeof detailEffectsPatchV1Schema>;
export type LensProfileCommandEnvelopeV1 = z.infer<typeof lensProfileCommandEnvelopeV1Schema>;
export type LensProfileCommandTypeV1 = z.infer<typeof lensProfileCommandTypeV1Schema>;
export type LensProfileDryRunResultV1 = z.infer<typeof lensProfileDryRunResultV1Schema>;
export type LensProfileMutationResultV1 = z.infer<typeof lensProfileMutationResultV1Schema>;
export type LensProfilePatchV1 = z.infer<typeof lensProfilePatchV1Schema>;
export type ExportApplyResultV1 = z.infer<typeof exportApplyResultV1Schema>;
export type ExportColorSpaceV1 = z.infer<typeof exportColorSpaceV1Schema>;
export type ExportCommandEnvelopeV1 = z.infer<typeof exportCommandEnvelopeV1Schema>;
export type ExportDryRunResultV1 = z.infer<typeof exportDryRunResultV1Schema>;
export type ExportImageFormatV1 = z.infer<typeof exportImageFormatV1Schema>;
export type ExportPlannedFileV1 = z.infer<typeof exportPlannedFileV1Schema>;
export type ExportResizeModeV1 = z.infer<typeof exportResizeModeV1Schema>;
export type FilmBlackAndWhiteAlgorithmV1 = z.infer<typeof filmBlackAndWhiteAlgorithmV1Schema>;
export type FilmBlackAndWhiteFilterPresetV1 = z.infer<typeof filmBlackAndWhiteFilterPresetV1Schema>;
export type FilmBlackAndWhiteModelV1 = z.infer<typeof filmBlackAndWhiteModelV1Schema>;
export type FilmBlackAndWhiteRenderStageV1 = z.infer<typeof filmBlackAndWhiteRenderStageV1Schema>;
export type FilmBlackAndWhiteRendererSupportV1 = z.infer<typeof filmBlackAndWhiteRendererSupportV1Schema>;
export type FilmBlackAndWhiteResponseFamilyV1 = z.infer<typeof filmBlackAndWhiteResponseFamilyV1Schema>;
export type FilmBlackAndWhiteToningModeV1 = z.infer<typeof filmBlackAndWhiteToningModeV1Schema>;
export type FilmBlackAndWhiteWarningCodeV1 = z.infer<typeof filmBlackAndWhiteWarningCodeV1Schema>;
export type FilmGrainAlgorithmV1 = z.infer<typeof filmGrainAlgorithmV1Schema>;
export type FilmGlowAlgorithmV1 = z.infer<typeof filmGlowAlgorithmV1Schema>;
export type FilmGlowBlendModeV1 = z.infer<typeof filmGlowBlendModeV1Schema>;
export type FilmGlowBlurStrategyV1 = z.infer<typeof filmGlowBlurStrategyV1Schema>;
export type FilmGlowModelV1 = z.infer<typeof filmGlowModelV1Schema>;
export type FilmGlowQualityModeV1 = z.infer<typeof filmGlowQualityModeV1Schema>;
export type FilmGlowRenderStageV1 = z.infer<typeof filmGlowRenderStageV1Schema>;
export type FilmGlowRendererSupportV1 = z.infer<typeof filmGlowRendererSupportV1Schema>;
export type FilmGlowSourceChannelV1 = z.infer<typeof filmGlowSourceChannelV1Schema>;
export type FilmGlowThresholdRolloffV1 = z.infer<typeof filmGlowThresholdRolloffV1Schema>;
export type FilmGlowTintModeV1 = z.infer<typeof filmGlowTintModeV1Schema>;
export type FilmGlowWarningCodeV1 = z.infer<typeof filmGlowWarningCodeV1Schema>;
export type FilmGrainIsoPresetV1 = z.infer<typeof filmGrainIsoPresetV1Schema>;
export type FilmGrainModelV1 = z.infer<typeof filmGrainModelV1Schema>;
export type FilmGrainRenderStageV1 = z.infer<typeof filmGrainRenderStageV1Schema>;
export type FilmGrainRendererSupportV1 = z.infer<typeof filmGrainRendererSupportV1Schema>;
export type FilmGrainSeedPolicyV1 = z.infer<typeof filmGrainSeedPolicyV1Schema>;
export type FilmGrainToneBandV1 = z.infer<typeof filmGrainToneBandV1Schema>;
export type FilmHalationAlgorithmV1 = z.infer<typeof filmHalationAlgorithmV1Schema>;
export type FilmHalationBlendModeV1 = z.infer<typeof filmHalationBlendModeV1Schema>;
export type FilmHalationModelV1 = z.infer<typeof filmHalationModelV1Schema>;
export type FilmHalationQualityModeV1 = z.infer<typeof filmHalationQualityModeV1Schema>;
export type FilmHalationRenderStageV1 = z.infer<typeof filmHalationRenderStageV1Schema>;
export type FilmHalationRendererSupportV1 = z.infer<typeof filmHalationRendererSupportV1Schema>;
export type FilmHalationSourceChannelV1 = z.infer<typeof filmHalationSourceChannelV1Schema>;
export type FilmHalationThresholdRolloffV1 = z.infer<typeof filmHalationThresholdRolloffV1Schema>;
export type FilmHalationWarningCodeV1 = z.infer<typeof filmHalationWarningCodeV1Schema>;
export type FilmLookCatalogV1 = z.infer<typeof filmLookCatalogV1Schema>;
export type FilmLookClaimLevelV1 = z.infer<typeof filmLookClaimLevelV1Schema>;
export type FilmLookNodeKindV1 = z.infer<typeof filmLookNodeKindV1Schema>;
export type FilmLookNodeStageV1 = z.infer<typeof filmLookNodeStageV1Schema>;
export type FilmLookNodeV1 = z.infer<typeof filmLookNodeV1Schema>;
export type FilmLookProvenanceV1 = z.infer<typeof filmLookProvenanceV1Schema>;
export type FilmLookRecipeCategoryV1 = z.infer<typeof filmLookRecipeCategoryV1Schema>;
export type FilmLookRecipeV1 = z.infer<typeof filmLookRecipeV1Schema>;
export type FilmRenderDomainV1 = z.infer<typeof filmRenderDomainV1Schema>;
export type LayerMaskBlendModeV1 = z.infer<typeof layerMaskBlendModeV1Schema>;
export type LayerMaskBrushStrokeV1 = z.infer<typeof layerMaskBrushStrokeV1Schema>;
export type LayerMaskCommandEnvelopeV1 = z.infer<typeof layerMaskCommandEnvelopeV1Schema>;
export type LayerMaskCommandTypeV1 = z.infer<typeof layerMaskCommandTypeV1Schema>;
export type LayerMaskDryRunResultV1 = z.infer<typeof layerMaskDryRunResultV1Schema>;
export type LayerMaskGradientV1 = z.infer<typeof layerMaskGradientV1Schema>;
export type LayerMaskRefinementParametersV1 = z.infer<typeof layerMaskRefinementParametersV1Schema>;
export type LayerMaskMutationResultV1 = z.infer<typeof layerMaskMutationResultV1Schema>;
export type LayerMaskParameterDiffV1 = z.infer<typeof layerMaskParameterDiffV1Schema>;
export type LayerMaskPointV1 = z.infer<typeof layerMaskPointV1Schema>;
export type LayerMaskRangeSelectionV1 = z.infer<typeof layerMaskRangeSelectionV1Schema>;
export type NegativeAcquisitionConfidence = z.infer<typeof negativeAcquisitionConfidenceSchema>;
export type NegativeAcquisitionProfileV1 = z.infer<typeof negativeAcquisitionProfileV1Schema>;
export type NegativeLabAppServerAuditEvent = z.infer<typeof negativeLabAppServerAuditEventSchema>;
export type NegativeLabAppServerExecutionMode = z.infer<typeof negativeLabAppServerExecutionModeSchema>;
export type NegativeLabAppServerToolDefinitionV1 = z.infer<typeof negativeLabAppServerToolDefinitionV1Schema>;
export type NegativeLabAppServerToolManifestV1 = z.infer<typeof negativeLabAppServerToolManifestV1Schema>;
export type RawEngineAppServerProtocolV1 = z.infer<typeof rawEngineAppServerProtocolV1Schema>;
export type RawEngineAppServerToolCallV1 = z.infer<typeof rawEngineAppServerToolCallV1Schema>;
export type RawEngineAppServerToolCallValidationV1 = z.infer<typeof rawEngineAppServerToolCallValidationV1Schema>;
export type RawEngineAppServerTransportV1 = z.infer<typeof rawEngineAppServerTransportV1Schema>;
export type NegativeLabApplyFrameCropParametersV1 = z.infer<typeof negativeLabApplyFrameCropParametersV1Schema>;
export type NegativeLabApplyResultV1 = z.infer<typeof negativeLabApplyResultV1Schema>;
export type NegativeLabApplyPlanRequestV1 = z.infer<typeof negativeLabApplyPlanRequestV1Schema>;
export type NegativeLabPositiveOutputReceiptV1 = z.infer<typeof negativeLabPositiveOutputReceiptV1Schema>;
export type NegativeLabBaseFogEstimateV1 = z.infer<typeof negativeLabBaseFogEstimateV1Schema>;
export type NegativeLabBaseSampleChannelStatsV1 = z.infer<typeof negativeLabBaseSampleChannelStatsV1Schema>;
export type NegativeLabBaseSampleRecordV1 = z.infer<typeof negativeLabBaseSampleRecordV1Schema>;
export type NegativeLabBaseSampleRejectionReasonV1 = z.infer<typeof negativeLabBaseSampleRejectionReasonV1Schema>;
export type NegativeLabBaseSampleRegionV1 = z.infer<typeof negativeLabBaseSampleRegionV1Schema>;
export type NegativeLabBaseSampleStatsV1 = z.infer<typeof negativeLabBaseSampleStatsV1Schema>;
export type NegativeLabBaseSampleStatusV1 = z.infer<typeof negativeLabBaseSampleStatusV1Schema>;
export type NegativeLabBuiltInPresetCatalogV1 = z.infer<typeof negativeLabBuiltInPresetCatalogV1Schema>;
export type NegativeLabBuiltInPresetFilmClass = z.infer<typeof negativeLabBuiltInPresetFilmClassSchema>;
export type NegativeLabBuiltInPresetTier = z.infer<typeof negativeLabBuiltInPresetTierSchema>;
export type NegativeLabBuiltInPresetV1 = z.infer<typeof negativeLabBuiltInPresetV1Schema>;
export type NegativeLabChangeSetV1 = z.infer<typeof negativeLabChangeSetV1Schema>;
export type NegativeLabCommandEnvelopeV1 = z.infer<typeof negativeLabCommandEnvelopeV1Schema>;
export type NegativeLabCommandType = z.infer<typeof negativeLabCommandTypeSchema>;
export type NegativeLabConversionOperationArtifactPurposeV1 = z.infer<
  typeof negativeLabConversionOperationArtifactPurposeV1Schema
>;
export type NegativeLabConversionOperationParameterRefsV1 = z.infer<
  typeof negativeLabConversionOperationParameterRefsV1Schema
>;
export type NegativeLabConversionOperationProvenanceV1 = z.infer<
  typeof negativeLabConversionOperationProvenanceV1Schema
>;
export type NegativeLabConversionOperationV1 = z.infer<typeof negativeLabConversionOperationV1Schema>;
export type NegativeLabCreateSessionParametersV1 = z.infer<typeof negativeLabCreateSessionParametersV1Schema>;
export type NegativeLabCreatePositiveVariantParametersV1 = z.infer<
  typeof negativeLabCreatePositiveVariantParametersV1Schema
>;
export type NegativeLabDensityCurvePointV1 = z.infer<typeof negativeLabDensityCurvePointV1Schema>;
export type NegativeLabDensityCurveV1 = z.infer<typeof negativeLabDensityCurveV1Schema>;
export type NegativeLabDensityNormalizationProfileV1 = z.infer<typeof negativeLabDensityNormalizationProfileV1Schema>;
export type NegativeLabDryRunResultV1 = z.infer<typeof negativeLabDryRunResultV1Schema>;
export type NegativeLabEstimateBaseFogParametersV1 = z.infer<typeof negativeLabEstimateBaseFogParametersV1Schema>;
export type NegativeLabDetectedFrameCropV1 = z.infer<typeof negativeLabDetectedFrameCropV1Schema>;
export type NegativeLabDetectedFrameV1 = z.infer<typeof negativeLabDetectedFrameV1Schema>;
export type NegativeLabFixtureDistributionV1 = z.infer<typeof negativeLabFixtureDistributionV1Schema>;
export type NegativeLabCleanRoomProvenanceV1 = z.infer<typeof negativeLabCleanRoomProvenanceV1Schema>;
export type NegativeLabFixtureManifestEntryV1 = z.infer<typeof negativeLabFixtureManifestEntryV1Schema>;
export type NegativeLabFixtureManifestV1 = z.infer<typeof negativeLabFixtureManifestV1Schema>;
export type NegativeLabFixtureRoleV1 = z.infer<typeof negativeLabFixtureRoleV1Schema>;
export type NegativeLabFixtureSourceV1 = z.infer<typeof negativeLabFixtureSourceV1Schema>;
export type NegativeLabFixtureStateV1 = z.infer<typeof negativeLabFixtureStateV1Schema>;
export type NegativeLabFixtureTierV1 = z.infer<typeof negativeLabFixtureTierV1Schema>;
export type NegativeLabFixtureValidationUseV1 = z.infer<typeof negativeLabFixtureValidationUseV1Schema>;
export type NegativeLabFixtureWarningCodeV1 = z.infer<typeof negativeLabFixtureWarningCodeV1Schema>;
export type NegativeLabMeasuredProfileEvidenceV1 = z.infer<typeof negativeLabMeasuredProfileEvidenceV1Schema>;
export type NegativeLabFrameBorderMetricsV1 = z.infer<typeof negativeLabFrameBorderMetricsV1Schema>;
export type NegativeLabFrameDetectionRequestV1 = z.infer<typeof negativeLabFrameDetectionRequestV1Schema>;
export type NegativeLabFrameDetectionResultV1 = z.infer<typeof negativeLabFrameDetectionResultV1Schema>;
export type NegativeLabFrameCropEditV1 = z.infer<typeof negativeLabFrameCropEditV1Schema>;
export type NegativeLabFrameSelectionV1 = z.infer<typeof negativeLabFrameSelectionV1Schema>;
export type NegativeLabInputProfileCatalogV1 = z.infer<typeof negativeLabInputProfileCatalogV1Schema>;
export type NegativeLabInputProfileKindV1 = z.infer<typeof negativeLabInputProfileKindV1Schema>;
export type NegativeLabInputProfileSourceV1 = z.infer<typeof negativeLabInputProfileSourceV1Schema>;
export type NegativeLabInputProfileV1 = z.infer<typeof negativeLabInputProfileV1Schema>;
export type NegativeLabRejectedFrameCandidateV1 = z.infer<typeof negativeLabRejectedFrameCandidateV1Schema>;
export type NegativeLabLegalNamingStatus = z.infer<typeof negativeLabLegalNamingStatusSchema>;
export type NegativeLabOperationClass = z.infer<typeof negativeLabOperationClassSchema>;
export type NegativeLabOperationStage = z.infer<typeof negativeLabOperationStageSchema>;
export type NegativeLabRuntimeProofV1 = z.infer<typeof negativeLabRuntimeProofV1Schema>;
export type NegativeLabOutputTransformRefV1 = z.infer<typeof negativeLabOutputTransformRefV1Schema>;
export type NegativeLabPerChannelInversionCurveSetScopeV1 = z.infer<
  typeof negativeLabPerChannelInversionCurveSetScopeV1Schema
>;
export type NegativeLabPerChannelInversionCurveSetSourceV1 = z.infer<
  typeof negativeLabPerChannelInversionCurveSetSourceV1Schema
>;
export type NegativeLabPerChannelInversionCurveSetV1 = z.infer<typeof negativeLabPerChannelInversionCurveSetV1Schema>;
export type NegativeLabPlanRollNormalizationParametersV1 = z.infer<
  typeof negativeLabPlanRollNormalizationParametersV1Schema
>;
export type NegativeLabPositiveVariantProvenanceV1 = z.infer<typeof negativeLabPositiveVariantProvenanceV1Schema>;
export type NegativeLabPresetMetadataLegalReviewStatusV1 = z.infer<
  typeof negativeLabPresetMetadataLegalReviewStatusV1Schema
>;
export type NegativeLabPresetMetadataPolicyCatalogV1 = z.infer<typeof negativeLabPresetMetadataPolicyCatalogV1Schema>;
export type NegativeLabPresetMetadataPolicyClaimLevelV1 = z.infer<
  typeof negativeLabPresetMetadataPolicyClaimLevelV1Schema
>;
export type NegativeLabPresetMetadataPolicyTierV1 = z.infer<typeof negativeLabPresetMetadataPolicyTierV1Schema>;
export type NegativeLabPresetMetadataPolicyV1 = z.infer<typeof negativeLabPresetMetadataPolicyV1Schema>;
export type NegativeLabPresetMetadataUiContextV1 = z.infer<typeof negativeLabPresetMetadataUiContextV1Schema>;
export type NegativeLabPresetProfileRefV1 = z.infer<typeof negativeLabPresetProfileRefV1Schema>;
export type NegativeLabProcessProfileClass = z.infer<typeof negativeLabProcessProfileClassSchema>;
export type NegativeLabProcessProfileV1 = z.infer<typeof negativeLabProcessProfileV1Schema>;
export type NegativeLabProfileMeasurementSource = z.infer<typeof negativeLabProfileMeasurementSourceSchema>;
export type NegativeLabQcOverlayKind = z.infer<typeof negativeLabQcOverlayKindSchema>;
export type NegativeLabQcOverlayV1 = z.infer<typeof negativeLabQcOverlayV1Schema>;
export type NegativeLabQcProofArtifactV1 = z.infer<typeof negativeLabQcProofArtifactV1Schema>;
export type NegativeLabStockRegistryAvailabilityV1 = z.infer<typeof negativeLabStockRegistryAvailabilityV1Schema>;
export type NegativeLabStockRegistryCategoryV1 = z.infer<typeof negativeLabStockRegistryCategoryV1Schema>;
export type NegativeLabStockRegistryClaimTierV1 = z.infer<typeof negativeLabStockRegistryClaimTierV1Schema>;
export type NegativeLabStockRegistryEntryV1 = z.infer<typeof negativeLabStockRegistryEntryV1Schema>;
export type NegativeLabStockRegistryFixtureStatusV1 = z.infer<typeof negativeLabStockRegistryFixtureStatusV1Schema>;
export type NegativeLabStockRegistryIdV1 = z.infer<typeof negativeLabStockRegistryIdV1Schema>;
export type NegativeLabStockRegistryLegalNamingStatusV1 = z.infer<
  typeof negativeLabStockRegistryLegalNamingStatusV1Schema
>;
export type NegativeLabStockRegistryProcessFamilyV1 = z.infer<typeof negativeLabStockRegistryProcessFamilyV1Schema>;
export type NegativeLabStockRegistryProfileStatusV1 = z.infer<typeof negativeLabStockRegistryProfileStatusV1Schema>;
export type NegativeLabStockRegistryV1 = z.infer<typeof negativeLabStockRegistryV1Schema>;
export type NegativeLabPreviewRequestV1 = z.infer<typeof negativeLabPreviewRequestV1Schema>;
export type NegativeLabRollBatchWorkflowStagePlanV1 = z.infer<typeof negativeLabRollBatchWorkflowStagePlanV1Schema>;
export type NegativeLabRollBatchWorkflowStageV1 = z.infer<typeof negativeLabRollBatchWorkflowStageV1Schema>;
export type NegativeLabRollBatchWorkflowV1 = z.infer<typeof negativeLabRollBatchWorkflowV1Schema>;
export type NegativeLabRollConsistencyFrameMetricV1 = z.infer<typeof negativeLabRollConsistencyFrameMetricV1Schema>;
export type NegativeLabRollConsistencyMetricsV1 = z.infer<typeof negativeLabRollConsistencyMetricsV1Schema>;
export type NegativeLabSampleGeometryV1 = z.infer<typeof negativeLabSampleGeometryV1Schema>;
export type NegativeLabSetConversionRecipeParametersV1 = z.infer<
  typeof negativeLabSetConversionRecipeParametersV1Schema
>;
export type NegativeLabSetFrameQcStatusParametersV1 = z.infer<typeof negativeLabSetFrameQcStatusParametersV1Schema>;
export type NegativeLabSourceAssetRefV1 = z.infer<typeof negativeLabSourceAssetRefV1Schema>;
export type NegativeLabSupportedProcessFamilyV1 = z.infer<typeof negativeLabSupportedProcessFamilyV1Schema>;
export type NegativeLabUpdateBaseSamplesParametersV1 = z.infer<typeof negativeLabUpdateBaseSamplesParametersV1Schema>;
export type NegativeFrameRecordV1 = z.infer<typeof negativeFrameRecordV1Schema>;
export type NegativeInputMode = z.infer<typeof negativeInputModeSchema>;
export type NegativePixelBasis = z.infer<typeof negativePixelBasisSchema>;
export type NegativeProcessFamily = z.infer<typeof negativeProcessFamilySchema>;
export type NegativeRollSessionV1 = z.infer<typeof negativeRollSessionV1Schema>;
export type NegativeWarningCode = z.infer<typeof negativeWarningCodeSchema>;
export type NegativeWarningSeverity = z.infer<typeof negativeWarningSeveritySchema>;
export type NegativeWarningV1 = z.infer<typeof negativeWarningV1Schema>;
export type PanoramaArtifactV1 = z.infer<typeof panoramaArtifactV1Schema>;
export type PanoramaBackendBlendModeV1 = z.infer<typeof panoramaBackendBlendModeV1Schema>;
export type PanoramaBackendCapabilityReportV1 = z.infer<typeof panoramaBackendCapabilityReportV1Schema>;
export type PanoramaBackendExposureModeV1 = z.infer<typeof panoramaBackendExposureModeV1Schema>;
export type PanoramaBackendIdV1 = z.infer<typeof panoramaBackendIdV1Schema>;
export type PanoramaBackendSeamMethodV1 = z.infer<typeof panoramaBackendSeamMethodV1Schema>;
export type PanoramaInvalidationReasonV1 = z.infer<typeof panoramaInvalidationReasonV1Schema>;
export type PanoramaStaleStateV1 = z.infer<typeof panoramaStaleStateV1Schema>;
export type PreviewHistogramChannelV1 = z.infer<typeof previewHistogramChannelV1Schema>;
export type PreviewHistogramScopeV1 = z.infer<typeof previewHistogramScopeV1Schema>;
export type PreviewRasterScopeV1 = z.infer<typeof previewRasterScopeV1Schema>;
export type PreviewScopeChannelV1 = z.infer<typeof previewScopeChannelV1Schema>;
export type PreviewScopeKindV1 = z.infer<typeof previewScopeKindV1Schema>;
export type PreviewScopeQueryV1 = z.infer<typeof previewScopeQueryV1Schema>;
export type PreviewScopeRenderBasisV1 = z.infer<typeof previewScopeRenderBasisV1Schema>;
export type PreviewScopeResultV1 = z.infer<typeof previewScopeResultV1Schema>;
export type RawEngineAgentPreviewRenderRequestV1 = z.infer<typeof rawEngineAgentPreviewRenderRequestV1Schema>;
export type ProjectLibraryCommandEnvelopeV1 = z.infer<typeof projectLibraryCommandEnvelopeV1Schema>;
export type ProjectLibraryCommandTypeV1 = z.infer<typeof projectLibraryCommandTypeV1Schema>;
export type ProjectLibraryFilterCriteriaV1 = z.infer<typeof projectLibraryFilterCriteriaV1Schema>;
export type ProjectLibraryImageRefV1 = z.infer<typeof projectLibraryImageRefV1Schema>;
export type ProjectLibraryMutationResultV1 = z.infer<typeof projectLibraryMutationResultV1Schema>;
export type ProjectLibrarySnapshotQueryV1 = z.infer<typeof projectLibrarySnapshotQueryV1Schema>;
export type ProjectLibrarySnapshotV1 = z.infer<typeof projectLibrarySnapshotV1Schema>;
export type ProjectLibrarySortCriteriaV1 = z.infer<typeof projectLibrarySortCriteriaV1Schema>;
export type QueryEnvelopeV1 = z.infer<typeof queryEnvelopeV1Schema>;
export type RawEngineActor = z.infer<typeof rawEngineActorSchema>;
export type RawEngineAgentReplayAuditLogV1 = z.infer<typeof rawEngineAgentReplayAuditLogV1Schema>;
export type RawEngineAgentReplayFixtureV1 = z.infer<typeof rawEngineAgentReplayFixtureV1Schema>;
export type RawEngineAgentReplayStepV1 = z.infer<typeof rawEngineAgentReplayStepV1Schema>;
export type RawEngineTarget = z.infer<typeof rawEngineTargetSchema>;
export type RawEngineToolKind = z.infer<typeof rawEngineToolKindSchema>;
export type RawEngineToolDefinitionV1 = z.infer<typeof rawEngineToolDefinitionV1Schema>;
export type RawEngineToolRegistryV1 = z.infer<typeof rawEngineToolRegistryV1Schema>;
export type ToneColorChannelV1 = z.infer<typeof toneColorChannelV1Schema>;
export type ToneColorCommandEnvelopeV1 = z.infer<typeof toneColorCommandEnvelopeV1Schema>;
export type ToneColorCommandTypeV1 = z.infer<typeof toneColorCommandTypeV1Schema>;
export type ToneColorCurvePointV1 = z.infer<typeof toneColorCurvePointV1Schema>;
export type ToneColorDryRunResultV1 = z.infer<typeof toneColorDryRunResultV1Schema>;
export type ToneColorHslBandV1 = z.infer<typeof toneColorHslBandV1Schema>;
export type ToneColorMutationResultV1 = z.infer<typeof toneColorMutationResultV1Schema>;
export type ToneColorParameterDiffV1 = z.infer<typeof toneColorParameterDiffV1Schema>;
export type ToneColorWheelV1 = z.infer<typeof toneColorWheelV1Schema>;
