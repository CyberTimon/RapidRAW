//! Direct CoreML.framework backend for Nonlocal Bayer denoise (macOS only,
//! `RAPIDRAW_NONLOCAL_PROVIDER=coreml`).
//!
//! This is a true CoreML.framework integration: at application inference
//! time there is no Python, CoreMLTools, PyTorch, NumPy or ONNX Runtime
//! dependency. The Python converter (`denoise/scripts/convert_coreml_direct.py`)
//! remains developer-only artifact tooling.
//!
//! The accepted artifact is a separate pinned FP32 packed `.mlpackage`
//! (`packed.mlpackage` + `manifest.json` under `RAPIDRAW_NONLOCAL_BUNDLE`).
//! Bundle validation is fail-closed: the manifest contract is checked
//! field-by-field and the package digest must equal both the manifest record
//! and the accepted hard pin. A second robust runtime tree hash (normalized
//! relative paths + file bytes) is carried in cache/provenance identity so a
//! package layout change invalidates caches even where the historical
//! exporter digest would not.
//!
//! Inference runs through a minimal macOS-only Objective-C bridge
//! (`src/nonlocal_coreml_bridge.m`, compiled by `build.rs` on macOS only)
//! which natively compiles the `.mlpackage` to `.mlmodelc` and loads one
//! `MLModel` per denoise job with `MLComputeUnitsAll` and
//! `allowLowPrecisionAccumulationOnGPU = NO`. The shared Rust
//! noise/conditioning/tiling driver (`nonlocal_onnx::denoise_packed`)
//! is reused through the [`nonlocal_onnx::TilePredictor`] contract; no
//! pipeline arithmetic is duplicated here.

#[cfg(target_os = "macos")]
use crate::nonlocal_onnx::TilePredictor;
use crate::nonlocal_onnx::{SOURCE_CHECKPOINT_SHA, TILE};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[cfg(target_os = "macos")]
use std::ffi::{CString, c_char, c_void};
#[cfg(target_os = "macos")]
use std::time::Instant;
use std::{
    fs,
    path::{Path, PathBuf},
};

/// Accepted direct CoreML package digest (converter/package digest over the
/// `.mlpackage` file set: sorted files, basename bytes then file bytes).
pub(crate) const COREML_PACKAGE_SHA: &str =
    "ecf8f41b72b8e79a7210f61b13b3a21ad2ddbc79c475039be367fc011a98f5d3";
/// Backend generation recorded in cache identity, job manifests and receipts.
pub(crate) const COREML_BACKEND_GENERATION: &str = "native-coreml-v1";
/// Robust runtime tree hash of the accepted CoreML package, recorded in
/// `distribution.json` and enforced at install planning time.
pub(crate) const COREML_TREE_SHA256: &str =
    "1b8efc7a23f92137c267bed50a839db11a2b14d457fa53ac96b6d040663a2b8a";
pub(crate) const COREML_RUNTIME: &str = "coreml";
pub(crate) const COREML_COMPUTE_UNITS: &str = "all";

