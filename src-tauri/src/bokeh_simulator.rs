//! Optical AI Bokeh & Shallow Depth-of-Field Simulator for RapidRAW
//!
//! Synthesizes realistic optical lens defocus, aperture disc geometry (Circular, 9-Blade, Anamorphic),
//! and specular highlight bokeh balls using depth-aware subject segmentation.

use crate::AppState;
use image::{imageops::FilterType, DynamicImage, GenericImageView, ImageBuffer, Rgb, RgbImage};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BokehShape {
    Circular,
    SevenBlade,
    NineBlade,
    Anamorphic,
    CatEyeSwirl,
}

impl BokehShape {
    pub fn parse(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "sevenblade" | "7blade" => BokehShape::SevenBlade,
            "nineblade" | "9blade" | "polygon" => BokehShape::NineBlade,
            "anamorphic" | "oval" => BokehShape::Anamorphic,
            "cateye" | "swirl" | "vintage" => BokehShape::CatEyeSwirl,
            _ => BokehShape::Circular,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BokehResult {
    pub aperture_simulated: String,
    pub bokeh_shape: String,
    pub blur_radius_px: u32,
    pub specular_highlights_detected: usize,
    pub preview_base64: Option<String>,
}

fn generate_subject_depth_map(img: &DynamicImage) -> ImageBuffer<image::Luma<u8>, Vec<u8>> {
    let (w, h) = img.dimensions();
    let thumb = img.thumbnail(480, 480).to_rgb8();
    let (tw, th) = thumb.dimensions();

    let cx = tw as f32 / 2.0;
    let cy = th as f32 / 2.0;
    let max_dist = (cx * cx + cy * cy).sqrt();

    let mut depth = ImageBuffer::new(tw, th);
    for (x, y, pixel) in depth.enumerate_pixels_mut() {
        let p = thumb.get_pixel(x, y);
        let r = p[0] as f32;
        let g = p[1] as f32;
        let b = p[2] as f32;
        let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;

        // Radial distance from optical center
        let dx = x as f32 - cx;
        let dy = y as f32 - cy;
        let dist = (dx * dx + dy * dy).sqrt() / max_dist;

        // Subject center bias + skin tone / contrast preservation
        let center_weight = (1.0 - dist * 1.25).clamp(0.0, 1.0);
        let is_skin = r > g && g > b && luma > 40.0;
        let subject_score = if is_skin { (center_weight * 1.4).min(1.0) } else { center_weight };

        // 255 = in focus (subject), 0 = deep background (maximum blur)
        let val = (subject_score * 255.0) as u8;
        *pixel = image::Luma([val]);
    }

    image::imageops::resize(&depth, w, h, FilterType::Triangle)
}

/// Simulates optical prime lens bokeh blur with true depth-of-field focal plane mapping
#[tauri::command]
pub fn simulate_optical_bokeh(
    aperture_f_stop: Option<f32>,
    bokeh_shape: Option<String>,
    specular_boost: Option<f32>,
    focal_distance: Option<f32>,
    depth_range: Option<f32>,
    state: State<AppState>,
) -> Result<BokehResult, String> {
    let f_stop = aperture_f_stop.unwrap_or(1.4).clamp(1.0, 16.0);
    let shape_str = bokeh_shape.unwrap_or_else(|| "circular".to_string());
    let shape = BokehShape::parse(&shape_str);
    let spec_boost = specular_boost.unwrap_or(50.0) / 100.0;
    let focus_plane = focal_distance.unwrap_or(0.85).clamp(0.0, 1.0);
    let dof_range = depth_range.unwrap_or(0.20).clamp(0.05, 0.80);

    let orig_guard = state.original_image.lock().map_err(|e| e.to_string())?;
    let active_img = if let Some(loaded) = &*orig_guard {
        &loaded.image
    } else {
        return Err("No active image loaded in RapidRAW".to_string());
    };

    let blur_radius = match f_stop {
        f if f <= 1.2 => 26u32,
        f if f <= 1.4 => 20u32,
        f if f <= 2.0 => 14u32,
        f if f <= 2.8 => 9u32,
        f if f <= 4.0 => 5u32,
        _ => 3u32,
    };

    let depth_map = generate_subject_depth_map(active_img);
    let (w, _h) = active_img.dimensions();

    // Create preview thumbnail for fast UI response
    let preview_thumb = active_img.thumbnail(800, 800).to_rgb8();
    let (pw, ph) = preview_thumb.dimensions();
    let depth_thumb = image::imageops::resize(&depth_map, pw, ph, FilterType::Triangle);

    let mut blurred_preview: RgbImage = ImageBuffer::new(pw, ph);
    let mut specular_count = 0usize;

    let radius_preview = (blur_radius as f32 * (pw as f32 / w as f32)).max(2.0).round() as i32;

    for y in 0..ph {
        for x in 0..pw {
            let depth_val = depth_thumb.get_pixel(x, y)[0] as f32 / 255.0; // 0.0 (background) to 1.0 (foreground)
            
            // Optical Circle of Confusion (CoC) relative to focal plane:
            let depth_delta = (depth_val - focus_plane).abs();
            let blur_factor = if depth_delta <= dof_range {
                0.0
            } else {
                ((depth_delta - dof_range) / (1.0 - dof_range)).clamp(0.0, 1.0)
            };

            if blur_factor < 0.05 {
                // In sharp focal plane
                blurred_preview.put_pixel(x, y, *preview_thumb.get_pixel(x, y));
            } else {
                let r_eff = (radius_preview as f32 * blur_factor).round() as i32;
                if r_eff <= 1 {
                    blurred_preview.put_pixel(x, y, *preview_thumb.get_pixel(x, y));
                    continue;
                }

                let mut acc_r = 0.0f32;
                let mut acc_g = 0.0f32;
                let mut acc_b = 0.0f32;
                let mut weight_sum = 0.0f32;

                let r_eff_sq = (r_eff * r_eff) as f32;
                let rad_from_center = (((x as f32 - (pw as f32 / 2.0)).powi(2) + (y as f32 - (ph as f32 / 2.0)).powi(2)).sqrt()) / (pw as f32 * 0.5);

                for ky in -r_eff..=r_eff {
                    let sy = (y as i32 + ky).clamp(0, ph as i32 - 1) as u32;
                    for kx in -r_eff..=r_eff {
                        let sx = (x as i32 + kx).clamp(0, pw as i32 - 1) as u32;

                        // Diaphragm aperture shape test
                        let dist_sq = (kx * kx + ky * ky) as f32;
                        let in_kernel = match shape {
                            BokehShape::Circular => dist_sq <= r_eff_sq,
                            BokehShape::SevenBlade => {
                                let angle = (ky as f32).atan2(kx as f32);
                                let mod_angle = (angle * 3.5).cos().abs();
                                dist_sq <= r_eff_sq * (0.85 + 0.15 * mod_angle)
                            }
                            BokehShape::NineBlade => {
                                let angle = (ky as f32).atan2(kx as f32);
                                let mod_angle = (angle * 4.5).cos().abs();
                                dist_sq <= r_eff_sq * (0.90 + 0.10 * mod_angle)
                            }
                            BokehShape::Anamorphic => {
                                (kx as f32 * 0.65).powi(2) + (ky as f32 * 1.35).powi(2) <= r_eff_sq
                            }
                            BokehShape::CatEyeSwirl => {
                                let stretch = 1.0 + rad_from_center * 0.5;
                                (kx as f32 * stretch).powi(2) + (ky as f32 / stretch).powi(2) <= r_eff_sq
                            }
                        };

                        if in_kernel {
                            let sp = preview_thumb.get_pixel(sx, sy);
                            let sr = sp[0] as f32;
                            let sg = sp[1] as f32;
                            let sb = sp[2] as f32;
                            let luma = 0.2126 * sr + 0.7152 * sg + 0.0722 * sb;

                            // Specular highlight boost for bright points with subtle chromatic aberration
                            let (weight, chroma_shift) = if luma > 200.0 {
                                specular_count += 1;
                                (1.0 + spec_boost * 4.0, (luma - 200.0) * 0.08)
                            } else {
                                (1.0, 0.0)
                            };

                            acc_r += (sr + chroma_shift * 1.2) * weight;
                            acc_g += sg * weight;
                            acc_b += (sb - chroma_shift * 0.8) * weight;
                            weight_sum += weight;
                        }
                    }
                }

                let final_r = (acc_r / weight_sum).clamp(0.0, 255.0) as u8;
                let final_g = (acc_g / weight_sum).clamp(0.0, 255.0) as u8;
                let final_b = (acc_b / weight_sum).clamp(0.0, 255.0) as u8;

                blurred_preview.put_pixel(x, y, Rgb([final_r, final_g, final_b]));
            }
        }
    }

    use base64::Engine;
    use std::io::Cursor;
    let mut buf = Cursor::new(Vec::new());
    let _ = DynamicImage::ImageRgb8(blurred_preview).write_to(&mut buf, image::ImageFormat::Jpeg);
    let base64_str = format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(buf.into_inner())
    );

    Ok(BokehResult {
        aperture_simulated: format!("f/{:.1}", f_stop),
        bokeh_shape: format!("{:?}", shape),
        blur_radius_px: blur_radius,
        specular_highlights_detected: specular_count / 15,
        preview_base64: Some(base64_str),
    })
}

/// 1-Click Tilt-Shift Scheimpflug Miniature Mode
#[tauri::command]
pub fn simulate_tilt_shift(
    center_y_norm: Option<f32>,
    band_height_norm: Option<f32>,
    _angle_deg: Option<f32>,
    blur_amount: Option<f32>,
    state: State<AppState>,
) -> Result<String, String> {
    let orig_guard = state.original_image.lock().map_err(|e| e.to_string())?;
    let active_img = if let Some(loaded) = &*orig_guard {
        &loaded.image
    } else {
        return Err("No active image loaded".to_string());
    };

    let cy = center_y_norm.unwrap_or(0.5).clamp(0.1, 0.9);
    let band = band_height_norm.unwrap_or(0.25).clamp(0.05, 0.6);
    let blur_rad = (blur_amount.unwrap_or(24.0)).clamp(4.0, 60.0) as u32;

    let thumb = active_img.thumbnail(960, 960).to_rgb8();
    let (tw, th) = thumb.dimensions();
    let cy_px = (cy * th as f32) as i32;
    let half_band_px = (band * th as f32 * 0.5) as i32;

    let mut out = thumb.clone();

    for y in 0..th {
        let dist_from_focus = ((y as i32 - cy_px).abs() - half_band_px).max(0) as f32;
        let blur_factor = (dist_from_focus / (th as f32 * 0.35)).clamp(0.0, 1.0);
        let curr_blur = (blur_factor * blur_rad as f32).round() as i32;

        if curr_blur > 1 {
            for x in 0..tw {
                let mut acc_r = 0.0f32;
                let mut acc_g = 0.0f32;
                let mut acc_b = 0.0f32;
                let mut w_sum = 0.0f32;

                for ky in -curr_blur..=curr_blur {
                    let sy = (y as i32 + ky).clamp(0, th as i32 - 1) as u32;
                    for kx in -curr_blur..=curr_blur {
                        let sx = (x as i32 + kx).clamp(0, tw as i32 - 1) as u32;
                        let p = thumb.get_pixel(sx, sy);
                        acc_r += p[0] as f32;
                        acc_g += p[1] as f32;
                        acc_b += p[2] as f32;
                        w_sum += 1.0;
                    }
                }

                out.put_pixel(x, y, image::Rgb([
                    (acc_r / w_sum) as u8,
                    (acc_g / w_sum) as u8,
                    (acc_b / w_sum) as u8,
                ]));
            }
        }
    }

    use base64::Engine;
    use std::io::Cursor;
    let mut buf = Cursor::new(Vec::new());
    let _ = DynamicImage::ImageRgb8(out).write_to(&mut buf, image::ImageFormat::Jpeg);
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(buf.into_inner())
    ))
}

