use serde_json::{Map, Value, json};
use std::collections::HashMap;
use uuid::Uuid;

use super::import::ProfileIndex;
use super::xmp::{Correction, CrsDoc, Curve, MaskDef, parse_number};
use crate::decode::white_balance::{MIRED_PER_RELATIVE_UNIT, TINT_PER_RELATIVE_UNIT};
use crate::library::presets::Preset;

pub const AUTO_TONE_KEY: &str = "presetAutoTone";

type Settings = HashMap<String, String>;

fn num(s: &Settings, key: &str) -> Option<f64> {
    parse_number(s.get(key)?)
}

fn round(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

fn is_true(s: &Settings, key: &str) -> Option<bool> {
    s.get(key)
        .map(|v| v.eq_ignore_ascii_case("true") || v == "1")
}

const COLORS: [(&str, &str); 8] = [
    ("Red", "reds"),
    ("Orange", "oranges"),
    ("Yellow", "yellows"),
    ("Green", "greens"),
    ("Aqua", "aquas"),
    ("Blue", "blues"),
    ("Purple", "purples"),
    ("Magenta", "magentas"),
];

fn identity_curve() -> Curve {
    vec![(0.0, 0.0), (255.0, 255.0)]
}

fn is_identity(curve: &Curve) -> bool {
    curve.iter().all(|(x, y)| (x - y).abs() < 0.5)
}

const MAX_CURVE_POINTS: usize = 16;

fn curve_json(curve: &Curve) -> Value {
    let resampled;
    let curve = if curve.len() > MAX_CURVE_POINTS {
        resampled = sample_curve(curve);
        &resampled
    } else {
        curve
    };
    Value::Array(
        curve
            .iter()
            .map(|(x, y)| json!({ "x": round(*x), "y": round(*y) }))
            .collect(),
    )
}

fn eval_curve(curve: &Curve, x: f64) -> f64 {
    let mut pts = curve.clone();
    pts.sort_by(|a, b| a.0.total_cmp(&b.0));
    pts.dedup_by(|a, b| (a.0 - b.0).abs() < 1e-9);
    let n = pts.len();
    if n == 0 {
        return x;
    }
    if n == 1 || x <= pts[0].0 {
        return pts[0].1;
    }
    if x >= pts[n - 1].0 {
        return pts[n - 1].1;
    }
    let d: Vec<f64> = pts
        .windows(2)
        .map(|w| (w[1].1 - w[0].1) / (w[1].0 - w[0].0))
        .collect();
    let mut m = vec![0.0; n];
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for i in 1..n - 1 {
        m[i] = if d[i - 1] * d[i] <= 0.0 {
            0.0
        } else {
            (d[i - 1] + d[i]) / 2.0
        };
    }
    for i in 0..n - 1 {
        if d[i] == 0.0 {
            m[i] = 0.0;
            m[i + 1] = 0.0;
        } else {
            let a = m[i] / d[i];
            let b = m[i + 1] / d[i];
            let s = a * a + b * b;
            if s > 9.0 {
                let t = 3.0 / s.sqrt();
                m[i] = t * a * d[i];
                m[i + 1] = t * b * d[i];
            }
        }
    }
    let i = pts.windows(2).position(|w| x < w[1].0).unwrap_or(n - 2);
    let (x0, y0) = pts[i];
    let (x1, y1) = pts[i + 1];
    let h = x1 - x0;
    let t = (x - x0) / h;
    let (t2, t3) = (t * t, t * t * t);
    (2.0 * t3 - 3.0 * t2 + 1.0) * y0
        + (t3 - 2.0 * t2 + t) * h * m[i]
        + (-2.0 * t3 + 3.0 * t2) * y1
        + (t3 - t2) * h * m[i + 1]
}

fn sample_points(f: impl Fn(f64) -> f64) -> Curve {
    let last = (MAX_CURVE_POINTS - 1) as f64;
    (0..MAX_CURVE_POINTS)
        .map(|i| {
            let x = (i as f64 * 255.0 / last).min(255.0);
            (x, f(x).clamp(0.0, 255.0))
        })
        .collect()
}

fn sample_curve(curve: &Curve) -> Curve {
    sample_points(|x| eval_curve(curve, x))
}

fn compose_curves(outer: &Curve, inner: &Curve) -> Curve {
    sample_points(|x| eval_curve(outer, eval_curve(inner, x)))
}

fn scale_curve(curve: &Curve, amount: f64) -> Curve {
    curve
        .iter()
        .map(|(x, y)| (*x, (x + (y - x) * amount).clamp(0.0, 255.0)))
        .collect()
}

#[derive(Clone, Copy)]
struct Parametric {
    shadows: f64,
    darks: f64,
    lights: f64,
    highlights: f64,
    split1: f64,
    split2: f64,
    split3: f64,
}

impl Parametric {
    fn from_settings(s: &Settings, look_shadows: f64) -> Option<Self> {
        let keys = [
            "ParametricShadows",
            "ParametricDarks",
            "ParametricLights",
            "ParametricHighlights",
        ];
        if look_shadows == 0.0 && !keys.iter().any(|k| s.contains_key(*k)) {
            return None;
        }
        let lift = |v: f64, scale: f64| if v > 0.0 { v * scale } else { v };
        let shadows = lift(
            num(s, "ParametricShadows").unwrap_or(0.0),
            PARAMETRIC_SHADOW_LIFT_SCALE,
        ) + lift(look_shadows, LOOK_SHADOW_LIFT_SCALE);
        Some(Self {
            shadows,
            darks: num(s, "ParametricDarks").unwrap_or(0.0),
            lights: num(s, "ParametricLights").unwrap_or(0.0),
            highlights: num(s, "ParametricHighlights").unwrap_or(0.0),
            split1: num(s, "ParametricShadowSplit").unwrap_or(25.0),
            split2: num(s, "ParametricMidtoneSplit").unwrap_or(50.0),
            split3: num(s, "ParametricHighlightSplit").unwrap_or(75.0),
        })
    }

    fn is_neutral(&self) -> bool {
        [self.shadows, self.darks, self.lights, self.highlights]
            .iter()
            .all(|v| v.abs() < 1e-6)
    }

    fn points(&self) -> Curve {
        let (s1, s2, s3) = (
            self.split1 / 100.0,
            self.split2 / 100.0,
            self.split3 / 100.0,
        );
        let x_h = (s3 + 1.0) / 2.0;
        let x_s = s1 / 2.0;
        let response = |v: f64, x: f64| {
            let headroom = if v >= 0.0 { 1.0 - x } else { x };
            (v * 1.2).tanh() * 0.35 * headroom.sqrt()
        };
        let (v_s, v_d, v_l, v_h) = (
            self.shadows / 100.0,
            self.darks / 100.0,
            self.lights / 100.0,
            self.highlights / 100.0,
        );
        let xs = [0.0, x_s, s1, s2, s3, x_h, 1.0];
        let ys = [
            0.0,
            x_s + response(v_s, x_s),
            s1 + (response(v_s, s1) + response(v_d, s1)) / 2.0,
            s2 + (response(v_d, s2) + response(v_l, s2)) / 2.0,
            s3 + (response(v_l, s3) + response(v_h, s3)) / 2.0,
            x_h + response(v_h, x_h),
            1.0,
        ];
        xs.iter()
            .zip(ys)
            .map(|(x, y)| (x * 255.0, y.clamp(0.0, 1.0) * 255.0))
            .collect()
    }

    fn json(&self) -> Value {
        json!({
            "darks": round(self.darks),
            "shadows": round(self.shadows),
            "highlights": round(self.highlights),
            "lights": round(self.lights),
            "whiteLevel": 0,
            "blackLevel": 0,
            "split1": round(self.split1),
            "split2": round(self.split2),
            "split3": round(self.split3),
        })
    }
}

fn default_parametric() -> Value {
    json!({
        "darks": 0, "shadows": 0, "highlights": 0, "lights": 0,
        "whiteLevel": 0, "blackLevel": 0, "split1": 25, "split2": 50, "split3": 75,
    })
}

fn default_curves_json() -> Value {
    let id = curve_json(&identity_curve());
    json!({ "luma": id, "red": id, "green": id, "blue": id })
}

fn point_curve(curves: &HashMap<String, Curve>, keys: &[&str]) -> Option<Curve> {
    keys.iter().find_map(|k| curves.get(*k).cloned())
}

fn apply_curves(
    s: &Settings,
    curves: &HashMap<String, Curve>,
    look_shadows: f64,
    adj: &mut Map<String, Value>,
) {
    let luma = point_curve(curves, &["ToneCurvePV2012", "ToneCurve"]);
    let red = point_curve(curves, &["ToneCurvePV2012Red", "ToneCurveRed"]);
    let green = point_curve(curves, &["ToneCurvePV2012Green", "ToneCurveGreen"]);
    let blue = point_curve(curves, &["ToneCurvePV2012Blue", "ToneCurveBlue"]);
    let parametric = Parametric::from_settings(s, look_shadows);

    if luma.is_none() && red.is_none() && green.is_none() && blue.is_none() && parametric.is_none()
    {
        return;
    }

    let point_luma = luma.unwrap_or_else(identity_curve);
    let channels = [
        ("red", red.unwrap_or_else(identity_curve)),
        ("green", green.unwrap_or_else(identity_curve)),
        ("blue", blue.unwrap_or_else(identity_curve)),
    ];

    let active_parametric = parametric.filter(|p| !p.is_neutral());
    let (render_luma, mode) = match active_parametric {
        Some(p) if is_identity(&point_luma) => (p.points(), "parametric"),
        Some(p) => (compose_curves(&point_luma, &p.points()), "point"),
        None => (point_luma.clone(), "point"),
    };

    let mut rendered = Map::new();
    let mut stored_points = Map::new();
    rendered.insert("luma".into(), curve_json(&render_luma));
    stored_points.insert(
        "luma".into(),
        curve_json(if mode == "parametric" {
            &point_luma
        } else {
            &render_luma
        }),
    );
    for (name, curve) in &channels {
        rendered.insert((*name).into(), curve_json(curve));
        stored_points.insert((*name).into(), curve_json(curve));
    }

    let mut parametric_json = default_parametric();
    let mut parametric_obj = Map::new();
    if mode == "parametric"
        && let Some(p) = active_parametric
    {
        parametric_json = p.json();
    }
    for ch in ["luma", "red", "green", "blue"] {
        parametric_obj.insert(
            ch.into(),
            if ch == "luma" {
                parametric_json.clone()
            } else {
                default_parametric()
            },
        );
    }

    adj.insert("curves".into(), Value::Object(rendered));
    adj.insert("pointCurves".into(), Value::Object(stored_points));
    adj.insert("parametricCurve".into(), Value::Object(parametric_obj));
    adj.insert("curveMode".into(), json!(mode));
}

const LOOK_ADDITIVE: [&str; 32] = [
    "Exposure2012",
    "Contrast2012",
    "Highlights2012",
    "Shadows2012",
    "Whites2012",
    "Blacks2012",
    "Clarity2012",
    "Dehaze",
    "Vibrance",
    "Saturation",
    "Texture",
    "ParametricShadows",
    "ParametricDarks",
    "ParametricLights",
    "ParametricHighlights",
    "ShadowTint",
    "RedHue",
    "RedSaturation",
    "GreenHue",
    "GreenSaturation",
    "BlueHue",
    "BlueSaturation",
    "SplitToningShadowSaturation",
    "SplitToningHighlightSaturation",
    "ColorGradeMidtoneSat",
    "ColorGradeGlobalSat",
    "ColorGradeShadowLum",
    "ColorGradeMidtoneLum",
    "ColorGradeHighlightLum",
    "ColorGradeGlobalLum",
    "PostCropVignetteAmount",
    "GrainAmount",
];

const LOOK_ADDITIVE_PREFIXES: [&str; 4] = [
    "HueAdjustment",
    "SaturationAdjustment",
    "LuminanceAdjustment",
    "GrayMixer",
];

const LOOK_COPY_IF_ABSENT: [&str; 11] = [
    "ParametricShadowSplit",
    "ParametricMidtoneSplit",
    "ParametricHighlightSplit",
    "ConvertToGrayscale",
    "GrainSize",
    "GrainFrequency",
    "PostCropVignetteMidpoint",
    "PostCropVignetteFeather",
    "PostCropVignetteRoundness",
    "ColorGradeBlending",
    "SplitToningBalance",
];

const LOOK_HUES: [(&str, &str); 4] = [
    ("SplitToningShadowHue", "SplitToningShadowSaturation"),
    ("SplitToningHighlightHue", "SplitToningHighlightSaturation"),
    ("ColorGradeMidtoneHue", "ColorGradeMidtoneSat"),
    ("ColorGradeGlobalHue", "ColorGradeGlobalSat"),
];

const CURVE_KEYS: [&str; 4] = [
    "ToneCurvePV2012",
    "ToneCurvePV2012Red",
    "ToneCurvePV2012Green",
    "ToneCurvePV2012Blue",
];

fn merge_look(
    settings: &mut Settings,
    curves: &mut HashMap<String, Curve>,
    profile: &CrsDoc,
    amount: f64,
) -> f64 {
    let original = settings.clone();
    let mut look_shadows = 0.0;
    for (hue_key, sat_key) in LOOK_HUES {
        let preset_sat = num(&original, sat_key).unwrap_or(0.0);
        if preset_sat.abs() < 1e-6
            && let Some(hue) = profile.get(hue_key)
        {
            settings.insert(hue_key.into(), hue.into());
        }
    }
    for (key, value) in &profile.settings {
        let additive = LOOK_ADDITIVE.contains(&key.as_str())
            || LOOK_ADDITIVE_PREFIXES.iter().any(|p| key.starts_with(p));
        if key == "ParametricShadows" {
            look_shadows = parse_number(value).map_or(0.0, |v| round(v * amount));
        } else if additive {
            if let Some(v) = parse_number(value) {
                let base = num(&original, key).unwrap_or(0.0);
                settings.insert(key.clone(), round(base + v * amount).to_string());
            }
        } else if LOOK_COPY_IF_ABSENT.contains(&key.as_str()) && !original.contains_key(key) {
            settings.insert(key.clone(), value.clone());
        }
    }
    for key in CURVE_KEYS {
        if let Some(profile_curve) = profile.curves.get(key) {
            let legacy = key.replace("PV2012", "");
            if !curves.contains_key(key)
                && let Some(old) = curves.remove(&legacy)
            {
                curves.insert(key.into(), old);
            }
            let scaled = scale_curve(profile_curve, amount);
            let merged = match curves.get(key) {
                Some(preset_curve) if !is_identity(preset_curve) => {
                    compose_curves(preset_curve, &scaled)
                }
                _ => scaled,
            };
            curves.insert(key.into(), merged);
        }
    }
    look_shadows
}

fn reset_lut(adj: &mut Map<String, Value>) {
    adj.insert("lutPath".into(), Value::Null);
    adj.insert("lutName".into(), Value::Null);
    adj.insert("lutData".into(), Value::Null);
    adj.insert("lutSize".into(), json!(0));
    adj.insert("lutIntensity".into(), json!(100));
    adj.insert("lutIsSceneReferred".into(), json!(false));
}

const EXPOSURE_SCALE: f64 = 0.75;
const PARAMETRIC_SHADOW_LIFT_SCALE: f64 = 0.2;
const LOOK_SHADOW_LIFT_SCALE: f64 = 1.0;
const CALIBRATION_SLIDERS: [(&str, &str, f64); 7] = [
    ("ShadowTint", "shadowsTint", 3.0),
    ("RedHue", "redHue", 0.25),
    ("RedSaturation", "redSaturation", 1.0),
    ("GreenHue", "greenHue", 0.1),
    ("GreenSaturation", "greenSaturation", 1.25),
    ("BlueHue", "blueHue", 0.1),
    ("BlueSaturation", "blueSaturation", 1.25),
];
const GRADING_BLACK_HOLD: f64 = 50.0;
const VIBRANCE_GAIN_SCALE: f64 = 0.5;
const MIDTONE_LUMINANCE_SCALE: f64 = 0.5;
const CALIBRATED_SLIDERS: [(&str, &str, f64); 8] = [
    ("Contrast2012", "contrast", 0.35),
    ("Highlights2012", "highlights", 1.25),
    ("Shadows2012", "shadows", 0.3),
    ("Whites2012", "whites", 1.0),
    ("Blacks2012", "blacks", 0.75),
    ("Clarity2012", "clarity", 1.0),
    ("Dehaze", "dehaze", 0.5),
    ("Texture", "structure", 0.5),
];

fn apply_vignette(s: &Settings, adj: &mut Map<String, Value>) {
    let Some(amount) = num(s, "PostCropVignetteAmount").map(|a| (a / 100.0).clamp(-1.0, 1.0))
    else {
        return;
    };
    let midpoint = num(s, "PostCropVignetteMidpoint").unwrap_or(50.0) / 100.0;
    let feather = num(s, "PostCropVignetteFeather").unwrap_or(50.0) / 100.0;
    let roundness = num(s, "PostCropVignetteRoundness").unwrap_or(0.0) / 100.0;

    let rr_amount = if amount < 0.0 {
        (1.0 + amount).powi(3) - 1.0
    } else {
        let (corner, gamma) = (0.05_f64, 2.2_f64);
        let g = corner.powf(1.0 / gamma);
        (((g + amount * (1.0 - g)).powf(gamma) - corner) / (1.0 - corner)).clamp(0.0, 1.0)
    };
    let rr_midpoint = 0.275 + 0.339 * midpoint - 0.158 * feather
        + 0.275 * (-roundness).max(0.0) * (1.0 - midpoint);
    let rr_feather = 0.183 + 0.269 * feather;
    let rr_roundness = 0.148 * roundness - 0.097;

    adj.insert("vignetteAmount".into(), json!(round(rr_amount * 100.0)));
    adj.insert(
        "vignetteMidpoint".into(),
        json!(round((rr_midpoint * 100.0).clamp(0.0, 100.0))),
    );
    adj.insert(
        "vignetteFeather".into(),
        json!(round((rr_feather * 100.0).clamp(0.0, 100.0))),
    );
    adj.insert(
        "vignetteRoundness".into(),
        json!(round((rr_roundness * 100.0).clamp(-100.0, 100.0))),
    );
}

fn apply_globals(
    s: &Settings,
    curves: &HashMap<String, Curve>,
    look_shadows: f64,
    adj: &mut Map<String, Value>,
) {
    for (xmp_key, rr_key, scale) in CALIBRATED_SLIDERS {
        if let Some(v) = num(s, xmp_key) {
            adj.insert(
                rr_key.into(),
                json!(round((v * scale).clamp(-100.0, 100.0))),
            );
        }
    }
    if let Some(v) = num(s, "Vibrance") {
        let scale = if v > 0.0 { VIBRANCE_GAIN_SCALE } else { 1.0 };
        adj.insert("vibrance".into(), json!(round(v * scale)));
    }
    if let Some(v) = num(s, "Exposure2012") {
        adj.insert("exposure".into(), json!(round(v * EXPOSURE_SCALE)));
    }

    let direct = [
        ("Saturation", "saturation"),
        ("LuminanceSmoothing", "lumaNoiseReduction"),
        ("ColorNoiseReduction", "colorNoiseReduction"),
        ("ChromaticAberrationRedCyan", "chromaticAberrationRedCyan"),
        (
            "ChromaticAberrationBlueYellow",
            "chromaticAberrationBlueYellow",
        ),
        ("GrainAmount", "grainAmount"),
        ("GrainSize", "grainSize"),
        ("GrainFrequency", "grainRoughness"),
    ];
    for (xmp_key, rr_key) in direct {
        if let Some(v) = num(s, xmp_key) {
            adj.insert(rr_key.into(), json!(round(v)));
        }
    }

    apply_vignette(s, adj);

    if let Some(v) = num(s, "Sharpness") {
        adj.insert(
            "sharpness".into(),
            json!(round((v / 150.0 * 100.0).clamp(0.0, 100.0))),
        );
    }

    if let Some(kelvin) = num(s, "Temperature") {
        let as_shot = num(s, "AsShotTemperature").unwrap_or(5500.0);
        let mired_delta = 1_000_000.0 / kelvin - 1_000_000.0 / as_shot;
        adj.insert(
            "temperature".into(),
            json!(round(
                (-mired_delta / MIRED_PER_RELATIVE_UNIT).clamp(-100.0, 100.0)
            )),
        );
    } else if s.get("WhiteBalance").is_some_and(|wb| wb == "As Shot") {
        adj.insert("temperature".into(), json!(0));
    }
    if let Some(tint) = num(s, "Tint") {
        adj.insert(
            "tint".into(),
            json!(round((tint / TINT_PER_RELATIVE_UNIT).clamp(-100.0, 100.0))),
        );
    } else if s.get("WhiteBalance").is_some_and(|wb| wb == "As Shot") {
        adj.insert("tint".into(), json!(0));
    }

    let has_hsl = COLORS.iter().any(|(src, _)| {
        [
            "HueAdjustment",
            "SaturationAdjustment",
            "LuminanceAdjustment",
        ]
        .iter()
        .any(|p| s.contains_key(&format!("{}{}", p, src)))
    });
    if has_hsl {
        let mut hsl = Map::new();
        for (src, dst) in COLORS {
            hsl.insert(
                dst.into(),
                json!({
                    "hue": round(num(s, &format!("HueAdjustment{}", src)).unwrap_or(0.0) * 0.75),
                    "saturation": round(num(s, &format!("SaturationAdjustment{}", src)).unwrap_or(0.0)),
                    "luminance": round(num(s, &format!("LuminanceAdjustment{}", src)).unwrap_or(0.0)),
                }),
            );
        }
        adj.insert("hsl".into(), Value::Object(hsl));
    }

    let grayscale = is_true(s, "ConvertToGrayscale").or_else(|| {
        s.get("CameraProfile")
            .map(|p| p.contains("Monochrome"))
            .filter(|m| *m)
    });
    if let Some(mono) = grayscale {
        adj.insert("monochromeEnabled".into(), json!(mono));
    }
    if grayscale == Some(true) {
        if COLORS
            .iter()
            .any(|(src, _)| s.contains_key(&format!("GrayMixer{}", src)))
        {
            let mut mix = Map::new();
            for (src, dst) in COLORS {
                let v = num(s, &format!("GrayMixer{}", src)).unwrap_or(0.0);
                mix.insert(dst.into(), json!(round(v.clamp(-100.0, 100.0))));
            }
            adj.insert("monochromeMix".into(), Value::Object(mix));
        }
        let toning_keys = [
            ("SplitToningShadowHue", "shadowHue"),
            ("SplitToningShadowSaturation", "shadowSaturation"),
            ("SplitToningHighlightHue", "highlightHue"),
            ("SplitToningHighlightSaturation", "highlightSaturation"),
            ("SplitToningBalance", "balance"),
        ];
        if toning_keys.iter().any(|(k, _)| s.contains_key(*k)) {
            let mut toning = Map::new();
            for (xmp_key, rr_key) in toning_keys {
                toning.insert(rr_key.into(), json!(round(num(s, xmp_key).unwrap_or(0.0))));
            }
            adj.insert("monochromeToning".into(), Value::Object(toning));
        }
    }

    let grading_keys = [
        ("SplitToningShadowHue", "shadows", "hue"),
        ("SplitToningShadowSaturation", "shadows", "saturation"),
        ("ColorGradeShadowLum", "shadows", "luminance"),
        ("ColorGradeMidtoneHue", "midtones", "hue"),
        ("ColorGradeMidtoneSat", "midtones", "saturation"),
        ("ColorGradeMidtoneLum", "midtones", "luminance"),
        ("SplitToningHighlightHue", "highlights", "hue"),
        ("SplitToningHighlightSaturation", "highlights", "saturation"),
        ("ColorGradeHighlightLum", "highlights", "luminance"),
        ("ColorGradeGlobalHue", "global", "hue"),
        ("ColorGradeGlobalSat", "global", "saturation"),
        ("ColorGradeGlobalLum", "global", "luminance"),
    ];
    let has_grading = grading_keys.iter().any(|(k, _, _)| s.contains_key(*k))
        || s.contains_key("ColorGradeBlending")
        || s.contains_key("SplitToningBalance");
    if has_grading {
        let mut grading = json!({
            "balance": round(num(s, "SplitToningBalance").unwrap_or(0.0)),
            "blending": round(num(s, "ColorGradeBlending").unwrap_or(50.0)),
            "blackHold": GRADING_BLACK_HOLD,
            "global": { "hue": 0, "saturation": 0, "luminance": 0 },
            "shadows": { "hue": 0, "saturation": 0, "luminance": 0 },
            "midtones": { "hue": 0, "saturation": 0, "luminance": 0 },
            "highlights": { "hue": 0, "saturation": 0, "luminance": 0 },
        });
        for (xmp_key, zone, field) in grading_keys {
            if let Some(v) = num(s, xmp_key) {
                let value = match field {
                    "hue" => v.rem_euclid(360.0),
                    "saturation" => v.clamp(0.0, 100.0),
                    _ if xmp_key == "ColorGradeMidtoneLum" => v * MIDTONE_LUMINANCE_SCALE,
                    _ => v,
                };
                grading[zone][field] = json!(round(value));
            }
        }
        adj.insert("colorGrading".into(), grading);
    }

    if CALIBRATION_SLIDERS
        .iter()
        .any(|(k, _, _)| s.contains_key(*k))
    {
        let mut cal = Map::new();
        for (xmp_key, rr_key, scale) in CALIBRATION_SLIDERS {
            let value = (num(s, xmp_key).unwrap_or(0.0) * scale).clamp(-100.0, 100.0);
            cal.insert(rr_key.into(), json!(round(value)));
        }
        adj.insert("colorCalibration".into(), Value::Object(cal));
    }

    apply_curves(s, curves, look_shadows, adj);

    if is_true(s, "AutoTone") == Some(true) {
        adj.insert(AUTO_TONE_KEY.into(), json!(true));
    }
}

fn apply_lens_blur(blur: &Settings, adj: &mut Map<String, Value>) {
    let active = is_true(blur, "Active").unwrap_or(true);
    adj.insert("lensBlurEnabled".into(), json!(active));
    if !active {
        return;
    }
    if let Some(amount) = num(blur, "BlurAmount") {
        adj.insert(
            "lensBlurAmount".into(),
            json!(round(amount.clamp(0.0, 100.0))),
        );
    }

    let shape = num(blur, "BokehShape").unwrap_or(0.0) as i32;
    let detail = num(blur, "BokehShapeDetail").unwrap_or(0.0) as i32;
    let spherical = num(blur, "SphericalAberration").unwrap_or(0.0);
    let rr_shape = if shape == 1 || (shape == 0 && detail == 0 && spherical >= 50.0) {
        "ring"
    } else if detail >= 1 {
        "hexagon"
    } else {
        "circle"
    };
    adj.insert("lensBlurShape".into(), json!(rr_shape));
    adj.insert("lensBlurDiffusion".into(), json!(0));

    let range: Vec<f64> = blur
        .get("FocalRange")
        .map(|r| r.split_whitespace().filter_map(parse_number).collect())
        .unwrap_or_default();
    let (min_depth, max_depth, min_fade, max_fade) = match range.as_slice() {
        [a, b, c, d] if !(*a == 0.0 && *b == 0.0 && *c == 100.0 && *d == 100.0) => {
            (100.0 - c, 100.0 - b, (d - c).max(1.0), (b - a).max(1.0))
        }
        _ => {
            adj.insert(
                crate::ai::lens_blur_focus::SUBJECT_FOCUS_KEY.into(),
                json!(true),
            );
            (50.0, 100.0, 12.0, 12.0)
        }
    };
    adj.insert("lensBlurMinDepth".into(), json!(round(min_depth)));
    adj.insert("lensBlurMaxDepth".into(), json!(round(max_depth)));
    adj.insert("lensBlurMinFade".into(), json!(round(min_fade)));
    adj.insert("lensBlurMaxFade".into(), json!(round(max_fade)));
}

fn default_mask_adjustments() -> Value {
    let zero = json!({ "hue": 0, "saturation": 0, "luminance": 0 });
    let parametric = default_parametric();
    json!({
        "activeTools": {},
        "blacks": 0,
        "brightness": 0,
        "clarity": 0,
        "colorGrading": {
            "balance": 0, "blackHold": 0, "blending": 50,
            "global": zero, "highlights": zero, "midtones": zero, "shadows": zero,
        },
        "colorNoiseReduction": 0,
        "contrast": 0,
        "curves": default_curves_json(),
        "pointCurves": default_curves_json(),
        "parametricCurve": { "luma": parametric, "red": parametric, "green": parametric, "blue": parametric },
        "curveMode": "point",
        "dehaze": 0,
        "exposure": 0,
        "flareAmount": 0,
        "glowAmount": 0,
        "halationAmount": 0,
        "highlights": 0,
        "hsl": {
            "aquas": zero, "blues": zero, "greens": zero, "magentas": zero,
            "oranges": zero, "purples": zero, "reds": zero, "yellows": zero,
        },
        "hue": 0,
        "lumaNoiseReduction": 0,
        "motionBlurAmount": 0,
        "motionBlurAngle": 0,
        "motionBlurDepth": 50,
        "motionBlurDepthEnabled": false,
        "motionBlurHighlights": 30,
        "motionBlurLayer": "auto",
        "motionBlurType": "linear",
        "saturation": 0,
        "shadows": 0,
        "sharpness": 0,
        "sharpnessThreshold": 15,
        "structure": 0,
        "temperature": 0,
        "tint": 0,
        "vibrance": 0,
        "whites": 0,
    })
}

fn mask_adjustments(correction: &Correction) -> Value {
    let p = &correction.props;
    let amount = num(p, "CorrectionAmount").unwrap_or(1.0);
    let mut adj = default_mask_adjustments();

    let local = [
        (
            "LocalExposure2012",
            "exposure",
            4.0 * EXPOSURE_SCALE,
            -5.0,
            5.0,
        ),
        ("LocalContrast2012", "contrast", 35.0, -100.0, 100.0),
        ("LocalHighlights2012", "highlights", 125.0, -100.0, 100.0),
        ("LocalShadows2012", "shadows", 30.0, -100.0, 100.0),
        ("LocalWhites2012", "whites", 100.0, -100.0, 100.0),
        ("LocalBlacks2012", "blacks", 75.0, -100.0, 100.0),
        ("LocalClarity2012", "clarity", 100.0, -100.0, 100.0),
        ("LocalDehaze", "dehaze", 50.0, -100.0, 100.0),
        ("LocalTexture", "structure", 50.0, -100.0, 100.0),
        ("LocalSaturation", "saturation", 100.0, -100.0, 100.0),
        ("LocalTemperature", "temperature", 100.0, -100.0, 100.0),
        ("LocalTint", "tint", 100.0, -100.0, 100.0),
        ("LocalSharpness", "sharpness", 100.0, -100.0, 100.0),
        (
            "LocalLuminanceNoise",
            "lumaNoiseReduction",
            100.0,
            0.0,
            100.0,
        ),
        ("LocalHue", "hue", 100.0, -100.0, 100.0),
    ];
    for (xmp_key, rr_key, scale, lo, hi) in local {
        if let Some(v) = num(p, xmp_key)
            && v != 0.0
        {
            adj[rr_key] = json!(round((v * scale * amount).clamp(lo, hi)));
        }
    }
    if adj["exposure"] == json!(0)
        && let Some(v) = num(p, "LocalExposure")
        && v != 0.0
    {
        adj["exposure"] = json!(round((v * EXPOSURE_SCALE * amount).clamp(-5.0, 5.0)));
    }

    if let Some(sat) = num(p, "LocalToningSaturation")
        && sat > 0.0
    {
        adj["colorGrading"]["global"] = json!({
            "hue": round(num(p, "LocalToningHue").unwrap_or(0.0).rem_euclid(360.0)),
            "saturation": round((sat * 100.0 * amount).clamp(0.0, 100.0)),
            "luminance": 0,
        });
    }

    let local_curves = [
        ("MainCurve", "luma"),
        ("RedCurve", "red"),
        ("GreenCurve", "green"),
        ("BlueCurve", "blue"),
    ];
    for (xmp_key, rr_key) in local_curves {
        if let Some(curve) = correction.curves.get(xmp_key)
            && !is_identity(curve)
        {
            let scaled = scale_curve(curve, amount);
            adj["curves"][rr_key] = curve_json(&scaled);
            adj["pointCurves"][rr_key] = curve_json(&scaled);
        }
    }
    adj
}

enum MaskTarget {
    Foreground { invert: bool },
    Sky,
    Face(&'static str),
    Text(&'static str),
}

fn mask_target(mask: &MaskDef) -> Option<MaskTarget> {
    let p = &mask.props;
    if p.get("What").map(String::as_str) != Some("Mask/Image") {
        return None;
    }
    let sub_type = num(p, "MaskSubType").map(|v| v as i64);
    let category = num(p, "MaskSubCategoryID").map(|v| v as i64);
    Some(match (sub_type, category) {
        (Some(1), _) => MaskTarget::Foreground { invert: false },
        (Some(2), _) => MaskTarget::Sky,
        (Some(0), Some(50006)) => MaskTarget::Sky,
        (Some(0), Some(50001)) => MaskTarget::Text("building"),
        (Some(0), Some(50002)) => MaskTarget::Text("mountain"),
        (Some(0), Some(50003)) => MaskTarget::Text("pavement"),
        (Some(0), Some(50004)) => MaskTarget::Text("ground"),
        (Some(0), Some(50005)) => MaskTarget::Text("vegetation"),
        (Some(0), Some(50007)) => MaskTarget::Text("water"),
        (Some(0), Some(50008)) => MaskTarget::Text("snow"),
        (Some(0), _) => MaskTarget::Foreground { invert: true },
        (Some(3), Some(2)) => MaskTarget::Face("faceSkin"),
        (Some(3), Some(3)) => MaskTarget::Face("iris"),
        (Some(3), Some(4)) => MaskTarget::Face("bodySkin"),
        (Some(3), Some(5)) => MaskTarget::Face("hair"),
        (Some(3), Some(6)) => MaskTarget::Face("lips"),
        (Some(3), Some(7)) => MaskTarget::Text("beard"),
        (Some(3), Some(8)) => MaskTarget::Face("eyeWhites"),
        (Some(3), Some(9)) => MaskTarget::Face("eyebrows"),
        (Some(3), Some(10)) => MaskTarget::Face("lips"),
        (Some(3), Some(11)) => MaskTarget::Text("clothes"),
        (Some(3), Some(12)) => MaskTarget::Face("teeth"),
        (Some(3), _) => MaskTarget::Text("person"),
        _ => return None,
    })
}

fn sub_mask(
    kind: &str,
    mode: &str,
    invert: bool,
    opacity: f64,
    visible: bool,
    mut parameters: Value,
) -> Value {
    parameters[crate::ai::jobs::QUIET_NO_RESULT_KEY] = json!(true);
    json!({
        "id": Uuid::new_v4().to_string(),
        "type": kind,
        "name": "",
        "mode": mode,
        "invert": invert,
        "opacity": round(opacity),
        "visible": visible,
        "parameters": parameters,
    })
}

fn build_sub_masks(correction: &Correction) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut skipped = false;
    for mask in &correction.masks {
        let p = &mask.props;
        let blend = num(p, "MaskBlendMode").unwrap_or(0.0) as i64;
        let Some(target) = mask_target(mask) else {
            if blend == 1 {
                return Vec::new();
            }
            skipped = true;
            continue;
        };
        if out.is_empty() && skipped && blend == 1 {
            return Vec::new();
        }
        let inverted = is_true(p, "MaskInverted").unwrap_or(false);
        let (mode, mut invert) = match (blend, inverted) {
            (1, true) => ("subtractive", false),
            (1, false) => ("intersect", false),
            (_, inv) => ("additive", inv),
        };
        let opacity = num(p, "MaskValue").unwrap_or(1.0) * 100.0;
        let visible = is_true(p, "MaskActive").unwrap_or(true);

        let value = match target {
            MaskTarget::Foreground { invert: inv } => {
                invert ^= inv;
                sub_mask(
                    "ai-foreground",
                    mode,
                    invert,
                    opacity,
                    visible,
                    json!({ "maskDataBase64": null, "grow": 0, "feather": 0 }),
                )
            }
            MaskTarget::Sky => sub_mask("ai-sky", mode, invert, opacity, visible, json!({})),
            MaskTarget::Text(prompt) => sub_mask(
                "ai-text",
                mode,
                invert,
                opacity,
                visible,
                json!({ "maskDataBase64": null, "prompt": prompt, "grow": 0, "feather": 0 }),
            ),
            MaskTarget::Face(part) => {
                if mode == "additive"
                    && !invert
                    && let Some(prev) = out.last_mut()
                    && prev["type"] == "ai-face"
                    && prev["mode"] == "additive"
                    && prev["invert"] == false
                    && let Some(parts) = prev["parameters"]["parts"].as_array_mut()
                {
                    if !parts.iter().any(|v| v == part) {
                        parts.push(json!(part));
                    }
                    continue;
                }
                sub_mask(
                    "ai-face",
                    mode,
                    invert,
                    opacity,
                    visible,
                    json!({ "maskDataBase64": null, "parts": [part], "grow": 0, "feather": 0 }),
                )
            }
        };
        out.push(value);
    }
    if let Some(first) = out.first_mut() {
        first["mode"] = json!("additive");
    }
    out
}

fn build_masks(doc: &CrsDoc) -> Vec<Value> {
    doc.corrections
        .iter()
        .filter(|c| c.props.get("What").is_none_or(|w| w == "Correction"))
        .filter_map(|correction| {
            let sub_masks = build_sub_masks(correction);
            if sub_masks.is_empty() {
                return None;
            }
            let name = correction
                .props
                .get("CorrectionName")
                .filter(|n| !n.is_empty())
                .cloned()
                .unwrap_or_else(|| "Mask".to_string());
            Some(json!({
                "id": Uuid::new_v4().to_string(),
                "name": name,
                "visible": is_true(&correction.props, "CorrectionActive").unwrap_or(true),
                "invert": false,
                "opacity": 100,
                "adjustments": mask_adjustments(correction),
                "subMasks": sub_masks,
            }))
        })
        .collect()
}

pub struct Conversion {
    pub preset: Preset,
    pub missing_profile: Option<String>,
}

pub fn convert(doc: &CrsDoc, profiles: Option<&ProfileIndex>) -> Conversion {
    let mut settings = doc.settings.clone();
    let mut curves = doc.curves.clone();
    let mut adjustments = Map::new();
    let mut missing_profile = None;
    let mut lut: Option<(String, String, f64)> = None;
    let mut look_shadows = 0.0;

    let named_look = doc.look.as_ref().filter(|l| {
        l.uuid.is_some()
            || l.parameters.is_some()
            || l.name.as_deref().is_some_and(|n| !n.is_empty())
    });
    if let Some(look) = named_look {
        let resolved = look
            .parameters
            .as_deref()
            .or_else(|| profiles.and_then(|p| p.find(look)));
        match resolved {
            Some(profile) => {
                look_shadows = merge_look(&mut settings, &mut curves, profile, look.amount);
                let baked = profiles.and_then(|index| {
                    index.lut_for(profile).or_else(|| {
                        look.parameters
                            .as_ref()
                            .and_then(|_| index.find(look))
                            .and_then(|installed| index.lut_for(installed))
                    })
                });
                if let Some((path, (min, max))) = baked {
                    let name = profile
                        .name
                        .clone()
                        .or_else(|| look.name.clone())
                        .unwrap_or_else(|| "Lightroom Profile".into());
                    let amount = if max > min {
                        look.amount.clamp(min, max)
                    } else {
                        look.amount
                    };
                    lut = Some((path, name, amount));
                }
            }
            None => missing_profile = look.name.clone(),
        }
    }

    apply_globals(&settings, &curves, look_shadows, &mut adjustments);

    if let Some((path, name, amount)) = lut {
        adjustments.insert("lutPath".into(), json!(path));
        adjustments.insert("lutName".into(), json!(name));
        adjustments.insert("lutData".into(), Value::Null);
        adjustments.insert("lutSize".into(), json!(super::import::LUT_SIZE));
        adjustments.insert("lutIntensity".into(), json!(round(amount * 100.0)));
        adjustments.insert("lutIsSceneReferred".into(), json!(false));
    } else if doc.look.is_some() || settings.contains_key("CameraProfile") {
        reset_lut(&mut adjustments);
    }

    if let Some(blur) = &doc.lens_blur {
        apply_lens_blur(blur, &mut adjustments);
    }

    let masks = build_masks(doc);
    let has_masks = !masks.is_empty();
    if has_masks {
        adjustments.insert("masks".into(), Value::Array(masks));
    }

    let name = doc
        .name
        .clone()
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Imported Preset".to_string());

    Conversion {
        preset: Preset {
            id: Uuid::new_v4().to_string(),
            name,
            adjustments: Value::Object(adjustments),
            include_masks: Some(has_masks),
            include_crop_transform: Some(false),
            preset_type: Some("style".to_string()),
        },
        missing_profile,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::xmp_presets::xmp::parse_crs;

    fn wrap(body: &str, attrs: &str) -> String {
        format!(
            r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" {attrs}>
<crs:Name><rdf:Alt><rdf:li xml:lang="x-default">Test</rdf:li></rdf:Alt></crs:Name>{body}</rdf:Description></rdf:RDF></x:xmpmeta>"#
        )
    }

    #[test]
    fn maps_basic_sliders() {
        let doc = parse_crs(&wrap(
            "",
            r#"crs:Exposure2012="+0.50" crs:Shadows2012="20" crs:Texture="-10""#,
        ))
        .unwrap();
        let adj = convert(&doc, None).preset.adjustments;
        assert_eq!(adj["exposure"], json!(0.375));
        assert_eq!(adj["shadows"], json!(6.0));
        assert_eq!(adj["structure"], json!(-5.0));
        assert!(adj.get("masks").is_none());
    }

    #[test]
    fn parametric_curve_becomes_parametric_mode() {
        let doc = parse_crs(&wrap(
            "<crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq></crs:ToneCurvePV2012>",
            r#"crs:ParametricDarks="-20" crs:ParametricShadowSplit="25" crs:ParametricMidtoneSplit="50" crs:ParametricHighlightSplit="75""#,
        ))
        .unwrap();
        let adj = convert(&doc, None).preset.adjustments;
        assert_eq!(adj["curveMode"], json!("parametric"));
        assert_eq!(adj["parametricCurve"]["luma"]["darks"], json!(-20.0));
        let mid = &adj["curves"]["luma"][3];
        assert!(mid["y"].as_f64().unwrap() < 127.5);
    }

    #[test]
    fn point_and_parametric_compose() {
        let doc = parse_crs(&wrap(
            "<crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 20</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq></crs:ToneCurvePV2012>",
            r#"crs:ParametricLights="30""#,
        ))
        .unwrap();
        let adj = convert(&doc, None).preset.adjustments;
        assert_eq!(adj["curveMode"], json!("point"));
        assert_eq!(
            adj["curves"]["luma"].as_array().unwrap().len(),
            MAX_CURVE_POINTS
        );
        assert_eq!(adj["curves"]["luma"][0]["y"], json!(20.0));
    }

    #[test]
    fn calibration_uses_fitted_scales() {
        let doc = parse_crs(&wrap(
            "",
            r#"crs:RedHue="+40" crs:BlueSaturation="-20" crs:ShadowTint="+50""#,
        ))
        .unwrap();
        let cal = &convert(&doc, None).preset.adjustments["colorCalibration"];
        assert_eq!(cal["redHue"], json!(10.0));
        assert_eq!(cal["blueSaturation"], json!(-25.0));
        assert_eq!(cal["shadowsTint"], json!(100.0));
        assert_eq!(cal["greenHue"], json!(0.0));
    }

    #[test]
    fn color_grading_keeps_lightroom_values() {
        let doc = parse_crs(&wrap(
            "",
            r#"crs:SplitToningShadowHue="218" crs:SplitToningShadowSaturation="100" crs:ColorGradeBlending="50""#,
        ))
        .unwrap();
        let grading = &convert(&doc, None).preset.adjustments["colorGrading"];
        assert_eq!(grading["shadows"]["hue"], json!(218.0));
        assert_eq!(grading["shadows"]["saturation"], json!(100.0));
        assert_eq!(grading["blackHold"], json!(GRADING_BLACK_HOLD));
    }

    #[test]
    fn subject_mask_becomes_foreground_mask() {
        let body = r#"<crs:MaskGroupBasedCorrections><rdf:Seq><rdf:li><rdf:Description crs:What="Correction" crs:CorrectionAmount="1" crs:CorrectionName="Pop" crs:LocalExposure2012="0.0825" crs:LocalTexture="0.1">
<crs:CorrectionMasks><rdf:Seq><rdf:li crs:What="Mask/Image" crs:MaskValue="1" crs:MaskSubType="1" crs:MaskInverted="false" crs:MaskBlendMode="0"/></rdf:Seq></crs:CorrectionMasks>
</rdf:Description></rdf:li></rdf:Seq></crs:MaskGroupBasedCorrections>"#;
        let conversion = convert(&parse_crs(&wrap(body, "")).unwrap(), None);
        assert_eq!(conversion.preset.include_masks, Some(true));
        let mask = &conversion.preset.adjustments["masks"][0];
        assert_eq!(mask["name"], json!("Pop"));
        assert_eq!(mask["adjustments"]["exposure"], json!(0.248));
        assert_eq!(mask["adjustments"]["structure"], json!(5.0));
        assert_eq!(mask["subMasks"][0]["type"], json!("ai-foreground"));
        assert_eq!(mask["subMasks"][0]["mode"], json!("additive"));
    }

    fn masks_of(masks: &str) -> Value {
        let body = format!(
            r#"<crs:MaskGroupBasedCorrections><rdf:Seq><rdf:li><rdf:Description crs:What="Correction" crs:CorrectionName="C" crs:LocalExposure2012="0.1">
<crs:CorrectionMasks><rdf:Seq>{}</rdf:Seq></crs:CorrectionMasks></rdf:Description></rdf:li></rdf:Seq></crs:MaskGroupBasedCorrections>"#,
            masks
        );
        convert(&parse_crs(&wrap(&body, "")).unwrap(), None)
            .preset
            .adjustments
    }

    #[test]
    fn unsupported_masks_never_flip_a_correction() {
        let gradient = r#"<rdf:li crs:What="Mask/Gradient" crs:MaskBlendMode="0"/>"#;
        let subtract_subject = r#"<rdf:li crs:What="Mask/Image" crs:MaskSubType="1" crs:MaskBlendMode="1" crs:MaskInverted="true"/>"#;
        let add_subject =
            r#"<rdf:li crs:What="Mask/Image" crs:MaskSubType="1" crs:MaskBlendMode="0"/>"#;
        let intersect_range = r#"<rdf:li crs:What="Mask/RangeMask" crs:MaskBlendMode="1"/>"#;
        assert!(
            masks_of(&format!("{gradient}{subtract_subject}"))
                .get("masks")
                .is_none()
        );
        assert!(
            masks_of(&format!("{add_subject}{intersect_range}"))
                .get("masks")
                .is_none()
        );
        let kept = masks_of(&format!("{gradient}{add_subject}"));
        assert_eq!(
            kept["masks"][0]["subMasks"][0]["type"],
            json!("ai-foreground")
        );
    }

    #[test]
    fn legacy_tone_curve_composes_with_look_curve() {
        let mut curves: HashMap<String, Curve> =
            [("ToneCurve".to_string(), vec![(0.0, 40.0), (255.0, 255.0)])].into();
        let profile = parse_crs(&wrap(
            "<crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>255, 230</rdf:li></rdf:Seq></crs:ToneCurvePV2012>",
            r#"crs:PresetType="Look""#,
        ))
        .unwrap();
        let mut settings = Settings::new();
        merge_look(&mut settings, &mut curves, &profile, 1.0);
        let merged = &curves["ToneCurvePV2012"];
        assert!(eval_curve(merged, 0.0) > 30.0, "{:?}", merged);
        assert!(eval_curve(merged, 255.0) < 240.0, "{:?}", merged);
    }

    #[test]
    fn people_parts_merge_into_one_face_mask() {
        let body = r#"<crs:MaskGroupBasedCorrections><rdf:Seq><rdf:li><rdf:Description crs:What="Correction" crs:CorrectionName="Eyes" crs:LocalExposure2012="0.1">
<crs:CorrectionMasks><rdf:Seq>
<rdf:li crs:What="Mask/Image" crs:MaskSubType="3" crs:MaskSubCategoryID="3" crs:MaskBlendMode="0"/>
<rdf:li crs:What="Mask/Image" crs:MaskSubType="3" crs:MaskSubCategoryID="8" crs:MaskBlendMode="0"/>
</rdf:Seq></crs:CorrectionMasks></rdf:Description></rdf:li></rdf:Seq></crs:MaskGroupBasedCorrections>"#;
        let adj = convert(&parse_crs(&wrap(body, "")).unwrap(), None)
            .preset
            .adjustments;
        let subs = adj["masks"][0]["subMasks"].as_array().unwrap();
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0]["type"], json!("ai-face"));
        assert_eq!(subs[0]["parameters"]["parts"], json!(["iris", "eyeWhites"]));
    }

    #[test]
    fn lens_blur_maps_shapes() {
        let body = r#"<crs:LensBlur crs:Active="true" crs:FocalRange="0 0 100 100" crs:BlurAmount="70" crs:BokehShape="1" crs:BokehShapeDetail="3"/>"#;
        let adj = convert(&parse_crs(&wrap(body, "")).unwrap(), None)
            .preset
            .adjustments;
        assert_eq!(adj["lensBlurEnabled"], json!(true));
        assert_eq!(adj["lensBlurAmount"], json!(70.0));
        assert_eq!(adj["lensBlurShape"], json!("ring"));
    }

    #[test]
    fn look_settings_fold_into_sliders() {
        let profile = parse_crs(&wrap(
            "",
            r#"crs:PresetType="Look" crs:Contrast2012="+15" crs:ParametricDarks="-10""#,
        ))
        .unwrap();
        let mut settings: Settings = [("Contrast2012".to_string(), "10".to_string())].into();
        let mut curves = HashMap::new();
        merge_look(&mut settings, &mut curves, &profile, 2.0);
        assert_eq!(num(&settings, "Contrast2012"), Some(40.0));
        assert_eq!(num(&settings, "ParametricDarks"), Some(-20.0));
    }

    #[test]
    fn look_shadow_lift_keeps_full_strength() {
        let profile = parse_crs(&wrap(
            "",
            r#"crs:PresetType="Look" crs:ParametricShadows="+20""#,
        ))
        .unwrap();
        let mut settings: Settings = [("ParametricShadows".to_string(), "50".to_string())].into();
        let mut curves = HashMap::new();
        let look_shadows = merge_look(&mut settings, &mut curves, &profile, 1.0);
        let p = Parametric::from_settings(&settings, look_shadows).unwrap();
        assert!((p.shadows - 30.0).abs() < 1e-6, "{}", p.shadows);
    }

    #[test]
    fn empty_look_clears_lut() {
        let conversion = convert(
            &parse_crs(&wrap(r#"<crs:Look crs:Name=""/>"#, "")).unwrap(),
            None,
        );
        assert!(conversion.missing_profile.is_none());
        assert_eq!(conversion.preset.adjustments["lutPath"], Value::Null);
    }

    #[test]
    fn auto_tone_is_flagged() {
        let adj = convert(
            &parse_crs(&wrap("", r#"crs:AutoTone="True""#)).unwrap(),
            None,
        )
        .preset
        .adjustments;
        assert_eq!(adj[AUTO_TONE_KEY], json!(true));
    }
}
