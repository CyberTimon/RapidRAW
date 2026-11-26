import type { Adjustments } from '../utils/adjustments';
import type { Homography } from '../utils/video/planar';
import type { ImmichMediaRef } from '../utils/immichApi';
import type { SortDirection } from './library';

export const PROJECT_SCHEMA = 'rapidraw.video';
export const PROJECT_VERSION = 2;
export const PROJECT_EXTENSION = 'rrproj';
export const TICKS_PER_SECOND = 705_600_000;

export type Ticks = number;

export interface FrameRate {
  num: number;
  den: number;
}

export type MediaKind = 'video' | 'image' | 'audio' | 'sequence';

export const CAMERA_LOGS = [
  'sLog3Cine',
  'sLog3',
  'sLog2',
  'vLog',
  'cLog3',
  'logC3',
  'logC4',
  'fLog2',
  'nLog',
  'appleLog',
  'dLog',
  'dLogM',
] as const;

export type CameraLog = (typeof CAMERA_LOGS)[number];

export interface TimelapseSource {
  frames: Array<string>;
  fps: FrameRate;
  deflicker: boolean;
  size: [number, number];
}

export interface MediaRef {
  id: string;
  path: string;
  kind: MediaKind;
  log?: CameraLog | null;
  name?: string;
  timelapse?: TimelapseSource;
  range?: TimeRange;
  immich?: ImmichMediaRef;
  bin?: string | null;
}

export interface MediaBin {
  id: string;
  name: string;
  parent: string | null;
}

export type MediaPoolSort = 'imported' | 'name' | 'date' | 'duration' | 'type';
export type MediaPoolGroup = 'none' | 'type' | 'folder';
export type MediaPoolTileSize = 'small' | 'medium' | 'large';

export interface MediaPoolView {
  sort: MediaPoolSort;
  order: SortDirection;
  group: MediaPoolGroup;
  size: MediaPoolTileSize;
}

export type MediaOrigin = Pick<MediaRef, 'log' | 'immich'>;

export type Ease = 'linear' | 'ease' | 'hold';

export type Handle = [number, number];

export interface Keyframe {
  time: Ticks;
  value: number;
  ease: Ease;
  in?: Handle;
  out?: Handle;
}

export interface Animated {
  value: number;
  keys?: Array<Keyframe>;
}

export type Quad = [[number, number], [number, number], [number, number], [number, number]];

export interface TrackKey {
  time: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  corners?: Quad;
}

export interface TrackAnchor {
  clip: string;
  media: string;
  canvas: Homography;
}

export interface MotionTrack {
  keys: Array<TrackKey>;
  reference?: TrackKey | null;
  reframe?: boolean;
  positionOnly?: boolean;
  anchor?: TrackAnchor | null;
}

export interface Transform {
  x: Animated;
  y: Animated;
  scale: Animated;
  rotation: Animated;
  opacity: Animated;
  radius: Animated;
  flipH: boolean;
  flipV: boolean;
  track?: MotionTrack | null;
  pin?: Quad | null;
}

export type BlendMode =
  'normal' | 'multiply' | 'screen' | 'overlay' | 'softLight' | 'add' | 'difference' | 'darken' | 'lighten';

export type FitMode = 'fit' | 'fill' | 'blur';

export type TransitionKind =
  'dissolve' | 'wipe' | 'push' | 'slide' | 'zoom' | 'blur' | 'dipToBlack' | 'dipToWhite' | 'iris' | 'whip' | 'spin';

export type Direction = 'left' | 'right' | 'up' | 'down';

export type MotionKind = 'fade' | 'slide' | 'zoom' | 'pop' | 'blur' | 'wipe' | 'spin' | 'typewriter' | 'words';

export interface Motion {
  kind: MotionKind;
  direction?: Direction;
}

interface Animations {
  animIn?: Motion | null;
  animOut?: Motion | null;
}

export type MatteKind = 'alpha' | 'luma';

export interface TrackMatte {
  kind: MatteKind;
  invert: boolean;
}

interface Layering {
  trackMatte?: TrackMatte | null;
}

interface LayerMotionBlur {
  motionBlur?: { shutter: number } | null;
}

export interface Transition {
  kind: TransitionKind;
  duration: Ticks;
  direction?: Direction;
}

export type TitleAlign = 'left' | 'center' | 'right';

interface ItemBase {
  id: string;
  start: Ticks;
  duration: Ticks;
  fadeIn: Ticks;
  fadeOut: Ticks;
  link?: string;
}

export interface Equalizer {
  low: number;
  mid: number;
  high: number;
}

interface AudioProcessing {
  eq?: Equalizer | null;
  denoise?: number;
  lowCut?: number;
  highCut?: number;
  compress?: number;
}

export interface ClipItem extends ItemBase, Animations, Layering, AudioProcessing {
  type: 'clip';
  media: string;
  sourceIn: Ticks;
  speed: number;
  volume: Animated;
  muted: boolean;
  look: string | null;
  transform: Transform;
  fit: FitMode;
  cellAspect?: number;
  blend: BlendMode;
  transitionIn: Transition | null;
  stabilize?: { strength: number } | null;
  speedRamp?: Array<Keyframe> | null;
  gap?: Ticks;
  interpolation?: Interpolation;
  freeze?: boolean;
  reverse?: boolean;
}

