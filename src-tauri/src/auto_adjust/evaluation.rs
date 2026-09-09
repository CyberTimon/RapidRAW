//! Reproducible evaluation on an explicitly supplied scratch-copy manifest.
use super::{AutoState, analysis, render, storage, types::*, worker};
use anyhow::{Result, ensure};
use serde::Deserialize;
use serde_json::json;
use std::{fs, path::PathBuf, time::Instant};
use tauri::Manager;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    paths: Vec<String>,
    output: PathBuf,
    #[serde(default)]
    options: Options,
    #[serde(default)]
    samples: Vec<String>,
}

pub fn run(app: &tauri::AppHandle, manifest_path: &str) -> Result<()> {
    let manifest: Manifest = serde_json::from_slice(&fs::read(manifest_path)?)?;
    manifest.options.controls.validate()?;
    for group in manifest.options.groups.values() {
        if let Some(controls) = &group.controls {
            controls.validate()?;
        }
    }
    ensure!(!manifest.paths.is_empty(), "No evaluation photos supplied");
    fs::create_dir_all(&manifest.output)?;
    let settings = crate::app_settings::load_settings(app.clone()).map_err(anyhow::Error::msg)?;
    let id = uuid::Uuid::new_v4().to_string();
    let entries = manifest
        .paths
        .iter()
        .map(|path| -> Result<Entry> {
            let (meta, _) = storage::metadata(path)?;
            Ok(Entry {
                path: path.clone(),
                fingerprint: storage::fingerprint(path, &settings)?,
                baseline: meta.adjustments.clone(),
                expected: meta.adjustments,
                applied: false,
                analysis: Analysis::default(),
                group_id: String::new(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let mut batch =
        Batch { id: id.clone(), version: VERSION.into(), options: manifest.options, entries, groups: vec![] };
    let state = app.state::<AutoState>();
    *state.progress.lock().unwrap() =
        Progress { id: id.clone(), batch_id: id.clone(), running: true, ..Progress::default() };
    let timer = Instant::now();
    worker::apply(app, &mut batch, &settings, false)?;
    let elapsed = timer.elapsed().as_secs_f64();
    let mut status = state.progress.lock().unwrap().clone();
    status.running = false;
    status.phase = "complete".into();
    let gpu = crate::gpu_processing::get_or_init_gpu_context(&app.state::<crate::AppState>(), app)
        .map_err(anyhow::Error::msg)?;
    let mut comparisons = Vec::new();
    for (index, e) in batch.entries.iter().enumerate() {
        if !manifest.samples.contains(&e.path) || !e.applied {
            continue;
        }
        let base = render::decode(&e.path, &settings)?;
        let before = render::preview(app, &e.path, &base, &gpu, super::correction::neutral(&e.baseline))?;
        let after = render::preview(app, &e.path, &base, &gpu, e.expected.clone())?;
        let final_stats = analysis::measure(
            &after.to_rgb8(),
            e.analysis.faces.clone(),
            e.analysis.iso,
            e.analysis.captured,
            e.analysis.reduced,
        );
        let original_file = format!("{index}-original.jpg");
        let after_file = format!("{index}-auto.jpg");
        before.to_rgb8().save(manifest.output.join(&original_file))?;
        after.to_rgb8().save(manifest.output.join(&after_file))?;
        let reference_path = PathBuf::from(format!("{}.reference.json", e.path));
        let saved_reference = reference_path.exists();
        let old_adjustments = if saved_reference {
            let meta: crate::image_processing::ImageMetadata =
                serde_json::from_slice(&fs::read(reference_path)?)?;
            meta.adjustments
        } else {
            crate::image_processing::auto_results_to_json(&crate::image_processing::perform_auto_analysis(
                &base,
            ))
        };
        let reference = render::preview(app, &e.path, &base, &gpu, old_adjustments)?;
        let reference_stats = analysis::measure(
            &reference.to_rgb8(),
            e.analysis.faces.clone(),
            e.analysis.iso,
            e.analysis.captured,
            e.analysis.reduced,
        );
        let legacy = format!("{index}-existing.jpg");
        reference.to_rgb8().save(manifest.output.join(&legacy))?;
        comparisons.push(json!({"photo":PathBuf::from(&e.path).file_name().unwrap().to_string_lossy(),"original":original_file,"auto":after_file,"existing":legacy,"savedReference":saved_reference,"before":e.analysis,"after":final_stats,"reference":reference_stats,"adjustments":e.expected}));
    }
    let report = json!({"version":VERSION,"batchId":id,"photos":batch.entries.len(),"elapsedSeconds":elapsed,"status":status,"groups":batch.groups,"comparisons":comparisons});
    storage::atomic(&manifest.output.join("report.json"), &serde_json::to_vec_pretty(&report)?)?;
    println!(
        "Auto evaluation completed: {} photos in {:.2} seconds; {} failures",
        batch.entries.len(),
        elapsed,
        status.failures.len()
    );
    ensure!(status.failures.is_empty(), "Evaluation reported per-photo failures; inspect report.json");
    Ok(())
}
