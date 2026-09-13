import type { Adjustments } from '../utils/adjustments';

type CommitListener = (path: string, adjustments: Adjustments, previous: Adjustments) => void;
let listener: CommitListener | null = null;

export function registerCropCommitListener(next: CommitListener) {
  listener = next;
  return () => {
    if (listener === next) listener = null;
  };
}

export function notifyCropCommit(path: string, adjustments: Adjustments, previous: Adjustments) {
  listener?.(path, adjustments, previous);
}
