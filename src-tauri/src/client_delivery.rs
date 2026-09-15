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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContactSheetConfig {
    pub paths: Vec<String>,
    pub output_path: String,
    pub columns: Option<u32>,
    pub cell_width: Option<u32>,
    pub include_exif: Option<bool>,
    pub include_checkboxes: Option<bool>,
    pub custom_title: Option<String>,
    pub dark_theme: Option<bool>,
    pub picked_paths: Option<Vec<String>>,
}

/// 5x7 ASCII bitmap font lookup table for crisp, deterministic antialiased sheet typography
pub fn get_5x7_glyph(ch: char) -> [u8; 7] {
    match ch.to_ascii_uppercase() {
        '0' => [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
        '1' => [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
        '2' => [0x0E, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1F],
        '3' => [0x1E, 0x01, 0x01, 0x0E, 0x01, 0x01, 0x1E],
        '4' => [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
        '5' => [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
        '6' => [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
        '7' => [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
        '8' => [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
        '9' => [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
        'A' => [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
        'B' => [0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E],
        'C' => [0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E],
        'D' => [0x1C, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1C],
        'E' => [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F],
        'F' => [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10],
        'G' => [0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F],
        'H' => [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
        'I' => [0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E],
        'J' => [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C],
        'K' => [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
        'L' => [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F],
        'M' => [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11],
        'N' => [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
        'O' => [0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
        'P' => [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10],
        'Q' => [0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D],
        'R' => [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11],
        'S' => [0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E],
        'T' => [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
        'U' => [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
        'V' => [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04],
        'W' => [0x11, 0x11, 0x11, 0x15, 0x15, 0x1B, 0x11],
        'X' => [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11],
        'Y' => [0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04],
        'Z' => [0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F],
        '.' => [0x00, 0x00, 0x00, 0x00, 0x00, 0x06, 0x06],
        ',' => [0x00, 0x00, 0x00, 0x00, 0x04, 0x04, 0x08],
        ':' => [0x00, 0x0C, 0x0C, 0x00, 0x0C, 0x0C, 0x00],
        '/' => [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
        '-' => [0x00, 0x00, 0x00, 0x1F, 0x00, 0x00, 0x00],
        '_' => [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1F],
        '|' => [0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
        '(' => [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
        ')' => [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
        '%' => [0x19, 0x1A, 0x04, 0x08, 0x10, 0x0B, 0x13],
        '©' => [0x0E, 0x1B, 0x15, 0x11, 0x15, 0x1B, 0x0E],
        '★' | '*' => [0x04, 0x15, 0x0E, 0x1F, 0x0E, 0x15, 0x04],
        _ => [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    }
}

pub fn draw_text_bitmap(
    img: &mut image::RgbImage,
    start_x: i32,
    start_y: i32,
    text: &str,
    color: image::Rgb<u8>,
    scale: u32,
) {
    let scale = scale.max(1);
    let mut cur_x = start_x;
    let (w, h) = img.dimensions();

    for ch in text.chars() {
        if ch == '\n' {
            continue;
        }
        let glyph = get_5x7_glyph(ch);
        for row in 0..7 {
            let row_bits = glyph[row];
            for col in 0..5 {
                if (row_bits & (0x10 >> col)) != 0 {
                    for dy in 0..scale {
                        for dx in 0..scale {
                            let px = cur_x + (col as i32) * (scale as i32) + (dx as i32);
                            let py = start_y + (row as i32) * (scale as i32) + (dy as i32);
                            if px >= 0 && px < w as i32 && py >= 0 && py < h as i32 {
                                img.put_pixel(px as u32, py as u32, color);
                            }
                        }
                    }
                }
            }
        }
        cur_x += (6 * scale) as i32;
    }
}

pub fn draw_rect_outline(
    img: &mut image::RgbImage,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    color: image::Rgb<u8>,
) {
    let (w, h) = img.dimensions();
    for cur_x in x..(x + width) {
        if cur_x >= 0 && cur_x < w as i32 {
            if y >= 0 && y < h as i32 {
                img.put_pixel(cur_x as u32, y as u32, color);
            }
            let bottom = y + height - 1;
            if bottom >= 0 && bottom < h as i32 {
                img.put_pixel(cur_x as u32, bottom as u32, color);
            }
        }
    }
    for cur_y in y..(y + height) {
        if cur_y >= 0 && cur_y < h as i32 {
            if x >= 0 && x < w as i32 {
                img.put_pixel(x as u32, cur_y as u32, color);
            }
            let right = x + width - 1;
            if right >= 0 && right < w as i32 {
                img.put_pixel(right as u32, cur_y as u32, color);
            }
        }
    }
}

pub fn draw_selection_checkbox(
    img: &mut image::RgbImage,
    center_x: i32,
    center_y: i32,
    radius: i32,
    is_picked: bool,
    border_color: image::Rgb<u8>,
    fill_color: image::Rgb<u8>,
    check_color: image::Rgb<u8>,
) {
    let (w, h) = img.dimensions();
    let r_sq = radius * radius;
    let inner_r_sq = (radius - 2) * (radius - 2);

    for dy in -radius..=radius {
        for dx in -radius..=radius {
            let dist_sq = dx * dx + dy * dy;
            let px = center_x + dx;
            let py = center_y + dy;
            if px >= 0 && px < w as i32 && py >= 0 && py < h as i32 {
                if dist_sq <= r_sq {
                    if is_picked {
                        img.put_pixel(px as u32, py as u32, fill_color);
                    } else if dist_sq >= inner_r_sq {
                        img.put_pixel(px as u32, py as u32, border_color);
                    }
                }
            }
        }
    }

    if is_picked {
        let check_coords = [
            (-4, 0), (-3, 1), (-2, 2), (-1, 1), (0, 0), (1, -1), (2, -2), (3, -3), (4, -4),
            (-4, 1), (-3, 2), (-2, 3), (-1, 2), (0, 1), (1, 0), (2, -1), (3, -2), (4, -3),
        ];
        for (dx, dy) in check_coords {
            let px = center_x + dx;
            let py = center_y + dy;
            if px >= 0 && px < w as i32 && py >= 0 && py < h as i32 {
                img.put_pixel(px as u32, py as u32, check_color);
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct ContactSheetCell {
    pub image: Option<image::RgbImage>,
    pub filename: String,
    pub exif_badge: String,
    pub is_picked: bool,
}

pub fn render_contact_sheet_canvas(
    cells: &[ContactSheetCell],
    columns: u32,
    cell_width: u32,
    include_exif: bool,
    include_checkboxes: bool,
    custom_title: &str,
    dark_theme: bool,
) -> image::RgbImage {
    let cols = columns.clamp(2, 8);
    let rows = ((cells.len() as f32) / (cols as f32)).ceil().max(1.0) as u32;

    let cell_w = cell_width.clamp(280, 1000);
    let box_w = cell_w.saturating_sub(32);
    let box_h = ((box_w as f32) * 0.68) as u32;
    let cell_h = box_h + 74;

    let header_h = 96u32;
    let footer_h = 50u32;
    let margin_x = 36u32;
    let grid_w = margin_x * 2 + cols * cell_w;
    let grid_h = header_h + rows * cell_h + footer_h;

    let bg_color = if dark_theme { image::Rgb([20, 22, 26]) } else { image::Rgb([250, 250, 252]) };
    let border_color = if dark_theme { image::Rgb([40, 44, 52]) } else { image::Rgb([225, 228, 234]) };
    let photo_box_bg = if dark_theme { image::Rgb([14, 15, 18]) } else { image::Rgb([240, 242, 246]) };
    let title_color = if dark_theme { image::Rgb([245, 247, 250]) } else { image::Rgb([20, 24, 32]) };
    let text_color = if dark_theme { image::Rgb([220, 225, 235]) } else { image::Rgb([35, 40, 50]) };
    let subtext_color = if dark_theme { image::Rgb([135, 142, 155]) } else { image::Rgb([110, 120, 135]) };
    let check_border = if dark_theme { image::Rgb([160, 168, 180]) } else { image::Rgb([140, 150, 165]) };
    let check_fill = image::Rgb([16, 185, 129]); // Emerald 500
    let check_mark = image::Rgb([255, 255, 255]);

    let mut sheet = image::RgbImage::from_pixel(grid_w, grid_h, bg_color);

    // Render Title Header
    let title = if custom_title.trim().is_empty() { "RAPIDRAW CLIENT PROOF SHEET" } else { custom_title.trim() };
    draw_text_bitmap(&mut sheet, (margin_x + 8) as i32, 24, title, title_color, 2);

    let subtitle = format!("TOTAL: {} PHOTOS  |  COLUMNS: {}  |  RATIO: PRESERVED", cells.len(), cols);
    draw_text_bitmap(&mut sheet, (margin_x + 8) as i32, 58, &subtitle, subtext_color, 1);

    // Top rule divider
    let divider_y = 82i32;
    for x in (margin_x as i32)..((grid_w - margin_x) as i32) {
        if x >= 0 && (x as u32) < grid_w {
            sheet.put_pixel(x as u32, divider_y as u32, border_color);
        }
    }

    // Render Grid Cells
    for (idx, cell) in cells.iter().enumerate() {
        let col = (idx as u32) % cols;
        let row = (idx as u32) / cols;

        let ox = margin_x + col * cell_w;
        let oy = header_h + row * cell_h;

        // Cell card border
        draw_rect_outline(
            &mut sheet,
            (ox + 4) as i32,
            (oy + 4) as i32,
            (cell_w - 8) as i32,
            (cell_h - 8) as i32,
            border_color,
        );

        // Photo container box background
        for py in (oy + 16)..(oy + 16 + box_h) {
            for px in (ox + 16)..(ox + 16 + box_w) {
                if px < grid_w && py < grid_h {
                    sheet.put_pixel(px, py, photo_box_bg);
                }
            }
        }

        // Overlay thumbnail with aspect ratio preservation (centered inside box)
        if let Some(ref thumb) = cell.image {
            let resized = image::DynamicImage::ImageRgb8(thumb.clone())
                .resize(box_w, box_h, FilterType::Triangle)
                .to_rgb8();
            let rw = resized.width();
            let rh = resized.height();
            let off_x = ox + 16 + (box_w.saturating_sub(rw)) / 2;
            let off_y = oy + 16 + (box_h.saturating_sub(rh)) / 2;
            image::imageops::overlay(&mut sheet, &resized, off_x as i64, off_y as i64);
        }

        // Draw Selection / Review Checkbox
        if include_checkboxes {
            let cx = (ox + 16 + box_w - 16) as i32;
            let cy = (oy + 16 + 16) as i32;
            draw_selection_checkbox(
                &mut sheet,
                cx,
                cy,
                10,
                cell.is_picked,
                check_border,
                check_fill,
                check_mark,
            );
        }

        // Filename
        let meta_top = oy + 16 + box_h + 8;
        let max_fn_chars = ((cell_w - 32) / 12) as usize;
        let display_name: String = if cell.filename.len() > max_fn_chars && max_fn_chars > 3 {
            format!("{}...", &cell.filename[..max_fn_chars - 3])
        } else {
            cell.filename.clone()
        };
        draw_text_bitmap(&mut sheet, (ox + 16) as i32, meta_top as i32, &display_name, text_color, 1);

        // EXIF Metadata Badge
        if include_exif && !cell.exif_badge.is_empty() {
            let max_exif_chars = ((cell_w - 32) / 6) as usize;
            let display_exif: String = if cell.exif_badge.len() > max_exif_chars && max_exif_chars > 3 {
                format!("{}...", &cell.exif_badge[..max_exif_chars - 3])
            } else {
                cell.exif_badge.clone()
            };
            draw_text_bitmap(&mut sheet, (ox + 16) as i32, (meta_top + 16) as i32, &display_exif, subtext_color, 1);
        }
    }

    // Footer copyright / signature
    let footer_y = grid_h - 32;
    draw_text_bitmap(
        &mut sheet,
        (margin_x + 8) as i32,
        footer_y as i32,
        "PRODUCED WITH RAPIDRAW PRO - PROOF SHEET ENGINE",
        subtext_color,
        1,
    );

    sheet
}

/// Formats EXIF tags into clean string badge: "ISO 400 | f/2.8 | 1/500s | 2026:09:05"
pub fn format_exif_badge_from_map(meta: &std::collections::HashMap<String, String>) -> String {
    let mut parts = Vec::new();
    if let Some(iso) = meta.get("ISO") {
        if !iso.is_empty() {
            parts.push(format!("ISO {}", iso));
        }
    }
    if let Some(f) = meta.get("FNumber") {
        if !f.is_empty() {
            parts.push(format!("f/{}", f));
        }
    }
    if let Some(ss) = meta.get("ExposureTime") {
        if !ss.is_empty() {
            parts.push(ss.clone());
        }
    }
    if let Some(dt) = meta.get("DateTimeOriginal") {
        if !dt.is_empty() {
            let date_only = dt.split_whitespace().next().unwrap_or(dt);
            parts.push(date_only.to_string());
        }
    }
    if parts.is_empty() {
        "ORIGINAL EXIF".to_string()
    } else {
        parts.join(" | ")
    }
}

/// Generates a printable High-Resolution Client Contact Sheet (Vector Grid with File Names, EXIF Badges, and Selection Checkboxes)
#[tauri::command]
pub fn generate_contact_sheet(
    config: ContactSheetConfig,
    app_handle: AppHandle,
) -> Result<String, String> {
    if config.paths.is_empty() {
        return Err("No photos provided for contact sheet".to_string());
    }

    let settings = crate::app_settings::load_settings(app_handle).unwrap_or_default();
    let picked_set: std::collections::HashSet<String> = config
        .picked_paths
        .unwrap_or_default()
        .into_iter()
        .collect();

    let cell_w = config.cell_width.unwrap_or(480).clamp(280, 1000);
    let box_w = cell_w.saturating_sub(32);
    let box_h = ((box_w as f32) * 0.68) as u32;

    let cells: Vec<ContactSheetCell> = config
        .paths
        .par_iter()
        .map(|path_str| {
            let filename = Path::new(path_str)
                .file_name()
                .map(|f| f.to_string_lossy().to_string())
                .unwrap_or_else(|| "image".to_string());
            let (src_path, _) = parse_virtual_path(path_str);
            let is_picked = picked_set.contains(path_str);

            let (thumb, exif_badge) = if let Ok(file_bytes) = read_file_mapped(&src_path) {
                let badge = if config.include_exif.unwrap_or(true) {
                    let exif_map = crate::exif_processing::read_exif_data(&path_str, &file_bytes);
                    format_exif_badge_from_map(&exif_map)
                } else {
                    String::new()
                };

                let img = if let Ok(base) = load_base_image_from_bytes(&file_bytes, &src_path.to_string_lossy(), false, &settings, None) {
                    Some(base.resize(box_w, box_h, FilterType::Triangle).to_rgb8())
                } else {
                    None
                };

                (img, badge)
            } else {
                (None, "FILE READ ERROR".to_string())
            };

            ContactSheetCell {
                image: thumb,
                filename,
                exif_badge,
                is_picked,
            }
        })
        .collect();

    let sheet = render_contact_sheet_canvas(
        &cells,
        config.columns.unwrap_or(4),
        cell_w,
        config.include_exif.unwrap_or(true),
        config.include_checkboxes.unwrap_or(true),
        &config.custom_title.unwrap_or_default(),
        config.dark_theme.unwrap_or(true),
    );

    let format = match Path::new(&config.output_path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("jpg")
        .to_lowercase()
        .as_str()
    {
        "png" => image::ImageFormat::Png,
        "webp" => image::ImageFormat::WebP,
        _ => image::ImageFormat::Jpeg,
    };

    if let Some(parent) = Path::new(&config.output_path).parent() {
        let _ = fs::create_dir_all(parent);
    }

    sheet
        .save_with_format(&config.output_path, format)
        .map_err(|e| format!("Failed to save contact sheet: {}", e))?;

    Ok(format!("Contact sheet saved to {}", config.output_path))
}

#[cfg(test)]
pub mod tests {
    use super::*;

    #[test]
    fn test_draw_text_bitmap_renders_glyph_pixels() {
        let mut img = image::RgbImage::from_pixel(100, 30, image::Rgb([0, 0, 0]));
        draw_text_bitmap(&mut img, 5, 5, "RAPID 123", image::Rgb([255, 255, 255]), 1);

        let white_pixels = img.pixels().filter(|p| p[0] == 255 && p[1] == 255 && p[2] == 255).count();
        assert!(white_pixels > 50, "Expected white pixels rendered for text glyphs, got {}", white_pixels);
    }

    #[test]
    fn test_draw_selection_checkbox_empty_vs_picked() {
        let mut img_empty = image::RgbImage::from_pixel(40, 40, image::Rgb([0, 0, 0]));
        let mut img_picked = image::RgbImage::from_pixel(40, 40, image::Rgb([0, 0, 0]));

        let border = image::Rgb([180, 180, 180]);
        let fill = image::Rgb([16, 185, 129]);
        let check = image::Rgb([255, 255, 255]);

        draw_selection_checkbox(&mut img_empty, 20, 20, 10, false, border, fill, check);
        draw_selection_checkbox(&mut img_picked, 20, 20, 10, true, border, fill, check);

        let empty_center = img_empty.get_pixel(20, 20);
        let picked_center = img_picked.get_pixel(20, 20);

        // In empty checkbox, center is interior background (black)
        assert_eq!(*empty_center, image::Rgb([0, 0, 0]), "Empty checkbox center should be background");
        // In picked checkbox, center is filled or checkmark
        assert!(picked_center[0] > 0 || picked_center[1] > 0, "Picked checkbox center should be filled");
    }

    #[test]
    fn test_render_contact_sheet_canvas_grid_dimensions_and_aspect() {
        // Create 6 synthetic cells with diverse aspect ratios (16:9, 4:5, 1:1)
        let landscape = image::RgbImage::from_pixel(320, 180, image::Rgb([200, 50, 50]));
        let portrait = image::RgbImage::from_pixel(200, 250, image::Rgb([50, 200, 50]));
        let square = image::RgbImage::from_pixel(200, 200, image::Rgb([50, 50, 200]));

        let cells = vec![
            ContactSheetCell {
                image: Some(landscape),
                filename: "LANDSCAPE_16_9.RAW".to_string(),
                exif_badge: "ISO 100 | f/4.0 | 1/250s".to_string(),
                is_picked: true,
            },
            ContactSheetCell {
                image: Some(portrait),
                filename: "PORTRAIT_4_5.RAW".to_string(),
                exif_badge: "ISO 800 | f/1.8 | 1/500s".to_string(),
                is_picked: false,
            },
            ContactSheetCell {
                image: Some(square),
                filename: "SQUARE_1_1.RAW".to_string(),
                exif_badge: "ISO 400 | f/2.8 | 1/125s".to_string(),
                is_picked: true,
            },
        ];

        let cols = 3u32;
        let cell_w = 360u32;
        let sheet = render_contact_sheet_canvas(
            &cells,
            cols,
            cell_w,
            true,
            true,
            "PROOF BENCHMARK",
            true,
        );

        let (w, h) = sheet.dimensions();
        let expected_w = 36 * 2 + cols * cell_w;
        assert_eq!(w, expected_w, "Sheet width should match grid calculations");
        assert!(h > 200, "Sheet height should encompass header, cells, and footer");

        // Verify top-left pixel is dark theme background
        let bg_sample = sheet.get_pixel(0, 0);
        assert_eq!(*bg_sample, image::Rgb([20, 22, 26]));
    }
}


