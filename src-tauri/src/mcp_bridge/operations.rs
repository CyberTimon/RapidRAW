use super::{
    EngineSettings, Result, flag, number, required,
    sessions::{Bridge, Session, atomic_write},
    validation,
};
use crate::{
    app_state::AppState,
    file_management::{Preset, PresetItem},
};
use serde_json::{Value, json};
use std::{fs, path::Path, sync::Arc};
use tauri::Manager;

pub(super) const METHODS: &[&str] = &[
    "enhancement_models",
    "install_enhancement_model",
    "enhance",
    "manage_presets",
    "manage_luts",
    "fork_session",
    "export_session_bundle",
    "import_session_bundle",
    "diff_versions",
    "copy_adjustments",
    "map_coordinates",
    "preflight",
    "sample_region",
    "inspect_adjustments",
    "render_compare",
    "save_version",
    "list_versions",
    "restore_version",
    "start_denoise",
    "get_job",
    "list_jobs",
    "cancel_job",
    "resume_job",
    "capabilities",
    "list_images",
    "open_photo",
    "list_sessions",
    "get_session",
    "close_session",
    "set_adjustments",
    "render",
    "analyze",
    "auto_adjust",
    "mask_create",
    "mask_duplicate",
    "mask_update",
    "mask_remove",
    "mask_generate",
    "retouch",
    "generate_depth",
    "history",
    "undo",
    "redo",
    "save_session",
    "load_recipe",
    "save_recipe",
    "list_presets",
    "apply_preset",
    "list_luts",
    "apply_lut",
    "models",
    "install_model",
    "batch_export",
    "export",
    "merge",
    "negative_convert",
    "get_metadata",
    "set_metadata",
    "get_engine_settings",
    "denoise",
    "lens_profile",
];

fn duplicate_mask_definition(source: &Value, params: &Value) -> Result<(Value, Vec<String>)> {
    let mut duplicate = source.clone();
    duplicate["id"] = json!(uuid::Uuid::new_v4().to_string());
    duplicate["name"] = json!(if params.get("name").is_some() {
        required(params, "name")?.to_string()
    } else {
        format!("{} copy", required(source, "name")?)
    });
    if flag(params, "invert", false)? {
        duplicate["invert"] = json!(!source["invert"].as_bool().unwrap_or(false));
    }
    if !flag(params, "copy_adjustments", false)? {
        duplicate["adjustments"] = json!({});
    }
    let submasks = duplicate["subMasks"]
        .as_array_mut()
        .ok_or("INVALID_MASK: subMasks must be an array")?;
    let mut ids = Vec::with_capacity(submasks.len());
    for submask in submasks {
        let id = uuid::Uuid::new_v4().to_string();
        submask["id"] = json!(id);
        ids.push(id);
    }
    Ok((duplicate, ids))
}

