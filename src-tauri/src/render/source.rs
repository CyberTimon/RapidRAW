use std::borrow::Cow;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use image::{DynamicImage, GenericImageView};
use serde_json::Value;

use crate::render::geometry::{
    Crop, GeometryParams, WarpModel, crop_rect, get_geometry_params_from_json, is_geometry_identity,
};
use crate::render::gpu::compute::{
    Bind, ComputeEncoder, Grid, Group, IMAGE_FORMAT, Out, Slot, Tex,
};
use crate::render::gpu::context::GpuContext;
use crate::render::image_processing::{downscale_f32_image, fitted_size};

const FRAME_ROTATE: u32 = 1;
const WARP_LENS: u32 = 1;
const WARP_TCA: u32 = 2;
const WARP_VIGNETTE: u32 = 4;
const WARP_DISTORTION: u32 = 8;
const IDENTITY_SAMPLES: usize = 4096;
static NO_ADJUSTMENTS: Value = Value::Null;

#[repr(C)]
#[derive(Debug, Default, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
pub(crate) struct TransformParams {
    grid: Grid,
    inverse_x: [f32; 4],
    inverse_y: [f32; 4],
    inverse_z: [f32; 4],
    center: [f32; 2],
    lens_scale: f32,
    max_radius_sq_inv: f32,
    distortion: f32,
    auto_crop_scale: f32,
    warp_flags: u32,
    orientation: u32,
    lens_k: [f32; 4],
    vignette_k: [f32; 3],
    vignette_amount: f32,
    tca_red: [f32; 3],
    tca_scale: f32,
    tca_blue: [f32; 3],
    vignette_scale: f32,
    rotation: [f32; 4],
    rotation_offset: [f32; 2],
    crop_origin: [u32; 2],
    oriented_size: [u32; 2],
    flip: [u32; 2],
    grain: [u32; 4],
}

