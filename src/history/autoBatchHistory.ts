import type { Adjustments } from '../utils/adjustments';
import { captureAdjustmentSnapshots, recordAdjustmentBatch, type AdjustmentSnapshots } from './adjustmentBatchHistory';

export interface AutoBatchHistoryCapture {
  before: AdjustmentSnapshots;
  label: string;
}

export async function captureAutoBatchHistory(paths: string[], label: string) {
  const uniquePaths = [...new Set(paths)];
  if (uniquePaths.length === 0) return null;
  return { before: await captureAdjustmentSnapshots(uniquePaths), label } satisfies AutoBatchHistoryCapture;
}

export async function recordCompletedAutoBatch(capture: AutoBatchHistoryCapture, changedPaths: string[]) {
  const paths = [...new Set(changedPaths)].filter((path) => capture.before[path]);
  if (paths.length === 0) return;
  const before = Object.fromEntries(paths.map((path) => [path, capture.before[path]])) as Record<string, Adjustments>;
  const after = await captureAdjustmentSnapshots(paths);
  if (JSON.stringify(before) !== JSON.stringify(after)) recordAdjustmentBatch(capture.label, before, after);
}