impl Bridge {
    pub async fn dispatch(&mut self, method: &str, params: Value) -> Result<Value> {
        if !params.is_object() {
            return Err("INVALID_ARGUMENT: params must be an object".into());
        }
        self.refresh_job_results()?;
        match method {
            "enhancement_models" => return Ok(self.enhancement_models()),
            "install_enhancement_model" => return self.install_enhancement_model(&params).await,
            "enhance" => return self.enhance(&params).await,
            "manage_presets" => return self.manage_presets(&params),
            "manage_luts" => return self.manage_luts(&params),
            "import_session_bundle" => return self.import_session_bundle(&params),
            "get_job" => return self.jobs.get(&params),
            "list_jobs" => return self.jobs.list(),
            "cancel_job" => return self.jobs.cancel(&params),
            "start_denoise" => return self.start_denoise_job(&params, false).await,
            "resume_job" => return self.start_denoise_job(&params, true).await,
            "capabilities" => {
                return Ok(
                    json!({"protocol_version":1,"engine":"RapidRAW","bridge_version":"1.2.0","methods":METHODS,"workspace":self.paths.root,"adjustment_schema":validation::adjustment_schema(),"coordinate_space":{"masks":"oriented full-resolution pixels before user crop","render_region":"output pixels after user crop, before preview resizing"},"precision":{"render":"float32 GPU / 16-bit readback","formats_16bit":["png","tiff"]},"persistence":"Every edit is saved atomically inside workspace; save_session writes native .rrdata beside the working copy.","originals":"Never overwritten. All source files copied to session workspace.","limits":{"masks":32,"history":32,"comparison_variants":4,"comparison_long_edge":2048,"concurrent_denoise_jobs":1,"request_bytes":67108864},"model_policy":"Local generation copies and verifies installed model assets. Only install_model can download missing assets. Only explicitly selected generative retouch can send image data to a connector."}),
                );
            }
            "get_engine_settings" => {
                return serde_json::to_value(&self.handle.state::<EngineSettings>().0)
                    .map_err(|e| e.to_string());
            }
            "list_images" => return list_images(&params),
            "open_photo" => return self.open(&params).await,
            "list_sessions" => {
                return Ok(
                    json!({"sessions":self.sessions.values().map(|s|s.info(false)).collect::<Vec<_>>(),"count":self.sessions.len()}),
                );
            }
            "list_presets" => {
                let mut items = presets(&self.handle)?;
                items.extend(self.workspace_presets()?);
                return Ok(json!({"presets":items}));
            }
            "list_luts" => {
                let mut items = crate::lut_processing::list_luts(self.handle.clone())?;
                items.extend(self.workspace_luts()?);
                return Ok(json!({"luts":items}));
            }
            "models" | "install_model" | "merge" => return self.advanced(method, &params).await,
            "batch_export" => return self.batch_export(&params).await,
            _ => {}
        }
        if !METHODS.contains(&method) {
            return Err(format!("METHOD_NOT_FOUND: {method}"));
        }
        let session = self.session(&params)?.clone();
        let id = session.id.clone();
        match method {
            "fork_session" => return self.fork_session(&session, &params),
            "export_session_bundle" => return self.export_session_bundle(&session, &params),
            "diff_versions" => return self.diff_versions(&session, &params),
            "copy_adjustments" => return self.copy_adjustments(&session, &params),
            "save_version" => return self.save_version(&session, &params),
            "list_versions" => return self.list_versions(&session),
            "restore_version" => return self.restore_version(&session, &params),
            "get_session" => return Ok(session.info(flag(&params, "include_adjustments", false)?)),
            "get_metadata" => {
                return Ok(
                    json!({"session_id":id,"revision":session.revision,"metadata":session.current().metadata}),
                );
            }
            "history" => {
                return Ok(
                    json!({"session_id":id,"revision":session.revision,"cursor":session.cursor,"entries":session.history.iter().enumerate().map(|(index,h)|json!({"index":index,"label":h.label,"current":index==session.cursor})).collect::<Vec<_>>()}),
                );
            }
            "close_session" => {
                self.persist(&session)?;
                self.sessions.remove(&id);
                if self.active.as_deref() == Some(&id) {
                    self.active = None;
                    let handle = self.handle.clone();
                    let working_path = session.working_path.clone();
                    tokio::task::spawn_blocking(move || {
                        let state = handle.state::<AppState>();
                        clear_closed_session_preview(&state, &working_path);
                    })
                    .await
                    .map_err(|error| format!("Could not close preview session: {error}"))?;
                }
                return Ok(
                    json!({"session_id":id,"closed":true,"saved":true,"restore":"Session is available on next bridge startup"}),
                );
            }
            "save_session" => return self.save_sidecar(&id),
            "save_recipe" => {
                let name = params["path"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("{id}-r{}.json", session.revision));
                let path = self.output_path(&name, "recipes")?;
                atomic_write(
                    &path,
                    &serde_json::to_vec_pretty(&session.current().adjustments)
                        .map_err(|e| e.to_string())?,
                    false,
                )?;
                return Ok(json!({"session_id":id,"revision":session.revision,"path":path}));
            }
            _ => {}
        }
        // All remaining calls inspect or mutate one active native image serially.
        session.check_revision(&params)?;
        self.activate(&id).await?;
        match method {
            "map_coordinates" => self.map_coordinates(&session, &params),
            "preflight" => self.preflight(&session, &params),
            "sample_region" => self.sample_region(&session, &params),
            "render_compare" => self.render_compare(&session, &params),
            "inspect_adjustments" => self.inspect_adjustments(&session, &params),
            "render" => self.render_response(&session, &params),
            "analyze" => self.analyze(&session, &params),
            "export" => self.export_photo(&session, &params),
            "set_adjustments" | "load_recipe" => {
                let patch = if method == "load_recipe" {
                    let path = Path::new(required(&params, "path")?);
                    serde_json::from_slice(
                        &fs::read(path).map_err(|e| format!("RECIPE_NOT_FOUND: {e}"))?,
                    )
                    .map_err(|e| format!("INVALID_RECIPE: {e}"))?
                } else {
                    params
                        .get("patch")
                        .cloned()
                        .ok_or("INVALID_ARGUMENT: patch is required")?
                };
                let mut adjustments = match params["mode"].as_str().unwrap_or("merge") {
                    "merge" => session.current().adjustments.clone(),
                    "replace" => validation::default_adjustments(),
                    _ => return Err("INVALID_ARGUMENT: mode must be merge or replace".into()),
                };
                validation::merge_patch(&mut adjustments, &patch)?;
                self.materialize_lut(&session, &mut adjustments)?;
                self.commit(&id, adjustments, session.current().metadata.clone(), method)
            }
            "auto_adjust" => {
                let suggestions = crate::image_processing::calculate_auto_adjustments(
                    self.handle.state::<AppState>(),
                )?;
                if !flag(&params, "apply", false)? {
                    return Ok(
                        json!({"session_id":id,"revision":session.revision,"suggestions":suggestions,"applied":false}),
                    );
                }
                let mut adjustments = session.current().adjustments.clone();
                validation::merge_patch(&mut adjustments, &suggestions)?;
                let mut result = self.commit(
                    &id,
                    adjustments,
                    session.current().metadata.clone(),
                    "Auto adjustments",
                )?;
                result["suggestions"] = suggestions;
                result["applied"] = json!(true);
                Ok(result)
            }
            "mask_create" | "mask_duplicate" | "mask_update" | "mask_remove" => {
                self.mask_edit(&session, method, &params)
            }
            "undo" | "redo" => {
                let mut updated = session.clone();
                if method == "undo" {
                    if updated.cursor == 0 {
                        return Err("HISTORY_BOUNDARY: No earlier edit to undo".into());
                    }
                    updated.cursor -= 1;
                } else {
                    if updated.cursor + 1 >= updated.history.len() {
                        return Err("HISTORY_BOUNDARY: No later edit to redo".into());
                    }
                    updated.cursor += 1;
                }
                updated.revision += 1;
                self.persist(&updated)?;
                let result = updated.info(false);
                self.sessions.insert(id, updated);
                Ok(result)
            }
            "set_metadata" => {
                let mut metadata = session.current().metadata.clone();
                if params.get("rating").is_some() {
                    let rating = number(&params, "rating", 0., 0., 5.)?;
                    if rating.fract() != 0. {
                        return Err("INVALID_ARGUMENT: rating must be integer".into());
                    }
                    metadata["rating"] = json!(rating as u8);
                }
                if let Some(tags) = params.get("tags") {
                    let array = tags
                        .as_array()
                        .ok_or("INVALID_ARGUMENT: tags must be strings")?;
                    if array.len() > 1000
                        || array
                            .iter()
                            .any(|v| v.as_str().is_none_or(|s| s.len() > 256))
                    {
                        return Err("INVALID_ARGUMENT: tags must contain up to1000 strings of at most256 bytes".into());
                    }
                    metadata["tags"] = tags.clone();
                }
                if let Some(exif) = params.get("exif") {
                    let exif = exif
                        .as_object()
                        .ok_or("INVALID_ARGUMENT: exif must be a string map")?;
                    if !metadata["exif"].is_object() {
                        metadata["exif"] = json!({});
                    }
                    for (key, value) in exif {
                        if value.as_str().is_none_or(|s| s.len() > 4096) {
                            return Err(
                                "INVALID_ARGUMENT: EXIF values must be strings up to4096 bytes"
                                    .into(),
                            );
                        }
                        metadata["exif"][key] = value.clone();
                    }
                }
                self.commit(
                    &id,
                    session.current().adjustments.clone(),
                    metadata,
                    "Metadata edit",
                )
            }
            "apply_lut" => {
                let mut adjustments = session.current().adjustments.clone();
                adjustments["lutPath"] = json!(required(&params, "path")?);
                adjustments["lutIntensity"] = json!(number(&params, "intensity", 100., 0., 100.)?);
                self.materialize_lut(&session, &mut adjustments)?;
                self.commit(
                    &id,
                    adjustments,
                    session.current().metadata.clone(),
                    "Apply LUT",
                )
            }
            "apply_preset" => {
                let preset_id = required(&params, "preset_id")?;
                let mut installed = presets(&self.handle)?;
                installed.extend(self.workspace_presets()?);
                let preset = installed
                    .into_iter()
                    .find(|p| p.id == preset_id)
                    .ok_or("PRESET_NOT_FOUND: Unknown preset id")?;
                let mut patch = preset.adjustments;
                if !patch.is_object() {
                    return Err("INVALID_PRESET: Adjustment object missing".into());
                }
                let migration_warnings = migrate_legacy_preset(&mut patch)?;
                if preset.include_masks == Some(false) {
                    patch.as_object_mut().unwrap().remove("masks");
                    patch.as_object_mut().unwrap().remove("aiPatches");
                }
                if preset.include_crop_transform == Some(false) {
                    for key in crate::cache_utils::GEOMETRY_KEYS.iter().copied().chain([
                        "crop",
                        "rotation",
                        "orientationSteps",
                        "flipHorizontal",
                        "flipVertical",
                        "aspectRatio",
                        "lensCorrectionMode",
                        "lensBlurDepthMap",
                        "lensBlurEnabled",
                    ]) {
                        patch.as_object_mut().unwrap().remove(key);
                    }
                }
                let intensity = number(&params, "intensity", 100., 0., 100.)? / 100.;
                let mut adjustments =
                    merge_preset_adjustments(&session.current().adjustments, patch, intensity)?;
                self.materialize_lut(&session, &mut adjustments)?;
                let mut result = self.commit(
                    &id,
                    adjustments,
                    session.current().metadata.clone(),
                    &format!("Preset {}", preset.name),
                )?;
                if !migration_warnings.is_empty() {
                    result["warnings"] = json!(migration_warnings);
                }
                Ok(result)
            }
            _ => self.advanced(method, &params).await,
        }
    }

