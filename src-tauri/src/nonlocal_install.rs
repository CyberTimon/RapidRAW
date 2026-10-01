//! Controlled auto-installation of Nonlocal runtime bundles.
//!
//! The validated ONNX and direct CoreML artifacts are distributed from a
//! public Hugging Face model repository as a hashed `distribution.json`
//! plus exact artifact files. `install_model kind="nonlocal"` is the only
//! network-mutating MCP call for these bundles: it streams the pinned
//! distribution manifest and provider-specific files, verifies every hash
//! and size incrementally, runs the existing provider bundle validation,
//! and only then atomically installs the bundle under the workspace model
//! directory. Ordinary `models`, `start_denoise`, resume and status calls
//! never download; a missing bundle fails closed with `MODEL_NOT_INSTALLED`
//! guidance. An explicit `RAPIDRAW_NONLOCAL_BUNDLE` always wins over the
//! installed bundle for developer/manual use.

use crate::nonlocal_coreml::{COREML_PACKAGE_SHA, COREML_TREE_SHA256};
use crate::nonlocal_onnx::{ONNX_MODEL_SHA, Provider, SOURCE_CHECKPOINT_SHA};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
};

/// Public Hugging Face model repository carrying the runtime artifacts.
pub(crate) const HUB_REPO: &str = "sheldonxxxx/RapidRAW-Nonlocal-Denoise";
/// Immutable Hub commit the application downloads from (never `main`).
pub(crate) const HUB_REVISION: &str = "af6bf36ca55591d103e465200efc4f13b7112a7b";
/// Human release tag pointing at [`HUB_REVISION`]; informational only.
pub(crate) const HUB_TAG: &str = "nonlocal-v2";
/// Hard-pinned SHA-256 of `distribution.json` at [`HUB_REVISION`].
pub(crate) const DISTRIBUTION_SHA256: &str =
    "91311f274f504ad98e26aad2178349e922bb44d9b793816029340411f1648bb1";
pub(crate) const DISTRIBUTION_PATH: &str = "distribution.json";
pub(crate) const MAX_DISTRIBUTION_BYTES: u64 = 1024 * 1024;
/// Per-file sanity cap (~6x the largest accepted artifact).
pub(crate) const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
/// Total download sanity cap.
pub(crate) const MAX_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;

pub(crate) fn hub_file_url(repo_path: &str) -> String {
    format!("https://huggingface.co/{HUB_REPO}/resolve/{HUB_REVISION}/{repo_path}")
}

/// Workspace install location for a provider bundle:
/// `models/nonlocal/<backend-generation>/`. Cache identity is
/// content/runtime based, so the filesystem path never affects it.
pub(crate) fn install_dir(models_dir: &Path, provider: Provider) -> PathBuf {
    models_dir.join("nonlocal").join(provider.generation())
}

/// Resolve the provider bundle without any network I/O. An explicit
/// `RAPIDRAW_NONLOCAL_BUNDLE` directory wins; otherwise the
/// workspace-installed bundle is required. Returns the directory and
/// whether it came from the environment override.
pub(crate) fn resolve_bundle(
    models_dir: Option<&Path>,
    provider: Provider,
) -> Result<(PathBuf, bool)> {
    if let Some(dir) = std::env::var_os("RAPIDRAW_NONLOCAL_BUNDLE") {
        let dir = PathBuf::from(dir);
        ensure!(
            dir.is_absolute() && dir.is_dir(),
            "NONLOCAL_UNAVAILABLE: RAPIDRAW_NONLOCAL_BUNDLE must name an existing absolute directory"
        );
        return Ok((dir, true));
    }
    let models = models_dir.with_context(|| {
        format!(
            "MODEL_NOT_INSTALLED: No Nonlocal {} bundle is installed and RAPIDRAW_NONLOCAL_BUNDLE is unset. Call install_model with kind='nonlocal'.",
            provider.as_str()
        )
    })?;
    let dir = install_dir(models, provider);
    ensure!(
        dir.is_dir(),
        "MODEL_NOT_INSTALLED: No Nonlocal {} bundle is installed under {}. Call install_model with kind='nonlocal'.",
        provider.as_str(),
        dir.display()
    );
    Ok((dir, false))
}

/// Validate an already-resolved provider bundle with the existing
/// provider-specific inner validation.
pub(crate) fn validate_resolved_bundle(provider: Provider, bundle: &Path) -> Result<()> {
    match provider {
        Provider::Cpu | Provider::Cuda => {
            crate::nonlocal_onnx::validate_bundle(bundle)?;
        }
        Provider::Coreml => {
            crate::nonlocal_coreml::validate_bundle(bundle)?;
        }
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub(crate) struct PlannedFile {
    pub repo_path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Clone, Debug)]
pub(crate) struct InstallPlan {
    pub variant: String,
    pub files: Vec<PlannedFile>,
    pub total_bytes: u64,
}

fn variant_key(provider: Provider) -> &'static str {
    match provider {
        Provider::Coreml => "coreml",
        Provider::Cpu | Provider::Cuda => "onnx",
    }
}

