use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::PathBuf;
use std::sync::Arc;

use image::{DynamicImage, GrayImage};
use rayon::prelude::*;
use serde::Deserialize;
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::ai::commands::{
    MaskTransform, data_url_bytes, encode_png, generate_foreground_mask, generate_sky_mask,
    generate_subject_mask, or_empty_mask, png_data_url, to_json, unrotate_box,
};
use crate::ai::models::{AiMaskModel, AiModels, get_or_init_ai_models};
use crate::app::state::AppState;
use crate::library::sidecars::parse_virtual_path;
use crate::video::ai_frames::{self, Analyzer, Map, Plan, Run, Sequence, SequenceWriter};
use crate::video::media::even_fit;
use crate::video::vision::Region;
use crate::video::{blocking, ffmpeg, proxy, tracking};

const MASKS_DIR: &str = "ai-masks";
const TRACKING_SHARE: f32 = 0.2;
const FLOW_LONGEST: f32 = 960.0;
const MAX_GAP_SECONDS: f64 = 0.2;
const MOTION_SHARE: f32 = 0.03;
const ENCODE_BATCH: usize = 16;
const IDENTITY: MaskTransform = MaskTransform {
    rotation: 0.0,
    flip_horizontal: false,
    flip_vertical: false,
    orientation_steps: 0,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceRequest {
    path: String,
    kind: String,
    times: Vec<f64>,
    reference: f64,
    parameters: Value,
}

fn sequence_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    proxy::cache_file(app, MASKS_DIR, id, "seq")
}

fn model_of(kind: &str) -> Result<AiMaskModel, String> {
    match kind {
        "ai-subject" => Ok(AiMaskModel::Subject),
        "ai-foreground" => Ok(AiMaskModel::Foreground),
        "ai-sky" => Ok(AiMaskModel::Sky),
        _ => Err("This AI mask can't follow the video yet".to_string()),
    }
}

fn transform_of(parameters: &Value) -> MaskTransform {
    MaskTransform {
        rotation: parameters["rotation"].as_f64().unwrap_or(0.0) as f32,
        flip_horizontal: parameters["flipHorizontal"].as_bool().unwrap_or(false),
        flip_vertical: parameters["flipVertical"].as_bool().unwrap_or(false),
        orientation_steps: parameters["orientationSteps"].as_u64().unwrap_or(0) as u8,
    }
}

fn subject_box(parameters: &Value, size: (u32, u32)) -> [f64; 4] {
    let transform = transform_of(parameters);
    let (width, height) = transform.box_space(size);
    let scale = |key: &str, length: u32| {
        length as f64 / parameters[key].as_f64().unwrap_or(length as f64).max(1.0)
    };
    let (sx, sy) = (
        scale("boxSpaceWidth", width),
        scale("boxSpaceHeight", height),
    );
    let point = |x: &str, y: &str| {
        (
            parameters[x].as_f64().unwrap_or(0.0) * sx,
            parameters[y].as_f64().unwrap_or(0.0) * sy,
        )
    };
    let (a, b) = unrotate_box(
        point("startX", "startY"),
        point("endX", "endY"),
        size,
        transform,
    );
    [a.0.min(b.0), a.1.min(b.1), a.0.max(b.0), a.1.max(b.1)]
}