export interface TitleItem extends ItemBase, Animations, Layering, LayerMotionBlur {
  type: 'title';
  text: string;
  font: string | null;
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  align: TitleAlign;
  backdrop: boolean;
  outline?: number;
  outlineColor?: string;
  shadow?: number;
  letterSpacing?: number;
  lineHeight?: number;
  wrapWidth?: number;
  transform: Transform;
  blend: BlendMode;
}

export interface AdjustmentItem extends ItemBase {
  type: 'adjustment';
  look: string | null;
  opacity: Animated;
}

export interface SolidItem extends ItemBase, Animations, Layering, LayerMotionBlur {
  type: 'solid';
  color: string;
  transform: Transform;
  cellAspect?: number;
  blend: BlendMode;
}

export interface AudioItem extends ItemBase, AudioProcessing {
  type: 'audio';
  media: string;
  sourceIn: Ticks;
  speed: number;
  volume: Animated;
  muted: boolean;
  beats?: boolean;
  crossfade?: Ticks;
  reverse?: boolean;
  speedRamp?: Array<Keyframe> | null;
  duck?: number | null;
}

export type VisualItem = ClipItem | TitleItem | AdjustmentItem | SolidItem;
export type TimelineItem = VisualItem | AudioItem;

export interface Track<T extends TimelineItem> {
  id: string;
  items: Array<T>;
  muted: boolean;
  hidden: boolean;
  locked: boolean;
  volume?: number;
  pan?: number;
  solo?: boolean;
  height?: number;
}

export type VideoTrack = Track<VisualItem>;
export type AudioTrack = Track<AudioItem>;
export type TrackKind = 'video' | 'audio';

export type Interpolation = 'none' | 'blend' | 'flow';

export interface ProjectSettings {
  width: number;
  height: number;
  fps: FrameRate;
  background: string;
  sampleRate: number;
  interpolation?: Interpolation;
}

export interface Marker {
  id: string;
  time: Ticks;
  label: string;
  color?: string;
}

export interface TimeRange {
  start: Ticks;
  end: Ticks;
}

export interface BeatAnalysis {
  tempo: number;
  beats: Array<number>;
  downbeats: Array<number>;
}

export interface CaptionStyle {
  size: number;
  font?: string | null;
  color: string;
  bold: boolean;
  backdrop: boolean;
  y: number;
}

export interface Caption {
  id: string;
  start: Ticks;
  duration: Ticks;
  text: string;
}

export interface Captions {
  enabled: boolean;
  style: CaptionStyle;
  items: Array<Caption>;
}

export interface VideoProject {
  schema: typeof PROJECT_SCHEMA;
  version: number;
  id: string;
  name: string;
  settings: ProjectSettings;
  media: Array<MediaRef>;
  bins?: Array<MediaBin>;
  looks: Record<string, Adjustments>;
  videoTracks: Array<VideoTrack>;
  audioTracks: Array<AudioTrack>;
  markers: Array<Marker>;
  captions: Captions | null;
  range?: TimeRange | null;
  masterVolume?: number;
  modified: number;
  sequences?: Record<string, Sequence>;
  open?: Array<string>;
}

export interface Sequence {
  videoTracks: Array<VideoTrack>;
  audioTracks: Array<AudioTrack>;
  markers: Array<Marker>;
  captions: Captions | null;
  range?: TimeRange | null;
}

export interface MediaInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  variableFrameRate?: boolean;
  hasVideo: boolean;
  hasAudio: boolean;
  codec: string | null;
  audioCodec: string | null;
  bitRate: number | null;
  hdr: boolean;
  isStill: boolean;
  isRaw: boolean;
  detectedLog?: CameraLog;
  captured?: string;
}

export interface RecentProject {
  path: string;
  name: string;
  modified: number;
  cover: string | null;
  missing: boolean;
}

export interface ClipSettings {
  in: number;
  out: number | null;
  poster: number | null;
  muted: boolean;
}

export type VideoCodec = 'h264' | 'hevc' | 'av1' | 'proRes' | 'vp9';
export type VideoContainer = 'mp4' | 'mov' | 'mkv' | 'webm';
export type AudioCodec = 'aac' | 'opus' | 'pcm';
export type VideoQuality = 'high' | 'medium' | 'low';
export type RateControl = 'quality' | 'bitrate';
export type DynamicRange = 'sdr' | 'hlg' | 'pq';
export type VideoResolution = 'original' | '2160' | '1440' | '1080' | '720' | 'custom';
export type LoudnessTarget = 'off' | 'streaming' | 'podcast' | 'broadcast';
export type VideoExportPreset =
  'custom' | 'youtube' | 'youtubeShorts' | 'instagramReels' | 'instagramPost' | 'tiktok' | 'archive';

export interface VideoExportSettings {
  preset: VideoExportPreset;
  codec: VideoCodec;
  container: VideoContainer;
  rateControl: RateControl;
  quality: VideoQuality;
  bitrate: number;
  resolution: VideoResolution;
  width: number;
  height: number;
  lockAspect: boolean;
  frameRate: string;
  audioCodec: AudioCodec;
  audioBitrate: number;
  dynamicRange: DynamicRange;
  loudness: LoudnessTarget;
}

export interface EncoderInfo {
  codec: VideoCodec;
  encoder: string;
  hardware: boolean;
  tenBit: boolean;
}

export type PlaybackEvent =
  | { type: 'clip'; itemId: string; time: number }
  | { type: 'started'; time: number }
  | { type: 'looped'; time: number }
  | { type: 'ended'; time: number }
  | { type: 'error'; message: string };
