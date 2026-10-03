//! Headless pipeline benchmark (`rapidraw bench`). See bench/README.md.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tauri::Manager;

use crate::AppState;
use crate::perf_trace;

#[derive(Clone, Debug)]
pub struct BenchSession {
    pub source: String,
    pub adjustments: Option<String>,
    pub iters: usize,
    pub preview_dim: Option<u32>,
    pub phases: Vec<String>,
    pub gpu_sync: bool,
    pub json_out: Option<String>,
}

const PHASES: [&str; 5] = ["open", "style", "drag", "geometry", "full"];

pub fn parse_bench_args(args: &[String]) -> Result<BenchSession, String> {
    let mut iter = args.iter();
    let mut session = BenchSession {
        source: String::new(),
        adjustments: None,
        iters: 20,
        preview_dim: None,
        phases: PHASES.iter().map(|s| s.to_string()).collect(),
        gpu_sync: false,
        json_out: None,
    };
    while let Some(arg) = iter.next() {
        let mut value = |name: &str| {
            iter.next()
                .cloned()
                .ok_or_else(|| format!("Missing value for {}", name))
        };
        match arg.as_str() {
            "--adjustments" => session.adjustments = Some(value(arg)?),
            "--iters" => {
                session.iters = value(arg)?
                    .parse()
                    .map_err(|_| "Invalid --iters".to_string())?
            }
            "--preview-dim" => {
                session.preview_dim = Some(
                    value(arg)?
                        .parse()
                        .map_err(|_| "Invalid --preview-dim".to_string())?,
                )
            }
            "--phases" => {
                session.phases = value(arg)?
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .collect();
                if let Some(unknown) = session
                    .phases
                    .iter()
                    .find(|p| !PHASES.contains(&p.as_str()))
                {
                    return Err(format!(
                        "Unknown phase '{}'; expected a comma-separated subset of {}",
                        unknown,
                        PHASES.join(",")
                    ));
                }
            }
            "--gpu-sync" => session.gpu_sync = true,
            "--json" => session.json_out = Some(value(arg)?),
            s if !s.starts_with('-') && session.source.is_empty() => session.source = s.to_string(),
            other => return Err(format!("Unknown bench argument '{}'", other)),
        }
    }
    if session.source.is_empty() {
        return Err("Usage: rapidraw bench <image> [--adjustments file] [--iters n] [--preview-dim px] [--phases list] [--gpu-sync] [--json file]".into());
    }
    session.iters = session.iters.max(1);
    Ok(session)
}

#[derive(Default)]
struct Iteration {
    total: Duration,
    stages: BTreeMap<&'static str, Duration>,
}

#[derive(Default)]
struct Phase {
    iterations: Vec<Iteration>,
    extra: Vec<String>,
    output_hash: Option<String>,
}

impl Phase {
    fn record_output(&mut self, bytes: &[u8]) {
        if self.output_hash.is_none() {
            self.output_hash = Some(blake3::hash(bytes).to_hex().to_string());
        }
    }
}

fn measure<T>(phase: &mut Phase, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _ = perf_trace::take();
    let start = Instant::now();
    let out = f();
    let total = start.elapsed();
    let mut stages = BTreeMap::new();
    for (name, d) in perf_trace::take() {
        *stages.entry(name).or_insert(Duration::ZERO) += d;
    }
    phase.iterations.push(Iteration { total, stages });
    out
}

fn load_adjustments(session: &BenchSession) -> Result<Value, String> {
    let path = session
        .adjustments
        .clone()
        .unwrap_or_else(|| format!("{}.rrdata", session.source));
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) if session.adjustments.is_none() => {
            println!("No sidecar at {}, using default adjustments.", path);
            return Ok(json!({}));
        }
        Err(e) => return Err(format!("Failed to read {}: {}", path, e)),
    };
    let v: Value =
        serde_json::from_str(&text).map_err(|e| format!("Bad JSON in {}: {}", path, e))?;
    Ok(v.get("adjustments").cloned().unwrap_or(v))
}

fn with_exposure(adj: &Value, exposure: f64) -> Value {
    let mut a = adj.clone();
    if let Some(obj) = a.as_object_mut() {
        obj.insert("exposure".into(), json!(exposure));
    }
    a
}

fn with_style(adj: &Value, i: usize) -> Value {
    let mut a = adj.clone();
    let t = (i % 7) as f64;
    if let Some(obj) = a.as_object_mut() {
        obj.insert("exposure".into(), json!(0.1 * t - 0.3));
        obj.insert("contrast".into(), json!(5.0 * t));
        obj.insert("highlights".into(), json!(-10.0 * t));
        obj.insert("shadows".into(), json!(8.0 * t));
        obj.insert("saturation".into(), json!(3.0 * t - 10.0));
        obj.insert("vibrance".into(), json!(4.0 * t));
        obj.insert("clarity".into(), json!(6.0 * t));
        obj.insert("temperature".into(), json!(2.0 * t - 6.0));
    }
    a
}

