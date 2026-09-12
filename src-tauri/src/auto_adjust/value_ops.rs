use super::types::AdjustmentFamilies;
use serde_json::{Value, json};

const HSL_NAMES: [&str; 8] = [
    "reds", "oranges", "yellows", "greens", "aquas", "blues", "purples", "magentas",
];

pub fn blend(out: &mut Value, baseline: &Value, selected: &AdjustmentFamilies, strength: f64) {
    if selected.curves {
        for channel in ["luma", "red", "green", "blue"] {
            let candidate = out["curves"][channel]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let base = baseline["curves"][channel]
                .as_array()
                .cloned()
                .unwrap_or_default();
            out["curves"][channel] = json!(blend_curve(&candidate, &base, strength));
        }
        out["pointCurves"] = out["curves"].clone();
    }
    for (active, keys) in [
        (selected.presence, &["clarity", "structure", "dehaze"][..]),
        (selected.color, &["vibrance", "saturation", "hue"][..]),
    ] {
        if active {
            for key in keys {
                blend_number(out, baseline, key, strength);
            }
        }
    }
    if selected.color_grading {
        blend_object(
            &mut out["colorGrading"],
            &baseline["colorGrading"],
            strength,
        );
    }
    if selected.color_mixer {
        blend_object(&mut out["hsl"], &baseline["hsl"], strength);
    }
}

pub fn make_curve(mut map: impl FnMut(f64) -> f64) -> Vec<Value> {
    let xs = [0., 32., 64., 128., 192., 224., 255.];
    let mut previous = -1.;
    xs.into_iter()
        .map(|x| {
            let y = if x == 0. || x == 255. {
                x
            } else {
                map(x).clamp(previous + 1., 254.)
            };
            previous = y;
            json!({"x": x, "y": y})
        })
        .collect()
}

pub fn identity_curves() -> Value {
    let line = json!([{"x":0,"y":0},{"x":255,"y":255}]);
    json!({"luma":line,"red":line,"green":line,"blue":line})
}

pub fn default_grading() -> Value {
    let wheel = json!({"hue":0,"saturation":0,"luminance":0});
    json!({"balance":0,"blending":50,"global":wheel,"highlights":wheel,"midtones":wheel,"shadows":wheel})
}

pub fn default_hsl() -> Value {
    Value::Object(
        HSL_NAMES
            .into_iter()
            .map(|name| {
                (
                    name.to_string(),
                    json!({"hue":0,"saturation":0,"luminance":0}),
                )
            })
            .collect(),
    )
}

fn blend_number(out: &mut Value, baseline: &Value, key: &str, strength: f64) {
    let old = baseline[key].as_f64().unwrap_or(0.);
    let next = out[key].as_f64().unwrap_or(0.);
    out[key] = json!(old + (next - old) * strength);
}

fn blend_object(out: &mut Value, baseline: &Value, strength: f64) {
    let Some(values) = out.as_object_mut() else {
        return;
    };
    for (key, value) in values {
        if value.is_object() {
            blend_object(value, &baseline[key], strength);
        } else if let Some(next) = value.as_f64() {
            let old = baseline[key]
                .as_f64()
                .unwrap_or_else(|| if key == "blending" { 50. } else { 0. });
            *value = json!(old + (next - old) * strength);
        }
    }
}

fn blend_curve(candidate: &[Value], baseline: &[Value], strength: f64) -> Vec<Value> {
    candidate
        .iter()
        .map(|point| {
            let x = point["x"].as_f64().unwrap_or(0.);
            let next = point["y"].as_f64().unwrap_or(x);
            let old = sample_curve(baseline, x);
            json!({"x":x,"y":old+(next-old)*strength})
        })
        .collect()
}

fn sample_curve(points: &[Value], x: f64) -> f64 {
    if points.len() < 2 {
        return x;
    }
    for pair in points.windows(2) {
        let x0 = pair[0]["x"].as_f64().unwrap_or(0.);
        let x1 = pair[1]["x"].as_f64().unwrap_or(255.);
        if x <= x1 {
            let y0 = pair[0]["y"].as_f64().unwrap_or(x0);
            let y1 = pair[1]["y"].as_f64().unwrap_or(x1);
            return y0 + (y1 - y0) * ((x - x0) / (x1 - x0).max(1e-6)).clamp(0., 1.);
        }
    }
    points
        .last()
        .and_then(|point| point["y"].as_f64())
        .unwrap_or(x)
}
