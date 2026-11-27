pub mod decode;
pub mod flow;
pub mod look;
pub mod motion;
pub mod range_masks;
pub mod shutter;
pub mod titles;
pub mod transparency;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use image::{DynamicImage, GenericImageView};
use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::app::settings::{AppSettings, load_settings};
use crate::app::state::AppState;
use crate::decode::formats::is_raw_file;
use crate::effects::motion_blur::{self, MotionBlurPipelines};
use crate::library::sidecars::parse_virtual_path;
use crate::render::color_space::OutputColorSpace;
use crate::render::gpu::compute::{self, Slot};
use crate::render::gpu::context::{GpuContext, get_or_init_gpu_context};
use crate::render::gpu::processor::RenderOutputPrecision;
use crate::render::hdr::Headroom;
use crate::render::image_processing::downscale_f32_image;
use crate::render::options::{RenderOptions, resolve_render_options};
use crate::render::source::{Frame, SourceTransform};
use crate::video::compose::{self, BlendMode, LayerPass, Placement, TextEdge};
use crate::video::geometry::{
    ClipGeometry, ClipSpace, FollowView, FrameGeometry, Framing, IDENTITY, affine, cell_crop,
    oriented, scaling, shift, stabilizing,
};
use crate::video::model::{
    Animated, Captions, ClipItem, FitMode, FrameRate, Item, Keyframe, LookJson, MatteKind,
    MediaKind, MediaRef, MotionBlur, TICKS_PER_SECOND, Track, TrackMatte, Transform, Transition,
    VideoProject, ramp_offsets, seconds,
};
use crate::video::stabilization::{self, ClipStabilization, MAX_ZOOM, MotionAnalysis};
use crate::video::tracking::{Anchor, Corners, Follow, MotionTrack, pin_corners, pin_extent};
use crate::video::vision::Homography;
use crate::video::vision::Similarity;
use crate::video::{ffmpeg, hash_of, proxy, reverse, timelapse};
use decode::{
    Bracket, Decoders, FramePlan, Neighbour, Neighbours, PREEMPTED, Picture, SOURCE_REACH,
    StreamRequest,
};
use flow::{FlowCache, Interpolation};
use look::{Look, LookTarget, MaskCache, has_cutout, render_look};
use motion::{MotionSpan, MotionState};
use shutter::{ShutterInput, Steady};
use titles::TitleStore;
use transparency::transparent_still;

const MEMORY_SHARE: u64 = 8;
const MIN_CACHE_BYTES: u64 = 128 << 20;
const MAX_CACHE_BYTES: u64 = 1 << 30;
const LAYERS_PER_ITEM: usize = 2;
const ANALYSIS_RETRY: Duration = Duration::from_secs(1);
const MAX_NESTING: usize = 8;
const RATE_TOLERANCE: f64 = 0.01;

#[derive(Clone, Copy)]
struct SourceTiming {
    index: u64,
    speed: f64,
    advance: f64,
    offset: f64,
    span: f64,
    ramped: bool,
}

impl SourceTiming {
    fn anchor(self, base: f64, fps: f64) -> Self {
        if !self.ramped {
            return self;
        }
        let time = seconds(((base + self.offset) * TICKS_PER_SECOND as f64).round() as i64);
        let absolute = (time * fps).round().max(0.0);
        Self {
            index: absolute as u64,
            offset: absolute / fps - base,
            ..self
        }
    }

    fn ramped(offsets: &[f64], local_frame: u64, fps: f64) -> Self {
        let at = (local_frame as usize).min(offsets.len().saturating_sub(2));
        SourceTiming {
            index: local_frame,
            speed: 1.0,
            advance: offsets
                .get(at + 1)
                .zip(offsets.get(at))
                .map_or(1.0 / fps, |(next, current)| next - current),
            offset: offsets
                .get(local_frame as usize)
                .or(offsets.last())
                .copied()
                .unwrap_or(0.0),
            span: offsets.last().copied().unwrap_or(0.0),
            ramped: true,
        }
    }

    fn sample(&self, source_fps: f64, interpolation: Option<Interpolation>) -> Sample {
        match interpolation {
            Some(mode) if self.advance * source_fps < 1.0 - RATE_TOLERANCE => Sample::Between(mode),
            _ if self.ramped && source_fps > 0.0 => Sample::Nearest,
            _ => Sample::Speed,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Hash)]
enum Sample {
    Speed,
    Nearest,
    Between(Interpolation),
}

struct ClipBasis {
    path: String,
    kind: MediaKind,
    reference: Option<String>,
    full: (u32, u32),
    look: Option<Arc<Look>>,
    decode: (u32, u32),
    stabilizing: bool,
    local: i64,
    local_frame: u64,
    timeline_frame: u64,
}

struct VideoClock {
    source: PathBuf,
    reversed: bool,
    decode_path: PathBuf,
    info: ffmpeg::MediaInfo,
    first: f64,
    exact: f64,
    timing: SourceTiming,
    shown: f64,
    sample: Sample,
    interpolation: Option<Interpolation>,
    mirrored: Option<f64>,
    stabilization: Option<Arc<ClipStabilization>>,
}

impl VideoClock {
    fn original(&self, decoded: f64) -> f64 {
        match self.mirrored {
            Some(frame) => self.info.duration - decoded - frame,
            None => decoded,
        }
    }

    fn requested(&self) -> f64 {
        match self.sample {
            Sample::Between(_) => self.exact,
            _ => self.first + self.timing.offset,
        }
    }

    fn correction(&self, decoded: f64) -> Option<Similarity> {
        let stabilization = self.stabilization.as_ref()?;
        let time = self.original(decoded);
        match self.sample {
            Sample::Between(_) => stabilization.at(time),
            _ => stabilization.frame_at(time),
        }
    }

    fn steady(&self, decoded: f64, around: &Neighbours, full: (u32, u32)) -> Option<Steady> {
        let stabilization = self.stabilization.as_ref()?;
        let centre = stabilizing(&self.correction(decoded)?, full).inverse()?;
        let toward = |neighbour: Option<&Neighbour>, sign: f64| {
            let neighbour = neighbour?;
            let at = stabilization.frame_at(self.original(decoded + sign * neighbour.gap))?;
            Some(stabilizing(&at, full).then(&centre))
        };
        Some(Steady {
            ahead: toward(around.next.as_ref(), 1.0),
            behind: toward(around.previous.as_ref(), -1.0),
        })
    }
}

fn look_frame(look: Option<&Look>, time: Option<f64>) -> Frame {
    let Some(look) = look else {
        return Frame::default();
    };
    match time.and_then(|time| look::animate_look(&look.json, time)) {
        Some(animated) => Frame::from_adjustments(&animated),
        None => Frame::from_adjustments(&look.json),
    }
}

#[derive(Clone)]
pub struct FrameSettings {
    pub canvas: (u32, u32),
    pub output_space: Option<OutputColorSpace>,
    pub headroom: Option<Headroom>,
    pub precision: RenderOutputPrecision,
    pub hwaccel: bool,
    pub preview: bool,
    pub use_proxies: bool,
    pub title_keys: HashMap<String, String>,
    pub look_overrides: HashMap<String, LookJson>,
}

pub fn canvas_for(project: &VideoProject, longest: Option<u32>) -> (u32, u32) {
    let (width, height) = (
        project.settings.width.max(2),
        project.settings.height.max(2),
    );
    let scale = longest.map_or(1.0, |longest| {
        (longest as f32 / width.max(height) as f32).min(1.0)
    });
    let even = |value: f32| ((value / 2.0).round() as u32).max(1) * 2;
    (even(width as f32 * scale), even(height as f32 * scale))
}

fn output_color(hex: &str, space: OutputColorSpace) -> [f32; 3] {
    let srgb = hex_color(hex);
    match space {
        OutputColorSpace::Srgb => srgb,
        space => space.srgb_converter()(srgb),
    }
}

fn hex_color(hex: &str) -> [f32; 3] {
    let hex = hex.trim_start_matches('#');
    let channel = |index: usize| {
        hex.get(index..index + 2)
            .and_then(|value| u8::from_str_radix(value, 16).ok())
            .unwrap_or(0) as f32
            / 255.0
    };
    let srgb = [channel(0), channel(2), channel(4)];
    srgb.map(|value| value.clamp(0.0, 1.0))
}

fn blend_mode(blend: &Option<String>) -> BlendMode {
    blend
        .as_ref()
        .and_then(|name| serde_json::from_value(Value::String(name.clone())).ok())
        .unwrap_or_default()
}

fn max_value(animated: &Animated) -> f64 {
    animated
        .keys
        .iter()
        .map(|key| key.value)
        .fold(animated.value, f64::max)
}

#[derive(PartialEq)]
enum CacheKey {
    Layer(String, u64),
    Still(String),
}

impl CacheKey {
    fn kept(&self, kept: &KeptKeys) -> bool {
        match self {
            CacheKey::Layer(item, _) => kept.keeps_scoped(item),
            CacheKey::Still(key) => kept.keeps(path_of(key)),
        }
    }
}

struct SlotCache {
    budget: u64,
    used: u64,
    entries: Vec<(CacheKey, Cached)>,
}

impl SlotCache {
    fn new(budget: u64) -> Self {
        Self {
            budget,
            used: 0,
            entries: Vec::new(),
        }
    }

    fn get(&mut self, key: &CacheKey) -> Option<Cached> {
        let index = self.entries.iter().position(|(cached, _)| cached == key)?;
        let entry = self.entries.remove(index);
        let value = entry.1.clone();
        self.entries.push(entry);
        Some(value)
    }

    fn insert(&mut self, key: CacheKey, value: Cached) {
        self.remove_where(|cached| *cached == key);
        if let CacheKey::Layer(item, _) = &key
            && let Some(index) = self.superseded(item)
        {
            self.evict(index);
        }
        self.used += value.slot.bytes();
        self.entries.push((key, value));
        while self.used > self.budget && self.entries.len() > 1 {
            let older = &self.entries[..self.entries.len() - 1];
            let victim = older
                .iter()
                .position(|(key, _)| matches!(key, CacheKey::Layer(..)))
                .unwrap_or(0);
            self.evict(victim);
        }
    }

    fn superseded(&self, item: &str) -> Option<usize> {
        let mut layers = self
            .entries
            .iter()
            .enumerate()
            .filter(|(_, (key, _))| matches!(key, CacheKey::Layer(other, _) if other == item))
            .map(|(index, _)| index);
        let oldest = layers.next()?;
        (layers.count() + 1 >= LAYERS_PER_ITEM).then_some(oldest)
    }

    fn evict(&mut self, index: usize) {
        let (_, evicted) = self.entries.remove(index);
        self.used -= evicted.slot.bytes();
    }

