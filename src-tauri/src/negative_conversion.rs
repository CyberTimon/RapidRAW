use crate::file_management::{load_settings, parse_virtual_path, read_file_mapped};
use crate::image_loader::load_base_image_from_bytes;
use std::fs;
use std::path::Path;
use tauri::AppHandle;
use std::io::Cursor;
use std::cmp::Ordering;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use image::{DynamicImage, Rgb32FImage};
use rayon::prelude::*;
use base64::{Engine as _, engine::general_purpose};
use image::codecs::jpeg::JpegEncoder;
use serde::{Deserialize, Serialize};

use crate::image_processing::downscale_f32_image;
use crate::AppState;

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
pub struct NegativeConversionParams {
    pub red_weight: f32,
    pub green_weight: f32,
    pub blue_weight: f32,

    pub exposure: f32,
    pub contrast: f32,
}

impl Default for NegativeConversionParams {
    fn default() -> Self {
        Self {
            red_weight: 1.0,
            green_weight: 1.0,
            blue_weight: 1.0,
            exposure: 0.0,
            contrast: 1.0,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ChannelBounds {
    pub min: f32,
    pub max: f32,
}

fn analyze_bounds(log_data: &[f32], width: usize, height: usize) -> [ChannelBounds; 3] {
    let margin_x = (width as f32 * 0.12) as usize;
    let margin_y = (height as f32 * 0.12) as usize;

    let est_pixels = (width.saturating_sub(margin_x * 2)) * (height.saturating_sub(margin_y * 2));
    let step = (est_pixels / 40_000).max(1);

    let mut r_vals = Vec::with_capacity(est_pixels / step);
    let mut g_vals = Vec::with_capacity(est_pixels / step);
    let mut b_vals = Vec::with_capacity(est_pixels / step);

    for y in (margin_y..(height - margin_y)).step_by(3) {
        let row_offset = y * width * 3;
        
        for x in (margin_x..(width - margin_x)).step_by(step) {
            let idx = row_offset + (x * 3);

            if idx + 2 < log_data.len() {
                let r = log_data[idx];
                let g = log_data[idx+1];
                let b = log_data[idx+2];

                if r.is_finite() { r_vals.push(r); }
                if g.is_finite() { g_vals.push(g); }
                if b.is_finite() { b_vals.push(b); }
            }
        }
    }

    let get_bounds = |mut vals: Vec<f32>| -> ChannelBounds {
        if vals.is_empty() { 
            return ChannelBounds { min: 0.0, max: 1.0 }; 
        }
        
        vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
        
        let len = vals.len() as f32;

        let min_idx = (len * 0.001) as usize;
        let max_idx = (len * 0.999) as usize;
        
        let min = vals[min_idx.min(vals.len().saturating_sub(1))];
        let max = vals[max_idx.min(vals.len().saturating_sub(1))];

        let safe_max = if max <= min + 0.0001 { min + 1.0 } else { max };
        
        ChannelBounds { min, max: safe_max }
    };

    [get_bounds(r_vals), get_bounds(g_vals), get_bounds(b_vals)]
}

fn run_pipeline(
    input: &DynamicImage,
    params: &NegativeConversionParams,
    override_bounds: Option<[ChannelBounds; 3]>,
) -> DynamicImage {
    let rgb = input.to_rgb32f();
    let (width, height) = rgb.dimensions();
    let raw_pixels = rgb.as_raw();

    let log_pixels: Vec<f32> = raw_pixels.par_iter().map(|&v| {
        -v.clamp(1e-6, 1.0).log10()
    }).collect();

    let bounds = if let Some(b) = override_bounds {
        b
    } else {
        analyze_bounds(&log_pixels, width as usize, height as usize)
    };
    
    let mut out_buffer = vec![0.0f32; raw_pixels.len()];

    let k = 4.0 * params.contrast.max(0.1); 
    let x0 = 0.5 - (params.exposure * 0.25);
    let gamma_inv = 1.0 / 2.2; 

    let y0 = 1.0 / (1.0 + (k * x0).exp());
    let y1 = 1.0 / (1.0 + (-k * (1.0 - x0)).exp());
    let scale = 1.0 / (y1 - y0);

    out_buffer.par_chunks_mut(3).enumerate().for_each(|(i, out_pixel)| {
        let idx = i * 3;

        let mut n_r = (log_pixels[idx] - bounds[0].min) / (bounds[0].max - bounds[0].min);
        let mut n_g = (log_pixels[idx + 1] - bounds[1].min) / (bounds[1].max - bounds[1].min);
        let mut n_b = (log_pixels[idx + 2] - bounds[2].min) / (bounds[2].max - bounds[2].min);

        n_r = n_r.max(0.0) * params.red_weight;
        n_g = n_g.max(0.0) * params.green_weight;
        n_b = n_b.max(0.0) * params.blue_weight;

        let apply_curve = |x: f32| -> f32 {
            let sigmoid = 1.0 / (1.0 + (-k * (x - x0)).exp());
            let s_norm = (sigmoid - y0) * scale;
            s_norm.clamp(0.0, 1.0)
        };

        let mut r = apply_curve(n_r);
        let mut g = apply_curve(n_g);
        let mut b = apply_curve(n_b);

        let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        let max_ch = r.max(g).max(b);
        
        if max_ch > 0.9 {
            let overflow = ((max_ch - 0.9) * 10.0).clamp(0.0, 1.0);
            let sat_reduction = overflow * overflow;
            
            r = r + (luma - r) * sat_reduction;
            g = g + (luma - g) * sat_reduction;
            b = b + (luma - b) * sat_reduction;
        }

        out_pixel[0] = r.clamp(0.0, 1.0).powf(gamma_inv);
        out_pixel[1] = g.clamp(0.0, 1.0).powf(gamma_inv);
        out_pixel[2] = b.clamp(0.0, 1.0).powf(gamma_inv);
    });

    let out_img = Rgb32FImage::from_vec(width, height, out_buffer).unwrap();
    DynamicImage::ImageRgb32F(out_img)
}

#[tauri::command]
pub async fn preview_negative_conversion(
    path: String,
    params: NegativeConversionParams,
    state: tauri::State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let (source_path, _) = parse_virtual_path(&path);
    let source_path_str = source_path.to_string_lossy().to_string();

    let mut hasher = DefaultHasher::new();
    source_path_str.hash(&mut hasher);
    "negative_preview_base".hash(&mut hasher);
    let cache_key = hasher.finish();

    let base_image_for_processing = {
        let mut cache = state.geometry_cache.lock().unwrap();
        
        if let Some(cached_img) = cache.get(&cache_key) {
            cached_img.clone()
        } else {
            let image_to_downscale = {
                let original_lock = state.original_image.lock().unwrap();
                if let Some(loaded) = original_lock.as_ref() {
                    if loaded.path == source_path_str {
                        loaded.image.clone().as_ref().clone()
                    } else {
                        drop(original_lock);
                        let settings = load_settings(app_handle.clone()).unwrap_or_default();
                        let highlight_compression = settings.raw_highlight_compression.unwrap_or(2.5);
                        let linear_mode = settings.linear_raw_mode;
                        
                        match read_file_mapped(Path::new(&source_path_str)) {
                            Ok(mmap) => load_base_image_from_bytes(&mmap, &source_path_str, false, highlight_compression, linear_mode.clone(), None)
                                .map_err(|e| e.to_string())?,
                            Err(_e) => {
                                let bytes = fs::read(&source_path_str).map_err(|io_err| io_err.to_string())?;
                                load_base_image_from_bytes(&bytes, &source_path_str, false, highlight_compression, linear_mode.clone(), None)
                                    .map_err(|e| e.to_string())?
                            }
                        }
                    }
                } else {
                    drop(original_lock);
                    let settings = load_settings(app_handle.clone()).unwrap_or_default();
                    let highlight_compression = settings.raw_highlight_compression.unwrap_or(2.5);
                    let linear_mode = settings.linear_raw_mode;

                    match read_file_mapped(Path::new(&source_path_str)) {
                        Ok(mmap) => load_base_image_from_bytes(&mmap, &source_path_str, false, highlight_compression, linear_mode.clone(), None)
                            .map_err(|e| e.to_string())?,
                        Err(_e) => {
                            let bytes = fs::read(&source_path_str).map_err(|io_err| io_err.to_string())?;
                            load_base_image_from_bytes(&bytes, &source_path_str, false, highlight_compression, linear_mode.clone(), None)
                                .map_err(|e| e.to_string())?
                        }
                    }
                }
            };

            let downscaled = downscale_f32_image(&image_to_downscale, 1080, 1080);

            cache.insert(cache_key, downscaled.clone());
            downscaled
        }
    };

    let processed = run_pipeline(&base_image_for_processing, &params, None);

    let mut buf = Cursor::new(Vec::new());
    processed.to_rgb8()
        .write_with_encoder(JpegEncoder::new_with_quality(&mut buf, 80))
        .map_err(|e| e.to_string())?;
    
    let base64_str = general_purpose::STANDARD.encode(buf.get_ref());
    Ok(format!("data:image/jpeg;base64,{}", base64_str))
}

#[tauri::command]
pub async fn convert_negative_full(
    path: String,
    params: NegativeConversionParams,
    state: tauri::State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let (source_path, _) = parse_virtual_path(&path);
    let source_path_str = source_path.to_string_lossy().to_string();

    let original_image = {
        let original_lock = state.original_image.lock().unwrap();
        if let Some(loaded) = original_lock.as_ref() {
            if loaded.path == source_path_str {
                loaded.image.clone().as_ref().clone()
            } else {
                drop(original_lock);
                let settings = load_settings(app_handle.clone()).unwrap_or_default();
                let highlight_compression = settings.raw_highlight_compression.unwrap_or(2.5);
                let linear_mode = settings.linear_raw_mode;

                match read_file_mapped(Path::new(&source_path_str)) {
                    Ok(mmap) => load_base_image_from_bytes(&mmap, &source_path_str, false, highlight_compression, linear_mode.clone(), None)
                        .map_err(|e| e.to_string())?,
                    Err(_e) => {
                        let bytes = fs::read(&source_path_str).map_err(|io_err| io_err.to_string())?;
                        load_base_image_from_bytes(&bytes, &source_path_str, false, highlight_compression, linear_mode.clone(), None)
                            .map_err(|e| e.to_string())?
                    }
                }
            }
        } else {
            drop(original_lock);
            let settings = load_settings(app_handle.clone()).unwrap_or_default();
            let highlight_compression = settings.raw_highlight_compression.unwrap_or(2.5);
            let linear_mode = settings.linear_raw_mode;

            match read_file_mapped(Path::new(&source_path_str)) {
                Ok(mmap) => load_base_image_from_bytes(&mmap, &source_path_str, false, highlight_compression, linear_mode.clone(), None)
                    .map_err(|e| e.to_string())?,
                Err(_e) => {
                    let bytes = fs::read(&source_path_str).map_err(|io_err| io_err.to_string())?;
                    load_base_image_from_bytes(&bytes, &source_path_str, false, highlight_compression, linear_mode.clone(), None)
                        .map_err(|e| e.to_string())?
                }
            }
        }
    };

    let bounds_reference_img = downscale_f32_image(&original_image, 1080, 1080);

    let ref_rgb = bounds_reference_img.to_rgb32f();
    let (ref_w, ref_h) = ref_rgb.dimensions();
    let ref_log_pixels: Vec<f32> = ref_rgb.as_raw().par_iter().map(|&v| {
        -v.clamp(1e-6, 1.0).log10()
    }).collect();

    let correct_bounds = analyze_bounds(&ref_log_pixels, ref_w as usize, ref_h as usize);
    let processed = run_pipeline(&original_image, &params, Some(correct_bounds));

    *state.negative_conversion_result.lock().unwrap() = Some(processed);
    
    Ok(())
}

#[tauri::command]
pub async fn save_converted_negative(
    original_path_str: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let processed_image = state
        .negative_conversion_result
        .lock()
        .unwrap()
        .take()
        .ok_or("No converted negative found in memory. Please run conversion first.")?;

    let path = std::path::Path::new(&original_path_str);
    let parent = path.parent().unwrap_or(std::path::Path::new(""));
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();

    let filename = format!("{}_Positive.tiff", stem);
    let out_path = parent.join(filename);

    processed_image.to_rgb16().save(&out_path).map_err(|e| e.to_string())?;

    Ok(out_path.to_string_lossy().to_string())
}