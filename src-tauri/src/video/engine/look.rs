use std::sync::{Arc, Mutex};

use image::{GrayImage, Luma};
use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};
use wgpu::util::DeviceExt;

use crate::adjustments::lut_processing::get_or_load_lut;
use crate::ai::commands::png_data_url;
use crate::app::state::AppState;
use crate::decode::as_shot::as_shot;
use crate::decode::white_balance::WhiteBalance;
use crate::effects::motion_blur::{Shutter, shutter};
use crate::masks::generation::MaskDefinition;
use crate::render::adjustment_utils::hydrate_adjustments;
use crate::render::gpu::compute::Slot;
use crate::render::gpu::context::GpuContext;
use crate::render::gpu::output::{MaskPass, process_to_texture};
use crate::render::gpu::processor::{RenderOutputPrecision, RenderRequest};
use crate::render::options::RenderOptions;
use crate::render::source::{RenderSource, SourceTransform};
use crate::render::uniforms::get_all_adjustments_from_json;
use crate::video::compose::ColorKey;
use crate::video::engine::range_masks::{self, MaskSpace, RangeMasks};
use crate::video::hash_of;
use crate::video::model::{Animated, Keyframe, TICKS_PER_SECOND};
use crate::video::tracking::{Follow, MotionTrack, TrackWarp};
use crate::video::vision::Homography;

pub struct Look {
    pub json: Value,
    pub hash: u64,
}

impl Look {
    pub fn new(app_handle: &AppHandle, mut json: Value) -> Self {
        let state = app_handle.state::<AppState>();
        hydrate_adjustments(&state, &mut json);
        Self {
            hash: hash_of(json.to_string()),
            json,
        }
    }
}

pub struct Cutout {
    pub masks: wgpu::TextureView,
    pub key: Option<ColorKey>,
}

#[derive(Default)]
pub struct MaskCache {
    key: u64,
    bitmaps: Arc<Vec<GrayImage>>,
    cutout: Option<Cutout>,
    ranges: Option<RangeMasks>,
}

impl MaskCache {
    pub fn cutout(&self) -> Option<&Cutout> {
        self.cutout.as_ref()
    }
}

fn is_cutout(mask: &Value) -> bool {
    mask["cutout"].as_bool() == Some(true)
}

fn hue_of([r, g, b]: [f32; 3]) -> f32 {
    let max = r.max(g).max(b);
    let delta = max - r.min(g).min(b);
    if delta <= 0.0 {
        0.0
    } else if max == r {
        60.0 * ((g - b) / delta).rem_euclid(6.0)
    } else if max == g {
        60.0 * ((b - r) / delta + 2.0)
    } else {
        60.0 * ((r - g) / delta + 4.0)
    }
}

fn color_key(mask: &Value) -> Option<ColorKey> {
    let key = mask.get("key").filter(|key| key.is_object())?;
    let unit = |name: &str, default: f64| {
        (key[name].as_f64().unwrap_or(default) / 100.0).clamp(0.0, 1.0) as f32
    };
    Some(ColorKey {
        hue: hue_of(super::hex_color(key["color"].as_str()?)),
        tolerance: unit("tolerance", 50.0),
        softness: unit("softness", 10.0),
        spill: unit("spill", 50.0),
    })
}

pub fn has_cutout(json: &Value) -> bool {
    json["masks"].as_array().is_some_and(|masks| {
        masks
            .iter()
            .any(|mask| is_cutout(mask) && mask["visible"] != false)
    })
}

fn upload_masks(
    context: &GpuContext,
    (width, height): (u32, u32),
    plain: Option<&GrayImage>,
    keyed: Option<&GrayImage>,
) -> wgpu::TextureView {
    let level =
        |mask: Option<&GrayImage>, index: usize| mask.map_or(0, |mask| mask.as_raw()[index]);
    let data: Vec<u8> = (0..width as usize * height as usize)
        .flat_map(|index| [level(plain, index), level(keyed, index)])
        .collect();
    context
        .device
        .create_texture_with_data(
            &context.queue,
            &wgpu::TextureDescriptor {
                label: Some("Video Cutout"),
                size: wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rg8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::MipMajor,
            &data,
        )
        .create_view(&Default::default())
}

fn union(bitmaps: Vec<&GrayImage>) -> Option<GrayImage> {
    let (first, rest) = bitmaps.split_first()?;
    let mut alpha = (*first).clone();
    for bitmap in rest {
        alpha
            .iter_mut()
            .zip(bitmap.iter())
            .for_each(|(pixel, other)| *pixel = (*pixel).max(*other));
    }
    Some(alpha)
}

pub struct LookTarget<'a> {
    pub path: &'a str,
    pub is_raw: bool,
    pub full_size: (u32, u32),
    pub time: Option<f64>,
    pub source_peak: Option<f32>,
    pub white_balance: Option<WhiteBalance>,
    pub maps: &'a [(&'static str, String)],
    pub follows: &'a [(String, Follow)],
}

