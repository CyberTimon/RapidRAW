import test from 'node:test';
import assert from 'node:assert/strict';
import {
  discardUndoableAction,
  getActionHistorySnapshot,
  recordUndoableAction,
  redoLastAction,
  resetActionHistory,
  undoLastAction,
} from './actionHistory';

test('undo and redo replay actions in global order', async () => {
  resetActionHistory();
  const values: string[] = [];
  const add = (value: string) => {
    values.push(value);
    recordUndoableAction({
      label: value,
      undo: () => void values.splice(values.lastIndexOf(value), 1),
      redo: () => void values.push(value),
    });
  };

  add('rating');
  add('exposure');
  await undoLastAction();
  assert.deepEqual(values, ['rating']);
  await undoLastAction();
  assert.deepEqual(values, []);
  await redoLastAction();
  await redoLastAction();
  assert.deepEqual(values, ['rating', 'exposure']);
});

test('a new action clears redo without losing earlier undo entries', async () => {
  resetActionHistory();
  let value = 0;
  const set = (before: number, after: number) => {
    value = after;
    recordUndoableAction({ label: 'change', undo: () => void (value = before), redo: () => void (value = after) });
  };

  set(0, 1);
  set(1, 2);
  await undoLastAction();
  set(1, 3);
  assert.equal(getActionHistorySnapshot().canRedo, false);
  await undoLastAction();
  await undoLastAction();
  assert.equal(value, 0);
});

test('a failed replay stays available and unlocks history', async () => {
  resetActionHistory();
  recordUndoableAction({ label: 'failure', undo: () => Promise.reject(new Error('nope')), redo: () => {} });
  await assert.rejects(undoLastAction(), /nope/);
  assert.deepEqual(getActionHistorySnapshot(), {
    busy: false,
    canRedo: false,
    canUndo: true,
    redoLabel: null,
    undoLabel: 'failure',
  });
});

test('discard removes a failed optimistic action', () => {
  resetActionHistory();
  const id = recordUndoableAction({ label: 'pending', undo: () => {}, redo: () => {} });
  discardUndoableAction(id);
  assert.equal(getActionHistorySnapshot().canUndo, false);
  assert.equal(getActionHistorySnapshot().canRedo, false);
});

test('a new action during undo invalidates redo and remains undoable', async () => {
  resetActionHistory();
  let value = 1;
  let release: (() => void) | undefined;
  recordUndoableAction({
    label: 'first',
    undo: async () => {
      value = 0;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    redo: () => void (value = 1),
  });

  const undo = undoLastAction();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const beforeSecond = value;
  value = 2;
  recordUndoableAction({
    label: 'second',
    undo: () => void (value = beforeSecond),
    redo: () => void (value = 2),
  });
  release?.();
  await undo;

  assert.equal(getActionHistorySnapshot().canRedo, false);
  await undoLastAction();
  assert.equal(value, 0);
});

test('a new action during redo stays after the replayed action', async () => {
  resetActionHistory();
  let value = 1;
  let release: (() => void) | undefined;
  recordUndoableAction({
    label: 'first',
    undo: () => void (value = 0),
    redo: async () => {
      value = 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  await undoLastAction();

  const redo = redoLastAction();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const beforeSecond = value;
  value = 2;
  recordUndoableAction({
    label: 'second',
    undo: () => void (value = beforeSecond),
    redo: () => void (value = 2),
  });
  release?.();
  await redo;

  await undoLastAction();
  assert.equal(value, 1);
  await undoLastAction();
  assert.equal(value, 0);
});
