use crate::app_settings::load_settings;
use image::{GenericImageView, GrayImage, imageops};
use image_hasher::{HashAlg, HasherConfig};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::{AppHandle, Emitter};

use crate::image_loader;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CullingSettings {
    pub similarity_threshold: u32,
    pub blur_threshold: f64,
    pub group_similar: bool,
    pub filter_blurry: bool,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImageAnalysisResult {
    pub path: String,
    pub quality_score: f64,
    pub sharpness_metric: f64,
    pub center_focus_metric: f64,
    pub exposure_metric: f64,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CullGroup {
    pub representative: ImageAnalysisResult,
    pub duplicates: Vec<ImageAnalysisResult>,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CullingSuggestions {
    pub similar_groups: Vec<CullGroup>,
    pub blurry_images: Vec<ImageAnalysisResult>,
    pub failed_paths: Vec<String>,
}

#[derive(Serialize, Clone)]
struct CullingProgress {
    current: usize,
    total: usize,
    stage: String,
}

struct ImageAnalysisData {
    hash: image_hasher::ImageHash,
    result: ImageAnalysisResult,
}

const WEIGHT_SHARPNESS: f64 = 0.40;
const WEIGHT_CENTER_FOCUS: f64 = 0.35;
const WEIGHT_EXPOSURE: f64 = 0.25;

fn calculate_laplacian_variance(image: &GrayImage) -> f64 {
    let (width, height) = image.dimensions();
    if width < 3 || height < 3 {
        return 0.0;
    }

    let mut laplacian_values = Vec::with_capacity(((width - 2) * (height - 2)) as usize);
    let mut sum = 0.0;

    for y in 1..height - 1 {
        for x in 1..width - 1 {
            let p_center = image.get_pixel(x, y)[0] as i32;
            let p_north = image.get_pixel(x, y - 1)[0] as i32;
            let p_south = image.get_pixel(x, y + 1)[0] as i32;
            let p_west = image.get_pixel(x - 1, y)[0] as i32;
            let p_east = image.get_pixel(x + 1, y)[0] as i32;
            let conv_val = (p_north + p_south + p_west + p_east - 4 * p_center) as f64;
            laplacian_values.push(conv_val);
            sum += conv_val;
        }
    }

    if laplacian_values.is_empty() {
        return 0.0;
    }
    let mean = sum / laplacian_values.len() as f64;

    laplacian_values
        .iter()
        .map(|v| (v - mean).powi(2))
        .sum::<f64>()
        / laplacian_values.len() as f64
}

fn calculate_exposure_metric(image: &GrayImage) -> f64 {
    let histogram = imageproc::stats::histogram(image);
    let total_pixels = (image.width() * image.height()) as f64;
    if total_pixels == 0.0 {
        return 0.0;
    }

    let clip_threshold_dark = 5;
    let clip_threshold_bright = 250;

    let dark_pixels = histogram.channels[0][0..clip_threshold_dark]
        .iter()
        .sum::<u32>() as f64;
    let bright_pixels = histogram.channels[0][clip_threshold_bright..256]
        .iter()
        .sum::<u32>() as f64;

    let dark_clip_ratio = dark_pixels / total_pixels;
    let bright_clip_ratio = bright_pixels / total_pixels;

    let penalty = (dark_clip_ratio * 5.0) + (bright_clip_ratio * 5.0);

    (1.0f64 - penalty).max(0.0)
}

fn analyze_image(
    path: &str,
    hasher: &image_hasher::Hasher,
    settings: &crate::app_settings::AppSettings,
) -> Result<ImageAnalysisData, String> {
    const ANALYSIS_DIM: u32 = 720; // FIXME: How should we calculate good focus if it's downscaled?!?

    if crate::file_management::is_cloud_placeholder(Path::new(path)) {
        return Err(format!("'{}' is stored in iCloud and not downloaded", path));
    }

    let file_bytes = std::fs::read(path).map_err(|e| e.to_string())?;

    let img = image_loader::load_base_image_from_bytes(&file_bytes, path, true, settings, None)
        .map_err(|e| e.to_string())?;

    let (width, height) = img.dimensions();
    let thumbnail = img.thumbnail(ANALYSIS_DIM, ANALYSIS_DIM);
    let gray_thumbnail = thumbnail.to_luma8();

    let sharpness_metric = calculate_laplacian_variance(&gray_thumbnail);
    let exposure_metric = calculate_exposure_metric(&gray_thumbnail);

    let (thumb_w, thumb_h) = gray_thumbnail.dimensions();
    let center_crop = imageops::crop_imm(
        &gray_thumbnail,
        thumb_w / 4,
        thumb_h / 4,
        thumb_w / 2,
        thumb_h / 2,
    )
    .to_image();
    let center_focus_metric = calculate_laplacian_variance(&center_crop);

    let normalized_sharpness = ((sharpness_metric + 1.0).log10() / 3.5).min(1.0);
    let normalized_center_focus = ((center_focus_metric + 1.0).log10() / 3.5).min(1.0);

    let quality_score = (normalized_sharpness * WEIGHT_SHARPNESS)
        + (normalized_center_focus * WEIGHT_CENTER_FOCUS)
        + (exposure_metric * WEIGHT_EXPOSURE);

    let hash = hasher.hash_image(&thumbnail);

    Ok(ImageAnalysisData {
        hash,
        result: ImageAnalysisResult {
            path: path.to_string(),
            quality_score,
            sharpness_metric,
            center_focus_metric,
            exposure_metric,
            width,
            height,
        },
    })
}

#[tauri::command]
pub async fn cull_images(
    paths: Vec<String>,
    settings: CullingSettings,
    app_handle: AppHandle,
) -> Result<CullingSuggestions, String> {
    if paths.is_empty() {
        return Ok(CullingSuggestions::default());
    }

    let app_settings = load_settings(app_handle.clone()).unwrap_or_default();

    let total_count = paths.len();
    let completed_count = Arc::new(AtomicUsize::new(0));
    let _ = app_handle.emit("culling-start", total_count);

    let hasher = HasherConfig::new()
        .hash_alg(HashAlg::DoubleGradient)
        .hash_size(16, 16)
        .to_hasher();

    let analysis_results: Vec<Result<ImageAnalysisData, (String, String)>> = paths
        .par_iter()
        .map(|path| {
            let completed = completed_count.fetch_add(1, Ordering::Relaxed) + 1;
            let _ = app_handle.emit(
                "culling-progress",
                CullingProgress {
                    current: completed,
                    total: total_count,
                    stage: "Analyzing images...".to_string(),
                },
            );

            analyze_image(path, &hasher, &app_settings).map_err(|e| (path.to_string(), e))
        })
        .collect();

    let mut successful_analyses = Vec::new();
    let mut failed_paths = Vec::new();
    for res in analysis_results {
        match res {
            Ok(data) => successful_analyses.push(data),
            Err((path, error)) => {
                eprintln!("Failed to analyze image {}: {}", path, error);
                failed_paths.push(path);
            }
        }
    }

    let _ = app_handle.emit(
        "culling-progress",
        CullingProgress {
            current: total_count,
            total: total_count,
            stage: "Grouping similar images...".to_string(),
        },
    );

    let mut suggestions = CullingSuggestions {
        failed_paths,
        ..Default::default()
    };
    let mut processed_indices = vec![false; successful_analyses.len()];

    if settings.group_similar {
        for i in 0..successful_analyses.len() {
            if processed_indices[i] {
                continue;
            }

            let mut current_group_indices = vec![];
            let mut queue = VecDeque::new();

            processed_indices[i] = true;
            current_group_indices.push(i);
            queue.push_back(i);

            while let Some(current_idx) = queue.pop_front() {
                for j in (current_idx + 1)..successful_analyses.len() {
                    if processed_indices[j] {
                        continue;
                    }

                    let dist = successful_analyses[current_idx]
                        .hash
                        .dist(&successful_analyses[j].hash);
                    if dist <= settings.similarity_threshold {
                        processed_indices[j] = true;
                        current_group_indices.push(j);
                        queue.push_back(j);
                    }
                }
            }

            if current_group_indices.len() > 1 {
                current_group_indices.sort_by(|&a, &b| {
                    successful_analyses[b]
                        .result
                        .quality_score
                        .partial_cmp(&successful_analyses[a].result.quality_score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });

                let representative_idx = current_group_indices[0];
                let duplicate_indices = &current_group_indices[1..];

                suggestions.similar_groups.push(CullGroup {
                    representative: successful_analyses[representative_idx].result.clone(),
                    duplicates: duplicate_indices
                        .iter()
                        .map(|&idx| successful_analyses[idx].result.clone())
                        .collect(),
                });
            }
        }
    }

    if settings.filter_blurry {
        for i in 0..successful_analyses.len() {
            if !processed_indices[i] {
                let item = &successful_analyses[i];
                if item.result.sharpness_metric < settings.blur_threshold {
                    suggestions.blurry_images.push(item.result.clone());
                }
            }
        }
        suggestions.blurry_images.sort_by(|a, b| {
            a.sharpness_metric
                .partial_cmp(&b.sharpness_metric)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }

    let _ = app_handle.emit("culling-complete", &suggestions);
    Ok(suggestions)
}

#[tauri::command]
pub fn generate_stock_report(
    suggestions: CullingSuggestions,
    output_directory: String,
) -> Result<String, String> {
    let report_path = Path::new(&output_directory).join("stock_culling_report.html");
    
    let total_similar_groups = suggestions.similar_groups.len();
    let total_duplicate_images: usize = suggestions.similar_groups.iter().map(|g| g.duplicates.len()).sum();
    let total_blurry = suggestions.blurry_images.len();

    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();

    let mut html = format!(r#"<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>RapidRAW Pro - Stock Photo QC & Culling Report</title>
    <style>
        :root {{
            --bg: #121316;
            --surface: #1c1d22;
            --surface-hover: #26272e;
            --accent: #3b82f6;
            --text: #f3f4f6;
            --text-secondary: #9ca3af;
            --border: #2d2f36;
            --success: #10b981;
            --warning: #f59e0b;
            --danger: #ef4444;
        }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background-color: var(--bg);
            color: var(--text);
            margin: 0;
            padding: 32px;
            line-height: 1.5;
        }}
        .container {{
            max-width: 1100px;
            margin: 0 auto;
        }}
        .header {{
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid var(--border);
            padding-bottom: 24px;
            margin-bottom: 32px;
        }}
        h1 {{
            font-size: 24px;
            font-weight: 700;
            margin: 0 0 8px 0;
            color: #ffffff;
        }}
        .meta {{
            color: var(--text-secondary);
            font-size: 14px;
        }}
        .stats-grid {{
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
            margin-bottom: 36px;
        }}
        .stat-card {{
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 20px;
        }}
        .stat-value {{
            font-size: 28px;
            font-weight: 700;
            margin-top: 4px;
        }}
        .stat-label {{
            color: var(--text-secondary);
            font-size: 13px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }}
        .section-title {{
            font-size: 18px;
            font-weight: 600;
            margin: 32px 0 16px 0;
            color: #ffffff;
            display: flex;
            align-items: center;
            gap: 8px;
        }}
        table {{
            width: 100%;
            border-collapse: collapse;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 8px;
            overflow: hidden;
            margin-bottom: 32px;
            font-size: 14px;
        }}
        th, td {{
            padding: 12px 16px;
            text-align: left;
            border-bottom: 1px solid var(--border);
        }}
        th {{
            background: rgba(255, 255, 255, 0.03);
            color: var(--text-secondary);
            font-weight: 600;
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }}
        tr:last-child td {{
            border-bottom: none;
        }}
        tr:hover td {{
            background: var(--surface-hover);
        }}
        .badge {{
            display: inline-block;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 600;
        }}
        .badge-success {{ background: rgba(16, 185, 129, 0.15); color: var(--success); }}
        .badge-warning {{ background: rgba(245, 158, 11, 0.15); color: var(--warning); }}
        .badge-danger {{ background: rgba(239, 68, 68, 0.15); color: var(--danger); }}
        .file-path {{
            font-family: monospace;
            word-break: break-all;
            color: #e5e7eb;
        }}
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>RapidRAW Pro: Stock QC & Culling Report</h1>
                <div class="meta">Generated on {} &bull; Output Directory: {}</div>
            </div>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-label">Similar Burst Groups</div>
                <div class="stat-value" style="color: var(--accent);">{}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Redundant Duplicates</div>
                <div class="stat-value" style="color: var(--warning);">{}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Blurry / Soft Rejects</div>
                <div class="stat-value" style="color: var(--danger);">{}</div>
            </div>
        </div>
"#, now, output_directory, total_similar_groups, total_duplicate_images, total_blurry);

    if !suggestions.similar_groups.is_empty() {
        html.push_str(r#"
        <div class="section-title">Similar Burst Sequences & Duplicate Analysis</div>
        <table>
            <thead>
                <tr>
                    <th>Role</th>
                    <th>File Name</th>
                    <th>Resolution</th>
                    <th>Quality Score</th>
                    <th>Sharpness</th>
                    <th>Center Focus</th>
                    <th>Exposure</th>
                </tr>
            </thead>
            <tbody>
"#);
        for (grp_idx, grp) in suggestions.similar_groups.iter().enumerate() {
            let rep_name = Path::new(&grp.representative.path).file_name().unwrap_or_default().to_string_lossy();
            html.push_str(&format!(
                r#"<tr style="background: rgba(59, 130, 246, 0.05);">
                    <td><span class="badge badge-success">Top Pick (Grp {})</span></td>
                    <td class="file-path">{}</td>
                    <td>{}x{}</td>
                    <td><b>{:.1}</b></td>
                    <td>{:.1}</td>
                    <td>{:.1}</td>
                    <td>{:.1}</td>
                </tr>"#,
                grp_idx + 1,
                rep_name,
                grp.representative.width,
                grp.representative.height,
                grp.representative.quality_score,
                grp.representative.sharpness_metric,
                grp.representative.center_focus_metric,
                grp.representative.exposure_metric
            ));
            for dup in &grp.duplicates {
                let dup_name = Path::new(&dup.path).file_name().unwrap_or_default().to_string_lossy();
                html.push_str(&format!(
                    r#"<tr>
                        <td><span class="badge badge-warning">Duplicate</span></td>
                        <td class="file-path">{}</td>
                        <td>{}x{}</td>
                        <td>{:.1}</td>
                        <td>{:.1}</td>
                        <td>{:.1}</td>
                        <td>{:.1}</td>
                    </tr>"#,
                    dup_name,
                    dup.width,
                    dup.height,
                    dup.quality_score,
                    dup.sharpness_metric,
                    dup.center_focus_metric,
                    dup.exposure_metric
                ));
            }
        }
        html.push_str("</tbody></table>");
    }

    if !suggestions.blurry_images.is_empty() {
        html.push_str(r#"
        <div class="section-title">Blurry / Soft Focus Images (Below Quality Threshold)</div>
        <table>
            <thead>
                <tr>
                    <th>Status</th>
                    <th>File Name</th>
                    <th>Resolution</th>
                    <th>Quality Score</th>
                    <th>Sharpness Metric</th>
                    <th>Center Focus</th>
                </tr>
            </thead>
            <tbody>
"#);
        for img in &suggestions.blurry_images {
            let name = Path::new(&img.path).file_name().unwrap_or_default().to_string_lossy();
            html.push_str(&format!(
                r#"<tr>
                    <td><span class="badge badge-danger">Blurry / Soft</span></td>
                    <td class="file-path">{}</td>
                    <td>{}x{}</td>
                    <td>{:.1}</td>
                    <td>{:.1}</td>
                    <td>{:.1}</td>
                </tr>"#,
                name,
                img.width,
                img.height,
                img.quality_score,
                img.sharpness_metric,
                img.center_focus_metric
            ));
        }
        html.push_str("</tbody></table>");
    }

    html.push_str(r#"
    </div>
</body>
</html>
"#);

    std::fs::write(&report_path, html).map_err(|e| format!("Failed to write HTML report to {:?}: {}", report_path, e))?;
    Ok(report_path.to_string_lossy().to_string())
}
