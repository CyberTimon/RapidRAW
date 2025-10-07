use regex::Regex;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use uuid::Uuid;

use crate::file_management::Preset;

#[derive(Copy, Clone, Debug)]
enum Num {
    I(i64),
    F(f64),
}

fn parse_num(s: &str) -> Option<Num> {
    if let Ok(i) = s.parse::<i64>() {
        Some(Num::I(i))
    } else if let Ok(f) = s.parse::<f64>() {
        Some(Num::F(f))
    } else {
        None
    }
}

fn num_to_json(num: Num) -> Option<Value> {
    match num {
        Num::I(i) => Some(Value::Number(i.into())),
        Num::F(f) => serde_json::Number::from_f64(f).map(Value::Number),
    }
}

fn get_attr_as_f64(attrs: &HashMap<String, String>, key: &str) -> Option<f64> {
    attrs
        .get(key)
        .and_then(|s| s.trim_start_matches('+').parse::<f64>().ok())
}

fn extract_xmp_name(xmp_content: &str) -> Option<String> {
    let re =
        Regex::new(r#"(?s)<crs:Name>.*?<rdf:Alt>.*?<rdf:li[^>]*>([^<]+)</rdf:li>.*?</crs:Name>"#)
            .ok()?;
    re.captures(xmp_content)
        .and_then(|c| c.get(1).map(|m| m.as_str().trim().to_string()))
}

fn extract_tone_curve_points(xmp_str: &str, curve_name: &str) -> Option<Vec<Value>> {
    let pattern = format!(
        r"(?s)<crs:{}>\s*<rdf:Seq>(.*?)</rdf:Seq>\s*</crs:{}>",
        curve_name, curve_name
    );
    let re = Regex::new(&pattern).ok()?;
    let captures = re.captures(xmp_str)?;
    let seq_content = captures.get(1)?.as_str();

    let point_re = Regex::new(r"<rdf:li>(\d+),\s*(\d+)</rdf:li>").ok()?;
    let mut points = Vec::new();

    for point_cap in point_re.captures_iter(seq_content) {
        let x: u32 = point_cap.get(1)?.as_str().parse().ok()?;
        let y: u32 = point_cap.get(2)?.as_str().parse().ok()?;

        let mut final_y = y;
        if curve_name == "ToneCurvePV2012" {
            const SHADOW_RANGE_END: f64 = 64.0;
            const SHADOW_DAMPEN_START: f64 = 0.8;
            const SHADOW_DAMPEN_END: f64 = 1.0;

            let x_f64 = x as f64;
            let y_f64 = y as f64;

            if y_f64 > x_f64 && x_f64 < SHADOW_RANGE_END {
                let lift_amount = y_f64 - x_f64;
                let progress = x_f64 / SHADOW_RANGE_END;
                let dampening_factor =
                    SHADOW_DAMPEN_START + (SHADOW_DAMPEN_END - SHADOW_DAMPEN_START) * progress;

                let new_y = x_f64 + (lift_amount * dampening_factor);
                final_y = new_y.round().clamp(0.0, 255.0) as u32;
            }
        }

        let mut point = Map::new();
        point.insert("x".to_string(), Value::Number(x.into()));
        point.insert("y".to_string(), Value::Number(final_y.into()));
        points.push(Value::Object(point));
    }

    if points.is_empty() {
        None
    } else {
        Some(points)
    }
}

pub fn convert_xmp_to_preset(xmp_content: &str) -> Result<Preset, String> {
    let xmp_one_line = xmp_content.split('\n').collect::<Vec<_>>().join(" ");

    let attr_re = Regex::new(r#"crs:([A-Za-z0-9]+)="([^"]*)""#)
        .map_err(|e| format!("Regex compilation failed: {}", e))?;
    let mut attrs: HashMap<String, String> = HashMap::new();
    for cap in attr_re.captures_iter(&xmp_one_line) {
        attrs.insert(cap[1].to_string(), cap[2].to_string());
    }

    let mut adjustments = Map::new();
    let mut hsl_map = Map::new();
    let mut color_grading_map = Map::new();
    let mut curves_map = Map::new();

    let mappings = vec![
        ("Exposure2012", "exposure"),
        ("Contrast2012", "contrast"),
        ("Highlights2012", "highlights"),
        ("Whites2012", "whites"),
        ("Blacks2012", "blacks"),
        ("Clarity2012", "clarity"),
        ("Dehaze", "dehaze"),
        ("Vibrance", "vibrance"),
        ("Saturation", "saturation"),
        ("Texture", "structure"),
        ("SharpenRadius", "sharpenRadius"),
        ("SharpenDetail", "sharpenDetail"),
        ("SharpenEdgeMasking", "sharpenMasking"),
        ("LuminanceSmoothing", "lumaNoiseReduction"),
        ("ColorNoiseReduction", "colorNoiseReduction"),
        ("ColorNoiseReductionDetail", "colorNoiseDetail"),
        ("ColorNoiseReductionSmoothness", "colorNoiseSmoothness"),
        ("ChromaticAberrationRedCyan", "chromaticAberrationRedCyan"),
        (
            "ChromaticAberrationBlueYellow",
            "chromaticAberrationBlueYellow",
        ),
        ("PostCropVignetteAmount", "vignetteAmount"),
        ("PostCropVignetteMidpoint", "vignetteMidpoint"),
        ("PostCropVignetteFeather", "vignetteFeather"),
        ("PostCropVignetteRoundness", "vignetteRoundness"),
        ("GrainAmount", "grainAmount"),
        ("GrainSize", "grainSize"),
        ("GrainFrequency", "grainRoughness"),
        ("ColorGradeBlending", "blending"),
    ];

    for (xmp_key, rr_key) in mappings {
        if let Some(raw_val) = attrs.get(xmp_key) {
            if let Some(num) = parse_num(raw_val.trim_start_matches('+')) {
                if let Some(json_val) = num_to_json(num) {
                    if rr_key == "blending" {
                        color_grading_map.insert(rr_key.to_string(), json_val);
                    } else {
                        adjustments.insert(rr_key.to_string(), json_val);
                    }
                }
            }
        }
    }

    if let Some(shadows_val) = get_attr_as_f64(&attrs, "Shadows2012") {
        let adjusted_shadows = (shadows_val * 1.5).min(100.0);
        adjustments.insert("shadows".to_string(), json!(adjusted_shadows));
    }

    if let Some(sharpness_val) = get_attr_as_f64(&attrs, "Sharpness") {
        let scaled_sharpness = (sharpness_val / 150.0) * 100.0;
        adjustments.insert(
            "sharpness".to_string(),
            json!(scaled_sharpness.clamp(0.0, 100.0)),
        );
    }

    if let Some(adjusted_k) = get_attr_as_f64(&attrs, "Temperature") {
        const AS_SHOT_DEFAULT: f64 = 5500.0;
        const MAX_MIRED_SHIFT: f64 = 150.0;
        let as_shot_k = get_attr_as_f64(&attrs, "AsShotTemperature").unwrap_or(AS_SHOT_DEFAULT);
        let mired_adjusted = 1_000_000.0 / adjusted_k;
        let mired_as_shot = 1_000_000.0 / as_shot_k;
        let mired_delta = mired_adjusted - mired_as_shot;
        let temp_value = (-mired_delta / MAX_MIRED_SHIFT) * 100.0;
        adjustments.insert(
            "temperature".to_string(),
            json!(temp_value.clamp(-100.0, 100.0)),
        );
    }

    if let Some(tint_val) = get_attr_as_f64(&attrs, "Tint") {
        let scaled_tint = (tint_val / 150.0) * 100.0;
        adjustments.insert("tint".to_string(), json!(scaled_tint.clamp(-100.0, 100.0)));
    }

    let colors = [
        ("Red", "reds"),
        ("Orange", "oranges"),
        ("Yellow", "yellows"),
        ("Green", "greens"),
        ("Aqua", "aquas"),
        ("Blue", "blues"),
        ("Purple", "purples"),
        ("Magenta", "magentas"),
    ];
    for (src, dst) in colors {
        let mut color_map = Map::new();
        if let Some(raw) = attrs.get(&format!("HueAdjustment{}", src)) {
            if let Some(num) = parse_num(raw.trim_start_matches('+')) {
                if let Some(Value::Number(n)) = num_to_json(num) {
                    if let Some(val_f64) = n.as_f64() {
                        let adjusted_hue = val_f64 * 0.75;
                        color_map.insert("hue".to_string(), json!(adjusted_hue));
                    }
                }
            }
        }
        if let Some(raw) = attrs.get(&format!("SaturationAdjustment{}", src)) {
            if let Some(num) = parse_num(raw.trim_start_matches('+')) {
                if let Some(json_val) = num_to_json(num) {
                    color_map.insert("saturation".to_string(), json_val);
                }
            }
        }
        if let Some(raw) = attrs.get(&format!("LuminanceAdjustment{}", src)) {
            if let Some(num) = parse_num(raw.trim_start_matches('+')) {
                if let Some(json_val) = num_to_json(num) {
                    color_map.insert("luminance".to_string(), json_val);
                }
            }
        }
        if !color_map.is_empty() {
            hsl_map.insert(dst.to_string(), Value::Object(color_map));
        }
    }
    if !hsl_map.is_empty() {
        adjustments.insert("hsl".to_string(), Value::Object(hsl_map));
    }

    let mut shadows_map = Map::new();
    let mut midtones_map = Map::new();
    let mut highlights_map = Map::new();
    if let Some(raw) = attrs.get("SplitToningShadowHue") {
        if let Some(num) = parse_num(raw) {
            if let Some(json_val) = num_to_json(num) {
                shadows_map.insert("hue".to_string(), json_val);
            }
        }
    }
    if let Some(raw) = attrs.get("ColorGradeMidtoneHue") {
        if let Some(num) = parse_num(raw) {
            if let Some(json_val) = num_to_json(num) {
                midtones_map.insert("hue".to_string(), json_val);
            }
        }
    }
    if let Some(raw) = attrs.get("SplitToningHighlightHue") {
        if let Some(num) = parse_num(raw) {
            if let Some(json_val) = num_to_json(num) {
                highlights_map.insert("hue".to_string(), json_val);
            }
        }
    }
    if let Some(raw) = attrs.get("SplitToningShadowSaturation") {
        if let Some(num) = parse_num(raw) {
            if let Some(json_val) = num_to_json(num) {
                shadows_map.insert("saturation".to_string(), json_val);
            }
        }
    }
    if let Some(raw) = attrs.get("ColorGradeMidtoneSat") {
        if let Some(num) = parse_num(raw) {
            if let Some(json_val) = num_to_json(num) {
                midtones_map.insert("saturation".to_string(), json_val);
            }
        }
    }
    if let Some(raw) = attrs.get("SplitToningHighlightSaturation") {
        if let Some(num) = parse_num(raw) {
            if let Some(json_val) = num_to_json(num) {
                highlights_map.insert("saturation".to_string(), json_val);
            }
        }
    }
    if let Some(raw) = attrs.get("ColorGradeShadowLum") {
        if let Some(num) = parse_num(raw) {
            if let Some(json_val) = num_to_json(num) {
                shadows_map.insert("luminance".to_string(), json_val);
            }
        }
    }
    if let Some(raw) = attrs.get("ColorGradeMidtoneLum") {
        if let Some(num) = parse_num(raw) {
            if let Some(json_val) = num_to_json(num) {
                midtones_map.insert("luminance".to_string(), json_val);
            }
        }
    }
    if let Some(raw) = attrs.get("ColorGradeHighlightLum") {
        if let Some(num) = parse_num(raw) {
            if let Some(json_val) = num_to_json(num) {
                highlights_map.insert("luminance".to_string(), json_val);
            }
        }
    }
    if let Some(raw) = attrs.get("SplitToningBalance") {
        if let Some(num) = parse_num(raw) {
            if let Some(json_val) = num_to_json(num) {
                color_grading_map.insert("balance".to_string(), json_val);
            }
        }
    }
    if !shadows_map.is_empty() {
        color_grading_map.insert("shadows".to_string(), Value::Object(shadows_map));
    }
    if !midtones_map.is_empty() {
        color_grading_map.insert("midtones".to_string(), Value::Object(midtones_map));
    }
    if !highlights_map.is_empty() {
        color_grading_map.insert("highlights".to_string(), Value::Object(highlights_map));
    }
    if !color_grading_map.is_empty() {
        adjustments.insert("colorGrading".to_string(), Value::Object(color_grading_map));
    }

    let curve_mappings = [
        ("ToneCurvePV2012", "luma"),
        ("ToneCurvePV2012Red", "red"),
        ("ToneCurvePV2012Green", "green"),
        ("ToneCurvePV2012Blue", "blue"),
    ];
    for (xmp_curve, rr_curve) in curve_mappings {
        if let Some(points) = extract_tone_curve_points(xmp_content, xmp_curve) {
            curves_map.insert(rr_curve.to_string(), Value::Array(points));
        }
    }
    if !curves_map.is_empty() {
        adjustments.insert("curves".to_string(), Value::Object(curves_map));
    }

    let preset_name =
        extract_xmp_name(xmp_content).unwrap_or_else(|| "Imported Preset".to_string());

    Ok(Preset {
        id: Uuid::new_v4().to_string(),
        name: preset_name,
        adjustments: Value::Object(adjustments),
    })
}
