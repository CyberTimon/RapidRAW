export interface PersonSummary {
  id: string;
  name: string | null;
  representativeFace: string;
  photoCount: number;
}
export interface FaceRecord {
  id: string;
  path: string;
  personId: string;
  bounds: [number, number, number, number];
  landmarks: [number, number][];
  confidence: number;
  quality: number;
  ignored: boolean;
}
export interface PeopleScanScope {
  paths: string[];
  recursive?: boolean;
  force?: boolean;
  detailed?: boolean;
}
export interface PeopleScanProgress {
  running: boolean;
  stage: string;
  elapsedMs: number;
  total: number;
  processed: number;
  skipped: number;
  failed: number;
  detectedFaces: number;
  cancelled: boolean;
  error: string | null;
}
export type PeopleScanResult = PeopleScanProgress;
export type PeopleMutation =
  | { type: 'reject'; a: string; b: string }
  | { type: 'rename'; id: string; name: string }
  | { type: 'merge'; ids: string[]; target: string }
  | { type: 'move'; faces: string[]; target: string | null }
  | { type: 'ignore'; faces: string[]; ignored: boolean }
  | { type: 'representative'; id: string; face: string };

export interface MatchSuggestion {
  a: string;
  b: string;
  score: number;
}
export interface PeopleExportReport {
  copied: number;
  failed: string[];
  cancelled: boolean;
}
export interface PersonShortcut {
  shortcut: string;
  personId: string;
}