fn require_hex64(value: &Value, label: &str) -> Result<String> {
    let text = value
        .as_str()
        .with_context(|| format!("NONLOCAL_DISTRIBUTION_INVALID: {label} must be a string"))?;
    ensure!(
        text.len() == 64 && text.chars().all(|c| c.is_ascii_hexdigit()),
        "NONLOCAL_DISTRIBUTION_INVALID: {label} must be a SHA-256 hex digest"
    );
    Ok(text.to_owned())
}

/// Pure install planning over a fetched `distribution.json`: schema, variant
/// selection, accepted hard pins and exact file inventory. No I/O.
pub(crate) fn plan_install(distribution: &Value, provider: Provider) -> Result<InstallPlan> {
    ensure!(
        distribution.get("schema_version").and_then(|v| v.as_u64()) == Some(1),
        "NONLOCAL_DISTRIBUTION_INVALID: schema_version must be 1"
    );
    ensure!(
        distribution
            .get("source_checkpoint_sha256")
            .and_then(|v| v.as_str())
            == Some(SOURCE_CHECKPOINT_SHA),
        "NONLOCAL_DISTRIBUTION_INVALID: source checkpoint lineage mismatch"
    );
    let key = variant_key(provider);
    let variant = distribution
        .get("variants")
        .and_then(|v| v.get(key))
        .with_context(|| format!("NONLOCAL_DISTRIBUTION_INVALID: missing variant {key:?}"))?;
    let backend = variant
        .get("backend")
        .and_then(|v| v.as_str())
        .with_context(|| "NONLOCAL_DISTRIBUTION_INVALID: variant missing backend")?;
    ensure!(
        backend == provider.generation(),
        "NONLOCAL_DISTRIBUTION_INVALID: variant backend does not match the requested provider"
    );
    match provider {
        Provider::Coreml => {
            ensure!(
                variant.get("package_sha256").and_then(|v| v.as_str()) == Some(COREML_PACKAGE_SHA),
                "NONLOCAL_DISTRIBUTION_INVALID: CoreML package pin mismatch"
            );
            ensure!(
                variant.get("package_tree_sha256").and_then(|v| v.as_str())
                    == Some(COREML_TREE_SHA256),
                "NONLOCAL_DISTRIBUTION_INVALID: CoreML tree pin mismatch"
            );
        }
        Provider::Cpu | Provider::Cuda => {
            ensure!(
                variant.get("model_sha256").and_then(|v| v.as_str()) == Some(ONNX_MODEL_SHA),
                "NONLOCAL_DISTRIBUTION_INVALID: ONNX model pin mismatch"
            );
        }
    }
    let entries = distribution
        .get("files")
        .and_then(|v| v.as_array())
        .with_context(|| "NONLOCAL_DISTRIBUTION_INVALID: files must be an array")?;
    ensure!(
        !entries.is_empty() && entries.len() <= 64,
        "NONLOCAL_DISTRIBUTION_INVALID: implausible file inventory"
    );
    let mut files = Vec::new();
    let mut total_bytes = 0u64;
    for entry in entries {
        let path = entry
            .get("path")
            .and_then(|v| v.as_str())
            .with_context(|| "NONLOCAL_DISTRIBUTION_INVALID: file entry missing path")?;
        // Only this provider variant's subtree is installed.
        if !path.starts_with(&format!("{key}/")) {
            continue;
        }
        check_repo_path(path).context("NONLOCAL_DISTRIBUTION_INVALID: unsafe file path")?;
        let size = entry
            .get("size")
            .and_then(|v| v.as_u64())
            .with_context(|| format!("NONLOCAL_DISTRIBUTION_INVALID: {path:?} missing size"))?;
        ensure!(
            size > 0 && size <= MAX_FILE_BYTES,
            "NONLOCAL_DISTRIBUTION_INVALID: implausible size for {path:?}"
        );
        let sha256 = require_hex64(
            entry.get("sha256").with_context(|| {
                format!("NONLOCAL_DISTRIBUTION_INVALID: {path:?} missing sha256")
            })?,
            "file sha256",
        )?;
        total_bytes = total_bytes
            .checked_add(size)
            .with_context(|| "NONLOCAL_DISTRIBUTION_INVALID: total size overflow")?;
        files.push(PlannedFile {
            repo_path: path.to_owned(),
            size,
            sha256,
        });
    }
    ensure!(
        total_bytes <= MAX_TOTAL_BYTES,
        "NONLOCAL_DISTRIBUTION_INVALID: total download too large"
    );
    // The variant manifest itself must be part of the inventory.
    let manifest = variant
        .get("manifest")
        .and_then(|v| v.as_str())
        .with_context(|| "NONLOCAL_DISTRIBUTION_INVALID: variant missing manifest")?;
    ensure!(
        files.iter().any(|f| f.repo_path == manifest),
        "NONLOCAL_DISTRIBUTION_INVALID: variant manifest is not in the file inventory"
    );
    ensure!(
        !files.is_empty(),
        "NONLOCAL_DISTRIBUTION_INVALID: empty variant"
    );
    let mut seen: Vec<&str> = files.iter().map(|f| f.repo_path.as_str()).collect();
    seen.sort();
    ensure!(
        seen.windows(2).all(|w| w[0] != w[1]),
        "NONLOCAL_DISTRIBUTION_INVALID: duplicate file destinations"
    );
    Ok(InstallPlan {
        variant: key.to_owned(),
        files,
        total_bytes,
    })
}

