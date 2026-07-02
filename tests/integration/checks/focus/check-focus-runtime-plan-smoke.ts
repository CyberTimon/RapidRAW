#!/usr/bin/env bun

import { deriveArtifactInvalidationReasons } from '../../../../packages/rawengine-schema/src/derivedArtifactInvalidation.ts';
import {
  applyFocusStackRuntimePlanV1,
  buildFocusStackRuntimeDryRunV1,
} from '../../../../packages/rawengine-schema/src/focus-stack/focusStackRuntimePlan.ts';
import {
  ApprovalClass,
  RAW_ENGINE_SCHEMA_VERSION,
} from '../../../../packages/rawengine-schema/src/rawEngineSchemas.ts';
import { COMPUTATIONAL_PROOF_MEMORY_BUDGET_BYTES } from '../../../../scripts/lib/computational/proof-budgets.ts';

const WIDTH = 72;
const HEIGHT = 48;
const sourceRegions = [
  { height: HEIGHT, sourceIndex: 0, width: 24, x: 0, y: 0 },
  { height: HEIGHT, sourceIndex: 1, width: 24, x: 24, y: 0 },
  { height: HEIGHT, sourceIndex: 2, width: 24, x: 48, y: 0 },
];

const frames = [0, 1, 2].map((sourceIndex) => ({
  contentHash: `sha256:focus-runtime-source-${sourceIndex}`,
  focusDistanceMm: 180 + sourceIndex * 60,
  graphRevision: 'graph_rev_focus_runtime_source',
  height: HEIGHT,
  pixels: createFocusFrame(sourceIndex),
  sourceIndex,
  translationX: sourceIndex === 0 ? 0 : sourceIndex,
  translationY: sourceIndex === 2 ? -1 : 0,
  width: WIDTH,
}));

const cells = sourceRegions.map((region) => ({
  height: region.height,
  lowConfidence: false,
  sourceScores: [0, 1, 2].map((sourceIndex) => ({
    relativeConfidence: sourceIndex === region.sourceIndex ? 1 : 0.01,
    sourceIndex,
  })),
  width: region.width,
  x: region.x,
  y: region.y,
}));

const dryRunCommand = {
  actor: { id: 'agent_rawengine', kind: 'agent' },
  approval: {
    approvalClass: ApprovalClass.PreviewOnly,
    reason: 'Focus stack runtime smoke validates non-mutating dry-run rendering.',
    state: 'not_required',
  },
  commandId: 'command_focus_runtime_plan_smoke',
  commandType: 'computationalMerge.createFocusStack',
  correlationId: 'corr_focus_runtime_plan_smoke',
  dryRun: true,
  expectedGraphRevision: 'graph_rev_focus_runtime',
  parameters: {
    alignmentMode: 'translation',
    blendMethod: 'weighted_sharpness',
    maxPreviewDimensionPx: 1200,
    memoryBudgetBytes: COMPUTATIONAL_PROOF_MEMORY_BUDGET_BYTES,
    outputName: 'Synthetic Runtime Focus Stack',
    qualityPreference: 'best',
    retouchLayerPolicy: 'generate_retouch_layer',
    sources: frames.map((frame) => ({
      colorSpaceHint: 'camera_rgb',
      focusDistanceMm: frame.focusDistanceMm,
      imageId: `img_focus_runtime_${frame.sourceIndex}`,
      imagePath: `/synthetic/focus/runtime-${frame.sourceIndex}.dng`,
      rawDefaultsApplied: true,
      role: 'focus_slice',
      sourceIndex: frame.sourceIndex,
    })),
  },
  schemaVersion: RAW_ENGINE_SCHEMA_VERSION,
  target: { id: 'project_focus_runtime', kind: 'project' },
};

const dryRun = buildFocusStackRuntimeDryRunV1({
  cells,
  command: dryRunCommand,
  depthConfidenceArtifactId: 'artifact_focus_runtime_depth_confidence',
  frames,
  haloMapArtifactId: 'artifact_focus_runtime_halo_map',
  outputArtifactId: 'artifact_focus_runtime_output',
  previewArtifactId: 'artifact_focus_runtime_preview',
  retouchLayerArtifactId: 'artifact_focus_runtime_retouch',
  sharpnessMapArtifactId: 'artifact_focus_runtime_sharpness',
});

const applyCommand = {
  ...dryRunCommand,
  approval: {
    approvalClass: ApprovalClass.EditApply,
    reason: 'Focus stack runtime smoke applies accepted dry-run plan.',
    state: 'approved',
  },
  commandId: 'command_focus_runtime_apply_smoke',
  correlationId: 'corr_focus_runtime_apply_smoke',
  dryRun: false,
  parameters: {
    ...dryRunCommand.parameters,
    acceptedDryRunPlanHash: dryRun.acceptedDryRunPlanHash,
    acceptedDryRunPlanId: dryRun.dryRunResult.mergePlan.planId,
  },
};