fn with_rotation(adj: &Value, i: usize) -> Value {
    let mut a = adj.clone();
    if let Some(obj) = a.as_object_mut() {
        obj.insert("rotation".into(), json!(0.25 * ((i % 8) as f64 + 1.0)));
    }
    a
}

pub async fn run_headless_bench(
    session: BenchSession,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    perf_trace::configure(true, session.gpu_sync);

    let adjustments = load_adjustments(&session)?;
    let settings = crate::app_settings::load_settings(app_handle.clone()).unwrap_or_default();
    let preview_dim = session
        .preview_dim
        .unwrap_or_else(|| settings.editor_preview_resolution.unwrap_or(1920));
    let n = session.iters;
    let wants = |p: &str| session.phases.iter().any(|x| x == p);

    println!("RapidRAW pipeline bench");
    println!("  image        {}", session.source);
    println!(
        "  preview dim  {} px   live quality {}",
        preview_dim,
        settings.live_preview_quality.as_deref().unwrap_or("high")
    );
    println!(
        "  iterations   {}   gpu-sync attribution {}",
        n, session.gpu_sync
    );

    let mut phases: Vec<(&'static str, Phase)> = Vec::new();
    let gpu_adapter: String;

    {
        let mut phase = Phase::default();
        let state = app_handle.state::<AppState>();
        let t0 = Instant::now();
        let res =
            crate::image_loader::load_image(session.source.clone(), state, app_handle.clone())
                .await?;
        let cold = t0.elapsed();
        let mut stages = BTreeMap::new();
        for (name, d) in perf_trace::take() {
            *stages.entry(name).or_insert(Duration::ZERO) += d;
        }
        phase.iterations.push(Iteration {
            total: cold,
            stages,
        });
        phase.extra.push(format!(
            "cold decode {:.1} ms, image {}x{} raw={}",
            ms(cold),
            res.width,
            res.height,
            res.is_raw
        ));
        if let Some(loaded) = app_handle
            .state::<AppState>()
            .original_image
            .lock()
            .unwrap()
            .as_ref()
        {
            phase.record_output(loaded.image.as_bytes());
        }
        {
            let ctx = crate::gpu_processing::get_or_init_gpu_context(
                &app_handle.state::<AppState>(),
                &app_handle,
            )?;
            let info = ctx.adapter_info.clone();
            gpu_adapter = format!(
                "{} ({:?}, driver {} {})",
                info.name, info.backend, info.driver, info.driver_info
            );
            phase.extra.push(format!("GPU adapter: {}", gpu_adapter));
        }
        if wants("open") {
            phases.push(("open", phase));
        }
    }

    let handle = app_handle.clone();
    let job = move |adj: Value, interactive: bool| -> Result<Vec<u8>, String> {
        let state = handle.state::<AppState>();
        crate::process_preview_job(
            &handle,
            state,
            adj,
            interactive,
            Some(preview_dim),
            None,
            false,
            false,
            None,
        )
    };

    let first = {
        let mut phase = Phase::default();
        let bytes = measure(&mut phase, || job(adjustments.clone(), false))?;
        phase.record_output(&bytes);
        phase.extra.push(format!(
            "first editor frame {:.1} ms, {} bytes",
            ms(phase.iterations[0].total),
            bytes.len()
        ));
        phase
    };
    phases.push(("first", first));

    if wants("style") {
        let mut phase = Phase::default();
        let mut bytes = 0;
        for i in 0..n {
            let out = measure(&mut phase, || job(with_style(&adjustments, i), false))?;
            phase.record_output(&out);
            bytes = out.len();
        }
        phase.extra.push(format!("response {} bytes", bytes));
        phases.push(("style", phase));
    }

    if wants("drag") {
        let mut phase = Phase::default();
        let base = adjustments
            .get("exposure")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let mut bytes = 0;
        for i in 0..n {
            let out = measure(&mut phase, || {
                job(
                    with_exposure(&adjustments, base + 0.02 * (i as f64 + 1.0)),
                    true,
                )
            })?;
            phase.record_output(&out);
            bytes = out.len();
        }
        phase.extra.push(format!("response {} bytes", bytes));
        phases.push(("drag", phase));
    }

    if wants("geometry") {
        let mut phase = Phase::default();
        for i in 0..n.div_ceil(4).max(3) {
            let out = measure(&mut phase, || job(with_rotation(&adjustments, i), false))?;
            phase.record_output(&out);
        }
        phases.push(("geometry", phase));
        // Restore the untouched geometry so later phases start from warm caches.
        job(adjustments.clone(), false)?;
    }

    if wants("full") {
        let mut phase = Phase::default();
        let mut bytes = 0;
        for i in 0..(n / 5).max(3) {
            let adj = with_style(&adjustments, i);
            let path = session.source.clone();
            let h = app_handle.clone();
            let _ = perf_trace::take();
            let start = Instant::now();
            let resp = crate::generate_preview_for_path(path, adj, h).await?;
            let total = start.elapsed();
            let mut stages = BTreeMap::new();
            for (name, d) in perf_trace::take() {
                *stages.entry(name).or_insert(Duration::ZERO) += d;
            }
            let out = resp_bytes(resp);
            phase.record_output(&out);
            bytes = out.len();
            phase.iterations.push(Iteration { total, stages });
        }
        phase.extra.push(format!("full-res JPEG {} bytes", bytes));
        phases.push(("full", phase));
    }

    report(&phases);

    if let Some(out) = &session.json_out {
        // Settings that change rendered output, so compare-pipeline.mjs can flag runs
        // that are not comparable.
        let meta = json!({
            "image": session.source,
            "gpu_adapter": gpu_adapter,
            "preview_dim": preview_dim,
            "live_preview_quality": settings.live_preview_quality,
            "raw_highlight_compression": settings.raw_highlight_compression,
            "linear_raw_mode": settings.linear_raw_mode,
            "raw_preprocessing_color_nr": settings.raw_preprocessing_color_nr,
            "raw_preprocessing_sharpening": settings.raw_preprocessing_sharpening,
            "apply_preprocessing_to_non_raws": settings.apply_preprocessing_to_non_raws,
            "use_apple_raw9": settings.use_apple_raw9,
            "tonemapper_override_enabled": settings.tonemapper_override_enabled,
            "default_raw_tonemapper": settings.default_raw_tonemapper,
            "default_non_raw_tonemapper": settings.default_non_raw_tonemapper,
        });
        let mut doc: serde_json::Map<String, Value> = phases
            .iter()
            .map(|(name, p)| {
                let its: Vec<Value> = p
                    .iterations
                    .iter()
                    .map(|it| {
                        let stages: serde_json::Map<String, Value> = it
                            .stages
                            .iter()
                            .map(|(k, v)| (k.to_string(), json!(ms(*v))))
                            .collect();
                        json!({ "total_ms": ms(it.total), "stages": stages })
                    })
                    .collect();
                (
                    name.to_string(),
                    json!({ "iterations": its, "notes": p.extra, "output_blake3": p.output_hash }),
                )
            })
            .collect();
        doc.insert("_meta".to_string(), meta);
        std::fs::write(out, serde_json::to_string_pretty(&doc).unwrap())
            .map_err(|e| e.to_string())?;
        println!("\nWrote {}", out);
    }
    Ok(())
}

fn resp_bytes(resp: tauri::ipc::Response) -> Vec<u8> {
    match tauri::ipc::IpcResponse::body(resp) {
        Ok(tauri::ipc::InvokeResponseBody::Raw(b)) => b,
        Ok(tauri::ipc::InvokeResponseBody::Json(s)) => s.into_bytes(),
        Err(_) => Vec::new(),
    }
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[idx]
}

fn report(phases: &[(&'static str, Phase)]) {
    for (name, phase) in phases {
        let mut totals: Vec<f64> = phase.iterations.iter().map(|i| ms(i.total)).collect();
        totals.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "\n== {:<9} n={:<3} median {:>9.1} ms   p90 {:>9.1} ms   min {:>9.1} ms   max {:>9.1} ms",
            name,
            totals.len(),
            percentile(&totals, 0.5),
            percentile(&totals, 0.9),
            totals.first().copied().unwrap_or(0.0),
            totals.last().copied().unwrap_or(0.0)
        );
        for e in &phase.extra {
            println!("   {}", e);
        }
        if let Some(h) = &phase.output_hash {
            println!("   output blake3 {}", h);
        }
        let mut names: Vec<&'static str> = phase
            .iterations
            .iter()
            .flat_map(|i| i.stages.keys().copied())
            .collect();
        names.sort();
        names.dedup();
        let mut rows: Vec<(&str, f64, f64, usize)> = names
            .iter()
            .map(|n| {
                let mut v: Vec<f64> = phase
                    .iterations
                    .iter()
                    .map(|i| i.stages.get(n).map(|d| ms(*d)).unwrap_or(0.0))
                    .collect();
                let hits = phase
                    .iterations
                    .iter()
                    .filter(|i| i.stages.contains_key(n))
                    .count();
                v.sort_by(|a, b| a.partial_cmp(b).unwrap());
                (
                    *n,
                    percentile(&v, 0.5),
                    v.iter().sum::<f64>() / v.len() as f64,
                    hits,
                )
            })
            .collect();
        rows.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap());
        if !rows.is_empty() {
            println!(
                "   {:<34} {:>10} {:>10} {:>6}",
                "stage", "median ms", "mean ms", "hits"
            );
            for (n, med, mean, hits) in rows {
                println!("   {:<34} {:>10.2} {:>10.2} {:>6}", n, med, mean, hits);
            }
        }
    }
}