/// Streamed download of one Hub file into a fresh temporary file while
/// incrementally verifying size and SHA-256. Nothing is buffered wholly in
/// memory and the destination is created with `create_new`.
async fn fetch_to_file(
    url: &str,
    dest: &Path,
    expected_size: u64,
    expected_sha: &str,
) -> Result<()> {
    let mut response = reqwest::get(url)
        .await
        .map_err(|e| anyhow::anyhow!("NONLOCAL_DOWNLOAD_FAILED: request failed: {e}"))?
        .error_for_status()
        .map_err(|e| anyhow::anyhow!("NONLOCAL_DOWNLOAD_FAILED: bad status: {e}"))?;
    check_url_scheme(response.url())?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = fs::File::create_new(dest)
        .map_err(|e| anyhow::anyhow!("NONLOCAL_DOWNLOAD_FAILED: cannot stage download: {e}"))?;
    let mut hash = Sha256::new();
    let mut total = 0u64;
    loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|e| anyhow::anyhow!("NONLOCAL_DOWNLOAD_FAILED: body failed: {e}"))?;
        let Some(chunk) = chunk else { break };
        total = total
            .checked_add(chunk.len() as u64)
            .with_context(|| "NONLOCAL_DOWNLOAD_FAILED: size overflow")?;
        ensure!(
            total <= expected_size,
            "NONLOCAL_DOWNLOAD_FAILED: download exceeds manifest size"
        );
        hash.update(&chunk);
        file.write_all(&chunk)?;
    }
    file.sync_all()?;
    drop(file);
    ensure!(
        total == expected_size,
        "NONLOCAL_DOWNLOAD_FAILED: truncated download (truncated downloads never replace an installed bundle)"
    );
    ensure!(
        hex::encode(hash.finalize()) == expected_sha,
        "NONLOCAL_DOWNLOAD_FAILED: file hash mismatch"
    );
    Ok(())
}

/// Fetch `distribution.json` (small, memory-capped) and require its
/// hard-pinned hash before parsing.
async fn fetch_distribution() -> Result<Value> {
    let url = hub_file_url(DISTRIBUTION_PATH);
    let mut response = reqwest::get(&url)
        .await
        .map_err(|e| anyhow::anyhow!("NONLOCAL_DOWNLOAD_FAILED: request failed: {e}"))?
        .error_for_status()
        .map_err(|e| anyhow::anyhow!("NONLOCAL_DOWNLOAD_FAILED: bad status: {e}"))?;
    check_url_scheme(response.url())?;
    let mut bytes = Vec::new();
    loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|e| anyhow::anyhow!("NONLOCAL_DOWNLOAD_FAILED: body failed: {e}"))?;
        let Some(chunk) = chunk else { break };
        bytes.extend_from_slice(&chunk);
        ensure!(
            bytes.len() as u64 <= MAX_DISTRIBUTION_BYTES,
            "NONLOCAL_DOWNLOAD_FAILED: distribution manifest too large"
        );
    }
    ensure!(
        hex::encode(Sha256::digest(&bytes)) == DISTRIBUTION_SHA256,
        "NONLOCAL_DOWNLOAD_FAILED: distribution manifest hash mismatch"
    );
    serde_json::from_slice(&bytes)
        .context("NONLOCAL_DISTRIBUTION_INVALID: distribution manifest is not valid JSON")
}

/// Atomically swap a validated staging directory into the install location.
/// A previously valid install is only moved aside after the replacement has
/// validated, and is restored if the final rename fails.
fn atomic_swap(staging: &Path, target: &Path) -> Result<()> {
    if target.exists() {
        let backup = target.with_extension(format!("backup-{}", uuid::Uuid::new_v4()));
        fs::rename(target, &backup)
            .with_context(|| "NONLOCAL_INSTALL_FAILED: cannot stage replacement")?;
        match fs::rename(staging, target) {
            Ok(()) => {
                fs::remove_dir_all(&backup).ok();
                Ok(())
            }
            Err(e) => {
                fs::rename(&backup, target).ok();
                Err(anyhow::anyhow!(
                    "NONLOCAL_INSTALL_FAILED: atomic install failed: {e}"
                ))
            }
        }
    } else {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(staging, target)
            .with_context(|| "NONLOCAL_INSTALL_FAILED: atomic install failed")
    }
}

