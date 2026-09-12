use super::{
    types::{AdjustmentFamilies, Analysis, Scene},
    value_ops::{default_grading, default_hsl, identity_curves, make_curve},
};
use serde_json::{Value, json};

const HSL_NAMES: [&str; 8] = [
    "reds", "oranges", "yellows", "greens", "aquas", "blues", "purples", "magentas",
];

#[derive(Clone, Copy)]
pub enum Family {
    Curves,
    Presence,
    Color,
    ColorGrading,
    ColorMixer,
}

pub fn enabled(family: Family, selected: &AdjustmentFamilies) -> bool {
    match family {
        Family::Curves => selected.curves,
        Family::Presence => selected.presence,
        Family::Color => selected.color,
        Family::ColorGrading => selected.color_grading,
        Family::ColorMixer => selected.color_mixer,
    }
}

pub fn reset(out: &mut Value, selected: &AdjustmentFamilies) {
    if selected.curves {
        let curves = identity_curves();
        out["curves"] = curves.clone();
        out["pointCurves"] = curves;
        out["curveMode"] = json!("point");
        out["sectionVisibility"]["curves"] = json!(true);
    }
    if selected.presence {
        for key in ["clarity", "structure", "dehaze"] {
            out[key] = json!(0);
        }
        out["sectionVisibility"]["details"] = json!(true);
    }
    if selected.color {
        for key in ["vibrance", "saturation", "hue"] {
            out[key] = json!(0);
        }
        out["sectionVisibility"]["color"] = json!(true);
    }
    if selected.color_grading {
        out["colorGrading"] = default_grading();
        out["sectionVisibility"]["color"] = json!(true);
    }
    if selected.color_mixer {
        out["hsl"] = default_hsl();
        out["sectionVisibility"]["color"] = json!(true);
    }
}

pub fn apply(out: &mut Value, family: Family, a: &Analysis, scene: Scene) {
    match family {
        Family::Curves => apply_curves(out, a),
        Family::Presence => {
            let noise_guard = 1. - a.noise * 0.8;
            out["clarity"] =
                json!(((0.075 - a.local_contrast) * 260. * noise_guard).clamp(-8., 18.));
            out["structure"] =
                json!(((0.05 - a.local_contrast) * 210. * noise_guard).clamp(-6., 12.));
            out["dehaze"] =
                json!(((0.52 - (a.p90 - a.p10)) * 34. * (1. - a.saturation)).clamp(-6., 15.));
        }
        Family::Color => {
            let target = match scene {
                Scene::Night | Scene::Mixed => 0.28,
                _ => 0.34,
            };
            out["vibrance"] = json!(((target - a.saturation) * 85.).clamp(-10., 22.));
            out["saturation"] = json!(((target - a.saturation) * 32.).clamp(-8., 10.));
            out["hue"] = json!(if a.hue_confidence > 0.75 && a.hue_offset.abs() > 4. {
                (-a.hue_offset * 0.25).clamp(-8., 8.)
            } else {
                0.
            });
        }
        Family::ColorGrading => apply_grading(out, a),
        Family::ColorMixer => apply_mixer(out, a, scene),
    }
}

pub fn restore(out: &mut Value, baseline: &Value, family: Family) {
    let keys: &[&str] = match family {
        Family::Curves => &["curves", "pointCurves", "parametricCurve", "curveMode"],
        Family::Presence => &["clarity", "structure", "dehaze"],
        Family::Color => &["vibrance", "saturation", "hue"],
        Family::ColorGrading => &["colorGrading"],
        Family::ColorMixer => &["hsl"],
    };
    for key in keys {
        if let Some(value) = baseline.get(*key) {
            out[*key] = value.clone();
        } else if let Some(values) = out.as_object_mut() {
            values.remove(*key);
        }
    }
}

pub fn blend(out: &mut Value, baseline: &Value, selected: &AdjustmentFamilies, strength: f64) {
    super::value_ops::blend(out, baseline, selected, strength);
}

fn apply_curves(out: &mut Value, a: &Analysis) {
    let range = a.p90 - a.p10;
    let contrast = ((0.52 - range) * 0.16).clamp(-0.025, 0.055);
    let middle = ((0.48 - a.median) * 0.08).clamp(-0.025, 0.025);
    let mut curves = identity_curves();
    curves["luma"] = json!(make_curve(|x| {
        let t = x / 255.;
        x + 255. * (contrast * (2. * t - 1.) * 4. * t * (1. - t) + middle * 4. * t * (1. - t))
    }));
    for (channel, channel_index) in [("red", 0), ("green", 1), ("blue", 2)] {
        curves[channel] = json!(make_curve(|x| {
            let tone = if x < 85. {
                0
            } else if x < 171. {
                1
            } else {
                2
            };
            let sample = a.tonal_color.get(tone);
            let offset =
                sample
                    .filter(|s| s.confidence > 0.65)
                    .map_or(0., |s| match channel_index {
                        0 => -s.warmth * 7.,
                        1 => -s.tint * 8.,
                        _ => s.warmth * 7.,
                    });
            x + offset.clamp(-4., 4.) * 4. * (x / 255.) * (1. - x / 255.)
        }));
    }
    out["curves"] = curves.clone();
    out["pointCurves"] = curves;
    out["curveMode"] = json!("point");
}

fn apply_grading(out: &mut Value, a: &Analysis) {
    let mut grading = default_grading();
    for (index, name) in ["shadows", "midtones", "highlights"].iter().enumerate() {
        if let Some(sample) = a
            .tonal_color
            .get(index)
            .filter(|sample| sample.confidence > 0.55)
        {
            let magnitude = sample.warmth.hypot(sample.tint);
            grading[*name] = json!({
                "hue": (-sample.tint).atan2(-sample.warmth).to_degrees().rem_euclid(360.),
                "saturation": (magnitude * 65.).clamp(0., 12.),
                "luminance": 0
            });
        }
    }
    grading["blending"] = json!((48. + a.color_variance * 10.).clamp(45., 65.));
    grading["balance"] = json!(((a.median - 0.5) * 40.).clamp(-20., 20.));
    out["colorGrading"] = grading;
}

fn apply_mixer(out: &mut Value, a: &Analysis, scene: Scene) {
    let mut hsl = default_hsl();
    let target_sat = if matches!(scene, Scene::Night | Scene::Mixed) {
        0.3
    } else {
        0.38
    };
    for (index, name) in HSL_NAMES.iter().enumerate() {
        let Some(bin) = a
            .hue_bins
            .get(index)
            .filter(|bin| bin.confidence > 0.45 && bin.coverage > 0.01)
        else {
            continue;
        };
        let protection = if index < 2 { 0.45 } else { 1. };
        hsl[*name] = json!({
            "hue": (-bin.hue * 0.35 * protection).clamp(-8., 8.),
            "saturation": ((target_sat - bin.saturation) * 35. * protection).clamp(-12., 12.),
            "luminance": ((0.5 - bin.luminance) * 12. * protection).clamp(-8., 8.)
        });
    }
    out["hsl"] = hsl;
}
