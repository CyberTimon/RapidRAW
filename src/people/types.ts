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
}
export interface PeopleScanProgress {
  running: boolean;
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
  | { type: 'rename'; id: string; name: string }
  | { type: 'merge'; ids: string[]; target: string }
  | { type: 'move'; faces: string[]; target: string | null }
  | { type: 'ignore'; faces: string[]; ignored: boolean }
  | { type: 'representative'; id: string; face: string };
