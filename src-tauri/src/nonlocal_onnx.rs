//! Native ONNX Runtime backend for Nonlocal Bayer denoise (CPU + Linux CUDA).
//!
//! This module replaces the retired Python/PyTorch worker boundary. The
//! accepted strict policy for this milestone is: graph optimizations OFF,
//! CUDA TF32 OFF, explicit provider `cpu`|`cuda` with no silent fallback,
//! CUDA on Linux only. ORT CoreML is deliberately not routed here; direct
//! native CoreML is a separate follow-up milestone.
//!
//! The host-side conditioning pipeline ports
//! `denoise/rapidraw_denoise/pipeline.py` + `noise.py`
//! (stratified-haar-irls-v1, 320/40 tiling, RGBG order, one pass per tile)
//! into Rust. The Python package remains only as a development/reference
//! oracle and research tooling, never as a production runtime dependency.

use crate::denoising::DenoiseControl;
use anyhow::{Context, Result, bail, ensure};
use ndarray::Dimension as _;
use ort::{
    session::{Session, builder::GraphOptimizationLevel},
    tensor::TensorElementType,
    value::{Tensor, ValueType},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    time::Instant,
};

/// Accepted ONNX bundle model hash (`model.onnx`, packed sampler, FP32). It
/// is the reference export with the zero-bias nodes dropped and every dense
/// and grouped 1x1 convolution expressed as a MatMul
/// (`rapidraw_denoise.onnx_rewrite`, version `gemm-1x1-v2`), which passes the
/// frozen strict-FP32 gates against the reference export. The validated hash
/// feeds cache identity and provenance.
pub(crate) const ONNX_MODEL_SHA: &str =
    "ba788a97f247058ea03d14bbf2f289adc8f4666039f27d0d530e6f67d23dd73c";
/// Pinned source checkpoint lineage the bundle must record.
pub(crate) const SOURCE_CHECKPOINT_SHA: &str =
    "c16747d852b93a95908792cdbac901f89cca98e35b91ea7db6214de42fbd3cad";
/// Backend generation recorded in cache identity, job manifests and receipts.
pub(crate) const BACKEND_GENERATION: &str = "native-onnx-v1";
pub(crate) const ALGORITHM: &str = "nonlocal-raw-v1";

pub(crate) const TILE: usize = 320;
pub(crate) const HALO: usize = 40;
pub(crate) const CORE: usize = TILE - 2 * HALO;
const BLOCK: usize = 32;
/// Between-tile wall-clock guard, matching the retired worker's 30 minutes.
/// An active ORT call is not abortable; cancellation lands on tile boundaries.
const JOB_WALL_LIMIT_SECS: u64 = 1800;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Provider {
    Cpu,
    Cuda,
    Coreml,
}

impl Provider {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Provider::Cpu => "cpu",
            Provider::Cuda => "cuda",
            Provider::Coreml => "coreml",
        }
    }

    /// Backend generation owning predictions from this provider. ONNX CPU
    /// and Linux CUDA share `native-onnx-v1`; direct CoreML is
    /// `native-coreml-v1` (see `crate::nonlocal_coreml`).
    pub fn generation(self) -> &'static str {
        match self {
            Provider::Cpu | Provider::Cuda => BACKEND_GENERATION,
            Provider::Coreml => crate::nonlocal_coreml::COREML_BACKEND_GENERATION,
        }
    }
}

pub(crate) struct NativeConfig {
    pub bundle: PathBuf,
    pub provider: Provider,
    pub device_id: i32,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub mem_limit_mb: Option<usize>,
}

impl NativeConfig {
    pub fn provider_as_str(&self) -> &'static str {
        self.provider.as_str()
    }

    /// Device id for CUDA cache keys; null otherwise so CPU/CUDA keys differ.
    pub fn device_id_or_null(&self) -> Value {
        match self.provider {
            Provider::Cuda => json!(self.device_id),
            Provider::Cpu | Provider::Coreml => Value::Null,
        }
    }
}

/// Provider resolution for the Nonlocal denoiser. When
/// `RAPIDRAW_NONLOCAL_PROVIDER` is unset, the platform default is CUDA on
/// Linux, direct CoreML on macOS (both the validated accelerated backends),
/// and CPU on other platforms. An explicit value is honored strictly; CUDA
/// sessions fail at provider registration when the runtime libraries are
/// missing, so this never silently downgrades a request.
pub(crate) fn parse_provider(linux: bool, macos: bool, raw: Option<&str>) -> Result<Provider> {
    match raw.unwrap_or(if linux {
        "cuda"
    } else if macos {
        "coreml"
    } else {
        "cpu"
    }) {
        "cpu" => Ok(Provider::Cpu),
        "cuda" if linux => Ok(Provider::Cuda),
        "cuda" => bail!(
            "NONLOCAL_PROVIDER_UNSUPPORTED: CUDA inference is supported on Linux only; use cpu"
        ),
        "coreml" if macos => Ok(Provider::Coreml),
        "coreml" => bail!(
            "NONLOCAL_PROVIDER_UNSUPPORTED: CoreML inference is supported on macOS only; use cpu"
        ),
        other => bail!(
            "NONLOCAL_PROVIDER_INVALID: RAPIDRAW_NONLOCAL_PROVIDER must be cpu, cuda or coreml, got {other:?}"
        ),
    }
}

fn parse_device_id_value(raw: Option<&str>) -> Result<i32> {
    match raw {
        None => Ok(0),
        Some(text) => text.parse::<i32>().ok().filter(|id| *id >= 0).with_context(
            || "NONLOCAL_PROVIDER_INVALID: RAPIDRAW_ONNX_DEVICE_ID must be a nonnegative integer",
        ),
    }
}

fn parse_mem_limit_value(raw: Option<&str>) -> Result<Option<usize>> {
    match raw {
        None => Ok(None),
        Some(text) => text
            .parse::<usize>()
            .ok()
            .filter(|mb| *mb > 0 && mb.checked_mul(1024 * 1024).is_some())
            .map(Some)
            .with_context(|| {
                "NONLOCAL_PROVIDER_INVALID: RAPIDRAW_ONNX_GPU_MEM_LIMIT_MB must be a positive integer fitting the address space"
            }),
    }
}

/// Pure provider/device resolution over raw env values (no process-global
/// reads), so CPU/CoreML handling of CUDA-only settings is unit-testable.
/// CPU and CoreML ignore `RAPIDRAW_ONNX_DEVICE_ID` and
/// `RAPIDRAW_ONNX_GPU_MEM_LIMIT_MB` entirely; CUDA validates them strictly.
fn resolve_provider_config(
    provider: Provider,
    device_raw: Option<&str>,
    mem_raw: Option<&str>,
) -> Result<(i32, Option<usize>)> {
    match provider {
        Provider::Cpu | Provider::Coreml => Ok((0, None)),
        Provider::Cuda => Ok((
            parse_device_id_value(device_raw)?,
            parse_mem_limit_value(mem_raw)?,
        )),
    }
}

/// Strict provider selection from the environment without bundle validation.
/// Used to record the backend generation on new jobs and to reject
/// cross-family resume before any inference configuration is loaded.
pub(crate) fn provider_from_env() -> Result<Provider> {
    parse_provider(
        cfg!(target_os = "linux"),
        cfg!(target_os = "macos"),
        std::env::var("RAPIDRAW_NONLOCAL_PROVIDER").ok().as_deref(),
    )
}

