use crate::ai_processing::{
    AiForegroundMaskParameters, AiSkyMaskParameters, AiSubjectMaskParameters,
};
use base64::{Engine as _, engine::general_purpose};
use image::{GrayImage, Luma};
use imageproc::distance_transform::Norm as DilationNorm;
use imageproc::morphology::{dilate, erode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::f32::consts::PI;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SubMaskMode {
    Additive,
    Subtractive,
}

#[derive(Serialize, Deserialize, Debug, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SubMask {
    pub id: String,
    #[serde(rename = "type")]
    pub mask_type: String,
    pub visible: bool,
    #[serde(default)]
    pub invert: bool,
    #[serde(default = "default_opacity")]
    pub opacity: f32,
    pub mode: SubMaskMode,
    pub parameters: Value,
}

fn default_opacity() -> f32 {
    100.0
}

#[derive(Serialize, Deserialize, Debug, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MaskDefinition {
    pub id: String,
    pub name: String,
    pub visible: bool,
    pub invert: bool,
    #[serde(default = "default_opacity")]
    pub opacity: f32,
    pub adjustments: Value,
    pub sub_masks: Vec<SubMask>,
}

#[derive(Serialize, Deserialize, Debug, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PatchData {
    pub color: String,
    pub mask: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiPatchDefinition {
    pub id: String,
    pub name: String,
    pub visible: bool,
    pub invert: bool,
    pub prompt: String,
    #[serde(default)]
    pub patch_data: Option<PatchData>,
    #[serde(default = "default_opacity")]
    pub opacity: f32,
    pub sub_masks: Vec<SubMask>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct GrowFeatherParameters {
    #[serde(default)]
    grow: f32,
    #[serde(default)]
    feather: f32,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct RadialMaskParameters {
    center_x: f64,
    center_y: f64,
    radius_x: f64,
    radius_y: f64,
    rotation: f32,
    feather: f32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct LinearMaskParameters {
    start_x: f64,
    start_y: f64,
    end_x: f64,
    end_y: f64,
    #[serde(default = "default_range")]
    range: f32,
}

fn default_range() -> f32 {
    50.0
}

impl Default for LinearMaskParameters {
    fn default() -> Self {
        Self {
            start_x: 0.0,
            start_y: 0.0,
            end_x: 0.0,
            end_y: 0.0,
            range: default_range(),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct Point {
    x: f64,
    y: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct BrushLine {
    tool: String,
    brush_size: f32,
    points: Vec<Point>,
    #[serde(default = "default_brush_feather")]
    feather: f32,
}

fn default_brush_feather() -> f32 {
    0.5
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct BrushMaskParameters {
    #[serde(default)]
    lines: Vec<BrushLine>,
}

fn apply_grow_and_feather(mask: &mut GrayImage, grow: f32, feather: f32, width: u32, height: u32) {
    let base_dimension = width.min(height) as f32;

    if grow.abs() > 0.01 {
        const MAX_GROW_PERCENTAGE: f32 = 0.01;
        let grow_pixels = (grow / 100.0) * base_dimension * MAX_GROW_PERCENTAGE;

        if grow_pixels.abs() >= 1.0 {
            let mut binary_mask = mask.clone();
            for p in binary_mask.pixels_mut() {
                if p[0] > 128 {
                    p[0] = 255;
                } else {
                    p[0] = 0;
                }
            }

            let amount = grow_pixels.abs().round() as u8;
            if amount > 0 {
                if grow_pixels > 0.0 {
                    *mask = dilate(&binary_mask, DilationNorm::LInf, amount);
                } else {
                    *mask = erode(&binary_mask, DilationNorm::LInf, amount);
                }
            }
        }
    }

    if feather > 0.0 {
        const MAX_FEATHER_SIGMA_PERCENTAGE: f32 = 0.005;
        let sigma = (feather / 100.0) * base_dimension * MAX_FEATHER_SIGMA_PERCENTAGE;

        if sigma > 0.01 {
            *mask = imageproc::filter::gaussian_blur_f32(mask, sigma);
        }
    }
}

fn draw_feathered_ellipse_mut(
    mask: &mut GrayImage,
    center: (i32, i32),
    radius: f32,
    feather: f32,
    color_value: u8,
    is_eraser: bool,
) {
    if radius <= 0.0 {
        return;
    }

    let (cx, cy) = center;
    let feather_amount = feather.clamp(0.0, 1.0);
    let inner_radius = radius * (1.0 - feather_amount);

    let top = (cy as f32 - radius).ceil() as i32;
    let bottom = (cy as f32 + radius).floor() as i32;
    let left = (cx as f32 - radius).ceil() as i32;
    let right = (cx as f32 + radius).floor() as i32;

    for y in top..=bottom {
        for x in left..=right {
            if x < 0 || x >= mask.width() as i32 || y < 0 || y >= mask.height() as i32 {
                continue;
            }

            let dx = x as f32 - cx as f32;
            let dy = y as f32 - cy as f32;
            let dist = (dx * dx + dy * dy).sqrt();

            if dist <= radius {
                let intensity = if dist <= inner_radius {
                    1.0
                } else {
                    1.0 - (dist - inner_radius) / (radius - inner_radius).max(0.01)
                };

                let final_value = (intensity * color_value as f32) as u8;

                let current_pixel = mask.get_pixel_mut(x as u32, y as u32);

                if is_eraser {
                    current_pixel[0] = current_pixel[0].saturating_sub(final_value);
                } else {
                    if final_value > current_pixel[0] {
                        current_pixel[0] = final_value;
                    }
                }
            }
        }
    }
}

fn generate_radial_bitmap(
    params_value: &Value,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
) -> GrayImage {
    let params: RadialMaskParameters =
        serde_json::from_value(params_value.clone()).unwrap_or_default();
    let mut mask = GrayImage::new(width, height);

    let center_x = (params.center_x as f32 * scale - crop_offset.0) as i32;
    let center_y = (params.center_y as f32 * scale - crop_offset.1) as i32;
    let radius_x = params.radius_x as f32 * scale;
    let radius_y = params.radius_y as f32 * scale;
    let rotation_rad = params.rotation * PI / 180.0;

    for y in 0..height {
        for x in 0..width {
            let dx = x as f32 - center_x as f32;
            let dy = y as f32 - center_y as f32;

            let cos_rot = rotation_rad.cos();
            let sin_rot = rotation_rad.sin();

            let rot_dx = dx * cos_rot + dy * sin_rot;
            let rot_dy = -dx * sin_rot + dy * cos_rot;

            let norm_x = rot_dx / radius_x.max(0.01);
            let norm_y = rot_dy / radius_y.max(0.01);

            let dist = (norm_x.powi(2) + norm_y.powi(2)).sqrt();

            let inner_bound = 1.0 - params.feather.clamp(0.0, 1.0);
            let intensity = 1.0 - (dist - inner_bound) / (1.0 - inner_bound).max(0.01);
            let clamped_intensity = intensity.clamp(0.0, 1.0);

            mask.put_pixel(x, y, Luma([(clamped_intensity * 255.0) as u8]));
        }
    }

    mask
}

fn generate_linear_bitmap(
    params_value: &Value,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
) -> GrayImage {
    let params: LinearMaskParameters =
        serde_json::from_value(params_value.clone()).unwrap_or_default();
    let mut mask = GrayImage::new(width, height);

    let start_x = params.start_x as f32 * scale - crop_offset.0;
    let start_y = params.start_y as f32 * scale - crop_offset.1;
    let end_x = params.end_x as f32 * scale - crop_offset.0;
    let end_y = params.end_y as f32 * scale - crop_offset.1;
    let range = params.range * scale;

    let line_vec_x = end_x - start_x;
    let line_vec_y = end_y - start_y;

    let len_sq = line_vec_x.powi(2) + line_vec_y.powi(2);

    if len_sq < 0.01 {
        return mask;
    }

    let perp_vec_x = -line_vec_y / len_sq.sqrt();
    let perp_vec_y = line_vec_x / len_sq.sqrt();

    let half_width = range.max(0.01);

    for y_u in 0..height {
        for x_u in 0..width {
            let x = x_u as f32;
            let y = y_u as f32;

            let pixel_vec_x = x - start_x;
            let pixel_vec_y = y - start_y;

            let dist_perp = pixel_vec_x * perp_vec_x + pixel_vec_y * perp_vec_y;

            let t = dist_perp / half_width;

            let intensity = 0.5 - t * 0.5;

            let clamped_intensity = intensity.clamp(0.0, 1.0);

            mask.put_pixel(x_u, y_u, Luma([(clamped_intensity * 255.0) as u8]));
        }
    }

    mask
}

fn generate_brush_bitmap(
    params_value: &Value,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
) -> GrayImage {
    let params: BrushMaskParameters =
        serde_json::from_value(params_value.clone()).unwrap_or_default();
    let mut mask = GrayImage::new(width, height);

    for line in &params.lines {
        if line.points.is_empty() {
            continue;
        }

        let is_eraser = line.tool == "eraser";
        let color_value = 255u8;
        let radius = (line.brush_size * scale / 2.0).max(0.0);
        let feather = line.feather.clamp(0.0, 1.0);

        if line.points.len() > 1 {
            for points_pair in line.points.windows(2) {
                let p1 = &points_pair[0];
                let p2 = &points_pair[1];

                let x1_f = p1.x as f32 * scale - crop_offset.0;
                let y1_f = p1.y as f32 * scale - crop_offset.1;
                let x2_f = p2.x as f32 * scale - crop_offset.0;
                let y2_f = p2.y as f32 * scale - crop_offset.1;

                let dist = ((x2_f - x1_f).powi(2) + (y2_f - y1_f).powi(2)).sqrt();
                let step_size = (radius * (1.0 - feather) / 2.0).max(1.0);
                let steps = (dist / step_size).ceil() as i32;

                if steps > 1 {
                    for i in 0..=steps {
                        let t = i as f32 / steps as f32;
                        let interp_x = (x1_f + t * (x2_f - x1_f)) as i32;
                        let interp_y = (y1_f + t * (y2_f - y1_f)) as i32;
                        draw_feathered_ellipse_mut(
                            &mut mask,
                            (interp_x, interp_y),
                            radius,
                            feather,
                            color_value,
                            is_eraser,
                        );
                    }
                } else {
                    draw_feathered_ellipse_mut(
                        &mut mask,
                        (x1_f as i32, y1_f as i32),
                        radius,
                        feather,
                        color_value,
                        is_eraser,
                    );
                    draw_feathered_ellipse_mut(
                        &mut mask,
                        (x2_f as i32, y2_f as i32),
                        radius,
                        feather,
                        color_value,
                        is_eraser,
                    );
                }
            }
        } else {
            let p1 = &line.points[0];
            let x1 = (p1.x as f32 * scale - crop_offset.0) as i32;
            let y1 = (p1.y as f32 * scale - crop_offset.1) as i32;
            draw_feathered_ellipse_mut(
                &mut mask,
                (x1, y1),
                radius,
                feather,
                color_value,
                is_eraser,
            );
        }
    }
    mask
}

fn generate_ai_bitmap_from_full_mask(
    full_mask_image: &GrayImage,
    rotation: f32,
    flip_horizontal: bool,
    flip_vertical: bool,
    orientation_steps: u8,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
) -> GrayImage {
    let (full_mask_w, full_mask_h) = full_mask_image.dimensions();
    let mut final_mask = GrayImage::new(width, height);

    let angle_rad = rotation.to_radians();
    let cos_a = angle_rad.cos();
    let sin_a = angle_rad.sin();

    let (coarse_rotated_w, coarse_rotated_h) = if orientation_steps % 2 == 1 {
        (full_mask_h, full_mask_w)
    } else {
        (full_mask_w, full_mask_h)
    };

    let scaled_coarse_rotated_w = coarse_rotated_w as f32 * scale;
    let scaled_coarse_rotated_h = coarse_rotated_h as f32 * scale;
    let center_x = scaled_coarse_rotated_w / 2.0;
    let center_y = scaled_coarse_rotated_h / 2.0;

    for y_out in 0..height {
        for x_out in 0..width {
            let x_uncrop = x_out as f32 + crop_offset.0;
            let y_uncrop = y_out as f32 + crop_offset.1;

            let x_centered = x_uncrop - center_x;
            let y_centered = y_uncrop - center_y;

            let x_unrotated = x_centered * cos_a + y_centered * sin_a + center_x;
            let y_unrotated = -x_centered * sin_a + y_centered * cos_a + center_y;

            let x_unflipped = if flip_horizontal {
                scaled_coarse_rotated_w - x_unrotated
            } else {
                x_unrotated
            };
            let y_unflipped = if flip_vertical {
                scaled_coarse_rotated_h - y_unrotated
            } else {
                y_unrotated
            };

            let (x_unrotated_coarse, y_unrotated_coarse) = match orientation_steps {
                0 => (x_unflipped, y_unflipped),
                1 => (y_unflipped, scaled_coarse_rotated_w - x_unflipped),
                2 => (
                    scaled_coarse_rotated_w - x_unflipped,
                    scaled_coarse_rotated_h - y_unflipped,
                ),
                3 => (scaled_coarse_rotated_h - y_unflipped, x_unflipped),
                _ => (x_unflipped, y_unflipped),
            };

            let x_src = x_unrotated_coarse / scale;
            let y_src = y_unrotated_coarse / scale;

            if x_src >= 0.0
                && x_src < full_mask_w as f32
                && y_src >= 0.0
                && y_src < full_mask_h as f32
            {
                let pixel = full_mask_image.get_pixel(x_src as u32, y_src as u32);
                final_mask.put_pixel(x_out, y_out, *pixel);
            }
        }
    }

    final_mask
}

fn generate_ai_bitmap_from_base64(
    data_url: &str,
    rotation: f32,
    flip_horizontal: bool,
    flip_vertical: bool,
    orientation_steps: u8,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
) -> Option<GrayImage> {
    let b64_data = if let Some(idx) = data_url.find(',') {
        &data_url[idx + 1..]
    } else {
        data_url
    };

    let decoded_bytes = general_purpose::STANDARD.decode(b64_data).ok()?;
    let full_mask_image = image::load_from_memory(&decoded_bytes).ok()?.to_luma8();

    Some(generate_ai_bitmap_from_full_mask(
        &full_mask_image,
        rotation,
        flip_horizontal,
        flip_vertical,
        orientation_steps,
        width,
        height,
        scale,
        crop_offset,
    ))
}

fn generate_ai_sky_bitmap(
    params_value: &Value,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
) -> Option<GrayImage> {
    let params: AiSkyMaskParameters = serde_json::from_value(params_value.clone()).ok()?;
    let grow_feather: GrowFeatherParameters =
        serde_json::from_value(params_value.clone()).unwrap_or_default();
    let data_url = params.mask_data_base64?;

    let mut mask = generate_ai_bitmap_from_base64(
        &data_url,
        params.rotation.unwrap_or(0.0),
        params.flip_horizontal.unwrap_or(false),
        params.flip_vertical.unwrap_or(false),
        params.orientation_steps.unwrap_or(0),
        width,
        height,
        scale,
        crop_offset,
    )?;

    apply_grow_and_feather(
        &mut mask,
        grow_feather.grow,
        grow_feather.feather,
        width,
        height,
    );

    Some(mask)
}

fn generate_ai_foreground_bitmap(
    params_value: &Value,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
) -> Option<GrayImage> {
    let params: AiForegroundMaskParameters = serde_json::from_value(params_value.clone()).ok()?;
    let grow_feather: GrowFeatherParameters =
        serde_json::from_value(params_value.clone()).unwrap_or_default();
    let data_url = params.mask_data_base64?;

    let mut mask = generate_ai_bitmap_from_base64(
        &data_url,
        params.rotation.unwrap_or(0.0),
        params.flip_horizontal.unwrap_or(false),
        params.flip_vertical.unwrap_or(false),
        params.orientation_steps.unwrap_or(0),
        width,
        height,
        scale,
        crop_offset,
    )?;

    apply_grow_and_feather(
        &mut mask,
        grow_feather.grow,
        grow_feather.feather,
        width,
        height,
    );

    Some(mask)
}

fn generate_ai_subject_bitmap(
    params_value: &Value,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
) -> Option<GrayImage> {
    let params: AiSubjectMaskParameters = serde_json::from_value(params_value.clone()).ok()?;
    let grow_feather: GrowFeatherParameters =
        serde_json::from_value(params_value.clone()).unwrap_or_default();
    let data_url = params.mask_data_base64?;

    let mut mask = generate_ai_bitmap_from_base64(
        &data_url,
        params.rotation.unwrap_or(0.0),
        params.flip_horizontal.unwrap_or(false),
        params.flip_vertical.unwrap_or(false),
        params.orientation_steps.unwrap_or(0),
        width,
        height,
        scale,
        crop_offset,
    )?;

    apply_grow_and_feather(
        &mut mask,
        grow_feather.grow,
        grow_feather.feather,
        width,
        height,
    );

    Some(mask)
}

fn generate_all_bitmap(width: u32, height: u32) -> GrayImage {
    GrayImage::from_pixel(width, height, Luma([255]))
}

fn generate_sub_mask_bitmap(
    sub_mask: &SubMask,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
) -> Option<GrayImage> {
    if !sub_mask.visible {
        return None;
    }

    match sub_mask.mask_type.as_str() {
        "radial" => Some(generate_radial_bitmap(
            &sub_mask.parameters,
            width,
            height,
            scale,
            crop_offset,
        )),
        "linear" => Some(generate_linear_bitmap(
            &sub_mask.parameters,
            width,
            height,
            scale,
            crop_offset,
        )),
        "brush" => Some(generate_brush_bitmap(
            &sub_mask.parameters,
            width,
            height,
            scale,
            crop_offset,
        )),
        "ai-subject" => {
            generate_ai_subject_bitmap(&sub_mask.parameters, width, height, scale, crop_offset)
        }
        "ai-foreground" => {
            generate_ai_foreground_bitmap(&sub_mask.parameters, width, height, scale, crop_offset)
        }
        "ai-sky" => generate_ai_sky_bitmap(&sub_mask.parameters, width, height, scale, crop_offset),
        "quick-eraser" => {
            generate_ai_subject_bitmap(&sub_mask.parameters, width, height, scale, crop_offset)
        }
        "all" => Some(generate_all_bitmap(width, height)),
        _ => None,
    }
}

pub fn generate_mask_bitmap(
    mask_def: &MaskDefinition,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
) -> Option<GrayImage> {
    if !mask_def.visible || mask_def.sub_masks.is_empty() {
        return None;
    }

    let mut final_mask = GrayImage::new(width, height);

    for sub_mask in &mask_def.sub_masks {
        if let Some(mut sub_bitmap) =
            generate_sub_mask_bitmap(sub_mask, width, height, scale, crop_offset)
        {
            if sub_mask.invert {
                for p in sub_bitmap.pixels_mut() {
                    p[0] = 255 - p[0];
                }
            }

            let opacity_multiplier = (sub_mask.opacity / 100.0).clamp(0.0, 1.0);
            if opacity_multiplier < 1.0 {
                for pixel in sub_bitmap.pixels_mut() {
                    pixel[0] = (pixel[0] as f32 * opacity_multiplier) as u8;
                }
            }

            match sub_mask.mode {
                SubMaskMode::Additive => {
                    for (x, y, pixel) in final_mask.enumerate_pixels_mut() {
                        let sub_pixel = sub_bitmap.get_pixel(x, y);
                        pixel[0] = pixel[0].max(sub_pixel[0]);
                    }
                }
                SubMaskMode::Subtractive => {
                    for (x, y, pixel) in final_mask.enumerate_pixels_mut() {
                        let sub_pixel = sub_bitmap.get_pixel(x, y);
                        pixel[0] = pixel[0].saturating_sub(sub_pixel[0]);
                    }
                }
            }
        }
    }

    if mask_def.invert {
        for pixel in final_mask.pixels_mut() {
            pixel[0] = 255 - pixel[0];
        }
    }

    let opacity_multiplier = (mask_def.opacity / 100.0).clamp(0.0, 1.0);
    if opacity_multiplier < 1.0 {
        for pixel in final_mask.pixels_mut() {
            pixel[0] = (pixel[0] as f32 * opacity_multiplier) as u8;
        }
    }

    Some(final_mask)
}