    fn remove_where(&mut self, evict: impl Fn(&CacheKey) -> bool) {
        let used = &mut self.used;
        self.entries.retain(|(key, value)| {
            let evicted = evict(key);
            if evicted {
                *used -= value.slot.bytes();
            }
            !evicted
        });
    }
}

fn cache_keys(project: &VideoProject) -> Vec<&str> {
    let tracks = project.video_tracks.iter().chain(
        project
            .sequences
            .values()
            .flat_map(|sequence| &sequence.video_tracks),
    );
    let items = tracks
        .flat_map(|track| &track.items)
        .filter_map(|item| match item {
            Item::Clip(clip) => Some(clip.id.as_str()),
            Item::Adjustment(adjustment) => Some(adjustment.id.as_str()),
            _ => None,
        });
    items
        .chain(project.media.iter().map(|media| media.path.as_str()))
        .collect()
}

fn path_of(key: &str) -> &str {
    key.rsplit_once('@').map_or(key, |(path, _)| path)
}

#[derive(Default)]
struct KeptKeys {
    fingerprint: u64,
    current: HashSet<String>,
    previous: HashSet<String>,
}

impl KeptKeys {
    fn update(&mut self, project: &VideoProject) -> bool {
        let keys = cache_keys(project);
        let fingerprint = hash_of(&keys);
        if fingerprint == self.fingerprint {
            return false;
        }
        self.fingerprint = fingerprint;
        let sources = project.media.iter().map(|media| {
            parse_virtual_path(&media.path)
                .0
                .to_string_lossy()
                .into_owned()
        });
        let current: HashSet<String> = keys
            .into_iter()
            .map(str::to_string)
            .chain(sources)
            .collect();
        if current == self.current {
            return false;
        }
        self.previous = std::mem::replace(&mut self.current, current);
        true
    }

    fn keeps(&self, key: &str) -> bool {
        self.current.contains(key) || self.previous.contains(key)
    }

    fn keeps_scoped(&self, key: &str) -> bool {
        key.strip_prefix("adjust:")
            .unwrap_or(key)
            .split('/')
            .all(|id| self.keeps(id))
    }
}

#[derive(Clone)]
struct Cached {
    slot: Slot,
    transparent: bool,
}

fn load_still(
    app: &AppHandle,
    context: &GpuContext,
    settings: &AppSettings,
    path: &str,
    size: (u32, u32),
) -> Result<Cached, String> {
    let source = parse_virtual_path(path).0;
    let state = app.state::<AppState>();
    let (image, _) =
        crate::decode::image_loader::get_or_decode_pristine(&state, &source, settings, None)?;
    if let Some(rgba) = transparent_still(&image, &source, size) {
        return Ok(Cached {
            slot: compute::upload_image(context, &DynamicImage::ImageRgba32F(rgba)),
            transparent: true,
        });
    }
    let slot = if image.dimensions() == size {
        compute::upload_image(context, &image)
    } else {
        compute::upload_image(context, &downscale_f32_image(&image, size.0, size.1))
    };
    Ok(Cached {
        slot,
        transparent: false,
    })
}

fn image_size(
    app: &AppHandle,
    settings: &AppSettings,
    source: &Path,
) -> Result<(u32, u32), String> {
    let state = app.state::<AppState>();
    crate::decode::image_loader::get_or_decode_pristine(&state, source, settings, None)
        .map(|(image, _)| image.dimensions())
}

fn unreadable(path: &str) -> String {
    format!("Could not load '{}'", path)
}

type StillLoad = (Option<ffmpeg::FileKey>, JoinHandle<Result<Cached, String>>);
type StillSizing = JoinHandle<Result<(u32, u32), String>>;

struct Placed {
    canvas_size: (u32, u32),
    content: (f32, f32),
    base_scale: f32,
    transform: Transform,
    span: MotionSpan,
    correction: Option<Similarity>,
    follows: Vec<(i64, Follow)>,
}

struct Pose {
    k: f32,
    sin: f32,
    cos: f32,
    fx: f32,
    fy: f32,
    px: f32,
    py: f32,
}

impl Placed {
    fn motion(&self, offset: i64) -> MotionState {
        MotionSpan {
            local: self.span.local + offset,
            ..self.span
        }
        .state()
    }

    fn bound(&self) -> Option<&Anchor> {
        self.transform.track.as_ref()?.anchor.as_ref()
    }

    fn follow(&self, offset: i64) -> Option<Follow> {
        let track = self.transform.track.as_ref()?;
        if track.anchor.is_some() {
            return self
                .follows
                .iter()
                .find(|(at, _)| *at == offset)
                .map(|(_, follow)| follow.clone());
        }
        let canvas = (self.canvas_size.0 as f64, self.canvas_size.1 as f64);
        track.follow(seconds(self.span.local + offset), canvas)
    }

    fn placement(&self, offset: i64, blend: BlendMode) -> Placement {
        self.place(
            offset,
            self.content,
            self.base_scale,
            self.correction,
            blend,
        )
    }

    fn frame_placement(&self, offset: i64, blend: BlendMode) -> Placement {
        let canvas = (self.canvas_size.0 as f32, self.canvas_size.1 as f32);
        self.place(offset, canvas, 1.0, None, blend)
    }

    fn pose(&self, offset: i64, base_scale: f32) -> Pose {
        let t = &self.transform;
        let (cw, ch) = (self.canvas_size.0 as f32, self.canvas_size.1 as f32);
        let local = self.span.local + offset;
        let motion = self.motion(offset);
        let tracked = self.follow(offset).and_then(|follow| follow.similar);
        let k = base_scale * t.scale.at(local).max(0.001) as f32 * motion.scale;
        let k = tracked
            .as_ref()
            .map_or(k, |tracked| k * tracked.scale as f32);
        let angle = t.rotation.at(local) as f32 + motion.rotation;
        let angle = tracked
            .as_ref()
            .map_or(angle, |tracked| angle + tracked.degrees as f32)
            .to_radians();
        let (sin, cos) = angle.sin_cos();
        let fx = if t.flip_h { -1.0 } else { 1.0 };
        let fy = if t.flip_v { -1.0 } else { 1.0 };
        let px = cw * 0.5 + (t.x.at(local) as f32 + motion.dx) * cw;
        let py = ch * 0.5 + (t.y.at(local) as f32 + motion.dy) * ch;
        let (px, py) = tracked.as_ref().map_or((px, py), |tracked| {
            let (x, y) = tracked.map(px as f64, py as f64);
            (x as f32, y as f32)
        });
        Pose {
            k,
            sin,
            cos,
            fx,
            fy,
            px,
            py,
        }
    }

    fn place(
        &self,
        offset: i64,
        content: (f32, f32),
        base_scale: f32,
        correction: Option<Similarity>,
        blend: BlendMode,
    ) -> Placement {
        let t = &self.transform;
        let local = self.span.local + offset;
        let motion = self.motion(offset);
        if let Some(pin) = &t.pin {
            let opacity = (t.opacity.at(local) as f32 * motion.opacity).clamp(0.0, 1.0);
            return self.pinned(pin, offset, content, correction, opacity, blend);
        }
        let Pose {
            k,
            sin,
            cos,
            fx,
            fy,
            px,
            py,
        } = self.pose(offset, base_scale);
        let m00 = cos / (fx * k);
        let m01 = sin / (fx * k);
        let m10 = -sin / (fy * k);
        let m11 = cos / (fy * k);
        let (lcx, lcy) = (content.0 * 0.5, content.1 * 0.5);
        let ([[m00, m01], [m10, m11]], shift) = match correction {
            Some(correction) => {
                let (sin, cos) = correction.angle.sin_cos();
                let s = correction.scale.max(0.001);
                let inverse = [[cos / s, sin / s], [-sin / s, cos / s]];
                let t = [correction.dx * content.0, correction.dy * content.1];
                (
                    [
                        [
                            inverse[0][0] * m00 + inverse[0][1] * m10,
                            inverse[0][0] * m01 + inverse[0][1] * m11,
                        ],
                        [
                            inverse[1][0] * m00 + inverse[1][1] * m10,
                            inverse[1][0] * m01 + inverse[1][1] * m11,
                        ],
                    ],
                    [
                        -(inverse[0][0] * t[0] + inverse[0][1] * t[1]),
                        -(inverse[1][0] * t[0] + inverse[1][1] * t[1]),
                    ],
                )
            }
            None => ([[m00, m01], [m10, m11]], [0.0, 0.0]),
        };
        Placement {
            canvas_to_layer: [
                [m00, m01, lcx + shift[0] - (m00 * px + m01 * py)],
                [m10, m11, lcy + shift[1] - (m10 * px + m11 * py)],
            ],
            perspective: None,
            opacity: (t.opacity.at(local) as f32 * motion.opacity).clamp(0.0, 1.0),
            blend,
        }
    }

    fn to_canvas(&self, offset: i64) -> Option<Homography> {
        let (width, height) = (self.content.0 as f64, self.content.1 as f64);
        if let Some(pin) = &self.transform.pin {
            return self.unpinned(pin, offset, self.content)?.inverse();
        }
        let pose = self.pose(offset, self.base_scale);
        let [k, sin, cos, fx, fy, px, py] = [
            pose.k, pose.sin, pose.cos, pose.fx, pose.fy, pose.px, pose.py,
        ]
        .map(f64::from);
        Some(shift(-0.5 * width, -0.5 * height).then(&affine([
            cos * fx * k,
            -sin * fy * k,
            px,
            sin * fx * k,
            cos * fy * k,
            py,
        ])))
    }

    fn unpinned(&self, pin: &Corners, offset: i64, content: (f32, f32)) -> Option<Homography> {
        let t = &self.transform;
        let canvas = (self.canvas_size.0 as f64, self.canvas_size.1 as f64);
        let quad = pin_corners(pin, self.follow(offset).as_ref(), canvas);
        let (width, height) = (content.0 as f64, content.1 as f64);
        let unit = Homography([1.0 / width, 0.0, 0.0, 0.0, 1.0 / height, 0.0, 0.0, 0.0, 1.0]);
        let mut matrix =
            Homography::from_square(&quad).and_then(|square| unit.then(&square).inverse())?;
        if t.flip_h {
            matrix = matrix.then(&Homography([
                -1.0, 0.0, width, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0,
            ]));
        }
        if t.flip_v {
            matrix = matrix.then(&Homography([
                1.0, 0.0, 0.0, 0.0, -1.0, height, 0.0, 0.0, 1.0,
            ]));
        }
        Some(matrix)
    }

    fn pinned(
        &self,
        pin: &Corners,
        offset: i64,
        content: (f32, f32),
        correction: Option<Similarity>,
        opacity: f32,
        blend: BlendMode,
    ) -> Placement {
        let (width, height) = (content.0 as f64, content.1 as f64);
        let Some(mut matrix) = self.unpinned(pin, offset, content) else {
            return Placement {
                opacity: 0.0,
                ..Placement::fit(self.canvas_size, self.canvas_size)
            };
        };
        if let Some(correction) = correction {
            let (sin, cos) = (correction.angle as f64).sin_cos();
            let s = (correction.scale as f64).max(0.001);
            let [a, b, c, d] = [cos / s, sin / s, -sin / s, cos / s];
            let shift = [correction.dx as f64 * width, correction.dy as f64 * height];
            let (cx, cy) = (width * 0.5, height * 0.5);
            matrix = matrix.then(&Homography([
                a,
                b,
                cx - a * cx - b * cy - (a * shift[0] + b * shift[1]),
                c,
                d,
                cy - c * cx - d * cy - (c * shift[0] + d * shift[1]),
                0.0,
                0.0,
                1.0,
            ]));
        }
        let m = matrix.0;
        Placement::projective(
            [[m[0], m[1], m[2]], [m[3], m[4], m[5]], [m[6], m[7], m[8]]],
            opacity,
            blend,
        )
    }
}

struct TextSource {
    glyphs: Slot,
    units: Slot,
    edges: [TextEdge; 2],
}

enum Source {
    Texture(Slot),
    Overlay(Slot),
    Text(Box<TextSource>),
    Fill([f32; 4]),
}

struct Layer {
    source: Source,
    placed: Placed,
    blend: BlendMode,
    passes: Vec<LayerPass>,
    radius: f32,
    backdrop: bool,
    shutter: i64,
    matte: Option<Matte>,
}

struct Matte {
    setting: TrackMatte,
    layers: Rc<Vec<Layer>>,
}

struct Visual<'a> {
    transform: &'a Transform,
    blend: &'a Option<String>,
    matte: Option<TrackMatte>,
    motion_blur: Option<MotionBlur>,
}

