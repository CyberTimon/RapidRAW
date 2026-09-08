import type { PeopleScanScope } from './types';
export type ScopeKind = 'context' | 'results' | 'source' | 'roots';
export function resolvePeopleScope(
  kind: ScopeKind,
  selected: string[],
  results: string[],
  source: string[],
  roots: string[],
  force = false,
): PeopleScanScope {
  const paths =
    kind === 'roots' ? roots : kind === 'source' ? source : kind === 'context' && selected.length ? selected : results;
  return { paths: [...new Set(paths.map((p) => p.split('?vc=')[0]))], recursive: kind === 'roots', force };
}
