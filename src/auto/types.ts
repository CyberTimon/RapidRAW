export type Scene = 'daylight' | 'warmIndoor' | 'night' | 'mixed' | 'uncertain';
export interface Controls {
  strength: number;
  subjectBrightness: number;
  warmth: number;
  consistency: number;
}
export interface GroupOverride {
  scene?: Scene;
  controls?: Controls;
  referencePath?: string;
}
export interface AutoOptions {
  controls: Controls;
  skipEdited: boolean;
  groups: Record<string, GroupOverride>;
}
export interface LightingGroup {
  id: string;
  scene: Scene;
  confidence: number;
  paths: string[];
  target: number;
  warmth: number;
  tint: number;
}
export interface AutoProgress {
  id: string;
  batchId: string;
  phase: string;
  completed: number;
  total: number;
  running: boolean;
  cancelled: boolean;
  changed: string[];
  skipped: string[];
  failures: Record<string, string>;
  warnings: Record<string, string>;
  groups: LightingGroup[];
}
export const DEFAULT_CONTROLS: Controls = { strength: 1, subjectBrightness: 0, warmth: 0, consistency: 0.5 };
export const DEFAULT_OPTIONS: AutoOptions = { controls: DEFAULT_CONTROLS, skipEdited: true, groups: {} };
export const SCENES: Scene[] = ['daylight', 'warmIndoor', 'night', 'mixed', 'uncertain'];
export const CONTROL_SPECS = [
  { key: 'strength', min: 0, max: 1.5, step: 0.05 },
  { key: 'subjectBrightness', min: -1, max: 1, step: 0.05 },
  { key: 'warmth', min: -1, max: 1, step: 0.05 },
  { key: 'consistency', min: 0, max: 1, step: 0.05 },
] as const;
