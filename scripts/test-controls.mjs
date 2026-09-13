import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = await mkdtemp(join(tmpdir(), 'rapidraw-controls-'));
const entries = [
  'src/crop/geometry.test.ts',
  'src/crop/session.test.ts',
  'src/crop/store.test.ts',
  'src/shortcuts/profiles.test.ts',
  'src/shortcuts/libraryNavigation.test.ts',
];
try {
  const paths = [];
  for (const [index, entry] of entries.entries()) {
    const outfile = join(directory, `${index}.cjs`);
    await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'cjs' });
    paths.push(outfile);
  }
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...paths], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
