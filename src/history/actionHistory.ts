export type HistoryOperation = () => void | Promise<void>;

export interface UndoableAction {
  label: string;
  undo: HistoryOperation;
  redo: HistoryOperation;
}

interface HistoryEntry extends UndoableAction {
  id: number;
}

export interface ActionHistorySnapshot {
  busy: boolean;
  canRedo: boolean;
  canUndo: boolean;
  redoLabel: string | null;
  undoLabel: string | null;
}

const MAX_HISTORY = 100;
const listeners = new Set<() => void>();
let past: HistoryEntry[] = [];
let future: HistoryEntry[] = [];
let nextId = 1;
let busy = false;
let replayingId: number | null = null;
let replayRecordIds: number[] = [];
const discarded = new Set<number>();
let snapshot: ActionHistorySnapshot = createSnapshot();

function createSnapshot(): ActionHistorySnapshot {
  return {
    busy,
    canRedo: !busy && future.length > 0,
    canUndo: !busy && past.length > 0,
    redoLabel: future.at(-1)?.label ?? null,
    undoLabel: past.at(-1)?.label ?? null,
  };
}

function publish() {
  snapshot = createSnapshot();
  listeners.forEach((listener) => listener());
}

export function recordUndoableAction(action: UndoableAction) {
  const entry = { ...action, id: nextId++ };
  if (replayingId !== null) replayRecordIds.push(entry.id);
  past = [...past, entry].slice(-MAX_HISTORY);
  future = [];
  publish();
  return entry.id;
}

export function discardUndoableAction(id: number) {
  if (replayingId === id) discarded.add(id);
  past = past.filter((entry) => entry.id !== id);
  future = future.filter((entry) => entry.id !== id);
  publish();
}

async function replay(direction: 'undo' | 'redo') {
  if (busy) return false;
  const source = direction === 'undo' ? past : future;
  const entry = source.at(-1);
  if (!entry) return false;

  if (direction === 'undo') past = past.slice(0, -1);
  else future = future.slice(0, -1);
  busy = true;
  replayingId = entry.id;
  replayRecordIds = [];
  publish();

  const restoreBeforeConcurrentRecords = () => {
    const recorded = new Set(replayRecordIds);
    const insertionIndex = past.findIndex((candidate) => recorded.has(candidate.id));
    const nextPast = [...past];
    nextPast.splice(insertionIndex < 0 ? nextPast.length : insertionIndex, 0, entry);
    past = nextPast.slice(-MAX_HISTORY);
  };

  try {
    await entry[direction]();
    if (!discarded.has(entry.id)) {
      if (direction === 'undo') {
        if (replayRecordIds.length === 0) future = [...future, entry];
      } else if (replayRecordIds.length === 0) past = [...past, entry].slice(-MAX_HISTORY);
      else restoreBeforeConcurrentRecords();
    }
    return true;
  } catch (error) {
    if (!discarded.has(entry.id)) {
      if (direction === 'undo') {
        if (replayRecordIds.length === 0) past = [...past, entry];
        else restoreBeforeConcurrentRecords();
      } else if (replayRecordIds.length === 0) future = [...future, entry];
    }
    throw error;
  } finally {
    busy = false;
    replayingId = null;
    replayRecordIds = [];
    discarded.delete(entry.id);
    publish();
  }
}

export const undoLastAction = () => replay('undo');
export const redoLastAction = () => replay('redo');

export function getActionHistorySnapshot() {
  return snapshot;
}

export function subscribeActionHistory(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetActionHistory() {
  past = [];
  future = [];
  busy = false;
  replayingId = null;
  replayRecordIds = [];
  discarded.clear();
  publish();
}
