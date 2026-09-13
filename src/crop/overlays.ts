export const OVERLAY_MODES = [
  'none',
  'thirds',
  'diagonal',
  'goldenTriangle',
  'goldenSpiral',
  'phiGrid',
  'armature',
] as const;
export type OverlayMode = (typeof OVERLAY_MODES)[number];
