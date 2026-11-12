import type { ActiveChannel, Adjustments } from '../utils/adjustments';
import type { WhiteBalance } from '../utils/whiteBalance';
import type { Folder } from './library';
import type { ToolType } from './masks';

export interface BrushSettings {
  feather: number;
  size: number;
  tool: ToolType;
}

export interface Preset {
  adjustments: Partial<Adjustments>;
  folder?: Folder;
  id: string;
  name: string;
  includeMasks?: boolean;
  includeCropTransform?: boolean;
  presetType?: 'tool' | 'style';
}

export interface SelectedImage {
  asShotWhiteBalance?: WhiteBalance;
  exif: any;
  group_id?: string | null;
  height: number;
  isRaw: boolean;
  isReady: boolean;
  metadata?: any;
  original_base64?: string;
  path: string;
  thumbnailUrl: string;
  width: number;
}

export interface TransformState {
  positionX: number;
  positionY: number;
  scale: number;
}

export interface WaveformData {
  height: number;
  luma: ImageBitmap | null;
  rgb: ImageBitmap | null;
  parade: ImageBitmap | null;
  vectorscope: ImageBitmap | null;
  width: number;
}

export interface ChannelConfig {
  [index: string]: ColorData;
  [ActiveChannel.Luma]: ColorData;
  [ActiveChannel.Red]: ColorData;
  [ActiveChannel.Green]: ColorData;
  [ActiveChannel.Blue]: ColorData;
}

interface ColorData {
  color: string;
  data: any;
}

export type OverlayMode =
  'none' | 'thirds' | 'goldenTriangle' | 'goldenSpiral' | 'phiGrid' | 'armature' | 'diagonal' | 'center';

export interface SpeedEditTarget {
  label: string | null;
  value: number;
  defaultValue: number;
  step: number;
  minPosition: number;
  maxPosition: number;
  format(value: number): string;
  toPosition(value: number): number;
  toValue(position: number): number;
  onChange(value: number): void;
  onDragStateChange(state: boolean): void;
}
