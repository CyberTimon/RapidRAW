use std::path::Path;
use std::sync::Arc;

use image::DynamicImage;
use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::effects::motion_blur::{self, MotionBlurPipelines, Shutter};
use crate::render::gpu::compute::{self, Grid, IMAGE_FORMAT, Out, Slot, Tex};
use crate::render::gpu::context::GpuContext;
use crate::video::VideoState;
use crate::video::ffmpeg::MediaInfo;

use super::decode::{Neighbour, Neighbours, StreamRequest};
use super::flow::{self, FlowCache, Frame, Params, base_size, fitted};

const SELECT_LONGEST: f32 = 2048.0;
const FAR_CANDIDATE: u32 = 4;
const FRONT_REACH: f32 = 0.06;
const FULL_TURN: f32 = 360.0;
const TRUST_NOISE: f32 = 1.0e-3;
const FILL_GAIN: f32 = 4.0;
const FILL_SIDE: u32 = 4;
const STILL_REACH: u64 = 1;
const STILL_KEY: &str = "still";

struct Field {
    blur: Tex,
    front: Tex,
}

fn trusted(enc: &mut compute::ComputeEncoder, steps: &Tex, gradient: &Slot) -> Tex {
    let size = steps.size;
    let trust = enc.texture("Flow Trust", size, wgpu::TextureFormat::Rgba32Float);
    flow::run(
        enc,
        "fl_trust",
        Params {
            values: [[TRUST_NOISE, 0.0, 0.0, 0.0], [0.0; 4]],
            ..Params::new(size)
        },
        &[&steps.view, &gradient.view],
        Out::F32(&trust.view),
    );
    let mut levels = vec![trust];
    loop {
        let size = levels[levels.len() - 1].size;
        let next = (size.0.div_ceil(2), size.1.div_ceil(2));
        if next.0.min(next.1) < FILL_SIDE {
            break;
        }
        let pulled = enc.texture("Flow Pull", next, wgpu::TextureFormat::Rgba32Float);
        flow::run(
            enc,
            "fl_pull",
            Params::new(next),
            &[&levels[levels.len() - 1].view],
            Out::F32(&pulled.view),
        );
        levels.push(pulled);
    }
    let mut coarse: Option<Tex> = None;
    for (index, level) in levels.iter().enumerate().rev() {
        let pushed = enc.texture("Flow Push", level.size, wgpu::TextureFormat::Rgba32Float);
        flow::run(
            enc,
            "fl_push",
            Params {
                values: [[0.0, FILL_GAIN, 0.0, 0.0], [0.0; 4]],
                modes: [coarse.is_some() as u32, (index == 0) as u32, 0, 0],
                ..Params::new(level.size)
            },
            &[
                &level.view,
                &coarse.as_ref().unwrap_or(level).view,
                &steps.view,
            ],
            Out::F32(&pushed.view),
        );
        coarse = Some(pushed);
    }
    coarse.expect("the fill has at least one level")
}

fn field(
    enc: &mut compute::ComputeEncoder,
    current: &Slot,
    gradient: &Slot,
    [previous, next]: [Option<&Slot>; 2],
    [behind, ahead]: [Option<&Slot>; 2],
    [back_rate, ahead_rate]: [f32; 2],
    exposure: f32,
) -> Field {
    let base = base_size(current.size);
    let ratio = current.size.0 as f32 / base.0 as f32;
    let scale = exposure * ratio;
    let reach = |rate: f32| if rate > 0.0 { ratio / rate } else { 0.0 };
    let modes = [ahead.is_some() as u32, behind.is_some() as u32, 0, 0];
    let dummy = &current.view;
    let measured = enc.texture("Flow Field", base, wgpu::TextureFormat::Rgba32Float);
    flow::run(
        enc,
        "fl_field",
        Params {
            values: [[ahead_rate, back_rate, 0.0, 0.0], [0.0; 4]],
            modes,
            ..Params::new(base)
        },
        &[
            ahead.map_or(dummy, |slot| &slot.view),
            behind.map_or(dummy, |slot| &slot.view),
        ],
        Out::F32(&measured.view),
    );
    let steps = trusted(enc, &measured, gradient);
    let front = enc.texture("Flow Front", base, IMAGE_FORMAT);
    flow::run(
        enc,
        "fl_front",
        Params {
            values: [
                [scale, FRONT_REACH * base.0.max(base.1) as f32, 0.0, 0.0],
                [0.0; 4],
            ],
            ..Params::new(base)
        },
        &[&steps.view],
        Out::F16(&front.view),
    );
    let size = fitted(current.size, SELECT_LONGEST);
    let select = Params {
        grid: Grid {
            radius: FAR_CANDIDATE,
            ..Grid::new(size)
        },
        values: [
            [scale, reach(ahead_rate), reach(back_rate), 0.0],
            [current.size.0 as f32 / size.0 as f32, 0.0, 0.0, 0.0],
        ],
        modes,
    };
    let selected = enc.texture("Flow Selected", size, IMAGE_FORMAT);
    flow::run(
        enc,
        "fl_select",
        select,
        &[
            &current.view,
            next.map_or(dummy, |slot| &slot.view),
            previous.map_or(dummy, |slot| &slot.view),
            &steps.view,
            &measured.view,
        ],
        Out::F16(&selected.view),
    );
    let blur = enc.texture("Flow Blur", size, IMAGE_FORMAT);
    flow::run(
        enc,
        "fl_clean",
        select,
        &[&selected.view, dummy, dummy, &steps.view],
        Out::F16(&blur.view),
    );
    Field { blur, front }
}

