import { z } from 'zod';

import {
  type DerivedOutputProvenanceSidecar,
  type DerivedOutputReceipt,
  derivedOutputProvenanceSidecarSchema,
  derivedOutputReceiptSchema,
} from '../schemas/computational-merge/derivedOutputReceiptSchemas';
import {
  focusStackBreathingCompensationSchema,
  focusStackRetouchSeedSchema,
} from '../schemas/focus-stack/focusStackOutputReviewSchemas';

const hdrSidecarArtifactSchema = z
  .object({
    dryRun: z
      .object({
        acceptedDryRunPlanHash: z.string().trim().min(1),
        acceptedDryRunPlanId: z.string().trim().min(1),
      })
      .passthrough()
      .optional(),
    editableDerivedAssetId: z.string().trim().min(1).optional(),
    family: z.literal('hdr'),
    outputArtifact: z
      .object({
        artifactId: z.string().trim().min(1).optional(),
        contentHash: z.string().trim().min(1).optional(),
      })
      .passthrough()
      .optional(),
    staleState: z
      .object({
        state: z.enum(['current', 'stale', 'unknown']),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const panoramaCropSchema = z
  .object({
    height: z.number().int().positive(),
    mode: z.string().trim().min(1),
    preCropHeight: z.number().int().positive(),
    preCropWidth: z.number().int().positive(),
    width: z.number().int().positive(),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
  })
  .strict();

const rawEngineArtifactsWithHdrProvenanceSchema = z
  .object({
    derivedOutputProvenanceSidecars: z.array(derivedOutputProvenanceSidecarSchema).default([]),
    focusStackArtifacts: z
      .array(
        z
          .object({
            artifactId: z.string().trim().min(1).optional(),
            family: z.literal('focus_stack').optional(),
            outputArtifact: z
              .object({
                artifactId: z.string().trim().min(1).optional(),
                contentHash: z.string().trim().min(1).optional(),
              })
              .passthrough()
              .optional(),
            retouchSeed: z
              .object({
                acceptedDryRunPlanHash: z.string().trim().min(1).optional(),
                acceptedDryRunPlanId: z.string().trim().min(1).optional(),
                artifactId: z.string().trim().min(1).optional(),
                availability: z.enum(['available', 'unavailable']).optional(),
                maskRegions: z.array(z.unknown()).default([]),
                outputContentHash: z.string().trim().min(1).optional(),
                previewContentHash: z.string().trim().min(1).optional(),
                reasonCodes: z.array(z.string().trim().min(1)).default([]),
                sourceCandidates: z.array(z.unknown()).default([]),
                staleReasons: z.array(z.string().trim().min(1)).default([]),
                staleState: z.enum(['current', 'stale', 'unknown']).optional(),
              })
              .passthrough()
              .optional(),
            staleState: z
              .object({
                invalidationReasons: z.array(z.string()).default([]),
                state: z.enum(['current', 'stale', 'unknown']),
              })
              .passthrough()
              .optional(),
            warnings: z.array(z.string().trim().min(1)).default([]),
          })
          .passthrough(),
      )
      .default([]),
    hdrMergeArtifacts: z.array(hdrSidecarArtifactSchema).default([]),
    panoramaArtifacts: z
      .array(
        z
          .object({
            artifactId: z.string().trim().min(1).optional(),
            boundarySettings: z
              .object({
                crop: panoramaCropSchema.optional(),
                effectiveMode: z.enum(['auto_crop', 'manual_crop', 'transparent']).optional(),
                requestedMode: z.enum(['auto_crop', 'manual_crop', 'transparent']).optional(),
              })
              .passthrough()
              .optional(),
            family: z.literal('panorama').optional(),
            outputArtifacts: z
              .array(
                z
                  .object({
                    artifactId: z.string().trim().min(1).optional(),
                    contentHash: z.string().trim().min(1).optional(),
                    dimensions: z
                      .object({
                        height: z.number().int().positive(),
                        width: z.number().int().positive(),
                      })
                      .passthrough()
                      .optional(),
                  })
                  .passthrough(),
              )
              .default([]),
            previewArtifacts: z
              .array(
                z
                  .object({
                    dimensions: z
                      .object({
                        height: z.number().int().positive(),
                        width: z.number().int().positive(),
                      })
                      .passthrough()
                      .optional(),
                  })
                  .passthrough(),
              )
              .default([]),
            projectionSettings: z
              .object({
                effectiveProjection: z.enum(['rectilinear', 'cylindrical', 'spherical']).optional(),
                requestedProjection: z.enum(['rectilinear', 'cylindrical', 'spherical']).optional(),
              })
              .passthrough()
              .optional(),
            staleState: z
              .object({
                invalidationReasons: z.array(z.string()).default([]),
                state: z.enum(['current', 'stale', 'unknown']),
              })
              .passthrough()
              .optional(),
            warnings: z.array(z.string().trim().min(1)).default([]),
          })
          .passthrough(),
      )
      .default([]),
    schemaVersion: z.literal(1),
  })
  .passthrough();

const metadataWithRawEngineArtifactsSchema = z
  .object({
    rawEngineArtifacts: rawEngineArtifactsWithHdrProvenanceSchema.optional(),
  })
  .passthrough();

export const buildHdrReopenedDerivedOutputReceipt = ({
  imagePath,
  metadata,
}: {
  imagePath: string;
  metadata: unknown;
}): DerivedOutputReceipt | null => {
  const parsedMetadata = metadataWithRawEngineArtifactsSchema.safeParse(metadata);
  if (!parsedMetadata.success) return null;

  const rawEngineArtifacts = parsedMetadata.data.rawEngineArtifacts;
  const provenance = rawEngineArtifacts?.derivedOutputProvenanceSidecars.find(
    (sidecar) => sidecar.receipt.family === 'hdr' && sidecar.output.path === imagePath,
  );
  if (provenance === undefined || provenance.sourceState.length < 2) return null;

  const matchingArtifact = rawEngineArtifacts?.hdrMergeArtifacts.find(
    (artifact) =>
      artifact.family === 'hdr' &&
      (artifact.outputArtifact?.contentHash === provenance.output.contentHash ||
        artifact.editableDerivedAssetId === provenance.acceptedApplyId ||
        artifact.outputArtifact?.artifactId === provenance.acceptedApplyId),
  );
  const outputArtifactId =
    matchingArtifact?.editableDerivedAssetId ??
    provenance.acceptedApplyId ??
    matchingArtifact?.outputArtifact?.artifactId ??
    provenance.receipt.receiptId;

  return derivedOutputReceiptSchema.parse({
    acceptedDryRunPlanHash: matchingArtifact?.dryRun?.acceptedDryRunPlanHash,
    acceptedDryRunPlanId: matchingArtifact?.dryRun?.acceptedDryRunPlanId ?? provenance.acceptedDryRunId,
    family: 'hdr',
    openInEditorAction: {
      label: 'Open HDR output',
      path: imagePath,
      state: 'available',
    },
    outputArtifactId,
    outputContentHash: provenance.output.contentHash,
    outputPath: imagePath,
    provenanceSidecar: provenance,
    receiptId: provenance.receipt.receiptId,
    settingsHash: provenance.settingsHash,
    sourceContentHashes: provenance.sourceState.map((source) => source.contentHash),
    sourceCount: provenance.sourceState.length,
    sourceGraphRevisions: provenance.sourceState.map((source) => source.graphRevision),
    staleReasons: undefined,
    staleState: matchingArtifact?.staleState?.state === 'current' ? 'current' : 'unknown',
    storagePolicy: 'export_path',
  });
};

export const buildPanoramaReopenedDerivedOutputReceipt = ({
  imagePath,
  metadata,
}: {
  imagePath: string;
  metadata: unknown;
}): DerivedOutputReceipt | null => {
  const parsedMetadata = metadataWithRawEngineArtifactsSchema.safeParse(metadata);
  if (!parsedMetadata.success) return null;

  const rawEngineArtifacts = parsedMetadata.data.rawEngineArtifacts;
  const provenance = rawEngineArtifacts?.derivedOutputProvenanceSidecars.find(
    (sidecar) => sidecar.receipt.family === 'panorama' && sidecar.output.path === imagePath,
  );
  if (provenance === undefined || provenance.sourceState.length < 2) return null;

  const matchingArtifact = rawEngineArtifacts?.panoramaArtifacts.find((artifact) =>
    artifact.outputArtifacts.some(
      (output) =>
        output.contentHash === provenance.output.contentHash ||
        output.artifactId === provenance.acceptedApplyId ||
        output.artifactId === provenance.receipt.receiptId,
    ),
  );
  const matchingOutputArtifact = matchingArtifact?.outputArtifacts.find(
    (output) => output.contentHash === provenance.output.contentHash,
  );
  const outputArtifactId =
    matchingOutputArtifact?.artifactId ??
    provenance.acceptedApplyId ??
    matchingArtifact?.artifactId ??
    provenance.receipt.receiptId;
  const previewDimensions = normalizeDimensions(
    provenance.panorama?.previewDimensions ?? matchingArtifact?.previewArtifacts[0]?.dimensions,
  );
  const panorama =
    provenance.panorama ??
    buildPanoramaReceiptMetadataFromArtifact({
      artifact: matchingArtifact,
      previewDimensions,
      sourceState: provenance.sourceState,
    });
  const sourcePaths = provenance.sourceState.map((source) => source.path);
  const staleReasons =
    matchingArtifact?.staleState?.state === 'stale'
      ? matchingArtifact.staleState.invalidationReasons.flatMap((reason) =>
          isDerivedOutputStaleReason(reason) ? [reason] : [],
        )
      : undefined;
  const staleState =
    staleReasons !== undefined && staleReasons.length > 0
      ? 'stale'
      : matchingArtifact?.staleState?.state === 'current'
        ? 'current'
        : 'unknown';

  return derivedOutputReceiptSchema.parse({
    acceptedDryRunPlanId: provenance.acceptedDryRunId,
    family: 'panorama',
    openInEditorAction: {
      label: 'Open panorama output',
      path: imagePath,
      state: 'available',
    },
    outputArtifactId,
    outputContentHash: provenance.output.contentHash,
    outputPath: imagePath,
    ...(panorama === undefined ? {} : { panorama }),
    ...(previewDimensions === undefined ? {} : { previewDimensions }),
    provenanceSidecar: provenance,
    receiptId: provenance.receipt.receiptId,
    settingsHash: provenance.settingsHash,
    sourceContentHashes: provenance.sourceState.map((source) => source.contentHash),
    sourceCount: provenance.sourceState.length,
    sourceGraphRevisions: provenance.sourceState.map((source) => source.graphRevision),
    ...(sourcePaths.every((path): path is string => path !== undefined) ? { sourcePaths } : {}),
    ...(staleReasons === undefined || staleReasons.length === 0 ? {} : { staleReasons }),
    staleState,
    storagePolicy: 'export_path',
    warningCodes: matchingArtifact?.warnings ?? provenance.warnings,
  });
};

export const buildReopenedDerivedOutputReceipt = ({
  imagePath,
  metadata,
}: {
  imagePath: string;
  metadata: unknown;
}): DerivedOutputReceipt | null =>
  buildFocusStackReopenedDerivedOutputReceipt({ imagePath, metadata }) ??
  buildHdrReopenedDerivedOutputReceipt({ imagePath, metadata }) ??
  buildPanoramaReopenedDerivedOutputReceipt({ imagePath, metadata });

export const buildFocusStackReopenedDerivedOutputReceipt = ({
  imagePath,
  metadata,
}: {
  imagePath: string;
  metadata: unknown;
}): DerivedOutputReceipt | null => {
  const parsedMetadata = metadataWithRawEngineArtifactsSchema.safeParse(metadata);
  if (!parsedMetadata.success) return null;

  const rawEngineArtifacts = parsedMetadata.data.rawEngineArtifacts;
  const provenance = rawEngineArtifacts?.derivedOutputProvenanceSidecars.find(
    (sidecar) => sidecar.receipt.family === 'focus_stack' && sidecar.output.path === imagePath,
  );
  if (provenance === undefined || provenance.sourceState.length < 2) return null;

  const matchingArtifact = rawEngineArtifacts?.focusStackArtifacts.find(
    (artifact) =>
      artifact.family === 'focus_stack' &&
      (artifact.outputArtifact?.contentHash === provenance.output.contentHash ||
        artifact.outputArtifact?.artifactId === provenance.acceptedApplyId ||
        artifact.artifactId === provenance.receipt.receiptId),
  );
  const outputArtifactId =
    matchingArtifact?.outputArtifact?.artifactId ?? provenance.acceptedApplyId ?? provenance.receipt.receiptId;
  const focusStack = provenance.focusStack ?? buildFocusStackReceiptMetadataFromArtifact(matchingArtifact);
  const focusStackRetouchSeed = focusStack?.retouchSeed;
  const staleState =
    matchingArtifact?.staleState?.state === 'stale'
      ? 'stale'
      : matchingArtifact?.staleState?.state === 'current'
        ? 'current'
        : (focusStackRetouchSeed?.staleState ?? 'unknown');

  return derivedOutputReceiptSchema.parse({
    acceptedDryRunPlanHash: focusStackRetouchSeed?.acceptedDryRunPlanHash,
    acceptedDryRunPlanId: focusStackRetouchSeed?.acceptedDryRunPlanId,
    family: 'focus_stack',
    focusStack,
    openInEditorAction: {
      label: 'Open focus stack output',
      path: imagePath,
      state: 'available',
    },
    outputArtifactId,
    outputContentHash: provenance.output.contentHash,
    outputPath: imagePath,
    provenanceSidecar: provenance,
    receiptId: provenance.receipt.receiptId,
    settingsHash: provenance.settingsHash,
    sourceContentHashes: provenance.sourceState.map((source) => source.contentHash),
    sourceCount: provenance.sourceState.length,
    sourceGraphRevisions: provenance.sourceState.map((source) => source.graphRevision),
    ...(provenance.sourceState.every((source) => source.path !== undefined)
      ? { sourcePaths: provenance.sourceState.map((source) => source.path as string) }
      : {}),
    staleReasons:
      matchingArtifact?.staleState?.state === 'stale'
        ? matchingArtifact.staleState.invalidationReasons.flatMap((reason) =>
            isDerivedOutputStaleReason(reason) ? [reason] : [],
          )
        : undefined,
    staleState,
    storagePolicy: 'sidecar_artifact',
    warningCodes: matchingArtifact?.warnings ?? provenance.warnings,
  });
};

export const upsertHdrReopenedDerivedOutputReceipt = ({
  imagePath,
  metadata,
  upsert,
}: {
  imagePath: string;
  metadata: unknown;
  upsert: (receipt: DerivedOutputReceipt) => void;
}): DerivedOutputReceipt | null => {
  const receipt = buildHdrReopenedDerivedOutputReceipt({ imagePath, metadata });
  if (receipt !== null) upsert(receipt);
  return receipt;
};

export const upsertReopenedDerivedOutputReceipt = ({
  imagePath,
  metadata,
  upsert,
}: {
  imagePath: string;
  metadata: unknown;
  upsert: (receipt: DerivedOutputReceipt) => void;
}): DerivedOutputReceipt | null => {
  const receipt = buildReopenedDerivedOutputReceipt({ imagePath, metadata });
  if (receipt !== null) upsert(receipt);
  return receipt;
};

function buildFocusStackReceiptMetadataFromArtifact(
  artifact: z.infer<typeof rawEngineArtifactsWithHdrProvenanceSchema>['focusStackArtifacts'][number] | undefined,
): DerivedOutputReceipt['focusStack'] {
  if (artifact === undefined) return undefined;
  const parsedRetouchSeed =
    artifact.retouchSeed === undefined ? undefined : focusStackRetouchSeedSchema.safeParse(artifact.retouchSeed);
  const parsedBreathingCompensation =
    artifact['focusBreathingCompensation'] === undefined
      ? undefined
      : focusStackBreathingCompensationSchema.safeParse(artifact['focusBreathingCompensation']);
  const hasRetouchSeed = parsedRetouchSeed?.success === true;
  const hasBreathingCompensation = parsedBreathingCompensation?.success === true;
  if (!hasBreathingCompensation && !hasRetouchSeed) return undefined;

  return {
    ...(hasBreathingCompensation ? { breathingCompensation: parsedBreathingCompensation.data } : {}),
    ...(hasRetouchSeed ? { retouchSeed: parsedRetouchSeed.data } : {}),
  };
}

const derivedOutputStaleReasons = new Set([
  'accepted_dry_run_plan_changed',
  'output_artifact_changed',
  'recipe_hash_changed',
  'settings_hash_changed',
  'source_content_hash_changed',
  'source_graph_revision_changed',
  'source_order_changed',
  'source_set_changed',
]);

const isDerivedOutputStaleReason = (
  value: string,
): value is NonNullable<DerivedOutputReceipt['staleReasons']>[number] => derivedOutputStaleReasons.has(value);

const normalizeDimensions = (
  dimensions: { height: number; width: number } | undefined,
): DerivedOutputReceipt['previewDimensions'] =>
  dimensions === undefined
    ? undefined
    : {
        height: dimensions.height,
        width: dimensions.width,
      };

const buildPanoramaReceiptMetadataFromArtifact = ({
  artifact,
  previewDimensions,
  sourceState,
}: {
  artifact: z.infer<typeof rawEngineArtifactsWithHdrProvenanceSchema>['panoramaArtifacts'][number] | undefined;
  previewDimensions: DerivedOutputReceipt['previewDimensions'];
  sourceState: DerivedOutputProvenanceSidecar['sourceState'];
}): DerivedOutputReceipt['panorama'] => {
  const crop = artifact?.boundarySettings?.crop;
  const effectiveMode = artifact?.boundarySettings?.effectiveMode;
  const requestedMode = artifact?.boundarySettings?.requestedMode;
  const effectiveProjection = artifact?.projectionSettings?.effectiveProjection;
  const requestedProjection = artifact?.projectionSettings?.requestedProjection;
  if (
    artifact === undefined ||
    crop === undefined ||
    effectiveMode === undefined ||
    requestedMode === undefined ||
    effectiveProjection === undefined ||
    requestedProjection === undefined ||
    previewDimensions === undefined
  ) {
    return undefined;
  }

  return {
    boundary: {
      crop,
      effectiveMode,
      requestedMode,
    },
    previewDimensions,
    projection: {
      effective: effectiveProjection,
      requested: requestedProjection,
    },
    sourceSetHash: `sidecar:${sourceState.map((source) => `${source.order}:${source.contentHash}`).join('|')}`,
  };
};
