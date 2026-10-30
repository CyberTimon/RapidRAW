import { influenceTargetKey, type InfluenceTarget } from './influencePreview';
export interface InfluenceIdentity {
  imageEpoch: number;
  recipeRevision: number;
  generation: number;
  resolution: number;
  targetKey: string;
}
export interface InfluenceState {
  target: InfluenceTarget | null;
  imageEpoch: number;
  recipeRevision: number;
  generation: number;
  interactions: readonly string[];
  status: 'off' | 'pending' | 'ready';
  request: InfluenceIdentity | null;
  result: InfluenceIdentity | null;
}
export const initialInfluenceState = (): InfluenceState => ({
  target: null,
  imageEpoch: 0,
  recipeRevision: 0,
  generation: 0,
  interactions: [],
  status: 'off',
  request: null,
  result: null,
});
export type InfluenceEvent =
  | { type: 'activate'; target: InfluenceTarget }
  | { type: 'clear' }
  | { type: 'imageChanged' }
  | { type: 'recipeChanged' }
  | { type: 'interaction'; token: string; active: boolean }
  | { type: 'request'; resolution: number }
  | { type: 'resolved'; identity: InfluenceIdentity };
export const sameInfluenceIdentity = (a: InfluenceIdentity, b: InfluenceIdentity) =>
  a.imageEpoch === b.imageEpoch &&
  a.recipeRevision === b.recipeRevision &&
  a.generation === b.generation &&
  a.resolution === b.resolution &&
  a.targetKey === b.targetKey;
const invalidate = (s: InfluenceState): InfluenceState => ({
  ...s,
  generation: s.generation + 1,
  request: null,
  result: null,
  status: s.target ? 'pending' : 'off',
});
export function reduceInfluenceState(state: InfluenceState, event: InfluenceEvent): InfluenceState {
  switch (event.type) {
    case 'activate':
      return invalidate({ ...state, target: event.target });
    case 'clear':
    case 'imageChanged':
      return {
        ...initialInfluenceState(),
        imageEpoch: state.imageEpoch + (event.type === 'imageChanged' ? 1 : 0),
        recipeRevision: state.recipeRevision,
        generation: state.generation + 1,
        interactions: state.interactions,
      };
    case 'recipeChanged':
      return invalidate({ ...state, recipeRevision: state.recipeRevision + 1 });
    case 'interaction': {
      const interactions = event.active
        ? [...new Set([...state.interactions, event.token])]
        : state.interactions.filter((t) => t !== event.token);
      return interactions.length === state.interactions.length ? state : invalidate({ ...state, interactions });
    }
    case 'request': {
      if (
        !state.target ||
        state.interactions.length ||
        state.status !== 'pending' ||
        !Number.isSafeInteger(event.resolution) ||
        event.resolution <= 0 ||
        event.resolution > 4096
      )
        return state;
      const request = {
        imageEpoch: state.imageEpoch,
        recipeRevision: state.recipeRevision,
        generation: state.generation + 1,
        resolution: event.resolution,
        targetKey: influenceTargetKey(state.target),
      };
      return { ...state, generation: request.generation, request, result: null };
    }
    case 'resolved':
      return !state.request || state.interactions.length || !sameInfluenceIdentity(state.request, event.identity)
        ? state
        : { ...state, status: 'ready', result: event.identity };
  }
}