struct LayerSource {
    source: Source,
    content: (f32, f32),
    base_scale: f32,
    correction: Option<Similarity>,
}

fn fit_scale(canvas: (u32, u32), size: (u32, u32), fit: FitMode) -> f32 {
    let sx = canvas.0 as f32 / size.0.max(1) as f32;
    let sy = canvas.1 as f32 / size.1.max(1) as f32;
    match fit {
        FitMode::Fit | FitMode::Blur => sx.min(sy),
        FitMode::Fill => sx.max(sy),
    }
}

fn clip_span(clip: &ClipItem, local: i64) -> MotionSpan {
    MotionSpan {
        local,
        duration: clip.duration,
        fade_in: clip.fade_in,
        fade_out: clip.fade_out,
        anim_in: clip.anim_in,
        anim_out: clip.anim_out,
        full_frame: true,
    }
}

fn shutter_offsets(shutter: i64) -> Vec<i64> {
    if shutter == 0 {
        return vec![0];
    }
    let open = -shutter / 2;
    vec![open, 0, open + shutter]
}

fn clip_below(
    tracks: &[Track],
    below: usize,
    ticks: i64,
    rank: impl Fn(&ClipItem) -> Option<bool>,
) -> Option<(usize, &ClipItem, i64)> {
    tracks[..below.min(tracks.len())]
        .iter()
        .enumerate()
        .flat_map(|(index, track)| {
            track.items.iter().filter_map(move |item| match item {
                Item::Clip(clip) => Some((index, clip.as_ref())),
                _ => None,
            })
        })
        .filter_map(|(index, clip)| Some((index, clip, rank(clip)?)))
        .min_by_key(|(index, clip, preferred)| {
            let end = clip.start + clip.duration;
            let distance = (clip.start - ticks).max(ticks - end + 1).max(0);
            (distance, !preferred, usize::MAX - index)
        })
        .map(|(index, clip, _)| {
            let at = ticks.clamp(clip.start, (clip.start + clip.duration - 1).max(clip.start));
            (index, clip, at)
        })
}

fn bound_clip<'a>(
    tracks: &'a [Track],
    below: usize,
    anchor: &Anchor,
    follower: &str,
    ticks: i64,
) -> Option<(usize, &'a ClipItem, i64)> {
    clip_below(tracks, below, ticks, |clip| {
        (clip.id != follower && (clip.id == anchor.clip || clip.media == anchor.media))
            .then_some(clip.id == anchor.clip)
    })
}

fn shutter_ticks(blur: MotionBlur, fps: FrameRate) -> i64 {
    (fps.ticks_of(1) as f64 * blur.shutter.clamp(0.0, 360.0) / 360.0).round() as i64
}

fn matte_of(item: &Item) -> Option<TrackMatte> {
    match item {
        Item::Clip(clip) => clip.track_matte,
        Item::Title(title) => title.track_matte,
        Item::Solid(solid) => solid.track_matte,
        _ => None,
    }
}

fn item_layer(
    canvas_size: (u32, u32),
    fps: FrameRate,
    span: MotionSpan,
    visual: Visual,
    layer: LayerSource,
) -> Layer {
    let radius = match layer.source {
        Source::Text(_) => 0.0,
        _ => visual.transform.radius.at(span.local).max(0.0) as f32,
    };
    Layer {
        placed: Placed {
            canvas_size,
            content: layer.content,
            base_scale: layer.base_scale,
            transform: visual.transform.clone(),
            span,
            correction: layer.correction,
            follows: Vec::new(),
        },
        source: layer.source,
        blend: blend_mode(visual.blend),
        passes: span.state().passes(),
        radius,
        backdrop: false,
        shutter: visual
            .motion_blur
            .map_or(0, |blur| shutter_ticks(blur, fps)),
        matte: visual.matte.map(|setting| Matte {
            setting,
            layers: Rc::default(),
        }),
    }
}

enum Op {
    Layer(Box<Layer>),
    Transition {
        from: Box<Layer>,
        to: Box<Layer>,
        transition: Transition,
        progress: f32,
    },
    Adjust {
        id: String,
        local: i64,
        look: Option<Arc<Look>>,
        opacity: f32,
        follows: Vec<(String, Follow)>,
    },
}

impl Op {
    fn layers_mut(&mut self) -> Vec<&mut Layer> {
        match self {
            Op::Layer(layer) => vec![layer.as_mut()],
            Op::Transition { from, to, .. } => vec![from.as_mut(), to.as_mut()],
            Op::Adjust { .. } => Vec::new(),
        }
    }
}

fn resolve_mattes(mut tracks: Vec<(usize, bool, Vec<Op>)>) -> Vec<Op> {
    for index in (0..tracks.len()).rev() {
        let track = tracks[index].0;
        if !tracks[index]
            .2
            .iter_mut()
            .any(|op| op.layers_mut().iter().any(|layer| layer.matte.is_some()))
        {
            continue;
        }
        let mut layers = Vec::new();
        if let Some((above, _, ops)) = tracks.get_mut(index + 1)
            && *above == track + 1
        {
            for op in std::mem::take(ops) {
                match op {
                    Op::Layer(layer) => layers.push(*layer),
                    other => ops.push(other),
                }
            }
        }
        let layers = Rc::new(layers);
        for op in &mut tracks[index].2 {
            for layer in op.layers_mut() {
                if let Some(matte) = &mut layer.matte {
                    matte.layers = Rc::clone(&layers);
                }
            }
        }
    }
    tracks
        .into_iter()
        .filter(|(_, hidden, _)| !hidden)
        .flat_map(|(_, _, ops)| ops)
        .collect()
}

pub struct Engine {
    app: AppHandle,
    context: GpuContext,
    settings: AppSettings,
    decoders: Decoders,
    cache: SlotCache,
    still_loads: u64,
    loading_stills: HashMap<String, StillLoad>,
    failed_stills: HashMap<String, (Option<ffmpeg::FileKey>, String)>,
    sizing_stills: HashMap<String, StillSizing>,
    unwarmed: bool,
    masks: HashMap<String, MaskCache>,
    looks: HashMap<String, (u64, Arc<Look>)>,
    full_sizes: HashMap<String, (u32, u32)>,
    ramps: HashMap<String, (u64, Arc<Vec<f64>>)>,
    plans: HashMap<String, (u64, Arc<FramePlan>)>,
    pictures: HashMap<String, (u64, f64)>,
    renders: u64,
    analyses: HashMap<PathBuf, (Instant, Option<Arc<MotionAnalysis>>)>,
    stabilizations: HashMap<String, (u64, Option<Arc<ClipStabilization>>)>,
    flows: HashMap<String, FlowCache>,
    missing_maps: Vec<crate::video::ai_maps::Block>,
    kept: KeptKeys,
}

struct Retime {
    key: String,
    mode: Interpolation,
    stream: u64,
    frames: [Neighbour; 2],
}

impl Retime {
    fn time(&self) -> f32 {
        let [before, after] = &self.frames;
        (before.gap / (before.gap + after.gap).max(f64::EPSILON)) as f32
    }
}