enum MaskWarp {
    Similar(TrackWarp),
    Plane(Homography),
}

impl MaskWarp {
    fn of(follow: Follow) -> Option<Self> {
        follow
            .plane
            .map(Self::Plane)
            .or_else(|| follow.similar.map(Self::Similar))
    }

    fn point(&self, x: f64, y: f64) -> (f64, f64) {
        match self {
            Self::Similar(warp) => warp.map(x, y),
            Self::Plane(plane) => plane.apply([x, y]).map_or((x, y), |[px, py]| (px, py)),
        }
    }

    fn handle(&self, x: f64, y: f64, dx: f64, dy: f64) -> (f64, f64) {
        match self {
            Self::Similar(warp) => warp.turn(dx, dy),
            Self::Plane(_) => {
                let (ax, ay) = self.point(x, y);
                let (hx, hy) = self.point(x + dx, y + dy);
                (hx - ax, hy - ay)
            }
        }
    }

    fn scale_at(&self, x: f64, y: f64) -> f64 {
        match self {
            Self::Similar(warp) => warp.scale,
            Self::Plane(plane) => plane.local_scale([x, y]),
        }
    }

    fn pair(parameters: &Value, x: &str, y: &str) -> Option<(f64, f64)> {
        Some((parameters.get(x)?.as_f64()?, parameters.get(y)?.as_f64()?))
    }

    fn map_fields(&self, parameters: &mut Value, x: &str, y: &str) {
        if let Some((px, py)) = Self::pair(parameters, x, y) {
            let (mx, my) = self.point(px, py);
            parameters[x] = mx.into();
            parameters[y] = my.into();
        }
    }

    fn scale_field(parameters: &mut Value, name: &str, scale: f64) {
        if let Some(value) = parameters.get(name).and_then(Value::as_f64) {
            parameters[name] = (value * scale).into();
        }
    }

    fn map_shape(&self, parameters: &mut Value) {
        match self {
            Self::Similar(warp) => {
                self.map_fields(parameters, "centerX", "centerY");
                for size in ["radiusX", "radiusY", "width", "height"] {
                    Self::scale_field(parameters, size, warp.scale);
                }
                let rotation = parameters
                    .get("rotation")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                parameters["rotation"] = (rotation + warp.degrees).into();
            }
            Self::Plane(plane) => {
                let center = Self::pair(parameters, "centerX", "centerY").unwrap_or_default();
                let side = plane.depth([center.0, center.1]).signum();
                if let Some(inverse) = plane.inverse() {
                    let unit = side / inverse.determinant().abs().cbrt();
                    parameters["inversePlane"] =
                        inverse.0.map(|value| value * unit).to_vec().into();
                }
            }
        }
    }

    fn apply(&self, sub_mask: &mut Value) {
        let kind = sub_mask
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let Some(parameters) = sub_mask.get_mut("parameters") else {
            return;
        };
        match kind.as_str() {
            "radial" | "rectangle" => self.map_shape(parameters),
            "linear" => {
                let (x, y) = Self::pair(parameters, "startX", "startY").unwrap_or_default();
                Self::scale_field(parameters, "range", self.scale_at(x, y));
                self.map_fields(parameters, "startX", "startY");
                self.map_fields(parameters, "endX", "endY");
            }
            "pen" => {
                if let Some(points) = parameters.get_mut("points").and_then(Value::as_array_mut) {
                    for point in points {
                        let (x, y) = Self::pair(point, "x", "y").unwrap_or_default();
                        for (dx, dy) in [("inX", "inY"), ("outX", "outY")] {
                            if let Some((hx, hy)) = Self::pair(point, dx, dy) {
                                let (mx, my) = self.handle(x, y, hx, hy);
                                point[dx] = mx.into();
                                point[dy] = my.into();
                            }
                        }
                        self.map_fields(point, "x", "y");
                    }
                }
            }
            _ => {
                if let Some(lines) = parameters.get_mut("lines").and_then(Value::as_array_mut) {
                    for line in lines {
                        let first = line["points"]
                            .get(0)
                            .and_then(|point| Self::pair(point, "x", "y"))
                            .unwrap_or_default();
                        Self::scale_field(line, "brushSize", self.scale_at(first.0, first.1));
                        if let Some(points) = line.get_mut("points").and_then(Value::as_array_mut) {
                            for point in points {
                                self.map_fields(point, "x", "y");
                            }
                        }
                    }
                }
            }
        }
    }
}

