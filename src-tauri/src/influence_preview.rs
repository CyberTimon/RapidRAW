//! Editor-only diagnostics. Recipes and export requests never contain these options.
use crate::{AppState, LoadedImage, PreviewTask};
use image::{DynamicImage, GrayImage, ImageEncoder};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tauri::{Manager, ipc::Response};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Scope {
    Global,
    Mask {
        #[serde(rename = "containerId")]
        container_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Target {
    Parameter {
        control: String,
    },
    Scalar {
        control: String,
        scope: Scope,
    },
    Hsl {
        band: String,
        component: String,
        scope: Scope,
    },
    Grading {
        range: String,
        scope: Scope,
    },
    Parametric {
        channel: String,
        parameter: String,
        scope: Scope,
    },
    CurvePoint {
        channel: String,
        index: usize,
        scope: Scope,
    },
    Effect {
        effect: String,
    },
    Light {
        #[serde(rename = "lightId")]
        light_id: String,
    },
    MonochromeMix {
        band: String,
    },
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InfluenceRequest {
    pub image_path: String,
    pub loaded_image_generation: usize,
    pub client_generation: u64,
    pub identity: Value,
    pub target: Target,
    pub target_resolution: u32,
    pub js_adjustments: Value,
    #[serde(default)]
    pub presentation: u32,
    #[serde(default)]
    pub selected_control: Option<String>,
    #[serde(default)]
    pub baseline_curve: Option<Value>,
    #[serde(default)]
    pub coverage_curve: Option<Value>,
}

pub struct InfluenceJob {
    request: InfluenceRequest,
    responder: tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>,
}

fn release_resources(state: &AppState) {
    if let Ok(mut stages) = state.influence_stages.try_lock() {
        *stages = Stages::default();
    }
    if let Ok(mut gpu) = state.influence_gpu.try_lock() {
        *gpu = None;
    }
}

#[tauri::command]
pub async fn request_influence_preview(
    request: InfluenceRequest,
    state: tauri::State<'_, AppState>,
) -> Result<Response, String> {
    if request.target_resolution == 0
        || request.target_resolution > 4096
        || request.client_generation > 9_007_199_254_740_991
    {
        return Err("Invalid influence request limits".into());
    }
    if let Some(curve) = request.coverage_curve.as_ref() {
        validate_curve(curve)?;
    }
    let previous = state
        .influence_generation
        .fetch_max(request.client_generation, Ordering::SeqCst);
    if request.presentation > 3 {
        return Err("Invalid diagnostic presentation".into());
    }
    if request.client_generation <= previous {
        return Err("Superseded influence request".into());
    }
    state.influence_release.store(false, Ordering::SeqCst);
    let (tx, rx) = tokio::sync::oneshot::channel();
    state
        .preview_worker_tx
        .lock()
        .map_err(|_| "Preview worker unavailable")?
        .as_ref()
        .ok_or("Preview worker unavailable")?
        .send(PreviewTask::Influence(InfluenceJob {
            request,
            responder: tx,
        }))
        .map_err(|_| "Preview worker unavailable")?;
    rx.await
        .map_err(|_| "Superseded influence request".to_string())?
        .map(Response::new)
}

#[tauri::command]
pub fn cancel_influence_preview(
    generation: u64,
    release: Option<bool>,
    state: tauri::State<'_, AppState>,
) {
    state
        .influence_generation
        .fetch_max(generation, Ordering::SeqCst);
    if release == Some(true) {
        state.influence_release.store(true, Ordering::SeqCst);
        release_resources(&state);
    }
}

pub fn run_job(app: &tauri::AppHandle, job: InfluenceJob) {
    let result =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| process(app, &job.request)))
            .unwrap_or_else(|_| Err("Influence renderer failed".into()));
    if result.is_err()
        || app
            .state::<AppState>()
            .influence_release
            .load(Ordering::SeqCst)
    {
        release_resources(&app.state::<AppState>());
    }
    let _ = job.responder.send(result);
}

fn current(state: &AppState, request: &InfluenceRequest) -> Result<(), String> {
    if state.influence_generation.load(Ordering::SeqCst) != request.client_generation
        || state.load_image_generation.load(Ordering::SeqCst) != request.loaded_image_generation
    {
        return Err("Superseded influence request".into());
    }
    Ok(())
}

fn scoped<'a>(recipe: &'a mut Value, scope: &Scope) -> Result<&'a mut Value, String> {
    match scope {
        Scope::Global => Ok(recipe),
        Scope::Mask { container_id } => recipe["masks"]
            .as_array_mut()
            .and_then(|masks| {
                masks
                    .iter_mut()
                    .find(|mask| mask["id"].as_str() == Some(container_id))
            })
            .map(|mask| &mut mask["adjustments"])
            .ok_or("Mask no longer exists".into()),
    }
}

const SCALARS: &[&str] = &[
    "exposure",
    "brightness",
    "contrast",
    "highlights",
    "shadows",
    "whites",
    "blacks",
    "temperature",
    "tint",
    "saturation",
    "vibrance",
    "hue",
    "clarity",
    "structure",
    "dehaze",
    "sharpness",
    "glowAmount",
    "halationAmount",
    "flareAmount",
];
const RELIGHT_PARAMETERS: &[&str] = &[
    "relightAmbient",
    "relightSoftness",
    "relightShine",
    "relightShadowSoftness",
];
const BANDS: &[&str] = &[
    "reds", "oranges", "yellows", "greens", "aquas", "blues", "purples", "magentas",
];