const applied = applyFocusStackRuntimePlanV1({
  artifactCreatedAt: '2026-06-17T20:10:00.000Z',
  cells,
  command: applyCommand,
  depthConfidenceArtifactId: 'artifact_focus_runtime_depth_confidence',
  frames,
  haloMapArtifactId: 'artifact_focus_runtime_halo_map',
  outputArtifactId: 'artifact_focus_runtime_output',
  previewArtifactId: 'artifact_focus_runtime_preview',
  retouchLayerArtifactId: 'artifact_focus_runtime_retouch',
  sharpnessMapArtifactId: 'artifact_focus_runtime_sharpness',
});

try {
  applyFocusStackRuntimePlanV1({
    cells,
    command: applyCommand,
    depthConfidenceArtifactId: 'artifact_focus_runtime_depth_confidence',
    frames,
    haloMapArtifactId: 'artifact_focus_runtime_halo_map',
    outputArtifactId: 'artifact_focus_runtime_output',
    previewArtifactId: 'artifact_focus_runtime_preview',
    retouchLayerArtifactId: 'artifact_focus_runtime_retouch',
    sharpnessMapArtifactId: 'artifact_focus_runtime_sharpness',
    weightPower: 3,
  });
  throw new Error('Focus stack stale accepted plan was applied after settings changed.');
} catch (error) {
  if (
    error instanceof Error &&
    error.message === 'Focus stack stale accepted plan was applied after settings changed.'
  ) {
    throw error;
  }
}

assertEqual(dryRun.provenance.focusCoverageRatio, 1, 'focus coverage');
assertEqual(
  dryRun.provenance.focusBreathingCompensation.status,
  'bounded_estimate',
  'breathing compensation estimate status',
);
assertEqual(
  dryRun.provenance.focusBreathingCompensation.compensationApplied,
  false,
  'breathing compensation applied flag',
);
assertEqual(
  dryRun.provenance.focusBreathingCompensation.maxRelativeScaleDelta,
  0.032,
  'breathing max relative scale delta',
);
assertDeepEqual(
  dryRun.provenance.focusBreathingCompensation.frameEstimates.map((estimate) => ({
    estimatedScale: estimate.estimatedScale,
    relativeScaleDelta: estimate.relativeScaleDelta,
    sourceIndex: estimate.sourceIndex,
  })),
  [
    { estimatedScale: 1, relativeScaleDelta: 0, sourceIndex: 0 },
    { estimatedScale: 1.016, relativeScaleDelta: 0.016, sourceIndex: 1 },
    { estimatedScale: 1.032, relativeScaleDelta: 0.032, sourceIndex: 2 },
  ],
  'breathing frame scale estimates',
);
if (!dryRun.provenance.focusBreathingCompensation.limits.includes('estimate_only_no_pixel_warp')) {
  throw new Error('Expected focus breathing receipt to state no pixel warp was applied.');
}
assertEqual(dryRun.provenance.alignmentTransforms.length, frames.length, 'alignment transform count');
assertEqual(dryRun.provenance.alignmentTransforms[0]?.role, 'reference', 'reference transform role');
assertEqual(dryRun.provenance.alignmentTransforms[2]?.translationY, -1, 'third transform y');
assertEqual(dryRun.provenance.blendSourceCoverage.length, frames.length, 'blend source coverage count');
assertEqual(dryRun.provenance.blendSourceCoverage[1]?.coveredAreaPx, (WIDTH / 3) * HEIGHT, 'middle coverage area');
assertEqual(dryRun.provenance.qualityMetrics.averageWinningConfidence, 1, 'average winning confidence');
assertEqual(dryRun.provenance.qualityMetrics.lowConfidenceAreaRatio, 0, 'low confidence area ratio');
assertEqual(dryRun.provenance.qualityMetrics.outputPixelCount, WIDTH * HEIGHT, 'quality output pixels');
assertEqual(dryRun.provenance.qualityMetrics.retouchLayerRecommended, true, 'retouch recommended');
assertEqual(dryRun.provenance.sharpnessSettings.cellCount, cells.length, 'sharpness cell count');
assertEqual(dryRun.provenance.sharpnessSettings.weightPower, 5, 'sharpness weight power');
assertEqual(applied.provenance.runtimeStatus, 'apply_rendered', 'apply runtime status');
assertEqual(applied.provenance.acceptedDryRunPlanId, dryRun.dryRunResult.mergePlan.planId, 'accepted plan id');
const artifactIds = applied.mutationResult.outputArtifacts.map((artifact) => artifact.artifactId).sort();
assertDeepEqual(
  artifactIds,
  [
    'artifact_focus_runtime_depth_confidence',
    'artifact_focus_runtime_halo_map',
    'artifact_focus_runtime_output',
    'artifact_focus_runtime_retouch',
    'artifact_focus_runtime_sharpness',
  ],
  'focus output artifacts',
);
for (const artifact of applied.mutationResult.outputArtifacts) {
  if (artifact.contentHash === undefined) {
    throw new Error(`Expected ${artifact.artifactId} to include rendered content hash.`);
  }
}
assertEqual(applied.sidecarArtifact.family, 'focus_stack', 'sidecar family');
assertEqual(applied.sidecarArtifact.focusBreathingCompensation?.status, 'bounded_estimate', 'sidecar breathing status');
assertEqual(
  applied.sidecarArtifact.focusBreathingCompensation?.maxRelativeScaleDelta,
  dryRun.provenance.focusBreathingCompensation.maxRelativeScaleDelta,
  'sidecar breathing max relative scale delta',
);
assertEqual(applied.sidecarArtifact.createdAt, '2026-06-17T20:10:00.000Z', 'sidecar created at');
assertEqual(applied.sidecarArtifact.outputArtifact.artifactId, 'artifact_focus_runtime_output', 'sidecar output');
assertEqual(applied.sidecarArtifact.haloMapArtifact?.artifactId, 'artifact_focus_runtime_halo_map', 'sidecar halo map');
assertEqual(
  applied.sidecarArtifact.haloReview?.artifactHash,
  applied.sidecarArtifact.haloMapArtifact?.contentHash,
  'sidecar halo review hash',
);
assertEqual(applied.sidecarArtifact.sharpnessMapArtifact?.storage, 'sidecar_artifact', 'sidecar sharpness storage');
assertEqual(applied.sidecarArtifact.depthConfidenceMapArtifact?.storage, 'sidecar_artifact', 'sidecar depth storage');
assertEqual(applied.sidecarArtifact.retouchLayerArtifact?.storage, 'sidecar_artifact', 'sidecar retouch storage');
assertEqual(applied.sidecarArtifact.sourceImageRefs.length, frames.length, 'sidecar source refs');
assertEqual(applied.sidecarArtifact.sourceState.length, frames.length, 'sidecar source state');
assertEqual(applied.sidecarArtifact.sharpnessSettings.cellCount, cells.length, 'sidecar sharpness cells');
assertEqual(applied.sidecarArtifact.staleState.state, 'current', 'sidecar stale state');
const currentArtifactState = {
  outputContentHash: applied.sidecarArtifact.outputArtifact.contentHash,
  sourceState: applied.sidecarArtifact.sourceState,
};
const unchangedReasons = deriveArtifactInvalidationReasons(
  {
    outputArtifact: { contentHash: applied.sidecarArtifact.outputArtifact.contentHash },
    sourceState: applied.sidecarArtifact.sourceState,
  },
  currentArtifactState,
);
assertEqual(unchangedReasons.length, 0, 'sidecar unchanged invalidation reasons');
const changedSourceReasons = deriveArtifactInvalidationReasons(
  {
    outputArtifact: { contentHash: applied.sidecarArtifact.outputArtifact.contentHash },
    sourceState: applied.sidecarArtifact.sourceState,
  },
  {
    ...currentArtifactState,
    sourceState: applied.sidecarArtifact.sourceState.map((sourceState, index) =>
      index === 0 ? { ...sourceState, contentHash: 'sha256:changed-focus-source' } : sourceState,
    ),
  },
);
if (!changedSourceReasons.includes('source_content_hash_changed')) {
  throw new Error('Expected focus stack sidecar to invalidate when source content changes.');
}