fn path_mut<'a>(json: &'a mut Value, path: &str) -> Option<&'a mut Value> {
    path.split('.')
        .try_fold(json, |node, segment| match segment.strip_prefix('#') {
            Some(id) => node
                .as_array_mut()?
                .iter_mut()
                .find(|entry| entry["id"].as_str() == Some(id)),
            None => node.get_mut(segment),
        })
}

pub fn is_animated(json: &Value) -> bool {
    json["animation"]
        .as_object()
        .is_some_and(|channels| !channels.is_empty())
}

pub(crate) fn animate_look(json: &Value, time: f64) -> Option<Value> {
    if !is_animated(json) {
        return None;
    }
    let ticks = (time * TICKS_PER_SECOND as f64).round() as i64;
    let mut look = json.clone();
    for (path, keys) in json["animation"].as_object()? {
        let Ok(keys) = serde_json::from_value::<Vec<Keyframe>>(keys.clone()) else {
            continue;
        };
        if let Some(slot) = path_mut(&mut look, path).filter(|slot| slot.is_number()) {
            *slot = Animated { value: 0.0, keys }.at(ticks).into();
        }
    }
    Some(look)
}

pub fn shutter_at(look: &Look, time: Option<f64>) -> Option<Shutter> {
    let animated = time.and_then(|time| animate_look(&look.json, time));
    shutter(animated.as_ref().unwrap_or(&look.json))
}

fn sub_masks(mask: &Value) -> impl Iterator<Item = &Value> {
    mask["subMasks"].as_array().into_iter().flatten()
}

pub fn masks_at(
    app: &AppHandle,
    path: &str,
    json: &Value,
    time: f64,
    size: (u32, u32),
) -> Option<Value> {
    masks_following(app, path, json, time, size, &[])
}

fn masks_following(
    app: &AppHandle,
    path: &str,
    json: &Value,
    time: f64,
    size: (u32, u32),
    follows: &[(String, Follow)],
) -> Option<Value> {
    let masks = json.get("masks")?.as_array()?;
    let depth = crate::video::ai_maps::has_depth_masks(json)
        .then(|| crate::video::ai_maps::depth_frame(app, path, time))
        .flatten()
        .map(|(png, width)| (png_data_url(&png), width as f64 / size.0.max(1) as f64));
    let animated = depth.is_some()
        || masks.iter().any(|mask| {
            mask.get("track").is_some_and(|track| !track.is_null())
                || sub_masks(mask).any(|sub_mask| sub_mask["parameters"]["sequence"].is_string())
        });
    if !animated {
        return None;
    }
    let turned = json["orientationSteps"].as_u64().unwrap_or(0) % 2 == 1;
    let frame = if turned {
        (size.1 as f64, size.0 as f64)
    } else {
        (size.0 as f64, size.1 as f64)
    };
    let mut masks = masks.clone();
    for mask in &mut masks {
        let resolved = mask["id"]
            .as_str()
            .and_then(|id| follows.iter().find(|(key, _)| key == id))
            .map(|(_, follow)| follow.clone());
        let warp = resolved
            .or_else(|| {
                mask.get("track")
                    .and_then(|track| MotionTrack::deserialize(track).ok())
                    .and_then(|track| track.follow(time, frame))
            })
            .and_then(MaskWarp::of);
        let Some(sub_masks) = mask.get_mut("subMasks").and_then(Value::as_array_mut) else {
            continue;
        };
        for sub_mask in sub_masks {
            if let Some(warp) = &warp {
                warp.apply(sub_mask);
            }
            let sequenced = sub_mask["parameters"]["sequence"]
                .as_str()
                .and_then(|id| crate::video::ai_masks::mask_at(app, id, time));
            if let Some(data) = sequenced {
                sub_mask["parameters"]["maskDataBase64"] = Value::String(data);
            }
            if let Some((data, scale)) = depth
                .as_ref()
                .filter(|_| sub_mask["type"] == crate::video::ai_maps::DEPTH_MASK)
            {
                sub_mask["parameters"]["maskDataBase64"] = Value::String(data.clone());
                sub_mask["parameters"]["maskScale"] = (*scale).into();
            }
        }
    }
    Some(Value::Array(masks))
}

