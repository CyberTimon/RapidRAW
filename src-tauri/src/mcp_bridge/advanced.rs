//! Native AI, cleanup, lens, and multi-image operations for the isolated bridge.
use super::{
    Result, flag, number, required,
    sessions::{Bridge, Session},
    validation,
};
use crate::{
    ai_processing as ai,
    app_state::AppState,
    mask_generation::{AiPatchDefinition, MaskDefinition},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::{DynamicImage, GrayImage, ImageFormat};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
};
use tauri::Manager;

mod subject_refinement;

fn generation_options(
    params: &Value,
    mode: &str,
) -> Result<Option<crate::ai_connector::GenerationOptions>> {
    let Some(value) = params.get("generation_options") else {
        return Ok(None);
    };
    if mode != "generative" {
        return Err(
            "INVALID_ARGUMENT: generation_options are only supported in generative retouch mode"
                .into(),
        );
    }
    let options: crate::ai_connector::GenerationOptions = serde_json::from_value(value.clone())
        .map_err(|error| format!("INVALID_ARGUMENT: generation_options: {error}"))?;
    options
        .validate()
        .map_err(|error| format!("INVALID_ARGUMENT: {error}"))?;
    Ok(Some(options))
}

fn model_assets(kind: &str) -> Result<Vec<(&'static str, &'static str)>> {
    Ok(match kind {
        "masks" => vec![
            (ai::ENCODER_FILENAME, ai::ENCODER_SHA256),
            (ai::DECODER_FILENAME, ai::DECODER_SHA256),
            (ai::U2NETP_FILENAME, ai::U2NETP_SHA256),
            (ai::SKYSEG_FILENAME, ai::SKYSEG_SHA256),
            (ai::DEPTH_FILENAME, ai::DEPTH_SHA256),
        ],
        "inpaint" => vec![(ai::LAMA_FILENAME, ai::LAMA_SHA256)],
        "denoise" => vec![(ai::DENOISE_FILENAME, ai::DENOISE_SHA256)],
        _ => {
            return Err(
                "INVALID_ARGUMENT: model kind must be masks, inpaint, denoise or nonlocal".into(),
            );
        }
    })
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file =
        fs::File::open(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(hex::encode(hash.finalize()))
}

fn image_reply(image: &GrayImage) -> Result<Value> {
    let original = DynamicImage::ImageLuma8(image.clone());
    let preview = if image.width().max(image.height()) > 1200 {
        original.thumbnail(1200, 1200)
    } else {
        original
    };
    let mut bytes = Cursor::new(Vec::new());
    preview
        .write_to(&mut bytes, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(
        json!({"data":STANDARD.encode(bytes.into_inner()),"mimeType":"image/png","width":preview.width(),"height":preview.height()}),
    )
}

fn bitmap_from_url(data: &str) -> Result<GrayImage> {
    let data = data.split_once(',').map(|(_, body)| body).unwrap_or(data);
    let bytes = STANDARD
        .decode(data)
        .map_err(|e| format!("Invalid generated bitmap encoding: {e}"))?;
    image::load_from_memory(&bytes)
        .map(|image| image.to_luma8())
        .map_err(|e| format!("Invalid generated bitmap: {e}"))
}

fn mask_statistics(mask: &GrayImage) -> Value {
    let total = mask.as_raw().len().max(1) as f64;
    let selected = mask.as_raw().iter().filter(|&&p| p > 0).count() as f64 / total;
    let opacity = mask
        .as_raw()
        .iter()
        .map(|&p| f64::from(p) / 255.0)
        .sum::<f64>()
        / total;
    json!({"width":mask.width(),"height":mask.height(),"nonzero_fraction":selected,"mean_opacity":opacity,"empty":selected==0.0})
}

fn append_generated_submask(
    mask: &mut Value,
    kind: &str,
    mode: &str,
    parameters: Value,
) -> Result<String> {
    let sub_mask_id = uuid::Uuid::new_v4().to_string();
    let component = json!({"id":sub_mask_id,"type":format!("ai-{kind}"),"visible":true,"invert":false,"mode":mode,"opacity":100,"parameters":parameters});
    mask["subMasks"]
        .as_array_mut()
        .ok_or("INVALID_MASK: Missing submasks")?
        .push(component);
    Ok(sub_mask_id)
}

fn oriented_dimensions(session: &Session) -> (u32, u32) {
    if session.current().adjustments["orientationSteps"]
        .as_u64()
        .unwrap_or(0)
        % 2
        == 1
    {
        (session.dimensions.1, session.dimensions.0)
    } else {
        session.dimensions
    }
}

fn region(params: &Value, dimensions: (u32, u32)) -> Result<((f64, f64), (f64, f64))> {
    let (width, height) = (f64::from(dimensions.0), f64::from(dimensions.1));
    if let Some(region) = params.get("region") {
        if !region.is_object() {
            return Err("INVALID_ARGUMENT: region must be an object".into());
        }
        let x = number(region, "x", 0.0, 0.0, width)?;
        let y = number(region, "y", 0.0, 0.0, height)?;
        let w = number(region, "width", width, 0.001, width)?;
        let h = number(region, "height", height, 0.001, height)?;
        if x + w > width || y + h > height {
            return Err(
                "INVALID_ARGUMENT: subject region exceeds oriented image dimensions".into(),
            );
        }
        Ok(((x, y), (x + w, y + h)))
    } else {
        Ok(((0.0, 0.0), (width, height)))
    }
}

impl Bridge {
    pub(super) async fn advanced(&mut self, method: &str, params: &Value) -> Result<Value> {
        match method {
            "models" => self.models_status(),
            "install_model" => {
                let kind = required(params, "kind")?;
                self.ensure_models(kind, true).await?;
                self.models_status()
            }
            "mask_generate" => self.generate_mask(params).await,
            "generate_depth" => self.depth(params).await,
            "retouch" => self.cleanup(params).await,
            "denoise" => self.denoise(params).await,
            "merge" => self.merge_images(params).await,
            "negative_convert" => self.negative(params).await,
            "lens_profile" => self.lens_profile(params),
            _ => Err(format!("UNKNOWN_METHOD: {method}")),
        }
    }

    /// Nonlocal bundle verification/installation. Explicit
    /// `install_model` (allow_download) downloads the pinned provider
    /// bundle; every other call only verifies what is already installed.
    /// Never requires ORT, even for the ONNX variant: installation is
    /// hash/validation-gated file delivery, not inference.
    pub(super) async fn ensure_nonlocal_models(&self, allow_download: bool) -> Result<()> {
        let model_directory = self
            .paths
            .models
            .canonicalize()
            .map_err(|e| format!("INVALID_PATH: Cannot resolve model workspace: {e}"))?;
        if model_directory != self.paths.models || !model_directory.starts_with(&self.paths.root) {
            return Err(
                "INVALID_PATH: Model directory must be a real directory inside the workspace"
                    .into(),
            );
        }
        let provider = crate::nonlocal_onnx::provider_from_env().map_err(|e| e.to_string())?;
        if std::env::var_os("RAPIDRAW_NONLOCAL_BUNDLE").is_some() {
            // Explicit developer override: verify only, never download.
            let (bundle, _) =
                crate::nonlocal_install::resolve_bundle(Some(&model_directory), provider)
                    .map_err(|e| e.to_string())?;
            return crate::nonlocal_install::validate_resolved_bundle(provider, &bundle)
                .map_err(|e| e.to_string());
        }
        let installed = crate::nonlocal_install::install_dir(&model_directory, provider);
        if installed.is_dir()
            && crate::nonlocal_install::validate_resolved_bundle(provider, &installed).is_ok()
        {
            return Ok(());
        }
        if !allow_download {
            return Err("MODEL_NOT_INSTALLED: No verified Nonlocal bundle is installed. Call install_model with kind='nonlocal'.".into());
        }
        crate::nonlocal_install::install(&model_directory, provider)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub(super) fn models_status(&self) -> Result<Value> {
        let installed = self
            .handle
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("models");
        let mut groups = serde_json::Map::new();
        groups.insert(
            "nonlocal".into(),
            crate::nonlocal_install::status(&self.paths.models),
        );
        for kind in ["masks", "inpaint", "denoise"] {
            let mut assets = Vec::new();
            let mut ready = true;
            for (name, hash) in model_assets(kind)? {
                let path = self.paths.models.join(name);
                let valid = path.is_file() && sha256_file(&path)? == hash;
                ready &= valid;
                let existing = installed.join(name);
                let legacy = if name == ai::SKYSEG_FILENAME {
                    Some(installed.join(ai::SKYSEG_LEGACY_FILENAME))
                } else {
                    None
                };
                assets.push(json!({"name":name,"path":path,"present":path.is_file(),"verified":valid,"expected_sha256":hash,"installed_app_copy_available":existing.is_file()||legacy.is_some_and(|p|p.is_file())}));
            }
            groups.insert(kind.into(), json!({"ready":ready,"assets":assets}));
        }
        for model in crate::ai_enhance::MODELS {
            let installed = crate::ai_enhance::installed(&self.paths.models, model.id);
            let mut assets = Vec::new();
            if let Ok((path, hash)) = &installed {
                assets.push(json!({"name":model.filename,"path":path,"present":true,"verified":true,"expected_sha256":hash,"installed_app_copy_available":false}));
                let receipt_name = format!("{}.json", model.filename);
                let receipt = self.paths.models.join(&receipt_name);
                if receipt.is_file() {
                    assets.push(json!({"name":receipt_name,"path":receipt,"present":true,"verified":true,"expected_sha256":sha256_file(&receipt)?,"installed_app_copy_available":false}));
                }
            }
            groups.insert(
                format!("enhance-{}", model.id),
                json!({"ready":installed.is_ok(),"assets":assets}),
            );
        }
        Ok(
            json!({"models_directory":self.paths.models,"groups":groups,"onnx_runtime_path":std::env::var_os("ORT_DYLIB_PATH").map(PathBuf::from),"onnx_execution":crate::ai_runtime::status(),"installation":"install_model copies verified installed assets when available, then downloads only missing or corrupt assets into this workspace"}),
        )
    }

    pub(super) async fn ensure_models(&self, kind: &str, allow_download: bool) -> Result<()> {
        // Nonlocal bundles install from the pinned Hub distribution without
        // any ONNX Runtime requirement, so this branch runs before the ORT
        // check below. Other kinds are unchanged.
        if kind == "nonlocal" {
            return self.ensure_nonlocal_models(allow_download).await;
        }
        let model_directory = self
            .paths
            .models
            .canonicalize()
            .map_err(|e| format!("INVALID_PATH: Cannot resolve model workspace: {e}"))?;
        if model_directory != self.paths.models || !model_directory.starts_with(&self.paths.root) {
            return Err(
                "INVALID_PATH: Model directory must be a real directory inside the workspace"
                    .into(),
            );
        }
        let runtime=std::env::var_os("ORT_DYLIB_PATH").map(PathBuf::from).filter(|p|p.is_file()).ok_or("MODEL_RUNTIME_UNAVAILABLE: Set ORT_DYLIB_PATH to the bundled ONNX runtime library before starting the bridge")?;
        let _ = runtime;
        let installed = self
            .handle
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("models");
        let cache = super::model_cache::directory(&self.handle)?;
        let mut missing = Vec::new();
        for (name, hash) in model_assets(kind)? {
            let target = self.paths.models.join(name);
            if fs::symlink_metadata(&target).is_ok_and(|metadata| metadata.file_type().is_symlink())
            {
                return Err(format!(
                    "INVALID_PATH: Workspace model {name} cannot be a symlink"
                ));
            }
            if target.is_file() && sha256_file(&target)? == hash {
                super::model_cache::remember(&cache, &target, hash)?;
                continue;
            }
            let mut source =
                super::model_cache::lookup(&cache, hash)?.unwrap_or_else(|| installed.join(name));
            if !source.is_file() && name == ai::SKYSEG_FILENAME {
                source = installed.join(ai::SKYSEG_LEGACY_FILENAME);
            }
            if !target.exists() && source.is_file() && sha256_file(&source)? == hash {
                crate::storage_copy::copy_new(&source, &target).map_err(|e| e.to_string())?;
            }
            if !target.is_file() || sha256_file(&target)? != hash {
                missing.push(name);
            }
        }
        if !allow_download && !missing.is_empty() {
            return Err(format!(
                "MODEL_NOT_INSTALLED: {} assets are missing or invalid: {}. Call install_model with kind='{kind}'.",
                kind,
                missing.join(", ")
            ));
        }
        let state = self.handle.state::<AppState>();
        match kind {
            "masks" => {
                ai::get_or_init_ai_models(&self.handle, &state.ai_state, &state.ai_init_lock)
                    .await
                    .map_err(|e| format!("MODEL_INITIALIZATION_FAILED: {e}"))?;
            }
            "inpaint" => {
                ai::get_or_init_lama_model(&self.handle, &state.ai_state, &state.ai_init_lock)
                    .await
                    .map_err(|e| format!("MODEL_INITIALIZATION_FAILED: {e}"))?;
            }
            "denoise" => {
                ai::get_or_init_denoise_model(&self.handle, &state.ai_state, &state.ai_init_lock)
                    .await
                    .map_err(|e| format!("MODEL_INITIALIZATION_FAILED: {e}"))?;
            }
            _ => unreachable!(),
        }
        for (name, hash) in model_assets(kind)? {
            super::model_cache::remember(&cache, &self.paths.models.join(name), hash)?;
        }
        Ok(())
    }

    async fn generate_mask(&mut self, params: &Value) -> Result<Value> {
        let session = self.session(params)?.clone();
        session.check_revision(params)?;
        let kind = required(params, "kind")?;
        if !["subject", "foreground", "sky", "depth", "normals", "albedo"].contains(&kind) {
            return Err("INVALID_ARGUMENT: unknown AI mask kind".into());
        }
        let provider = params
            .get("depth_provider")
            .map(|v| {
                v.as_str()
                    .ok_or("INVALID_ARGUMENT: depth_provider must be a string")
            })
            .transpose()?
            .unwrap_or("builtin");
        if !["builtin", "marigold"].contains(&provider)
            || (params.get("depth_provider").is_some() && kind != "depth")
        {
            return Err("INVALID_ARGUMENT: depth_provider applies only to depth masks and must be builtin or marigold".into());
        }
        let controls = params
            .get("parameters")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let controls_map = controls
            .as_object()
            .ok_or("INVALID_ARGUMENT: parameters must be an object")?;
        for key in controls_map.keys() {
            if ![
                "grow",
                "feather",
                "minDepth",
                "maxDepth",
                "minFade",
                "maxFade",
                "normalAngle",
                "normalAmount",
                "surfacePointX",
                "surfacePointY",
                "surfaceTolerance",
                "surfaceAmount",
                "surfaceColor",
            ]
            .contains(&key.as_str())
            {
                return Err(format!(
                    "INVALID_ARGUMENT: unsupported AI mask parameter {key}"
                ));
            }
            if (key.starts_with("normal") && kind != "normals")
                || (key.starts_with("surface") && kind != "albedo")
            {
                return Err(format!("INVALID_ARGUMENT: {key} does not apply to {kind}"));
            }
            if kind != "depth"
                && ["minDepth", "maxDepth", "minFade", "maxFade"].contains(&key.as_str())
            {
                return Err(format!(
                    "INVALID_ARGUMENT: {key} only applies to depth masks"
                ));
            }
        }
        let append_target = if let Some(value) = params.get("target_mask_id") {
            if params.get("refine").is_some() {
                return Err(
                    "INVALID_ARGUMENT: target_mask_id cannot be combined with refine".into(),
                );
            }
            let mask_id = value
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or("INVALID_ARGUMENT: target_mask_id must be a mask ID")?;
            let mode = required(params, "mode")?;
            if !["additive", "subtractive", "intersect"].contains(&mode) {
                return Err(
                    "INVALID_ARGUMENT: mode must be additive, subtractive or intersect".into(),
                );
            }
            let masks = session.current().adjustments["masks"]
                .as_array()
                .ok_or("MASK_NOT_FOUND: Session contains no masks")?;
            let index = masks
                .iter()
                .position(|mask| mask["id"] == mask_id)
                .ok_or("MASK_NOT_FOUND: target_mask_id is not in this session")?;
            let components = masks[index]["subMasks"]
                .as_array()
                .ok_or("INVALID_MASK: Missing submasks")?;
            if components.len() >= 128 {
                return Err("INVALID_MASK: A parent can contain at most 128 submasks".into());
            }
            if matches!(kind, "normals" | "albedo")
                && components.iter().any(|component| {
                    crate::marigold_surface::is_surface(component["type"].as_str().unwrap_or(""))
                })
            {
                return Err(
                    "INVALID_MASK: A parent can contain only one normals or albedo component"
                        .into(),
                );
            }
            Some((index, mode.to_string()))
        } else {
            if params.get("mode").is_some() {
                return Err("INVALID_ARGUMENT: mode requires target_mask_id".into());
            }
            None
        };
        let bbox = region(params, oriented_dimensions(&session))?;
        let subject_request = subject_refinement::prepare(params, &session)?;
        number(&controls, "grow", 0.0, -100.0, 100.0)?;
        number(&controls, "feather", 0.0, 0.0, 100.0)?;
        if matches!(kind, "normals" | "albedo") && params.get("region").is_some() {
            return Err("INVALID_ARGUMENT: intersect surface masks with a brush or subject mask to limit the region".into());
        }
        if kind == "normals" {
            number(&controls, "normalAngle", 0.0, -180.0, 180.0)?;
            number(&controls, "normalAmount", 0.5, -1.5, 1.5)?;
        }
        if kind == "albedo" {
            number(&controls, "surfacePointX", 0.5, 0.0, 1.0)?;
            number(&controls, "surfacePointY", 0.5, 0.0, 1.0)?;
            number(&controls, "surfaceTolerance", 0.13, 0.005, 1.0)?;
            number(&controls, "surfaceAmount", 0.0, 0.0, 1.0)?;
            if let Some(color) = controls.get("surfaceColor")
                && color.as_array().is_none_or(|a| {
                    a.len() != 3 || a.iter().any(|v| v.as_u64().is_none_or(|v| v > 255))
                })
            {
                return Err(
                    "INVALID_ARGUMENT: surfaceColor must contain three integers from 0 to 255"
                        .into(),
                );
            }
        }
        if provider == "builtin" && !matches!(kind, "normals" | "albedo") {
            self.ensure_models("masks", false).await?;
        }
        self.activate(&session.id).await?;
        let state = self.handle.state::<AppState>();
        let adjustments = &session.current().adjustments;
        let rotation = adjustments["rotation"].as_f64().unwrap_or(0.0) as f32;
        let flip_h = adjustments["flipHorizontal"].as_bool().unwrap_or(false);
        let flip_v = adjustments["flipVertical"].as_bool().unwrap_or(false);
        let orientation = adjustments["orientationSteps"].as_u64().unwrap_or(0) as u8;
        let mut refinement = None;
        let generated = if let Some(request) = &subject_request {
            let (parameters, info) = request.generate(self, &session)?;
            refinement = Some(info);
            Ok(parameters)
        } else {
            match kind {
                "subject" => serde_json::to_value(
                    crate::ai_commands::generate_ai_subject_mask(
                        adjustments.clone(),
                        session.working_path.clone(),
                        bbox.0,
                        bbox.1,
                        rotation,
                        flip_h,
                        flip_v,
                        orientation,
                        state.clone(),
                        self.handle.clone(),
                    )
                    .await?,
                ),
                "foreground" => serde_json::to_value(
                    crate::ai_commands::generate_ai_foreground_mask(
                        adjustments.clone(),
                        rotation,
                        flip_h,
                        flip_v,
                        orientation,
                        state.clone(),
                        self.handle.clone(),
                    )
                    .await?,
                ),
                "sky" => serde_json::to_value(
                    crate::ai_commands::generate_ai_sky_mask(
                        adjustments.clone(),
                        rotation,
                        flip_h,
                        flip_v,
                        orientation,
                        state.clone(),
                        self.handle.clone(),
                    )
                    .await?,
                ),
                "normals" | "albedo" => {
                    let mut generated = crate::marigold_surface::generate_marigold_surface_mask(
                        kind.into(),
                        adjustments.clone(),
                        session.working_path.clone(),
                        state.clone(),
                        self.handle.clone(),
                    )
                    .await?;
                    if kind == "normals" {
                        generated["normalAngle"] = json!(0);
                        generated["normalAmount"] = json!(0.5);
                    } else {
                        generated["surfacePointX"] = json!(0.5);
                        generated["surfacePointY"] = json!(0.5);
                        generated["surfaceTolerance"] = json!(0.13);
                        generated["surfaceAmount"] = json!(0);
                        generated["surfaceColor"] = json!([90, 160, 220]);
                    }
                    Ok(generated)
                }
                "depth" if provider == "marigold" => {
                    let mut generated = crate::marigold_depth::generate_marigold_depth_mask(
                        adjustments.clone(),
                        session.working_path.clone(),
                        state.clone(),
                        self.handle.clone(),
                    )
                    .await?;
                    for (key, fallback) in [
                        ("minDepth", 0.0),
                        ("maxDepth", 100.0),
                        ("minFade", 15.0),
                        ("maxFade", 15.0),
                        ("feather", 15.0),
                    ] {
                        generated[key] = json!(number(&controls, key, fallback, 0.0, 100.0)?);
                    }
                    Ok(generated)
                }
                "depth" => serde_json::to_value(
                    crate::ai_commands::generate_ai_depth_mask(
                        adjustments.clone(),
                        session.working_path.clone(),
                        number(&controls, "minDepth", 0.0, 0.0, 100.0)? as f32,
                        number(&controls, "maxDepth", 100.0, 0.0, 100.0)? as f32,
                        number(&controls, "minFade", 15.0, 0.0, 100.0)? as f32,
                        number(&controls, "maxFade", 15.0, 0.0, 100.0)? as f32,
                        number(&controls, "feather", 15.0, 0.0, 100.0)? as f32,
                        rotation,
                        flip_h,
                        flip_v,
                        orientation,
                        state.clone(),
                        self.handle.clone(),
                    )
                    .await?,
                ),
                _ => unreachable!(),
            }
        }
        .map_err(|e: serde_json::Error| e.to_string())?;
        let target = subject_request.as_ref().and_then(|r| r.target);
        let mut parameters = if let Some((mi, si)) = target {
            let mut previous = adjustments["masks"][mi]["subMasks"][si]["parameters"].clone();
            for (key, value) in generated.as_object().unwrap() {
                previous[key] = value.clone();
            }
            previous
        } else {
            generated
        };
        for (key, value) in controls_map {
            parameters[key] = value.clone();
        }
        let id = uuid::Uuid::new_v4().to_string();
        let mut local = params
            .get("adjustments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        validation::resolve_curve_patch(&mut local, &params["adjustments"]);
        let (mask, sub_mask_id) = if let Some((mi, si)) = target {
            let mut mask = adjustments["masks"][mi].clone();
            mask["subMasks"][si]["parameters"] = parameters;
            if let Some(name) = params.get("name") {
                mask["name"] = name.clone();
            }
            if params.get("adjustments").is_some() {
                validation::merge_patch(&mut mask["adjustments"], &local)?;
            }
            let sub_mask_id = mask["subMasks"][si]["id"].clone();
            (mask, sub_mask_id)
        } else if let Some((mi, mode)) = &append_target {
            let mut mask = adjustments["masks"][*mi].clone();
            let sub_mask_id = append_generated_submask(&mut mask, kind, mode, parameters)?;
            if let Some(name) = params.get("name") {
                mask["name"] = name.clone();
            }
            if params.get("adjustments").is_some() {
                validation::merge_patch(&mut mask["adjustments"], &local)?;
            }
            (mask, json!(sub_mask_id))
        } else {
            let sub_mask_id = uuid::Uuid::new_v4().to_string();
            (
                json!({"id":id,"name":params["name"].as_str().unwrap_or(kind),"visible":true,"invert":false,"opacity":100,"adjustments":local,"subMasks":[{"id":sub_mask_id,"type":format!("ai-{kind}"),"visible":true,"invert":false,"mode":"additive","opacity":100,"parameters":parameters}]}),
                json!(sub_mask_id),
            )
        };
        let id = mask["id"].as_str().unwrap().to_string();
        validation::validate_adjustments(&json!({"masks":[mask.clone()]}), session.dimensions)?;
        let definition: MaskDefinition =
            serde_json::from_value(mask.clone()).map_err(|e| e.to_string())?;
        let (width, height) = oriented_dimensions(&session);
        let bitmap = crate::mask_generation::generate_mask_bitmap(
            &definition,
            width,
            height,
            1.0,
            (0.0, 0.0),
            None,
        );
        let bitmap = if target.is_some() || append_target.is_some() {
            // The model selection was checked before applying preserved parent
            // visibility, opacity and sibling add/subtract/intersect operations.
            bitmap.unwrap_or_else(|| GrayImage::new(width, height))
        } else {
            bitmap.ok_or("MASK_GENERATION_FAILED: Generated mask could not be rasterized")?
        };
        let statistics = mask_statistics(&bitmap);
        if target.is_none()
            && append_target.is_none()
            && !matches!(kind, "normals" | "albedo")
            && statistics["empty"] == true
        {
            return Err("EMPTY_MASK: Model selected no pixels. Adjust the subject region or mask parameters and retry.".into());
        }
        let mut next = adjustments.clone();
        if !next["masks"].is_array() {
            next["masks"] = json!([]);
        }
        if let Some((mi, _)) = target {
            next["masks"][mi] = mask;
        } else if let Some((mi, _)) = append_target {
            next["masks"][mi] = mask;
        } else {
            next["masks"].as_array_mut().unwrap().push(mask);
        }
        let mut result = self.commit(
            &session.id,
            next,
            session.current().metadata.clone(),
            &format!("Generated {kind} mask"),
        )?;
        result["mask_id"] = json!(id);
        result["sub_mask_id"] = sub_mask_id;
        if let Some(refinement) = refinement {
            result["refinement"] = refinement;
        }
        result["mask_statistics"] = statistics;
        result["coordinate_space"] = json!("oriented image pixels before crop");
        result["image"] = image_reply(&bitmap)?;
        Ok(result)
    }

    async fn depth(&mut self, params: &Value) -> Result<Value> {
        let session = self.session(params)?.clone();
        session.check_revision(params)?;
        let enable = flag(params, "enable_blur", false)?;
        self.ensure_models("masks", false).await?;
        self.activate(&session.id).await?;
        let data = crate::ai_commands::generate_full_image_depth_map(
            session.current().adjustments.clone(),
            self.handle.state::<AppState>(),
            self.handle.clone(),
        )
        .await?;
        let bitmap = bitmap_from_url(&data)?;
        let mut next = session.current().adjustments.clone();
        next["lensBlurDepthMap"] = json!(data);
        if enable {
            next["lensBlurEnabled"] = json!(true);
        }
        let mut result = self.commit(
            &session.id,
            next,
            session.current().metadata.clone(),
            "Generated depth map",
        )?;
        result["depth_statistics"] = mask_statistics(&bitmap);
        result["image"] = image_reply(&bitmap)?;
        result["coordinate_space"] = json!(
            "geometry-warped source image before orientation and crop; depth blur consumes this map directly"
        );
        Ok(result)
    }

    async fn cleanup(&mut self, params: &Value) -> Result<Value> {
        let session = self.session(params)?.clone();
        session.check_revision(params)?;
        let mode = required(params, "mode")?;
        if ![
            "clone",
            "heal",
            "retouch",
            "liquify",
            "inpaint",
            "generative",
        ]
        .contains(&mode)
        {
            return Err("INVALID_ARGUMENT: unknown retouch mode".into());
        }
        let generation_options = generation_options(params, mode)?;
        let removal_options = params
            .get("removal_options")
            .map(|value| {
                let options: crate::inpainting::removal::RemovalOptions =
                    serde_json::from_value(value.clone())
                        .map_err(|error| format!("INVALID_ARGUMENT: removal_options: {error}"))?;
                options.validate()?;
                Ok::<_, String>(options)
            })
            .transpose()?;
        let preview_only = match params.get("preview_only") {
            None => false,
            Some(value) => value
                .as_bool()
                .ok_or("INVALID_ARGUMENT: preview_only must be boolean")?,
        };
        if (removal_options.is_some() || preview_only) && !["inpaint", "generative"].contains(&mode)
        {
            return Err("INVALID_ARGUMENT: removal_options and preview_only require inpaint or generative mode".into());
        }

        let submasks = params["sub_masks"]
            .as_array()
            .ok_or("INVALID_ARGUMENT: sub_masks must be an array")?;
        if submasks.is_empty() || submasks.len() > 64 {
            return Err("INVALID_ARGUMENT: require 1..64 sub_masks".into());
        }
        if ["clone", "heal", "retouch", "liquify"].contains(&mode)
            && !submasks.iter().any(|m| m["type"] == mode)
        {
            return Err(format!(
                "INVALID_ARGUMENT: {mode} requires at least one submask of type '{mode}'"
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let name = params["name"].as_str().unwrap_or(mode);
        let mut patch = json!({"id":id,"name":name,"visible":true,"invert":false,"opacity":100,"prompt":params["prompt"].as_str().unwrap_or(""),"subMasks":submasks});
        if let Some(options) = &generation_options {
            patch["generationOptions"] = json!(options);
        }
        if let Some(options) = &removal_options {
            patch["removalOptions"] = json!(options);
        }
        let test_mask = json!({"id":id,"name":name,"visible":true,"invert":false,"adjustments":{},"subMasks":submasks});
        validation::validate_adjustments(&json!({"masks":[test_mask]}), session.dimensions)?;
        let source = if ["clone", "heal"].contains(&mode) {
            let point = params
                .get("source_point")
                .ok_or("INVALID_ARGUMENT: clone and heal require source_point")?;
            let dims = oriented_dimensions(&session);
            (
                number(point, "x", 0.0, 0.0, f64::from(dims.0))?,
                number(point, "y", 0.0, 0.0, f64::from(dims.1))?,
            )
        } else {
            (0.0, 0.0)
        };
        if mode == "inpaint" && !preview_only {
            self.ensure_models("inpaint", false).await?;
        }
        if mode == "generative" && !preview_only {
            let settings = crate::app_settings::load_settings(self.handle.clone())
                .map_err(|e| e.to_string())?;
            match settings.ai_provider.as_deref() {
                Some("cloud") => {}
                Some("ai-connector") if settings.ai_connector_address.as_deref().is_some_and(|s| !s.trim().is_empty()) => {}
                _ => return Err("GENERATION_NOT_CONFIGURED: Set aiProvider to cloud or ai-connector in workspace/engine-settings.json and restart the MCP connection; ai-connector also requires aiConnectorAddress".into()),
            }
            if generation_options.is_some()
                && settings.ai_provider.as_deref() != Some("ai-connector")
            {
                return Err(
                    "INVALID_ARGUMENT: generation_options require an AI Connector provider".into(),
                );
            }
            if settings.ai_provider.as_deref() == Some("cloud")
                && params["token"].as_str().is_none_or(str::is_empty)
            {
                return Err(
                    "INVALID_ARGUMENT: cloud generative retouch requires a request token".into(),
                );
            }
            let prompt_free_removal = generation_options
                .as_ref()
                .and_then(|options| options.profile.as_deref())
                == Some("qwen21-remove-v1");
            if prompt_free_removal
                && params["prompt"]
                    .as_str()
                    .is_some_and(|text| !text.trim().is_empty())
            {
                return Err("INVALID_ARGUMENT: Qwen Remove does not accept a text prompt".into());
            }
            if !prompt_free_removal
                && params["prompt"]
                    .as_str()
                    .is_none_or(|text| text.trim().is_empty())
            {
                return Err("INVALID_ARGUMENT: generative retouch requires a prompt".into());
            }
        }
        self.activate(&session.id).await?;
        let definition: AiPatchDefinition =
            serde_json::from_value(patch.clone()).map_err(|e| e.to_string())?;
        let state = self.handle.state::<AppState>();
        let adjustments = session.current().adjustments.clone();
        let encoded = match mode {
            "clone" | "heal" => {
                crate::inpainting::generate_manual_cleanup_patch(
                    definition,
                    adjustments,
                    source,
                    state,
                )
                .await?
            }
            "liquify" => {
                crate::inpainting::generate_liquify_patch(definition, adjustments, source, state)
                    .await?
            }
            "retouch" => {
                crate::inpainting::generate_retouch_patch(definition, adjustments, state).await?
            }
            "inpaint" | "generative" => {
                crate::inpainting::invoke_generative_replace_with_mask_def(
                    session.working_path.clone(),
                    definition,
                    adjustments,
                    mode == "inpaint",
                    Some(preview_only),
                    params["token"].as_str().map(str::to_string),
                    self.handle.clone(),
                    state,
                )
                .await?
            }
            _ => unreachable!(),
        };
        let data: Value =
            serde_json::from_str(&encoded).map_err(|e| format!("INVALID_PATCH_RESULT: {e}"))?;
        let bitmap = bitmap_from_url(
            data["mask"]
                .as_str()
                .ok_or("INVALID_PATCH_RESULT: missing mask bitmap")?,
        )?;
        if mask_statistics(&bitmap)["empty"] == true {
            return Err("EMPTY_MASK: Retouch generated no affected pixels".into());
        }
        if preview_only {
            return Ok(json!({"session_id":session.id,"revision":session.revision,
                "preview_only":true,"changed":false,"remote_generation":false,
                "mask_statistics":mask_statistics(&bitmap),"bounds":data["bounds"],
                "coordinate_space":"unoriented source pixels before crop",
                "image":image_reply(&bitmap)?,"removal_options":removal_options}));
        }
        let generation_receipt = data.get("generation").cloned();
        patch["patchData"] = data;
        let mut next = session.current().adjustments.clone();
        if !next["aiPatches"].is_array() {
            next["aiPatches"] = json!([]);
        }
        next["aiPatches"].as_array_mut().unwrap().push(patch);
        let mut result = self.commit(
            &session.id,
            next,
            session.current().metadata.clone(),
            &format!("Applied {mode} patch"),
        )?;
        result["patch_id"] = json!(id);
        result["mask_statistics"] = mask_statistics(&bitmap);
        result["image"] = image_reply(&bitmap)?;
        result["remote_generation"] = json!(mode == "generative");
        if let Some(generation) = generation_receipt {
            result["generation"] = generation;
        }
        if let Some(options) = removal_options {
            result["removal_options"] = json!(options);
        }
        if let Some(options) = generation_options {
            result["generation_options"] = json!(options);
        }
        Ok(result)
    }

    async fn denoise(&mut self, params: &Value) -> Result<Value> {
        let parent = self.session(params)?.clone();
        parent.check_revision(params)?;
        let method = params["method"].as_str().unwrap_or("ai");
        if !["ai", "bm3d"].contains(&method) {
            return Err("INVALID_ARGUMENT: denoise method must be ai or bm3d".into());
        }
        let intensity = number(params, "intensity", 50.0, 0.0, 100.0)? as f32 / 100.0;
        if intensity == 0.0 {
            let mut result = parent.info(true);
            result["changed"] = json!(false);
            result["parent_session_id"] = json!(parent.id);
            result["inherited_adjustments"] = json!(true);
            result["source_domain_preserved"] = json!(true);
            return Ok(result);
        }
        self.activate(&parent.id).await?;
        let state = self.handle.state::<AppState>();
        let source = state
            .original_image
            .lock()
            .unwrap()
            .as_ref()
            .ok_or("IMAGE_NOT_LOADED: No pristine source available for denoising")?
            .image
            .clone();
        let ai_session = if method == "ai" {
            self.ensure_models("denoise", false).await?;
            Some(
                ai::get_or_init_denoise_model(&self.handle, &state.ai_state, &state.ai_init_lock)
                    .await
                    .map_err(|e| e.to_string())?,
            )
        } else {
            None
        };
        let (image, normalization_range) = crate::denoising::denoise_source_image(
            &source,
            intensity,
            method,
            &self.handle,
            ai_session,
        )?;
        let result = self.derived(&parent, image, "Denoised source").await?;
        let id = required(&result, "session_id")?.to_string();
        // A float TIFF stores source pixels, not a baked display export. Retain
        // the parent rendering domain so AgX/LUTs/tonal edits still run once.
        let mut derived = self.sessions[&id].clone();
        derived.is_raw = parent.is_raw;
        self.persist(&derived)?;
        self.sessions.insert(id.clone(), derived);
        self.activate(&id).await?;
        let mut metadata = parent.current().metadata.clone();
        metadata["mcpSourceDomain"] = json!(if parent.is_raw { "linear-raw" } else { "srgb" });
        metadata["derivedFrom"] = json!({"session_id":parent.id,"revision":parent.revision,"operation":"denoise","method":method,"intensity":intensity*100.0,"source_domain_preserved":true,"normalization_range":normalization_range});
        self.commit(
            &id,
            parent.current().adjustments.clone(),
            metadata,
            "Inherited edits after denoise",
        )?;
        let mut result = self.sessions[&id].info(true);
        result["parent_session_id"] = json!(parent.id);
        result["inherited_adjustments"] = json!(true);
        result["source_domain_preserved"] = json!(true);
        result["normalization_range"] = json!(normalization_range);
        result["changed"] = json!(true);
        let mut warnings =
            vec!["Denoising can alter fine texture and local color; compare the result at 100%."];
        if parent.is_raw {
            warnings.push("This derived linear TIFF retains RAW rendering through the saved MCP session. Opening it independently in the RapidRAW GUI or another editor will not reproduce that interpretation from the rrdata alone; use MCP export for a portable display image.");
        }
        result["warnings"] = json!(warnings);
        Ok(result)
    }

    async fn merge_images(&mut self, params: &Value) -> Result<Value> {
        let kind = required(params, "kind")?;
        if !["hdr", "focus", "panorama"].contains(&kind) {
            return Err("INVALID_ARGUMENT: merge kind must be hdr, focus or panorama".into());
        }
        let sources = params["paths"]
            .as_array()
            .ok_or("INVALID_ARGUMENT: paths must be an array")?;
        if !(2..=100).contains(&sources.len()) {
            return Err("INVALID_ARGUMENT: merge requires 2..100 images".into());
        }
        let mut input_sessions = Vec::new();
        for source in sources {
            let path = source
                .as_str()
                .ok_or("INVALID_ARGUMENT: every merge path must be a string")?;
            let opened = self
                .open(&json!({"path":path,"inherit_sidecar":false}))
                .await?;
            input_sessions.push(self.sessions[opened["session_id"].as_str().unwrap()].clone());
        }
        let working = input_sessions
            .iter()
            .map(|s| s.working_path.clone())
            .collect();
        let state = self.handle.state::<AppState>();
        let image = match kind {
            "hdr" => {
                *state.hdr_result.lock().unwrap() = None;
                crate::merge_hdr(working, self.handle.clone(), state.clone()).await?;
                state
                    .hdr_result
                    .lock()
                    .unwrap()
                    .take()
                    .ok_or("MERGE_FAILED: HDR produced no image")?
            }
            "focus" => {
                *state.focus_stack_result.lock().unwrap() = None;
                crate::focus_stacking::stitch_focus_stack(
                    working,
                    self.handle.clone(),
                    state.clone(),
                )
                .await?;
                state
                    .focus_stack_result
                    .lock()
                    .unwrap()
                    .take()
                    .ok_or("MERGE_FAILED: Focus stack produced no image")?
            }
            "panorama" => {
                let handle = self.handle.clone();
                tokio::task::spawn_blocking(move || {
                    crate::panorama_stitching::stitch_panorama_for_mcp(working, handle)
                })
                .await
                .map_err(|error| format!("MERGE_FAILED: Panorama worker failed: {error}"))??
            }
            _ => unreachable!(),
        };
        let mut result = self
            .derived(&input_sessions[0], image, &format!("Merged {kind}"))
            .await?;
        let id = required(&result, "session_id")?.to_string();
        let parent_ids: Vec<String> = input_sessions.iter().map(|s| s.id.clone()).collect();
        let session = self.sessions[&id].clone();
        let mut metadata = session.current().metadata.clone();
        metadata["derivedFrom"] = json!({"session_ids":parent_ids,"operation":kind});
        self.commit(
            &id,
            session.current().adjustments.clone(),
            metadata,
            "Recorded merge inputs",
        )?;
        result = self.sessions[&id].info(true);
        result["parent_session_ids"] = json!(parent_ids);
        result["merge_kind"] = json!(kind);
        result["inherited_adjustments"] = json!(false);
        Ok(result)
    }

    async fn negative(&mut self, params: &Value) -> Result<Value> {
        let parent = self.session(params)?.clone();
        parent.check_revision(params)?;
        let parameters = params["parameters"]
            .as_object()
            .ok_or("INVALID_ARGUMENT: parameters must be an object")?;
        for key in parameters.keys() {
            if ![
                "red_weight",
                "green_weight",
                "blue_weight",
                "exposure",
                "contrast",
            ]
            .contains(&key.as_str())
            {
                return Err(format!(
                    "INVALID_ARGUMENT: unknown negative conversion parameter {key}"
                ));
            }
        }
        let raw = &params["parameters"];
        let settings = crate::negative_conversion::NegativeConversionParams {
            red_weight: number(raw, "red_weight", 1.0, 0.5, 2.0)? as f32,
            green_weight: number(raw, "green_weight", 1.0, 0.5, 2.0)? as f32,
            blue_weight: number(raw, "blue_weight", 1.0, 0.5, 2.0)? as f32,
            exposure: number(raw, "exposure", 0.0, -2.0, 2.0)? as f32,
            contrast: number(raw, "contrast", 1.0, 0.5, 2.5)? as f32,
        };
        self.activate(&parent.id).await?;
        let state = self.handle.state::<AppState>();
        let (source, _) = crate::get_original_image(&state)?;
        let image = crate::negative_conversion::run_pipeline(&source, &settings, None);
        let result = self
            .derived(&parent, image, "Converted film negative")
            .await?;
        let id = required(&result, "session_id")?.to_string();
        let session = self.sessions[&id].clone();
        let mut metadata = session.current().metadata.clone();
        metadata["derivedFrom"] = json!({"session_id":parent.id,"revision":parent.revision,"operation":"negative_convert","parameters":settings});
        self.commit(
            &id,
            session.current().adjustments.clone(),
            metadata,
            "Recorded negative conversion",
        )?;
        let mut result = self.sessions[&id].info(true);
        result["parent_session_id"] = json!(parent.id);
        result["inherited_adjustments"] = json!(false);
        Ok(result)
    }

    fn lens_profile(&mut self, params: &Value) -> Result<Value> {
        let session = self.session(params)?.clone();
        session.check_revision(params)?;
        let mode = params["mode"].as_str().unwrap_or("auto");
        if !["auto", "lookup"].contains(&mode) {
            return Err("INVALID_ARGUMENT: lens mode must be auto or lookup".into());
        }
        let state = self.handle.state::<AppState>();
        let maker = params["maker"].as_str();
        let model = params["model"].as_str();
        if mode == "lookup" {
            let Some(maker) = maker else {
                return Ok(json!({"makers":crate::lens_correction::get_lensfun_makers(state)?}));
            };
            let Some(model) = model else {
                return Ok(
                    json!({"maker":maker,"models":crate::lens_correction::get_lensfun_lenses_for_maker(maker.into(),state)?}),
                );
            };
            let focal = number(params, "focal_length", 50.0, 0.1, 10000.0)? as f32;
            let aperture = params
                .get("aperture")
                .map(|_| number(params, "aperture", 0.0, 0.1, 256.0).map(|v| v as f32))
                .transpose()?;
            let distance = params
                .get("distance")
                .map(|_| number(params, "distance", 0.0, 0.001, 1e9).map(|v| v as f32))
                .transpose()?;
            let profile = crate::lens_correction::get_lens_distortion_params(
                maker.into(),
                model.into(),
                focal,
                aperture,
                distance,
                state,
            )?;
            return Ok(json!({"maker":maker,"model":model,"focal_length":focal,"profile":profile}));
        }
        let mut adjustments = session.current().adjustments.clone();
        let mut exif = session.current().metadata["exif"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        for (key, field) in [
            ("focal_length", "FocalLength"),
            ("aperture", "FNumber"),
            ("distance", "SubjectDistance"),
        ] {
            if params.get(key).is_some() {
                exif.insert(
                    field.into(),
                    json!(number(params, key, 1.0, 0.001, 1e9)?.to_string()),
                );
            }
        }
        if let (Some(maker), Some(model)) = (maker, model) {
            adjustments["lensMaker"] = json!(maker);
            adjustments["lensModel"] = json!(model);
            adjustments["lensCorrectionMode"] = json!("manual");
        } else if maker.is_some() || model.is_some() {
            return Err(
                "INVALID_ARGUMENT: supply both maker and model, or neither for EXIF detection"
                    .into(),
            );
        } else {
            adjustments["lensCorrectionMode"] = json!("auto");
        }
        let exif: Option<std::collections::HashMap<String, String>> = Some(
            exif.into_iter()
                .filter_map(|(k, v)| v.as_str().map(|text| (k, text.to_string())))
                .collect(),
        );
        {
            let db = state.lens_db.lock().unwrap();
            crate::file_management::resolve_lens_params_in_adjustments(
                &mut adjustments,
                &exif,
                db.as_deref(),
            );
        }
        if !adjustments["lensDistortionParams"].is_object() {
            return Err("LENS_PROFILE_NOT_FOUND: No calibrated lens profile matches this image. Use lookup to inspect available makers and models.".into());
        }
        let profile = adjustments["lensDistortionParams"].clone();
        let mut result = self.commit(
            &session.id,
            adjustments,
            session.current().metadata.clone(),
            "Applied lens profile",
        )?;
        result["profile"] = profile;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generated_component_joins_existing_parent_in_requested_mode() {
        let mut mask = json!({"id":"parent","subMasks":[{"id":"depth","type":"ai-depth","mode":"additive","parameters":{"depthArtifact":"opaque-depth"}}]});
        let id = append_generated_submask(
            &mut mask,
            "subject",
            "intersect",
            json!({"maskDataBase64":"opaque-subject"}),
        )
        .unwrap();
        assert_eq!(mask["subMasks"].as_array().unwrap().len(), 2);
        assert_eq!(
            mask["subMasks"][0]["parameters"]["depthArtifact"],
            "opaque-depth"
        );
        assert_eq!(mask["subMasks"][1]["id"], id);
        assert_eq!(mask["subMasks"][1]["mode"], "intersect");
        assert_eq!(mask["subMasks"][1]["type"], "ai-subject");
        assert_eq!(
            mask["subMasks"][1]["parameters"]["maskDataBase64"],
            "opaque-subject"
        );
    }
    #[test]
    fn generation_options_require_explicit_generative_mode_and_valid_values() {
        assert!(generation_options(&json!({}), "inpaint").unwrap().is_none());
        let params =
            json!({"generation_options":{"seed":104729,"profile":"balanced","megapixels":2}});
        assert_eq!(
            generation_options(&params, "generative")
                .unwrap()
                .unwrap()
                .seed,
            Some(104729)
        );
        for mode in ["clone", "heal", "retouch", "liquify", "inpaint"] {
            assert!(generation_options(&params, mode).is_err());
        }
        for invalid in [
            json!({"seed":0}),
            json!({"seed":1.5}),
            json!({"seed":9007199254740992u64}),
            json!({"profile":"../model"}),
            json!({"megapixels":32}),
            json!({"unknown":1}),
            json!({"seed":null}),
            json!({"profile":null}),
            json!({"megapixels":null}),
            json!(null),
        ] {
            assert!(
                generation_options(&json!({"generation_options":invalid}), "generative").is_err()
            );
        }
    }
    #[test]
    fn subject_regions_are_validated_before_native_inference() {
        assert_eq!(
            region(
                &json!({"region":{"x":20,"y":10,"width":30,"height":40}}),
                (100, 80)
            )
            .unwrap(),
            ((20.0, 10.0), (50.0, 50.0))
        );
        assert!(
            region(
                &json!({"region":{"x":99,"y":10,"width":30,"height":40}}),
                (100, 80)
            )
            .is_err()
        );
        assert!(region(&json!({"region":{"width":0,"height":40}}), (100, 80)).is_err());
    }
    #[test]
    fn empty_mask_statistics_cannot_look_successful() {
        let mut mask = GrayImage::new(2, 2);
        assert_eq!(mask_statistics(&mask)["empty"], true);
        mask.put_pixel(0, 0, image::Luma([255]));
        assert_eq!(mask_statistics(&mask)["nonzero_fraction"], 0.25);
        assert_eq!(mask_statistics(&mask)["mean_opacity"], 0.25);
    }
}