fn validate_availability(recipe: &Value, target: &Target) -> Result<(), String> {
    if recipe["monochromeEnabled"].as_bool().unwrap_or(false)
        && matches!(target,
        Target::Hsl { component, .. } if component != "luminance")
    {
        return Err("Hue and saturation are bypassed in monochrome mode".into());
    }
    let scalar_tool = |control: &str| match control {
        "exposure" | "brightness" | "contrast" | "highlights" | "shadows" | "whites" | "blacks" => {
            "basic"
        }
        "temperature" | "tint" => "whiteBalance",
        "saturation" | "vibrance" => "colorPresence",
        "hue" => "hue",
        "clarity" | "structure" | "dehaze" => "presence",
        "sharpness" => "sharpening",
        _ => "creative",
    };
    let (scope, tool) = match target {
        Target::Scalar { scope, control } => (Some(scope), scalar_tool(control)),
        Target::Hsl { scope, .. } => (Some(scope), "colorMixer"),
        Target::Grading { scope, .. } => (Some(scope), "colorGrading"),
        Target::Parametric { scope, .. } | Target::CurvePoint { scope, .. } => {
            (Some(scope), "curves")
        }
        Target::Parameter { control } if RELIGHT_PARAMETERS.contains(&control.as_str()) => {
            (None, "relight")
        }
        Target::Parameter { .. } => return Err("Unsupported parameter".into()),
        Target::Effect { effect } => (
            None,
            match effect.as_str() {
                "centre" => "presence",
                "vignette" => "vignette",
                "fog" => "fog",
                "lensBlur" => "lensBlur",
                _ => return Err("Unsupported effect".into()),
            },
        ),
        Target::MonochromeMix { .. } => (None, "colorPresence"),
        Target::Light { .. } => (None, "relight"),
    };
    let source = if let Some(Scope::Mask { container_id }) = scope {
        let mask = recipe["masks"]
            .as_array()
            .and_then(|m| {
                m.iter()
                    .filter(|m| {
                        m["visible"].as_bool() == Some(true)
                            && m["subMasks"].as_array().is_some_and(|s| !s.is_empty())
                    })
                    .take(crate::image_processing::MAX_MASKS)
                    .find(|m| m["id"].as_str() == Some(container_id))
            })
            .ok_or("Mask is disabled or outside the rendered mask limit")?;
        &mask["adjustments"]
    } else {
        recipe
    };
    if !crate::image_processing::is_tool_active(source, tool) {
        return Err("Effect is disabled".into());
    }
    let parent = match target {
        Target::Parameter { control } if RELIGHT_PARAMETERS.contains(&control.as_str()) => {
            Some("relight")
        }
        Target::MonochromeMix { .. } => Some("monochrome"),
        _ => None,
    };
    if parent.is_some_and(|p| !recipe[format!("{p}Enabled")].as_bool().unwrap_or(false)) {
        return Err("Effect is disabled".into());
    }
    if let Target::Effect { effect } = target
        && ["lensBlur", "fog"].contains(&effect.as_str())
        && !recipe[format!("{effect}Enabled")]
            .as_bool()
            .unwrap_or(false)
    {
        return Err("Effect is disabled".into());
    }
    if let Target::Light { .. } = target
        && !recipe["relightEnabled"].as_bool().unwrap_or(false)
    {
        return Err("Effect is disabled".into());
    }
    Ok(())
}

fn validate_curve(curve: &Value) -> Result<(), String> {
    let points = curve.as_array().ok_or("Missing curve points")?;
    if points.len() < 2
        || points.len() > 16
        || points.iter().any(|p| {
            ["x", "y"].iter().any(|key| {
                p[*key]
                    .as_f64()
                    .is_none_or(|v| !v.is_finite() || !(0.0..=255.0).contains(&v))
            })
        })
        || points
            .windows(2)
            .any(|p| p[0]["x"].as_f64() >= p[1]["x"].as_f64())
    {
        return Err("Invalid diagnostic curve".into());
    }
    Ok(())
}