/// Explicit native Nonlocal configuration. An explicit
/// `RAPIDRAW_NONLOCAL_BUNDLE` directory always wins (developer/manual use);
/// otherwise the provider bundle installed under `models_dir` is required —
/// this call never downloads. `model.onnx` + manifest is validated for
/// `cpu|cuda`, `packed.mlpackage` + manifest for `coreml` (see
/// `crate::nonlocal_coreml`). Sessions are built later ([`open_backend`]).
pub(crate) fn configuration_with_models(models_dir: Option<&Path>) -> Result<NativeConfig> {
    let provider = provider_from_env()?;
    let (device_id, mem_limit_mb) = resolve_provider_config(
        provider,
        std::env::var("RAPIDRAW_ONNX_DEVICE_ID").ok().as_deref(),
        std::env::var("RAPIDRAW_ONNX_GPU_MEM_LIMIT_MB")
            .ok()
            .as_deref(),
    )?;
    let (bundle, _) = crate::nonlocal_install::resolve_bundle(models_dir, provider)?;
    match provider {
        Provider::Cpu | Provider::Cuda => {
            validate_bundle(&bundle)?;
        }
        Provider::Coreml => {
            crate::nonlocal_coreml::validate_bundle(&bundle)?;
        }
    }
    Ok(NativeConfig {
        bundle,
        provider,
        device_id,
        mem_limit_mb,
    })
}

pub(crate) fn hash_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(hex::encode(hash.finalize()))
}

/// ORT runtime/build identity for cache keys and provenance.
pub(crate) fn ort_identity() -> String {
    ort::info().to_string()
}

fn manifest_string(manifest: &Value, key: &str) -> Result<String> {
    manifest
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .with_context(|| format!("NONLOCAL_BUNDLE_INVALID: manifest missing string {key:?}"))
}

fn manifest_i64(manifest: &Value, key: &str) -> Result<i64> {
    manifest
        .get(key)
        .and_then(|v| v.as_i64())
        .with_context(|| format!("NONLOCAL_BUNDLE_INVALID: manifest missing integer {key:?}"))
}

/// Fail-closed validation of the accepted bundle before any inference.
/// Checks manifest contract fields and requires the actual model file hash
/// to equal both the manifest record and the accepted hard pin.
pub(crate) fn validate_bundle(bundle: &Path) -> Result<BundleContract> {
    let manifest_path = bundle.join("manifest.json");
    let model_path = bundle.join("model.onnx");
    ensure!(
        manifest_path.is_file() && model_path.is_file(),
        "NONLOCAL_BUNDLE_INVALID: bundle must contain model.onnx + manifest.json"
    );
    let manifest: Value = serde_json::from_slice(&std::fs::read(&manifest_path)?)
        .context("NONLOCAL_BUNDLE_INVALID: manifest is not valid JSON")?;
    ensure!(
        manifest.get("manifest_version").and_then(|v| v.as_i64()) == Some(1),
        "NONLOCAL_BUNDLE_INVALID: manifest_version must be 1"
    );
    ensure!(
        manifest
            .get("checkpoint_pinned_match")
            .and_then(|v| v.as_bool())
            == Some(true),
        "NONLOCAL_BUNDLE_INVALID: checkpoint_pinned_match must be true"
    );
    ensure!(
        manifest
            .get("source_checkpoint_sha256")
            .and_then(|v| v.as_str())
            == Some(SOURCE_CHECKPOINT_SHA),
        "NONLOCAL_BUNDLE_INVALID: source checkpoint lineage mismatch"
    );
    // External-data layouts are rejected: the pinned bytes must be one file.
    if manifest.get("external_data").and_then(|v| v.as_bool()) == Some(true)
        || manifest
            .get("exporter")
            .and_then(|v| v.get("external_data"))
            .and_then(|v| v.as_bool())
            == Some(true)
    {
        bail!("NONLOCAL_BUNDLE_INVALID: external-data bundle layout not supported");
    }
    ensure!(
        manifest.get("diagnostic_shape").and_then(|v| v.as_bool()) != Some(true),
        "NONLOCAL_BUNDLE_INVALID: diagnostic-shape bundle rejected"
    );
    ensure!(
        manifest.get("precision").and_then(|v| v.as_str()) == Some("fp32"),
        "NONLOCAL_BUNDLE_INVALID: precision must be fp32"
    );
    ensure!(
        manifest_i64(&manifest, "tile")? == TILE as i64
            && manifest_i64(&manifest, "halo")? == HALO as i64
            && manifest_i64(&manifest, "retained_core")? == CORE as i64,
        "NONLOCAL_BUNDLE_INVALID: tile/halo/retained_core must be 320/40/240"
    );
    ensure!(
        manifest.get("cfa_order").and_then(|v| v.as_str()) == Some("RGBG"),
        "NONLOCAL_BUNDLE_INVALID: cfa_order must be RGBG"
    );
    let input_name = manifest_string(&manifest, "input_name")?;
    let output_name = manifest_string(&manifest, "output_name")?;
    ensure!(
        input_name == "raw_with_noise" && output_name == "denoised_raw",
        "NONLOCAL_BUNDLE_INVALID: unexpected model I/O names"
    );
    let shape = |key: &str, expected: &[i64]| -> Result<()> {
        let actual: Vec<i64> = manifest
            .get(key)
            .and_then(|v| v.as_array())
            .with_context(|| format!("NONLOCAL_BUNDLE_INVALID: manifest missing {key:?}"))?
            .iter()
            .map(|v| {
                v.as_i64()
                    .with_context(|| format!("NONLOCAL_BUNDLE_INVALID: {key:?} must be integers"))
            })
            .collect::<Result<_>>()?;
        ensure!(
            actual == expected,
            "NONLOCAL_BUNDLE_INVALID: {key:?} must be {expected:?}"
        );
        Ok(())
    };
    shape("input_shape", &[1, 8, TILE as i64, TILE as i64])?;
    shape("output_shape", &[1, 4, TILE as i64, TILE as i64])?;
    ensure!(
        manifest.get("input_dtype").and_then(|v| v.as_str()) == Some("float32")
            && manifest.get("output_dtype").and_then(|v| v.as_str()) == Some("float32"),
        "NONLOCAL_BUNDLE_INVALID: I/O dtypes must be float32"
    );
    let recorded = manifest_string(&manifest, "model_sha256")?;
    ensure!(
        recorded == ONNX_MODEL_SHA,
        "NONLOCAL_BUNDLE_INVALID: manifest model hash is not the accepted bundle"
    );
    let actual = hash_file(&model_path)?;
    ensure!(
        actual == recorded,
        "NONLOCAL_BUNDLE_INVALID: model file hash mismatch (modified graph rejected)"
    );
    Ok(BundleContract {
        model_path,
        model_sha256: actual,
        input_name,
        output_name,
    })
}

#[derive(Debug)]
pub(crate) struct BundleContract {
    pub model_path: PathBuf,
    /// Hash of the validated model file; always `ONNX_MODEL_SHA`.
    pub model_sha256: String,
    pub input_name: String,
    pub output_name: String,
}

fn expect_io_type(kind: &str, name: &str, ty: &ValueType, dims: &[usize]) -> Result<()> {
    match ty {
        ValueType::Tensor { ty, shape, .. } => {
            ensure!(
                *ty == TensorElementType::Float32,
                "NONLOCAL_BUNDLE_INVALID: {kind} {name:?} must be float32"
            );
            ensure!(
                shape.to_ixdyn().slice() == dims,
                "NONLOCAL_BUNDLE_INVALID: {kind} {name:?} must have static shape {dims:?}"
            );
            Ok(())
        }
        _ => bail!("NONLOCAL_BUNDLE_INVALID: {kind} {name:?} must be a tensor"),
    }
}

