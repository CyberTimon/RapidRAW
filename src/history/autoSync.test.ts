import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppSettings } from '../components/ui/AppProperties';
import { useLibraryStore } from '../store/useLibraryStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { INITIAL_ADJUSTMENTS } from '../utils/adjustments';
import { resetActionHistory, undoLastAction } from './actionHistory';
import { scheduleSelectedAdjustmentSync } from './autoSync';

type TestRuntime = typeof globalThis & {
  __rapidrawInvoke?: (command: string, args: unknown) => Promise<unknown>;
};

test('batches a gallery gesture and syncs its final delta to the other selected photos', async () => {
  resetActionHistory();
  const calls: Array<{ command: string; args: unknown }> = [];
  const saved = {
    'active.jpg': { ...INITIAL_ADJUSTMENTS },
    'second.jpg': { ...INITIAL_ADJUSTMENTS },
  };
  (globalThis as TestRuntime).__rapidrawInvoke = async (command, args) => {
    calls.push({ command, args });
    const payload = args as { adjustments?: Partial<typeof INITIAL_ADJUSTMENTS>; path?: keyof typeof saved };
    if (command === 'load_metadata' && payload.path) return { adjustments: saved[payload.path] };
    if (command === 'apply_adjustments_to_paths') {
      saved['second.jpg'] = { ...saved['second.jpg'], ...payload.adjustments };
    }
    if (command === 'save_metadata_and_update_thumbnail' && payload.path && payload.adjustments) {
      saved[payload.path] = { ...saved[payload.path], ...payload.adjustments };
    }
  };
  useLibraryStore.setState({ multiSelectedPaths: ['active.jpg', 'second.jpg'] });
  useSettingsStore.setState({
    appSettings: {
      copyPasteSettings: {
        mode: 'merge',
        includedAdjustments: ['exposure'],
        knownAdjustments: ['exposure'],
        autoSync: true,
      },
    } as AppSettings,
  });

  const middle = { ...INITIAL_ADJUSTMENTS, exposure: 0.5 };
  const final = { ...INITIAL_ADJUSTMENTS, exposure: 1 };
  scheduleSelectedAdjustmentSync('active.jpg', INITIAL_ADJUSTMENTS, middle);
  scheduleSelectedAdjustmentSync('active.jpg', middle, final);
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.deepEqual(
    calls
      .filter(({ command }) => command === 'apply_adjustments_to_paths')
      .map(({ command, args }) => {
        const { syncJobId, ...payload } = args as Record<string, unknown>;
        assert.equal(typeof syncJobId, 'string');
        return { command, args: payload };
      }),
    [
      {
        command: 'apply_adjustments_to_paths',
        args: { paths: ['second.jpg'], adjustments: { exposure: 1 } },
      },
    ],
  );
  assert.equal(saved['second.jpg'].exposure, 1);
  await undoLastAction();
  assert.equal(saved['active.jpg'].exposure, 0);
  assert.equal(saved['second.jpg'].exposure, 0);
});

test('syncs the visible Exposure slider even when manual paste only includes EV Shift', async () => {
  resetActionHistory();
  const saved: Record<string, typeof INITIAL_ADJUSTMENTS> = {
    'first.CR3': { ...INITIAL_ADJUSTMENTS, brightness: 0.25, contrast: 12 },
    'second.CR3': { ...INITIAL_ADJUSTMENTS, brightness: 1.51 },
    'third.CR3': { ...INITIAL_ADJUSTMENTS, brightness: -1, contrast: 8 },
    'unselected.CR3': { ...INITIAL_ADJUSTMENTS, brightness: -2 },
  };
  (globalThis as TestRuntime).__rapidrawInvoke = async (command, args) => {
    const payload = args as { path: string; paths: string[]; adjustments: Partial<typeof INITIAL_ADJUSTMENTS> };
    if (command === 'load_metadata') return { adjustments: saved[payload.path] };
    if (command === 'apply_adjustments_to_paths') {
      for (const path of payload.paths) saved[path] = { ...saved[path], ...payload.adjustments };
    }
  };
  useLibraryStore.setState({ multiSelectedPaths: ['first.CR3', 'second.CR3', 'third.CR3'] });
  useSettingsStore.setState({
    appSettings: {
      copyPasteSettings: { mode: 'merge', includedAdjustments: ['exposure', 'toneMapper'], autoSync: true },
    } as AppSettings,
  });
  const previous = saved['second.CR3'];
  const next = { ...previous, brightness: 3.82 };
  assert.equal(scheduleSelectedAdjustmentSync('second.CR3', previous, next), true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(saved['first.CR3'].brightness, 3.82);
  assert.equal(saved['third.CR3'].brightness, 3.82);
  assert.equal(saved['first.CR3'].contrast, 12);
  assert.equal(saved['third.CR3'].contrast, 8);
  assert.equal(saved['unselected.CR3'].brightness, -2);

  useSettingsStore.setState({
    appSettings: { copyPasteSettings: { autoSync: false } } as AppSettings,
  });
  assert.equal(scheduleSelectedAdjustmentSync('second.CR3', next, { ...next, brightness: 0 }), false);
  useSettingsStore.setState({
    appSettings: { copyPasteSettings: { autoSync: true } } as AppSettings,
  });
});

test('immediate undo cancels a pending selected-photo sync', async () => {
  resetActionHistory();
  const commands: string[] = [];
  (globalThis as TestRuntime).__rapidrawInvoke = async (command) => {
    commands.push(command);
    if (command === 'load_metadata') return { adjustments: INITIAL_ADJUSTMENTS };
  };
  useLibraryStore.setState({ multiSelectedPaths: ['active.jpg', 'second.jpg'] });

  scheduleSelectedAdjustmentSync('active.jpg', INITIAL_ADJUSTMENTS, { ...INITIAL_ADJUSTMENTS, exposure: 2 });
  await undoLastAction();
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(commands.includes('apply_adjustments_to_paths'), false);
});
