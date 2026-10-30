import { useEffect } from 'react';
import { useInfluencePreviewOwner } from '../context/InfluencePreviewContext';
import { useInfluencePreviewStore } from '../store/useInfluencePreviewStore';
import { altPreviewTarget } from '../utils/altPreviewTarget';
import { altPreviewPolicy } from '../utils/altPreviewPolicy';

export function useInfluenceSelection() {
  const context = useInfluencePreviewOwner();
  return (control?: string, alt = false) => {
    const store = useInfluencePreviewStore.getState();
    const owner = context?.ownerId ?? 'global';
    const scope = context?.scope ?? { kind: 'global' as const };
    const target = altPreviewTarget(control, scope, owner, store.subcontrols);
    store.beginDrag(target, alt, target ? altPreviewPolicy(target, control) : 0, control);
  };
}
export function useInfluenceSubcontrol(tool: string, key: string) {
  const context = useInfluencePreviewOwner();
  useEffect(() => {
    useInfluencePreviewStore.getState().rememberSubcontrol((context?.ownerId ?? 'global') + ':' + tool, key);
  }, [tool, key, context?.ownerId]);
}