/// One ORT session per denoise job, reused for all tiles.
pub(crate) struct Backend {
    session: Session,
    pub input_name: String,
    pub provider: &'static str,
}

pub(crate) fn open_backend(config: &NativeConfig, contract: &BundleContract) -> Result<Backend> {
    // ort `commit()` returns `Ok(true)` on fresh init and `Ok(false)` when a
    // compatible global environment already exists (see ort 2.0
    // `OnceLock::try_insert_with_fallible`); only `Err` is a genuine failure.
    ort::init().with_name("Nonlocal").commit().map_err(|e| {
        anyhow::anyhow!("NONLOCAL_BACKEND_UNAVAILABLE: ORT runtime initialization failed: {e:#}")
    })?;
    let builder = Session::builder()?.with_optimization_level(GraphOptimizationLevel::Disable)?;
    #[cfg(target_os = "linux")]
    let builder = {
        if config.provider == Provider::Cuda {
            use ort::execution_providers::{
                ArenaExtendStrategy,
                cuda::{CUDAExecutionProvider, CuDNNConvAlgorithmSearch},
            };
            let mut ep = CUDAExecutionProvider::default()
                .with_device_id(config.device_id)
                .with_arena_extend_strategy(ArenaExtendStrategy::SameAsRequested)
                .with_conv_algorithm_search(CuDNNConvAlgorithmSearch::Heuristic)
                .with_tf32(false);
            if let Some(mb) = config.mem_limit_mb {
                ep = ep.with_memory_limit(mb * 1024 * 1024);
            }
            builder.with_execution_providers([ep.build().error_on_failure()])?
        } else {
            builder
        }
    };
    #[cfg(not(target_os = "linux"))]
    if config.provider == Provider::Cuda {
        bail!("NONLOCAL_PROVIDER_UNSUPPORTED: CUDA inference is supported on Linux only");
    }
    let session = builder
        .commit_from_file(&contract.model_path)
        .map_err(|e| anyhow::anyhow!("NONLOCAL_BACKEND_UNAVAILABLE: {e:#}"))?;
    ensure!(
        session.inputs.len() == 1 && session.outputs.len() == 1,
        "NONLOCAL_BUNDLE_INVALID: session must expose exactly one input and one output"
    );
    let input = &session.inputs[0];
    let output = &session.outputs[0];
    ensure!(
        input.name == contract.input_name,
        "NONLOCAL_BUNDLE_INVALID: session input {:?} != manifest contract",
        input.name
    );
    ensure!(
        output.name == contract.output_name,
        "NONLOCAL_BUNDLE_INVALID: session output {:?} != manifest contract",
        output.name
    );
    expect_io_type("input", &input.name, &input.input_type, &[1, 8, TILE, TILE])?;
    expect_io_type(
        "output",
        &output.name,
        &output.output_type,
        &[1, 4, TILE, TILE],
    )?;
    Ok(Backend {
        session,
        input_name: contract.input_name.clone(),
        provider: config.provider.as_str(),
    })
}

/// Backend-neutral single-tile predictor contract shared by the ONNX and
/// direct CoreML backends. The input is one conditioned `[8,320,320]` CHW
/// tile; the output is the denoised `[4,320,320]` CHW prediction. Backends
/// validate FP32 exact-shape finite input and output; they never retry on
/// another provider and errors propagate.
pub(crate) trait TilePredictor {
    fn predict_tile(&mut self, tile: &[f32]) -> Result<Vec<f32>>;
    // Only called from macOS-gated CoreML paths; the ONNX Linux path
    // records its provider through config instead.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn provider_name(&self) -> &'static str;
}

impl TilePredictor for Backend {
    /// Run one conditioned CHW tile through the ORT session.
    fn predict_tile(&mut self, tile: &[f32]) -> Result<Vec<f32>> {
        ensure!(
            tile.len() == 8 * TILE * TILE,
            "NONLOCAL_TILE_INVALID: conditioned tile must be [8,320,320]"
        );
        ensure!(
            tile.iter().all(|v| v.is_finite()),
            "NONLOCAL_TILE_INVALID: conditioned tile must be finite"
        );
        let array = ndarray::Array::from_shape_vec((1, 8, TILE, TILE), tile.to_vec())
            .map_err(|e| anyhow::anyhow!("NONLOCAL_TILE_INVALID: {e}"))?;
        let tensor = Tensor::from_array(array)?;
        let outputs = self
            .session
            .run(ort::inputs![self.input_name.as_str() => tensor])
            .map_err(|e| anyhow::anyhow!("NONLOCAL_INFERENCE_FAILED: {e:#}"))?;
        let (shape, values) = outputs[0]
            .try_extract_array::<f32>()
            .map(|a| (a.shape().to_vec(), a.into_owned()))
            .map_err(|e| anyhow::anyhow!("NONLOCAL_OUTPUT_INVALID: {e}"))?;
        ensure!(
            shape.as_slice() == [1, 4, TILE, TILE],
            "NONLOCAL_OUTPUT_INVALID: expected [1,4,320,320], got {shape:?}"
        );
        let values = values.into_raw_vec_and_offset().0;
        ensure!(
            values.len() == 4 * TILE * TILE && values.iter().all(|v| v.is_finite()),
            "NONLOCAL_OUTPUT_INVALID: output must be finite [1,4,320,320]"
        );
        Ok(values)
    }

    fn provider_name(&self) -> &'static str {
        self.provider
    }
}