    fn mask_edit(&mut self, session: &Session, method: &str, params: &Value) -> Result<Value> {
        let mut adjustments = session.current().adjustments.clone();
        let masks = adjustments["masks"]
            .as_array_mut()
            .ok_or("INVALID_ADJUSTMENTS: masks must be an array")?;
        let mut submask_ids = Vec::new();
        let mask_id = if method == "mask_create" {
            uuid::Uuid::new_v4().to_string()
        } else {
            required(params, "mask_id")?.to_string()
        };
        if method == "mask_create" {
            let kind = required(params, "type")?;
            if ![
                "radial",
                "linear",
                "brush",
                "flow",
                "color",
                "luminance",
                "all",
            ]
            .contains(&kind)
            {
                return Err("INVALID_ARGUMENT: Use mask_generate for AI selections".into());
            }
            let mut local = params
                .get("adjustments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            validation::resolve_curve_patch(&mut local, &params["adjustments"]);
            masks.push(json!({"id":mask_id,"name":params["name"].as_str().unwrap_or("Agent mask"),"visible":true,"invert":flag(params,"invert",false)?,"opacity":number(params,"opacity",100.,0.,100.)?,"adjustments":local,"subMasks":[{"id":uuid::Uuid::new_v4().to_string(),"type":kind,"visible":true,"invert":false,"opacity":100,"mode":"additive","parameters":params.get("parameters").cloned().unwrap_or_else(||json!({}))}]}));
        } else if method == "mask_duplicate" {
            let source_index = masks
                .iter()
                .position(|mask| mask["id"] == mask_id)
                .ok_or("MASK_NOT_FOUND: Unknown mask id")?;
            let (duplicate, ids) = duplicate_mask_definition(&masks[source_index], params)?;
            let new_id = required(&duplicate, "id")?.to_string();
            submask_ids = ids;
            masks.insert(source_index + 1, duplicate);
            let mut result = self.commit(
                &session.id,
                adjustments,
                session.current().metadata.clone(),
                method,
            )?;
            result["source_mask_id"] = json!(mask_id);
            result["mask_id"] = json!(new_id);
            result["submask_ids"] = json!(submask_ids);
            return Ok(result);
        } else {
            let index = masks
                .iter()
                .position(|m| m["id"].as_str() == Some(&mask_id))
                .ok_or("MASK_NOT_FOUND: Unknown mask id")?;
            if method == "mask_remove" {
                masks.remove(index);
            } else {
                if params.get("patch").is_none() && params.get("submask_operations").is_none() {
                    return Err("INVALID_ARGUMENT: Supply patch or submask_operations".into());
                }
                if let Some(patch) = params.get("patch") {
                    if !patch.is_object() {
                        return Err("INVALID_ARGUMENT: patch must be an object".into());
                    }
                    if patch.get("id").is_some() {
                        return Err("INVALID_ARGUMENT: A mask's id cannot be changed".into());
                    }
                    merge_object(&mut masks[index], patch);
                    validation::resolve_curve_patch(
                        &mut masks[index]["adjustments"],
                        &patch["adjustments"],
                    );
                }
                if let Some(operations) = params.get("submask_operations") {
                    submask_ids = super::geometry_review::apply_submask_operations(
                        &mut masks[index],
                        operations,
                    )?;
                }
            }
        }
        let mut result = self.commit(
            &session.id,
            adjustments,
            session.current().metadata.clone(),
            method,
        )?;
        result["mask_id"] = json!(mask_id);
        if !submask_ids.is_empty() {
            result["submask_ids"] = json!(submask_ids);
        }
        Ok(result)
    }

    pub(super) fn materialize_lut(&self, session: &Session, adjustments: &mut Value) -> Result<()> {
        let Some(path) = adjustments["lutPath"].as_str().map(str::to_string) else {
            return Ok(());
        };
        let source = Path::new(&path)
            .canonicalize()
            .map_err(|e| format!("LUT_NOT_FOUND: {e}"))?;
        let parsed = crate::lut_processing::parse_lut_file(source.to_string_lossy().as_ref())
            .map_err(|e| format!("INVALID_LUT: {e}"))?;
        let bytes = fs::read(&source).map_err(|e| e.to_string())?;
        let dir = self
            .paths
            .root
            .join("sessions")
            .join(&session.id)
            .join("assets");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let hash = blake3::hash(&bytes).to_hex().to_string();
        let name = format!(
            "{}.{}",
            hash,
            source
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("cube")
        );
        let target = dir.join(name);
        if !target.exists() {
            atomic_write(&target, &bytes, false)?;
        }
        adjustments["lutPath"] = json!(target);
        adjustments["lutSize"] = json!(parsed.size);
        adjustments["lutName"] = json!(source.file_name().unwrap_or_default().to_string_lossy());
        self.handle
            .state::<AppState>()
            .lut_cache
            .lock()
            .unwrap()
            .insert(target.to_string_lossy().into_owned(), Arc::new(parsed));
        Ok(())
    }

    async fn batch_export(&mut self, params: &Value) -> Result<Value> {
        let items = params["items"]
            .as_array()
            .filter(|a| !a.is_empty() && a.len() <= 500)
            .ok_or("INVALID_ARGUMENT: items must contain 1..500 exports")?;
        let options = params.get("options").cloned().unwrap_or_else(|| json!({}));
        if !options.is_object() {
            return Err("INVALID_ARGUMENT: options must be an object".into());
        }
        let mut results = Vec::new();
        for item in items {
            let mut args = options.clone();
            args["session_id"] = item["session_id"].clone();
            args["path"] = item["path"].clone();
            let result = async {
                let session = self.session(&args)?.clone();
                self.activate(&session.id).await?;
                self.export_photo(&session, &args)
            }
            .await;
            results.push(match result {Ok(value)=>json!({"ok":true,"result":value}),Err(error)=>json!({"ok":false,"session_id":args["session_id"],"path":args["path"],"error":error})});
        }
        let failed = results.iter().filter(|r| r["ok"] == false).count();
        Ok(
            json!({"ok":failed==0,"total":results.len(),"succeeded":results.len()-failed,"failed":failed,"results":results}),
        )
    }
}

/// Only clear the bridge's source when it still owns the shared editor state.
/// The gate excludes active preview readers; advancing the generation under it
/// invalidates their queued successors before any cache is cleared.
fn clear_closed_session_preview(state: &AppState, working_path: &str) -> bool {
    let _session = state
        .preview_session_gate
        .write()
        .unwrap_or_else(|error| error.into_inner());
    let still_active = state
        .original_image
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .is_some_and(|image| image.path == working_path);
    if !still_active {
        return false;
    }

    state.begin_preview_generation();
    crate::mask_generation::clear_component_mask_cache();
    *state.original_image.lock().unwrap() = None;
    *state.cached_preview.lock().unwrap() = None;
    *state.gpu_image_cache.lock().unwrap() = None;
    *state.full_warped_cache.lock().unwrap() = None;
    *state.patched_warped_cache.lock().unwrap() = None;
    *state.full_transformed_cache.lock().unwrap() = None;
    state.mask_cache.lock().unwrap().clear();
    state.patch_cache.lock().unwrap().clear();
    state.geometry_cache.lock().unwrap().clear();
    *state.denoise_result.lock().unwrap() = None;
    *state.hdr_result.lock().unwrap() = None;
    *state.panorama_result.lock().unwrap() = None;
    true
}

fn list_images(params: &Value) -> Result<Value> {
    let directory = Path::new(required(params, "path")?)
        .canonicalize()
        .map_err(|e| format!("SOURCE_NOT_FOUND: {e}"))?;
    if !directory.is_dir() {
        return Err("INVALID_ARGUMENT: path must be a directory".into());
    }
    let recursive = flag(params, "recursive", false)?;
    let offset = number(params, "offset", 0., 0., 1_000_000.)? as usize;
    let limit = number(params, "limit", 50., 1., 500.)? as usize;
    let mut paths = Vec::new();
    let walk = walkdir::WalkDir::new(&directory)
        .follow_links(false)
        .max_depth(if recursive { usize::MAX } else { 1 })
        .sort_by_file_name();
    for entry in walk {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().is_file() && crate::formats::is_supported_image_file(entry.path()) {
            paths.push(entry.into_path());
        }
    }
    let total = paths.len();
    let images=paths.into_iter().skip(offset).take(limit).map(|path|json!({"path":path,"bytes":fs::metadata(&path).map(|m|m.len()).unwrap_or(0),"is_raw":crate::formats::is_raw_file(&path),"has_sidecar":Path::new(&format!("{}.rrdata",path.display())).is_file()})).collect::<Vec<_>>();
    let next = offset + images.len();
    Ok(
        json!({"images":images,"total_count":total,"offset":offset,"has_more":next<total,"next_offset":if next<total {Some(next)}else{None}}),
    )
}

fn presets(handle: &tauri::AppHandle) -> Result<Vec<Preset>> {
    let mut out = Vec::new();
    for item in crate::file_management::load_presets(handle.clone())? {
        match item {
            PresetItem::Preset(p) => out.push(p),
            PresetItem::Folder(f) => out.extend(f.children),
        }
    }
    Ok(out)
}

/// Older installed presets retained controls for a removed inline negative engine.
/// Only an explicitly disabled legacy section is safe to discard; ordinary edits
/// and arbitrary unknown keys still use strict native schema validation.
pub(super) fn migrate_legacy_preset(patch: &mut Value) -> Result<Vec<String>> {
    let Some(enabled) = patch.get("enableNegativeConversion") else {
        return Ok(Vec::new());
    };
    if enabled != &Value::Bool(false) {
        return Err("INVALID_PRESET: Active or malformed legacy negative conversion cannot be applied as a preset. Use negative_convert explicitly, then apply a preset without obsolete negative controls.".into());
    }
    let fields = [
        "enableNegativeConversion",
        "filmBaseColor",
        "negativeRedBalance",
        "negativeGreenBalance",
        "negativeBlueBalance",
    ];
    let object = patch
        .as_object_mut()
        .ok_or("INVALID_PRESET: Adjustment object missing")?;
    let removed = fields
        .into_iter()
        .filter(|field| object.remove(*field).is_some())
        .collect::<Vec<_>>();
    Ok(vec![format!(
        "Ignored inactive legacy negative-conversion preset fields: {}",
        removed.join(", ")
    )])
}

fn merge_object(base: &mut Value, patch: &Value) {
    if let Some(map) = patch.as_object() {
        if !base.is_object() {
            *base = json!({});
        }
        for (key, value) in map {
            if value.is_null() {
                base.as_object_mut().unwrap().remove(key);
            } else {
                merge_object(&mut base[key], value);
            }
        }
    } else {
        *base = patch.clone();
    }
}

fn merge_preset_adjustments(base: &Value, mut patch: Value, intensity: f64) -> Result<Value> {
    let mut adjustments = base.clone();
    if intensity == 0. {
        return Ok(adjustments);
    }
    if intensity < 1. {
        let mut effective_base = base.clone();
        if patch["lutPath"]
            .as_str()
            .is_some_and(|path| !path.is_empty())
            && base["lutPath"].as_str().is_none_or(str::is_empty)
        {
            // A stored default strength has no effect until a LUT is present.
            effective_base["lutIntensity"] = json!(0);
        }
        // Paths and interpretation flags select the preset dependency at any
        // positive strength; this does not crossfade two different LUTs.
        interpolate_patch(&effective_base, &mut patch, intensity);
    }
    validation::merge_patch(&mut adjustments, &patch)?;
    Ok(adjustments)
}

fn interpolate_patch(base: &Value, patch: &mut Value, intensity: f64) {
    match patch {
        Value::Number(n) => {
            if let (Some(from), Some(to)) = (base.as_f64(), n.as_f64()) {
                *patch = json!(from + (to - from) * intensity);
            }
        }
        Value::Object(map) => {
            for (key, value) in map {
                interpolate_patch(&base[key], value, intensity);
            }
        }
        // Arrays carry curve and mask topology; select them as a complete structure.
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_state::{LoadedImage, PreviewIdentity, PreviewLane};
    use image::DynamicImage;
    use std::collections::HashMap;
    use std::sync::atomic::Ordering;

    #[test]
    fn duplicate_parent_preserves_selection_assets_but_gets_independent_ids() {
        let source = json!({"id":"parent","name":"Subject","visible":true,"invert":false,"adjustments":{"exposure":1},"subMasks":[{"id":"ai","type":"ai-subject","parameters":{"maskDataBase64":"opaque-bitmap"}},{"id":"brush","type":"brush","parameters":{"lines":[]}}]});
        let (duplicate, ids) =
            duplicate_mask_definition(&source, &json!({"name":"Environment","invert":true}))
                .unwrap();
        assert_ne!(duplicate["id"], source["id"]);
        assert_eq!(duplicate["name"], "Environment");
        assert_eq!(duplicate["invert"], true);
        assert_eq!(duplicate["adjustments"], json!({}));
        assert_eq!(
            duplicate["subMasks"][0]["parameters"],
            source["subMasks"][0]["parameters"]
        );
        assert_eq!(ids.len(), 2);
        assert_ne!(ids[0], ids[1]);
        assert_ne!(ids[0], "ai");
        assert_ne!(ids[1], "brush");
        assert_eq!(source["adjustments"]["exposure"], 1);

        let (graded, _) =
            duplicate_mask_definition(&source, &json!({"copy_adjustments":true})).unwrap();
        assert_eq!(graded["adjustments"], source["adjustments"]);
        assert_eq!(graded["invert"], false);
    }

    #[test]
    fn closing_active_source_invalidates_preview_without_clearing_another_source() {
        let state = AppState::default();
        let generation = state.begin_preview_generation();
        let old_preview = PreviewIdentity {
            generation,
            lane: PreviewLane::Main,
            revision: Some(1),
        };
        state.register_preview_intent(old_preview).unwrap();
        *state.original_image.lock().unwrap() = Some(LoadedImage {
            path: "closed-photo".into(),
            image: Arc::new(DynamicImage::new_rgb8(2, 2)),
            is_raw: false,
        });
        state.patch_cache.lock().unwrap().insert_group(
            "patch:old".into(),
            HashMap::from([("patchData".into(), json!({"color":"old"}))]),
        );

        assert!(clear_closed_session_preview(&state, "closed-photo"));
        assert!(state.original_image.lock().unwrap().is_none());
        assert!(state.patch_cache.lock().unwrap().is_empty());
        assert!(state.ensure_preview_identity(old_preview).is_err());

        *state.original_image.lock().unwrap() = Some(LoadedImage {
            path: "other-photo".into(),
            image: Arc::new(DynamicImage::new_rgb8(2, 2)),
            is_raw: false,
        });
        let current_generation = state.load_image_generation.load(Ordering::SeqCst);
        assert!(!clear_closed_session_preview(&state, "closed-photo"));
        assert_eq!(
            state.load_image_generation.load(Ordering::SeqCst),
            current_generation
        );
        assert_eq!(
            state.original_image.lock().unwrap().as_ref().unwrap().path,
            "other-photo"
        );
    }

    #[test]
    fn disabled_legacy_preset_controls_migrate_with_an_explicit_warning() {
        let mut patch = json!({"exposure":0.4,"enableNegativeConversion":false,"filmBaseColor":"#ff8800","negativeRedBalance":0,"negativeGreenBalance":0,"negativeBlueBalance":0});
        let warnings = migrate_legacy_preset(&mut patch).unwrap();
        assert_eq!(patch, json!({"exposure":0.4}));
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("enableNegativeConversion"));
        assert!(warnings[0].contains("negativeBlueBalance"));
        validation::merge_patch(&mut validation::default_adjustments(), &patch).unwrap();
    }
    #[test]
    fn active_legacy_negative_preset_is_rejected_without_changing_patch() {
        let mut patch = json!({"enableNegativeConversion":true,"filmBaseColor":"#ff8800"});
        let before = patch.clone();
        assert!(
            migrate_legacy_preset(&mut patch)
                .unwrap_err()
                .contains("negative_convert")
        );
        assert_eq!(patch, before);
    }
    #[test]
    fn legacy_preset_migration_does_not_accept_unrelated_unknown_controls() {
        let mut patch = json!({"enableNegativeConversion":false,"unknownControl":7});
        migrate_legacy_preset(&mut patch).unwrap();
        assert!(validation::merge_patch(&mut validation::default_adjustments(), &patch).is_err());
        let mut direct = json!({"enableNegativeConversion":false});
        assert!(validation::merge_patch(&mut validation::default_adjustments(), &direct).is_err());
        direct = json!({"filmBaseColor":"#ff8800"});
        assert!(migrate_legacy_preset(&mut direct).unwrap().is_empty());
        assert!(validation::merge_patch(&mut validation::default_adjustments(), &direct).is_err());
    }

    #[test]
    fn image_discovery_filters_sorts_and_paginates_without_following_links() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("b.JPG"), b"placeholder").unwrap();
        fs::write(dir.path().join("a.cr3"), b"placeholder").unwrap();
        fs::write(dir.path().join("a.cr3.rrdata"), b"{}").unwrap();
        fs::write(dir.path().join("notes.txt"), b"ignored").unwrap();
        fs::create_dir(dir.path().join("nested")).unwrap();
        fs::write(dir.path().join("nested/c.png"), b"placeholder").unwrap();
        let first = list_images(&json!({"path":dir.path(),"limit":1})).unwrap();
        assert_eq!(first["total_count"], 2);
        assert_eq!(first["images"].as_array().unwrap().len(), 1);
        assert_eq!(first["images"][0]["has_sidecar"], true);
        assert_eq!(first["next_offset"], 1);
        assert_eq!(first["has_more"], true);
        let second = list_images(&json!({"path":dir.path(),"limit":1,"offset":1})).unwrap();
        assert_eq!(second["has_more"], false);
        assert!(second["next_offset"].is_null());
        let recursive = list_images(&json!({"path":dir.path(),"recursive":true})).unwrap();
        assert_eq!(recursive["total_count"], 3);
        assert_eq!(fs::read(dir.path().join("a.cr3")).unwrap(), b"placeholder");
        assert_eq!(fs::read(dir.path().join("a.cr3.rrdata")).unwrap(), b"{}");
    }
    #[test]
    fn recursive_patch_deletion_preserves_siblings_and_replaces_arrays() {
        let mut original = json!({"adjustments":{"exposure":1,"contrast":4},"subMasks":[{"id":"old"}],"visible":true});
        merge_object(
            &mut original,
            &json!({"adjustments":{"exposure":null},"subMasks":[{"id":"new"}]}),
        );
        assert!(original["adjustments"].get("exposure").is_none());
        assert_eq!(original["adjustments"]["contrast"], 4);
        assert_eq!(original["subMasks"], json!([{"id":"new"}]));
        assert_eq!(original["visible"], true);
    }
    #[test]
    fn recursive_mask_patch_preserves_adjustments() {
        let mut m = json!({"id":"a","adjustments":{"exposure":1,"contrast":4}});
        merge_object(&mut m, &json!({"adjustments":{"exposure":0.5}}));
        assert_eq!(m["adjustments"]["contrast"], 4);
        assert_eq!(m["adjustments"]["exposure"], 0.5);
    }
    #[test]
    fn interpolates_numeric_controls_without_corrupting_masks() {
        let mut patch = json!({"exposure":2,"masks":[{"id":"new"}]});
        interpolate_patch(&json!({"exposure":0,"masks":[]}), &mut patch, 0.5);
        assert_eq!(patch["exposure"], 1.);
        assert_eq!(patch["masks"][0]["id"], "new");
    }

    #[test]
    fn new_lut_preset_fades_from_zero_and_preserves_omitted_corrections() {
        let mut base = validation::default_adjustments();
        base["exposure"] = json!(0.8);
        base["temperature"] = json!(-3);
        base["tint"] = json!(4);
        base["colorNoiseReduction"] = json!(22);
        base["sharpness"] = json!(17);
        base["contrast"] = json!(10);
        let preset = json!({"lutPath":"/example/film.cube","lutIntensity":60,"lutIsSceneReferred":true,"contrast":-4});
        let unchanged = base.clone();
        assert_eq!(
            merge_preset_adjustments(&base, preset.clone(), 0.).unwrap(),
            base
        );
        let half = merge_preset_adjustments(&base, preset.clone(), 0.5).unwrap();
        assert_eq!(half["lutIntensity"], 30.);
        assert_eq!(half["lutPath"], preset["lutPath"]);
        assert_eq!(half["lutIsSceneReferred"], true);
        assert_eq!(half["contrast"], 3.);
        for key in [
            "exposure",
            "temperature",
            "tint",
            "colorNoiseReduction",
            "sharpness",
            "curves",
            "masks",
        ] {
            assert_eq!(half[key], base[key], "omitted {key}");
        }
        let full = merge_preset_adjustments(&base, preset.clone(), 1.).unwrap();
        for (key, value) in preset.as_object().unwrap() {
            assert_eq!(&full[key], value, "exact full strength {key}");
        }
        assert_eq!(base, unchanged);
    }

    #[test]
    fn replacing_lut_selects_one_dependency_and_interpolates_its_scalar_strength() {
        let mut base = validation::default_adjustments();
        base["lutPath"] = json!("/example/old.cube");
        base["lutIntensity"] = json!(80);
        base["lutIsSceneReferred"] = json!(false);
        let preset =
            json!({"lutPath":"/example/new.cube","lutIntensity":60,"lutIsSceneReferred":true});
        let half = merge_preset_adjustments(&base, preset.clone(), 0.5).unwrap();
        assert_eq!(half["lutPath"], preset["lutPath"]);
        assert_eq!(half["lutIsSceneReferred"], true);
        assert_eq!(half["lutIntensity"], 70.);
        assert_eq!(merge_preset_adjustments(&base, preset, 0.).unwrap(), base);
    }
}