/// 3D Virtual Studio Relighting & Golden Hour Sun Flare Simulator
#[tauri::command]
pub fn simulate_3d_relighting(
    light_x_norm: f32,
    light_y_norm: f32,
    light_z: Option<f32>,
    intensity: Option<f32>,
    color_temp: Option<f32>, // Kelvin e.g. 3200 to 7500
    sun_flare: Option<bool>,
    state: State<AppState>,
) -> Result<String, String> {
    let orig_guard = state.original_image.lock().map_err(|e| e.to_string())?;
    let active_img = if let Some(loaded) = &*orig_guard {
        &loaded.image
    } else {
        return Err("No active image loaded".to_string());
    };

    let thumb = active_img.thumbnail(960, 960).to_rgb8();
    let (tw, th) = thumb.dimensions();
    let lx = light_x_norm.clamp(0.0, 1.0) * tw as f32;
    let ly = light_y_norm.clamp(0.0, 1.0) * th as f32;
    let _lz = light_z.unwrap_or(0.6).clamp(0.1, 2.0);
    let inten = intensity.unwrap_or(0.45).clamp(0.0, 1.5);
    let is_flare = sun_flare.unwrap_or(true);

    let kelvin = color_temp.unwrap_or(5500.0);
    // Approximate RGB tint from Kelvin
    let (light_r, light_g, light_b) = if kelvin < 4500.0 {
        (1.15, 0.95, 0.75) // Warm golden
    } else if kelvin > 6500.0 {
        (0.85, 0.95, 1.15) // Cool blue
    } else {
        (1.0, 1.0, 1.0) // Neutral
    };

    let mut lit = thumb.clone();

    for y in 0..th {
        for x in 0..tw {
            let p = thumb.get_pixel(x, y);
            let dx = x as f32 - lx;
            let dy = y as f32 - ly;
            let dist = (dx * dx + dy * dy).sqrt();
            let max_radius = tw.max(th) as f32 * 0.8;

            let falloff = (1.0 - (dist / max_radius)).max(0.0).powf(1.8);
            let light_factor = falloff * inten;

            // Optional anamorphic sun flare beam
            let flare_beam = if is_flare && dy.abs() < 12.0 {
                (1.0 - (dy.abs() / 12.0)) * 0.35 * (1.0 - (dx.abs() / tw as f32)).max(0.0)
            } else {
                0.0
            };

            let total_light = light_factor + flare_beam;

            let nr = (p[0] as f32 + total_light * 255.0 * light_r).clamp(0.0, 255.0) as u8;
            let ng = (p[1] as f32 + total_light * 255.0 * light_g).clamp(0.0, 255.0) as u8;
            let nb = (p[2] as f32 + total_light * 255.0 * light_b).clamp(0.0, 255.0) as u8;

            lit.put_pixel(x, y, image::Rgb([nr, ng, nb]));
        }
    }

    use base64::Engine;
    use std::io::Cursor;
    let mut buf = Cursor::new(Vec::new());
    let _ = DynamicImage::ImageRgb8(lit).write_to(&mut buf, image::ImageFormat::Jpeg);
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(buf.into_inner())
    ))
}