// ---------------------------------------------------------------------------
// Conditioning pipeline (port of pipeline.py + noise.py; no ORT here).
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub(crate) struct ChannelDiagnostics {
    pub blocks: usize,
    pub valid_blocks: usize,
    pub fit_blocks: usize,
    pub intensity_span: f64,
    pub median_variance_ratio: f64,
    pub relative_mad: f64,
    pub weak_identifiability: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct NoiseProfile {
    pub shot: [f32; 4],
    pub read: [f32; 4],
    pub diagnostics: Vec<ChannelDiagnostics>,
    pub method: &'static str,
}

impl NoiseProfile {
    pub fn to_json(&self) -> Value {
        json!({
            "shot": self.shot,
            "read": self.read,
            "method": self.method,
            "diagnostics": self.diagnostics.iter().map(|d| json!({
                "blocks": d.blocks, "valid_blocks": d.valid_blocks,
                "fit_blocks": d.fit_blocks, "intensity_span": d.intensity_span,
                "median_variance_ratio": d.median_variance_ratio,
                "relative_mad": d.relative_mad,
                "weak_identifiability": d.weak_identifiability,
            })).collect::<Vec<_>>(),
        })
    }
}

fn median_sorted(sorted: &[f64]) -> f64 {
    let n = sorted.len();
    if n % 2 == 1 {
        sorted[n / 2]
    } else {
        (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
    }
}

fn median_f64(values: &mut [f64]) -> f64 {
    values.sort_by(|a, b| a.partial_cmp(b).expect("finite values"));
    median_sorted(values)
}

fn median_f32(values: &mut [f32]) -> f32 {
    values.sort_by(|a, b| a.partial_cmp(b).expect("finite values"));
    let n = values.len();
    if n % 2 == 1 {
        values[n / 2]
    } else {
        (values[n / 2 - 1] + values[n / 2]) / 2.0
    }
}

/// Nonnegative least squares for a 2-column design (Lawson-Hanson).
/// Matches `scipy.optimize.nnls` on this 2-variable problem.
fn nnls_2col(a0: &[f64], a1: &[f64], b: &[f64]) -> [f64; 2] {
    debug_assert_eq!(a0.len(), a1.len());
    debug_assert_eq!(a0.len(), b.len());
    let dot = |x: &[f64], y: &[f64]| x.iter().zip(y).map(|(u, v)| u * v).sum::<f64>();
    let cols: [&[f64]; 2] = [a0, a1];
    let mut x = [0.0f64, 0.0];
    let mut in_p = [false, false];
    for _ in 0..10 {
        // w = A^T (b - A x)
        let mut residual: Vec<f64> = b.to_vec();
        for j in 0..2 {
            if in_p[j] && x[j] != 0.0 {
                for (r, c) in residual.iter_mut().zip(cols[j]) {
                    *r -= c * x[j];
                }
            }
        }
        let mut w = [dot(cols[0], &residual), dot(cols[1], &residual)];
        for j in 0..2 {
            if in_p[j] {
                w[j] = f64::NEG_INFINITY;
            }
        }
        let j = if w[0] > w[1] { 0 } else { 1 };
        if w[j] <= 0.0 {
            break;
        }
        in_p[j] = true;
        // Inner loop: solve on P, pull back infeasible coordinates.
        for _ in 0..10 {
            let active: Vec<usize> = (0..2).filter(|j| in_p[*j]).collect();
            let mut s = [0.0f64, 0.0];
            match active.as_slice() {
                [j] => {
                    let denom = dot(cols[*j], cols[*j]);
                    s[*j] = if denom > 0.0 {
                        dot(cols[*j], b) / denom
                    } else {
                        0.0
                    };
                }
                [i, j] => {
                    let a00 = dot(cols[*i], cols[*i]);
                    let a01 = dot(cols[*i], cols[*j]);
                    let a11 = dot(cols[*j], cols[*j]);
                    let b0 = dot(cols[*i], b);
                    let b1 = dot(cols[*j], b);
                    let det = a00 * a11 - a01 * a01;
                    if det != 0.0 {
                        s[*i] = (b0 * a11 - b1 * a01) / det;
                        s[*j] = (a00 * b1 - a01 * b0) / det;
                    }
                }
                _ => break,
            }
            let feasible = active.iter().all(|j| s[*j] > 0.0);
            if feasible {
                for j in active {
                    x[j] = s[j];
                }
                break;
            }
            let mut alpha = f64::INFINITY;
            for j in &active {
                if s[*j] <= 0.0 {
                    let trial = x[*j] / (x[*j] - s[*j]);
                    if trial < alpha {
                        alpha = trial;
                    }
                }
            }
            if !alpha.is_finite() {
                break;
            }
            for j in 0..2 {
                x[j] += alpha * (s[j] - x[j]);
                if in_p[j] && x[j] <= 0.0 {
                    x[j] = 0.0;
                    in_p[j] = false;
                }
            }
        }
    }
    x
}

/// Split `len` indices into `groups` nearly-equal sections (np.array_split).
fn array_split(len: usize, groups: usize) -> Vec<(usize, usize)> {
    let mut out = Vec::with_capacity(groups);
    let base = len / groups;
    let rest = len % groups;
    let mut start = 0;
    for g in 0..groups {
        let size = base + usize::from(g < rest);
        out.push((start, start + size));
        start += size;
    }
    out
}

/// Blind per-plane Poisson-Gaussian fit (stratified-haar-irls-v1).
/// `packed` is plane-major [4,H,W] RGBG with signed normalized samples.
pub(crate) fn estimate_noise(packed: &[f32], height: usize, width: usize) -> Result<NoiseProfile> {
    ensure!(
        packed.len() == 4 * height * width,
        "NONLOCAL_NOISE_INVALID: expected four-plane packed RAW"
    );
    ensure!(
        packed.iter().all(|v| v.is_finite()),
        "NONLOCAL_NOISE_INVALID: expected finite packed RAW"
    );
    let mut shot = [0f32; 4];
    let mut read = [0f32; 4];
    let mut diagnostics = Vec::with_capacity(4);
    for c in 0..4 {
        let plane = &packed[c * height * width..(c + 1) * height * width];
        let (bh, bw) = (height / BLOCK * BLOCK, width / BLOCK * BLOCK);
        ensure!(
            bh.min(bw) >= BLOCK * 2,
            "NONLOCAL_NOISE_INVALID: noise estimation needs at least 64 x 64 packed pixels"
        );
        let (nby, nbx) = (bh / BLOCK, bw / BLOCK);
        let nblocks = nby * nbx;
        // Block means, diagonal-Haar variances (f32, as in the reference).
        let mut means = vec![0f32; nblocks];
        let mut variances = vec![0f32; nblocks];
        let mut textures = vec![0f32; nblocks];
        // Clipping fractions for the validity mask.
        let mut frac_ge = vec![0f32; nblocks];
        let mut frac_zero = vec![0f32; nblocks];
        for by in 0..nby {
            for bx in 0..nbx {
                let b = by * nbx + bx;
                let at = |y: usize, x: usize| plane[(by * BLOCK + y) * width + bx * BLOCK + x];
                let mut sum = 0f32;
                let mut n_ge = 0u32;
                let mut n_zero = 0u32;
                // 16x16 sub-bands of the 32x32 block.
                let mut hh = [0f32; 256];
                let mut low = [0f32; 256];
                for y in 0..16 {
                    for x in 0..16 {
                        let a = at(2 * y, 2 * x);
                        let bb = at(2 * y, 2 * x + 1);
                        let cc = at(2 * y + 1, 2 * x);
                        let d = at(2 * y + 1, 2 * x + 1);
                        hh[y * 16 + x] = (a - bb - cc + d) * 0.5;
                        low[y * 16 + x] = (a + bb + cc + d) * 0.25;
                    }
                }
                for y in 0..BLOCK {
                    for x in 0..BLOCK {
                        let v = at(y, x);
                        sum += v;
                        if v >= 0.995 {
                            n_ge += 1;
                        }
                        if v == 0.0 {
                            n_zero += 1;
                        }
                    }
                }
                let center = median_f32(&mut hh);
                let mut dev = [0f32; 256];
                for (d, h) in dev.iter_mut().zip(&hh) {
                    *d = (h - center).abs();
                }
                let mad = median_f32(&mut dev);
                variances[b] = (mad / 0.67448975f32).powi(2);
                means[b] = sum / 1024.0;
                // Low-frequency texture from first differences of `low`.
                let mut tsum = 0f32;
                for y in 0..15 {
                    for x in 0..16 {
                        let d = low[(y + 1) * 16 + x] - low[y * 16 + x];
                        tsum += d * d;
                    }
                }
                let mut t = tsum / 240.0;
                tsum = 0.0;
                for y in 0..16 {
                    for x in 0..15 {
                        let d = low[y * 16 + x + 1] - low[y * 16 + x];
                        tsum += d * d;
                    }
                }
                t += tsum / 240.0;
                textures[b] = t;
                frac_ge[b] = n_ge as f32 / 1024.0;
                frac_zero[b] = n_zero as f32 / 1024.0;
            }
        }
        let mut candidates: Vec<usize> = (0..nblocks)
            .filter(|b| frac_ge[*b] < 0.01 && frac_zero[*b] < 0.05 && variances[*b] > 0.0)
            .collect();
        ensure!(
            candidates.len() >= 12,
            "NONLOCAL_NOISE_INVALID: too few unclipped blocks; supply measured parameters"
        );
        candidates.sort_by(|a, b| {
            means[*a]
                .partial_cmp(&means[*b])
                .expect("finite block means")
        });
        let groups = array_split(candidates.len(), 12.min(candidates.len() / 4));
        let mut selected = Vec::new();
        for (start, end) in groups {
            let mut group: Vec<usize> = candidates[start..end].to_vec();
            group.sort_by(|a, b| {
                textures[*a]
                    .partial_cmp(&textures[*b])
                    .expect("finite texture")
            });
            let keep = 3.max(group.len() / 3);
            selected.extend(group.into_iter().take(keep));
        }
        let ids = selected;
        let xs: Vec<f64> = ids.iter().map(|b| means[*b] as f64).collect();
        let ys: Vec<f64> = ids.iter().map(|b| variances[*b] as f64).collect();
        let ones = vec![1.0f64; xs.len()];
        let mut weights = vec![1.0f64; xs.len()];
        let mut coef = [0.0f64, 0.0];
        for _ in 0..8 {
            let sw: Vec<f64> = weights.iter().map(|w| w.sqrt()).collect();
            let wa0: Vec<f64> = xs.iter().zip(&sw).map(|(x, s)| x * s).collect();
            let wa1: Vec<f64> = ones.iter().zip(&sw).map(|(o, s)| o * s).collect();
            let wb: Vec<f64> = ys.iter().zip(&sw).map(|(y, s)| y * s).collect();
            coef = nnls_2col(&wa0, &wa1, &wb);
            let pred: Vec<f64> = xs
                .iter()
                .map(|x| (coef[0] * x + coef[1]).max(1e-10))
                .collect();
            let residual: Vec<f64> = ys.iter().zip(&pred).map(|(y, p)| (y - p) / p).collect();
            let mut centered = residual.clone();
            let med = median_f64(&mut centered);
            let mut abs_dev: Vec<f64> = residual.iter().map(|r| (r - med).abs()).collect();
            let scale = (median_f64(&mut abs_dev) * 1.4826).max(1e-10);
            let mut wmax = 0.0f64;
            for (w, (r, p)) in weights.iter_mut().zip(residual.iter().zip(&pred)) {
                *w = (1.345 * scale / r.abs().max(1e-12)).min(1.0) / (p * p);
                wmax = wmax.max(*w);
            }
            for w in weights.iter_mut() {
                *w /= wmax;
            }
        }
        let (s, r) = (coef[0] as f32, (coef[1] as f32).max(1e-10));
        shot[c] = s;
        read[c] = r;
        let pred: Vec<f64> = xs.iter().map(|x| coef[0] * x + coef[1]).collect();
        let ratios: Vec<f64> = ys.iter().zip(&pred).map(|(y, p)| y / p).collect();
        let mads: Vec<f64> = ys
            .iter()
            .zip(&pred)
            .map(|(y, p)| ((y - p) / p).abs())
            .collect();
        let mut ratios_sorted = ratios.clone();
        let mut mads_sorted = mads.clone();
        let span = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max)
            - xs.iter().cloned().fold(f64::INFINITY, f64::min);
        diagnostics.push(ChannelDiagnostics {
            blocks: nblocks,
            valid_blocks: candidates.len(),
            fit_blocks: ids.len(),
            intensity_span: span,
            median_variance_ratio: median_sorted({
                ratios_sorted.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
                &ratios_sorted
            }),
            relative_mad: median_sorted({
                mads_sorted.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
                &mads_sorted
            }),
            weak_identifiability: span < 0.05 || s == 0.0,
        });
        ensure!(
            shot[c].is_finite() && read[c].is_finite() && shot[c] >= 0.0 && read[c] >= 0.0,
            "NONLOCAL_NOISE_INVALID: nonfinite noise fit"
        );
    }
    for c in 0..4 {
        ensure!(
            shot[c] + read[c] > 0.0,
            "NONLOCAL_NOISE_INVALID: every channel needs nonzero noise variance"
        );
    }
    Ok(NoiseProfile {
        shot,
        read,
        diagnostics,
        method: "stratified-haar-irls-v1",
    })
}

/// Build the 8-channel conditioned input: clip(packed,0,1) then
/// sqrt(max(variance,1e-12)) from the ORIGINAL signed packed values.
pub(crate) fn conditioned_input(
    packed: &[f32],
    height: usize,
    width: usize,
    profile: &NoiseProfile,
) -> Vec<f32> {
    let plane = height * width;
    let mut out = vec![0f32; 8 * plane];
    for c in 0..4 {
        for i in 0..plane {
            let v = packed[c * plane + i];
            out[c * plane + i] = v.clamp(0.0, 1.0);
            let var = profile.shot[c] * v.max(0.0) + profile.read[c];
            out[(4 + c) * plane + i] = var.max(1e-12).sqrt();
        }
    }
    out
}

fn reflect_index(p: usize, halo: usize, n: usize, pad_after: usize) -> usize {
    let total = halo + n + pad_after;
    debug_assert!(p < total);
    let period = 2 * (n - 1);
    let d = p as i64 - halo as i64;
    let mut folded = d.rem_euclid(period as i64);
    if folded >= n as i64 {
        folded = period as i64 - folded;
    }
    folded as usize
}

/// Reflect-pad CHW exactly like `np.pad(..., mode="reflect")`.
/// Returns (padded, padded_h, padded_w, ny, nx).
pub(crate) fn reflect_pad(
    src: &[f32],
    channels: usize,
    height: usize,
    width: usize,
    tile: usize,
    halo: usize,
) -> (Vec<f32>, usize, usize, usize, usize) {
    let core = tile - 2 * halo;
    let ny = height.div_ceil(core);
    let nx = width.div_ceil(core);
    let (ph, pw) = (ny * core + 2 * halo, nx * core + 2 * halo);
    let pad_bottom = ny * core - height + halo;
    let pad_right = nx * core - width + halo;
    let mut out = vec![0f32; channels * ph * pw];
    for c in 0..channels {
        for y in 0..ph {
            let sy = reflect_index(y, halo, height, pad_bottom);
            for x in 0..pw {
                let sx = reflect_index(x, halo, width, pad_right);
                out[(c * ph + y) * pw + x] = src[(c * height + sy) * width + sx];
            }
        }
    }
    (out, ph, pw, ny, nx)
}

pub(crate) struct PackResult {
    /// Denoised [4,H,W] plane-major prediction.
    pub prediction: Vec<f32>,
    pub profile: NoiseProfile,
    pub elapsed_secs: f64,
}

/// Full conditioning + tiled native inference, shared by the ONNX and direct
/// CoreML backends through [`TilePredictor`]. `packed` is plane-major
/// [4,H,W]. Cancellation and the 30-minute wall guard land on tile
/// boundaries: an active backend prediction is not abortable.
pub(crate) fn denoise_packed<P: TilePredictor>(
    backend: &mut P,
    packed: &[f32],
    height: usize,
    width: usize,
    control: &DenoiseControl,
) -> Result<PackResult> {
    ensure!(
        packed.len() == 4 * height * width,
        "NONLOCAL_INPUT_INVALID: packed shape mismatch"
    );
    let started = Instant::now();
    control.check().map_err(anyhow::Error::msg)?;
    let profile = estimate_noise(packed, height, width)?;
    let conditioned = conditioned_input(packed, height, width, &profile);
    let (padded, ph, pw, ny, nx) = reflect_pad(&conditioned, 8, height, width, TILE, HALO);
    let mut out = vec![0f32; 4 * height * width];
    for ty in 0..ny {
        for tx in 0..nx {
            control.check().map_err(anyhow::Error::msg)?;
            if started.elapsed().as_secs() > JOB_WALL_LIMIT_SECS {
                bail!("NONLOCAL_TIMEOUT: inference exceeded 30 minutes");
            }
            let mut tile = vec![0f32; 8 * TILE * TILE];
            for c in 0..8 {
                for y in 0..TILE {
                    let src_row = &padded[(c * ph + ty * CORE + y) * pw + tx * CORE..][..TILE];
                    tile[(c * TILE + y) * TILE..(c * TILE + y) * TILE + TILE]
                        .copy_from_slice(src_row);
                }
            }
            let pred = backend.predict_tile(&tile)?;
            let (cy, cx) = (height - ty * CORE, width - tx * CORE);
            let (cy, cx) = (cy.min(CORE), cx.min(CORE));
            for c in 0..4 {
                for y in 0..cy {
                    let src_row = &pred[(c * TILE + HALO + y) * TILE + HALO..][..cx];
                    out[((c * height + ty * CORE + y) * width + tx * CORE)..][..cx]
                        .copy_from_slice(src_row);
                }
            }
            let done = (ty * nx + tx + 1) as f32;
            control.report(0.1 + done / (ny * nx) as f32 * 0.8, "Nonlocal inference");
        }
    }
    ensure!(
        out.iter().all(|v| v.is_finite()),
        "NONLOCAL_OUTPUT_INVALID: nonfinite inference result"
    );
    Ok(PackResult {
        prediction: out,
        profile,
        elapsed_secs: started.elapsed().as_secs_f64(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

    fn test_control() -> DenoiseControl {
        DenoiseControl {
            cancelled: Arc::new(AtomicBool::new(false)),
            progress: Arc::new(|_, _| {}),
        }
    }

    /// Bit-exact procedural golden image, reproducible in the Python oracle
    /// with the same f32 expression order (see module docs for the formula).
    fn golden_packed() -> (Vec<f32>, usize, usize) {
        const H: usize = 128;
        const W: usize = 128;
        let mut packed = vec![0f32; 4 * H * W];
        for c in 0..4 {
            for y in 0..H {
                for x in 0..W {
                    let k = ((x * 7 + y * 13 + c * 11) % 64) as f32;
                    let idx = ((c * H + y) * W + x) as u64;
                    let n01 = ((((idx * 1103515245 + 12345) >> 16) % 1024) as f32) / 1024.0;
                    let base = 0.15f32 + 0.5 * (x as f32 / 128.0) + 0.1 * (k / 64.0);
                    let scale = 0.9f32 + 0.05 * c as f32;
                    let noise = ((n01 - 0.5) * 0.04) * (0.3 + base);
                    packed[(c * H + y) * W + x] = base * scale + noise;
                }
            }
        }
        (packed, H, W)
    }

    #[test]
    #[allow(clippy::excessive_precision)]
    fn golden_input_is_bit_exact() {
        // Guard the oracle contract: exact samples from the Python run.
        let (packed, h, w) = golden_packed();
        assert_eq!((h, w), (128, 128));
        let at = |c: usize, y: usize, x: usize| packed[(c * h + y) * w + x];
        assert_eq!(at(0, 0, 0), 0.12600000202655792f32);
        assert_eq!(at(1, 0, 1), 0.16993582248687744f32);
        assert_eq!(at(3, 127, 127), 0.6866649389266968f32);
        assert_eq!(at(2, 64, 64), 0.4387066960334778f32);
    }

    #[test]
    fn noise_profile_matches_python_oracle() {
        let (packed, h, w) = golden_packed();
        let profile = estimate_noise(&packed, h, w).unwrap();
        assert_eq!(profile.method, "stratified-haar-irls-v1");
        let expected_shot = [
            0.0010845984621192875,
            0.001048926412256982,
            0.0009957114631825045,
            0.00093253112591397,
        ];
        for (c, (((shot, read), diag), expected)) in profile
            .shot
            .iter()
            .zip(profile.read.iter())
            .zip(profile.diagnostics.iter())
            .zip(expected_shot.iter())
            .enumerate()
        {
            let diff = (*shot as f64 - *expected).abs();
            assert!(
                diff <= 1e-9 + 1e-6 * expected.abs(),
                "channel {c} shot mismatch: {shot} vs {expected}"
            );
            assert!(
                *read == 1e-10,
                "channel {c} read should hit the 1e-10 floor"
            );
            assert_eq!(
                (diag.blocks, diag.valid_blocks, diag.fit_blocks),
                (16, 16, 12)
            );
            assert!(!diag.weak_identifiability);
        }
        let expected_spans = [
            0.3378317207098007,
            0.356661781668663,
            0.3755858540534973,
            0.3939673602581024,
        ];
        let expected_ratios = [
            0.9873515889325565,
            0.9745000875273072,
            0.9831969203747892,
            0.993472930359977,
        ];
        for c in 0..4 {
            let d = &profile.diagnostics[c];
            // Means accumulate sequentially in f32 here vs pairwise in
            // NumPy (~3e-7); tolerances cover summation order, not method.
            assert!(
                (d.intensity_span - expected_spans[c]).abs() < 1e-6,
                "channel {c} span mismatch"
            );
            assert!(
                (d.median_variance_ratio - expected_ratios[c]).abs() < 1e-6,
                "channel {c} ratio mismatch"
            );
        }
    }

    #[test]
    #[allow(clippy::excessive_precision)]
    fn conditioning_matches_python_oracle() {
        let (packed, h, w) = golden_packed();
        let profile = estimate_noise(&packed, h, w).unwrap();
        let cond = conditioned_input(&packed, h, w, &profile);
        assert_eq!(cond.len(), 8 * h * w);
        let plane = h * w;
        // Signal channels are clip(packed,0,1); packed is already in range.
        assert!((cond[0] - packed[0]).abs() < 1e-7);
        // Noise channels from the oracle run.
        assert!((cond[4 * plane] - 0.011690146289765835f32).abs() < 1e-6);
        assert!((cond[7 * plane + plane - 1] - 0.025304872542619705f32).abs() < 1e-6);
        let mean = cond.iter().map(|v| *v as f64).sum::<f64>() / cond.len() as f64;
        assert!((mean - 0.22838643193244934).abs() < 1e-6, "mean {mean}");
    }

    #[test]
    fn noise_estimation_rejects_degenerate_inputs() {
        let (packed, h, w) = golden_packed();
        assert!(estimate_noise(&packed[..packed.len() - 1], h, w).is_err());
        let mut nan = packed.clone();
        nan[100] = f32::NAN;
        assert!(estimate_noise(&nan, h, w).is_err());
        assert!(estimate_noise(&vec![0.5f32; 4 * 16 * 16], 16, 16).is_err());
        // Flat field: no texture spread is still fittable, but fully
        // clipped input must fail.
        assert!(estimate_noise(&vec![1.0f32; 4 * 128 * 128], 128, 128).is_err());
    }

    #[test]
    fn reflect_pad_matches_numpy() {
        // Oracle: np.pad 1ch 5x6 with tile=8 halo=2 -> 12x12.
        let src: Vec<f32> = (0..5 * 6).map(|i| i as f32 * 0.5 + 1.0).collect();
        let (padded, ph, pw, ny, nx) = reflect_pad(&src, 1, 5, 6, 8, 2);
        assert_eq!((ph, pw, ny, nx), (12, 12, 2, 2));
        let at = |y: usize, x: usize, w: usize| y * w + x;
        // Interior placement: padded[halo, halo] == src[0,0].
        assert_eq!(padded[at(2, 2, 12)], src[at(0, 0, 6)]);
        assert_eq!(padded[at(2 + 4, 2 + 5, 12)], src[at(4, 5, 6)]);
        // Reflect (not edge-repeat): padded[1,2] == src[1,0].
        assert_eq!(padded[at(1, 2, 12)], src[at(1, 0, 6)]);
        assert_eq!(padded[at(0, 2, 12)], src[at(2, 0, 6)]);
    }

    #[test]
    fn conditioned_tile_shape_is_batch_ready() {
        let (packed, h, w) = golden_packed();
        let profile = estimate_noise(&packed, h, w).unwrap();
        let cond = conditioned_input(&packed, h, w, &profile);
        assert_eq!(cond.len(), 8 * h * w);
        assert!(cond.iter().all(|v| v.is_finite()));
        // Noise channels are nonnegative standard deviations.
        assert!(cond[4 * h * w..].iter().all(|v| *v >= 0.0));
    }

    #[test]
    fn provider_and_option_parsing_is_strict() {
        // Unset defaults to CUDA on Linux, CoreML on macOS, CPU elsewhere.
        assert_eq!(parse_provider(false, false, None).unwrap(), Provider::Cpu);
        assert_eq!(parse_provider(true, false, None).unwrap(), Provider::Cuda);
        assert_eq!(parse_provider(false, true, None).unwrap(), Provider::Coreml);
        assert_eq!(
            parse_provider(true, true, Some("cpu")).unwrap(),
            Provider::Cpu
        );
        assert_eq!(
            parse_provider(true, false, Some("cuda")).unwrap(),
            Provider::Cuda
        );
        assert!(parse_provider(false, false, Some("cuda")).is_err());
        assert!(parse_provider(true, false, Some("auto")).is_err());
        assert!(parse_provider(true, false, Some("CUDA")).is_err());
        // CoreML is macOS-only.
        assert_eq!(
            parse_provider(false, true, Some("coreml")).unwrap(),
            Provider::Coreml
        );
        assert!(parse_provider(false, false, Some("coreml")).is_err());
        assert!(parse_provider(true, false, Some("coreml")).is_err());
        assert_eq!(Provider::Cpu.generation(), BACKEND_GENERATION);
        assert_eq!(Provider::Cuda.generation(), BACKEND_GENERATION);
        assert_eq!(
            Provider::Coreml.generation(),
            crate::nonlocal_coreml::COREML_BACKEND_GENERATION
        );
        assert_eq!(parse_device_id_value(None).unwrap(), 0);
        assert_eq!(parse_device_id_value(Some("2")).unwrap(), 2);
        for bad in ["-1", "1.5", "", "2147483648"] {
            assert!(parse_device_id_value(Some(bad)).is_err(), "{bad}");
        }
        assert_eq!(parse_mem_limit_value(None).unwrap(), None);
        assert_eq!(parse_mem_limit_value(Some("4096")).unwrap(), Some(4096));
        for bad in ["0", "-1", "1.5", ""] {
            assert!(parse_mem_limit_value(Some(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn cpu_ignores_invalid_cuda_only_settings() {
        // Stale/invalid CUDA-only values must not fail CPU or CoreML
        // configuration.
        for provider in [Provider::Cpu, Provider::Coreml] {
            for device in [
                None,
                Some("0"),
                Some("2"),
                Some("-1"),
                Some("bogus"),
                Some(""),
            ] {
                for mem in [None, Some("4096"), Some("0"), Some("-1"), Some("bogus")] {
                    let (device_id, mem_limit) =
                        resolve_provider_config(provider, device, mem).unwrap();
                    assert_eq!(device_id, 0);
                    assert_eq!(mem_limit, None);
                }
            }
        }
        // CUDA still validates both settings strictly.
        assert!(resolve_provider_config(Provider::Cuda, None, None).is_ok());
        assert_eq!(
            resolve_provider_config(Provider::Cuda, Some("2"), Some("4096")).unwrap(),
            (2, Some(4096))
        );
        for bad_device in ["-1", "1.5", "", "bogus", "2147483648"] {
            assert!(
                resolve_provider_config(Provider::Cuda, Some(bad_device), None).is_err(),
                "{bad_device}"
            );
        }
        for bad_mem in ["0", "-1", "1.5", "", "bogus"] {
            assert!(
                resolve_provider_config(Provider::Cuda, None, Some(bad_mem)).is_err(),
                "{bad_mem}"
            );
        }
    }

    #[test]
    fn bundle_validation_rejects_before_hash() {
        let root = tempfile::tempdir().unwrap();
        // Missing files.
        assert!(validate_bundle(root.path()).is_err());
        // Structurally valid manifest pointing at the accepted model hash,
        // but with a decoy model file: must fail on the file hash.
        let manifest = json!({
            "manifest_version": 1,
            "checkpoint_pinned_match": true,
            "source_checkpoint_sha256": SOURCE_CHECKPOINT_SHA,
            "precision": "fp32", "tile": 320, "halo": 40, "retained_core": 240,
            "cfa_order": "RGBG",
            "input_name": "raw_with_noise", "input_shape": [1, 8, 320, 320],
            "input_dtype": "float32",
            "output_name": "denoised_raw", "output_shape": [1, 4, 320, 320],
            "output_dtype": "float32",
            "model_sha256": ONNX_MODEL_SHA,
        });
        std::fs::write(root.path().join("manifest.json"), manifest.to_string()).unwrap();
        std::fs::write(root.path().join("model.onnx"), b"decoy").unwrap();
        let err = validate_bundle(root.path()).unwrap_err().to_string();
        assert!(err.contains("model file hash mismatch"), "{err}");
        // Wrong lineage is rejected even with everything else valid.
        let mut bad = manifest.clone();
        bad["source_checkpoint_sha256"] = json!("0".repeat(64));
        std::fs::write(root.path().join("manifest.json"), bad.to_string()).unwrap();
        let err = validate_bundle(root.path()).unwrap_err().to_string();
        assert!(err.contains("lineage"), "{err}");
    }

    #[test]
    fn bundle_validation_binds_file_to_the_pinned_hash() {
        let root = tempfile::tempdir().unwrap();
        let manifest = |sha: &str| {
            json!({
                "manifest_version": 1,
                "checkpoint_pinned_match": true,
                "source_checkpoint_sha256": SOURCE_CHECKPOINT_SHA,
                "precision": "fp32", "tile": 320, "halo": 40, "retained_core": 240,
                "cfa_order": "RGBG",
                "input_name": "raw_with_noise", "input_shape": [1, 8, 320, 320],
                "input_dtype": "float32",
                "output_name": "denoised_raw", "output_shape": [1, 4, 320, 320],
                "output_dtype": "float32",
                "model_sha256": sha,
            })
            .to_string()
        };
        std::fs::write(root.path().join("model.onnx"), b"decoy").unwrap();
        // A file that is not the pinned bytes never passes, even when the
        // manifest records the pinned hash.
        std::fs::write(root.path().join("manifest.json"), manifest(ONNX_MODEL_SHA)).unwrap();
        let err = validate_bundle(root.path()).unwrap_err().to_string();
        assert!(err.contains("model file hash mismatch"), "{err}");
        // A manifest recording the decoy's own hash is still not an accepted model.
        let decoy = hex::encode(Sha256::digest(b"decoy"));
        std::fs::write(root.path().join("manifest.json"), manifest(&decoy)).unwrap();
        let err = validate_bundle(root.path()).unwrap_err().to_string();
        assert!(err.contains("not the accepted bundle"), "{err}");
    }

    #[test]
    fn nnls_matches_scipy_on_reference_subproblem() {
        // First IRLS weighted subproblem of golden channel 0, captured
        // from the oracle (unweighted first iteration). scipy gives
        // [0.0011384090424375827, 0.0]: the read column stays inactive,
        // exercising the Lawson-Hanson active-set path.
        let x = [
            0.23362445831298828,
            0.2336105853319168,
            0.23398147523403168,
            0.3461224436759949,
            0.346081405878067,
            0.34645169973373413,
            0.45862138271331787,
            0.4585822820663452,
            0.45894840359687805,
            0.57113116979599,
            0.5710382461547852,
            0.5714423060417175,
        ];
        let y = [
            0.00022697931854054332,
            0.00022721187269780785,
            0.0002316268946742639,
            0.00034783955197781324,
            0.00035602881689555943,
            0.00035474932519719005,
            0.0005144766764715314,
            0.0005168224452063441,
            0.000510817626491189,
            0.0007030483684502542,
            0.0006964760832488537,
            0.0006920025916770101,
        ];
        let ones = [1.0f64; 12];
        let coef = nnls_2col(&x, &ones, &y);
        assert!((coef[0] - 0.0011384090424375827).abs() < 1e-12, "{coef:?}");
        assert!(coef[1] == 0.0, "{coef:?}");
    }

    #[test]
    #[ignore = "Requires RAPIDRAW_NONLOCAL_BUNDLE pointing at the accepted bundle; runs one real tile on CPU"]
    fn accepted_bundle_single_tile_matches_reference_stack() {
        let bundle = PathBuf::from(std::env::var_os("RAPIDRAW_NONLOCAL_BUNDLE").expect(
            "Set RAPIDRAW_NONLOCAL_BUNDLE to the accepted bundle-packed-320-fp32 directory",
        ));
        let contract = validate_bundle(&bundle).unwrap();
        let config = NativeConfig {
            bundle,
            provider: Provider::Cpu,
            device_id: 0,
            mem_limit_mb: None,
        };
        let mut backend = open_backend(&config, &contract).unwrap();
        assert_eq!(backend.provider, "cpu");
        // Deterministic synthetic tile: session reuse must be bit-identical.
        let tile: Vec<f32> = (0..8 * TILE * TILE)
            .map(|i| ((i % 1024) as f32 / 1024.0) * 0.8 - 0.05)
            .collect();
        let first = backend.predict_tile(&tile).unwrap();
        let second = backend.predict_tile(&tile).unwrap();
        assert_eq!(first, second);
        assert!(first.iter().all(|v| v.is_finite()));
    }

    #[test]
    #[allow(clippy::excessive_precision)]
    #[ignore = "Requires RAPIDRAW_NONLOCAL_BUNDLE plus RAPIDRAW_NONLOCAL_PARITY_TILE (LE f32 [8,320,320] real fixture tile)"]
    fn rust_cpu_tile_matches_frozen_fixture_output() {
        // Fixture: portrait-controlled-fp32 tile-00; frozen direct output
        // mean 0.10673097521066666, max 0.30275070667266846.
        let bundle = PathBuf::from(std::env::var_os("RAPIDRAW_NONLOCAL_BUNDLE").expect(
            "Set RAPIDRAW_NONLOCAL_BUNDLE to the accepted bundle-packed-320-fp32 directory",
        ));
        let tile_path = PathBuf::from(
            std::env::var_os("RAPIDRAW_NONLOCAL_PARITY_TILE")
                .expect("Set RAPIDRAW_NONLOCAL_PARITY_TILE to the LE-f32 fixture tile"),
        );
        let bytes = std::fs::read(&tile_path).unwrap();
        assert_eq!(bytes.len(), 8 * TILE * TILE * 4);
        let tile: Vec<f32> = bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|b| f32::from_le_bytes(*b))
            .collect();
        let contract = validate_bundle(&bundle).unwrap();
        let config = NativeConfig {
            bundle,
            provider: Provider::Cpu,
            device_id: 0,
            mem_limit_mb: None,
        };
        let mut backend = open_backend(&config, &contract).unwrap();
        let out = backend.predict_tile(&tile).unwrap();
        let mean = out.iter().map(|v| *v as f64).sum::<f64>() / out.len() as f64;
        let max = out.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        assert!((mean - 0.10673097521066666).abs() < 1e-6, "mean {mean}");
        assert!((max - 0.30275070667266846).abs() < 1e-5, "max {max}");
        let at = |c: usize, y: usize, x: usize| (c * TILE + y) * TILE + x;
        for (got, want) in [
            (out[at(0, 0, 0)], 0.06770084798336029f32),
            (out[at(1, 160, 160)], 0.13144299387931824f32),
        ] {
            assert!((got - want).abs() < 1e-5, "{got} vs {want}");
        }
        let _ = test_control();
    }

    /// End-to-end tiling check at the production 320/40 geometry: the whole
    /// conditioning + tiling + stitching driver against a reference produced
    /// by `rapidraw_denoise.pipeline.denoise_with_predictor` (tile 320, halo
    /// 40) on the same input through the same bundle on CPU. Input and
    /// reference are plane-major little-endian f32 `[4,H,W]`; the geometry
    /// comes from `RAPIDRAW_NONLOCAL_PHOTO_HEIGHT` and `..._WIDTH`. Gates match
    /// the tile family: no elementwise violation at 1e-4 atol/rtol, MAE <= 1e-5,
    /// p99 <= 1e-4.
    #[test]
    #[ignore = "Requires RAPIDRAW_NONLOCAL_BUNDLE, RAPIDRAW_NONLOCAL_PHOTO_{INPUT,REF,HEIGHT,WIDTH}; runs a full image on CPU"]
    fn rust_cpu_full_photo_matches_reference_tiling() {
        let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("Set {name}"));
        let read_f32 = |path: String| -> Vec<f32> {
            std::fs::read(path)
                .unwrap()
                .as_chunks::<4>()
                .0
                .iter()
                .map(|b| f32::from_le_bytes(*b))
                .collect()
        };
        let bundle = PathBuf::from(var("RAPIDRAW_NONLOCAL_BUNDLE"));
        let height: usize = var("RAPIDRAW_NONLOCAL_PHOTO_HEIGHT").parse().unwrap();
        let width: usize = var("RAPIDRAW_NONLOCAL_PHOTO_WIDTH").parse().unwrap();
        let packed = read_f32(var("RAPIDRAW_NONLOCAL_PHOTO_INPUT"));
        let reference = read_f32(var("RAPIDRAW_NONLOCAL_PHOTO_REF"));
        assert_eq!(packed.len(), 4 * height * width);
        assert_eq!(reference.len(), packed.len());
        let contract = validate_bundle(&bundle).unwrap();
        let config = NativeConfig {
            bundle,
            provider: Provider::Cpu,
            device_id: 0,
            mem_limit_mb: None,
        };
        let mut backend = open_backend(&config, &contract).unwrap();
        let result = denoise_packed(&mut backend, &packed, height, width, &test_control()).unwrap();
        let mut errors: Vec<f64> = Vec::with_capacity(reference.len());
        let mut violations = 0usize;
        for (got, want) in result.prediction.iter().zip(&reference) {
            let err = (*got as f64 - *want as f64).abs();
            if err > 1e-4 + 1e-4 * (*want as f64).abs() {
                violations += 1;
            }
            errors.push(err);
        }
        let mae = errors.iter().sum::<f64>() / errors.len() as f64;
        errors.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let p99 = errors[(0.99 * (errors.len() - 1) as f64) as usize];
        eprintln!(
            "full-photo parity: max={:e} mae={mae:e} p99={p99:e} violations={violations} tiles_seconds={:.1}",
            errors[errors.len() - 1],
            result.elapsed_secs
        );
        assert_eq!(violations, 0, "elementwise violations");
        assert!(mae <= 1e-5, "mae {mae:e}");
        assert!(p99 <= 1e-4, "p99 {p99:e}");
    }
}