impl Engine {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let state = app.state::<AppState>();
        let context = get_or_init_gpu_context(&state, app)?;
        let budget =
            compute::memory_share(&context, MEMORY_SHARE, MIN_CACHE_BYTES, MAX_CACHE_BYTES);
        Ok(Self {
            app: app.clone(),
            context,
            settings: load_settings(app.clone()).unwrap_or_default(),
            decoders: Decoders::default(),
            cache: SlotCache::new(budget),
            still_loads: 0,
            loading_stills: HashMap::new(),
            failed_stills: HashMap::new(),
            sizing_stills: HashMap::new(),
            unwarmed: false,
            masks: HashMap::new(),
            looks: HashMap::new(),
            full_sizes: HashMap::new(),
            ramps: HashMap::new(),
            plans: HashMap::new(),
            pictures: HashMap::new(),
            renders: 0,
            analyses: HashMap::new(),
            stabilizations: HashMap::new(),
            flows: HashMap::new(),
            missing_maps: Vec::new(),
            kept: KeptKeys::default(),
        })
    }

    pub fn context(&self) -> &GpuContext {
        &self.context
    }

    fn fresh_id(&mut self) -> u64 {
        self.renders += 1;
        hash_of(("render", self.renders))
    }

    fn prune(&mut self, project: &VideoProject) {
        if !self.kept.update(project) {
            return;
        }
        let kept = &self.kept;
        self.looks.retain(|id, _| kept.keeps(id));
        self.ramps.retain(|id, _| kept.keeps(id));
        self.plans.retain(|id, _| kept.keeps(id));
        self.pictures.retain(|key, _| kept.keeps_scoped(key));
        self.stabilizations.retain(|id, _| kept.keeps(id));
        self.masks.retain(|key, _| kept.keeps_scoped(key));
        self.full_sizes.retain(|path, _| kept.keeps(path));
        self.failed_stills.retain(|path, _| kept.keeps(path));
        self.sizing_stills.retain(|path, _| kept.keeps(path));
        self.loading_stills
            .retain(|key, _| kept.keeps(path_of(key)));
        self.cache.remove_where(|key| !key.kept(kept));
        self.analyses
            .retain(|source, _| kept.keeps(&source.to_string_lossy()));
    }

    pub fn media_loads(&self) -> u64 {
        self.decoders.opened() + self.still_loads
    }

    pub fn preempt_on(&mut self, cancel: Option<Arc<AtomicBool>>) {
        self.decoders.cancel_on(cancel);
    }

    fn look(
        &mut self,
        project: &VideoProject,
        frame: &FrameSettings,
        id: &str,
        look_id: Option<&str>,
    ) -> Option<Arc<Look>> {
        let source = frame
            .look_overrides
            .get(id)
            .or_else(|| look_id.and_then(|look_id| project.looks.get(look_id)))
            .filter(|source| !source.json().is_null())?;
        let raw = source.hash();
        if let Some((hash, look)) = self.looks.get(id)
            && *hash == raw
        {
            return Some(Arc::clone(look));
        }
        let look = Arc::new(Look::new(&self.app, source.json().clone()));
        self.looks.insert(id.to_string(), (raw, Arc::clone(&look)));
        Some(look)
    }

    fn options(&self, frame: &FrameSettings, is_raw: bool) -> RenderOptions {
        let base = resolve_render_options(&self.settings, is_raw);
        RenderOptions {
            output_space: frame.output_space.unwrap_or(base.output_space),
            headroom: frame.headroom.unwrap_or(base.headroom),
            ..base
        }
    }

    fn full_size(&mut self, path: &str, kind: MediaKind) -> Result<Option<(u32, u32)>, String> {
        if let Some(size) = self.full_sizes.get(path) {
            return Ok(Some(*size));
        }
        let source = parse_virtual_path(path).0;
        let size = match kind {
            MediaKind::Image => {
                let file = self.known_failure(path)?;
                let sizing = self.sizing_stills.remove(path);
                if self.decoders.warming()
                    && sizing.as_ref().is_none_or(|sizing| !sizing.is_finished())
                {
                    let sizing = sizing.unwrap_or_else(|| self.size_in_background(&source));
                    self.sizing_stills.insert(path.to_string(), sizing);
                    self.unwarmed = true;
                    return Ok(None);
                }
                let sizing = sizing.or_else(|| {
                    self.decoders
                        .preemptible()
                        .then(|| self.size_in_background(&source))
                });
                let sized = match sizing {
                    Some(sizing) => match self.decoders.join(sizing) {
                        Ok(joined) => joined.unwrap_or_else(|_| Err(unreadable(path))),
                        Err(sizing) => {
                            self.sizing_stills.insert(path.to_string(), sizing);
                            return Err(PREEMPTED.to_string());
                        }
                    },
                    None => image_size(&self.app, &self.settings, &source),
                };
                self.remember_failure(path, file, sized)?
            }
            _ => {
                let info = ffmpeg::probe(&source)?;
                (info.width, info.height)
            }
        };
        self.full_sizes.insert(path.to_string(), size);
        Ok(Some(size))
    }

    fn size_in_background(&self, source: &Path) -> StillSizing {
        let (app, settings) = (self.app.clone(), self.settings.clone());
        let source = source.to_path_buf();
        std::thread::spawn(move || image_size(&app, &settings, &source))
    }

    fn load_in_background(
        &self,
        path: &str,
        size: (u32, u32),
    ) -> JoinHandle<Result<Cached, String>> {
        let (app, context) = (self.app.clone(), self.context.clone());
        let (settings, path) = (self.settings.clone(), path.to_string());
        std::thread::spawn(move || load_still(&app, &context, &settings, &path, size))
    }

    fn known_failure(&mut self, path: &str) -> Result<Option<ffmpeg::FileKey>, String> {
        let file = ffmpeg::file_key(&parse_virtual_path(path).0).ok();
        if let Some((failed, error)) = self.failed_stills.get(path) {
            if *failed == file {
                return Err(error.clone());
            }
            self.failed_stills.remove(path);
        }
        Ok(file)
    }

    fn remember_failure<T>(
        &mut self,
        path: &str,
        file: Option<ffmpeg::FileKey>,
        result: Result<T, String>,
    ) -> Result<T, String> {
        if let Err(error) = &result {
            self.failed_stills
                .insert(path.to_string(), (file, error.clone()));
        }
        result
    }

    fn still(&mut self, path: &str, size: (u32, u32)) -> Result<Option<Cached>, String> {
        let key = format!("{}@{}x{}", path, size.0, size.1);
        let finished: Vec<String> = self
            .loading_stills
            .iter()
            .filter(|(_, (_, loading))| loading.is_finished())
            .map(|(key, _)| key.clone())
            .collect();
        for done in finished {
            let Some((file, loading)) = self.loading_stills.remove(&done) else {
                continue;
            };
            if let Ok(still) = self.settle_still(path_of(&done), file, loading.join()) {
                self.cache.insert(CacheKey::Still(done), still);
            }
        }
        if let Some(still) = self.cache.get(&CacheKey::Still(key.clone())) {
            return Ok(Some(still));
        }
        let file = self.known_failure(path)?;
        let loading = self.loading_stills.remove(&key);
        let background = !self.context.shares_one_gl_context();
        if self.decoders.warming() && background {
            let loading = loading.unwrap_or_else(|| (file, self.load_in_background(path, size)));
            self.loading_stills.insert(key, loading);
            return Ok(None);
        }
        self.still_loads += 1;
        let loading = loading.or_else(|| {
            (background && self.decoders.preemptible())
                .then(|| (file, self.load_in_background(path, size)))
        });
        let still = match loading {
            Some((file, loading)) => match self.decoders.join(loading) {
                Ok(joined) => self.settle_still(path, file, joined),
                Err(loading) => {
                    self.loading_stills.insert(key, (file, loading));
                    return Err(PREEMPTED.to_string());
                }
            },
            None => {
                let loaded = load_still(&self.app, &self.context, &self.settings, path, size);
                self.settle_still(path, file, Ok(loaded))
            }
        }?;
        self.cache.insert(CacheKey::Still(key), still.clone());
        Ok(Some(still))
    }

    fn settle_still(
        &mut self,
        path: &str,
        file: Option<ffmpeg::FileKey>,
        loaded: std::thread::Result<Result<Cached, String>>,
    ) -> Result<Cached, String> {
        let loaded = loaded.unwrap_or_else(|_| Err(unreadable(path)));
        self.remember_failure(path, file, loaded)
    }

    fn ramp_offsets(
        &mut self,
        clip: &ClipItem,
        keys: &[Keyframe],
        project: &VideoProject,
    ) -> Arc<Vec<f64>> {
        let hash = hash_of((
            clip.duration,
            project.settings.fps.num,
            project.settings.fps.den,
            keys.iter()
                .map(|key| {
                    (
                        key.time,
                        key.value.to_bits(),
                        key.ease,
                        [key.handle_in, key.handle_out]
                            .map(|handle| handle.map(|h| h.map(f64::to_bits))),
                    )
                })
                .collect::<Vec<_>>(),
        ));
        if let Some((cached, offsets)) = self.ramps.get(&clip.id)
            && *cached == hash
        {
            return Arc::clone(offsets);
        }
        let offsets = Arc::new(ramp_offsets(clip.duration, keys, project.settings.fps));
        self.ramps
            .insert(clip.id.clone(), (hash, Arc::clone(&offsets)));
        offsets
    }

    fn analysis(&mut self, source: &Path) -> Option<Arc<MotionAnalysis>> {
        if let Some((loaded, analysis)) = self.analyses.get(source)
            && (analysis.is_some() || loaded.elapsed() < ANALYSIS_RETRY)
        {
            return analysis.clone();
        }
        let analysis = stabilization::load_analysis(&self.app, source).map(Arc::new);
        self.analyses
            .insert(source.to_path_buf(), (Instant::now(), analysis.clone()));
        analysis
    }

    fn stabilization(
        &mut self,
        clip: &ClipItem,
        source: &Path,
        aspect: f32,
        range: (f64, f64),
    ) -> Option<Arc<ClipStabilization>> {
        let strength = clip.stabilize.as_ref()?.strength;
        if strength <= 0.0 {
            return None;
        }
        let analysis = self.analysis(source)?;
        let key = hash_of((
            source,
            strength.to_bits(),
            range.0.to_bits(),
            range.1.to_bits(),
            aspect.to_bits(),
            analysis.motions.len(),
        ));
        if let Some((cached, result)) = self.stabilizations.get(&clip.id)
            && *cached == key
        {
            return result.clone();
        }
        let result =
            stabilization::for_clip(&analysis, range.0, range.1, strength, aspect).map(Arc::new);
        self.stabilizations
            .insert(clip.id.clone(), (key, result.clone()));
        result
    }

    fn interpolates(
        &mut self,
        project: &VideoProject,
        clip: &ClipItem,
        info: &ffmpeg::MediaInfo,
    ) -> bool {
        if clip.freeze || info.fps <= 0.0 {
            return false;
        }
        let slowest = match clip.ramp() {
            Some(keys) => {
                self.ramp_offsets(clip, keys, project)
                    .windows(2)
                    .map(|pair| pair[1] - pair[0])
                    .fold(f64::INFINITY, f64::min)
                    * project.fps()
            }
            None => clip.speed(),
        };
        slowest * info.fps < project.fps() * (1.0 - RATE_TOLERANCE)
    }

    fn source_timing(
        &mut self,
        project: &VideoProject,
        clip: &ClipItem,
        local: i64,
        local_frame: u64,
    ) -> SourceTiming {
        if clip.freeze {
            return SourceTiming {
                index: 0,
                speed: 1.0,
                advance: 0.0,
                offset: 0.0,
                span: 0.0,
                ramped: false,
            };
        }
        match clip.ramp() {
            Some(keys) => {
                let offsets = self.ramp_offsets(clip, keys, project);
                SourceTiming::ramped(&offsets, local_frame, project.fps())
            }
            None => SourceTiming {
                index: local_frame,
                speed: clip.speed(),
                advance: clip.speed() / project.fps(),
                offset: seconds(local.max(0)) * clip.speed(),
                span: seconds(clip.duration) * clip.speed(),
                ramped: false,
            },
        }
    }

    fn clip_basis(
        &mut self,
        project: &VideoProject,
        clip: &ClipItem,
        media: &MediaRef,
        ticks: i64,
        frame: &FrameSettings,
        current: Option<&Follow>,
    ) -> Result<Option<ClipBasis>, String> {
        let (path, kind) = (media.path.as_str(), media.kind);
        if timelapse::is_pending(path)
            || (frame.preview
                && kind != MediaKind::Sequence
                && !parse_virtual_path(path).0.is_file())
        {
            return Ok(None);
        }
        let reference = timelapse::frame_path(Path::new(path), None);
        let look_path = reference.as_deref().unwrap_or(path);
        let full = match kind {
            MediaKind::Sequence => (project.settings.width, project.settings.height),
            _ => match self.full_size(path, kind)? {
                Some(size) => size,
                None => return Ok(None),
            },
        };
        let look = self.look(project, frame, &clip.id, clip.look.as_deref());
        let neutral = Value::Null;
        let look_value = look.as_ref().map_or(&neutral, |look| &look.json);
        let output = SourceTransform::from_adjustments(look_path, look_value).output_size(full);
        let canvas = frame.canvas;
        let stabilizing = kind == MediaKind::Video
            && !clip.freeze
            && clip
                .stabilize
                .as_ref()
                .is_some_and(|stabilize| stabilize.strength > 0.0);
        let zoom = if stabilizing { MAX_ZOOM } else { 1.0 };
        let framed = cell_crop(output, clip.cell_aspect).map_or(output, |(_, size)| size);
        let tracked = clip
            .transform
            .track
            .as_ref()
            .map_or(1.0, MotionTrack::max_scale);
        let magnification = match &clip.transform.pin {
            Some(pin) => {
                let [across, down] = pin_extent(
                    pin,
                    clip.transform.track.as_ref(),
                    (canvas.0 as f64, canvas.1 as f64),
                    current,
                );
                (across / framed.0.max(1) as f64).max(down / framed.1.max(1) as f64) as f32
            }
            None => {
                fit_scale(canvas, framed, clip.fit)
                    * (max_value(&clip.transform.scale) * tracked) as f32
            }
        };
        let decode_scale = (magnification * zoom).min(1.0);
        let decode = (
            ((full.0 as f32 * decode_scale).round() as u32).max(2),
            ((full.1 as f32 * decode_scale).round() as u32).max(2),
        );
        let timeline_frame = project.frame_of(ticks);
        Ok(Some(ClipBasis {
            path: path.to_string(),
            kind,
            reference,
            full,
            look,
            decode,
            stabilizing,
            local: ticks - clip.start,
            local_frame: timeline_frame.saturating_sub(project.frame_of(clip.start)),
            timeline_frame,
        }))
    }

    fn video_clock(
        &mut self,
        project: &VideoProject,
        clip: &ClipItem,
        media: &MediaRef,
        basis: &ClipBasis,
        frame: &FrameSettings,
    ) -> Result<VideoClock, String> {
        let source = parse_virtual_path(&basis.path).0;
        let reversed = clip
            .reverse
            .then(|| reverse::video_for(&self.app, &source))
            .flatten();
        let decode_path = reversed
            .clone()
            .unwrap_or_else(|| proxy::decode_path(&self.app, &source, frame.use_proxies));
        let info = ffmpeg::probe(&decode_path)?.with_log(media.log);
        let timing = self.source_timing(project, clip, basis.local, basis.local_frame);
        let start = if clip.freeze {
            seconds(clip.source_in)
                .min(info.duration - 1.0 / info.fps.max(1.0))
                .max(0.0)
        } else {
            seconds(clip.source_in)
        };
        let first = match (clip.reverse, reversed.is_some()) {
            (true, true) => info.duration - start,
            (true, false) => start - timing.span,
            _ => start,
        };
        let exact = first + timing.offset;
        let interpolation = Interpolation::of(
            clip.interpolation
                .as_deref()
                .or(project.settings.interpolation.as_deref()),
        )
        .filter(|_| self.interpolates(project, clip, &info));
        let sample = timing.sample(info.fps, interpolation);
        let grid = match sample {
            Sample::Speed => project.fps(),
            _ => info.fps,
        };
        let timing = timing.anchor(first, grid);
        let mirrored = match clip.reverse && reversed.is_some() {
            true => Some(1.0 / ffmpeg::probe(&source)?.fps),
            false => None,
        };
        let stabilization = if basis.stabilizing {
            let low = if clip.reverse {
                start - timing.span
            } else {
                start
            };
            let aspect = basis.full.0 as f32 / basis.full.1.max(1) as f32;
            self.stabilization(clip, &source, aspect, (low, low + timing.span))
        } else {
            None
        };
        let mut clock = VideoClock {
            reversed: reversed.is_some(),
            source,
            decode_path,
            info,
            first,
            exact,
            timing,
            shown: first + timing.offset,
            sample,
            interpolation,
            mirrored,
            stabilization,
        };
        if clock.mirrored.is_some() {
            clock.shown = clock.original(clock.shown).max(0.0);
        }
        Ok(clock)
    }

    fn frame_plan(
        &mut self,
        project: &VideoProject,
        clip: &ClipItem,
        clock: &VideoClock,
        margin: u64,
    ) -> Option<Arc<FramePlan>> {
        let keys = clip.ramp()?;
        if clock.sample == Sample::Speed {
            return None;
        }
        let offsets = self.ramp_offsets(clip, keys, project);
        let ramp = self.ramps.get(&clip.id).map(|(hash, _)| *hash)?;
        let key = hash_of((
            ramp,
            clock.first.to_bits(),
            clock.info.fps.to_bits(),
            clock.interpolation,
            margin,
        ));
        if let Some((cached, plan)) = self.plans.get(&clip.id)
            && *cached == key
        {
            return Some(Arc::clone(plan));
        }
        let (info, first, fps) = (&clock.info, clock.first, project.fps());
        let frames = (0..offsets.len() as u64).flat_map(|local_frame| {
            let timing = SourceTiming::ramped(&offsets, local_frame, fps);
            let (single, bracket) = match timing.sample(info.fps, clock.interpolation) {
                Sample::Between(_) => {
                    let index = StreamRequest::source_index(info, first + timing.offset);
                    (None, Some(StreamRequest::bracket_frames(index)))
                }
                _ => {
                    let anchored = timing.anchor(first, info.fps);
                    let time = first + anchored.offset;
                    (Some(StreamRequest::source_index(info, time)), None)
                }
            };
            single.into_iter().chain(bracket.into_iter().flatten())
        });
        let plan = Arc::new(FramePlan::new(frames, margin));
        self.plans.insert(clip.id.clone(), (key, Arc::clone(&plan)));
        Some(plan)
    }

    fn framing(basis: &ClipBasis, time: Option<f64>, cell_aspect: Option<f64>) -> Framing {
        Framing::new(
            basis.full,
            basis.decode,
            look_frame(basis.look.as_deref(), time),
            cell_aspect,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn follow_at(
        &mut self,
        project: &VideoProject,
        tracks: &[Track],
        below: usize,
        follower: &str,
        track: Option<&MotionTrack>,
        ticks: i64,
        frame: &FrameSettings,
        depth: usize,
    ) -> Option<Follow> {
        let track = track?;
        let anchor = track.anchor.as_ref()?;
        if depth > MAX_NESTING {
            return None;
        }
        let (index, clip, at) = bound_clip(tracks, below, anchor, follower, ticks)?;
        let geometry = self
            .clip_geometry(project, tracks, index, clip, at, frame, depth + 1)
            .ok()
            .flatten()?;
        track.follow_in(
            geometry.source_time,
            geometry.source,
            &geometry.to_canvas,
            (frame.canvas.0 as f64, frame.canvas.1 as f64),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn clip_geometry(
        &mut self,
        project: &VideoProject,
        tracks: &[Track],
        track_index: usize,
        clip: &ClipItem,
        ticks: i64,
        frame: &FrameSettings,
        depth: usize,
    ) -> Result<Option<ClipGeometry>, String> {
        let Some(media) = project.media_ref(&clip.media) else {
            return Ok(None);
        };
        if media.kind == MediaKind::Sequence {
            return Ok(None);
        }
        let current = self.follow_at(
            project,
            tracks,
            track_index,
            &clip.id,
            clip.transform.track.as_ref(),
            ticks,
            frame,
            depth,
        );
        let Some(basis) = self.clip_basis(project, clip, media, ticks, frame, current.as_ref())?
        else {
            return Ok(None);
        };
        let (source_time, correction) = match basis.kind {
            MediaKind::Video => {
                let clock = self.video_clock(project, clip, media, &basis, frame)?;
                let decoded = self
                    .pictures
                    .get(&clip.id)
                    .filter(|(shown, _)| *shown == clock.shown.to_bits())
                    .filter(|_| !matches!(clock.sample, Sample::Between(_)))
                    .map_or_else(|| clock.requested(), |(_, decoded)| *decoded);
                (clock.shown, clock.correction(decoded))
            }
            _ => (seconds(clip.source_in + basis.local.max(0)), None),
        };
        let framing = Self::framing(&basis, Some(source_time), clip.cell_aspect);
        let placed = Placed {
            canvas_size: frame.canvas,
            content: (framing.content.0 as f32, framing.content.1 as f32),
            base_scale: fit_scale(frame.canvas, framing.content, clip.fit),
            transform: clip.transform.clone(),
            span: clip_span(clip, basis.local),
            correction: None,
            follows: current.into_iter().map(|follow| (0, follow)).collect(),
        };
        let Some(placement) = placed.to_canvas(0) else {
            return Ok(None);
        };
        let stabilization =
            correction.map_or(IDENTITY, |correction| stabilizing(&correction, basis.full));
        Ok(Some(ClipGeometry {
            source_time,
            source: basis.full,
            framing,
            to_canvas: stabilization.then(&framing.map).then(&placement),
        }))
    }

    #[allow(clippy::too_many_arguments)]
    fn bind(
        &mut self,
        layer: &mut Layer,
        project: &VideoProject,
        tracks: &[Track],
        track_index: usize,
        id: &str,
        ticks: i64,
        frame: &FrameSettings,
        current: Option<Follow>,
    ) {
        if layer.placed.bound().is_none() {
            return;
        }
        let track = layer.placed.transform.track.as_ref();
        let mut follows = Vec::new();
        for offset in shutter_offsets(layer.shutter) {
            let follow = match (offset, &current) {
                (0, Some(follow)) => Some(follow.clone()),
                _ => self.follow_at(
                    project,
                    tracks,
                    track_index,
                    id,
                    track,
                    ticks + offset,
                    frame,
                    0,
                ),
            };
            follows.extend(follow.map(|follow| (offset, follow)));
        }
        layer.placed.follows = follows;
    }

    #[allow(clippy::too_many_arguments)]
    fn mask_follows(
        &mut self,
        project: &VideoProject,
        tracks: &[Track],
        track_index: usize,
        id: &str,
        json: &Value,
        ticks: i64,
        frame: &FrameSettings,
    ) -> Vec<(String, Follow)> {
        let Some(masks) = json["masks"].as_array() else {
            return Vec::new();
        };
        masks
            .iter()
            .filter_map(|mask| {
                let track = MotionTrack::deserialize(mask.get("track")?)
                    .ok()
                    .filter(|track| track.anchor.is_some())?;
                let follow = self.follow_at(
                    project,
                    tracks,
                    track_index,
                    id,
                    Some(&track),
                    ticks,
                    frame,
                    0,
                )?;
                Some((mask["id"].as_str()?.to_string(), follow))
            })
            .collect()
    }

    fn geometry_settings(project: &VideoProject) -> FrameSettings {
        FrameSettings {
            canvas: (
                project.settings.width.max(2),
                project.settings.height.max(2),
            ),
            output_space: None,
            headroom: None,
            precision: RenderOutputPrecision::EightBit,
            hwaccel: false,
            preview: false,
            use_proxies: false,
            title_keys: HashMap::new(),
            look_overrides: HashMap::new(),
        }
    }

    pub fn clip_geometry_at(
        &mut self,
        project: &VideoProject,
        item_id: &str,
        ticks: i64,
    ) -> Result<Option<ClipGeometry>, String> {
        let frame = Self::geometry_settings(project);
        let tracks = &project.video_tracks;
        let Some((index, clip)) = tracks.iter().enumerate().find_map(|(index, track)| {
            track.items.iter().find_map(|item| match item {
                Item::Clip(clip) if clip.id == item_id => Some((index, clip)),
                _ => None,
            })
        }) else {
            return Ok(None);
        };
        self.clip_geometry(project, tracks, index, clip, ticks, &frame, 0)
    }

    pub fn frame_geometry(
        &mut self,
        project: &VideoProject,
        time: f64,
    ) -> Result<FrameGeometry, String> {
        self.prune(project);
        let frame = Self::geometry_settings(project);
        let ticks = project.settings.fps.ticks_of(project.frame_at(time) as i64);
        let tracks = &project.video_tracks;
        let mut geometry = FrameGeometry::default();
        for (index, track) in tracks.iter().enumerate() {
            for item in &track.items {
                let (start, end) = item.span();
                if ticks < start || ticks >= end {
                    continue;
                }
                let (id, transform) = match item {
                    Item::Clip(clip) => (&clip.id, Some(&clip.transform)),
                    Item::Title(title) => (&title.id, Some(&title.transform)),
                    Item::Solid(solid) => (&solid.id, Some(&solid.transform)),
                    Item::Adjustment(adjustment) => (&adjustment.id, None),
                    Item::Audio(_) => continue,
                };
                let track = transform.and_then(|transform| transform.track.as_ref());
                if let Some(follow) =
                    self.follow_at(project, tracks, index, id, track, ticks, &frame, 0)
                {
                    geometry
                        .follows
                        .insert(id.to_string(), FollowView::from(&follow));
                }
                match item {
                    Item::Clip(clip) => {
                        let video = project
                            .media_ref(&clip.media)
                            .is_some_and(|media| media.kind == MediaKind::Video);
                        if video
                            && let Ok(Some(space)) =
                                self.clip_space(project, tracks, index, clip, ticks, &frame)
                        {
                            geometry.clips.insert(clip.id.clone(), space);
                        }
                    }
                    Item::Adjustment(adjustment) => {
                        let Some(look) =
                            self.look(project, &frame, &adjustment.id, adjustment.look.as_deref())
                        else {
                            continue;
                        };
                        for (mask, follow) in self.mask_follows(
                            project,
                            tracks,
                            index,
                            &adjustment.id,
                            &look.json,
                            ticks,
                            &frame,
                        ) {
                            geometry.follows.insert(
                                format!("{}:{}", adjustment.id, mask),
                                FollowView::from(&follow),
                            );
                        }
                    }
                    _ => {}
                }
            }
        }
        Ok(geometry)
    }

    fn clip_space(
        &mut self,
        project: &VideoProject,
        tracks: &[Track],
        index: usize,
        clip: &ClipItem,
        ticks: i64,
        frame: &FrameSettings,
    ) -> Result<Option<ClipSpace>, String> {
        let Some(geometry) = self.clip_geometry(project, tracks, index, clip, ticks, frame, 0)?
        else {
            return Ok(None);
        };
        let look = self.look(project, frame, &clip.id, clip.look.as_deref());
        let (map, size) = oriented(
            &look_frame(look.as_deref(), Some(geometry.source_time)),
            geometry.source,
        );
        let m = &map.0;
        Ok(Some(ClipSpace {
            media: clip.media.clone(),
            source_time: geometry.source_time,
            source: [geometry.source.0, geometry.source.1],
            canvas: geometry.to_canvas.0,
            anchor: geometry
                .to_canvas
                .then(&scaling(
                    1.0 / frame.canvas.0 as f64,
                    1.0 / frame.canvas.1 as f64,
                ))
                .0,
            frame: map.0,
            frame_size: [size.0, size.1],
            mirrored: m[0] * m[4] - m[1] * m[3] < 0.0,
        }))
    }

    #[allow(clippy::too_many_arguments)]
    fn clip_layer(
        &mut self,
        project: &VideoProject,
        tracks: &[Track],
        track_index: usize,
        clip: &ClipItem,
        ticks: i64,
        frame: &FrameSettings,
        titles: &TitleStore,
        live: &mut HashSet<String>,
        scope: &str,
    ) -> Result<Option<Layer>, String> {
        let Some(media) = project.media_ref(&clip.media) else {
            return Ok(None);
        };
        let current = self.follow_at(
            project,
            tracks,
            track_index,
            &clip.id,
            clip.transform.track.as_ref(),
            ticks,
            frame,
            0,
        );
        let Some(basis) = self.clip_basis(project, clip, media, ticks, frame, current.as_ref())?
        else {
            return Ok(None);
        };
        let (path, kind, full, decode) =
            (basis.path.as_str(), basis.kind, basis.full, basis.decode);
        let (local, local_frame, timeline_frame) =
            (basis.local, basis.local_frame, basis.timeline_frame);
        let reference = basis.reference.as_deref();
        let look_path = reference.unwrap_or(path);
        let look = basis.look.clone();
        let canvas = frame.canvas;
        let fps = project.fps();
        let mut correction = None;
        let mut shutter_input = None;
        let mut retime = None;
        let mut transparent = false;
        let shutter_at = |time: f64| {
            look.as_deref()
                .and_then(|look| look::shutter_at(look, Some(time)))
        };
        let shutter;
        let (source_slot, source_key, source_time, source_peak) = match kind {
            MediaKind::Image => {
                let time = seconds(clip.source_in + local.max(0));
                shutter = shutter_at(time);
                let still = self.still(path, decode)?;
                transparent = still.as_ref().is_some_and(|still| still.transparent);
                (still.map(|still| still.slot), 0u64, Some(time), None)
            }
            MediaKind::Sequence => {
                let Some(sequence) = project.sequences.get(&clip.media) else {
                    return Ok(None);
                };
                if scope.matches('/').count() >= MAX_NESTING {
                    return Ok(None);
                }
                let start = seconds(clip.source_in);
                let timing = self
                    .source_timing(project, clip, local, local_frame)
                    .anchor(start, fps);
                let time = start + timing.offset;
                shutter = shutter_at(time);
                let nested = project.settings.fps.ticks_of((time * fps).round() as i64);
                let nested_scope = format!("{}{}/", scope, clip.id);
                let space = self.options(frame, false).output_space;
                if self.decoders.warming() {
                    self.collect_ops(
                        project,
                        &sequence.video_tracks,
                        None,
                        nested,
                        frame,
                        space,
                        titles,
                        live,
                        &nested_scope,
                    )?;
                    return Ok(None);
                }
                let rendered = self.render_tracks(
                    project,
                    &sequence.video_tracks,
                    None,
                    nested,
                    frame,
                    titles,
                    live,
                    &nested_scope,
                )?;
                let working = compute::encode(&self.context, |enc| {
                    crate::video::gpu::frame_to_working(enc, &rendered, space).detach()
                })?;
                (Some(working), self.fresh_id(), Some(time), None)
            }
            _ => {
                let clock = self.video_clock(project, clip, media, &basis, frame)?;
                let info = ffmpeg::MediaInfo {
                    deflicker: timelapse::deflicker(
                        &clock.source,
                        media
                            .timelapse
                            .as_ref()
                            .is_some_and(|timelapse| timelapse.deflicker),
                        clock.reversed,
                    ),
                    ..clock.info.clone()
                };
                let SourceTiming {
                    index,
                    speed,
                    advance,
                    ..
                } = clock.timing;
                let (decode_path, exact, shown) = (&clock.decode_path, clock.exact, clock.shown);
                shutter = shutter_at(shown);
                let footage = shutter.filter(|shutter| shutter.footage && advance > 0.0);
                let key = format!("{}{}", scope, clip.id);
                let shutter_of = |around: Neighbours, shutter| ShutterInput {
                    around,
                    key: key.clone(),
                    advance: advance.abs(),
                    shutter,
                    steady: None,
                };
                let footage_look = look
                    .as_deref()
                    .is_some_and(|look| motion_blur::footage_shutter(&look.json));
                let margin = if footage_look { SOURCE_REACH } else { 0 };
                let plan = self.frame_plan(project, clip, &clock, margin);
                let (picture, time, decoded) = match clock.sample {
                    Sample::Speed => {
                        let request = StreamRequest {
                            path: decode_path,
                            info: &info,
                            source_time: clock.requested(),
                            speed,
                            fps,
                            size: decode,
                            hwaccel: frame.hwaccel,
                            preview: frame.preview,
                            reach: footage
                                .map_or(0, |_| StreamRequest::reach_for(&info, speed, fps)),
                            plan: None,
                        };
                        let picture = self.decoders.frame(&key, &request, index)?;
                        shutter_input = footage.and_then(|shutter| {
                            Some(shutter_of(
                                self.decoders.neighbours(&key, &request, index)?,
                                shutter,
                            ))
                        });
                        (picture, request.source_time, None)
                    }
                    Sample::Nearest => {
                        let (request, source_index) = StreamRequest::source_frames(
                            decode_path,
                            &info,
                            clock.requested(),
                            decode,
                            frame.hwaccel,
                            frame.preview,
                        );
                        let request = request.planned(plan);
                        let picture = self.decoders.frame(&key, &request, source_index)?;
                        shutter_input = footage.and_then(|shutter| {
                            Some(shutter_of(
                                self.decoders.neighbours(&key, &request, source_index)?,
                                shutter,
                            ))
                        });
                        (picture, request.source_time, None)
                    }
                    Sample::Between(mode) => {
                        let (request, source_index) = StreamRequest::source_frames(
                            decode_path,
                            &info,
                            exact,
                            decode,
                            frame.hwaccel,
                            frame.preview,
                        );
                        let request = request.planned(plan);
                        let picture = self.decoders.frame(&key, &request, source_index)?;
                        let bracket = picture
                            .as_ref()
                            .and_then(|_| self.decoders.bracket(&key, &request, exact));
                        let picture = match bracket {
                            Some(Bracket {
                                stream,
                                before,
                                after: Some(after),
                            }) => {
                                shutter_input = footage.map(|shutter| {
                                    shutter_of(
                                        Neighbours {
                                            stream,
                                            key: hash_of((decode_path, exact.to_bits())),
                                            previous: Some(before.clone()),
                                            next: Some(after.clone()),
                                        },
                                        shutter,
                                    )
                                });
                                let slot = before.slot.clone();
                                retime = Some(Retime {
                                    key: key.clone(),
                                    mode,
                                    stream,
                                    frames: [before, after],
                                });
                                Some(Picture { slot, source: None })
                            }
                            Some(Bracket { before, .. }) => {
                                shutter_input = footage.and_then(|shutter| {
                                    Some(shutter_of(
                                        self.decoders.neighbours(&key, &request, source_index)?,
                                        shutter,
                                    ))
                                });
                                Some(Picture {
                                    slot: before.slot,
                                    source: None,
                                })
                            }
                            None => picture,
                        };
                        (picture, exact, Some(exact))
                    }
                };
                let decoded = decoded
                    .or_else(|| picture.as_ref().and_then(|picture| picture.source))
                    .unwrap_or_else(|| clock.requested());
                if scope.is_empty() {
                    self.pictures
                        .insert(clip.id.clone(), (shown.to_bits(), decoded));
                }
                correction = clock.correction(decoded);
                if let Some(input) = shutter_input.as_mut() {
                    input.steady = clock.steady(decoded, &input.around, full);
                }
                live.insert(key);
                (
                    picture.map(|picture| picture.slot),
                    hash_of((
                        (!clip.freeze).then_some(timeline_frame),
                        decode_path,
                        time.to_bits(),
                        clock.sample,
                        &info.deflicker,
                    )),
                    Some(shown),
                    Some(info.source_peak()),
                )
            }
        };
        let Some(source_slot) = source_slot.filter(|_| !self.decoders.warming()) else {
            return Ok(None);
        };
        let layer_key = hash_of((
            &clip.id,
            source_key,
            media.log,
            look.as_ref().map(|look| look.hash),
            look.as_ref()
                .filter(|look| look::is_animated(&look.json))
                .map(|_| timeline_frame),
            source_slot.size,
            frame.output_space.map(|space| space as u32),
            frame.precision,
            frame.preview,
            crate::video::ai_frames::revision(),
        ));
        let layer_key = match &shutter_input {
            Some(input) => hash_of((
                layer_key,
                input.sides(),
                input.advance.to_bits(),
                input.steady.as_ref().map(Steady::key),
            )),
            None => layer_key,
        };
        let cache_key = (kind != MediaKind::Sequence)
            .then(|| CacheKey::Layer(format!("{}{}", scope, clip.id), layer_key));
        let cached = cache_key
            .as_ref()
            .and_then(|key| self.cache.get(key))
            .map(|cached| cached.slot);
        let graded = match cached {
            Some(slot) => slot,
            None => {
                self.decoders.check()?;
                let is_raw = (kind == MediaKind::Image || reference.is_some())
                    && is_raw_file(Path::new(
                        &*parse_virtual_path(look_path).0.to_string_lossy(),
                    ));
                let options = self.options(frame, is_raw);
                let neutral_look = Look {
                    json: Value::Null,
                    hash: 0,
                };
                let maps = match (look.as_deref(), source_time) {
                    (Some(look), Some(time)) if kind == MediaKind::Video && reference.is_none() => {
                        crate::video::ai_maps::overrides(
                            &self.app,
                            project,
                            clip,
                            &parse_virtual_path(path).0,
                            &format!("{}{}", scope, clip.id),
                            &look.json,
                            time,
                            &mut self.missing_maps,
                        )
                    }
                    _ => Vec::new(),
                };
                let source_slot = match &retime {
                    Some(retime) => flow::interpolated(
                        &self.context,
                        self.flows.entry(retime.key.clone()).or_default(),
                        retime.stream,
                        retime.mode,
                        retime.frames.each_ref().map(Neighbour::frame),
                        retime.time(),
                    )?,
                    None => source_slot,
                };
                let source_slot = match &shutter_input {
                    Some(input) => shutter::render(
                        &self.context,
                        self.flows.entry(input.key.clone()).or_default(),
                        &source_slot,
                        input,
                    )?,
                    None => source_slot,
                };
                let source_slot = if is_raw && reference.is_some() {
                    compute::encode(&self.context, |enc| {
                        crate::video::gpu::working_to_linear(enc, &source_slot).detach()
                    })?
                } else {
                    source_slot
                };
                let masks = self
                    .masks
                    .entry(format!("{}{}", scope, clip.id))
                    .or_default();
                let slot = render_look(
                    &self.app,
                    &self.context,
                    &source_slot,
                    layer_key,
                    &LookTarget {
                        path: reference
                            .as_ref()
                            .and_then(|_| timelapse::frame_path(Path::new(path), source_time))
                            .as_deref()
                            .unwrap_or(look_path),
                        is_raw,
                        full_size: full,
                        time: source_time,
                        source_peak: source_peak.filter(|_| reference.is_none()),
                        white_balance: timelapse::white_balance(
                            Path::new(path),
                            source_time,
                            media
                                .timelapse
                                .as_ref()
                                .is_some_and(|timelapse| timelapse.deflicker),
                        ),
                        maps: &maps,
                        follows: &[],
                    },
                    look.as_deref().unwrap_or(&neutral_look),
                    options,
                    frame.precision,
                    masks,
                )?;
                let slot = if transparent {
                    compute::encode(&self.context, |enc| {
                        compose::premultiply(enc, &slot.view, slot.size).detach()
                    })?
                } else {
                    slot
                };
                let slot = match masks.cutout() {
                    Some(cutout) => compute::encode(&self.context, |enc| {
                        compose::cutout(enc, &slot, &cutout.masks, cutout.key).detach()
                    })?,
                    None => slot,
                };
                if let Some(key) = cache_key {
                    self.cache.insert(
                        key,
                        Cached {
                            slot: slot.clone(),
                            transparent: false,
                        },
                    );
                }
                slot
            }
        };
        let correction = correction.and_then(|correction| {
            Self::framing(&basis, source_time, clip.cell_aspect)
                .correction(&stabilizing(&correction, full))
        });
        let graded = match cell_crop(graded.size, clip.cell_aspect) {
            Some((origin, size)) => compute::encode(&self.context, |enc| {
                compose::crop(enc, &graded, origin, size).detach()
            })?,
            None => graded,
        };
        let cut_out = look.as_ref().is_some_and(|look| has_cutout(&look.json));
        let mut layer = item_layer(
            canvas,
            project.settings.fps,
            clip_span(clip, local),
            Visual {
                transform: &clip.transform,
                blend: &clip.blend,
                matte: clip.track_matte,
                motion_blur: shutter.map(|shutter| MotionBlur {
                    shutter: shutter.angle as f64,
                }),
            },
            LayerSource {
                content: (graded.size.0 as f32, graded.size.1 as f32),
                base_scale: fit_scale(canvas, graded.size, clip.fit),
                correction,
                source: Source::Texture(graded),
            },
        );
        self.bind(
            &mut layer,
            project,
            tracks,
            track_index,
            &clip.id,
            ticks,
            frame,
            current,
        );
        Ok(Some(Layer {
            backdrop: clip.fit == FitMode::Blur && !cut_out && clip.transform.pin.is_none(),
            ..layer
        }))
    }

    #[allow(clippy::too_many_arguments)]
    fn collect_ops(
        &mut self,
        project: &VideoProject,
        tracks: &[Track],
        captions: Option<&Captions>,
        ticks: i64,
        frame: &FrameSettings,
        output_space: OutputColorSpace,
        titles: &TitleStore,
        live: &mut HashSet<String>,
        scope: &str,
    ) -> Result<Vec<Op>, String> {
        let mut collected: Vec<(usize, bool, Vec<Op>)> = Vec::new();
        let render_scale = frame.canvas.1 as f32 / project.settings.height.max(1) as f32;
        let mut wanted = false;
        for (track_index, track) in tracks.iter().enumerate() {
            if track.hidden && !std::mem::take(&mut wanted) {
                continue;
            }
            let active: Vec<&Item> = track
                .items
                .iter()
                .filter(|item| {
                    let (start, end) = item.span();
                    ticks >= start && ticks < end
                })
                .collect();
            wanted = active.iter().any(|item| matte_of(item).is_some());
            let slot = collected.len();
            collected.push((track_index, track.hidden, Vec::new()));
            let ops = &mut collected[slot].2;
            if track_index == 0
                && active.len() >= 2
                && let (Item::Clip(from), Item::Clip(to)) = (active[0], active[1])
                && let Some(transition) = to.transition_in
            {
                let overlap = (from.start + from.duration - to.start).max(1);
                let progress = ((ticks - to.start) as f32 / overlap as f32).clamp(0.0, 1.0);
                let from_layer = self.clip_layer(
                    project,
                    tracks,
                    track_index,
                    from,
                    ticks,
                    frame,
                    titles,
                    live,
                    scope,
                )?;
                let to_layer = self.clip_layer(
                    project,
                    tracks,
                    track_index,
                    to,
                    ticks,
                    frame,
                    titles,
                    live,
                    scope,
                )?;
                match (from_layer, to_layer) {
                    (Some(from), Some(to)) => ops.push(Op::Transition {
                        from: Box::new(from),
                        to: Box::new(to),
                        transition,
                        progress,
                    }),
                    (Some(layer), None) | (None, Some(layer)) => {
                        ops.push(Op::Layer(Box::new(layer)))
                    }
                    (None, None) => {}
                }
                continue;
            }
            for item in active {
                match item {
                    Item::Clip(clip) => {
                        if let Some(layer) = self.clip_layer(
                            project,
                            tracks,
                            track_index,
                            clip,
                            ticks,
                            frame,
                            titles,
                            live,
                            scope,
                        )? {
                            ops.push(Op::Layer(Box::new(layer)));
                        }
                    }
                    Item::Title(title) => {
                        let Some(raster) =
                            titles.get(&self.context, &frame.title_keys, &title.id)?
                        else {
                            continue;
                        };
                        let span = MotionSpan {
                            local: ticks - title.start,
                            duration: title.duration,
                            fade_in: title.fade_in,
                            fade_out: title.fade_out,
                            anim_in: title.anim_in,
                            anim_out: title.anim_out,
                            full_frame: false,
                        };
                        let size = raster.glyphs.size;
                        let source = match raster.units.and_then(|units| {
                            span.text_reveal((units.characters, units.words))
                                .map(|edges| (units.map, edges))
                        }) {
                            Some((units, edges)) => Source::Text(Box::new(TextSource {
                                glyphs: raster.glyphs,
                                units,
                                edges,
                            })),
                            None => Source::Overlay(raster.glyphs),
                        };
                        let mut layer = item_layer(
                            frame.canvas,
                            project.settings.fps,
                            span,
                            Visual {
                                transform: &title.transform,
                                blend: &title.blend,
                                matte: title.track_matte,
                                motion_blur: title.motion_blur,
                            },
                            LayerSource {
                                content: (size.0 as f32, size.1 as f32),
                                base_scale: render_scale,
                                correction: None,
                                source,
                            },
                        );
                        self.bind(
                            &mut layer,
                            project,
                            tracks,
                            track_index,
                            &title.id,
                            ticks,
                            frame,
                            None,
                        );
                        ops.push(Op::Layer(Box::new(layer)));
                    }
                    Item::Solid(solid) => {
                        let [r, g, b] = output_color(&solid.color, output_space);
                        let content = cell_crop(frame.canvas, solid.cell_aspect)
                            .map_or(frame.canvas, |(_, size)| size);
                        let mut layer = item_layer(
                            frame.canvas,
                            project.settings.fps,
                            MotionSpan {
                                local: ticks - solid.start,
                                duration: solid.duration,
                                fade_in: solid.fade_in,
                                fade_out: solid.fade_out,
                                anim_in: solid.anim_in,
                                anim_out: solid.anim_out,
                                full_frame: true,
                            },
                            Visual {
                                transform: &solid.transform,
                                blend: &solid.blend,
                                matte: solid.track_matte,
                                motion_blur: solid.motion_blur,
                            },
                            LayerSource {
                                content: (content.0 as f32, content.1 as f32),
                                base_scale: 1.0,
                                correction: None,
                                source: Source::Fill([r, g, b, 1.0]),
                            },
                        );
                        self.bind(
                            &mut layer,
                            project,
                            tracks,
                            track_index,
                            &solid.id,
                            ticks,
                            frame,
                            None,
                        );
                        ops.push(Op::Layer(Box::new(layer)));
                    }
                    Item::Adjustment(adjustment) => {
                        let local = ticks - adjustment.start;
                        let fade = MotionSpan {
                            local,
                            duration: adjustment.duration,
                            fade_in: adjustment.fade_in,
                            fade_out: adjustment.fade_out,
                            anim_in: None,
                            anim_out: None,
                            full_frame: true,
                        }
                        .state()
                        .opacity;
                        let look =
                            self.look(project, frame, &adjustment.id, adjustment.look.as_deref());
                        let follows = match &look {
                            Some(look) => self.mask_follows(
                                project,
                                tracks,
                                track_index,
                                &adjustment.id,
                                &look.json,
                                ticks,
                                frame,
                            ),
                            None => Vec::new(),
                        };
                        ops.push(Op::Adjust {
                            id: adjustment.id.clone(),
                            local,
                            look,
                            opacity: (adjustment.opacity.at(local) as f32 * fade).clamp(0.0, 1.0),
                            follows,
                        });
                    }
                    Item::Audio(_) => {}
                }
            }
        }
        let mut ops = resolve_mattes(collected);
        if let Some(captions) = captions.filter(|captions| captions.enabled) {
            for caption in &captions.items {
                if ticks < caption.start || ticks >= caption.start + caption.duration {
                    continue;
                }
                let Some(slot) = titles
                    .get(&self.context, &frame.title_keys, &caption.id)?
                    .map(|raster| raster.glyphs)
                else {
                    continue;
                };
                let transform = Transform {
                    y: Animated {
                        value: captions.style.y,
                        keys: Vec::new(),
                    },
                    ..Transform::default()
                };
                ops.push(Op::Layer(Box::new(Layer {
                    placed: Placed {
                        canvas_size: frame.canvas,
                        content: (slot.size.0 as f32, slot.size.1 as f32),
                        base_scale: render_scale,
                        transform,
                        span: MotionSpan::STILL,
                        correction: None,
                        follows: Vec::new(),
                    },
                    source: Source::Overlay(slot),
                    blend: BlendMode::Normal,
                    passes: Vec::new(),
                    radius: 0.0,
                    backdrop: false,
                    shutter: 0,
                    matte: None,
                })));
            }
        }
        Ok(ops)
    }

    pub fn prepare(
        &mut self,
        project: &VideoProject,
        frames: &[u64],
        frame: &FrameSettings,
        titles: &TitleStore,
    ) -> Result<bool, String> {
        self.prune(project);
        let output_space = self.options(frame, false).output_space;
        self.unwarmed = false;
        self.decoders.warm(true);
        let collected = frames.iter().try_for_each(|index| {
            self.collect_ops(
                project,
                &project.video_tracks,
                project.captions.as_ref(),
                project.settings.fps.ticks_of(*index as i64),
                frame,
                output_space,
                titles,
                &mut HashSet::new(),
                "",
            )
            .map(|_| ())
        });
        self.decoders.warm(false);
        collected.map(|_| !self.unwarmed)
    }

    pub fn take_missing_maps(&mut self) -> Vec<crate::video::ai_maps::Block> {
        std::mem::take(&mut self.missing_maps)
    }

    pub fn render(
        &mut self,
        project: &VideoProject,
        frame_index: u64,
        frame: &FrameSettings,
        titles: &TitleStore,
    ) -> Result<Slot, String> {
        self.prune(project);
        let ticks = project.settings.fps.ticks_of(frame_index as i64);
        let mut live = HashSet::new();
        self.missing_maps.clear();
        let slot = self.render_tracks(
            project,
            &project.video_tracks,
            project.captions.as_ref(),
            ticks,
            frame,
            titles,
            &mut live,
            "",
        )?;
        self.decoders.retain(&live);
        self.flows.retain(|key, _| live.contains(key));
        Ok(slot)
    }

    #[allow(clippy::too_many_arguments)]
    fn render_tracks(
        &mut self,
        project: &VideoProject,
        tracks: &[Track],
        captions: Option<&Captions>,
        ticks: i64,
        frame: &FrameSettings,
        titles: &TitleStore,
        live: &mut HashSet<String>,
        scope: &str,
    ) -> Result<Slot, String> {
        let options = self.options(frame, false);
        let ops = self.collect_ops(
            project,
            tracks,
            captions,
            ticks,
            frame,
            options.output_space,
            titles,
            live,
            scope,
        )?;
        let effect_scale = frame.canvas.1 as f32 / 1080.0;
        let [r, g, b] = output_color(&project.settings.background, options.output_space);
        let canvas_size = frame.canvas;
        let overlay_space =
            Some(options.output_space).filter(|space| *space != OutputColorSpace::Srgb);
        let mut canvas = compute::encode(&self.context, |enc| {
            compose::fill(enc, canvas_size, [r, g, b, 1.0]).detach()
        })?;
        let mut pending: Vec<Op> = Vec::new();
        let luma = options.output_space.rgb().luma().as_vec3().to_array();
        let flush = |canvas: &Slot, ops: Vec<Op>, context: &GpuContext| -> Result<Slot, String> {
            if ops.is_empty() {
                return Ok(canvas.clone());
            }
            let painter = Painter {
                context,
                canvas: canvas_size,
                effect_scale,
                overlay_space,
                luma,
            };
            compute::encode(context, |enc| {
                let mut current: Option<compute::Tex> = None;
                for op in &ops {
                    let base = current.as_deref().unwrap_or(canvas).clone();
                    let next = match op {
                        Op::Layer(layer) => {
                            let Some(drawn) = painter.draw(enc, &base, layer, layer.blend) else {
                                continue;
                            };
                            drawn
                        }
                        Op::Transition {
                            from,
                            to,
                            transition,
                            progress,
                        } => {
                            let clear = compose::fill(enc, canvas_size, [0.0; 4]);
                            let isolate = |enc: &mut compute::ComputeEncoder, layer: &Layer| {
                                painter
                                    .draw(enc, &clear, layer, BlendMode::Normal)
                                    .unwrap_or_else(|| compose::fill(enc, canvas_size, [0.0; 4]))
                            };
                            let from_canvas = isolate(enc, from);
                            let to_canvas = isolate(enc, to);
                            let mixed = compose::transition(
                                enc,
                                &from_canvas,
                                &to_canvas,
                                *transition,
                                *progress,
                                effect_scale,
                            );
                            compose::composite(
                                enc,
                                &base,
                                &mixed,
                                &Placement::fit(canvas_size, canvas_size),
                            )
                        }
                        Op::Adjust { .. } => continue,
                    };
                    current = Some(next);
                }
                current.map_or_else(|| canvas.clone(), |tex| tex.detach())
            })
        };
        for op in ops {
            match op {
                Op::Adjust {
                    id,
                    local,
                    look,
                    opacity,
                    follows,
                } => {
                    canvas = flush(&canvas, std::mem::take(&mut pending), &self.context)?;
                    if opacity <= 0.0 {
                        continue;
                    }
                    let graded = match &look {
                        Some(look) => {
                            let canvas_id = self.fresh_id();
                            let working = compute::encode(&self.context, |enc| {
                                crate::video::gpu::frame_to_working(
                                    enc,
                                    &canvas,
                                    options.output_space,
                                )
                                .detach()
                            })?;
                            let masks = self.masks.entry(format!("adjust:{}", id)).or_default();
                            render_look(
                                &self.app,
                                &self.context,
                                &working,
                                canvas_id,
                                &LookTarget {
                                    path: "adjustment-layer",
                                    is_raw: false,
                                    full_size: canvas_size,
                                    time: Some(seconds(local.max(0))),
                                    source_peak: None,
                                    white_balance: None,
                                    maps: &[],
                                    follows: &follows,
                                },
                                look,
                                options,
                                frame.precision,
                                masks,
                            )?
                        }
                        None => canvas.clone(),
                    };
                    canvas = compute::encode(&self.context, |enc| {
                        let placement = Placement {
                            opacity,
                            ..Placement::fit(canvas_size, graded.size)
                        };
                        compose::composite(enc, &canvas, &graded, &placement).detach()
                    })?;
                }
                other => pending.push(other),
            }
        }
        flush(&canvas, pending, &self.context)
    }
}

struct Painter<'a> {
    context: &'a GpuContext,
    canvas: (u32, u32),
    effect_scale: f32,
    overlay_space: Option<OutputColorSpace>,
    luma: [f32; 3],
}

impl Painter<'_> {
    fn texture(&self, enc: &mut compute::ComputeEncoder, layer: &Layer) -> Option<Slot> {
        let overlay = |enc: &mut compute::ComputeEncoder, slot: &Slot| match self.overlay_space {
            Some(space) => crate::video::gpu::overlay_to_output(enc, slot, space).detach(),
            None => slot.clone(),
        };
        let base = match &layer.source {
            Source::Texture(slot) => slot.clone(),
            Source::Overlay(slot) => overlay(enc, slot),
            Source::Text(text) => {
                let revealed =
                    compose::text_reveal(enc, &text.glyphs, &text.units, text.edges).detach();
                overlay(enc, &revealed)
            }
            Source::Fill(rgba) => {
                let (width, height) = layer.placed.content;
                compose::fill(enc, (width.round() as u32, height.round() as u32), *rgba).detach()
            }
        };
        let mut current = base;
        if layer.radius > 0.0 {
            let window = compose::fit_window(self.canvas, current.size, layer.placed.base_scale);
            if let Some(rounded) = compose::round(enc, &current, layer.radius, window) {
                current = rounded.detach();
            }
        }
        for pass in &layer.passes {
            if let Some(next) = compose::layer_pass(enc, &current, *pass, self.effect_scale) {
                current = next.detach();
            }
        }
        (layer.placed.motion(0).opacity > 0.0).then_some(current)
    }

    fn place(
        &self,
        enc: &mut compute::ComputeEncoder,
        base: &Slot,
        content: &Slot,
        layer: &Layer,
        frame: bool,
        blend: BlendMode,
    ) -> compute::Tex {
        let at = |offset: i64| {
            if frame {
                layer.placed.frame_placement(offset, blend)
            } else {
                layer.placed.placement(offset, blend)
            }
        };
        if layer.shutter == 0 {
            return compose::composite(enc, base, content, &at(0));
        }
        let open = -layer.shutter / 2;
        let blurs = self
            .context
            .motion_blur
            .get_or_init(|| MotionBlurPipelines::new(&self.context.device));
        compose::blurred_composite(
            enc,
            blurs,
            base,
            content,
            [at(open), at(0), at(open + layer.shutter)],
        )
    }

    fn paint(
        &self,
        enc: &mut compute::ComputeEncoder,
        base: &Slot,
        layer: &Layer,
        blend: BlendMode,
    ) -> Option<compute::Tex> {
        let content = self.texture(enc, layer)?;
        let backdrop = match &layer.source {
            Source::Texture(slot) if layer.backdrop => {
                let frame = compose::backdrop(enc, self.canvas, slot);
                Some(self.place(enc, base, &frame, layer, true, blend))
            }
            _ => None,
        };
        Some(self.place(
            enc,
            backdrop.as_deref().unwrap_or(base),
            &content,
            layer,
            false,
            blend,
        ))
    }

    fn draw(
        &self,
        enc: &mut compute::ComputeEncoder,
        base: &Slot,
        layer: &Layer,
        blend: BlendMode,
    ) -> Option<compute::Tex> {
        let Some(matte) = &layer.matte else {
            return self.paint(enc, base, layer, blend);
        };
        if matte.layers.is_empty() {
            return matte
                .setting
                .invert
                .then(|| self.paint(enc, base, layer, blend))
                .flatten();
        }
        let clear = compose::fill(enc, self.canvas, [0.0; 4]);
        let mut shape: Option<compute::Tex> = None;
        for source in matte.layers.iter() {
            let below = shape.as_deref().unwrap_or(&clear).clone();
            if let Some(next) = self.draw(enc, &below, source, source.blend) {
                shape = Some(next);
            }
        }
        let isolated = self.paint(enc, &clear, layer, BlendMode::Normal)?;
        let source = match matte.setting.kind {
            MatteKind::Alpha => compose::MatteSource::Alpha,
            MatteKind::Luma => compose::MatteSource::Luma(self.luma),
        };
        Some(compose::matte(
            enc,
            base,
            &isolated,
            compose::Matte {
                shape: shape.as_deref().unwrap_or(&clear),
                source,
                invert: matte.setting.invert,
            },
            blend,
        ))
    }
}
