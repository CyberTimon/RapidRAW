use crate::app::state::AppState;
use crate::decode::white_balance::{self, WhiteBalance};
use crate::render::image_processing::srgb_channel_to_linear;
use crate::render::preview::cached_patched_image;
use image::{DynamicImage, GenericImageView};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::borrow::Cow;

#[derive(Deserialize, Clone, Copy)]
pub struct UvPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WhiteBalanceSample {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub temperature: f32,
    pub tint: f32,
    pub count: u32,
}

const MAX_WB_SAMPLES: f64 = 262_144.0;

fn read_linear_rgb(image: &DynamicImage, x: u32, y: u32, is_raw: bool) -> Option<[f32; 3]> {
    let rgb = match image {
        DynamicImage::ImageRgb32F(buf) => {
            let p = buf.get_pixel(x, y);
            [p[0], p[1], p[2]]
        }
        DynamicImage::ImageRgba32F(buf) => {
            let p = buf.get_pixel(x, y);
            [p[0], p[1], p[2]]
        }
        _ => {
            let p = image.crop_imm(x, y, 1, 1).to_rgb32f();
            let p = p.get_pixel(0, 0);
            [p[0], p[1], p[2]]
        }
    };

    if rgb.iter().any(|c| !c.is_finite()) {
        return None;
    }

    let rgb = rgb.map(|c| c.max(0.0));
    if is_raw {
        Some(rgb)
    } else {
        Some(rgb.map(srgb_channel_to_linear))
    }
}

fn point_in_convex_quad(px: f64, py: f64, quad: &[(f64, f64)]) -> bool {
    let mut has_pos = false;
    let mut has_neg = false;
    for i in 0..quad.len() {
        let (ax, ay) = quad[i];
        let (bx, by) = quad[(i + 1) % quad.len()];
        let cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
        if cross > 0.0 {
            has_pos = true;
        } else if cross < 0.0 {
            has_neg = true;
        }
        if has_pos && has_neg {
            return false;
        }
    }
    true
}

fn compute_white_balance_sample(
    image: &DynamicImage,
    is_raw: bool,
    as_shot: WhiteBalance,
    corners: &[UvPoint],
) -> Result<WhiteBalanceSample, String> {
    if corners.len() < 3 {
        return Err("At least three corners are required".to_string());
    }

    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return Err("Image is empty".to_string());
    }

    let quad: Vec<(f64, f64)> = corners
        .iter()
        .map(|c| (c.x * width as f64, c.y * height as f64))
        .collect();

    if quad.iter().any(|(x, y)| !x.is_finite() || !y.is_finite()) {
        return Err("Invalid sample corners".to_string());
    }

    let min_x = quad.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
    let max_x = quad.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max);
    let min_y = quad.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
    let max_y = quad.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);

    let start_x = min_x.floor().clamp(0.0, width as f64) as u32;
    let end_x = max_x.ceil().clamp(0.0, width as f64) as u32;
    let start_y = min_y.floor().clamp(0.0, height as f64) as u32;
    let end_y = max_y.ceil().clamp(0.0, height as f64) as u32;

    let area = (end_x.saturating_sub(start_x) as f64) * (end_y.saturating_sub(start_y) as f64);
    let stride = ((area / MAX_WB_SAMPLES).sqrt().ceil() as usize).max(1);

    let mut sum = [0.0f64; 3];
    let mut count: u32 = 0;

    for y in (start_y..end_y).step_by(stride) {
        for x in (start_x..end_x).step_by(stride) {
            if !point_in_convex_quad(x as f64 + 0.5, y as f64 + 0.5, &quad) {
                continue;
            }
            if let Some(rgb) = read_linear_rgb(image, x, y, is_raw) {
                sum[0] += rgb[0] as f64;
                sum[1] += rgb[1] as f64;
                sum[2] += rgb[2] as f64;
                count += 1;
            }
        }
    }

    if count == 0 {
        let cx = quad.iter().map(|p| p.0).sum::<f64>() / quad.len() as f64;
        let cy = quad.iter().map(|p| p.1).sum::<f64>() / quad.len() as f64;
        let x = (cx.floor().max(0.0) as u32).min(width - 1);
        let y = (cy.floor().max(0.0) as u32).min(height - 1);
        let rgb = read_linear_rgb(image, x, y, is_raw).ok_or("Sampled pixel is invalid")?;
        sum = [rgb[0] as f64, rgb[1] as f64, rgb[2] as f64];
        count = 1;
    }

    let r = (sum[0] / count as f64) as f32;
    let g = (sum[1] / count as f64) as f32;
    let b = (sum[2] / count as f64) as f32;
    let picked = white_balance::pick_white_balance([r as f64, g as f64, b as f64], as_shot)
        .unwrap_or(as_shot);

    Ok(WhiteBalanceSample {
        r,
        g,
        b,
        temperature: picked.temperature as f32,
        tint: picked.tint as f32,
        count,
    })
}

#[tauri::command]
pub async fn sample_white_balance(
    corners: Vec<UvPoint>,
    js_adjustments: Option<Value>,
    state: tauri::State<'_, AppState>,
) -> Result<WhiteBalanceSample, String> {
    let loaded_image = state
        .original_image
        .lock()
        .unwrap()
        .clone()
        .ok_or("No original image loaded")?;
    let adjustments = js_adjustments.unwrap_or_default();
    let converted = crate::adjustments::negative_conversion::is_enabled(&adjustments)
        .then(|| cached_patched_image(&state, &loaded_image.image, &adjustments))
        .flatten();

    tokio::task::spawn_blocking(move || {
        let image = match &converted {
            Some(image) => Cow::Borrowed(image.as_ref()),
            None => crate::adjustments::negative_conversion::apply_negative_conversion(
                Cow::Borrowed(loaded_image.image.as_ref()),
                &adjustments,
            ),
        };
        compute_white_balance_sample(
            &image,
            crate::adjustments::negative_conversion::effective_is_raw(
                loaded_image.is_raw,
                &adjustments,
            ),
            loaded_image.as_shot.white_balance,
            &corners,
        )
    })
    .await
    .map_err(|e| format!("Task execution failed: {}", e))?
}