/// OS/build identity for cache keys and provenance. On macOS this carries
/// the product version and kernel build plus architecture through the
/// already-linked `sysinfo` API (no subprocess), so a macOS/CoreML upgrade
/// invalidates CoreML protocol-3 cache identity instead of silently reusing
/// predictions from another OS build. Off macOS (where `coreml` cannot be
/// selected) it degrades to OS/architecture only.
pub(crate) fn runtime_identity() -> String {
    #[cfg(target_os = "macos")]
    {
        let product = sysinfo::System::os_version().unwrap_or_else(|| "unknown".into());
        let kernel = sysinfo::System::kernel_version().unwrap_or_else(|| "unknown".into());
        format!(
            "{COREML_RUNTIME}/macos-{}/{product}/{kernel}",
            std::env::consts::ARCH
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        format!(
            "{COREML_RUNTIME}/{}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    }
}

/// Collect the package's regular files in sorted order. Symlinks and other
/// non-regular entries are rejected fail-closed.
fn package_files(package: &Path) -> Result<Vec<PathBuf>> {
    let root_meta = fs::symlink_metadata(package)?;
    ensure!(
        !root_meta.file_type().is_symlink() && root_meta.is_dir(),
        "NONLOCAL_COREML_BUNDLE_INVALID: packed.mlpackage must be a real directory"
    );
    let mut files = Vec::new();
    let mut dirs = vec![package.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        let mut entries: Vec<PathBuf> = fs::read_dir(&dir)?
            .map(|entry| entry.map(|entry| entry.path()))
            .collect::<Result<_, _>>()?;
        entries.sort();
        for path in entries {
            let meta = fs::symlink_metadata(&path)?;
            if meta.file_type().is_symlink() {
                bail!(
                    "NONLOCAL_COREML_BUNDLE_INVALID: symlinks are not allowed in packed.mlpackage: {}",
                    path.display()
                );
            } else if meta.is_dir() {
                dirs.push(path);
            } else if meta.is_file() {
                files.push(path);
            } else {
                bail!(
                    "NONLOCAL_COREML_BUNDLE_INVALID: unexpected package entry: {}",
                    path.display()
                );
            }
        }
    }
    files.sort();
    ensure!(
        !files.is_empty(),
        "NONLOCAL_COREML_BUNDLE_INVALID: packed.mlpackage contains no files"
    );
    Ok(files)
}

/// Historical exporter digest: iterate sorted package files, feed each
/// basename then its bytes. This reproduces
/// `denoise/scripts/convert_coreml_direct.py` exactly.
pub(crate) fn historical_package_digest(package: &Path) -> Result<String> {
    let mut digest = Sha256::new();
    for path in package_files(package)? {
        let name = path
            .file_name()
            .with_context(|| "NONLOCAL_COREML_BUNDLE_INVALID: package file without a name")?;
        digest.update(name.as_encoded_bytes());
        digest.update(fs::read(&path)?);
    }
    Ok(hex::encode(digest.finalize()))
}

/// Robust runtime tree hash: sorted normalized relative paths plus file
/// bytes. Layout changes (renames, moves) change this hash even where the
/// historical basename digest would not.
pub(crate) fn runtime_tree_hash(package: &Path) -> Result<String> {
    let mut digest = Sha256::new();
    for path in package_files(package)? {
        let relative = path.strip_prefix(package).with_context(
            || "NONLOCAL_COREML_BUNDLE_INVALID: package file outside packed.mlpackage",
        )?;
        let mut posix = String::new();
        for (index, component) in relative.components().enumerate() {
            if index > 0 {
                posix.push('/');
            }
            posix.push_str(
                component
                    .as_os_str()
                    .to_str()
                    .with_context(|| "NONLOCAL_COREML_BUNDLE_INVALID: non-UTF8 package path")?,
            );
        }
        digest.update(posix.as_bytes());
        digest.update([0u8]);
        digest.update(fs::read(&path)?);
    }
    Ok(hex::encode(digest.finalize()))
}

fn manifest_string(manifest: &Value, key: &str) -> Result<String> {
    manifest
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .with_context(|| format!("NONLOCAL_COREML_BUNDLE_INVALID: manifest missing string {key:?}"))
}

fn manifest_io(manifest: &Value, key: &str, name: &str, channels: i64) -> Result<()> {
    let io = manifest
        .get(key)
        .with_context(|| format!("NONLOCAL_COREML_BUNDLE_INVALID: manifest missing {key:?}"))?;
    ensure!(
        io.get("name").and_then(|v| v.as_str()) == Some(name),
        "NONLOCAL_COREML_BUNDLE_INVALID: {key} name must be {name:?}"
    );
    ensure!(
        io.get("shape")
            .map(|v| v == &json!([1, channels, TILE as i64, TILE as i64]))
            == Some(true),
        "NONLOCAL_COREML_BUNDLE_INVALID: {key} shape must be [1,{channels},320,320]"
    );
    ensure!(
        io.get("dtype").and_then(|v| v.as_str()) == Some("float32"),
        "NONLOCAL_COREML_BUNDLE_INVALID: {key} dtype must be float32"
    );
    Ok(())
}

#[derive(Debug)]
pub(crate) struct CoreMlContract {
    // Only read by the macOS-only `open_backend`; Linux builds validate
    // bundles fail-closed without loading them.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub package: PathBuf,
    /// Robust runtime tree hash (relative paths + bytes) for cache identity.
    pub tree_sha256: String,
}

/// Fail-closed validation of the accepted CoreML bundle before any model
/// load. Checks the manifest contract field-by-field and requires the
/// recomputed package digest to equal both the manifest record and the
/// accepted hard pin.
pub(crate) fn validate_bundle(bundle: &Path) -> Result<CoreMlContract> {
    let manifest_path = bundle.join("manifest.json");
    let package = bundle.join("packed.mlpackage");
    ensure!(
        manifest_path.is_file() && package.is_dir(),
        "NONLOCAL_COREML_BUNDLE_INVALID: bundle must contain packed.mlpackage/ + manifest.json"
    );
    let manifest: Value = serde_json::from_slice(&fs::read(&manifest_path)?)
        .context("NONLOCAL_COREML_BUNDLE_INVALID: manifest is not valid JSON")?;
    ensure!(
        manifest.get("manifest_version").and_then(|v| v.as_i64()) == Some(1),
        "NONLOCAL_COREML_BUNDLE_INVALID: manifest_version must be 1"
    );
    ensure!(
        manifest.get("artifact").and_then(|v| v.as_str()) == Some("packed.mlpackage"),
        "NONLOCAL_COREML_BUNDLE_INVALID: artifact must be packed.mlpackage"
    );
    ensure!(
        manifest.get("conversion").and_then(|v| v.as_str())
            == Some("coremltools-direct-torchscript"),
        "NONLOCAL_COREML_BUNDLE_INVALID: conversion must be coremltools-direct-torchscript"
    );
    ensure!(
        manifest.get("compute_precision").and_then(|v| v.as_str()) == Some("FLOAT32"),
        "NONLOCAL_COREML_BUNDLE_INVALID: compute_precision must be FLOAT32"
    );
    ensure!(
        manifest
            .get("sampler_implementation")
            .and_then(|v| v.as_str())
            == Some("static-packed (static-packed-v1; export-only route)"),
        "NONLOCAL_COREML_BUNDLE_INVALID: sampler must be the static-packed export route"
    );
    ensure!(
        manifest
            .get("checkpoint_pinned_match")
            .and_then(|v| v.as_bool())
            == Some(true),
        "NONLOCAL_COREML_BUNDLE_INVALID: checkpoint_pinned_match must be true"
    );
    ensure!(
        manifest
            .get("source_checkpoint_sha256")
            .and_then(|v| v.as_str())
            == Some(SOURCE_CHECKPOINT_SHA),
        "NONLOCAL_COREML_BUNDLE_INVALID: source checkpoint lineage mismatch"
    );
    manifest_io(&manifest, "input", "raw_with_noise", 8)?;
    manifest_io(&manifest, "output", "denoised_raw", 4)?;
    let recorded = manifest_string(&manifest, "package_sha256")?;
    ensure!(
        recorded == COREML_PACKAGE_SHA,
        "NONLOCAL_COREML_BUNDLE_INVALID: manifest package hash is not the accepted bundle"
    );
    let actual = historical_package_digest(&package)?;
    ensure!(
        actual == COREML_PACKAGE_SHA,
        "NONLOCAL_COREML_BUNDLE_INVALID: package digest mismatch (modified package rejected)"
    );
    let tree_sha256 = runtime_tree_hash(&package)?;
    Ok(CoreMlContract {
        package,
        tree_sha256,
    })
}

// ---------------------------------------------------------------------------
// Native CoreML.framework bridge (macOS only).
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod ffi {
    use std::ffi::{c_char, c_float, c_void};

    unsafe extern "C" {
        pub fn nlx_coreml_load(
            package_path: *const c_char,
            err_buf: *mut c_char,
            err_cap: usize,
        ) -> *mut c_void;
        pub fn nlx_coreml_check_io(
            handle: *mut c_void,
            err_buf: *mut c_char,
            err_cap: usize,
        ) -> i32;
        pub fn nlx_coreml_predict(
            handle: *mut c_void,
            input: *const c_float,
            output: *mut c_float,
            err_buf: *mut c_char,
            err_cap: usize,
        ) -> i32;
        pub fn nlx_coreml_free(handle: *mut c_void);
    }
}

/// One compiled `MLModel` per denoise job, reused for all tiles. The handle is owned by the job worker thread.
#[cfg(target_os = "macos")]
pub(crate) struct Backend {
    handle: *mut c_void,
    /// Seconds spent natively compiling + loading the model (kept separate
    /// from tile-prediction wall time).
    pub load_secs: f64,
}

// The handle is used only on the constructing worker thread.
#[cfg(target_os = "macos")]
unsafe impl Send for Backend {}

#[cfg(target_os = "macos")]
const ERR_CAP: usize = 1024;

#[cfg(target_os = "macos")]
fn bridge_error(buf: &[c_char]) -> String {
    let bytes: Vec<u8> = buf
        .iter()
        .take_while(|c| **c != 0)
        .map(|c| *c as u8)
        .collect();
    let text = String::from_utf8_lossy(&bytes);
    text.chars().take(300).collect()
}

#[cfg(target_os = "macos")]
fn with_err_buf<T>(call: impl FnOnce(*mut c_char, usize) -> T) -> (T, String) {
    let mut buf = [0 as c_char; ERR_CAP];
    let out = call(buf.as_mut_ptr(), ERR_CAP);
    (out, bridge_error(&buf))
}

/// Natively compile the `.mlpackage` to `.mlmodelc` and load one `MLModel`
/// with all compute units and no low-precision GPU accumulation. Fails
/// closed; never falls back to another provider.
#[cfg(target_os = "macos")]
pub(crate) fn open_backend(
    config: &crate::nonlocal_onnx::NativeConfig,
    contract: &CoreMlContract,
) -> Result<Backend> {
    use crate::nonlocal_onnx::Provider;

    ensure!(
        config.provider == Provider::Coreml,
        "NONLOCAL_COREML_UNAVAILABLE: CoreML backend requires provider=coreml"
    );
    let started = Instant::now();
    let path = CString::new(contract.package.to_string_lossy().as_bytes())
        .context("NONLOCAL_COREML_UNAVAILABLE: package path is not valid UTF-8")?;
    // SAFETY: the bridge copies what it needs during the call; the handle it
    // returns is freed exactly once in `Drop` on this same thread.
    let handle = unsafe {
        let (handle, err) = with_err_buf(|buf, cap| ffi::nlx_coreml_load(path.as_ptr(), buf, cap));
        if handle.is_null() {
            bail!("NONLOCAL_COREML_UNAVAILABLE: CoreML model load failed: {err}");
        }
        let (rc, err) = with_err_buf(|buf, cap| ffi::nlx_coreml_check_io(handle, buf, cap));
        if rc != 0 {
            ffi::nlx_coreml_free(handle);
            bail!("NONLOCAL_COREML_INVALID: live model contract mismatch: {err}");
        }
        handle
    };
    Ok(Backend {
        handle,
        load_secs: started.elapsed().as_secs_f64(),
    })
}

#[cfg(target_os = "macos")]
impl Drop for Backend {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            // SAFETY: handle came from `nlx_coreml_load` and is freed once here.
            unsafe {
                ffi::nlx_coreml_free(self.handle);
            }
            self.handle = std::ptr::null_mut();
        }
    }
}

#[cfg(target_os = "macos")]
impl TilePredictor for Backend {
    /// Run one conditioned CHW tile through the loaded `MLModel`; validates
    /// FP32 exact-shape finite input and output.
    fn predict_tile(&mut self, tile: &[f32]) -> Result<Vec<f32>> {
        ensure!(
            tile.len() == 8 * TILE * TILE,
            "NONLOCAL_TILE_INVALID: conditioned tile must be [8,320,320]"
        );
        ensure!(
            tile.iter().all(|v| v.is_finite()),
            "NONLOCAL_TILE_INVALID: conditioned tile must be finite"
        );
        let mut out = vec![0f32; 4 * TILE * TILE];
        // SAFETY: the bridge reads exactly 8*320*320 floats and writes
        // exactly 4*320*320 floats synchronously before returning.
        let (rc, err) = unsafe {
            with_err_buf(|buf, cap| {
                ffi::nlx_coreml_predict(self.handle, tile.as_ptr(), out.as_mut_ptr(), buf, cap)
            })
        };
        ensure!(
            rc == 0,
            "NONLOCAL_COREML_INFERENCE_FAILED: CoreML prediction failed: {err}"
        );
        ensure!(
            out.iter().all(|v| v.is_finite()),
            "NONLOCAL_COREML_OUTPUT_INVALID: output must be finite [1,4,320,320]"
        );
        Ok(out)
    }

    fn provider_name(&self) -> &'static str {
        "coreml"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn synthetic_package(root: &Path, names: &[&str]) {
        let package = root.join("packed.mlpackage");
        fs::create_dir_all(package.join("Weights")).unwrap();
        for (index, name) in names.iter().enumerate() {
            let path = if index % 2 == 0 {
                package.join(name)
            } else {
                package.join("Weights").join(name)
            };
            fs::write(path, format!("payload-{name}")).unwrap();
        }
        let manifest = json!({
            "manifest_version": 1,
            "artifact": "packed.mlpackage",
            "conversion": "coremltools-direct-torchscript",
            "compute_precision": "FLOAT32",
            "sampler_implementation": "static-packed (static-packed-v1; export-only route)",
            "source_checkpoint_sha256": SOURCE_CHECKPOINT_SHA,
            "checkpoint_pinned_match": true,
            "input": {"name": "raw_with_noise", "shape": [1, 8, 320, 320], "dtype": "float32"},
            "output": {"name": "denoised_raw", "shape": [1, 4, 320, 320], "dtype": "float32"},
            "package_sha256": COREML_PACKAGE_SHA,
        });
        fs::write(root.join("manifest.json"), manifest.to_string()).unwrap();
    }

    #[test]
    fn manifest_rejections_are_fail_closed() {
        let root = tempfile::tempdir().unwrap();
        // Missing files.
        assert!(validate_bundle(root.path()).is_err());
        synthetic_package(root.path(), &["a.bin", "b.weights"]);
        // Synthetic payload never matches the accepted pin.
        let err = validate_bundle(root.path()).unwrap_err().to_string();
        assert!(err.contains("package digest mismatch"), "{err}");
        // Each contract field is required: corrupt them one at a time and
        // require a rejection naming the bundle.
        let manifest_path = root.path().join("manifest.json");
        let base: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        let mut cases: Vec<(&str, &str, Value)> = Vec::new();
        let mut wrong_version = base.clone();
        wrong_version["manifest_version"] = json!(2);
        cases.push((
            "manifest_version",
            "manifest_version must be 1",
            wrong_version,
        ));
        let mut wrong_artifact = base.clone();
        wrong_artifact["artifact"] = json!("model.mlpackage");
        cases.push((
            "artifact",
            "artifact must be packed.mlpackage",
            wrong_artifact,
        ));
        let mut wrong_conversion = base.clone();
        wrong_conversion["conversion"] = json!("onnx");
        cases.push((
            "conversion",
            "conversion must be coremltools-direct-torchscript",
            wrong_conversion,
        ));
        let mut wrong_precision = base.clone();
        wrong_precision["compute_precision"] = json!("FLOAT16");
        cases.push((
            "precision",
            "compute_precision must be FLOAT32",
            wrong_precision,
        ));
        let mut wrong_sampler = base.clone();
        wrong_sampler["sampler_implementation"] = json!("reference");
        cases.push((
            "sampler",
            "sampler must be the static-packed",
            wrong_sampler,
        ));
        let mut wrong_lineage = base.clone();
        wrong_lineage["source_checkpoint_sha256"] = json!("0".repeat(64));
        cases.push((
            "lineage",
            "source checkpoint lineage mismatch",
            wrong_lineage,
        ));
        let mut wrong_input = base.clone();
        wrong_input["input"]["shape"] = json!([1, 8, 160, 160]);
        cases.push(("input shape", "shape must be [1,8,320,320]", wrong_input));
        let mut wrong_output = base.clone();
        wrong_output["output"]["name"] = json!("other");
        cases.push(("output name", "name must be \"denoised_raw\"", wrong_output));
        let mut unchecked = base.clone();
        unchecked["checkpoint_pinned_match"] = json!(false);
        cases.push((
            "pinned match",
            "checkpoint_pinned_match must be true",
            unchecked,
        ));
        let mut wrong_recorded = base.clone();
        wrong_recorded["package_sha256"] = json!("f".repeat(64));
        cases.push((
            "recorded hash",
            "manifest package hash is not the accepted bundle",
            wrong_recorded,
        ));
        for (label, needle, manifest) in cases {
            fs::write(&manifest_path, manifest.to_string()).unwrap();
            let err = validate_bundle(root.path()).unwrap_err().to_string();
            assert!(
                err.contains("NONLOCAL_COREML_BUNDLE_INVALID") && err.contains(needle),
                "{label}: {err}"
            );
        }
    }

    #[test]
    fn package_walk_rejects_symlinks() {
        let root = tempfile::tempdir().unwrap();
        synthetic_package(root.path(), &["a.bin"]);
        let package = root.path().join("packed.mlpackage");
        #[cfg(unix)]
        std::os::unix::fs::symlink(package.join("a.bin"), package.join("link.bin")).unwrap();
        #[cfg(unix)]
        {
            let err = historical_package_digest(&package).unwrap_err().to_string();
            assert!(err.contains("symlink"), "{err}");
        }
    }

    #[test]
    fn historical_digest_reproduces_exporter_algorithm() {
        // Independently recompute basename+bytes over sorted files and
        // require the helper to agree exactly.
        let root = tempfile::tempdir().unwrap();
        synthetic_package(root.path(), &["b.bin", "a.weights", "c.bin"]);
        let package = root.path().join("packed.mlpackage");
        let mut files: Vec<PathBuf> = Vec::new();
        let mut stack = vec![package.clone()];
        while let Some(dir) = stack.pop() {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    files.push(path);
                }
            }
        }
        files.sort();
        let mut digest = Sha256::new();
        for path in &files {
            digest.update(path.file_name().unwrap().as_encoded_bytes());
            digest.update(fs::read(path).unwrap());
        }
        assert_eq!(
            hex::encode(digest.finalize()),
            historical_package_digest(&package).unwrap()
        );
    }

    #[test]
    fn tree_hash_detects_layout_changes_the_exporter_digest_misses() {
        // Same basenames in the same sorted order with the same bytes, but
        // different subdirectories: the historical basename digest is blind,
        // the runtime tree hash is not. (Uppercase "Weights/" sorts before
        // lowercase root names, so both layouts feed basenames a, b, m.)
        fn layout(root: &Path, entries: &[(&str, &str)]) {
            let package = root.join("packed.mlpackage");
            for (rel, payload) in entries {
                let path = package.join(rel);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, payload).unwrap();
            }
        }
        let first = tempfile::tempdir().unwrap();
        layout(
            first.path(),
            &[
                ("m.bin", "1"),
                ("Weights/a.bin", "2"),
                ("Weights/b.bin", "3"),
            ],
        );
        let second = tempfile::tempdir().unwrap();
        layout(
            second.path(),
            &[("a.bin", "2"), ("b.bin", "3"), ("m.bin", "1")],
        );
        let first_pkg = first.path().join("packed.mlpackage");
        let second_pkg = second.path().join("packed.mlpackage");
        assert_eq!(
            historical_package_digest(&first_pkg).unwrap(),
            historical_package_digest(&second_pkg).unwrap()
        );
        assert_ne!(
            runtime_tree_hash(&first_pkg).unwrap(),
            runtime_tree_hash(&second_pkg).unwrap()
        );
        // Identical trees hash identically.
        assert_eq!(
            runtime_tree_hash(&first_pkg).unwrap(),
            runtime_tree_hash(&first_pkg).unwrap()
        );
    }

    #[test]
    fn runtime_identity_names_coreml_platform() {
        let first = runtime_identity();
        let second = runtime_identity();
        assert_eq!(first, second, "identity is deterministic");
        assert!(!first.is_empty() && first.len() < 256, "{first}");
        assert!(first.starts_with("coreml/"), "{first}");
        assert!(first.contains(std::env::consts::ARCH), "{first}");
        #[cfg(target_os = "macos")]
        {
            // coreml/macos-<arch>/<product-version>/<kernel-build>
            let parts: Vec<&str> = first.split('/').collect();
            assert_eq!(parts.len(), 4, "{first}");
            assert_eq!(parts[0], "coreml");
            assert!(parts[1].starts_with("macos-"), "{first}");
            assert!(!parts[2].is_empty() && parts[2] != "unknown", "{first}");
            assert!(!parts[3].is_empty() && parts[3] != "unknown", "{first}");
        }
    }

    /// Minimal strict `.npy`/`.npz` reader for frozen fixtures (test-only).
    /// Only little-endian float32 C-order arrays are accepted; zip entries
    /// must be stored (NumPy's `savez` default), never compressed.
    #[cfg(target_os = "macos")]
    mod frozen_fixtures {
        use anyhow::{Context, Result, bail, ensure};

        fn u16_le(data: &[u8], at: usize) -> usize {
            u16::from_le_bytes([data[at], data[at + 1]]) as usize
        }

        fn u32_le(data: &[u8], at: usize) -> usize {
            u32::from_le_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]]) as usize
        }

        fn parse_shape(header: &str) -> Result<Vec<usize>> {
            let key = "'shape':";
            let start = header
                .find(key)
                .with_context(|| "npy header missing shape")?
                + key.len();
            let open = header[start..]
                .find('(')
                .with_context(|| "npy shape missing paren")?
                + start;
            let close = header[open..]
                .find(')')
                .with_context(|| "npy shape unterminated")?
                + open;
            let mut shape = Vec::new();
            for part in header[open + 1..close].split(',') {
                let part = part.trim();
                if !part.is_empty() {
                    shape.push(part.parse::<usize>().context("npy shape is not integers")?);
                }
            }
            Ok(shape)
        }

        pub fn read_npy(data: &[u8]) -> Result<(Vec<usize>, Vec<f32>)> {
            ensure!(
                data.len() >= 10 && data[0..6] == *b"\x93NUMPY",
                "not an npy array"
            );
            let (hlen_size, header_at) = match (data[6], data[7]) {
                (1, 0) => (2, 10),
                (2, 0) => (4, 12),
                _ => bail!("unsupported npy version"),
            };
            let header_len = if hlen_size == 2 {
                u16_le(data, 8)
            } else {
                u32_le(data, 8)
            };
            let header = std::str::from_utf8(
                data.get(header_at..header_at + header_len)
                    .with_context(|| "npy header truncated")?,
            )
            .context("npy header is not UTF-8")?;
            ensure!(
                header.contains("'<f4'") || header.contains("'|f4'"),
                "fixture array is not float32"
            );
            ensure!(
                header.contains("'fortran_order': False"),
                "fixture array must be C-order"
            );
            let shape = parse_shape(header)?;
            let count: usize = shape.iter().product();
            let values_at = header_at + header_len;
            let bytes = data
                .get(values_at..values_at + count * 4)
                .with_context(|| "npy payload truncated")?;
            Ok((
                shape,
                bytes
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(|b| f32::from_le_bytes(*b))
                    .collect(),
            ))
        }

        pub fn read_npz_float(
            path: &std::path::Path,
            entry: &str,
        ) -> Result<(Vec<usize>, Vec<f32>)> {
            let data = std::fs::read(path)?;
            // End of central directory: NumPy writes no comment, so it is
            // exactly the trailing 22 bytes.
            ensure!(data.len() >= 22, "npz too small");
            let eocd = data.len() - 22;
            ensure!(
                data[eocd..eocd + 4] == [0x50, 0x4b, 0x05, 0x06] && u16_le(&data, eocd + 20) == 0,
                "npz end-of-central-directory not found"
            );
            let dir_count = u16_le(&data, eocd + 10);
            let mut at = u32_le(&data, eocd + 16);
            for _ in 0..dir_count {
                ensure!(
                    data.get(at..at + 4) == Some(&[0x50u8, 0x4b, 0x01, 0x02][..]),
                    "npz central directory corrupt"
                );
                ensure!(u16_le(&data, at + 10) == 0, "npz entry must be stored");
                let name_len = u16_le(&data, at + 28);
                let extra_len = u16_le(&data, at + 30);
                let comment_len = u16_le(&data, at + 32);
                let local_off = u32_le(&data, at + 42);
                let name = std::str::from_utf8(
                    data.get(at + 46..at + 46 + name_len)
                        .with_context(|| "npz name truncated")?,
                )?;
                at += 46 + name_len + extra_len + comment_len;
                if name != entry {
                    continue;
                }
                ensure!(
                    data.get(local_off..local_off + 4) == Some(&[0x50u8, 0x4b, 0x03, 0x04][..]),
                    "npz local header corrupt"
                );
                let local_name = u16_le(&data, local_off + 26);
                let local_extra = u16_le(&data, local_off + 28);
                let payload = local_off + 30 + local_name + local_extra;
                let (shape, values) = read_npy(
                    data.get(payload..)
                        .with_context(|| "npz payload truncated")?,
                )?;
                return Ok((shape, values));
            }
            bail!("npz entry {entry:?} not found")
        }
    }

    /// Frozen tile gates mirroring `denoise/rapidraw_denoise/metrics.py`:
    /// elementwise |err| <= 1e-4 + 1e-4*|ref| with zero violations,
    /// MAE <= 1e-5, p99 <= 1e-4, per-channel |bias| <= 1e-5.
    #[cfg(target_os = "macos")]
    fn assert_tile_parity(label: &str, actual: &[f32], reference: &[f32]) {
        use std::time::Instant;

        assert_eq!(actual.len(), reference.len(), "{label}: length");
        assert_eq!(actual.len(), 4 * TILE * TILE, "{label}: shape");
        assert!(actual.iter().all(|v| v.is_finite()), "{label}: finite");
        let started = Instant::now();
        let mut max_abs = 0f64;
        let mut sum_abs = 0f64;
        let mut sum_sq = 0f64;
        let mut violations = 0usize;
        let mut abs_dev = Vec::with_capacity(actual.len());
        let mut bias = [0f64; 4];
        let plane = TILE * TILE;
        for (index, (a, r)) in actual.iter().zip(reference.iter()).enumerate() {
            let err = (*a as f64 - *r as f64).abs();
            max_abs = max_abs.max(err);
            sum_abs += err;
            sum_sq += err * err;
            if err > 1e-4 + 1e-4 * (*r as f64).abs() {
                violations += 1;
            }
            abs_dev.push(err);
            bias[index / plane] += *a as f64 - *r as f64;
        }
        let n = actual.len() as f64;
        let mae = sum_abs / n;
        abs_dev.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
        let pos = 0.99 * (n - 1.0);
        let lo = pos.floor() as usize;
        let hi = pos.ceil() as usize;
        let p99 = abs_dev[lo] + (pos - lo as f64) * (abs_dev[hi] - abs_dev[lo]);
        let channel_bias: Vec<f64> = bias.iter().map(|b| (b / plane as f64).abs()).collect();
        eprintln!(
            "{label}: max={max_abs:e} mae={mae:e} p99={p99:e} rmse={:e} bias={channel_bias:?} violations={violations} scored_ms={}",
            (sum_sq / n).sqrt(),
            started.elapsed().as_millis()
        );
        assert_eq!(violations, 0, "{label}: elementwise violations");
        assert!(mae <= 1e-5, "{label}: mae {mae:e}");
        assert!(p99 <= 1e-4, "{label}: p99 {p99:e}");
        for (c, b) in channel_bias.iter().enumerate() {
            assert!(*b <= 1e-5, "{label}: channel {c} bias {b:e}");
        }
    }

    #[cfg(target_os = "macos")]
    fn fixture_tile(fixtures: &std::path::Path, photo: &str, tile: usize) -> (Vec<f32>, Vec<f32>) {
        let path = fixtures
            .join(format!("{photo}-controlled-fp32"))
            .join("tiles")
            .join(format!("tile-{tile:02}.npz"));
        let (in_shape, input) =
            frozen_fixtures::read_npz_float(&path, "input.npy").expect("fixture input");
        let (out_shape, reference) =
            frozen_fixtures::read_npz_float(&path, "output.npy").expect("fixture output");
        assert_eq!(in_shape, vec![1, 8, TILE, TILE]);
        assert_eq!(out_shape, vec![1, 4, TILE, TILE]);
        // Strip the leading batch axis: fixtures are NCHW, the predictor is CHW.
        let plane_in = 8 * TILE * TILE;
        let plane_out = 4 * TILE * TILE;
        assert_eq!(input.len(), plane_in);
        assert_eq!(reference.len(), plane_out);
        (input, reference)
    }

    /// Print the historical package digest and runtime tree hash of a bundle
    /// directory for distribution staging. The bundle must fully validate;
    /// both hashes are recomputed by current source (not read from the
    /// manifest). Requires `RAPIDRAW_NONLOCAL_COREML_BUNDLE`.
    #[test]
    #[ignore = "Staging helper: prints accepted bundle hashes from current source"]
    fn print_bundle_hashes_for_staging() {
        let bundle = std::path::PathBuf::from(
            std::env::var_os("RAPIDRAW_NONLOCAL_COREML_BUNDLE")
                .expect("Set RAPIDRAW_NONLOCAL_COREML_BUNDLE to the bundle directory"),
        );
        let contract = validate_bundle(&bundle).expect("bundle validates");
        let historical =
            historical_package_digest(&bundle.join("packed.mlpackage")).expect("digest");
        eprintln!("HISTORICAL_PACKAGE_SHA256={historical}");
        eprintln!("RUNTIME_TREE_SHA256={}", contract.tree_sha256);
        eprintln!("RUNTIME_IDENTITY={}", runtime_identity());
    }

    /// Native Rust/CoreML parity on the frozen real fixture tiles. Requires
    /// the exact accepted package plus the in-repo fixture set:
    /// `RAPIDRAW_NONLOCAL_COREML_BUNDLE` and
    /// `RAPIDRAW_NONLOCAL_COREML_FIXTURES` (e.g. `.../nonlocal-onnx-evidence/fixtures`).
    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "Requires RAPIDRAW_NONLOCAL_COREML_BUNDLE (exact package) + RAPIDRAW_NONLOCAL_COREML_FIXTURES; runs 18 real tiles through CoreML"]
    fn accepted_package_tile_parity() {
        let bundle = std::path::PathBuf::from(
            std::env::var_os("RAPIDRAW_NONLOCAL_COREML_BUNDLE")
                .expect("Set RAPIDRAW_NONLOCAL_COREML_BUNDLE to the exact packed bundle directory"),
        );
        let fixtures = std::path::PathBuf::from(
            std::env::var_os("RAPIDRAW_NONLOCAL_COREML_FIXTURES")
                .expect("Set RAPIDRAW_NONLOCAL_COREML_FIXTURES to the fixtures root"),
        );
        let contract = validate_bundle(&bundle).expect("exact CoreML bundle validates");
        assert_eq!(contract.tree_sha256.len(), 64);
        let config = crate::nonlocal_onnx::NativeConfig {
            bundle,
            provider: crate::nonlocal_onnx::Provider::Coreml,
            device_id: 0,
            mem_limit_mb: None,
        };
        let mut backend = open_backend(&config, &contract).expect("CoreML model loads");
        assert_eq!(backend.provider_name(), "coreml");
        eprintln!("COREML_LOAD_S={:.3}", backend.load_secs);
        for photo in ["portrait", "landscape", "phone"] {
            for tile in 0..6 {
                let tile_started = std::time::Instant::now();
                let (input, reference) = fixture_tile(&fixtures, photo, tile);
                let out = backend.predict_tile(&input).expect("tile predicts");
                eprintln!(
                    "COREML_PREDICT_S={:.3}",
                    tile_started.elapsed().as_secs_f64()
                );
                assert_tile_parity(&format!("coreml-{photo}-{tile:02}"), &out, &reference);
            }
        }
        // Session reuse must be deterministic.
        let (input, reference) = fixture_tile(&fixtures, "portrait", 0);
        let repeat = backend.predict_tile(&input).expect("repeat predicts");
        assert_tile_parity("coreml-portrait-repeat-00", &repeat, &reference);
    }

    /// Native Rust/CoreML full-photo parity through the shared
    /// noise/conditioning/tiling driver. Requires the exact accepted package
    /// plus a packed `[4,H,W]` little-endian float32 input and the frozen
    /// torch reference output computed with the production 320/40 tiling:
    /// `RAPIDRAW_NONLOCAL_COREML_BUNDLE`, `RAPIDRAW_NONLOCAL_COREML_PHOTO_INPUT`
    /// and `RAPIDRAW_NONLOCAL_COREML_PHOTO_REF` (single-array float32 `.npy`).
    /// Gates match the tile family (zero elementwise violations at
    /// 1e-4 atol/rtol, MAE <= 1e-5, p99 <= 1e-4).
    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "Requires exact CoreML bundle + full-photo packed input and torch reference; runs end to end"]
    fn accepted_package_full_photo_parity() {
        let bundle = std::path::PathBuf::from(
            std::env::var_os("RAPIDRAW_NONLOCAL_COREML_BUNDLE")
                .expect("Set RAPIDRAW_NONLOCAL_COREML_BUNDLE to the exact packed bundle directory"),
        );
        let input_path = std::path::PathBuf::from(
            std::env::var_os("RAPIDRAW_NONLOCAL_COREML_PHOTO_INPUT")
                .expect("Set RAPIDRAW_NONLOCAL_COREML_PHOTO_INPUT to the packed input.f32"),
        );
        let contract = validate_bundle(&bundle).expect("exact CoreML bundle validates");
        let config = crate::nonlocal_onnx::NativeConfig {
            bundle,
            provider: crate::nonlocal_onnx::Provider::Coreml,
            device_id: 0,
            mem_limit_mb: None,
        };
        let mut backend = open_backend(&config, &contract).expect("CoreML model loads");
        eprintln!("COREML_LOAD_S={:.3}", backend.load_secs);
        let control = crate::denoising::DenoiseControl {
            cancelled: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            progress: std::sync::Arc::new(|_, _| {}),
        };
        let var = "RAPIDRAW_NONLOCAL_COREML_PHOTO_REF";
        let ref_path = std::path::PathBuf::from(
            std::env::var_os(var)
                .unwrap_or_else(|| panic!("Set {var} to the torch reference .npy")),
        );
        let (ref_shape, reference) =
            frozen_fixtures::read_npy(&std::fs::read(&ref_path).expect("reference readable"))
                .expect("reference parses");
        assert_eq!(ref_shape.len(), 3, "reference must be [4,H,W]");
        let (height, width) = (ref_shape[1], ref_shape[2]);
        assert_eq!(ref_shape[0], 4);
        let raw = std::fs::read(&input_path).expect("photo input readable");
        assert_eq!(
            raw.len(),
            4 * height * width * 4,
            "input size matches reference"
        );
        let packed: Vec<f32> = raw
            .as_chunks::<4>()
            .0
            .iter()
            .map(|b| f32::from_le_bytes(*b))
            .collect();
        let started = std::time::Instant::now();
        let result =
            crate::nonlocal_onnx::denoise_packed(&mut backend, &packed, height, width, &control)
                .expect("full-photo inference");
        let wall_s = started.elapsed().as_secs_f64();
        assert_eq!(result.prediction.len(), reference.len());
        let label = "coreml-full";
        // Full-array gates, same family as the tile gates.
        let mut max_abs = 0f64;
        let mut sum_abs = 0f64;
        let mut violations = 0usize;
        let mut abs_dev = Vec::with_capacity(reference.len());
        for (a, r) in result.prediction.iter().zip(reference.iter()) {
            assert!(a.is_finite(), "{label}: finite");
            let err = (*a as f64 - *r as f64).abs();
            max_abs = max_abs.max(err);
            sum_abs += err;
            if err > 1e-4 + 1e-4 * (*r as f64).abs() {
                violations += 1;
            }
            abs_dev.push(err);
        }
        let mae = sum_abs / reference.len() as f64;
        abs_dev.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
        let pos = 0.99 * (reference.len() as f64 - 1.0);
        let lo = pos.floor() as usize;
        let hi = pos.ceil() as usize;
        let p99 = abs_dev[lo] + (pos - lo as f64) * (abs_dev[hi] - abs_dev[lo]);
        eprintln!(
            "{label}: max={max_abs:e} mae={mae:e} p99={p99:e} violations={violations} \
             inference_s={:.1} load_s={:.3}",
            result.elapsed_secs, backend.load_secs
        );
        assert_eq!(violations, 0, "{label}: elementwise violations");
        assert!(mae <= 1e-5, "{label}: mae {mae:e}");
        assert!(p99 <= 1e-4, "{label}: p99 {p99:e}");
        eprintln!("{label}: WALL_S={wall_s:.1}");
    }
}
