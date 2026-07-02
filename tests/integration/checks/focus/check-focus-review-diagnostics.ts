#!/usr/bin/env bun

import { readFileSync } from 'node:fs';

const failures: string[] = [];
const modalSource = readFileSync('src/components/modals/computational-merge/FocusStackModal.tsx', 'utf8');
const panelSource = readFileSync('src/components/modals/computational-merge/ComputationalMergeReviewPanel.tsx', 'utf8');
const receiptPanelSource = readFileSync(
  'src/components/modals/computational-merge/DerivedOutputReceiptPanel.tsx',
  'utf8',
);
const contractSource = readFileSync('src/utils/computational-merge/computationalMergeReviewPanels.ts', 'utf8');
const reviewSource = readFileSync('src/utils/focusStackOutputReview.ts', 'utf8');

for (const marker of [
  'focus-review-diagnostics',
  'focus-stack-setup-summary',
  'focus-stack-readiness-summary',
  'data-stack-ready={String(isSourceCountValid)}',
  'data-alignment-mode={settings.alignmentMode}',
  'data-blend-method={settings.blendMethod}',
  'sourceReadinessLabel',
  'stackReadinessLabel',
  'sections={[',
  'modals.focusStack.preflight.sources',
  'modals.focusStack.preflight.ready',
  'modals.focusStack.preflight.blocked',
  'modals.focusStack.preflight.alignment',
  'modals.focusStack.qualityLabel',
  'modals.focusStack.preflight.previewBudget',
  'settings.maxPreviewDimensionPx',
  'modals.focusStack.preflight.blend',
  'modals.focusStack.haloSuppressionLabel',
  'modals.focusStack.haloSuppressionValue',
  'modals.focusStack.review.decision',
  'modals.focusStack.review.editableArtifact',
  'modals.focusStack.review.editableHandoffStatus',
  'modals.focusStack.review.exportHandoff',
  'modals.focusStack.review.retouchedExportParity',
  'data-retouched-export-parity-status={outputReview.editableHandoff.retouchedExportParity?.status ??',
  'data-retouched-export-parity-proof-hash=',
  'modals.focusStack.review.haloRegionRisk',
  'modals.focusStack.review.haloReviewStatus',
  'modals.focusStack.review.haloReviewTitle',
  'modals.focusStack.review.haloRiskCells',
  'modals.focusStack.review.lowConfidenceCells',
  'modals.focusStack.review.overlay',
  'modals.focusStack.review.overlayMode',
  'modals.focusStack.review.overlayTitle',
  'modals.focusStack.review.sourceContribution',
  'modals.focusStack.review.percentValue',
  'modals.focusStack.review.provenance',
  'modals.focusStack.review.sharpnessCoverage',
  'modals.focusStack.review.transitionRisk',
  'modals.focusStack.review.warning',
  'buildFocusStackOutputReviewWorkflow',
  'focus-editable-handoff-proof',
  'data-editable-artifact-id={outputReview.editableHandoff.artifactId}',
  'data-export-review-artifact-id={outputReview.editableHandoff.exportReviewArtifactId}',
  'data-halo-review-status={outputReview.haloReview.reviewStatus}',
  'focus-sharpness-overlay-controls',
  'focus-halo-suppression-controls',
  'settings.haloSuppressionStrengthPercent',
  'settings.reviewOverlayMode',
  'settings.reviewOverlayOpacityPercent',
]) {
  if (!modalSource.includes(marker)) {
    failures.push(`Focus review diagnostics missing ${marker}.`);
  }
}

for (const marker of [
  'buildFocusStackOutputReviewFromArtifact',
  'artifact.haloReview',
  'focusBreathingCompensation',
  'editableHandoff',
  'retouchedExportParity',
  'transitionRiskRegions',
  'settings.haloSuppressionStrengthPercent',
]) {
  if (!reviewSource.includes(marker)) {
    failures.push(`Focus output review adapter missing ${marker}.`);
  }
}

for (const marker of ['ComputationalMergeReviewSection', 'sections?:', 'data-testid={testId}']) {
  if (!panelSource.includes(marker)) {
    failures.push(`Shared review panel missing ${marker}.`);
  }
}

for (const marker of [
  'Retouch seed availability',
  'Retouch seed state',
  'Mask regions',
  'retouchSeed',
  'Breathing compensation status',
  'Breathing max scale delta',
  'Breathing limits',
  'data-focus-retouch-seed-availability=',
  'data-focus-retouch-seed-state=',
  'data-focus-breathing-compensation-status=',
  'data-focus-breathing-compensation-applied=',
  'data-focus-breathing-evidence-source=',
  'data-focus-breathing-max-relative-scale-delta=',
  'data-focus-breathing-reference-source-index=',
  'data-focus-breathing-limits=',
]) {
  if (!receiptPanelSource.includes(marker)) {
    failures.push(`Derived output receipt panel missing ${marker}.`);
  }
}

for (const marker of ['focus_stack', 'sharpnessGainRatio', 'synthetic_runtime', 'not_raw_decode_verified']) {
  if (!contractSource.includes(marker)) {
    failures.push(`Review diagnostics contract missing ${marker}.`);
  }
}

if (failures.length > 0) {
  console.error('Focus review diagnostics validation failed.');
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('focus review diagnostics ok');