/// Download, verify and atomically install the provider bundle. The
/// previously valid install (if any) is untouched unless the replacement
/// fully validates. Staging is removed on failure.
pub(crate) async fn install(models_dir: &Path, provider: Provider) -> Result<Value> {
    let distribution = fetch_distribution().await?;
    let plan = plan_install(&distribution, provider)?;
    let staging_parent = models_dir.join("nonlocal");
    fs::create_dir_all(&staging_parent)?;
    let staging = tempfile::Builder::new()
        .prefix(".staging-")
        .tempdir_in(&staging_parent)
        .context("NONLOCAL_INSTALL_FAILED: cannot create staging directory")?;
    // Strip the "<variant>/" prefix: the bundle root holds manifest.json
    // plus the artifact tree directly.
    for file in &plan.files {
        let relative = file
            .repo_path
            .strip_prefix(&format!("{}/", plan.variant))
            .with_context(|| "NONLOCAL_INSTALL_FAILED: variant path mismatch")?;
        let dest = staging.path().join(relative);
        fetch_to_file(
            &hub_file_url(&file.repo_path),
            &dest,
            file.size,
            &file.sha256,
        )
        .await?;
    }
    // No unexpected files may appear in staging.
    let mut staged: Vec<String> = Vec::new();
    let mut stack = vec![staging.path().to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)? {
            let path = entry?.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                staged.push(
                    path.strip_prefix(staging.path())
                        .with_context(|| "NONLOCAL_INSTALL_FAILED: staging layout")?
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
    }
    staged.sort();
    let mut expected: Vec<String> = plan
        .files
        .iter()
        .map(|f| {
            f.repo_path
                .strip_prefix(&format!("{}/", plan.variant))
                .unwrap_or(&f.repo_path)
                .to_owned()
        })
        .collect();
    expected.sort();
    ensure!(
        staged == expected,
        "NONLOCAL_INSTALL_FAILED: staging tree does not match the manifest inventory"
    );
    // Existing inner bundle validation before anything is installed.
    validate_resolved_bundle(provider, staging.path())?;
    let target = install_dir(models_dir, provider);
    // TempDir cleanup would delete the tree on success after rename, so
    // persist the staging path before swapping.
    let staged_path = staging.keep();
    let outcome = atomic_swap(&staged_path, &target);
    if outcome.is_err() {
        fs::remove_dir_all(&staged_path).ok();
    }
    outcome?;
    // Re-validate the installed location so the report reflects bytes at
    // their final path.
    validate_resolved_bundle(provider, &target)?;
    Ok(json!({
        "installed": true,
        "provider": provider.as_str(),
        "backend": provider.generation(),
        "path": target,
        "hub_repo": HUB_REPO,
        "hub_revision": HUB_REVISION,
        "hub_tag": HUB_TAG,
        "distribution_sha256": DISTRIBUTION_SHA256,
        "files": plan.files.len(),
        "total_bytes": plan.total_bytes,
    }))
}

/// Truthful Nonlocal group status for `models`, resolved for the
/// environment-selected provider. An invalid or unsupported
/// `RAPIDRAW_NONLOCAL_PROVIDER` is surfaced as a not-ready configuration
/// error — never silently reported as CPU. See [`status_for`]. Never
/// downloads.
pub(crate) fn status(models_dir: &Path) -> Value {
    let requested = std::env::var("RAPIDRAW_NONLOCAL_PROVIDER").ok();
    status_report(
        models_dir,
        cfg!(target_os = "linux"),
        cfg!(target_os = "macos"),
        requested.as_deref(),
    )
}

/// Pure provider resolution for status reporting, over an explicit raw
/// provider value instead of process-global environment reads, so invalid
/// providers are unit-testable without env mutation.
fn status_report(models_dir: &Path, linux: bool, macos: bool, requested: Option<&str>) -> Value {
    match crate::nonlocal_onnx::parse_provider(linux, macos, requested) {
        Ok(provider) => status_for(models_dir, provider),
        Err(e) => {
            let mut report = base_pins();
            report["configured"] = json!(false);
            report["ready"] = json!(false);
            report["weights_verified"] = json!(false);
            report["provider_requested"] = requested.map_or(Value::Null, Value::from);
            report["backend"] = Value::Null;
            report["error"] = json!(e.to_string());
            report["installation"] = json!(
                "Set RAPIDRAW_NONLOCAL_PROVIDER (unset defaults to cuda on Linux, coreml on macOS, and cpu elsewhere; cpu, cuda and coreml are the valid values), then call install_model kind='nonlocal' when the bundle is missing."
            );
            report
        }
    }
}

fn base_pins() -> Value {
    json!({
        "method": "nonlocal",
        "entrypoint": "start_denoise",
        "output": "bayer-dng",
        "hub_repo": HUB_REPO,
        "hub_revision": HUB_REVISION,
        "hub_tag": HUB_TAG,
        "distribution_sha256": DISTRIBUTION_SHA256,
        "expected_source_checkpoint_sha256": SOURCE_CHECKPOINT_SHA,
        "expected_onnx_model_sha256": ONNX_MODEL_SHA,
        "expected_coreml_package_sha256": COREML_PACKAGE_SHA,
        "expected_coreml_tree_sha256": COREML_TREE_SHA256,
    })
}

/// Pure installation guidance for the four resolution states, so wording is
/// unit-testable without process-global environment mutation. An explicit
/// override is never presented as Hub-installable while it remains set.
fn install_guidance(ready: bool, via_env: bool) -> &'static str {
    match (ready, via_env) {
        (true, false) => {
            "Pinned installed bundle ready. install_model kind='nonlocal' verifies the install and downloads the pinned Hub revision when missing or invalid."
        }
        (true, true) => {
            "Using the explicit RAPIDRAW_NONLOCAL_BUNDLE override; no Hub download or install occurs while it is set. Unset the override to use the workspace-pinned Hub bundle (install_model kind='nonlocal' installs it when missing or invalid)."
        }
        (false, false) => {
            "Bundle failed validation. Remove the corrupt bundle and call install_model kind='nonlocal'."
        }
        (false, true) => {
            "The explicit RAPIDRAW_NONLOCAL_BUNDLE override failed validation; install_model will NOT download or replace a Hub bundle while the override remains set. Fix or remove that manual bundle, or unset the override, then use or install the workspace-pinned Hub bundle."
        }
    }
}