fn tracked_boxes(
    request: &SequenceRequest,
    initial: [f64; 4],
    size: (u32, u32),
    progress: &dyn Fn(f32),
) -> Result<Vec<[f64; 4]>, String> {
    let (width, height) = (size.0 as f64, size.1 as f64);
    let region = Region {
        cx: ((initial[0] + initial[2]) / 2.0 / width) as f32,
        cy: ((initial[1] + initial[3]) / 2.0 / height) as f32,
        width: ((initial[2] - initial[0]) / width) as f32,
        height: ((initial[3] - initial[1]) / height) as f32,
    };
    let mut boxes: Vec<Option<[f64; 4]>> = vec![None; request.times.len()];
    let mut order: Vec<usize> = (0..request.times.len()).collect();
    order.sort_by(|&a, &b| request.times[a].total_cmp(&request.times[b]));
    let split = order.partition_point(|&index| request.times[index] < request.reference);
    let runs = [
        order[split..].to_vec(),
        order[..split].iter().rev().copied().collect::<Vec<_>>(),
    ];
    for (run_index, run) in runs.iter().enumerate() {
        if run.is_empty() {
            continue;
        }
        let times: Vec<f64> = std::iter::once(request.reference)
            .chain(run.iter().map(|&index| request.times[index]))
            .collect();
        let samples = tracking::track_region(
            &request.path,
            &times,
            tracking::Target::Region(region),
            None,
            &|value| progress(TRACKING_SHARE * (run_index as f32 + value) / runs.len() as f32),
        )?;
        for (offset, &index) in run.iter().enumerate() {
            if let Some(sample) = samples.get(offset + 1).copied().flatten() {
                let half_width = (initial[2] - initial[0]) / 2.0 * sample.scale as f64;
                let half_height = (initial[3] - initial[1]) / 2.0 * sample.scale as f64;
                let (cx, cy) = (sample.cx as f64 * width, sample.cy as f64 * height);
                boxes[index] = Some([
                    (cx - half_width).max(0.0),
                    (cy - half_height).max(0.0),
                    (cx + half_width).min(width),
                    (cy + half_height).min(height),
                ]);
            }
        }
    }
    let mut last = initial;
    let mut filled = vec![initial; boxes.len()];
    for &index in &order[split..] {
        last = boxes[index].unwrap_or(last);
        filled[index] = last;
    }
    last = initial;
    for &index in order[..split].iter().rev() {
        last = boxes[index].unwrap_or(last);
        filled[index] = last;
    }
    Ok(filled)
}

fn decode_mask(data_url: &str) -> Option<GrayImage> {
    Some(
        image::load_from_memory(&data_url_bytes(data_url)?)
            .ok()?
            .to_luma8(),
    )
}

fn sequence_id(request: &SequenceRequest) -> String {
    let mut hasher = DefaultHasher::new();
    let mut parameters = request.parameters.clone();
    if let Some(object) = parameters.as_object_mut() {
        object.remove("maskDataBase64");
        object.remove("sequence");
    }
    (
        &request.path,
        &request.kind,
        parameters.to_string(),
        request.reference.to_bits(),
    )
        .hash(&mut hasher);
    request
        .times
        .iter()
        .for_each(|time| time.to_bits().hash(&mut hasher));
    format!("{:016x}", hasher.finish())
}

fn mask_for(
    state: &AppState,
    models: &AiModels,
    model: AiMaskModel,
    key: &str,
    image: &image::DynamicImage,
    subject: Option<[f64; 4]>,
) -> Result<Value, String> {
    match (subject, model) {
        (Some(bounds), _) => generate_subject_mask(
            &state.ai_state,
            models,
            key,
            image,
            (bounds[0], bounds[1]),
            (bounds[2], bounds[3]),
            false,
            IDENTITY,
            None,
        )
        .and_then(to_json),
        (None, AiMaskModel::Sky) => {
            generate_sky_mask(&state.ai_state, models, key, image, IDENTITY, None).and_then(to_json)
        }
        (None, _) => generate_foreground_mask(models, image, IDENTITY, None).and_then(to_json),
    }
}

struct MaskFrames<'a> {
    state: &'a AppState,
    models: &'a AiModels,
    model: AiMaskModel,
    path: &'a str,
    subjects: Option<(&'a [f64], Vec<[f64; 4]>)>,
    previous: Option<GrayImage>,
    pending: Vec<(f64, GrayImage)>,
    writer: SequenceWriter,
}

impl MaskFrames<'_> {
    fn flush(&mut self) -> Result<(), String> {
        let encoded: Vec<Result<Vec<u8>, String>> = self
            .pending
            .par_iter()
            .map(|(_, mask)| encode_png(mask))
            .collect();
        for ((time, _), png) in self.pending.drain(..).zip(encoded) {
            self.writer.push(time, Some(&png?))?;
        }
        Ok(())
    }
}