impl TransformParams {
    pub(crate) fn grain(stride: u32, blocks: (u32, u32), is_raw: bool) -> Self {
        Self {
            grain: [stride, blocks.0, blocks.1, is_raw as u32],
            ..Default::default()
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Frame {
    pub orientation: u8,
    pub flip_horizontal: bool,
    pub flip_vertical: bool,
    pub rotation: f32,
    pub crop: Option<Crop>,
}

impl Frame {
    pub fn from_adjustments(adjustments: &Value) -> Self {
        Self {
            orientation: (adjustments["orientationSteps"].as_u64().unwrap_or(0) % 4) as u8,
            flip_horizontal: adjustments["flipHorizontal"].as_bool().unwrap_or(false),
            flip_vertical: adjustments["flipVertical"].as_bool().unwrap_or(false),
            rotation: adjustments["rotation"].as_f64().unwrap_or(0.0) as f32,
            crop: serde_json::from_value(adjustments["crop"].clone()).ok(),
        }
    }

    pub fn scale_crop(self, scale: f64) -> Self {
        Self {
            crop: self.crop.map(|c| Crop {
                x: c.x * scale,
                y: c.y * scale,
                width: c.width * scale,
                height: c.height * scale,
            }),
            ..self
        }
    }

    fn oriented_size(&self, (w, h): (u32, u32)) -> (u32, u32) {
        if self.orientation % 2 == 1 {
            (h, w)
        } else {
            (w, h)
        }
    }

    fn rotates(&self) -> bool {
        self.rotation % 360.0 != 0.0
    }

    fn crop_rect(&self, size: (u32, u32)) -> (u32, u32, u32, u32) {
        self.crop
            .as_ref()
            .and_then(|crop| crop_rect(crop, size))
            .unwrap_or((0, 0, size.0, size.1))
    }

    fn size(&self, size: (u32, u32)) -> (u32, u32) {
        let (_, _, w, h) = self.crop_rect(self.oriented_size(size));
        (w, h)
    }

    fn is_identity(&self, size: (u32, u32)) -> bool {
        self.orientation == 0
            && !self.flip_horizontal
            && !self.flip_vertical
            && !self.rotates()
            && self.crop_rect(size) == (0, 0, size.0, size.1)
    }
}

#[derive(Clone, Debug, Default)]
pub struct SourceTransform {
    pub warp: Option<GeometryParams>,
    pub working_fit: Option<(u32, u32)>,
    pub effects: bool,
    pub frame: Frame,
    pub output_fit: Option<(u32, u32)>,
}

fn fit(size: (u32, u32), target: Option<(u32, u32)>) -> (u32, u32) {
    target
        .and_then(|target| fitted_size(size, target))
        .unwrap_or(size)
}

impl SourceTransform {
    pub fn from_adjustments(path: &str, adjustments: &Value) -> Self {
        let geometry = get_geometry_params_from_json(path, adjustments);
        Self {
            warp: (!is_geometry_identity(&geometry)).then_some(geometry),
            effects: true,
            frame: Frame::from_adjustments(adjustments),
            ..Default::default()
        }
    }

    pub fn working_size(&self, source: (u32, u32)) -> (u32, u32) {
        fit(source, self.working_fit)
    }

    pub fn output_size(&self, source: (u32, u32)) -> (u32, u32) {
        fit(self.frame.size(self.working_size(source)), self.output_fit)
    }
}

pub struct RenderSource<'a> {
    pub image: &'a DynamicImage,
    pub id: u64,
    pub adjustments: &'a Value,
    pub transform: SourceTransform,
}

impl<'a> RenderSource<'a> {
    pub fn new(
        image: &'a DynamicImage,
        id: u64,
        adjustments: &'a Value,
        transform: SourceTransform,
    ) -> Self {
        Self {
            image,
            id,
            adjustments,
            transform,
        }
    }

    pub fn plain(image: &'a DynamicImage) -> Self {
        let mut hasher = DefaultHasher::new();
        image.as_bytes().hash(&mut hasher);
        Self::new(
            image,
            hasher.finish(),
            &NO_ADJUSTMENTS,
            SourceTransform::default(),
        )
    }

    pub fn edited(image: &'a DynamicImage, id: u64, path: &str, adjustments: &'a Value) -> Self {
        Self::new(
            image,
            id,
            adjustments,
            SourceTransform::from_adjustments(path, adjustments),
        )
    }

    pub fn scaled(mut self, scale: f32) -> Self {
        self.transform.frame = std::mem::take(&mut self.transform.frame).scale_crop(scale as f64);
        self
    }

    pub fn crop_offset(&self) -> (f32, f32) {
        self.transform
            .frame
            .crop
            .map_or((0.0, 0.0), |c| (c.x as f32, c.y as f32))
    }

    pub fn size(&self) -> (u32, u32) {
        self.transform.output_size(self.image.dimensions())
    }

    pub fn identity(&self) -> u64 {
        let bytes = self.image.as_bytes();
        let mut hasher = DefaultHasher::new();
        (self.id, self.image.dimensions()).hash(&mut hasher);
        let words = bytes.len() / 8;
        for index in (0..words).step_by((words / IDENTITY_SAMPLES).max(1)) {
            bytes[index * 8..index * 8 + 8].hash(&mut hasher);
        }
        hasher.finish()
    }

    pub fn key(&self) -> u64 {
        let mut hasher = DefaultHasher::new();
        format!("{:?}", self.transform).hash(&mut hasher);
        if self.transform.effects {
            crate::render::cache_utils::calculate_effects_hash(self.adjustments).hash(&mut hasher);
        }
        hasher.finish()
    }

    pub fn render(&self, context: &GpuContext, source: &Slot) -> Result<Slot, String> {
        crate::render::gpu::compute::encode(context, |enc| self.encode(enc, source))?
            .map_or_else(|| Ok(source.clone()), Ok)
    }

    fn encode(&self, enc: &mut ComputeEncoder, source: &Slot) -> Option<Slot> {
        let transform = &self.transform;
        let mut current: Option<Tex> = None;
        let stage = |enc: &mut ComputeEncoder,
                     current: &mut Option<Tex>,
                     size: (u32, u32),
                     run: &dyn Fn(&mut ComputeEncoder, &Slot, &Slot)| {
            let output = enc.texture("Source Stage", size, IMAGE_FORMAT);
            run(enc, current.as_deref().unwrap_or(source), &output);
            *current = Some(output);
        };

        if let Some(geometry) = &transform.warp {
            let size = source.size;
            stage(enc, &mut current, size, &|enc, src, dst| {
                warp(enc, geometry, src, dst)
            });
        }
        let working_size = transform.working_size(source.size);
        if working_size != source.size {
            stage(enc, &mut current, working_size, &downscale);
        }
        if transform.effects {
            let adjustments = self.adjustments;
            if let Some(job) =
                crate::effects::relight::prepare(adjustments, transform.warp.as_ref(), working_size)
            {
                stage(enc, &mut current, working_size, &|enc, src, dst| {
                    crate::effects::relight::encode(enc, &job, src, dst)
                });
            }
            if let Some(job) =
                crate::effects::fog::prepare(adjustments, transform.warp.as_ref(), working_size)
            {
                stage(enc, &mut current, working_size, &|enc, src, dst| {
                    crate::effects::fog::encode(enc, &job, src, dst)
                });
            }
            if let Some(job) = crate::effects::lens_blur::prepare(
                adjustments,
                transform.warp.as_ref(),
                working_size,
            ) {
                stage(enc, &mut current, working_size, &|enc, src, dst| {
                    crate::effects::lens_blur::encode(enc, &job, src, dst)
                });
            }
        }
        if !transform.frame.is_identity(working_size) {
            let frame = &transform.frame;
            stage(
                enc,
                &mut current,
                frame.size(working_size),
                &|enc, src, dst| reframe(enc, frame, src, dst),
            );
        }
        let output_size = transform.output_size(source.size);
        if output_size != transform.frame.size(working_size) {
            stage(enc, &mut current, output_size, &downscale);
        }
        current.map(Tex::detach)
    }
}

pub fn source_id(tag: &str, path: &str, adjustments: &Value) -> u64 {
    let mut hasher = DefaultHasher::new();
    (
        tag,
        path,
        crate::render::cache_utils::calculate_patch_hash(adjustments),
    )
        .hash(&mut hasher);
    hasher.finish()
}

pub fn fit_to_gpu<'a>(
    context: &GpuContext,
    image: &'a DynamicImage,
) -> (Cow<'a, DynamicImage>, f32) {
    let limit = context.limits.max_texture_dimension_2d;
    let (width, height) = image.dimensions();
    if fitted_size((width, height), (limit, limit)).is_none() {
        return (Cow::Borrowed(image), 1.0);
    }
    let fitted = downscale_f32_image(image, limit, limit);
    log::warn!(
        "{}x{} exceeds the GPU texture limit ({}); rendering at {}x{}",
        width,
        height,
        limit,
        fitted.width(),
        fitted.height()
    );
    let scale = fitted.width() as f32 / width as f32;
    (Cow::Owned(fitted), scale)
}

fn warp(enc: &mut ComputeEncoder, geometry: &GeometryParams, src: &Slot, dst: &Slot) {
    let model = WarpModel::new(geometry, src.size.0, src.size.1);
    let column = |c: usize| {
        [
            model.inverse[(0, c)],
            model.inverse[(1, c)],
            model.inverse[(2, c)],
            0.0,
        ]
    };
    let flags = [
        (model.has_lens_correction, WARP_LENS),
        (model.has_tca, WARP_TCA),
        (model.has_vignetting, WARP_VIGNETTE),
        (model.k_distortion.abs() > 1e-5, WARP_DISTORTION),
    ]
    .iter()
    .filter(|(on, _)| *on)
    .fold(0, |acc, (_, flag)| acc | flag);
    let params = TransformParams {
        grid: Grid::new(dst.size),
        inverse_x: column(0),
        inverse_y: column(1),
        inverse_z: column(2),
        center: [model.cx, model.cy],
        lens_scale: model.lens_scale as f32,
        max_radius_sq_inv: model.max_radius_sq_inv as f32,
        distortion: model.k_distortion as f32,
        auto_crop_scale: model.auto_crop_scale,
        warp_flags: flags,
        lens_k: model.lens_k.map(|k| k as f32),
        vignette_k: model.vignette_k.map(|k| k as f32),
        vignette_amount: model.vignette_amount as f32,
        tca_red: model.tca_red.map(|k| k as f32),
        tca_scale: model.tca_scale as f32,
        tca_blue: model.tca_blue.map(|k| k as f32),
        vignette_scale: model.vignette_scale as f32,
        ..Default::default()
    };
    enc.run(
        Group::Transform,
        "tf_warp",
        &params,
        dst.size,
        &[&src.view],
        Out::F16(&dst.view),
        Bind::default(),
    );
}

fn reframe(enc: &mut ComputeEncoder, frame: &Frame, src: &Slot, dst: &Slot) {
    let oriented = frame.oriented_size(src.size);
    let (x, y, _, _) = frame.crop_rect(oriented);
    let (sin, cos) = (frame.rotation * std::f32::consts::PI / 180.0).sin_cos();
    let center = [oriented.0 as f32 / 2.0, oriented.1 as f32 / 2.0];
    let params = TransformParams {
        grid: Grid {
            flags: if frame.rotates() { FRAME_ROTATE } else { 0 },
            ..Grid::new(dst.size).with_src(src.size)
        },
        orientation: frame.orientation as u32,
        rotation: [cos, sin, -sin, cos],
        rotation_offset: [
            center[0] - (cos * center[0] + sin * center[1]),
            center[1] - (-sin * center[0] + cos * center[1]),
        ],
        crop_origin: [x, y],
        oriented_size: [oriented.0, oriented.1],
        flip: [frame.flip_horizontal as u32, frame.flip_vertical as u32],
        ..Default::default()
    };
    enc.run(
        Group::Transform,
        "tf_frame",
        &params,
        dst.size,
        &[&src.view],
        Out::F16(&dst.view),
        Bind::default(),
    );
}

fn downscale(enc: &mut ComputeEncoder, src: &Slot, dst: &Slot) {
    let params = TransformParams {
        grid: Grid::new(dst.size).with_src(src.size),
        ..Default::default()
    };
    enc.run(
        Group::Transform,
        "tf_downscale",
        &params,
        dst.size,
        &[&src.view],
        Out::F16(&dst.view),
        Bind::default(),
    );
}
