use super::{advanced, analysis, correction, quality, types::*};
use crate::{
    app_settings::AppSettings,
    image_processing::{GpuContext, ImageMetadata},
};
use anyhow::Result;
use image::DynamicImage;
use serde_json::Value;

pub fn preview(
    app: &tauri::AppHandle,
    path: &str,
    base: &DynamicImage,
    gpu: &GpuContext,
    adjustments: Value,
) -> Result<DynamicImage> {
    crate::file_management::render_auto_preview(
        path,
        Some(gpu),
        Some(base),
        app,
        Some(640),
        Some(ImageMetadata {
            adjustments,
            ..ImageMetadata::default()
        }),
    )
}
pub fn decode(path: &str, settings: &AppSettings) -> Result<DynamicImage> {
    let (source, _) = crate::file_management::parse_virtual_path(path);
    let bytes = std::fs::read(&source)?;
    // Full decode keeps mask coordinates and preprocessing identical to the editor.
    crate::image_loader::load_base_image_from_bytes(
        &bytes,
        &source.to_string_lossy(),
        false,
        settings,
        None,
    )
}
#[allow(clippy::too_many_arguments)]
pub fn refine(
    app: &tauri::AppHandle,
    e: &Entry,
    g: &Group,
    c: &Controls,
    selected: &AdjustmentFamilies,
    white_balance_intent: WhiteBalanceIntent,
    scene: Scene,
    base: &DynamicImage,
    gpu: &GpuContext,
    batch: &str,
) -> Result<Value> {
    let a = &e.analysis;
    let target = correction::target(a, g, c, scene);
    let mut candidate =
        correction::propose_selected(a, g, c, scene, &e.baseline, selected, white_balance_intent);
    let original = preview(
        app,
        &e.path,
        base,
        gpu,
        correction::neutral_selected(&e.baseline, selected),
    )?
    .to_rgb8();
    let mut best_stats = a.clone();
    let mut best = candidate.clone();
    let mut best_score = f64::INFINITY;
    for _ in 0..if selected.tone { 4 } else { 1 } {
        let rendered = preview(app, &e.path, base, gpu, candidate.clone())?;
        let stats = analysis::measure(
            &rendered.to_rgb8(),
            a.faces.clone(),
            a.iso,
            a.captured,
            a.reduced,
        );
        let penalty = quality::clipping_cost(&original, &rendered.to_rgb8(), &a.faces);
        let score = (stats.subject - target).abs() + penalty;
        if score < best_score {
            best_score = score;
            best = candidate.clone();
            best_stats = stats.clone();
        }
        let highlight_growth = (stats.clipped - a.clipped - 0.004).max(0.);
        if (stats.subject - target).abs() < 0.025 && highlight_growth < 0.001 {
            break;
        }
        if !selected.tone {
            break;
        }
        if highlight_growth >= 0.001 {
            let value = candidate["highlights"].as_f64().unwrap_or(0.);
            candidate["highlights"] =
                serde_json::json!((value - (15. + highlight_growth * 700.).min(30.)).max(-100.));
        }
        if !a.faces.is_empty() && !a.reduced && a.subject >= 0.025 {
            let delta = ((target / stats.subject.max(0.025)).log2() * 1.5).clamp(-0.6, 0.6);
            let current = candidate["brightness"].as_f64().unwrap_or(0.);
            candidate["brightness"] = serde_json::json!(
                (current + delta).clamp(0., correction::brightness_limit(a, scene))
            );
            if penalty > 0.04 {
                let ev = candidate["exposure"].as_f64().unwrap_or(0.);
                candidate["exposure"] = serde_json::json!((ev - 0.25).max(-1.5));
            }
            continue;
        }
        let delta = if penalty > 0.04 {
            -0.2
        } else {
            ((target / stats.subject.max(0.03)).log2() * 0.6).clamp(-0.25, 0.25)
        };
        let current = candidate["exposure"].as_f64().unwrap_or(0.);
        let limit = if scene == Scene::Mixed || a.subject < 0.025 || correction::recovery_limited(a)
        {
            0.4
        } else if a.reduced || scene == Scene::Uncertain {
            0.8
        } else if scene == Scene::Night {
            1.0
        } else {
            2.2
        };
        candidate["exposure"] =
            serde_json::json!((current + delta).clamp(-1.5, limit * (1. - 0.5 * a.noise)));
    }
    let optional_families = [
        advanced::Family::Curves,
        advanced::Family::Presence,
        advanced::Family::Color,
        advanced::Family::ColorGrading,
        advanced::Family::ColorMixer,
    ];
    for family in optional_families {
        if !advanced::enabled(family, selected) {
            continue;
        }
        let before = preview(app, &e.path, base, gpu, best.clone())?.to_rgb8();
        let mut trial = best.clone();
        advanced::apply(&mut trial, family, &best_stats, scene);
        let rendered = preview(app, &e.path, base, gpu, trial.clone())?;
        let stats = analysis::measure(
            &rendered.to_rgb8(),
            a.faces.clone(),
            a.iso,
            a.captured,
            a.reduced,
        );
        let clipping = quality::clipping_cost(&before, &rendered.to_rgb8(), &a.faces);
        let color_shift = quality::color_cost(&before, &rendered.to_rgb8(), &a.faces);
        if clipping <= 0.04 && color_shift <= 0.12 && stats.noise <= best_stats.noise + 0.08 {
            best = trial;
            best_stats = stats;
        } else {
            advanced::restore(&mut best, &e.baseline, family);
        }
    }
    {
        let swapped = e.baseline["orientationSteps"].as_u64().unwrap_or(0) % 2 == 1;
        let (w, h) = if swapped {
            (base.height(), base.width())
        } else {
            (base.width(), base.height())
        };
        let crop = &e.baseline["crop"];
        let canvas = (
            crop["width"].as_f64().unwrap_or(w as f64),
            crop["height"].as_f64().unwrap_or(h as f64),
        );
        let offset = (
            crop["x"].as_f64().unwrap_or(0.),
            crop["y"].as_f64().unwrap_or(0.),
        );
        let before = best.clone();
        if selected.tone && scene != Scene::Mixed {
            correction::add_subject_masks(&mut best, &best_stats, target, canvas, offset, batch);
        }
        if best != before {
            let view = preview(app, &e.path, base, gpu, best.clone())?;
            let stats = analysis::measure(
                &view.to_rgb8(),
                a.faces.clone(),
                a.iso,
                a.captured,
                a.reduced,
            );
            let score = (stats.subject - target).abs()
                + quality::clipping_cost(&original, &view.to_rgb8(), &a.faces);
            if score > best_score {
                best = before;
            }
        }
    }
    let mut result = correction::blend_selected(best.clone(), &e.baseline, c.strength, selected);
    // Verify the strength-scaled output too; stronger settings must not bypass clipping protection.
    let view = preview(app, &e.path, base, gpu, result.clone())?;
    if c.strength > 1.0 && quality::clipping_cost(&original, &view.to_rgb8(), &a.faces) > 0.04 {
        result = correction::blend_selected(best, &e.baseline, 1.0, selected);
    }
    Ok(result)
}
