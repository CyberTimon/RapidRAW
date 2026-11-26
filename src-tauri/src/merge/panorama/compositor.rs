use super::camera::{Camera, Lens, Orientation};
use super::layout::{OutputLayout, plan_layout};
use super::photometric::Photometric;
use super::projection::{Projection, ProjectionMode, plan_canvas};
use super::seams::{NO_LABEL, SeamLayer, find_seams};
use crate::merge::blending::{MultiBandBlender, band_count};
use crate::merge::raster::{Raster, Rect, push_pull_fill};
use crate::render::color_space::srgb_transfer;
use nalgebra::Vector3;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

const SEAM_MEGAPIXELS: f64 = 0.8;
const LABEL_WEIGHT_FLOOR: f32 = 1e-4;
const STRIP_MIN_ROWS: usize = 1024;
const STRIP_MARGIN_FACTOR: usize = 4;
const MAX_OUTPUT_PIXELS: f64 = 200.0e6;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StitchSettings {
    pub projection: ProjectionMode,
    pub boundary_warp: f64,
    pub auto_crop: bool,
    pub exposure_compensation: bool,
}

impl Default for StitchSettings {
    fn default() -> Self {
        StitchSettings {
            projection: ProjectionMode::Auto,
            boundary_warp: 0.0,
            auto_crop: true,
            exposure_compensation: true,
        }
    }
}

pub struct SourceImage {
    pub levels: Vec<Raster>,
}

pub struct Scene<'a> {
    pub sources: Vec<&'a SourceImage>,
    pub cameras: &'a [Camera],
    pub lens: Lens,
    pub photometric: &'a Photometric,
    pub orientation: Orientation,
}

struct PlannedLayer {
    image: usize,
    roi: Rect,
}

pub struct CompositionPlan {
    layout: OutputLayout,
    seam_scale: f64,
    seam_width: usize,
    seam_height: usize,
    layers: Vec<PlannedLayer>,
    labels: Vec<u16>,
    photometric: Photometric,
}

impl CompositionPlan {
    pub fn projection(&self) -> Projection {
        self.layout.canvas.projection
    }

    pub fn full_scale(&self) -> f64 {
        let area = self.layout.crop.width * self.layout.crop.height;
        (MAX_OUTPUT_PIXELS / area).sqrt().min(1.0)
    }

    pub fn magnification(&self, camera: &Camera, scale: f64) -> f64 {
        magnification(&self.layout, camera, scale)
    }

