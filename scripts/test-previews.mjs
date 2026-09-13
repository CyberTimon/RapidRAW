import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = await mkdtemp(join(tmpdir(), 'rapidraw-previews-'));
const entries = [
  'src/utils/previewDetailQueue.test.ts',
  'src/utils/thumbnailCache.test.ts',
  'src/hooks/librarySelection.test.ts',
  'src/hooks/thumbnailRequests.test.ts',
];
try {
  const paths = [];
  for (const [index, entry] of entries.entries()) {
    const outfile = join(directory, `${index}.cjs`);
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      plugins: [
        {
          name: 'tauri-test-bridge',
          setup(build) {
            build.onResolve({ filter: /^@tauri-apps\/api\/(core|event)$/ }, ({ path }) => ({
              path,
              namespace: 'tauri-test',
            }));
            build.onLoad({ filter: /core$/, namespace: 'tauri-test' }, () => ({
              contents:
                'export const invoke = (command, args) => globalThis.__rapidrawInvoke?.(command, args) ?? Promise.resolve();',
              loader: 'js',
            }));
            build.onLoad({ filter: /event$/, namespace: 'tauri-test' }, () => ({
              contents:
                'export const listen = async (event, callback) => globalThis.__rapidrawListen?.(event, callback) ?? (() => {});',
              loader: 'js',
            }));
          },
        },
      ],
    });
    paths.push(outfile);
  }
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...paths], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