fn neutralize(
    recipe: &Value,
    target: &Target,
    as_shot: crate::as_shot::AsShot,
    baseline_curve: Option<&Value>,
) -> Result<Value, String> {
    let mut baseline = recipe.clone();
    match target {
        Target::Parameter { control } => {
            if !RELIGHT_PARAMETERS.contains(&control.as_str()) {
                return Err("Unsupported parameter".into());
            }
            baseline[control] = if control == "relightAmbient" || control == "relightShine" {
                json!(0)
            } else {
                crate::image_processing::default_adjustments()[control].clone()
            };
        }
        Target::Scalar { control, scope } => {
            if !SCALARS.contains(&control.as_str()) {
                return Err("Unsupported scalar".into());
            }
            if matches!(scope, Scope::Global) && ["temperature", "tint"].contains(&control.as_str())
            {
                let resolved =
                    crate::white_balance::from_adjustments(recipe, as_shot.white_balance);
                baseline["whiteBalance"] = json!({"temperature": if control == "temperature" { as_shot.white_balance.temperature } else { resolved.temperature }, "tint": if control == "tint" { as_shot.white_balance.tint } else { resolved.tint }});
                baseline["temperature"] = json!(0);
                baseline["tint"] = json!(0);
            } else {
                scoped(&mut baseline, scope)?[control] = json!(0);
            }
        }
        Target::Hsl {
            band,
            component,
            scope,
        } => {
            if !BANDS.contains(&band.as_str())
                || !["hue", "saturation", "luminance"].contains(&component.as_str())
            {
                return Err("Invalid HSL target".into());
            }
            scoped(&mut baseline, scope)?["hsl"][band][component] = json!(0);
        }
        Target::Grading { range, scope } => {
            if !["shadows", "midtones", "highlights", "global"].contains(&range.as_str()) {
                return Err("Invalid grading range".into());
            }
            scoped(&mut baseline, scope)?["colorGrading"][range] =
                json!({"hue":0,"saturation":0,"luminance":0});
        }
        Target::Parametric {
            channel,
            parameter,
            scope,
        } => {
            if !["luma", "red", "green", "blue"].contains(&channel.as_str())
                || ![
                    "shadows",
                    "darks",
                    "lights",
                    "highlights",
                    "blackLevel",
                    "whiteLevel",
                ]
                .contains(&parameter.as_str())
            {
                return Err("Invalid parametric curve target".into());
            }
            let curve = baseline_curve.ok_or("Missing baseline curve")?;
            validate_curve(curve)?;
            scoped(&mut baseline, scope)?["curves"][channel] = curve.clone();
            scoped(&mut baseline, scope)?["parametricCurve"][channel][parameter] = json!(0);
        }
        Target::CurvePoint {
            channel,
            index,
            scope,
        } => {
            if !["luma", "red", "green", "blue"].contains(&channel.as_str()) || *index >= 16 {
                return Err("Invalid curve anchor".into());
            }
            let curve = baseline_curve.ok_or("Missing curve anchor reference")?;
            validate_curve(curve)?;
            if curve.as_array().is_none_or(|p| *index >= p.len()) {
                return Err("Missing curve anchor".into());
            }
            scoped(&mut baseline, scope)?["curves"][channel] = curve.clone();
        }
        Target::MonochromeMix { band } => {
            if !BANDS.contains(&band.as_str()) {
                return Err("Invalid monochrome band".into());
            }
            baseline["monochromeMix"][band] = json!(0);
        }
        Target::Effect { effect } => match effect.as_str() {
            "centre" => baseline["centré"] = json!(0),
            "vignette" => baseline["vignetteAmount"] = json!(0),
            "lensBlur" | "fog" => baseline[format!("{effect}Enabled")] = json!(false),
            _ => return Err("Unsupported effect".into()),
        },
        Target::Light { light_id } => {
            let lights = baseline["relightLights"]
                .as_array_mut()
                .ok_or("No lights")?;
            if !lights.iter().any(|l| l["id"].as_str() == Some(light_id)) {
                return Err("Light no longer exists".into());
            }
            lights.retain(|l| l["id"].as_str() != Some(light_id));
        }
    }
    Ok(baseline)
}

type Stage = Mutex<Option<(u64, Arc<DynamicImage>)>>;

fn source_content_hash(recipe: &Value) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for key in [
        "aiPatches",
        "lensBlurDepthMap",
        "fogDepthMap",
        "relightNormalMap",
    ] {
        recipe[key].to_string().hash(&mut h);
    }
    crate::ai_denoise::cache_epoch().hash(&mut h);
    h.finish()
}

