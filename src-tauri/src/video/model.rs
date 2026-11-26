use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use serde::{Deserialize, Deserializer};
use serde_json::Value;

use crate::video::camera_log::CameraLog;
use crate::video::tracking::{Corners, MotionTrack, lenient_corners};

pub const TICKS_PER_SECOND: i64 = 705_600_000;
const MIN_SPEED: f64 = 0.1;
const MAX_SPEED: f64 = 16.0;

pub fn seconds(ticks: i64) -> f64 {
    ticks as f64 / TICKS_PER_SECOND as f64
}

pub fn clamp_speed(speed: f64) -> f64 {
    speed.clamp(MIN_SPEED, MAX_SPEED)
}

fn one() -> f64 {
    1.0
}

fn black() -> String {
    "#000000".to_string()
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameRate {
    pub num: i64,
    pub den: i64,
}

impl FrameRate {
    pub fn value(self) -> f64 {
        (self.num as f64 / self.den.max(1) as f64).clamp(1.0, 240.0)
    }

    pub fn frame_of(self, ticks: i64) -> i64 {
        let numerator = ticks as i128 * self.num.max(1) as i128;
        let denominator = TICKS_PER_SECOND as i128 * self.den.max(1) as i128;
        (numerator + denominator / 2).div_euclid(denominator) as i64
    }

    pub fn ticks_of(self, frame: i64) -> i64 {
        let numerator = frame as i128 * TICKS_PER_SECOND as i128 * self.den.max(1) as i128;
        let denominator = self.num.max(1) as i128;
        (numerator + denominator / 2).div_euclid(denominator) as i64
    }
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MediaKind {
    Video,
    Image,
    Audio,
    Sequence,
}

#[derive(Deserialize, Clone, Debug)]
pub struct MediaRef {
    pub id: String,
    pub path: String,
    pub kind: MediaKind,
    #[serde(default)]
    pub log: Option<CameraLog>,
    #[serde(default)]
    pub timelapse: Option<crate::video::timelapse::TimelapseSource>,
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash, Default)]
#[serde(rename_all = "camelCase")]
pub enum Ease {
    #[default]
    Linear,
    #[serde(rename = "ease")]
    Smooth,
    Hold,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Stabilize {
    #[serde(default)]
    pub strength: f64,
}

#[derive(Deserialize, Clone, Copy, Debug, Default, PartialEq)]
pub struct Equalizer {
    #[serde(default)]
    pub low: f64,
    #[serde(default)]
    pub mid: f64,
    #[serde(default)]
    pub high: f64,
}

#[derive(Deserialize, Clone, Copy, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Sound {
    #[serde(default)]
    pub eq: Option<Equalizer>,
    #[serde(default)]
    pub denoise: f64,
    #[serde(default)]
    pub low_cut: f64,
    #[serde(default)]
    pub high_cut: f64,
    #[serde(default)]
    pub compress: f64,
}

impl Ease {
    fn handle(self) -> [f64; 2] {
        match self {
            Ease::Smooth => [1.0 / 3.0, 0.0],
            _ => [1.0 / 3.0, 1.0 / 3.0],
        }
    }
}

const SOLVE_STEPS: usize = 32;

fn bezier_ease([x1, y1]: [f64; 2], [x2, y2]: [f64; 2], t: f64) -> f64 {
    let (x1, x2) = (x1.clamp(0.0, 1.0), x2.clamp(0.0, 1.0));
    let cx = 3.0 * x1;
    let bx = 3.0 * (x2 - x1) - cx;
    let ax = 1.0 - cx - bx;
    let cy = 3.0 * y1;
    let by = 3.0 * (y2 - y1) - cy;
    let ay = 1.0 - cy - by;
    let cubic = |a: f64, b: f64, c: f64, s: f64| ((a * s + b) * s + c) * s;
    let (mut low, mut high, mut s) = (0.0, 1.0, t);
    for _ in 0..SOLVE_STEPS {
        let error = cubic(ax, bx, cx, s) - t;
        if error.abs() < 1e-12 {
            break;
        }
        if error > 0.0 {
            high = s;
        } else {
            low = s;
        }
        let next = s - error / ((3.0 * ax * s + 2.0 * bx) * s + cx);
        s = if next > low && next < high {
            next
        } else {
            (low + high) / 2.0
        };
    }
    cubic(ay, by, cy, s)
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Keyframe {
    pub time: i64,
    pub value: f64,
    #[serde(default)]
    pub ease: Ease,
    #[serde(default, rename = "in")]
    pub handle_in: Option<[f64; 2]>,
    #[serde(default, rename = "out")]
    pub handle_out: Option<[f64; 2]>,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct Animated {
    pub value: f64,
    #[serde(default)]
    pub keys: Vec<Keyframe>,
}

impl Animated {
    pub fn at(&self, local: i64) -> f64 {
        let (Some(first), Some(last)) = (self.keys.first(), self.keys.last()) else {
            return self.value;
        };
        if local <= first.time {
            return first.value;
        }
        if local >= last.time {
            return last.value;
        }
        let next = self
            .keys
            .iter()
            .position(|key| key.time > local)
            .unwrap_or(0);
        let (from, to) = (&self.keys[next - 1], &self.keys[next]);
        let t = (local - from.time) as f64 / (to.time - from.time).max(1) as f64;
        let eased = match (from.ease, from.handle_out, to.handle_in) {
            (Ease::Hold, _, _) => 0.0,
            (Ease::Linear, None, None) => t,
            (Ease::Smooth, None, None) => t * t * (3.0 - 2.0 * t),
            (ease, out, into) => {
                let [ix, iy] = into.unwrap_or(ease.handle());
                bezier_ease(out.unwrap_or(ease.handle()), [1.0 - ix, 1.0 - iy], t)
            }
        };
        from.value + (to.value - from.value) * eased
    }

    pub fn is_animated(&self) -> bool {
        !self.keys.is_empty()
    }
}

fn unit() -> Animated {
    Animated {
        value: 1.0,
        keys: Vec::new(),
    }
}

fn lenient_track<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<MotionTrack>, D::Error> {
    Ok(MotionTrack::deserialize(Value::deserialize(deserializer)?).ok())
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Transform {
    #[serde(default)]
    pub x: Animated,
    #[serde(default)]
    pub y: Animated,
    #[serde(default = "unit")]
    pub scale: Animated,
    #[serde(default)]
    pub rotation: Animated,
    #[serde(default = "unit")]
    pub opacity: Animated,
    #[serde(default)]
    pub radius: Animated,
    #[serde(default)]
    pub flip_h: bool,
    #[serde(default)]
    pub flip_v: bool,
    #[serde(default, deserialize_with = "lenient_track")]
    pub track: Option<MotionTrack>,
    #[serde(default, deserialize_with = "lenient_corners")]
    pub pin: Option<Corners>,
}

impl Default for Transform {
    fn default() -> Self {
        Self {
            x: Animated::default(),
            y: Animated::default(),
            scale: unit(),
            rotation: Animated::default(),
            opacity: unit(),
            radius: Animated::default(),
            flip_h: false,
            flip_v: false,
            track: None,
            pin: None,
        }
    }
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransitionKind {
    Dissolve,
    Wipe,
    Push,
    Slide,
    Zoom,
    Blur,
    DipToBlack,
    DipToWhite,
    Iris,
    Whip,
    Spin,
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    #[default]
    Left,
    Right,
    Up,
    Down,
}

impl Direction {
    pub fn axis(self) -> [f32; 2] {
        match self {
            Direction::Left => [-1.0, 0.0],
            Direction::Right => [1.0, 0.0],
            Direction::Up => [0.0, -1.0],
            Direction::Down => [0.0, 1.0],
        }
    }
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MotionKind {
    Fade,
    Slide,
    Zoom,
    Pop,
    Blur,
    Wipe,
    Spin,
    Typewriter,
    Words,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Motion {
    pub kind: MotionKind,
    #[serde(default)]
    pub direction: Option<Direction>,
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MatteKind {
    Alpha,
    Luma,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct TrackMatte {
    pub kind: MatteKind,
    #[serde(default)]
    pub invert: bool,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct MotionBlur {
    pub shutter: f64,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Transition {
    pub kind: TransitionKind,
    #[serde(default)]
    pub direction: Option<Direction>,
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum FitMode {
    #[default]
    Fit,
    Fill,
    Blur,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClipItem {
    pub id: String,
    pub start: i64,
    pub duration: i64,
    #[serde(default)]
    pub fade_in: i64,
    #[serde(default)]
    pub fade_out: i64,
    pub media: String,
    #[serde(default)]
    pub source_in: i64,
    #[serde(default = "one")]
    pub speed: f64,
    #[serde(default = "unit")]
    pub volume: Animated,
    #[serde(default)]
    pub muted: bool,
    #[serde(flatten)]
    pub sound: Sound,
    #[serde(default)]
    pub look: Option<String>,
    #[serde(default)]
    pub transform: Transform,
    #[serde(default)]
    pub fit: FitMode,
    #[serde(default)]
    pub cell_aspect: Option<f64>,
    #[serde(default)]
    pub blend: Option<String>,
    #[serde(default)]
    pub track_matte: Option<TrackMatte>,
    #[serde(default)]
    pub transition_in: Option<Transition>,
    #[serde(default)]
    pub anim_in: Option<Motion>,
    #[serde(default)]
    pub anim_out: Option<Motion>,
    #[serde(default)]
    pub stabilize: Option<Stabilize>,
    #[serde(default)]
    pub speed_ramp: Option<Vec<Keyframe>>,
    #[serde(default)]
    pub interpolation: Option<String>,
    #[serde(default)]
    pub freeze: bool,
    #[serde(default)]
    pub reverse: bool,
}

impl ClipItem {
    pub fn speed(&self) -> f64 {
        clamp_speed(self.speed)
    }

    pub fn ramp(&self) -> Option<&[Keyframe]> {
        self.speed_ramp
            .as_deref()
            .filter(|keys| !keys.is_empty() && !self.freeze)
    }

    pub fn pace(&self) -> Pace<'_> {
        Pace::of(self.speed, self.ramp())
    }
}

pub enum Pace<'a> {
    Constant(f64),
    Ramp(&'a [Keyframe]),
}

impl<'a> Pace<'a> {
    fn of(speed: f64, ramp: Option<&'a [Keyframe]>) -> Self {
        match ramp {
            Some(keys) if keys.iter().any(|key| key.value != keys[0].value) => Self::Ramp(keys),
            Some([first, ..]) => Self::Constant(clamp_speed(first.value)),
            _ => Self::Constant(clamp_speed(speed)),
        }
    }
}

pub fn ramp_offsets(duration: i64, keys: &[Keyframe], fps: FrameRate) -> Vec<f64> {
    let speed = Animated {
        value: 1.0,
        keys: keys.to_vec(),
    };
    let frames = fps.frame_of(duration).max(1);
    let frame_seconds = 1.0 / fps.value();
    let mut total = 0.0;
    (0..=frames)
        .map(|index| {
            let current = total;
            total += clamp_speed(speed.at(fps.ticks_of(index))) * frame_seconds;
            current
        })
        .collect()
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TitleItem {
    pub id: String,
    pub start: i64,
    pub duration: i64,
    #[serde(default)]
    pub fade_in: i64,
    #[serde(default)]
    pub fade_out: i64,
    #[serde(default)]
    pub transform: Transform,
    #[serde(default)]
    pub blend: Option<String>,
    #[serde(default)]
    pub track_matte: Option<TrackMatte>,
    #[serde(default)]
    pub motion_blur: Option<MotionBlur>,
    #[serde(default)]
    pub anim_in: Option<Motion>,
    #[serde(default)]
    pub anim_out: Option<Motion>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AdjustmentItem {
    pub id: String,
    pub start: i64,
    pub duration: i64,
    #[serde(default)]
    pub fade_in: i64,
    #[serde(default)]
    pub fade_out: i64,
    #[serde(default)]
    pub look: Option<String>,
    #[serde(default = "unit")]
    pub opacity: Animated,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SolidItem {
    #[serde(default)]
    pub id: String,
    pub start: i64,
    pub duration: i64,
    #[serde(default)]
    pub fade_in: i64,
    #[serde(default)]
    pub fade_out: i64,
    #[serde(default = "black")]
    pub color: String,
    #[serde(default)]
    pub transform: Transform,
    #[serde(default)]
    pub cell_aspect: Option<f64>,
    #[serde(default)]
    pub blend: Option<String>,
    #[serde(default)]
    pub track_matte: Option<TrackMatte>,
    #[serde(default)]
    pub motion_blur: Option<MotionBlur>,
    #[serde(default)]
    pub anim_in: Option<Motion>,
    #[serde(default)]
    pub anim_out: Option<Motion>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioItem {
    #[serde(default)]
    pub id: String,
    pub start: i64,
    pub duration: i64,
    #[serde(default)]
    pub fade_in: i64,
    #[serde(default)]
    pub fade_out: i64,
    #[serde(default)]
    pub crossfade: i64,
    pub media: String,
    #[serde(default)]
    pub source_in: i64,
    #[serde(default = "one")]
    pub speed: f64,
    #[serde(default = "unit")]
    pub volume: Animated,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub reverse: bool,
    #[serde(default)]
    pub speed_ramp: Option<Vec<Keyframe>>,
    #[serde(default)]
    pub duck: Option<f64>,
    #[serde(flatten)]
    pub sound: Sound,
}

impl AudioItem {
    pub fn pace(&self) -> Pace<'_> {
        Pace::of(self.speed, self.speed_ramp.as_deref())
    }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Item {
    Clip(Box<ClipItem>),
    Title(TitleItem),
    Adjustment(AdjustmentItem),
    Solid(SolidItem),
    Audio(AudioItem),
}

impl Item {
    pub fn id(&self) -> &str {
        match self {
            Self::Clip(item) => &item.id,
            Self::Title(item) => &item.id,
            Self::Adjustment(item) => &item.id,
            Self::Solid(item) => &item.id,
            Self::Audio(item) => &item.id,
        }
    }

    pub fn span(&self) -> (i64, i64) {
        let (start, duration) = match self {
            Self::Clip(item) => (item.start, item.duration),
            Self::Title(item) => (item.start, item.duration),
            Self::Adjustment(item) => (item.start, item.duration),
            Self::Solid(item) => (item.start, item.duration),
            Self::Audio(item) => (item.start, item.duration),
        };
        (start, start + duration)
    }
}

#[derive(Deserialize, Clone, Debug)]
pub struct Track {
    #[serde(default)]
    pub items: Vec<Item>,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default = "one")]
    pub volume: f64,
    #[serde(default)]
    pub pan: f64,
    #[serde(default)]
    pub solo: bool,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    pub width: u32,
    pub height: u32,
    pub fps: FrameRate,
    #[serde(default = "black")]
    pub background: String,
    #[serde(default)]
    pub interpolation: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Caption {
    pub id: String,
    pub start: i64,
    pub duration: i64,
}

fn caption_y() -> f64 {
    0.4
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CaptionStyle {
    #[serde(default = "caption_y")]
    pub y: f64,
}

impl Default for CaptionStyle {
    fn default() -> Self {
        Self { y: caption_y() }
    }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Captions {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub style: CaptionStyle,
    #[serde(default)]
    pub items: Vec<Caption>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Sequence {
    #[serde(default)]
    pub video_tracks: Vec<Track>,
    #[serde(default)]
    pub audio_tracks: Vec<Track>,
}

#[derive(Debug, Default)]
struct LookData {
    json: Value,
    hash: OnceLock<u64>,
}

#[derive(Clone, Debug, Default)]
pub struct LookJson(Arc<LookData>);

impl LookJson {
    pub fn json(&self) -> &Value {
        &self.0.json
    }

    pub fn hash(&self) -> u64 {
        *self
            .0
            .hash
            .get_or_init(|| crate::video::hash_of(self.0.json.to_string()))
    }
}

impl<'de> Deserialize<'de> for LookJson {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Value::deserialize(deserializer).map(|json| {
            Self(Arc::new(LookData {
                json,
                hash: OnceLock::new(),
            }))
        })
    }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VideoProject {
    pub settings: ProjectSettings,
    #[serde(default)]
    pub media: Vec<MediaRef>,
    #[serde(default)]
    pub looks: HashMap<String, LookJson>,
    #[serde(default)]
    pub video_tracks: Vec<Track>,
    #[serde(default)]
    pub audio_tracks: Vec<Track>,
    #[serde(default)]
    pub captions: Option<Captions>,
    #[serde(default = "one")]
    pub master_volume: f64,
    #[serde(default)]
    pub sequences: HashMap<String, Sequence>,
}

impl VideoProject {
    pub fn fps(&self) -> f64 {
        self.settings.fps.value()
    }

    pub fn media_ref(&self, id: &str) -> Option<&MediaRef> {
        self.media.iter().find(|media| media.id == id)
    }

    pub fn media_path(&self, id: &str) -> Option<(&str, MediaKind)> {
        self.media_ref(id)
            .map(|media| (media.path.as_str(), media.kind))
    }

    pub fn items(&self) -> impl Iterator<Item = &Item> {
        self.video_tracks
            .iter()
            .chain(&self.audio_tracks)
            .chain(
                self.sequences.values().flat_map(|sequence| {
                    sequence.video_tracks.iter().chain(&sequence.audio_tracks)
                }),
            )
            .flat_map(|track| &track.items)
    }

    pub fn sequence_audio(&self, id: &str) -> Option<VideoProject> {
        let sequence = self.sequences.get(id)?;
        let mut sequences = self.sequences.clone();
        sequences.remove(id);
        Some(VideoProject {
            settings: self.settings.clone(),
            media: self.media.clone(),
            looks: HashMap::new(),
            video_tracks: sequence.video_tracks.clone(),
            audio_tracks: sequence.audio_tracks.clone(),
            captions: None,
            master_volume: 1.0,
            sequences,
        })
    }

    pub fn solo_audio(&self, id: &str) -> VideoProject {
        let solo = |track: &Track| {
            let holds = track.items.iter().any(|item| item.id() == id);
            let silenced = |item: &Item| {
                let mut item = item.clone();
                match &mut item {
                    Item::Clip(clip) if clip.id != id => clip.muted = true,
                    Item::Audio(audio) if audio.id != id => audio.muted = true,
                    _ => {}
                }
                item
            };
            Track {
                items: if holds {
                    track.items.iter().map(silenced).collect()
                } else {
                    Vec::new()
                },
                muted: track.muted && !holds,
                hidden: track.hidden,
                volume: if holds { 1.0 } else { track.volume },
                pan: if holds { 0.0 } else { track.pan },
                solo: false,
            }
        };
        VideoProject {
            settings: self.settings.clone(),
            media: self.media.clone(),
            looks: HashMap::new(),
            video_tracks: self.video_tracks.iter().map(solo).collect(),
            audio_tracks: self.audio_tracks.iter().map(solo).collect(),
            captions: None,
            master_volume: 1.0,
            sequences: self.sequences.clone(),
        }
    }

    pub fn frame_of(&self, ticks: i64) -> u64 {
        self.settings.fps.frame_of(ticks).max(0) as u64
    }

    pub fn end_ticks(&self) -> i64 {
        let items = self
            .video_tracks
            .iter()
            .chain(&self.audio_tracks)
            .flat_map(|track| &track.items)
            .map(|item| item.span().1);
        let captions = self
            .captions
            .iter()
            .filter(|captions| captions.enabled)
            .flat_map(|captions| &captions.items)
            .map(|caption| caption.start + caption.duration);
        items.chain(captions).max().unwrap_or(0)
    }

    pub fn frame_count(&self) -> u64 {
        self.frame_of(self.end_ticks())
    }

    pub fn frame_at(&self, seconds: f64) -> u64 {
        (seconds.max(0.0) * self.fps()).round() as u64
    }

    pub fn frame_range(&self, start: f64, end: f64) -> (u64, u64) {
        (
            self.frame_at(start),
            self.frame_at(end).min(self.frame_count()),
        )
    }
}
