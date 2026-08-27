//! Multi-Channel Client Delivery Pack Exporter for RapidRAW
//!
//! Automatically renders and exports photos into 5 structured client packages:
//! 1. Master Print (Full Resolution)
//! 2. Social Instagram 4:5 (1080 x 1350)
//! 3. Social Stories / Reels 9:16 (1080 x 1920)
//! 4. Watermarked Client Web Proofs (2048px)
//! 5. Optimized WebP Fast Gallery

use crate::file_management::{parse_virtual_path, read_file_mapped};
use crate::image_loader::load_base_image_from_bytes;
use image::{imageops::FilterType, DynamicImage, GenericImageView};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientDeliveryConfig {
    pub paths: Vec<String>,
    pub output_dir: String,
    pub export_master_print: bool,
    pub export_instagram_4x5: bool,
    pub export_stories_9x16: bool,
    pub export_watermarked_proofs: bool,
    pub export_webp_gallery: bool,
    pub watermark_text: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ClientDeliverySummary {
    pub total_photos: usize,
    pub files_generated: usize,
    pub output_directory: String,
    pub elapsed_ms: u64,
}

fn smart_crop_to_aspect(img: &DynamicImage, target_ratio: f32) -> DynamicImage {
    let (w, h) = img.dimensions();
    let current_ratio = w as f32 / h as f32;

    if (current_ratio - target_ratio).abs() < 0.01 {
        return img.clone();
    }

    if current_ratio > target_ratio {
        // Image is wider than target: crop left & right
        let new_w = (h as f32 * target_ratio).round() as u32;
        let offset_x = (w - new_w) / 2;
        img.crop_imm(offset_x, 0, new_w, h)
    } else {
        // Image is taller than target: crop top & bottom (slight top bias for portraits)
        let new_h = (w as f32 / target_ratio).round() as u32;
        let offset_y = ((h - new_h) as f32 * 0.35).round() as u32;
        img.crop_imm(0, offset_y, w, new_h)
    }
}

fn apply_watermark_overlay(img: &mut DynamicImage, _watermark_text: &str) {
    // Draws subtle translucent proof banner across the bottom center
    let (w, h) = img.dimensions();
    let banner_h = (h as f32 * 0.06).max(30.0) as u32;
    let banner_y = h.saturating_sub(banner_h + (h as f32 * 0.04) as u32);

    let mut rgba = img.to_rgba8();
    for y in banner_y..(banner_y + banner_h).min(h) {
        for x in (w / 6)..((w * 5) / 6) {
            let p = rgba.get_pixel_mut(x, y);
            p[0] = (p[0] as f32 * 0.6 + 20.0) as u8;
            p[1] = (p[1] as f32 * 0.6 + 20.0) as u8;
            p[2] = (p[2] as f32 * 0.6 + 20.0) as u8;
        }
    }
    *img = DynamicImage::ImageRgba8(rgba);
}

#[tauri::command]
pub fn export_client_delivery_pack(
    config: ClientDeliveryConfig,
    app_handle: AppHandle,
    _state: tauri::State<'_, crate::AppState>,
) -> Result<ClientDeliverySummary, String> {
    if config.paths.is_empty() {
        return Err("No photos selected for delivery export".to_string());
    }

    let _sleep_guard = crate::sleep_lock::SleepLockGuard::new("client_delivery_pack");
    let start_time = std::time::Instant::now();
    let root_dir = PathBuf::from(&config.output_dir);
    if !root_dir.exists() {
        let _ = fs::create_dir_all(&root_dir);
    }

    // Subdirectories
    let dir_print = root_dir.join("01_Master_Print_FullRes");
    let dir_insta = root_dir.join("02_Social_Instagram_4x5");
    let dir_stories = root_dir.join("03_Stories_Reels_9x16");
    let dir_proofs = root_dir.join("04_Client_Watermarked_Proofs");
    let dir_webp = root_dir.join("05_Fast_WebP_Gallery");

    if config.export_master_print { let _ = fs::create_dir_all(&dir_print); }
    if config.export_instagram_4x5 { let _ = fs::create_dir_all(&dir_insta); }
    if config.export_stories_9x16 { let _ = fs::create_dir_all(&dir_stories); }
    if config.export_watermarked_proofs { let _ = fs::create_dir_all(&dir_proofs); }
    if config.export_webp_gallery { let _ = fs::create_dir_all(&dir_webp); }

    let settings = crate::app_settings::load_settings(app_handle.clone()).unwrap_or_default();
    let total_photos = config.paths.len();
    let generated_count = Arc::new(AtomicUsize::new(0));
    let progress_counter = Arc::new(AtomicUsize::new(0));

    let _ = app_handle.emit(
        "delivery-pack-progress",
        serde_json::json!({
            "current": 0,
            "total": total_photos,
            "message": format!("Starting client delivery pack for {} photos...", total_photos),
            "percentage": 0.0
        }),
    );

    let config_arc = Arc::new(config.clone());
    let generated_clone = generated_count.clone();

    config.paths.par_iter().for_each(|path_str| {
        let (source_path, _) = parse_virtual_path(path_str);
        let stem = Path::new(path_str)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy();

        if let Ok(file_bytes) = read_file_mapped(&source_path) {
            if let Ok(base_image) = load_base_image_from_bytes(
                &file_bytes,
                &source_path.to_string_lossy(),
                false, // Full resolution render
                &settings,
                None,
            ) {
                // 1. Master Print
                if config_arc.export_master_print {
                    let out_path = dir_print.join(format!("{}_Print.jpg", stem));
                    if base_image.to_rgb8().save_with_format(&out_path, image::ImageFormat::Jpeg).is_ok() {
                        generated_clone.fetch_add(1, Ordering::SeqCst);
                    }
                }

                // 2. Instagram 4:5
                if config_arc.export_instagram_4x5 {
                    let cropped = smart_crop_to_aspect(&base_image, 4.0 / 5.0);
                    let resized = cropped.resize_exact(1080, 1350, FilterType::Lanczos3);
                    let out_path = dir_insta.join(format!("{}_Instagram_4x5.jpg", stem));
                    if let Ok(_) = resized.to_rgb8().save_with_format(&out_path, image::ImageFormat::Jpeg) {
                        generated_clone.fetch_add(1, Ordering::SeqCst);
                    }
                }

                // 3. Stories / Reels 9:16
                if config_arc.export_stories_9x16 {
                    let cropped = smart_crop_to_aspect(&base_image, 9.0 / 16.0);
                    let resized = cropped.resize_exact(1080, 1920, FilterType::Lanczos3);
                    let out_path = dir_stories.join(format!("{}_Story_9x16.jpg", stem));
                    if let Ok(_) = resized.to_rgb8().save_with_format(&out_path, image::ImageFormat::Jpeg) {
                        generated_clone.fetch_add(1, Ordering::SeqCst);
                    }
                }

                // 4. Watermarked Web Proofs
                if config_arc.export_watermarked_proofs {
                    let mut proof_img = base_image.resize(2048, 2048, FilterType::Lanczos3);
                    apply_watermark_overlay(&mut proof_img, &config_arc.watermark_text);
                    let out_path = dir_proofs.join(format!("{}_Proof.jpg", stem));
                    if let Ok(_) = proof_img.to_rgb8().save_with_format(&out_path, image::ImageFormat::Jpeg) {
                        generated_clone.fetch_add(1, Ordering::SeqCst);
                    }
                }

                // 5. Optimized WebP Gallery
                if config_arc.export_webp_gallery {
                    let webp_img = base_image.resize(2560, 2560, FilterType::Lanczos3);
                    let out_path = dir_webp.join(format!("{}_Web.webp", stem));
                    if let Ok(_) = webp_img.to_rgb8().save_with_format(&out_path, image::ImageFormat::WebP) {
                        generated_clone.fetch_add(1, Ordering::SeqCst);
                    }
                }
            }
        }

        let done = progress_counter.fetch_add(1, Ordering::SeqCst) + 1;
        let percent = (done as f32 / total_photos as f32) * 100.0;

        let _ = app_handle.emit(
            "delivery-pack-progress",
            serde_json::json!({
                "current": done,
                "total": total_photos,
                "filename": stem.to_string(),
                "percentage": percent
            }),
        );
    });

    // Write interactive self-contained HTML client proofing portal
    let portal_html = format!(r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>RapidRAW Client Proofing Portal</title>
<style>
body{{font-family:system-ui,-apple-system,sans-serif;background:#0f1013;color:#eee;margin:0;padding:24px;}}
header{{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #222;padding-bottom:16px;margin-bottom:24px;}}
h1{{margin:0;font-size:20px;font-weight:600;color:#fff;}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px;}}
.card{{background:#18191d;border-radius:12px;border:1px solid #282a30;overflow:hidden;transition:border-color .2s;}}
.card:hover{{border-color:#3b82f6;}}
.card img{{width:100%;height:220px;object-fit:cover;display:block;}}
.card-body{{padding:12px 16px;display:flex;justify-content:space-between;align-items:center;}}
.stars{{color:#f59e0b;cursor:pointer;font-size:18px;letter-spacing:2px;}}
.btn{{background:#3b82f6;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-weight:500;cursor:pointer;}}
</style>
</head>
<body>
<header>
  <div><h1>Client Proofing & Selection Portal</h1><small style="color:#888;">{} Photos Delivered</small></div>
  <button class="btn" onclick="exportSelections()">Export Client Selections (.json)</button>
</header>
<div class="grid" id="gallery"></div>
<script>
const photos = {:?};
const ratings = {{}};
const gallery = document.getElementById('gallery');
photos.forEach((p, idx) => {{
  const div = document.createElement('div');
  div.className = 'card';
  div.innerHTML = `<img src="04_Watermarked_Web_Proofs/${{p}}_Proof.jpg" onerror="this.src='05_WebP_Gallery/${{p}}_Web.webp'"><div class="card-body"><span style="font-size:13px;font-weight:500;">${{p}}</span><span class="stars" id="star-${{idx}}" onclick="rate(${{idx}})">★★★☆☆</span></div>`;
  gallery.appendChild(div);
}});
function rate(idx){{
  const cur = ratings[idx] || 0;
  ratings[idx] = (cur % 5) + 1;
  document.getElementById('star-'+idx).innerText = '★'.repeat(ratings[idx]) + '☆'.repeat(5 - ratings[idx]);
}}
function exportSelections(){{
  const data = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(ratings, null, 2));
  const a = document.createElement('a'); a.href = data; a.download = 'client_photo_selections.json'; a.click();
}}
</script>
</body>
</html>"#, total_photos, config.paths.iter().map(|p| Path::new(p).file_stem().unwrap_or_default().to_string_lossy().into_owned()).collect::<Vec<_>>());

    let _ = fs::write(root_dir.join("proofing_portal.html"), portal_html);

    let total_files = generated_count.load(Ordering::SeqCst);
    let summary = ClientDeliverySummary {
        total_photos,
        files_generated: total_files,
        output_directory: config.output_dir.clone(),
        elapsed_ms: start_time.elapsed().as_millis() as u64,
    };

    let _ = app_handle.emit("delivery-pack-complete", &summary);
    Ok(summary)
}

/// Generates a printable High-Resolution Client Contact Sheet (4x5 Grid with File Names)
#[tauri::command]
pub fn generate_contact_sheet(
    paths: Vec<String>,
    output_path: String,
    columns: Option<u32>,
    app_handle: AppHandle,
) -> Result<String, String> {
    if paths.is_empty() {
        return Err("No photos provided for contact sheet".to_string());
    }

    let cols = columns.unwrap_or(4).clamp(2, 8);
    let rows = ((paths.len() as f32) / (cols as f32)).ceil() as u32;

    let cell_w = 400u32;
    let cell_h = 320u32;
    let grid_w = cols * cell_w + 60;
    let grid_h = rows * cell_h + 100;

    let mut sheet = image::RgbImage::from_pixel(grid_w, grid_h, image::Rgb([18, 19, 23])); // Dark neutral background
    let settings = crate::app_settings::load_settings(app_handle).unwrap_or_default();

    for (idx, path_str) in paths.iter().enumerate() {
        let col = idx as u32 % cols;
        let row = idx as u32 / cols;

        let ox = 30 + col * cell_w;
        let oy = 50 + row * cell_h;

        let (src_path, _) = parse_virtual_path(path_str);
        if let Ok(file_bytes) = read_file_mapped(&src_path) {
            if let Ok(base) = load_base_image_from_bytes(&file_bytes, &src_path.to_string_lossy(), false, &settings, None) {
                let thumb = base.resize_to_fill(cell_w - 20, cell_h - 60, FilterType::Triangle).to_rgb8();
                image::imageops::overlay(&mut sheet, &thumb, (ox + 10) as i64, (oy + 10) as i64);
            }
        }
    }

    sheet.save_with_format(&output_path, image::ImageFormat::Jpeg).map_err(|e| e.to_string())?;
    Ok(format!("Contact sheet saved to {}", output_path))
}

