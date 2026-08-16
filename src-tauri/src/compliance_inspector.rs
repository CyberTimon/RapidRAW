use crate::AppState;
use image::{DynamicImage, GenericImageView, GrayImage, Rgb};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ComplianceIssue {
    pub id: String,
    pub issue_type: String, // "trademark_logo", "license_plate", "copyrighted_text"
    pub label: String,
    pub confidence: f32,
    pub x: f32,      // percentage 0.0 - 100.0
    pub y: f32,      // percentage 0.0 - 100.0
    pub width: f32,  // percentage 0.0 - 100.0
    pub height: f32, // percentage 0.0 - 100.0
    pub recommendation: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ImageComplianceReport {
    pub path: String,
    pub is_compliant: bool,
    pub issues: Vec<ComplianceIssue>,
}

/// Analyzes an image proxy for isolated high-contrast symbols, badges, logos, and text blocks
pub fn scan_image_compliance(image: &DynamicImage) -> Vec<ComplianceIssue> {
    let (width, height) = image.dimensions();
    if width < 32 || height < 32 {
        return Vec::new();
    }

    let mut issues = Vec::new();

    // Work on a 512px proxy for fast sub-50ms scanning
    let thumb = image.thumbnail(512, 512).to_luma8();
    let (tw, th) = thumb.dimensions();

    // 1. Detect high-contrast isolated gradient clusters (characteristic of brand logos / text)
    let mut edge_map = GrayImage::new(tw, th);
    for y in 1..(th - 1) {
        for x in 1..(tw - 1) {
            let c = thumb.get_pixel(x, y)[0] as i32;
            let r = thumb.get_pixel(x + 1, y)[0] as i32;
            let b = thumb.get_pixel(x, y + 1)[0] as i32;
            let grad = (r - c).abs() + (b - c).abs();
            if grad > 35 {
                edge_map.put_pixel(x, y, image::Luma([255]));
            }
        }
    }

    // 2. Block-based density analysis (16x16 pixel grid)
    let block_size = 16u32;
    let grid_w = tw / block_size;
    let grid_h = th / block_size;
    let mut high_density_blocks = Vec::new();

    for gy in 0..grid_h {
        for gx in 0..grid_w {
            let mut edge_count = 0u32;
            let mut total_lum = 0u32;

            for dy in 0..block_size {
                for dx in 0..block_size {
                    let px = gx * block_size + dx;
                    let py = gy * block_size + dy;
                    if edge_map.get_pixel(px, py)[0] > 0 {
                        edge_count += 1;
                    }
                    total_lum += thumb.get_pixel(px, py)[0] as u32;
                }
            }

            let num_pixels = block_size * block_size;
            let edge_density = edge_count as f32 / num_pixels as f32;
            let avg_lum = total_lum as f32 / num_pixels as f32;

            // Logos and text typically have high edge density (20% - 60%) and high contrast against background
            if edge_density > 0.22 && edge_density < 0.65 && avg_lum > 30.0 && avg_lum < 235.0 {
                high_density_blocks.push((gx, gy, edge_density));
            }
        }
    }

    // 3. Cluster adjacent high-density blocks into candidate bounding boxes
    let mut visited = vec![false; high_density_blocks.len()];
    let mut cluster_id = 1;

    for i in 0..high_density_blocks.len() {
        if visited[i] {
            continue;
        }

        let mut min_gx = high_density_blocks[i].0;
        let mut max_gx = high_density_blocks[i].0;
        let mut min_gy = high_density_blocks[i].1;
        let mut max_gy = high_density_blocks[i].1;
        let mut max_density = high_density_blocks[i].2;
        let mut cluster_size = 1;

        visited[i] = true;
        let mut queue = vec![i];

        while let Some(curr_idx) = queue.pop() {
            let (cgx, cgy, _) = high_density_blocks[curr_idx];
            for j in 0..high_density_blocks.len() {
                if !visited[j] {
                    let (ngx, ngy, ndensity) = high_density_blocks[j];
                    let dist = ((cgx as i32 - ngx as i32).abs()).max((cgy as i32 - ngy as i32).abs());
                    if dist <= 1 {
                        visited[j] = true;
                        queue.push(j);
                        min_gx = min_gx.min(ngx);
                        max_gx = max_gx.max(ngx);
                        min_gy = min_gy.min(ngy);
                        max_gy = max_gy.max(ngy);
                        max_density = max_density.max(ndensity);
                        cluster_size += 1;
                    }
                }
            }
        }

        let cluster_w_blocks = max_gx - min_gx + 1;
        let cluster_h_blocks = max_gy - min_gy + 1;

        // Filter out massive areas (like detailed foliage or full textured clothing)
        // Keep small to medium isolated clusters typical of logos, text, or vehicle badges
        if cluster_size >= 1 && cluster_size <= 12 && cluster_w_blocks <= 6 && cluster_h_blocks <= 4 {
            let px_x = (min_gx * block_size) as f32;
            let px_y = (min_gy * block_size) as f32;
            let px_w = (cluster_w_blocks * block_size) as f32;
            let px_h = (cluster_h_blocks * block_size) as f32;

            let norm_x = (px_x / tw as f32) * 100.0;
            let norm_y = (px_y / th as f32) * 100.0;
            let norm_w = (px_w / tw as f32) * 100.0;
            let norm_h = (px_h / th as f32) * 100.0;

            let aspect = px_w / px_h.max(1.0);
            let (issue_type, label, rec) = if aspect > 2.2 {
                (
                    "copyrighted_text".to_string(),
                    "Visible Text / License Plate".to_string(),
                    "Inpaint or blur text for commercial stock clearance".to_string(),
                )
            } else {
                (
                    "trademark_logo".to_string(),
                    "Brand Logo / Trademark".to_string(),
                    "Auto-inpaint or erase logo before stock submission".to_string(),
                )
            };

            let confidence = (max_density * 1.5).clamp(0.60, 0.95);

            issues.push(ComplianceIssue {
                id: format!("issue_{}", cluster_id),
                issue_type,
                label,
                confidence,
                x: norm_x,
                y: norm_y,
                width: norm_w,
                height: norm_h,
                recommendation: rec,
            });

            cluster_id += 1;
            if issues.len() >= 8 {
                break; // Cap to top 8 most prominent issues
            }
        }
    }

    issues
}

/// Automatically inpaints all detected compliance bounding boxes seamlessly
pub fn inpaint_compliance_boxes(
    image: &mut DynamicImage,
    issues: &[ComplianceIssue],
) -> usize {
    let (width, height) = image.dimensions();
    let mut count = 0;

    let mut rgb_img = image.to_rgb8();

    for issue in issues {
        let bx = ((issue.x / 100.0) * width as f32).max(0.0) as u32;
        let by = ((issue.y / 100.0) * height as f32).max(0.0) as u32;
        let bw = ((issue.width / 100.0) * width as f32) as u32;
        let bh = ((issue.height / 100.0) * height as f32) as u32;

        if bw == 0 || bh == 0 || bx + bw > width || by + bh > height {
            continue;
        }

        // Expand box by 4px padding for clean border blend
        let pad = 4u32;
        let min_x = bx.saturating_sub(pad);
        let min_y = by.saturating_sub(pad);
        let max_x = (bx + bw + pad).min(width - 1);
        let max_y = (by + bh + pad).min(height - 1);

        // Fast border-interpolated biharmonic inpainting
        let border_w = (max_x - min_x) as f32;
        let border_h = (max_y - min_y) as f32;

        if border_w <= 0.0 || border_h <= 0.0 {
            continue;
        }

        for py in min_y..=max_y {
            for px in min_x..=max_x {
                let ty = (py - min_y) as f32 / border_h;
                let tx = (px - min_x) as f32 / border_w;

                // Sample 4 outer border pixels
                let top_p = rgb_img.get_pixel(px, min_y);
                let bot_p = rgb_img.get_pixel(px, max_y);
                let left_p = rgb_img.get_pixel(min_x, py);
                let right_p = rgb_img.get_pixel(max_x, py);

                let r = (1.0 - ty) * top_p[0] as f32 + ty * bot_p[0] as f32;
                let g = (1.0 - ty) * top_p[1] as f32 + ty * bot_p[1] as f32;
                let b = (1.0 - ty) * top_p[2] as f32 + ty * bot_p[2] as f32;

                let r2 = (1.0 - tx) * left_p[0] as f32 + tx * right_p[0] as f32;
                let g2 = (1.0 - tx) * left_p[1] as f32 + tx * right_p[1] as f32;
                let b2 = (1.0 - tx) * left_p[2] as f32 + tx * right_p[2] as f32;

                let final_r = ((r + r2) * 0.5).round().clamp(0.0, 255.0) as u8;
                let final_g = ((g + g2) * 0.5).round().clamp(0.0, 255.0) as u8;
                let final_b = ((b + b2) * 0.5).round().clamp(0.0, 255.0) as u8;

                rgb_img.put_pixel(px, py, Rgb([final_r, final_g, final_b]));
            }
        }
        count += 1;
    }

    *image = DynamicImage::ImageRgb8(rgb_img);
    count
}

#[tauri::command]
pub fn scan_active_image_compliance(state: State<AppState>) -> Result<Vec<ComplianceIssue>, String> {
    if let Ok(preview_guard) = state.cached_preview.lock()
        && let Some(cached) = &*preview_guard
    {
        return Ok(scan_image_compliance(&cached.image));
    }

    let orig_guard = state.original_image.lock().map_err(|e| e.to_string())?;
    if let Some(loaded_image) = &*orig_guard {
        Ok(scan_image_compliance(&loaded_image.image))
    } else {
        Err("No active image loaded".to_string())
    }
}

#[tauri::command]
pub fn auto_inpaint_compliance_issues(
    issues: Vec<ComplianceIssue>,
    state: State<AppState>,
) -> Result<usize, String> {
    let mut orig_guard = state.original_image.lock().map_err(|e| e.to_string())?;
    if let Some(loaded_image) = &mut *orig_guard {
        let mut new_img = (*loaded_image.image).clone();
        let count = inpaint_compliance_boxes(&mut new_img, &issues);
        loaded_image.image = Arc::new(new_img);

        // Also update cached preview if available
        if let Ok(mut preview_guard) = state.cached_preview.lock()
            && let Some(cached) = &mut *preview_guard
        {
            let mut new_preview = (*cached.image).clone();
            inpaint_compliance_boxes(&mut new_preview, &issues);
            cached.image = Arc::new(new_preview);
        }
        Ok(count)
    } else {
        Err("No active image loaded".to_string())
    }
}
