use super::{AutoState, analysis, cache, groups, render, storage, types::*};
use crate::{app_settings::AppSettings, gpu_processing, image_processing::GpuContext};
use anyhow::{Result, ensure};
use tauri::Manager;

pub(super) fn phase(app: &tauri::AppHandle, name: &str, total: usize) {
    let state = app.state::<AutoState>();
    {
        let mut p = state.progress.lock().unwrap();
        p.phase = name.into();
        p.total = total;
        p.completed = 0;
    }
    state.publish(app);
}
pub(super) fn report(app: &tauri::AppHandle, path: &str, result: Result<()>) {
    let state = app.state::<AutoState>();
    {
        let mut p = state.progress.lock().unwrap();
        p.completed += 1;
        if let Err(e) = result {
            p.failures.insert(path.into(), e.to_string());
        }
    }
    state.publish(app);
}
pub fn apply(app: &tauri::AppHandle, batch: &mut Batch, settings: &AppSettings, resume: bool) -> Result<()> {
    let state = app.state::<AutoState>();
    let app_state = app.state::<crate::AppState>();
    let gpu = gpu_processing::get_or_init_gpu_context(&app_state, app).map_err(anyhow::Error::msg)?;
    if !resume {
        phase(app, "loadingModels", batch.entries.len());
        let reduced = match cache::prepare(app) {
            Ok(()) => false,
            Err(e) => {
                state
                    .progress
                    .lock()
                    .unwrap()
                    .warnings
                    .insert("models".into(), format!("Global correction only: {e}"));
                true
            }
        };
        phase(app, "analyzing", batch.entries.len());
        let mut good = Vec::new();
        for mut e in batch.entries.drain(..) {
            if state.cancelled() {
                break;
            }
            let outcome = cache::analyze(app, &e, settings, &gpu, reduced);
            match outcome {
                Ok(a) => {
                    e.analysis = a;
                    report(app, &e.path, Ok(()));
                    good.push(e);
                }
                Err(error) => report(app, &e.path, Err(error)),
            }
        }
        batch.entries = good;
        batch.groups = groups::establish(&mut batch.entries);
    }
    // Compute overrides on a copy: repeated tuning never mutates original group targets.
    let mut effective = batch.groups.clone();
    for g in &mut effective {
        if let Some(o) = batch.options.groups.get(&g.id) {
            if let Some(scene) = o.scene {
                g.scene = scene;
                g.target = analysis::default_target(
                    scene,
                    batch
                        .entries
                        .iter()
                        .any(|entry| entry.group_id == g.id && !entry.analysis.faces.is_empty()),
                );
            }
            if let Some(path) = &o.reference_path {
                ensure!(g.paths.contains(path), "Reference must belong to its lighting group");
                let base = render::decode(path, settings)?;
                let (meta, _) = storage::metadata(path)?;
                let view = render::preview(app, path, &base, &gpu, meta.adjustments)?;
                let source = batch.entries.iter().find(|e| &e.path == path).unwrap();
                let a = analysis::measure(
                    &view.to_rgb8(),
                    source.analysis.faces.clone(),
                    source.analysis.iso,
                    source.analysis.captured,
                    source.analysis.reduced,
                );
                g.target = a.subject.clamp(0.12, 0.7);
                g.warmth = a.warmth;
                g.tint = a.tint;
            }
        }
    }
    storage::save(app, batch)?;
    state.progress.lock().unwrap().groups = effective.clone();
    phase(app, "applying", batch.entries.len());
    std::thread::scope(|scope| -> Result<()> {
        let mut pending = batch
            .entries
            .first()
            .filter(|_| !state.cancelled())
            .map(|e| cache::prefetch(scope, e.path.clone(), settings.clone()));
        for index in 0..batch.entries.len() {
            if state.cancelled() {
                break;
            }
            let base = pending.take().unwrap().join().map_err(|_| anyhow::anyhow!("Auto decode failed"))?;
            // Bounded look-ahead overlaps decoding with current preview evaluation.
            pending = batch
                .entries
                .get(index + 1)
                .map(|e| cache::prefetch(scope, e.path.clone(), settings.clone()));
            let entry = &mut batch.entries[index];
            let g = effective
                .iter()
                .find(|g| g.id == entry.group_id)
                .ok_or_else(|| anyhow::anyhow!("Missing lighting group"))?;
            let controls = batch
                .options
                .groups
                .get(&g.id)
                .and_then(|o| o.controls.as_ref())
                .unwrap_or(&batch.options.controls);
            let outcome =
                base.and_then(|base| apply_one(app, &batch.id, entry, g, controls, settings, &gpu, &base));
            report(app, &entry.path, outcome);
        }
        Ok(())
    })?;
    Ok(())
}
#[allow(clippy::too_many_arguments)]
fn apply_one(
    app: &tauri::AppHandle,
    id: &str,
    e: &mut Entry,
    g: &Group,
    c: &Controls,
    settings: &AppSettings,
    gpu: &GpuContext,
    base: &image::DynamicImage,
) -> Result<()> {
    let state = app.state::<AutoState>();
    if state.protected.lock().unwrap().contains(&e.path) {
        state.progress.lock().unwrap().skipped.push(e.path.clone());
        return Ok(());
    }
    ensure!(
        storage::current_fingerprint(app, &e.path)? == e.fingerprint,
        "Source or decoding settings changed; start a new batch"
    );
    let (before, _) = storage::metadata(&e.path)?;
    if !storage::same(&before.adjustments, &e.expected) {
        state.progress.lock().unwrap().skipped.push(e.path.clone());
        return Ok(());
    }
    let mut result = render::refine(app, e, g, c, g.scene, base, gpu, id)?;
    if !result.is_object() {
        result = serde_json::json!({});
    }
    result["autoProvenance"] =
        serde_json::json!({"version":VERSION,"batchId":id,"groupId":g.id,"reduced":e.analysis.reduced});
    {
        let _lock = storage::WRITE_LOCK.lock().unwrap();
        if state.cancelled() || state.protected.lock().unwrap().contains(&e.path) {
            state.progress.lock().unwrap().skipped.push(e.path.clone());
            return Ok(());
        }
        let (mut meta, bytes) = storage::metadata(&e.path)?;
        if !storage::same(&meta.adjustments, &e.expected) {
            state.progress.lock().unwrap().skipped.push(e.path.clone());
            return Ok(());
        }
        ensure!(storage::current_fingerprint(app, &e.path)? == e.fingerprint, "Source changed during Auto");
        // Write-ahead journal makes an interrupted commit recoverable without guessing.
        let previous = e.clone();
        e.expected = result.clone();
        e.applied = true;
        storage::save_entry(app, id, e)?;
        meta.adjustments = result;
        if let Err(error) = storage::commit(&e.path, &meta, &bytes) {
            *e = previous;
            storage::save_entry(app, id, e)?;
            return Err(error);
        }
        state.progress.lock().unwrap().changed.push(e.path.clone());
        if e.analysis.reduced {
            state
                .progress
                .lock()
                .unwrap()
                .warnings
                .insert(e.path.clone(), "Global correction only; subject detection unavailable".into());
        }
        super::completion::sync(app, &e.path, &meta, settings);
    }
    super::completion::thumbnail(app, &e.path, settings, Some(gpu), Some(base));
    Ok(())
}