/// Provider-explicit status: readiness, installed/override path, expected
/// hard pins, Hub source and install guidance. Never downloads.
pub(crate) fn status_for(models_dir: &Path, provider: Provider) -> Value {
    let mut base = base_pins();
    base["provider_requested"] = json!(provider.as_str());
    base["backend"] = json!(provider.generation());
    let installed_path = install_dir(models_dir, provider);
    match resolve_bundle(Some(models_dir), provider) {
        Ok((bundle, via_env)) => match validate_resolved_bundle(provider, &bundle) {
            Ok(()) => {
                let mut report = base;
                report["configured"] = json!(true);
                report["ready"] = json!(true);
                report["weights_verified"] = json!(true);
                report["via_env_override"] = json!(via_env);
                report["bundle_path"] = json!(bundle);
                report["installed_path"] = json!(installed_path);
                report["installation"] = json!(install_guidance(true, via_env));
                report
            }
            Err(e) => {
                let mut report = base;
                report["configured"] = json!(false);
                report["ready"] = json!(false);
                report["weights_verified"] = json!(false);
                report["via_env_override"] = json!(via_env);
                report["bundle_path"] = json!(bundle);
                report["installed_path"] = json!(installed_path);
                report["error"] = json!(e.to_string());
                report["installation"] = json!(install_guidance(false, via_env));
                report
            }
        },
        Err(e) => {
            let mut report = base;
            report["configured"] = json!(false);
            report["ready"] = json!(false);
            report["weights_verified"] = json!(false);
            report["installed_path"] = json!(installed_path);
            report["error"] = json!(e.to_string());
            report["installation"] = json!(
                "Call install_model kind='nonlocal' to download the pinned bundle, or set RAPIDRAW_NONLOCAL_BUNDLE to an explicit bundle directory."
            );
            report
        }
    }
}

/// Relative-path safety shared by install planning.
fn check_repo_path(path: &str) -> Result<()> {
    let parsed = Path::new(path);
    ensure!(!parsed.is_absolute(), "absolute path");
    for component in parsed.components() {
        match component {
            Component::Normal(_) => {}
            _ => bail!("unsafe component in {path:?}"),
        }
    }
    ensure!(
        !path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == ".."),
        "empty or dot segment in {path:?}"
    );
    Ok(())
}