/// Reuse the renderer's colour pipeline for selection probes without adding
/// diagnostic bindings or branches to the normal render/export shader.
/// Probe x selects HSL (1), grading (2), vignette (3), constant coverage (5),
/// or a full-strength local curve (6) / tonal component (7). The remaining
/// values identify the band/component and rendered mask index.
pub(crate) fn probe_shader_source(source: &str) -> String {
    // include_str! preserves checkout line endings on Windows.
    let source = source.replace("\r\n", "\n");
    fn insert(source: String, marker: &str, replacement: &str) -> String {
        assert_eq!(
            source.matches(marker).count(),
            1,
            "Diagnostic shader marker changed: {marker}"
        );
        source.replacen(marker, replacement, 1)
    }
    let helpers = r#"
@group(1) @binding(0) var<uniform> probe: vec4<u32>;
fn probe_hsl(c: vec3<f32>, band: u32, lum: bool, mono: bool) -> f32 {
    let safe = max(c, vec3<f32>(0.0));
    if (!mono && abs(safe.r-safe.g)<0.001 && abs(safe.g-safe.b)<0.001) {return 0.0;}
    let hsv=rgb_to_hsv(linear_to_srgb_extended(safe));
    let weight=normalized_hsl_weights(hsv.x)[band];
    if(mono){return weight*smoothstep(0.05,0.4,hsv.y)*smoothstep(0.0,0.1,hsv.y*hsv.z);}
    let gates=hsl_gates(hsv.y);return weight*select(gates.x,gates.y,lum);
}
fn probe_grade(c:vec3<f32>,blending:f32,balance:f32,range:u32)->f32{
    return grading_selection_weights(c,max(blending,0.00001),balance)[range];
}
fn probe_vignette(coord:vec2<i32>)->f32{return vignette_selection_weight(coord);
}
"#;
    let source = insert(
        source.to_owned(),
        "let vignette_mask = smoothstep(v_mid - v_feather, v_mid + v_feather, d);",
        "var vignette_mask=select(0.0,1.0,d>=v_mid); if(v_feather>0.0){vignette_mask=smoothstep(v_mid-v_feather,v_mid+v_feather,d);}",
    );
    let mut result = format!("{source}\n{helpers}");
    result = insert(
        result,
        "if (influence > 0.001) {\n            let m = adjustments.mask_adjustments[i];\n\n            t_exposure",
        "if (influence > 0.001 || (probe.x==7u && probe.w==i)) {\n            let m = adjustments.mask_adjustments[i];\n            t_exposure",
    );
    for (index, control) in ["highlights", "shadows", "whites", "blacks"]
        .iter()
        .enumerate()
    {
        result = insert(
            result,
            &format!("t_{control} += m.{control} * influence;"),
            &format!(
                "t_{control} += m.{control} * select(influence,1.0,probe.x==7u && probe.w==i && probe.y=={index}u);"
            ),
        );
    }
    result = insert(
        result,
        "if (influence > 0.001) {\n            let mask_curved_srgb",
        "if (influence > 0.001 || (probe.x==6u && probe.w==i)) {\n            let mask_curved_srgb",
    );
    result = insert(
        result,
        "final_rgb = mix(final_rgb, mask_curved_srgb, influence);",
        "final_rgb = mix(final_rgb, mask_curved_srgb, select(influence,1.0,probe.x==6u && probe.w==i));",
    );

    result = insert(
        result,
        "    var color_from_texture =",
        "    var influence_weight = 0.0;\n    var color_from_texture =",
    );
    result = insert(
        result,
        "    let is_monochrome =",
        r#"
    if(probe.x==1u && adjustments.global.monochrome.enabled==1u){
        influence_weight=probe_hsl(composite_rgb_linear,probe.y,probe.z==2u,true);
        if(probe.w<adjustments.mask_count){let coverage=get_mask_influence(probe.w,absolute_coord);influence_weight*=select(0.0,coverage,coverage>0.001);}
    }
    let is_monochrome ="#,
    );
    result = insert(
        result,
        "        composite_rgb_linear = apply_color_calibration(composite_rgb_linear, adjustments.global.color_calibration);",
        r#"        composite_rgb_linear = apply_color_calibration(composite_rgb_linear, adjustments.global.color_calibration);
        if(probe.x==1u){
            influence_weight=probe_hsl(composite_rgb_linear,probe.y,probe.z==2u,false);
            if(probe.w<adjustments.mask_count){let coverage=get_mask_influence(probe.w,absolute_coord);influence_weight*=select(0.0,coverage,coverage>0.001);}
        }"#,
    );
    result = insert(
        result,
        "    composite_rgb_linear = apply_color_grading(",
        r#"
    if(probe.x==2u && probe.w==4294967295u){influence_weight=probe_grade(composite_rgb_linear,adjustments.global.color_grading_blending,adjustments.global.color_grading_balance,probe.y);}
    composite_rgb_linear = apply_color_grading("#,
    );
    result = insert(
        result,
        "            let mask_graded = apply_color_grading(",
        r#"
            if(probe.x==2u && probe.w==i){influence_weight=probe_grade(composite_rgb_linear,m.color_grading_blending,m.color_grading_balance,probe.y)*influence;}
            let mask_graded = apply_color_grading("#,
    );
    result = insert(
        result,
        "    if (has_feature(F_VIGNETTE)",
        "    if(probe.x==3u){influence_weight=probe_vignette(absolute_coord_i);}\n    if (has_feature(F_VIGNETTE)",
    );
    result = insert(
        result,
        "    if (adjustments.global.show_clipping == 1u)",
        r#"
    if(probe.x==5u){influence_weight=1.0;}
    if(probe.x!=6u && probe.x!=7u){final_rgb=vec3<f32>(clamp(influence_weight,0.0,1.0));}
    if (adjustments.global.show_clipping == 1u)"#,
    );
    result
}

fn scope_index(recipe: &Value, scope: &Scope) -> Result<u32, String> {
    match scope {
        Scope::Global => Ok(u32::MAX),
        Scope::Mask { container_id } => recipe["masks"]
            .as_array()
            .and_then(|m| {
                m.iter()
                    .filter(|m| {
                        m["visible"].as_bool() == Some(true)
                            && m["subMasks"].as_array().is_some_and(|a| !a.is_empty())
                    })
                    .take(crate::image_processing::MAX_MASKS)
                    .position(|m| m["id"].as_str() == Some(container_id))
            })
            .map(|i| i as u32)
            .ok_or("Mask is not rendered".into()),
    }
}
fn probe_parameters(target: &Target, recipe: &Value) -> Result<[u32; 4], String> {
    match target {
        Target::Parameter { control } if control == "relightAmbient" => Ok([5, 0, 0, u32::MAX]),
        Target::Hsl {
            band,
            component,
            scope,
        } => Ok([
            1,
            BANDS
                .iter()
                .position(|b| *b == band)
                .ok_or("Invalid band")? as u32,
            if component == "luminance" { 2 } else { 0 },
            scope_index(recipe, scope)?,
        ]),
        Target::MonochromeMix { band } => Ok([
            1,
            BANDS
                .iter()
                .position(|b| *b == band)
                .ok_or("Invalid band")? as u32,
            2,
            u32::MAX,
        ]),
        Target::Grading { range, scope } => Ok([
            2,
            ["shadows", "midtones", "highlights"]
                .iter()
                .position(|r| *r == range)
                .ok_or("Invalid selective grading range")? as u32,
            0,
            scope_index(recipe, scope)?,
        ]),
        Target::Effect { effect } if effect == "vignette" => Ok([3, 0, 0, u32::MAX]),
        _ => Err("This selection requires a spatial provider".into()),
    }
}
#[derive(Clone)]
struct CoverageFrames {
    key: u64,
    primary: Arc<crate::gpu_processing::DiagnosticFrame>,
    reference: Option<Arc<crate::gpu_processing::DiagnosticFrame>>,
    filter: Option<Arc<crate::gpu_processing::DiagnosticFrame>>,
}
#[derive(Default)]
pub(crate) struct Stages {
    masks: Mutex<Option<(u64, Arc<Vec<GrayImage>>)>>,
    coverage: Mutex<Option<CoverageFrames>>,
    image_generation: usize,
    reservation: Option<crate::memory_budget::MemoryReservation>,
    patched: Stage,
    working: Stage,
    warped: Stage,
    effects: Stage,
}
impl Stages {
    fn prepare(
        &self,
        loaded: &LoadedImage,
        recipe: &Value,
        resolution: u32,
        cancelled: &(dyn Fn() -> bool + Sync),
    ) -> Result<crate::TransformedPreview, String> {
        crate::compute_transformed_preview_cached(
            loaded,
            recipe,
            resolution,
            &self.patched,
            &self.working,
            &self.warped,
            &self.effects,
            source_content_hash(recipe),
            cancelled,
        )
    }
}

#[allow(clippy::too_many_arguments)]
fn render(
    app: &tauri::AppHandle,
    state: &tauri::State<AppState>,
    loaded: &LoadedImage,
    recipe: &Value,
    stages: &Stages,
    request: &InfluenceRequest,
    gpu: &mut Option<crate::gpu_processing::DiagnosticGpu>,
    probe: Option<[u32; 4]>,
) -> Result<crate::gpu_processing::DiagnosticFrame, String> {
    current(state, request)?;
    let context = crate::gpu_processing::get_or_init_gpu_context(state, app)?;
    let (base, scale, offset) =
        stages.prepare(loaded, recipe, request.target_resolution, &|| {
            current(state, request).is_err()
        })?;
    current(state, request)?;
    if base.width() > context.limits.max_texture_dimension_2d
        || base.height() > context.limits.max_texture_dimension_2d
    {
        return Err("Diagnostic exceeds GPU limits".into());
    }
    let definitions: Vec<crate::mask_generation::MaskDefinition> =
        serde_json::from_value(recipe["masks"].clone()).unwrap_or_default();
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for def in &definitions {
        serde_json::to_string(&(
            &def.id,
            def.visible,
            def.invert,
            def.opacity,
            &def.sub_masks,
        ))
        .map_err(|e| e.to_string())?
        .hash(&mut hasher);
    }
    crate::cache_utils::calculate_geometry_hash(recipe).hash(&mut hasher);
    // Colour/luminance mask sampling includes source negative conversion.
    crate::cache_utils::calculate_patch_hash(recipe).hash(&mut hasher);
    (
        base.width(),
        base.height(),
        scale.to_bits(),
        offset.0.to_bits(),
        offset.1.to_bits(),
        loaded.path.as_str(),
    )
        .hash(&mut hasher);
    let mask_key = hasher.finish();
    let masks = {
        let mut cached = stages.masks.lock().map_err(|_| "Mask cache unavailable")?;
        if cached.as_ref().is_none_or(|(key, _)| *key != mask_key) {
            let active: Vec<_> = definitions
                .iter()
                .filter(|d| d.visible && !d.sub_masks.is_empty())
                .take(crate::image_processing::MAX_MASKS)
                .collect();
            let source = active
                .iter()
                .any(|m| m.requires_warped_image())
                .then(|| crate::build_ai_source_image(&loaded.image, loaded.is_raw, recipe));
            let bitmaps = active
                .iter()
                .map(|m| {
                    crate::mask_generation::generate_mask_bitmap(
                        m,
                        base.width(),
                        base.height(),
                        scale,
                        (offset.0 * scale, offset.1 * scale),
                        source.as_ref(),
                    )
                    .ok_or("Mask bitmap unavailable; refusing mismatched mask indices".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;
            *cached = Some((mask_key, Arc::new(bitmaps)));
        }
        Arc::clone(&cached.as_ref().unwrap().1)
    };
    let settings = crate::app_settings::load_settings(app.clone()).unwrap_or_default();
    let options = crate::image_processing::resolve_render_options(&settings, loaded.is_raw);
    let mut adjustments = crate::image_processing::get_all_adjustments_from_json(
        recipe,
        loaded.is_raw,
        loaded.as_shot,
        options,
    );
    adjustments.global.show_clipping = 0;
    let lut = recipe["lutPath"]
        .as_str()
        .map(|path| crate::lut_processing::get_or_load_lut(state, path))
        .transpose()
        .map_err(|e| e.to_string())?;
    if !gpu
        .as_ref()
        .is_some_and(|g| g.matches(&context, base.width(), base.height()))
    {
        *stages
            .coverage
            .lock()
            .map_err(|_| "Coverage cache unavailable")? = None;
        *gpu = Some(crate::gpu_processing::DiagnosticGpu::new(
            context,
            base.width(),
            base.height(),
        )?);
    }
    let key = crate::cache_utils::calculate_transform_hash(recipe)
        ^ source_content_hash(recipe)
        ^ request.loaded_image_generation as u64;
    gpu.as_mut().unwrap().render(
        &base,
        key,
        crate::gpu_processing::RenderRequest {
            adjustments,
            mask_bitmaps: &masks,
            mask_cache_key: Some(mask_key),
            lut,
            roi: None,
        },
        probe,
        &|| current(state, request).is_err(),
    )
}

fn coverage_cache_key(domain: &Value, request: &InfluenceRequest) -> Result<u64, String> {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    domain.to_string().hash(&mut h);
    serde_json::to_string(&request.target)
        .map_err(|e| e.to_string())?
        .hash(&mut h);
    request.selected_control.hash(&mut h);
    request.presentation.hash(&mut h);
    request.target_resolution.hash(&mut h);
    request.loaded_image_generation.hash(&mut h);
    request
        .coverage_curve
        .as_ref()
        .map(Value::to_string)
        .hash(&mut h);
    Ok(h.finish())
}

fn fixed_response_recipes(
    domain: &Value,
    target: &Target,
    curve: Option<&Value>,
) -> Result<(Value, Value), String> {
    let mut low = domain.clone();
    let mut high = domain.clone();
    match target {
        Target::Scalar { control, scope }
            if ["highlights", "shadows", "whites", "blacks"].contains(&control.as_str()) =>
        {
            scoped(&mut low, scope)?[control] = json!(-50);
            scoped(&mut high, scope)?[control] = json!(50);
        }
        Target::Effect { effect } if effect == "centre" => {
            low["centré"] = json!(-50);
            high["centré"] = json!(50);
        }
        Target::Parametric { channel, scope, .. } | Target::CurvePoint { channel, scope, .. } => {
            let curve = curve.ok_or("Missing fixed curve probe")?;
            validate_curve(curve)?;
            scoped(&mut high, scope)?["curves"][channel] = curve.clone();
        }
        _ => return Err("No coverage provider for this adjustment".into()),
    }
    Ok((low, high))
}
fn response_scope(target: &Target) -> Option<&Scope> {
    match target {
        Target::Scalar { control, scope }
            if ["highlights", "shadows", "whites", "blacks"].contains(&control.as_str()) =>
        {
            Some(scope)
        }
        Target::Parametric { scope, .. } | Target::CurvePoint { scope, .. } => Some(scope),
        _ => None,
    }
}
fn response_probe(target: &Target, recipe: &Value) -> Result<Option<[u32; 4]>, String> {
    if let Some(scope @ Scope::Mask { .. }) = response_scope(target) {
        let index = scope_index(recipe, scope)?;
        return Ok(Some(match target {
            Target::Scalar { control, .. } => [
                7,
                ["highlights", "shadows", "whites", "blacks"]
                    .iter()
                    .position(|c| *c == control)
                    .ok_or("Invalid tone control")? as u32,
                0,
                index,
            ],
            _ => [6, 0, 0, index],
        }));
    }
    Ok(None)
}
#[allow(clippy::too_many_arguments)]
fn coverage_frames(
    app: &tauri::AppHandle,
    state: &tauri::State<AppState>,
    loaded: &LoadedImage,
    recipe: &Value,
    baseline: &Value,
    stages: &Stages,
    request: &InfluenceRequest,
    gpu: &mut Option<crate::gpu_processing::DiagnosticGpu>,
) -> Result<CoverageFrames, String> {
    let domain = if request.presentation == 3 {
        recipe
    } else {
        baseline
    };
    let key = coverage_cache_key(domain, request)?;
    if let Some(cached) = stages
        .coverage
        .lock()
        .map_err(|_| "Coverage cache unavailable")?
        .as_ref()
        && cached.key == key
    {
        return Ok(cached.clone());
    }
    let direct = match &request.target {
        Target::Scalar {
            scope: Scope::Mask { container_id },
            ..
        } if response_scope(&request.target).is_none() => Some(DynamicImage::ImageLuma8(mask_map(
            loaded,
            domain,
            container_id,
            request.target_resolution,
            stages,
            &|| current(state, request).is_err(),
        )?)),
        Target::Light { .. } | Target::Effect { .. }
            if matches!(&request.target, Target::Light { .. })
                || matches!(&request.target,Target::Effect {effect} if effect=="fog") =>
        {
            let mut coverage_recipe = domain.clone();
            coverage_recipe["fogAmount"] = json!(100);
            Some(DynamicImage::ImageRgba8(spatial_map(
                loaded,
                &coverage_recipe,
                &request.target,
                request.target_resolution,
                stages,
                &|| current(state, request).is_err(),
            )?))
        }
        _ => None,
    };
    let (primary, reference) = if let Some(image) = direct {
        (
            gpu.as_ref()
                .ok_or("Diagnostic device unavailable")?
                .upload_frame(&image.to_rgba32f()),
            None,
        )
    } else if let Ok(probe) = probe_parameters(&request.target, domain) {
        (
            render(
                app,
                state,
                loaded,
                domain,
                stages,
                request,
                gpu,
                Some(probe),
            )?,
            None,
        )
    } else {
        let (low, high) =
            fixed_response_recipes(domain, &request.target, request.coverage_curve.as_ref())?;
        let probe = response_probe(&request.target, domain)?;
        let before = render(app, state, loaded, &low, stages, request, gpu, probe)?;
        let after = render(app, state, loaded, &high, stages, request, gpu, probe)?;
        (after, Some(Arc::new(before)))
    };
    let filter = if let Some(Scope::Mask { container_id }) = response_scope(&request.target) {
        let mask = mask_map(
            loaded,
            domain,
            container_id,
            request.target_resolution,
            stages,
            &|| current(state, request).is_err(),
        )?;
        Some(Arc::new(
            gpu.as_ref()
                .ok_or("Diagnostic device unavailable")?
                .upload_frame(&DynamicImage::ImageLuma8(mask).to_rgba32f()),
        ))
    } else {
        None
    };
    let coverage = CoverageFrames {
        key,
        primary: Arc::new(primary),
        reference,
        filter,
    };
    *stages
        .coverage
        .lock()
        .map_err(|_| "Coverage cache unavailable")? = Some(coverage.clone());
    Ok(coverage)
}

fn mask_map(
    loaded: &LoadedImage,
    recipe: &Value,
    id: &str,
    resolution: u32,
    stages: &Stages,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<GrayImage, String> {
    let mut domain = recipe.clone();
    for key in ["relightEnabled", "fogEnabled", "lensBlurEnabled"] {
        domain[key] = json!(false);
    }
    let (base, scale, offset) = stages.prepare(loaded, &domain, resolution, cancelled)?;
    let mask: crate::mask_generation::MaskDefinition = recipe["masks"]
        .as_array()
        .and_then(|m| m.iter().find(|m| m["id"].as_str() == Some(id)))
        .cloned()
        .ok_or("Mask no longer exists")
        .and_then(|m| serde_json::from_value(m).map_err(|_| "Invalid mask"))?;
    let source = mask
        .requires_warped_image()
        .then(|| crate::build_ai_source_image(&loaded.image, loaded.is_raw, recipe));
    crate::mask_generation::generate_mask_bitmap(
        &mask,
        base.width(),
        base.height(),
        scale,
        (offset.0 * scale, offset.1 * scale),
        source.as_ref(),
    )
    .ok_or("Mask is disabled or unavailable".into())
}

fn align_spatial_map(
    map: DynamicImage,
    loaded: &LoadedImage,
    recipe: &Value,
    resolution: u32,
) -> DynamicImage {
    let scale = map.width() as f64 / loaded.image.width().max(1) as f64;
    let mut domain = recipe.clone();
    if let Ok(mut crop) =
        serde_json::from_value::<crate::image_processing::Crop>(recipe["crop"].clone())
    {
        crop.x *= scale;
        crop.y *= scale;
        crop.width = (crop.width * scale).min(resolution as f64);
        crop.height = (crop.height * scale).min(resolution as f64);
        domain["crop"] = serde_json::to_value(crop).unwrap_or(Value::Null);
    }
    crate::adjustment_utils::apply_spatial_transformations(map, &domain)
        .0
        .into_owned()
}

fn spatial_map(
    loaded: &LoadedImage,
    recipe: &Value,
    target: &Target,
    resolution: u32,
    stages: &Stages,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<image::RgbaImage, String> {
    let effect = match target {
        Target::Light { .. } => "relight",
        Target::Effect { effect } => effect.as_str(),
        _ => return Err("Not a spatial target".into()),
    };
    let map_key = match effect {
        "relight" => "relightNormalMap",
        "fog" => "fogDepthMap",
        "lensBlur" => "lensBlurDepthMap",
        _ => return Err("Unsupported spatial target".into()),
    };
    if !crate::image_processing::is_effect_enabled(recipe, effect, &format!("{effect}Enabled")) {
        return Err("Effect is disabled".into());
    }
    if recipe[map_key].as_str().is_none_or(str::is_empty) {
        return Err("Depth or normal map not ready".into());
    }
    let map_value = recipe[map_key]
        .as_str()
        .ok_or("Depth or normal map not ready")?;
    let valid = if effect == "relight" {
        crate::effect_maps::resolve_rgba_map(map_value, recipe)
            .is_some_and(|m| m.width() >= 2 && m.height() >= 2)
    } else {
        crate::effect_maps::resolve_luma_map(map_value, recipe)
            .is_some_and(|m| m.width() >= 2 && m.height() >= 2)
    };
    if !valid {
        return Err("Depth or normal map is invalid".into());
    }
    let mut input_recipe = recipe.clone();
    input_recipe["lensBlurEnabled"] = json!(false);
    if effect != "lensBlur" {
        input_recipe["fogEnabled"] = json!(false);
    }
    if effect == "relight" {
        input_recipe["relightEnabled"] = json!(false);
    }
    stages.prepare(loaded, &input_recipe, resolution, cancelled)?;
    let input = stages
        .effects
        .lock()
        .map_err(|_| "Effect input unavailable")?
        .as_ref()
        .map(|(_, image)| Arc::clone(image))
        .ok_or("Effect input unavailable")?;
    let map = match target {
        Target::Light { light_id } => {
            let index = recipe["relightLights"]
                .as_array()
                .and_then(|lights| {
                    lights
                        .iter()
                        .filter(|l| l["visible"].as_bool().unwrap_or(true))
                        .position(|l| l["id"].as_str() == Some(light_id))
                })
                .ok_or("Light no longer exists")?;
            crate::relight::diagnose_relight(&input, recipe, index)
        }
        _ if effect == "fog" => crate::fog::diagnose_fog(&input, recipe),
        _ => return Err("Select an individual light for Light reach".into()),
    };
    Ok(align_spatial_map(map, loaded, recipe, resolution).to_rgba8())
}

fn baseline_recipe(
    recipe: &Value,
    request: &InfluenceRequest,
    as_shot: crate::as_shot::AsShot,
) -> Result<Value, String> {
    let mut baseline = neutralize(
        recipe,
        &request.target,
        as_shot,
        request.baseline_curve.as_ref(),
    )?;
    if let Some(control) = request.selected_control.as_deref() {
        match &request.target {
            Target::Effect { effect }
                if ["vignette", "fog", "lensBlur"].contains(&effect.as_str()) =>
            {
                let allowed = [
                    "vignetteAmount",
                    "vignetteMidpoint",
                    "vignetteRoundness",
                    "vignetteFeather",
                    "fogAmount",
                    "fogStart",
                    "fogDensity",
                    "fogHeight",
                    "fogVariation",
                    "fogGlow",
                    "fogTemperature",
                    "fogTint",
                    "lensBlurAmount",
                    "lensBlurDiffusion",
                ];
                if allowed.contains(&control) && control.starts_with(effect) {
                    // default_adjustments() is a sparse recipe, not the UI defaults.
                    // Keep the effect enabled while neutralizing only the grabbed control.
                    let default = crate::image_processing::default_adjustment_values()
                        .and_then(|defaults| defaults.get(control))
                        .filter(|value| value.is_number())
                        .ok_or("Missing effect control default")?;
                    baseline = recipe.clone();
                    baseline[control] = if ["fogAmount", "lensBlurAmount"].contains(&control) {
                        json!(0)
                    } else {
                        default.clone()
                    };
                }
            }
            Target::Grading { range, scope } => {
                if control == format!("grading.{range}.wheel") {
                    baseline = recipe.clone();
                    let grading = &mut scoped(&mut baseline, scope)?["colorGrading"][range];
                    grading["hue"] = json!(0);
                    grading["saturation"] = json!(0);
                }
                let prefix = format!("grading.{range}.");
                if let Some(key) = control.strip_prefix(&prefix)
                    && ["hue", "saturation", "luminance"].contains(&key)
                {
                    baseline = recipe.clone();
                    scoped(&mut baseline, scope)?["colorGrading"][range][key] = json!(0);
                }
            }
            Target::Light { light_id } => {
                if let Some((id, key)) = control
                    .strip_prefix("light.")
                    .and_then(|s| s.split_once('|'))
                    && id == light_id
                {
                    let default = match key {
                        "intensity" | "depth" | "temperature" | "tint" => Some(0),
                        "radius" => Some(30),
                        "angle" => Some(135),
                        "elevation" => Some(60),
                        "cone" => Some(40),
                        "feather" => Some(50),
                        _ => None,
                    };
                    if let Some(default) = default {
                        baseline = recipe.clone();
                        if let Some(light) =
                            baseline["relightLights"].as_array_mut().and_then(|lights| {
                                lights
                                    .iter_mut()
                                    .find(|l| l["id"].as_str() == Some(light_id))
                            })
                        {
                            light[key] = json!(default);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    Ok(baseline)
}

fn process(app: &tauri::AppHandle, request: &InfluenceRequest) -> Result<Vec<u8>, String> {
    let started = std::time::Instant::now();
    let state = app.state::<AppState>();
    current(&state, request)?;
    let loaded = state
        .original_image
        .lock()
        .map_err(|_| "Image unavailable")?
        .clone()
        .ok_or("No image loaded")?;
    if loaded.path != request.image_path {
        return Err("Image changed".into());
    }
    let pixels = u64::from(loaded.image.width()) * u64::from(loaded.image.height());
    let preview_pixels = u64::from(request.target_resolution).pow(2);
    let bytes = pixels
        .checked_mul(48)
        .and_then(|n| {
            preview_pixels
                .checked_mul(96)
                .and_then(|v| n.checked_add(v))
        })
        .ok_or("Image memory size overflow")?;
    let mut stages = state
        .influence_stages
        .lock()
        .map_err(|_| "Diagnostic cache unavailable")?;
    if stages.image_generation != request.loaded_image_generation {
        *stages = Stages {
            image_generation: request.loaded_image_generation,
            ..Default::default()
        };
    }
    stages.reservation.take();
    let memory = state
        .memory_budget
        .try_reserve(bytes)
        .ok_or("Insufficient diagnostic memory; reduce preview resolution")?;
    let mut recipe = request.js_adjustments.clone();
    crate::adjustment_utils::hydrate_adjustments(&state, &mut recipe);
    validate_availability(&recipe, &request.target)?;
    if crate::ai_denoise::is_enabled(&recipe)
        && !crate::ai_denoise::has_cached_entry(
            &loaded.path,
            crate::ai_denoise::DenoiseMethod::from_adjustments(&recipe),
        )
    {
        return Err("Waiting for existing denoise results".into());
    }
    let denoise_epoch = crate::ai_denoise::cache_epoch();

    let map = {
        let baseline = baseline_recipe(&recipe, request, loaded.as_shot)?;
        let mut gpu = state
            .influence_gpu
            .lock()
            .map_err(|_| "Diagnostic device unavailable")?;
        let actual = render(
            app, &state, &loaded, &recipe, &stages, request, &mut gpu, None,
        )?;
        current(&state, request)?;
        if request.presentation == 0 {
            let before = render(
                app, &state, &loaded, &baseline, &stages, request, &mut gpu, None,
            )?;
            gpu.as_mut()
                .unwrap()
                .compose(&actual, &before, 0, None, None)?
        } else {
            let coverage = coverage_frames(
                app, &state, &loaded, &recipe, &baseline, &stages, request, &mut gpu,
            )?;
            gpu.as_mut().unwrap().compose_filtered(
                &actual,
                &actual,
                request.presentation,
                Some(&coverage.primary),
                coverage.reference.as_deref(),
                coverage.filter.as_deref(),
            )?
        }
    };
    current(&state, request)?;
    if denoise_epoch != crate::ai_denoise::cache_epoch() {
        return Err("Dependency changed; retry preview".into());
    }
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(
            map.as_raw(),
            map.width(),
            map.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| e.to_string())?;
    current(&state, request)?;
    let empty = map
        .pixels()
        .all(|p| p[3] == 0 || (p[0] == 0 && p[1] == 0 && p[2] == 0));
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.;
    log::debug!(
        "Influence preview: {:?} presentation={} {}x{} {:.2}ms empty={}",
        request.target,
        request.presentation,
        map.width(),
        map.height(),
        elapsed_ms,
        empty
    );
    let header=serde_json::to_vec(&json!({"identity":request.identity,"generation":request.client_generation,"width":map.width(),"height":map.height(),"status":"ready","empty":empty,"elapsedMs":elapsed_ms})).map_err(|e|e.to_string())?;
    let mut result = b"RIF1".to_vec();
    result.extend_from_slice(&(header.len() as u32).to_le_bytes());
    result.extend(header);
    result.extend(png);
    stages.reservation = Some(memory);
    Ok(result)
}

#[cfg(test)]
mod tests;