impl Analyzer for MaskFrames<'_> {
    fn key(&mut self, image: &DynamicImage, time: f64) -> Result<Map, String> {
        let key = format!("{}#video-mask-{:.4}", self.path, time);
        let subject = self
            .subjects
            .as_ref()
            .and_then(|(times, boxes)| ai_frames::nearest(times, time).map(|index| boxes[index]));
        let size = (image.width(), image.height());
        let empty = || GrayImage::new(size.0, size.1);
        let mask = match or_empty_mask(
            mask_for(self.state, self.models, self.model, &key, image, subject),
            IDENTITY,
            None,
        ) {
            Ok((result, _)) => result["maskDataBase64"]
                .as_str()
                .and_then(decode_mask)
                .filter(|mask| mask.dimensions() == size)
                .unwrap_or_else(empty),
            Err(error) => {
                log::warn!("AI mask key frame at {:.3}s failed: {}", time, error);
                self.previous
                    .clone()
                    .filter(|mask| mask.dimensions() == size)
                    .unwrap_or_else(empty)
            }
        };
        self.previous = Some(mask.clone());
        Ok(Map {
            size,
            channels: 1,
            values: mask.iter().map(|&level| level as f32 / 255.0).collect(),
        })
    }

    fn emit(&mut self, time: f64, map: Map) -> Result<(), String> {
        let levels = map
            .values
            .iter()
            .map(|value| (value * 255.0).round().clamp(0.0, 255.0) as u8)
            .collect();
        let mask =
            GrayImage::from_raw(map.size.0, map.size.1, levels).ok_or("Mask size mismatch")?;
        self.pending.push((time, mask));
        if self.pending.len() >= ENCODE_BATCH {
            self.flush()?;
        }
        Ok(())
    }
}

fn compute(
    app: &AppHandle,
    models: &AiModels,
    model: AiMaskModel,
    request: &SequenceRequest,
    progress: &dyn Fn(f32),
) -> Result<String, String> {
    let id = sequence_id(request);
    if load(app, &id).is_some() {
        return Ok(id);
    }
    let target = sequence_path(app, &id)?;
    let source = parse_virtual_path(&request.path).0;
    let info = ffmpeg::probe(&source)?;
    let size = (info.width, info.height);
    let subjects = match model {
        AiMaskModel::Subject => Some((
            request.times.as_slice(),
            tracked_boxes(
                request,
                subject_box(&request.parameters, size),
                size,
                progress,
            )?,
        )),
        _ => None,
    };
    let start = if subjects.is_some() {
        TRACKING_SHARE
    } else {
        0.0
    };
    let context = crate::render::gpu::context::shared_gpu_context()?;
    let state = app.state::<AppState>();
    let mut analyzer = MaskFrames {
        state: &state,
        models,
        model,
        path: &request.path,
        subjects,
        previous: None,
        pending: Vec::new(),
        writer: SequenceWriter::create(&target)?,
    };
    ai_frames::analyze(
        &Run {
            context: &context,
            source: &source,
            info: &info,
            frames: &ai_frames::frame_indices(&request.times, info.fps),
            cancelled: &tracking::cancelled,
            progress: &|value| progress(start + (1.0 - start) * value),
        },
        &Plan {
            key_size: even_fit(size, size.0.max(size.1), 2),
            flow_longest: FLOW_LONGEST,
            max_gap: MAX_GAP_SECONDS,
            motion: MOTION_SHARE * FLOW_LONGEST,
        },
        &mut analyzer,
    )?;
    analyzer.flush()?;
    if tracking::cancelled() {
        return Err(ai_frames::CANCELLED.to_string());
    }
    analyzer.writer.finish()?;
    Ok(id)
}

fn load(app: &AppHandle, id: &str) -> Option<Arc<Sequence>> {
    ai_frames::load(&sequence_path(app, id).ok()?)
}

pub fn mask_at(app: &AppHandle, id: &str, time: f64) -> Option<String> {
    let (_, png) = load(app, id)?.frame(time)?;
    Some(png_data_url(&png))
}

#[tauri::command]
pub fn video_ai_masks_ready(ids: Vec<String>, app_handle: AppHandle) -> Vec<bool> {
    ids.iter()
        .map(|id| {
            sequence_path(&app_handle, id)
                .is_ok_and(|path| ai_frames::is_loaded(&path) || path.is_file())
        })
        .collect()
}

#[tauri::command]
pub async fn video_ai_mask_sequence(
    mut request: SequenceRequest,
    on_progress: Channel<f32>,
    app_handle: AppHandle,
) -> Result<String, String> {
    request.times.sort_by(f64::total_cmp);
    request.times.dedup();
    let model = model_of(&request.kind)?;
    let state = app_handle.state::<AppState>();
    let models = get_or_init_ai_models(&app_handle, &state.ai_state, &state.ai_init_lock, model)
        .await
        .map_err(|e| e.to_string())?;
    let exclusive = tracking::begin()?;
    blocking(move || {
        let _exclusive = exclusive;
        compute(&app_handle, &models, model, &request, &|value| {
            let _ = on_progress.send(value);
        })
    })
    .await?
}
