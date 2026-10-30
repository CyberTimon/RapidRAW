import { createContext, useContext } from 'react';
import type { InfluenceScope } from '../utils/influencePreview';

export interface InfluencePreviewOwner {
  ownerId: string;
  scope: InfluenceScope;
}

/** Panels must provide explicit ownership; an active mask alone does not imply scope. */
export const InfluencePreviewContext = createContext<InfluencePreviewOwner | null>(null);

export const useInfluencePreviewOwner = () => useContext(InfluencePreviewContext);