    pub fn output_size(&self, scale: f64, orientation: Orientation) -> (usize, usize) {
        let w = ((self.layout.crop.width * scale).round() as usize).max(1);
        let h = ((self.layout.crop.height * scale).round() as usize).max(1);
        match orientation {
            Orientation::Horizontal => (w, h),
            Orientation::Vertical => (h, w),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Interpolation {
    Bilinear,
    Bicubic,
}

fn magnification(layout: &OutputLayout, camera: &Camera, scale: f64) -> f64 {
    scale * layout.canvas.scale / camera.focal
}

fn select_level(source: &SourceImage, camera: &Camera, magnification: f64) -> usize {
    source
        .levels
        .iter()
        .rposition(|level| level.width as f64 / camera.width >= magnification)
        .unwrap_or(0)
}

struct WarpedLayer {
    color: Raster,
    valid: Vec<f32>,
}

fn warp_layer(
    scene: &Scene,
    photometric: &Photometric,
    layout: &OutputLayout,
    image: usize,
    rect: Rect,
    scale: f64,
    interpolation: Interpolation,
) -> WarpedLayer {
    let camera = &scene.cameras[image];
    let source = scene.sources[image];
    let lens = scene.lens;
    let level = &source.levels[select_level(source, camera, magnification(layout, camera, scale))];
    let r_norm = camera.radius_norm();
    let transfer = srgb_transfer();

    let mut color = Raster::new(rect.width, rect.height, 3);
    let mut valid = vec![0.0f32; rect.width * rect.height];
    color
        .data
        .par_chunks_mut(rect.width * 3)
        .zip(valid.par_chunks_mut(rect.width))
        .enumerate()
        .for_each(|(ly, (row, valid_row))| {
            let y = (rect.y + ly) as f64 + 0.5;
            let mut sample = [0.0f32; 3];
            for lx in 0..rect.width {
                let x = (rect.x + lx) as f64 + 0.5;
                let Some(ray) = layout.ray(x / scale, y / scale) else {
                    continue;
                };
                let Some(p) = camera.project(&lens, &ray) else {
                    continue;
                };
                let (px, py) = camera.level_position(level, &p);
                if px < -0.5
                    || py < -0.5
                    || px > level.width as f64 - 0.5
                    || py > level.height as f64 - 0.5
                {
                    continue;
                }
                match interpolation {
                    Interpolation::Bilinear => level.bilinear(px as f32, py as f32, &mut sample),
                    Interpolation::Bicubic => level.bicubic(px as f32, py as f32, &mut sample),
                }
                let r2 = (p.norm_squared() / (r_norm * r_norm)) as f32;
                let gain = photometric.correction(image, r2);
                for c in 0..3 {
                    row[lx * 3 + c] = transfer.encode(sample[c] * gain[c]);
                }
                valid_row[lx] = 1.0;
            }
        });
    WarpedLayer { color, valid }
}

fn output_rays(layout: &OutputLayout, rect: Rect, scale: f64) -> Vec<Option<Vector3<f64>>> {
    let mut rays = vec![None; rect.width * rect.height];
    rays.par_chunks_mut(rect.width)
        .enumerate()
        .for_each(|(ly, row)| {
            let y = ((rect.y + ly) as f64 + 0.5) / scale;
            for (lx, ray) in row.iter_mut().enumerate() {
                *ray = layout.ray(((rect.x + lx) as f64 + 0.5) / scale, y);
            }
        });
    rays
}

fn coverage_mask(camera: &Camera, lens: &Lens, rays: &[Option<Vector3<f64>>]) -> Vec<bool> {
    rays.par_iter()
        .map(|ray| {
            ray.and_then(|ray| camera.project(lens, &ray))
                .is_some_and(|p| camera.contains(&p))
        })
        .collect()
}

fn split_column_runs(valid: &[bool], width: usize, height: usize) -> Vec<Rect> {
    let mut column_used = vec![false; width];
    for y in 0..height {
        for x in 0..width {
            if valid[y * width + x] {
                column_used[x] = true;
            }
        }
    }
    let mut runs = Vec::new();
    let mut x = 0;
    while x < width {
        if !column_used[x] {
            x += 1;
            continue;
        }
        let start = x;
        while x < width && column_used[x] {
            x += 1;
        }
        let (mut y0, mut y1) = (usize::MAX, 0);
        for y in 0..height {
            if valid[y * width + start..y * width + x].iter().any(|&v| v) {
                y0 = y0.min(y);
                y1 = y1.max(y + 1);
            }
        }
        runs.push(Rect {
            x: start,
            y: y0,
            width: x - start,
            height: y1 - y0,
        });
    }
    runs
}

pub fn plan_composition(
    scene: &Scene,
    settings: &StitchSettings,
) -> Result<CompositionPlan, String> {
    let canvas = plan_canvas(scene.cameras, &scene.lens, settings.projection);
    let canvas_area = canvas.width * canvas.height;
    let seam_scale = (SEAM_MEGAPIXELS * 1.0e6 / canvas_area).sqrt().min(1.0);
    let layout = plan_layout(
        canvas,
        scene.cameras,
        &scene.lens,
        seam_scale,
        settings.boundary_warp / 100.0,
        settings.auto_crop,
    )?;

    let photometric = if settings.exposure_compensation {
        scene.photometric.clone()
    } else {
        Photometric::identity(scene.cameras.len())
    };

    let seam_width = ((layout.crop.width * seam_scale).round() as usize).max(1);
    let seam_height = ((layout.crop.height * seam_scale).round() as usize).max(1);
    let full_rect = Rect {
        x: 0,
        y: 0,
        width: seam_width,
        height: seam_height,
    };

    let rays = output_rays(&layout, full_rect, seam_scale);
    let layers: Vec<PlannedLayer> = (0..scene.cameras.len())
        .into_par_iter()
        .map(|image| {
            let mask = coverage_mask(&scene.cameras[image], &scene.lens, &rays);
            split_column_runs(&mask, seam_width, seam_height)
                .into_iter()
                .map(|roi| PlannedLayer { image, roi })
                .collect::<Vec<_>>()
        })
        .flatten()
        .collect();
    drop(rays);
    if layers.is_empty() {
        return Err("None of the images are visible in the panorama.".to_string());
    }
    let seam_layers: Vec<SeamLayer> = layers
        .par_iter()
        .map(|layer| {
            let warp = warp_layer(
                scene,
                &photometric,
                &layout,
                layer.image,
                layer.roi,
                seam_scale,
                Interpolation::Bilinear,
            );
            SeamLayer {
                roi: layer.roi,
                color: warp.color,
                valid: warp.valid.iter().map(|&v| v > 0.5).collect(),
            }
        })
        .collect();

    let labels = find_seams(seam_width, seam_height, &seam_layers);

    Ok(CompositionPlan {
        layout,
        seam_scale,
        seam_width,
        seam_height,
        layers,
        labels,
        photometric,
    })
}

fn label_weight(plan: &CompositionPlan, layer: u16, x: f64, y: f64) -> f32 {
    let gx = x - 0.5;
    let gy = y - 0.5;
    let x0 = gx.floor();
    let y0 = gy.floor();
    let fx = (gx - x0) as f32;
    let fy = (gy - y0) as f32;
    let at = |xi: f64, yi: f64| -> f32 {
        let cx = (xi.max(0.0) as usize).min(plan.seam_width - 1);
        let cy = (yi.max(0.0) as usize).min(plan.seam_height - 1);
        let label = plan.labels[cy * plan.seam_width + cx];
        if label == layer && label != NO_LABEL {
            1.0
        } else {
            0.0
        }
    };
    let top = at(x0, y0) * (1.0 - fx) + at(x0 + 1.0, y0) * fx;
    let bottom = at(x0, y0 + 1.0) * (1.0 - fx) + at(x0 + 1.0, y0 + 1.0) * fx;
    top * (1.0 - fy) + bottom * fy
}

pub fn render_composition(
    scene: &Scene,
    plan: &CompositionPlan,
    scale: f64,
    interpolation: Interpolation,
    progress: &dyn Fn(String),
) -> Raster {
    let width = ((plan.layout.crop.width * scale).round() as usize).max(1);
    let height = ((plan.layout.crop.height * scale).round() as usize).max(1);
    let bands = band_count(width, height);
    let align = MultiBandBlender::alignment(bands);
    let margin = (STRIP_MARGIN_FACTOR * align).max(32).div_ceil(align) * align;
    let core = STRIP_MIN_ROWS.max(2 * margin).div_ceil(align) * align;
    let ratio = scale / plan.seam_scale;
    let pad = (2.0 * ratio).ceil() as usize + 2;

    let layer_rects: Vec<Rect> = plan
        .layers
        .iter()
        .map(|layer| {
            let x0 = ((layer.roi.x as f64 * ratio).floor() as usize).saturating_sub(pad);
            let y0 = ((layer.roi.y as f64 * ratio).floor() as usize).saturating_sub(pad);
            let x1 = ((layer.roi.right() as f64 * ratio).ceil() as usize + pad).min(width);
            let y1 = ((layer.roi.bottom() as f64 * ratio).ceil() as usize + pad).min(height);
            Rect {
                x: x0 - x0 % align,
                y: y0,
                width: x1 - (x0 - x0 % align),
                height: y1 - y0,
            }
        })
        .collect();

    let mut output = Raster::new(width, height, 3);
    let strip_count = height.div_ceil(core);
    for strip in 0..strip_count {
        if strip_count > 1 {
            progress(format!("Blending region {} of {}", strip + 1, strip_count));
        }
        let y_start = strip * core;
        let y_end = ((strip + 1) * core).min(height);
        let region_y0 = y_start.saturating_sub(margin);
        let region_y1 = (y_end + margin).min(height);
        let region = Rect {
            x: 0,
            y: region_y0,
            width,
            height: region_y1 - region_y0,
        };

        let mut blender = MultiBandBlender::new(region.width, region.height, bands);
        let mut coverage = vec![false; width * (y_end - y_start)];

        for (index, layer) in plan.layers.iter().enumerate() {
            let Some(mut rect) = layer_rects[index].intersect(&region) else {
                continue;
            };
            let local_y = rect.y - region.y;
            let aligned_y = local_y - local_y % align;
            rect.height += local_y - aligned_y;
            rect.y = region.y + aligned_y;

            let mut warp = warp_layer(
                scene,
                &plan.photometric,
                &plan.layout,
                layer.image,
                rect,
                scale,
                interpolation,
            );
            if !warp.valid.iter().any(|&v| v > 0.0) {
                continue;
            }

            let weights: Vec<f32> = warp
                .valid
                .par_chunks(rect.width)
                .enumerate()
                .flat_map_iter(|(ly, row)| {
                    let y = ((rect.y + ly) as f64 + 0.5) / ratio;
                    row.iter().enumerate().map(move |(lx, &v)| {
                        if v <= 0.0 {
                            return 0.0;
                        }
                        let x = ((rect.x + lx) as f64 + 0.5) / ratio;
                        v * (label_weight(plan, index as u16, x, y) + LABEL_WEIGHT_FLOOR)
                    })
                })
                .collect();

            for ly in 0..rect.height {
                let gy = rect.y + ly;
                if gy < y_start || gy >= y_end {
                    continue;
                }
                for lx in 0..rect.width {
                    if warp.valid[ly * rect.width + lx] > 0.0 {
                        coverage[(gy - y_start) * width + rect.x + lx] = true;
                    }
                }
            }

            push_pull_fill(&mut warp.color, &warp.valid, bands + 2);
            blender.feed(&warp.color, &weights, rect.x, rect.y - region.y);
        }

        let blended = blender.finish();
        let stride = width * 3;
        output.data[y_start * stride..y_end * stride]
            .par_chunks_mut(stride)
            .enumerate()
            .for_each(|(ly, row)| {
                let by = y_start - region.y + ly;
                for x in 0..width {
                    if coverage[ly * width + x] {
                        let src = blended.pixel(x, by);
                        row[x * 3] = src[0].max(0.0);
                        row[x * 3 + 1] = src[1].max(0.0);
                        row[x * 3 + 2] = src[2].max(0.0);
                    }
                }
            });
    }

    match scene.orientation {
        Orientation::Horizontal => output,
        Orientation::Vertical => rotate_counter_clockwise(&output),
    }
}

fn rotate_counter_clockwise(src: &Raster) -> Raster {
    let (w, h, ch) = (src.height, src.width, src.channels);
    let mut out = Raster::new(w, h, ch);
    out.data
        .par_chunks_mut(w * ch)
        .enumerate()
        .for_each(|(y, row)| {
            for x in 0..w {
                let s = src.pixel(src.width - 1 - y, x);
                row[x * ch..(x + 1) * ch].copy_from_slice(s);
            }
        });
    out
}

pub fn build_levels(full: Raster, min_dimension: usize, max_dimension: usize) -> Vec<Raster> {
    let mut levels = Vec::new();
    let mut level = full;
    loop {
        let next = (level.width.min(level.height) / 2 >= min_dimension)
            .then(|| crate::merge::raster::downsample_box(&level));
        if level.width.max(level.height) <= max_dimension || next.is_none() {
            levels.push(level);
        }
        match next {
            Some(next) => level = next,
            None => return levels,
        }
    }
}

pub fn level_for_magnification(
    full: Raster,
    camera: &Camera,
    magnification: f64,
    min_dimension: usize,
) -> Raster {
    let mut level = full;
    while level.width.min(level.height) / 2 >= min_dimension
        && (level.width / 2) as f64 / camera.width >= magnification
    {
        level = crate::merge::raster::downsample_box(&level);
    }
    level
}

pub fn level_for_size(levels: &[Raster], max_dimension: usize) -> &Raster {
    levels
        .iter()
        .find(|l| l.width.max(l.height) <= max_dimension)
        .unwrap_or_else(|| levels.last().unwrap())
}