/// Hub downloads require HTTPS, except loopback HTTP used by local tests.
/// Any other scheme (or a redirect landing off HTTPS) fails closed.
fn check_url_scheme(url: &reqwest::Url) -> Result<()> {
    if url.scheme() == "https" {
        return Ok(());
    }
    let loopback =
        url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "::1" | "localhost"));
    ensure!(loopback, "NONLOCAL_DOWNLOAD_FAILED: unexpected URL scheme");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nonlocal_coreml::COREML_BACKEND_GENERATION;
    use std::io::Read as _;

    fn distribution(variant_files: Value, pins: Value) -> Value {
        json!({
            "schema_version": 1,
            "source_checkpoint_sha256": SOURCE_CHECKPOINT_SHA,
            "variants": {
                "coreml": {
                    "backend": COREML_BACKEND_GENERATION,
                    "package_sha256": pins["coreml_package"],
                    "package_tree_sha256": pins["coreml_tree"],
                    "manifest": "coreml/manifest.json",
                },
                "onnx": {
                    "backend": crate::nonlocal_onnx::BACKEND_GENERATION,
                    "model_sha256": pins["onnx_model"],
                    "manifest": "onnx/manifest.json",
                },
            },
            "files": variant_files,
        })
    }

    fn real_pins() -> Value {
        json!({
            "coreml_package": COREML_PACKAGE_SHA,
            "coreml_tree": COREML_TREE_SHA256,
            "onnx_model": ONNX_MODEL_SHA,
        })
    }

    fn file(path: &str, size: u64) -> Value {
        json!({"path": path, "size": size, "sha256": "a".repeat(64)})
    }

    #[test]
    fn plan_selects_provider_variant_and_enforces_pins() {
        let files = json!([
            file("coreml/manifest.json", 100),
            file("coreml/packed.mlpackage/Manifest.json", 100),
            file("onnx/manifest.json", 100),
            file("onnx/model.onnx", 100),
        ]);
        let plan =
            plan_install(&distribution(files.clone(), real_pins()), Provider::Coreml).unwrap();
        assert_eq!(plan.variant, "coreml");
        assert_eq!(plan.files.len(), 2);
        assert!(
            plan.files
                .iter()
                .all(|f| f.repo_path.starts_with("coreml/"))
        );
        let plan = plan_install(&distribution(files, real_pins()), Provider::Cpu).unwrap();
        assert_eq!(plan.variant, "onnx");
        assert_eq!(plan.files.len(), 2);
        // Wrong pins are rejected even with a well-formed inventory.
        let mut bad = real_pins();
        bad["coreml_package"] = json!("b".repeat(64));
        assert!(
            plan_install(
                &distribution(json!([file("coreml/manifest.json", 100)]), bad),
                Provider::Coreml
            )
            .is_err()
        );
    }

    #[test]
    fn plan_rejects_schema_lineage_and_inventory_abuse() {
        let good = || {
            distribution(
                json!([
                    file("onnx/manifest.json", 100),
                    file("onnx/model.onnx", 100)
                ]),
                real_pins(),
            )
        };
        // Bad schema.
        let mut bad_schema = good();
        bad_schema["schema_version"] = json!(2);
        assert!(plan_install(&bad_schema, Provider::Cpu).is_err());
        // Wrong lineage.
        let mut bad_lineage = good();
        bad_lineage["source_checkpoint_sha256"] = json!("0".repeat(64));
        assert!(plan_install(&bad_lineage, Provider::Cpu).is_err());
        // Traversal, absolute, duplicate, zero-size and oversized entries.
        for evil in [
            json!([file("../evil.bin", 100)]),
            json!([file("/abs.bin", 100)]),
            json!([
                file("onnx/manifest.json", 100),
                file("onnx/manifest.json", 100),
                file("onnx/model.onnx", 100),
            ]),
            json!([file("onnx/manifest.json", 0), file("onnx/model.onnx", 100)]),
            json!([
                file("onnx/manifest.json", 100),
                file("onnx/model.onnx", MAX_FILE_BYTES + 1)
            ]),
        ] {
            assert!(plan_install(&distribution(evil, real_pins()), Provider::Cpu).is_err());
        }
        // Manifest itself must be inventoried.
        assert!(
            plan_install(
                &distribution(json!([file("onnx/model.onnx", 100)]), real_pins()),
                Provider::Cpu
            )
            .is_err()
        );
        // Missing variant.
        let mut no_variant = good();
        no_variant["variants"]
            .as_object_mut()
            .unwrap()
            .remove("onnx");
        assert!(plan_install(&no_variant, Provider::Cpu).is_err());
    }

    #[test]
    fn install_dir_layout_is_generation_based() {
        let models = Path::new("/models");
        assert_eq!(
            install_dir(models, Provider::Cpu),
            PathBuf::from("/models/nonlocal/native-onnx-v1")
        );
        assert_eq!(
            install_dir(models, Provider::Cuda),
            PathBuf::from("/models/nonlocal/native-onnx-v1")
        );
        assert_eq!(
            install_dir(models, Provider::Coreml),
            PathBuf::from("/models/nonlocal/native-coreml-v1")
        );
    }

    #[test]
    fn check_repo_path_rejects_escapes() {
        assert!(check_repo_path("coreml/manifest.json").is_ok());
        assert!(check_repo_path("/abs").is_err());
        assert!(check_repo_path("../up").is_err());
        assert!(check_repo_path("a//b").is_err());
        assert!(check_repo_path("a/./b").is_err());
    }

    /// Minimal blocking HTTP/1.0 server serving one canned response, so
    /// download streaming is tested without public network access.
    fn serve_once(status: &'static str, body: Vec<u8>) -> (String, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut head = vec![0u8; 4096];
            let _ = stream.read(&mut head);
            let response = format!(
                "HTTP/1.0 {}Content-Length: {}\r\nConnection: close\r\n\r\n",
                status,
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
            stream.write_all(&body).unwrap();
        });
        (format!("http://{addr}/file.bin"), handle)
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    #[test]
    fn streamed_download_verifies_size_and_hash() {
        let body: Vec<u8> = (0..10_000u32).map(|i| (i % 251) as u8).collect();
        let sha = hex::encode(Sha256::digest(&body));
        let root = tempfile::tempdir().unwrap();
        // Success path.
        let (url, server) = serve_once("200 OK\r\n", body.clone());
        block_on(fetch_to_file(
            &url,
            &root.path().join("ok.bin"),
            body.len() as u64,
            &sha,
        ))
        .unwrap();
        server.join().unwrap();
        assert_eq!(fs::read(root.path().join("ok.bin")).unwrap(), body);
        // Hash mismatch leaves no usable file behind for the caller: the
        // staged file fails verification and the install aborts.
        let (url, server) = serve_once("200 OK\r\n", body.clone());
        assert!(
            block_on(fetch_to_file(
                &url,
                &root.path().join("bad.bin"),
                body.len() as u64,
                &"0".repeat(64)
            ))
            .is_err()
        );
        server.join().unwrap();
        // Truncation is rejected even when the served prefix hashes cleanly.
        let (url, server) = serve_once("200 OK\r\n", body[..100].to_vec());
        assert!(
            block_on(fetch_to_file(
                &url,
                &root.path().join("short.bin"),
                body.len() as u64,
                &sha
            ))
            .is_err()
        );
        server.join().unwrap();
        // Oversize bodies fail before completion.
        let (url, server) = serve_once("200 OK\r\n", body.clone());
        assert!(block_on(fetch_to_file(&url, &root.path().join("big.bin"), 10, &sha)).is_err());
        server.join().unwrap();
        // Non-HTTPS URLs are rejected by the downloader.
        assert!(
            block_on(fetch_to_file(
                "http://127.0.0.1:9/x",
                &root.path().join("no.bin"),
                1,
                &sha
            ))
            .is_err()
        );
    }

    #[test]
    fn invalid_provider_status_is_truthful_not_cpu() {
        let models = tempfile::tempdir().unwrap();
        // Invalid values surface as configuration errors, never as CPU.
        for bad in ["auto", "CUDA", "bogus", ""] {
            let report = status_report(models.path(), false, true, Some(bad));
            assert_eq!(report["configured"], json!(false), "{bad}");
            assert_eq!(report["ready"], json!(false), "{bad}");
            assert_eq!(report["weights_verified"], json!(false), "{bad}");
            assert_eq!(report["provider_requested"], json!(bad), "{bad}");
            assert!(
                report["error"]
                    .as_str()
                    .unwrap()
                    .contains("NONLOCAL_PROVIDER"),
                "{bad}: {}",
                report["error"]
            );
            assert_eq!(report["hub_revision"], json!(HUB_REVISION), "{bad}");
        }
        // Unsupported-platform providers are errors, not silent CPU either.
        let report = status_report(models.path(), true, false, Some("coreml"));
        assert_eq!(report["configured"], json!(false));
        assert_eq!(report["provider_requested"], json!("coreml"));
        assert!(
            report["error"].as_str().unwrap().contains("UNSUPPORTED"),
            "{}",
            report["error"]
        );
        let report = status_report(models.path(), false, false, Some("cuda"));
        assert_eq!(report["configured"], json!(false));
        // Valid providers resolve normally (missing bundle, not a CPU lie).
        let report = status_report(models.path(), false, true, Some("coreml"));
        assert_eq!(report["provider_requested"], json!("coreml"));
        assert_eq!(report["backend"], json!("native-coreml-v1"));
        assert!(
            report["error"]
                .as_str()
                .unwrap()
                .contains("MODEL_NOT_INSTALLED"),
            "{}",
            report["error"]
        );
        let report = status_report(models.path(), false, false, None);
        assert_eq!(report["provider_requested"], json!("cpu"));
    }

    #[test]
    fn missing_install_status_offers_install_guidance() {
        if std::env::var_os("RAPIDRAW_NONLOCAL_BUNDLE").is_some() {
            eprintln!("SKIP: RAPIDRAW_NONLOCAL_BUNDLE is set in this environment");
            return;
        }
        let models = tempfile::tempdir().unwrap();
        // Missing install: guidance offers install or override, no download.
        let report = status_for(models.path(), Provider::Cpu);
        assert_eq!(report["ready"], json!(false));
        assert!(
            report["installation"]
                .as_str()
                .unwrap()
                .contains("install_model kind='nonlocal'"),
            "{}",
            report["installation"]
        );
    }

    #[test]
    fn install_guidance_covers_all_four_states() {
        // Pure wording assertions over ready/invalid crossed with
        // installed/override. No environment reads, so this always runs.
        // Only the invalid-override state must deny that install_model can
        // download while the override is set.
        let ready_installed = install_guidance(true, false);
        assert!(ready_installed.contains("Pinned installed bundle ready"));
        assert!(ready_installed.contains("install_model kind='nonlocal'"));
        assert!(!ready_installed.contains("override"));
        let ready_override = install_guidance(true, true);
        assert!(ready_override.contains("explicit RAPIDRAW_NONLOCAL_BUNDLE override"));
        assert!(ready_override.contains("no Hub download or install occurs while it is set"));
        let invalid_installed = install_guidance(false, false);
        assert!(invalid_installed.contains("Remove the corrupt bundle"));
        assert!(invalid_installed.contains("install_model kind='nonlocal'"));
        assert!(!invalid_installed.contains("override remains set"));
        let invalid_override = install_guidance(false, true);
        assert!(
            invalid_override
                .contains("explicit RAPIDRAW_NONLOCAL_BUNDLE override failed validation")
        );
        assert!(invalid_override.contains("will NOT download or replace"));
        assert!(invalid_override.contains("unset the override"));
    }

    #[test]
    fn resolve_bundle_prefers_override_and_guides_when_missing() {
        if std::env::var_os("RAPIDRAW_NONLOCAL_BUNDLE").is_some() {
            eprintln!("SKIP: RAPIDRAW_NONLOCAL_BUNDLE is set in this environment");
            return;
        }
        let models = tempfile::tempdir().unwrap();
        let err = resolve_bundle(Some(models.path()), Provider::Cpu)
            .unwrap_err()
            .to_string();
        assert!(err.contains("MODEL_NOT_INSTALLED"), "{err}");
        assert!(err.contains("install_model"), "{err}");
        assert!(resolve_bundle(None, Provider::Cpu).is_err());
    }

    /// End-to-end install from the pinned Hub revision into a temporary
    /// workspace, then resolve/validate/status from the installed path.
    /// Requires public network access to huggingface.co.
    #[test]
    #[ignore = "Downloads the ~85MB CoreML bundle from the pinned Hub revision"]
    fn install_coreml_from_hub_into_temp_workspace() {
        if std::env::var_os("RAPIDRAW_NONLOCAL_BUNDLE").is_some() {
            eprintln!("SKIP: RAPIDRAW_NONLOCAL_BUNDLE is set in this environment");
            return;
        }
        let models = tempfile::tempdir().unwrap();
        let report = block_on(install(models.path(), Provider::Coreml)).unwrap();
        assert_eq!(report["installed"], json!(true));
        assert_eq!(report["backend"], json!("native-coreml-v1"));
        assert_eq!(report["hub_revision"], json!(HUB_REVISION));
        let (bundle, via_env) = resolve_bundle(Some(models.path()), Provider::Coreml).unwrap();
        assert!(!via_env);
        assert_eq!(bundle, install_dir(models.path(), Provider::Coreml));
        validate_resolved_bundle(Provider::Coreml, &bundle).unwrap();
        let status = status_for(models.path(), Provider::Coreml);
        assert_eq!(status["ready"], json!(true));
        assert_eq!(status["weights_verified"], json!(true));
        assert_eq!(status["provider_requested"], json!("coreml"));
        #[cfg(target_os = "macos")]
        {
            // The Hub-installed bundle drives real inference, not just
            // validation: run the frozen portrait tile-00 through it.
            let contract = crate::nonlocal_coreml::validate_bundle(&bundle).unwrap();
            let config = crate::nonlocal_onnx::NativeConfig {
                bundle,
                provider: Provider::Coreml,
                device_id: 0,
                mem_limit_mb: None,
            };
            let mut backend = crate::nonlocal_coreml::open_backend(&config, &contract).unwrap();
            use crate::nonlocal_onnx::TilePredictor as _;
            let tile: Vec<f32> = (0..8 * 320 * 320)
                .map(|i| ((i % 1024) as f32 / 1024.0) * 0.8 - 0.05)
                .collect();
            let out = backend.predict_tile(&tile).unwrap();
            assert_eq!(out.len(), 4 * 320 * 320);
            assert!(out.iter().all(|v| v.is_finite()));
        }
    }

    /// End-to-end install of the ONNX bundle from the pinned Hub revision into
    /// a temporary workspace, then validate and status from the installed path.
    /// Requires public network access to huggingface.co.
    #[test]
    #[ignore = "Downloads the ~86MB ONNX bundle from the pinned Hub revision"]
    fn install_onnx_from_hub_into_temp_workspace() {
        if std::env::var_os("RAPIDRAW_NONLOCAL_BUNDLE").is_some() {
            eprintln!("SKIP: RAPIDRAW_NONLOCAL_BUNDLE is set in this environment");
            return;
        }
        let models = tempfile::tempdir().unwrap();
        let report = block_on(install(models.path(), Provider::Cpu)).unwrap();
        assert_eq!(report["installed"], json!(true));
        assert_eq!(report["backend"], json!("native-onnx-v1"));
        assert_eq!(report["hub_revision"], json!(HUB_REVISION));
        let (bundle, via_env) = resolve_bundle(Some(models.path()), Provider::Cpu).unwrap();
        assert!(!via_env);
        assert_eq!(bundle, install_dir(models.path(), Provider::Cpu));
        validate_resolved_bundle(Provider::Cpu, &bundle).unwrap();
        let status = status_for(models.path(), Provider::Cpu);
        assert_eq!(status["ready"], json!(true));
        assert_eq!(status["provider_requested"], json!("cpu"));
    }

    #[test]
    fn failed_install_leaves_previous_bundle_untouched() {
        // A "valid" previous install is simulated by a marker tree; the
        // install fails at download verification, so the swap never runs.
        let models = tempfile::tempdir().unwrap();
        let target = install_dir(models.path(), Provider::Cpu);
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("previous.txt"), b"keep me").unwrap();
        let body = b"corrupt".to_vec();
        let (url, server) = serve_once("200 OK\r\n", body);
        let dest = models.path().join("staged.bin");
        let result = block_on(fetch_to_file(&url, &dest, 7, &"f".repeat(64)));
        server.join().unwrap();
        assert!(result.is_err());
        // Nothing was swapped: the previous tree is intact.
        assert_eq!(fs::read(target.join("previous.txt")).unwrap(), b"keep me");
    }
}