#[allow(clippy::too_many_arguments)]
pub fn render_look(
    app_handle: &AppHandle,
    context: &GpuContext,
    source: &Slot,
    frame_id: u64,
    target: &LookTarget,
    look: &Look,
    options: RenderOptions,
    precision: RenderOutputPrecision,
    masks: &mut MaskCache,
) -> Result<Slot, String> {
    let state = app_handle.state::<AppState>();
    let animated = target.time.and_then(|time| animate_look(&look.json, time));
    let mapped = (!target.maps.is_empty()).then(|| {
        let mut json = animated.clone().unwrap_or_else(|| look.json.clone());
        for (key, map) in target.maps {
            json[*key] = Value::String(map.clone());
        }
        json
    });
    let json = mapped.as_ref().or(animated.as_ref()).unwrap_or(&look.json);
    let base_scale = source.size.0 as f32 / target.full_size.0.max(1) as f32;
    let render_source = RenderSource::gpu(
        source,
        frame_id,
        json,
        SourceTransform::from_adjustments(target.path, json),
    )
    .scaled(base_scale);
    let crop_offset = render_source.crop_offset();
    let (width, height) = render_source.size();

    let tracked = target.time.and_then(|time| {
        masks_following(
            app_handle,
            target.path,
            json,
            time,
            target.full_size,
            target.follows,
        )
    });
    let mask_key = hash_of((
        look.hash,
        width,
        height,
        base_scale.to_bits(),
        tracked
            .as_ref()
            .or(animated.as_ref().map(|json| &json["masks"]))
            .map(Value::to_string),
    ));
    if masks.key != mask_key {
        let source = tracked.as_ref().or_else(|| json.get("masks"));
        let definitions: Vec<MaskDefinition> = source
            .and_then(|value| serde_json::from_value(value.clone()).ok())
            .unwrap_or_default();
        let (generated, mut ranges) = range_masks::generate(
            context,
            &definitions,
            MaskSpace {
                size: (width, height),
                scale: base_scale,
                crop_offset,
            },
        );
        let containers = source
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice);
        let (mut plain, mut keyed, mut whole, mut key) = (Vec::new(), Vec::new(), false, None);
        let mut per_frame = (0u32, 0u32);
        for (index, ((definition, json), bitmap)) in definitions
            .iter()
            .zip(containers)
            .zip(&generated)
            .enumerate()
        {
            if !is_cutout(json) {
                continue;
            }
            let bit = ranges
                .as_ref()
                .and_then(|ranges| ranges.layer_of(index))
                .map_or(0, |layer| 1 << layer);
            match (color_key(json), bitmap) {
                (Some(found), Some(bitmap)) => {
                    key = key.or(Some(found));
                    keyed.push(bitmap);
                    per_frame.1 |= bit;
                }
                (Some(found), None) if definition.visible && definition.sub_masks.is_empty() => {
                    key = key.or(Some(found));
                    whole = true;
                }
                (None, Some(bitmap)) => {
                    plain.push(bitmap);
                    per_frame.0 |= bit;
                }
                _ => {}
            }
        }
        let plain = union(plain);
        let keyed = if whole {
            Some(GrayImage::from_pixel(width, height, Luma([255])))
        } else {
            union(keyed)
        };
        masks.cutout = (plain.is_some() || keyed.is_some()).then(|| {
            let base = upload_masks(context, (width, height), plain.as_ref(), keyed.as_ref());
            Cutout {
                masks: match ranges.as_mut().filter(|_| per_frame != (0, 0)) {
                    Some(ranges) => ranges.cut_out(context, base, per_frame),
                    None => base,
                },
                key: keyed.as_ref().and(key),
            }
        });
        masks.bitmaps = Arc::new(generated.into_iter().flatten().collect());
        masks.ranges = ranges;
        masks.key = mask_key;
    }

    let lut = json["lutPath"]
        .as_str()
        .and_then(|path| get_or_load_lut(&state, path).ok());
    let mut shot = as_shot(target.path);
    if let Some(peak) = target.source_peak {
        shot.source_peak = peak;
    }
    if let Some(white_balance) = target.white_balance {
        shot.white_balance = white_balance;
    }
    let mut adjustments = get_all_adjustments_from_json(json, target.is_raw, shot, options);
    adjustments.global.show_clipping = 0;
    let bitmaps = Arc::clone(&masks.bitmaps);
    let ranges = masks.ranges.as_ref().map(|ranges| {
        move |input: &wgpu::TextureView, mask_view: &wgpu::TextureView| {
            ranges.encode(context, input, mask_view)
        }
    });
    process_to_texture(
        context,
        &state,
        &render_source,
        RenderRequest {
            adjustments,
            mask_bitmaps: &bitmaps,
            mask_cache_key: Some(mask_key),
            lut,
            roi: None,
            hsl_probe: false,
            motion_blur: crate::effects::motion_blur::MotionBlurs::new(
                target.path,
                json,
                (width, height),
                crop_offset,
                target.full_size.0.max(target.full_size.1) as f32 * base_scale,
            ),
        },
        "video_engine",
        precision,
        ranges.as_ref().map(|pass| pass as &MaskPass),
        &Mutex::new(None),
    )
}