pub struct ShutterInput {
    pub key: String,
    pub around: Neighbours,
    pub advance: f64,
    pub shutter: Shutter,
}

impl ShutterInput {
    pub fn sides(&self) -> (bool, bool) {
        (self.around.previous.is_some(), self.around.next.is_some())
    }
}

pub fn render(
    context: &GpuContext,
    cache: &mut FlowCache,
    current: &Slot,
    frame: &ShutterInput,
) -> Result<Slot, String> {
    let around = &frame.around;
    let keys: Vec<u64> = [around.previous.as_ref(), around.next.as_ref()]
        .into_iter()
        .flatten()
        .map(|neighbour| neighbour.key)
        .chain([around.key])
        .collect();
    cache.follow(around.stream, &keys);
    let pipelines = context
        .motion_blur
        .get_or_init(|| MotionBlurPipelines::new(&context.device));
    let result = compute::encode(context, |enc| {
        let centre = Frame {
            key: around.key,
            slot: current,
        };
        let behind = around
            .previous
            .as_ref()
            .map(|previous| cache.between(enc, previous.frame(), centre).field);
        let ahead = around
            .next
            .as_ref()
            .map(|next| cache.between(enc, centre, next.frame()).field);
        let rate = |neighbour: Option<&Neighbour>| {
            neighbour.map_or(0.0, |neighbour| {
                (frame.advance / neighbour.gap.max(f64::EPSILON)) as f32
            })
        };
        let gradient = cache.gradient(enc, centre);
        let Field { blur, front } = field(
            enc,
            current,
            &gradient,
            [
                around.previous.as_ref().map(|previous| &previous.slot),
                around.next.as_ref().map(|next| &next.slot),
            ],
            [behind.as_ref(), ahead.as_ref()],
            [rate(around.previous.as_ref()), rate(around.next.as_ref())],
            frame.shutter.angle / FULL_TURN,
        );
        let size = current.size;
        let views = [0, 1, 2].map(|_| enc.texture("Shutter Blur", size, IMAGE_FORMAT));
        motion_blur::shutter_blur(
            pipelines,
            enc.device,
            &mut enc.encoder,
            &current.view,
            [&blur.view, &front.view],
            [&views[0].view, &views[1].view, &views[2].view],
            size,
            frame.shutter.highlights,
        );
        let [_, _, output] = views;
        output.detach()
    });
    if result.is_err() {
        *cache = FlowCache::default();
    }
    result
}

#[derive(Deserialize)]
pub struct StillShutter {
    look: Value,
    advance: f64,
}

pub fn still(
    app: &AppHandle,
    path: &Path,
    info: &MediaInfo,
    time: f64,
    request: &StillShutter,
) -> Result<Option<Arc<DynamicImage>>, String> {
    let Some(shutter) = motion_blur::shutter(&request.look)
        .filter(|shutter| shutter.footage && request.advance > 0.0)
    else {
        return Ok(None);
    };
    let video = app.state::<VideoState>();
    let mut lease = video.batch(app)?;
    let engine = &mut *lease;
    let key = STILL_KEY.to_string();
    let (stream, index) =
        StreamRequest::source_frames(path, info, time, (info.width, info.height), true, false);
    let stream = StreamRequest {
        reach: STILL_REACH,
        ..stream
    };
    let Some(current) = engine.decoders.frame(&key, &stream, index)? else {
        return Ok(None);
    };
    let Some(around) = engine.decoders.neighbours(&key, &stream, index) else {
        return Ok(None);
    };
    let input = ShutterInput {
        key: key.clone(),
        around,
        advance: request.advance,
        shutter,
    };
    let slot = render(
        &engine.context,
        engine.flows.entry(key).or_default(),
        &current,
        &input,
    )?;
    let image = crate::video::gpu::slot_image(&engine.context, &slot)?;
    compute::register_upload(&engine.context, &image, slot);
    Ok(Some(image))
}
