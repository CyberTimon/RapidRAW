use super::{analysis::default_target, types::*};
use serde_json::{Value, json};

pub fn neutral(baseline: &Value) -> Value {
    let mut result = if baseline.is_object() { baseline.clone() } else { json!({}) };
    result.as_object_mut().unwrap().remove("autoProvenance");
    for key in KEYS {
        result[*key] = json!(0);
    }
    result["masks"] = json!(
        baseline["masks"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|m| m.get("autoOwner").is_none())
            .cloned()
            .collect::<Vec<_>>()
    );
    result["sectionVisibility"]["basic"] = json!(true);
    result["sectionVisibility"]["color"] = json!(true);
    result
}
pub fn recovery_limited(a: &Analysis) -> bool {
    a.iso.unwrap_or(0) >= 6400 && a.subject < 0.15
}
pub fn brightness_limit(a: &Analysis, scene: Scene) -> f64 {
    if scene == Scene::Mixed {
        0.8
    } else if recovery_limited(a) {
        1.2
    } else {
        3.8 * (1. - 0.3 * a.noise)
    }
}
pub fn target(a: &Analysis, g: &Group, c: &Controls, scene: Scene) -> f64 {
    let base = default_target(scene, !a.faces.is_empty());
    let group_weight = if g.paths.len() > 1 { c.consistency } else { 0. };
    ((base * (1. - group_weight) + g.target * group_weight) * 2f64.powf(c.subject_brightness * 0.5))
        .clamp(0.12, 0.7)
}
pub fn propose(a: &Analysis, g: &Group, c: &Controls, scene: Scene, baseline: &Value) -> Value {
    let mut out = neutral(baseline);
    let desired = target(a, g, c, scene);
    // Convert the display-referred ratio to an approximate linear EV starting point.
    // The renderer feedback loop below evaluates/corrects this initial estimate.
    let ev = (desired / a.subject.max(0.025)).log2() * 1.8;
    let cap = if scene == Scene::Mixed || a.subject < 0.025 || recovery_limited(a) {
        0.4
    } else if a.reduced || scene == Scene::Uncertain {
        0.8
    } else if scene == Scene::Night {
        1.0
    } else {
        2.2
    };
    let exposure = ev.clamp(-1.5, cap * (1. - 0.5 * a.noise));
    let exposure = if a.p90 > 0.82 { exposure.min(0.3) } else { exposure };
    out["exposure"] = json!(if !a.faces.is_empty() && !a.reduced && a.subject >= 0.025 {
        exposure.min(0.8)
    } else {
        exposure
    });
    if !a.faces.is_empty() && !a.reduced && a.subject >= 0.025 {
        // Midtone recovery retains more highlight headroom than linear exposure alone.
        out["brightness"] = json!(
            (desired / a.subject.max(0.025))
                .log2()
                .clamp(0., brightness_limit(a, scene).min(3.2 * (1. - 0.3 * a.noise)))
        );
    }
    out["shadows"] =
        json!(((desired - a.subject).max(0.) * 32. * (1. - a.noise)).min(if scene == Scene::Night {
            10.
        } else {
            16.
        }));
    let midtones = out["brightness"].as_f64().unwrap_or(0.);
    if midtones > 1.0 {
        // Keep strong midtone recovery from lifting the black floor and exposing noisy shadows.
        out["shadows"] = json!(-(midtones * 7. * (1. + a.noise)).min(28.));
        out["blacks"] = json!(-(midtones * 8.).min(28.));
        out["contrast"] = json!((midtones * 6.).min(20.));
    }
    out["highlights"] = json!(-((a.p99 - 0.65).max(0.) * 220. + a.clipped * 500.).min(80.));
    // Preserve atmosphere: warm light is only partly neutralized; colored light is left intact.
    let atmosphere = match scene {
        Scene::Mixed => 0.,
        Scene::Night => 0.2,
        Scene::WarmIndoor => 0.3,
        Scene::Uncertain => 0.25,
        _ => 0.65,
    };
    let shared = if g.paths.len() > 1 { c.consistency * a.neutral_confidence } else { 0. };
    let cast = a.warmth * atmosphere + (a.warmth - g.warmth) * shared * (1. - atmosphere);
    // Shader temperature is divided by 25 and then applies +/- 0.2 RGB gains.
    out["temperature"] = json!((-cast * 125. * a.neutral_confidence + c.warmth * 12.).clamp(-30., 30.));
    out["tint"] = json!(
        (a.tint * 80. * a.neutral_confidence * atmosphere + (a.tint - g.tint) * shared * 30.)
            .clamp(-20., 20.)
    );
    out
}
pub fn blend(mut candidate: Value, baseline: &Value, strength: f64) -> Value {
    if strength == 0. {
        return baseline.clone();
    }
    for k in KEYS {
        let old = baseline[*k].as_f64().unwrap_or(0.);
        let value = candidate[*k].as_f64().unwrap_or(0.);
        let limit = if *k == "exposure" || *k == "brightness" { 5.0 } else { 100.0 };
        candidate[*k] = json!((old + (value - old) * strength).clamp(-limit, limit));
    }
    if let Some(masks) = candidate["masks"].as_array_mut() {
        for m in masks {
            if m.get("autoOwner").is_some() {
                m["opacity"] = json!((100. * strength).min(100.));
            }
        }
    }
    candidate
}

/// Feathered face recovery uses the editable radial-mask primitive. Restrict it to
/// high-confidence, sufficiently large detections to avoid small bright halos.
pub fn add_subject_masks(
    out: &mut Value,
    a: &Analysis,
    target: f64,
    canvas: (f64, f64),
    offset: (f64, f64),
    batch: &str,
) {
    if a.reduced || a.iso.unwrap_or(0) >= 6400 || a.noise > 0.65 || a.p99 < 0.75 || a.subject >= target * 0.92
    {
        return;
    }
    let mut masks = out["masks"].as_array().cloned().unwrap_or_default();
    for f in
        a.faces.iter().filter(|f| f.confidence >= 0.9 && f.bounds[2] >= 0.025 && f.bounds[3] >= 0.025).take(8)
    {
        if f.luma >= 0.7 || f.luma < 0.025 {
            continue;
        }
        if masks.len() >= crate::image_processing::MAX_MASKS {
            break;
        }
        let [x, y, w, h] = f.bounds.map(f64::from);
        // A shared gain preserves relative face brightness instead of equalizing skin tones.
        let ev = ((target / a.subject.max(0.025)).log2() * 1.5).clamp(0., 0.7) * (1. - a.noise);
        let id = uuid::Uuid::new_v4().to_string();
        masks.push(json!({"id":id,"name":"Auto subject","autoOwner":batch,"visible":true,"invert":false,"opacity":100,
            "adjustments":{"exposure":ev,"shadows":8.0*(1.-a.noise)},
            "subMasks":[{"id":uuid::Uuid::new_v4().to_string(),"name":"Auto subject","type":"radial","mode":"additive","visible":true,"invert":false,"opacity":100,
                "parameters":{"centerX":offset.0+(x+w/2.)*canvas.0,"centerY":offset.1+(y+h/2.)*canvas.1,"radiusX":w*canvas.0*0.8,"radiusY":h*canvas.1*0.8,"rotation":0,"feather":0.75}}]}));
    }
    out["masks"] = json!(masks);
}