const outputHash = new Bun.CryptoHasher('sha256').update(new Uint8Array(applied.outputPixels.buffer)).digest('hex');
const sourceHashes = frames.map((frame) =>
  new Bun.CryptoHasher('sha256').update(new Uint8Array(frame.pixels.buffer)).digest('hex'),
);
if (sourceHashes.includes(outputHash)) {
  throw new Error('Expected focus stack output to differ from every source frame.');
}

const result = {
  acceptedDryRunPlanId: applied.provenance.acceptedDryRunPlanId,
  artifactCount: applied.mutationResult.outputArtifacts.length,
  artifactContentHashes: applied.mutationResult.outputArtifacts.map((artifact) => artifact.contentHash),
  fixture: 'synthetic_focus_runtime_plan_v1',
  focusCoverageRatio: dryRun.provenance.focusCoverageRatio,
  focusBreathingCompensation: dryRun.provenance.focusBreathingCompensation,
  outputSha256: outputHash,
  qualityMetrics: dryRun.provenance.qualityMetrics,
  sharpnessSettings: dryRun.provenance.sharpnessSettings,
  warnings: dryRun.dryRunResult.warnings,
};
if (process.argv.includes('--verbose')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`focus runtime plan ok (${result.artifactCount} artifacts, coverage=${result.focusCoverageRatio})`);
}

function createFocusFrame(sourceIndex) {
  const pixels = new Float32Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const localPattern = ((x * 7 + y * 11 + sourceIndex * 19) % 31) / 255;
      const sourceRegion = sourceRegions.find((region) => x >= region.x && x < region.x + region.width);
      const focusBoost = sourceRegion?.sourceIndex === sourceIndex ? 0.72 : 0.08;
      pixels[y * WIDTH + x] = Math.min(1, 0.12 + localPattern + focusBoost);
    }
  }
  return pixels;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}.`);
  }
}

function assertDeepEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}
