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

fn extract_namespaced_scalar(content: &str, prefix: &str, key: &str) -> Option<String> {
    let prefix = regex::escape(prefix);
    let key = regex::escape(key);
    let attr_pattern = format!(r#"{}:{}="([^"]*)""#, prefix, key);
    let attr_re = Regex::new(&attr_pattern).ok()?;
    if let Some(captures) = attr_re.captures(content) {
        return captures
            .get(1)
            .map(|value| value.as_str().trim().to_string());
    }

    let element_pattern = format!(
        r#"(?s)<{}:{}>\s*([^<]+?)\s*</{}:{}>"#,
        prefix, key, prefix, key
    );
    Regex::new(&element_pattern)
        .ok()?
        .captures(content)
        .and_then(|captures| {
            captures
                .get(1)
                .map(|value| value.as_str().trim().to_string())
        })
}

fn get_namespaced_f64(content: &str, prefix: &str, key: &str) -> Option<f64> {
    extract_namespaced_scalar(content, prefix, key)?
        .trim_start_matches('+')
        .parse::<f64>()
        .ok()
}

fn is_xmp_true(value: Option<&String>) -> bool {
    value.is_some_and(|value| value.eq_ignore_ascii_case("true") || value == "1")
}

fn orient_crop_bounds(
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
    orientation: u16,
) -> (f64, f64, f64, f64) {
    match orientation {
        2 => (1.0 - right, top, 1.0 - left, bottom),
        3 => (1.0 - right, 1.0 - bottom, 1.0 - left, 1.0 - top),
        4 => (left, 1.0 - bottom, right, 1.0 - top),
        5 => (1.0 - bottom, 1.0 - right, 1.0 - top, 1.0 - left),
        6 => (1.0 - bottom, left, 1.0 - top, right),
        7 => (top, left, bottom, right),
        8 => (top, 1.0 - right, bottom, 1.0 - left),
        _ => (left, top, right, bottom),
    }
}

fn import_xmp_crop(
    xmp_content: &str,
    attrs: &HashMap<String, String>,
    adjustments: &mut Map<String, Value>,
) {
    if !is_xmp_true(attrs.get("HasCrop")) || is_xmp_true(attrs.get("AlreadyApplied")) {
        return;
    }

    let Some(left) = get_attr_as_f64(attrs, "CropLeft") else {
        return;
    };
    let Some(top) = get_attr_as_f64(attrs, "CropTop") else {
        return;
    };
    let Some(right) = get_attr_as_f64(attrs, "CropRight") else {
        return;
    };
    let Some(bottom) = get_attr_as_f64(attrs, "CropBottom") else {
        return;
    };

    if ![left, top, right, bottom]
        .iter()
        .all(|value| value.is_finite() && (0.0..=1.0).contains(value))
        || right <= left
        || bottom <= top
    {
        return;
    }

    let image_width = get_namespaced_f64(xmp_content, "tiff", "ImageWidth")
        .or_else(|| get_namespaced_f64(xmp_content, "exif", "PixelXDimension"));
    let image_height = get_namespaced_f64(xmp_content, "tiff", "ImageLength")
        .or_else(|| get_namespaced_f64(xmp_content, "exif", "PixelYDimension"));
    let (Some(image_width), Some(image_height)) = (image_width, image_height) else {
        return;
    };
    if image_width < 1.0 || image_height < 1.0 {
        return;
    }

    let orientation = extract_namespaced_scalar(xmp_content, "tiff", "Orientation")
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(1);
    let (left, top, right, bottom) = orient_crop_bounds(left, top, right, bottom, orientation);
    let (oriented_width, oriented_height) = if (5..=8).contains(&orientation) {
        (image_height, image_width)
    } else {
        (image_width, image_height)
    };

    let x = (left * oriented_width).ceil();
    let y = (top * oriented_height).ceil();
    let width = ((right - left) * oriented_width)
        .floor()
        .min(oriented_width - x);
    let height = ((bottom - top) * oriented_height)
        .floor()
        .min(oriented_height - y);
    if width < 1.0 || height < 1.0 {
        return;
    }

    adjustments.insert(
        "crop".to_string(),
        json!({
            "x": x,
            "y": y,
            "width": width,
            "height": height,
        }),
    );
    adjustments.insert("aspectRatio".to_string(), json!(width / height));

    if let Some(angle) = get_attr_as_f64(attrs, "CropAngle")
        && angle.is_finite()
        && angle.abs() > f64::EPSILON
    {
        // Lightroom stores CropAngle with the opposite sign from RapidRAW's
        // clockwise-positive rotation control.
        adjustments.insert("rotation".to_string(), json!(-angle));
    }
}

fn import_legacy_basic_adjustments(
    attrs: &HashMap<String, String>,
    adjustments: &mut Map<String, Value>,
) {
    // Process Version 2003/2010 uses a different Basic panel from PV2012.
    // Only use these fields as fallbacks so a sidecar containing both process
    // representations always prefers the newer PV2012 values.
    if !attrs.contains_key("Exposure2012")
        && let Some(value) = get_attr_as_f64(attrs, "Exposure")
    {
        adjustments.insert("exposure".to_string(), json!(value.clamp(-5.0, 5.0)));
    }

    if !attrs.contains_key("Highlights2012")
        && let Some(value) = get_attr_as_f64(attrs, "HighlightRecovery")
    {
        adjustments.insert("highlights".to_string(), json!((-value).clamp(-100.0, 0.0)));
    }

    if !attrs.contains_key("Shadows2012")
        && let Some(value) = get_attr_as_f64(attrs, "FillLight")
    {
        adjustments.insert("shadows".to_string(), json!(value.clamp(0.0, 100.0)));
    }

    if !attrs.contains_key("Blacks2012")
        && let Some(value) = get_attr_as_f64(attrs, "Shadows")
    {
        const LEGACY_NEUTRAL_BLACKS: f64 = 5.0;
        adjustments.insert(
            "blacks".to_string(),
            json!((LEGACY_NEUTRAL_BLACKS - value).clamp(-100.0, 100.0)),
        );
    }

    if !attrs.contains_key("Exposure2012")
        && let Some(value) = get_attr_as_f64(attrs, "Brightness")
    {
        const LEGACY_NEUTRAL_BRIGHTNESS: f64 = 50.0;
        const LEGACY_BRIGHTNESS_TO_RR: f64 = 10.0;
        adjustments.insert(
            "brightness".to_string(),
            json!(((value - LEGACY_NEUTRAL_BRIGHTNESS) / LEGACY_BRIGHTNESS_TO_RR).clamp(-5.0, 5.0)),
        );
    }

    if !attrs.contains_key("Contrast2012")
        && let Some(value) = get_attr_as_f64(attrs, "Contrast")
    {
        const LEGACY_NEUTRAL_CONTRAST: f64 = 25.0;
        adjustments.insert(
            "contrast".to_string(),
            json!((value - LEGACY_NEUTRAL_CONTRAST).clamp(-100.0, 100.0)),
        );
    }

    if !attrs.contains_key("Clarity2012")
        && let Some(value) = get_attr_as_f64(attrs, "Clarity")
    {
        adjustments.insert("clarity".to_string(), json!(value.clamp(-100.0, 100.0)));
    }
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
    convert_xmp_to_preset_with_crop(xmp_content, false, Some(5500.0))
}

pub fn convert_xmp_sidecar_to_preset(xmp_content: &str) -> Result<Preset, String> {
    convert_xmp_sidecar_to_preset_with_as_shot_temperature(xmp_content, None)
}

fn convert_xmp_sidecar_to_preset_with_as_shot_temperature(
    xmp_content: &str,
    as_shot_temperature: Option<f64>,
) -> Result<Preset, String> {
    convert_xmp_to_preset_with_crop(xmp_content, true, as_shot_temperature)
}

fn parse_xmp_attributes(xmp_content: &str) -> Result<HashMap<String, String>, String> {
    // Lightroom sidecars can contain nested rdf:Description elements for
    // profiles and looks. Only the outer description represents the image's
    // active settings; nested attributes must not overwrite those values.
    let description_re = Regex::new(r#"(?s)<rdf:Description\b([^>]*)>"#)
        .map_err(|e| format!("Regex compilation failed: {}", e))?;
    let attribute_source = description_re
        .captures(xmp_content)
        .and_then(|captures| captures.get(1))
        .map_or(xmp_content, |attributes| attributes.as_str());

    let attr_re = Regex::new(r#"crs:([A-Za-z0-9]+)="([^"]*)""#)
        .map_err(|e| format!("Regex compilation failed: {}", e))?;
    let mut attrs: HashMap<String, String> = HashMap::new();
    for cap in attr_re.captures_iter(attribute_source) {
        attrs.insert(cap[1].to_string(), cap[2].to_string());
    }

    let elem_re = Regex::new(r#"(?s)<crs:([A-Za-z0-9]+)>\s*([^<]+?)\s*</crs:([A-Za-z0-9]+)>"#)
        .map_err(|e| format!("Regex compilation failed: {}", e))?;
    for cap in elem_re.captures_iter(xmp_content) {
        if cap[1] == cap[3] {
            attrs
                .entry(cap[1].to_string())
                .or_insert_with(|| cap[2].trim().to_string());
        }
    }

    Ok(attrs)
}

fn convert_xmp_to_preset_with_crop(
    xmp_content: &str,
    include_crop_transform: bool,
    as_shot_temperature: Option<f64>,
) -> Result<Preset, String> {
    let attrs = parse_xmp_attributes(xmp_content)?;

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
        if let Some(raw_val) = attrs.get(xmp_key)
            && let Some(num) = parse_num(raw_val.trim_start_matches('+'))
            && let Some(json_val) = num_to_json(num)
        {
            if rr_key == "blending" {
                color_grading_map.insert(rr_key.to_string(), json_val);
            } else {
                adjustments.insert(rr_key.to_string(), json_val);
            }
        }
    }

    import_legacy_basic_adjustments(&attrs, &mut adjustments);

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

    let white_balance_is_as_shot = attrs
        .get("WhiteBalance")
        .is_some_and(|value| value.eq_ignore_ascii_case("As Shot"));

    if !white_balance_is_as_shot && let Some(adjusted_k) = get_attr_as_f64(&attrs, "Temperature") {
        const MAX_MIRED_SHIFT: f64 = 150.0;
        if let Some(as_shot_k) = get_attr_as_f64(&attrs, "AsShotTemperature")
            .or(as_shot_temperature)
            .filter(|temperature| *temperature > 0.0)
            && adjusted_k > 0.0
        {
            let mired_adjusted = 1_000_000.0 / adjusted_k;
            let mired_as_shot = 1_000_000.0 / as_shot_k;
            let mired_delta = mired_adjusted - mired_as_shot;
            let temp_value = (-mired_delta / MAX_MIRED_SHIFT) * 100.0;
            adjustments.insert(
                "temperature".to_string(),
                json!(temp_value.clamp(-100.0, 100.0)),
            );
        }
    }

    if !white_balance_is_as_shot && let Some(tint_val) = get_attr_as_f64(&attrs, "Tint") {
        // Lightroom stores tint as an absolute, camera-profile-dependent value.
        // Sidecars therefore need an as-shot baseline before that value can be
        // translated into RapidRAW's relative tint control. Preset XMP files do
        // not describe a particular source image, so retain their established
        // direct conversion behavior.
        let tint_delta = get_attr_as_f64(&attrs, "AsShotTint")
            .map(|as_shot_tint| tint_val - as_shot_tint)
            .or((!include_crop_transform).then_some(tint_val));
        if let Some(tint_delta) = tint_delta {
            let scaled_tint = (tint_delta / 150.0) * 100.0;
            adjustments.insert("tint".to_string(), json!(scaled_tint.clamp(-100.0, 100.0)));
        }
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
        if let Some(raw) = attrs.get(&format!("HueAdjustment{}", src))
            && let Some(num) = parse_num(raw.trim_start_matches('+'))
            && let Some(Value::Number(n)) = num_to_json(num)
            && let Some(val_f64) = n.as_f64()
        {
            let adjusted_hue = val_f64 * 0.75;
            color_map.insert("hue".to_string(), json!(adjusted_hue));
        }
        if let Some(raw) = attrs.get(&format!("SaturationAdjustment{}", src))
            && let Some(num) = parse_num(raw.trim_start_matches('+'))
            && let Some(json_val) = num_to_json(num)
        {
            color_map.insert("saturation".to_string(), json_val);
        }
        if let Some(raw) = attrs.get(&format!("LuminanceAdjustment{}", src))
            && let Some(num) = parse_num(raw.trim_start_matches('+'))
            && let Some(json_val) = num_to_json(num)
        {
            color_map.insert("luminance".to_string(), json_val);
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
    let mut global_map = Map::new();
    if let Some(raw) = attrs.get("SplitToningShadowHue")
        && let Some(num) = parse_num(raw)
        && let Some(json_val) = num_to_json(num)
    {
        shadows_map.insert("hue".to_string(), json_val);
    }
    if let Some(raw) = attrs.get("ColorGradeMidtoneHue")
        && let Some(num) = parse_num(raw)
        && let Some(json_val) = num_to_json(num)
    {
        midtones_map.insert("hue".to_string(), json_val);
    }
    if let Some(raw) = attrs.get("SplitToningHighlightHue")
        && let Some(num) = parse_num(raw)
        && let Some(json_val) = num_to_json(num)
    {
        highlights_map.insert("hue".to_string(), json_val);
    }
    if let Some(raw) = attrs.get("SplitToningShadowSaturation")
        && let Some(num) = parse_num(raw)
        && let Some(json_val) = num_to_json(num)
    {
        shadows_map.insert("saturation".to_string(), json_val);
    }
    if let Some(raw) = attrs.get("ColorGradeMidtoneSat")
        && let Some(num) = parse_num(raw)
        && let Some(json_val) = num_to_json(num)
    {
        midtones_map.insert("saturation".to_string(), json_val);
    }
    if let Some(raw) = attrs.get("SplitToningHighlightSaturation")
        && let Some(num) = parse_num(raw)
        && let Some(json_val) = num_to_json(num)
    {
        highlights_map.insert("saturation".to_string(), json_val);
    }
    if let Some(raw) = attrs.get("ColorGradeShadowLum")
        && let Some(num) = parse_num(raw)
        && let Some(json_val) = num_to_json(num)
    {
        shadows_map.insert("luminance".to_string(), json_val);
    }
    if let Some(raw) = attrs.get("ColorGradeMidtoneLum")
        && let Some(num) = parse_num(raw)
        && let Some(json_val) = num_to_json(num)
    {
        midtones_map.insert("luminance".to_string(), json_val);
    }
    if let Some(raw) = attrs.get("ColorGradeHighlightLum")
        && let Some(num) = parse_num(raw)
        && let Some(json_val) = num_to_json(num)
    {
        highlights_map.insert("luminance".to_string(), json_val);
    }
    if let Some(raw) = attrs.get("ColorGradeGlobalHue")
        && let Some(num) = parse_num(raw)
        && let Some(json_val) = num_to_json(num)
    {
        global_map.insert("hue".to_string(), json_val);
    }
    if let Some(raw) = attrs.get("ColorGradeGlobalSat")
        && let Some(num) = parse_num(raw)
        && let Some(json_val) = num_to_json(num)
    {
        global_map.insert("saturation".to_string(), json_val);
    }
    if let Some(raw) = attrs.get("ColorGradeGlobalLum")
        && let Some(num) = parse_num(raw)
        && let Some(json_val) = num_to_json(num)
    {
        global_map.insert("luminance".to_string(), json_val);
    }
    if let Some(raw) = attrs.get("SplitToningBalance")
        && let Some(num) = parse_num(raw)
        && let Some(json_val) = num_to_json(num)
    {
        color_grading_map.insert("balance".to_string(), json_val);
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
    if !global_map.is_empty() {
        color_grading_map.insert("global".to_string(), Value::Object(global_map));
    }
    if !color_grading_map.is_empty() {
        adjustments.insert("colorGrading".to_string(), Value::Object(color_grading_map));
    }

    let curve_mappings = [
        (["ToneCurvePV2012", "ToneCurve"], "luma"),
        (["ToneCurvePV2012Red", "ToneCurveRed"], "red"),
        (["ToneCurvePV2012Green", "ToneCurveGreen"], "green"),
        (["ToneCurvePV2012Blue", "ToneCurveBlue"], "blue"),
    ];
    for (xmp_curves, rr_curve) in curve_mappings {
        for xmp_curve in xmp_curves {
            if let Some(points) = extract_tone_curve_points(xmp_content, xmp_curve) {
                curves_map.insert(rr_curve.to_string(), Value::Array(points));
                break;
            }
        }
    }
    if !curves_map.is_empty() {
        adjustments.insert("curves".to_string(), Value::Object(curves_map));
    }

    if include_crop_transform {
        import_xmp_crop(xmp_content, &attrs, &mut adjustments);
    }

    let preset_name =
        extract_xmp_name(xmp_content).unwrap_or_else(|| "Imported Preset".to_string());

    Ok(Preset {
        id: Uuid::new_v4().to_string(),
        name: preset_name,
        adjustments: Value::Object(adjustments),
        include_masks: Some(false),
        include_crop_transform: Some(include_crop_transform),
        preset_type: Some("style".to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn converts_attribute_based_xmp_adjustments() {
        let preset = convert_xmp_to_preset(
            r#"<rdf:Description crs:Exposure2012="+0.50" crs:Contrast2012="25" />"#,
        )
        .unwrap();

        assert_eq!(preset.adjustments["exposure"], json!(0.5));
        assert_eq!(preset.adjustments["contrast"], json!(25));
    }

    #[test]
    fn converts_element_based_xmp_adjustments() {
        let preset = convert_xmp_to_preset(
            r#"
            <rdf:Description>
              <crs:Exposure2012>+0.50</crs:Exposure2012>
              <crs:Contrast2012>25</crs:Contrast2012>
            </rdf:Description>
            "#,
        )
        .unwrap();

        assert_eq!(preset.adjustments["exposure"], json!(0.5));
        assert_eq!(preset.adjustments["contrast"], json!(25));
    }

    #[test]
    fn converts_legacy_process_adjustments_and_tone_curve() {
        let preset = convert_xmp_sidecar_to_preset(
            r#"<rdf:Description
                crs:ProcessVersion="5.7"
                crs:Exposure="0.00"
                crs:HighlightRecovery="20"
                crs:FillLight="0"
                crs:Shadows="5"
                crs:Brightness="+50"
                crs:Contrast="+25"
                crs:Clarity="0">
              <crs:ToneCurve>
                <rdf:Seq>
                  <rdf:li>0, 0</rdf:li>
                  <rdf:li>32, 16</rdf:li>
                  <rdf:li>64, 50</rdf:li>
                  <rdf:li>128, 128</rdf:li>
                  <rdf:li>192, 202</rdf:li>
                  <rdf:li>255, 255</rdf:li>
                </rdf:Seq>
              </crs:ToneCurve>
            </rdf:Description>"#,
        )
        .unwrap();

        assert_eq!(preset.adjustments["exposure"], json!(0.0));
        assert_eq!(preset.adjustments["highlights"], json!(-20.0));
        assert_eq!(preset.adjustments["shadows"], json!(0.0));
        assert_eq!(preset.adjustments["blacks"], json!(0.0));
        assert_eq!(preset.adjustments["brightness"], json!(0.0));
        assert_eq!(preset.adjustments["contrast"], json!(0.0));
        assert_eq!(preset.adjustments["clarity"], json!(0.0));
        assert_eq!(
            preset.adjustments["curves"]["luma"],
            json!([
                { "x": 0, "y": 0 },
                { "x": 32, "y": 16 },
                { "x": 64, "y": 50 },
                { "x": 128, "y": 128 },
                { "x": 192, "y": 202 },
                { "x": 255, "y": 255 }
            ])
        );
    }

    #[test]
    fn prefers_pv2012_values_and_curves_over_legacy_fallbacks() {
        let preset = convert_xmp_to_preset(
            r#"<rdf:Description
                crs:Exposure2012="+0.50"
                crs:Exposure="+2.00">
              <crs:ToneCurvePV2012>
                <rdf:Seq>
                  <rdf:li>0, 0</rdf:li>
                  <rdf:li>255, 255</rdf:li>
                </rdf:Seq>
              </crs:ToneCurvePV2012>
              <crs:ToneCurve>
                <rdf:Seq>
                  <rdf:li>0, 10</rdf:li>
                  <rdf:li>255, 245</rdf:li>
                </rdf:Seq>
              </crs:ToneCurve>
            </rdf:Description>"#,
        )
        .unwrap();

        assert_eq!(preset.adjustments["exposure"], json!(0.5));
        assert_eq!(
            preset.adjustments["curves"]["luma"],
            json!([{ "x": 0, "y": 0 }, { "x": 255, "y": 255 }])
        );
    }

    #[test]
    fn ignores_adjustment_attributes_in_nested_lightroom_look() {
        let preset = convert_xmp_sidecar_to_preset(
            r#"<rdf:Description crs:Exposure2012="+0.50" crs:ProcessVersion="11.0">
              <crs:Look>
                <rdf:Description crs:Exposure2012="+2.00" crs:ProcessVersion="15.4" />
              </crs:Look>
            </rdf:Description>"#,
        )
        .unwrap();

        assert_eq!(preset.adjustments["exposure"], json!(0.5));
    }

    #[test]
    fn converts_sidecar_crop_to_rapidraw_pixels() {
        let preset = convert_xmp_sidecar_to_preset(
            r#"<rdf:Description
                tiff:ImageWidth="6000"
                tiff:ImageLength="4000"
                tiff:Orientation="1"
                crs:CropTop="0.078"
                crs:CropLeft="0"
                crs:CropBottom="0.922"
                crs:CropRight="1"
                crs:CropAngle="0"
                crs:HasCrop="True"
                crs:AlreadyApplied="False" />"#,
        )
        .unwrap();

        assert_eq!(
            preset.adjustments["crop"],
            json!({ "x": 0.0, "y": 312.0, "width": 6000.0, "height": 3376.0 })
        );
        assert_eq!(preset.adjustments["aspectRatio"], json!(6000.0 / 3376.0));
    }

    #[test]
    fn transforms_sidecar_crop_for_exif_orientation() {
        let preset = convert_xmp_sidecar_to_preset(
            r#"<rdf:Description
                tiff:ImageWidth="6000"
                tiff:ImageLength="4000"
                tiff:Orientation="8"
                crs:CropTop="0.078"
                crs:CropLeft="0"
                crs:CropBottom="0.922"
                crs:CropRight="1"
                crs:HasCrop="True" />"#,
        )
        .unwrap();

        assert_eq!(
            preset.adjustments["crop"],
            json!({ "x": 312.0, "y": 0.0, "width": 3376.0, "height": 6000.0 })
        );
    }

    #[test]
    fn imports_element_based_crop_and_rotation() {
        let preset = convert_xmp_sidecar_to_preset(
            r#"<rdf:Description>
                <tiff:ImageWidth>6000</tiff:ImageWidth>
                <tiff:ImageLength>4000</tiff:ImageLength>
                <crs:CropTop>0.1</crs:CropTop>
                <crs:CropLeft>0.2</crs:CropLeft>
                <crs:CropBottom>0.9</crs:CropBottom>
                <crs:CropRight>0.8</crs:CropRight>
                <crs:CropAngle>2.05755</crs:CropAngle>
                <crs:HasCrop>True</crs:HasCrop>
            </rdf:Description>"#,
        )
        .unwrap();

        assert_eq!(
            preset.adjustments["crop"],
            json!({ "x": 1200.0, "y": 400.0, "width": 3600.0, "height": 3200.0 })
        );
        assert_eq!(preset.adjustments["rotation"], json!(-2.05755));
    }

    #[test]
    fn keeps_crop_out_of_reusable_xmp_presets() {
        let preset = convert_xmp_to_preset(
            r#"<rdf:Description
                tiff:ImageWidth="6000"
                tiff:ImageLength="4000"
                crs:CropTop="0.1"
                crs:CropLeft="0.2"
                crs:CropBottom="0.9"
                crs:CropRight="0.8"
                crs:HasCrop="True" />"#,
        )
        .unwrap();

        assert!(preset.adjustments.as_object().unwrap().is_empty());
        assert_eq!(preset.include_crop_transform, Some(false));
    }

    #[test]
    fn converts_custom_white_balance_relative_to_raw_as_shot_values() {
        let xmp = r#"<rdf:Description
                crs:WhiteBalance="Custom"
                crs:Temperature="5068"
                crs:AsShotTemperature="4440"
                crs:Tint="-11"
                crs:AsShotTint="-5" />"#;
        let preset = convert_xmp_sidecar_to_preset(xmp).unwrap();

        assert!((preset.adjustments["temperature"].as_f64().unwrap() - 18.6).abs() < 0.1);
        assert!((preset.adjustments["tint"].as_f64().unwrap() + 4.0).abs() < 0.01);
    }

    #[test]
    fn keeps_as_shot_white_balance_neutral() {
        let xmp = r#"<rdf:Description
                crs:WhiteBalance="As Shot"
                crs:Temperature="6800"
                crs:Tint="+38" />"#;
        let preset = convert_xmp_sidecar_to_preset(xmp).unwrap();

        assert!(preset.adjustments.get("temperature").is_none());
        assert!(preset.adjustments.get("tint").is_none());
    }

    #[test]
    fn omits_custom_temperature_when_as_shot_baseline_is_unknown() {
        let preset = convert_xmp_sidecar_to_preset(
            r#"<rdf:Description crs:WhiteBalance="Custom" crs:Temperature="5068" />"#,
        )
        .unwrap();

        assert!(preset.adjustments.get("temperature").is_none());
    }

    #[test]
    fn omits_absolute_sidecar_white_balance_without_as_shot_baseline() {
        let preset = convert_xmp_sidecar_to_preset(
            r#"<rdf:Description
                crs:WhiteBalance="Custom"
                crs:Temperature="6190"
                crs:Tint="+12" />"#,
        )
        .unwrap();

        assert!(preset.adjustments.get("temperature").is_none());
        assert!(preset.adjustments.get("tint").is_none());
    }
}
