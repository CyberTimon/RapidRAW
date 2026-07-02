#!/usr/bin/env bun

import { FocusStackAppServerRuntimeToolBusV1 } from '../../../../packages/rawengine-schema/src/focus-stack/focusStackAppServerRuntime.ts';
import {
  ApprovalClass,
  RAW_ENGINE_SCHEMA_VERSION,
} from '../../../../packages/rawengine-schema/src/rawEngineSchemas.ts';
import { sampleComputationalMergeAppServerToolManifestV1 } from '../../../../packages/rawengine-schema/src/samplePayloads.ts';
import { COMPUTATIONAL_PROOF_MEMORY_BUDGET_BYTES } from '../../../../scripts/lib/computational/proof-budgets.ts';
import { getComputationalMergeAppServerRoutePairSummary } from '../../../../src/utils/computational-merge/computationalMergeAppServerRoutePairs.ts';
import { buildFocusStackDerivedOutputReceipt } from '../../../../src/utils/derivedOutputReceipt.ts';
import { buildFocusStackOutputReviewFromArtifact } from '../../../../src/utils/focusStackOutputReview.ts';

const focusRoutePair = getComputationalMergeAppServerRoutePairSummary('focus_stack');
const WIDTH = 72;
const HEIGHT = 48;
const sourceRegions = [
  { height: HEIGHT, sourceIndex: 0, width: 24, x: 0, y: 0 },
  { height: HEIGHT, sourceIndex: 1, width: 24, x: 24, y: 0 },
  { height: HEIGHT, sourceIndex: 2, width: 24, x: 48, y: 0 },
];
const frames = [0, 1, 2].map((sourceIndex) => ({
  contentHash: `sha256:focus-app-server-runtime-${sourceIndex}`,
  focusDistanceMm: 180 + sourceIndex * 60,
  graphRevision: 'graph_rev_focus_app_server_runtime_source',
  height: HEIGHT,
  pixels: createFocusFrame(sourceIndex),
  sourceIndex,
  translationX: 0,
  translationY: 0,
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
    reason: 'Focus stack app-server runtime smoke validates dry-run dispatch.',
    state: 'not_required',
  },
  commandId: 'command_focus_app_server_runtime',
  commandType: 'computationalMerge.createFocusStack',
  correlationId: 'corr_focus_app_server_runtime',
  dryRun: true,
  expectedGraphRevision: 'graph_rev_focus_app_server_runtime',
  parameters: {
    alignmentMode: 'translation',
    blendMethod: 'weighted_sharpness',
    maxPreviewDimensionPx: 1200,
    memoryBudgetBytes: COMPUTATIONAL_PROOF_MEMORY_BUDGET_BYTES,
    outputName: 'Synthetic App Server Runtime Focus Stack',
    qualityPreference: 'best',
    retouchLayerPolicy: 'generate_retouch_layer',
    sources: frames.map((frame) => ({
      colorSpaceHint: 'camera_rgb',
      focusDistanceMm: frame.focusDistanceMm,
      imageId: `img_focus_app_server_runtime_${frame.sourceIndex}`,
      imagePath: `/synthetic/focus/app-server-runtime-${frame.sourceIndex}.dng`,
      rawDefaultsApplied: true,
      role: 'focus_slice',
      sourceIndex: frame.sourceIndex,
    })),
  },
  schemaVersion: RAW_ENGINE_SCHEMA_VERSION,
  target: { id: 'project_focus_app_server_runtime', kind: 'project' },
};

const bus = new FocusStackAppServerRuntimeToolBusV1(sampleComputationalMergeAppServerToolManifestV1);
const dryRun = bus.execute({
  request: buildRequest(dryRunCommand),
  toolName: focusRoutePair.dryRunToolName,
});
if (dryRun.kind !== 'dry_run') throw new Error('Expected focus dry-run dispatch result.');

const applyCommand = {
  ...dryRunCommand,
  approval: {
    approvalClass: ApprovalClass.EditApply,
    reason: 'Focus stack app-server runtime smoke applies accepted plan.',
    state: 'approved',
  },
  commandId: 'command_focus_app_server_runtime_apply',
  correlationId: 'corr_focus_app_server_runtime_apply',
  dryRun: false,
  parameters: {
    ...dryRunCommand.parameters,
    acceptedDryRunPlanHash: dryRun.acceptedDryRunPlanHash,
    acceptedDryRunPlanId: dryRun.dryRun.dryRunResult.mergePlan.planId,
  },
};
const applied = bus.execute({
  request: buildRequest(applyCommand),
  toolName: focusRoutePair.applyToolName,
});
if (applied.kind !== 'apply') throw new Error('Expected focus apply dispatch result.');
if (applied.apply.sidecarArtifact.sourceImageRefs.length !== frames.length) {
  throw new Error('Expected focus app-server apply to return editable sidecar source refs.');
}
if (applied.apply.sidecarArtifact.outputArtifact.artifactId !== 'artifact_focus_app_server_runtime_output') {
  throw new Error('Expected focus app-server apply to return sidecar output artifact.');
}
if (applied.apply.sidecarArtifact.haloMapArtifact?.artifactId !== 'artifact_focus_app_server_runtime_halo_map') {
  throw new Error('Expected focus app-server apply to return sidecar halo map artifact.');
}
if (
  applied.apply.sidecarArtifact.haloReview?.artifactHash !== applied.apply.sidecarArtifact.haloMapArtifact.contentHash
) {
  throw new Error('Expected focus app-server halo review to preserve halo map hash.');
}
if (applied.apply.sidecarArtifact.retouchSeed?.availability !== 'available') {
  throw new Error('Expected focus app-server apply to persist available retouch seed metadata.');
}
if (applied.apply.sidecarArtifact.retouchSeed?.staleState !== 'current') {
  throw new Error('Expected focus app-server apply to persist current retouch seed state.');
}
if (applied.apply.sidecarArtifact.focusBreathingCompensation?.status !== 'bounded_estimate') {
  throw new Error('Expected focus app-server apply to persist bounded focus breathing compensation evidence.');
}
if (applied.apply.sidecarArtifact.focusBreathingCompensation.maxRelativeScaleDelta !== 0.032) {
  throw new Error(
    `Expected focus breathing max scale delta 0.032, got ${applied.apply.sidecarArtifact.focusBreathingCompensation.maxRelativeScaleDelta}.`,
  );
}
if (applied.apply.sidecarArtifact.createdAt !== '2026-06-17T20:15:00.000Z') {
  throw new Error('Expected focus app-server apply to preserve sidecar artifact timestamp.');
}
const outputReview = buildFocusStackOutputReviewFromArtifact(applied.apply.sidecarArtifact);
if (outputReview.focusBreathingCompensation?.status !== 'bounded_estimate') {
  throw new Error('Expected focus output review to expose focus breathing compensation evidence.');
}
if (outputReview.haloReview.artifactHash !== applied.apply.sidecarArtifact.haloMapArtifact.contentHash) {
  throw new Error('Expected focus output review to expose halo map hash.');
}
if (outputReview.editableHandoff.status !== 'ready') {
  throw new Error(`Expected focus app-server output review ready handoff, got ${outputReview.editableHandoff.status}.`);
}
assertEqual(outputReview.lowConfidenceCellRatio, 0, 'output review low-confidence ratio');
assertEqual(outputReview.haloRiskCellRatio, 0, 'output review halo-risk ratio');
assertDeepEqual(
  outputReview.reviewOverlay.sourceContributionSummary,
  [
    { sourceIndex: 0, winnerCellRatio: 0.333333 },
    { sourceIndex: 1, winnerCellRatio: 0.333333 },
    { sourceIndex: 2, winnerCellRatio: 0.333333 },
  ],
  'output review source contribution summary',
);
assertDeepEqual(
  outputReview.reviewOverlay.sourceContributionDetails.map((source) => ({
    confidencePercent: source.confidencePercent,
    coverageCellCount: source.coverageCellCount,
    sourceIndex: source.sourceIndex,
    warningState: source.warningState,
  })),
  [
    { confidencePercent: 96, coverageCellCount: 1, sourceIndex: 0, warningState: 'clear' },
    { confidencePercent: 88, coverageCellCount: 1, sourceIndex: 1, warningState: 'artifact_review_required' },
    { confidencePercent: 86, coverageCellCount: 1, sourceIndex: 2, warningState: 'artifact_review_required' },
  ],
  'output review source contribution details',
);
const derivedReceipt = buildFocusStackDerivedOutputReceipt({
  acceptedDryRunPlanHash: applied.apply.provenance.acceptedDryRunPlanHash,
  acceptedDryRunPlanId: applied.apply.provenance.acceptedDryRunPlanId,
  review: outputReview,
  settings: {
    alignmentMode: 'translation',
    blendMethod: 'weighted_sharpness',
    haloSuppressionStrengthPercent: 80,
    maxPreviewDimensionPx: 1200,
    qualityPreference: 'best',
    retouchLayerPolicy: 'generate_retouch_layer',
    reviewOverlayMode: 'halo_risk',
    reviewOverlayOpacityPercent: 70,
    sourceMode: 'focus_bracket',
  },
});
if (derivedReceipt.openInEditorAction.state !== 'available') {
  throw new Error('Expected focus stack derived receipt to expose typed available editor handoff.');
}
if (derivedReceipt.openInEditorAction.path !== outputReview.artifactPath) {
  throw new Error('Expected focus stack derived receipt to expose the applied output path.');
}
if (derivedReceipt.provenanceSidecar?.acceptedDryRunId !== outputReview.editableHandoff.exportReviewArtifactId) {
  throw new Error('Expected focus stack derived receipt to preserve export-review handoff metadata.');
}
if (derivedReceipt.focusStack?.retouchSeed?.acceptedDryRunPlanId !== applied.apply.provenance.acceptedDryRunPlanId) {
  throw new Error('Expected focus stack derived receipt to persist the accepted retouch seed plan id.');
}
if (derivedReceipt.focusStack?.breathingCompensation?.status !== 'bounded_estimate') {
  throw new Error('Expected focus stack derived receipt to persist breathing compensation evidence.');
}
if (derivedReceipt.provenanceSidecar?.focusStack?.breathingCompensation?.compensationApplied !== false) {
  throw new Error('Expected focus stack sidecar receipt to persist breathing compensation limits.');
}

const outputHash = new Bun.CryptoHasher('sha256')
  .update(new Uint8Array(applied.apply.outputPixels.buffer))
  .digest('hex');
const sourceHashes = frames.map((frame) =>
  new Bun.CryptoHasher('sha256').update(new Uint8Array(frame.pixels.buffer)).digest('hex'),
);
if (sourceHashes.includes(outputHash)) throw new Error('Expected focus stack output to differ from source frames.');

expectThrows('unaccepted focus apply plan', () =>
  new FocusStackAppServerRuntimeToolBusV1(sampleComputationalMergeAppServerToolManifestV1).execute({
    request: buildRequest(applyCommand),
    toolName: focusRoutePair.applyToolName,
  }),
);

const result = {
  editableArtifactId: applied.apply.sidecarArtifact.artifactId,
  fixture: 'synthetic_focus_app_server_runtime_v1',
  focusBreathingCompensation: applied.apply.provenance.focusBreathingCompensation,
  focusCoverageRatio: applied.apply.provenance.focusCoverageRatio,
  outputSha256: outputHash,
  planId: dryRun.dryRun.dryRunResult.mergePlan.planId,
};
if (process.argv.includes('--verbose')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`focus app-server runtime ok (coverage=${result.focusCoverageRatio})`);
}

function buildRequest(command) {
  return {
    artifactCreatedAt: '2026-06-17T20:15:00.000Z',
    cells,
    command,
    depthConfidenceArtifactId: 'artifact_focus_app_server_runtime_depth_confidence',
    frames,
    haloMapArtifactId: 'artifact_focus_app_server_runtime_halo_map',
    outputArtifactId: 'artifact_focus_app_server_runtime_output',
    previewArtifactId: 'artifact_focus_app_server_runtime_preview',
    retouchLayerArtifactId: 'artifact_focus_app_server_runtime_retouch',
    sharpnessMapArtifactId: 'artifact_focus_app_server_runtime_sharpness',
  };
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

function expectThrows(label, callback) {
  try {
    callback();
  } catch {
    return;
  }
  throw new Error(`Expected ${label} to throw.`);
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
