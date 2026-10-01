//! Bayer-domain Nonlocal inference. Decoding and DNG writing use the editor's
//! RAW library; inference runs in-process through the native ONNX Runtime
//! backend (`crate::nonlocal_onnx`) on CPU or Linux CUDA, or directly
//! through CoreML.framework (`crate::nonlocal_coreml`) on macOS.
//! Cancellation lands on tile boundaries: an active ORT/CoreML prediction
//! is not forcibly aborted.
use crate::{
    denoising::DenoiseControl,
    nonlocal_coreml::{self, COREML_BACKEND_GENERATION, COREML_PACKAGE_SHA},
    nonlocal_onnx::{
        self, ALGORITHM, BACKEND_GENERATION, HALO, NativeConfig, SOURCE_CHECKPOINT_SHA, TILE,
    },
};
use anyhow::{Context, Result, bail, ensure};
use rawler::{
    decoders::{RawDecodeParams, RawMetadata},
    dng::{
        CropMode, DNG_VERSION_V1_4, DngCompression, DngPhotometricConversion, writer::DngWriter,
    },
    imgop::{Dim2, Point, Rect},
    rawimage::{RawImage, RawImageData, RawPhotometricInterpretation},
    rawsource::RawSource,
    tags::{ExifTag, TiffCommonTag},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{BufWriter, Read, Write},
    path::{Path, PathBuf},
};

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

/// Workspace-aware configuration: an explicit `RAPIDRAW_NONLOCAL_BUNDLE`
/// wins, otherwise the bundle installed under `models/nonlocal/` is used.
/// Never downloads; missing bundles fail with `MODEL_NOT_INSTALLED`.
pub(crate) fn configuration_with_models(models_dir: Option<&Path>) -> Result<NativeConfig> {
    nonlocal_onnx::configuration_with_models(models_dir)
}

struct Packed {
    width: usize,
    height: usize,
    positions: [(usize, usize); 4],
    black: [f32; 4],
    white: f32,
    values: Vec<f32>,
}

/// Physically crop inactive sensor borders, keeping CFA, black repeat and the
/// default crop in the new coordinate system. The rendered geometry is unchanged.
fn prepare(raw: &mut RawImage) -> Result<Packed> {
    ensure!(
        raw.cpp == 1 && raw.width > 0 && raw.height > 0,
        "NONLOCAL_UNSUPPORTED: Expected single-sample Bayer RAW"
    );
    let RawPhotometricInterpretation::Cfa(config) = &mut raw.photometric else {
        bail!("NONLOCAL_UNSUPPORTED: Expected Bayer RAW, not RGB or linear DNG");
    };
    ensure!(
        config.cfa.width == 2 && config.cfa.height == 2 && config.cfa.is_rgb(),
        "NONLOCAL_UNSUPPORTED: Only RGB Bayer CFA is supported"
    );
    ensure!(
        raw.whitelevel.0.len() == 1
            && raw.blacklevel.cpp == 1
            && raw.blacklevel.levels.len() == raw.blacklevel.width * raw.blacklevel.height
            && [1, 2].contains(&raw.blacklevel.width)
            && [1, 2].contains(&raw.blacklevel.height),
        "NONLOCAL_UNSUPPORTED: Unsupported black/white repeat pattern"
    );
    let area = raw.active_area.unwrap_or(Rect::new(
        Point::new(0, 0),
        Dim2::new(raw.width, raw.height),
    ));
    let (x, y, w, h) = (area.p.x, area.p.y, area.d.w, area.d.h);
    ensure!(
        w >= 16
            && h >= 16
            && w <= 20000
            && h <= 20000
            && w * h <= 200_000_000
            && w % 2 == 0
            && h % 2 == 0
            && x + w <= raw.width
            && y + h <= raw.height,
        "NONLOCAL_UNSUPPORTED: Expected even Bayer active dimensions between 16 and 20000 pixels"
    );
    if let Some(crop) = raw.crop_area {
        ensure!(
            crop.p.x >= x
                && crop.p.y >= y
                && crop.p.x + crop.d.w <= x + w
                && crop.p.y + crop.d.h <= y + h,
            "NONLOCAL_UNSUPPORTED: Default crop lies outside the active area"
        );
        raw.crop_area = Some(Rect::new(Point::new(crop.p.x - x, crop.p.y - y), crop.d));
    }
    let pixels = raw.data.as_f32();
    ensure!(
        pixels.len() == raw.width * raw.height,
        "NONLOCAL_UNSUPPORTED: Invalid sensor buffer"
    );
    let mut active = Vec::with_capacity(w * h);
    for row in y..y + h {
        active.extend_from_slice(&pixels[row * raw.width + x..row * raw.width + x + w]);
    }
    drop(pixels);
    config.cfa = config.cfa.shift(x, y);
    raw.camera.cfa = config.cfa.clone();
    raw.blacklevel = raw.blacklevel.shift(x, y);
    raw.width = w;
    raw.height = h;
    raw.active_area = Some(Rect::new(Point::new(0, 0), Dim2::new(w, h)));
    raw.blackareas.clear();
    let mut red = None;
    let mut blue = None;
    let mut greens = Vec::new();
    for row in 0..2 {
        for col in 0..2 {
            match config.cfa.color_at(row, col) {
                0 => red = Some((row, col)),
                1 => greens.push((row, col)),
                2 => blue = Some((row, col)),
                _ => bail!("NONLOCAL_UNSUPPORTED: Non-RGB CFA"),
            }
        }
    }
    ensure!(
        red.is_some() && blue.is_some() && greens.len() == 2,
        "NONLOCAL_UNSUPPORTED: Invalid Bayer layout"
    );
    let red = red.unwrap();
    // Checkpoint convention is R, green on the red row, B, other green.
    greens.sort_by_key(|p| p.0 != red.0);
    let positions = [red, greens[0], blue.unwrap(), greens[1]];
    let white = raw.whitelevel.0[0] as f32;
    let mut black = [0.; 4];
    let plane = w * h / 4;
    let mut values = vec![0.; w * h];
    for (c, &(dy, dx)) in positions.iter().enumerate() {
        black[c] = raw.blacklevel.levels
            [(dy % raw.blacklevel.height) * raw.blacklevel.width + dx % raw.blacklevel.width]
            .as_f32();
        ensure!(
            black[c].is_finite() && white > black[c],
            "NONLOCAL_UNSUPPORTED: Invalid RAW normalization levels"
        );
        for row in 0..h / 2 {
            for col in 0..w / 2 {
                let value =
                    (active[(row * 2 + dy) * w + col * 2 + dx] - black[c]) / (white - black[c]);
                ensure!(
                    value.is_finite(),
                    "NONLOCAL_UNSUPPORTED: Nonfinite RAW data"
                );
                values[c * plane + row * w / 2 + col] = value;
            }
        }
    }
    raw.data = RawImageData::Float(active);
    raw.bps = 32;
    Ok(Packed {
        width: w / 2,
        height: h / 2,
        positions,
        black,
        white,
        values,
    })
}

fn blend(raw: &mut RawImage, packed: &Packed, prediction: &[f32], strength: f32) -> Result<()> {
    ensure!(
        strength.is_finite() && (0.0..=1.0).contains(&strength),
        "Invalid denoise strength"
    );
    ensure!(
        prediction.len() == packed.values.len() && prediction.iter().all(|v| v.is_finite()),
        "Invalid RAW prediction"
    );
    let RawImageData::Float(pixels) = &mut raw.data else {
        bail!("Expected prepared sensor buffer")
    };
    if strength == 0. {
        return Ok(());
    }
    let plane = packed.width * packed.height;
    for (c, &(dy, dx)) in packed.positions.iter().enumerate() {
        for row in 0..packed.height {
            for col in 0..packed.width {
                let p = c * plane + row * packed.width + col;
                let index = (row * 2 + dy) * raw.width + col * 2 + dx;
                // Preserve unclipped highlights above the model's training range.
                let predicted = if packed.values[p] >= 1. {
                    pixels[index]
                } else {
                    prediction[p] * (packed.white - packed.black[c]) + packed.black[c]
                };
                pixels[index] += strength * (predicted - pixels[index]);
            }
        }
    }
    Ok(())
}

fn write_dng(path: &Path, raw: &RawImage, metadata: &RawMetadata) -> Result<()> {
    // Match the pinned rawler encoder's strip layout, but write TIFF's scalar
    // RowsPerStrip instead of its nonstandard array of per-strip row counts.
    let env_usize = |name: &str| {
        std::env::var(name)
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
    };
    let rows_per_strip = if raw.height > env_usize("RAWLER_DNG_MULTISTRIP_THRESHOLD").unwrap_or(100)
    {
        env_usize("RAWLER_DNG_ROWS_PER_STRIP")
            .unwrap_or(256)
            .min(raw.height)
    } else {
        raw.height
    };
    ensure!(rows_per_strip > 0, "Invalid DNG rows per strip");
    let mut file = File::options().write(true).create_new(true).open(path)?;
    {
        let mut buffer = BufWriter::new(&mut file);
        let mut dng = DngWriter::new(&mut buffer, DNG_VERSION_V1_4)?;
        let mut frame = dng.subframe_on_root(0);
        frame.raw_image(
            raw,
            CropMode::Best,
            DngCompression::Uncompressed,
            DngPhotometricConversion::Original,
            1,
        )?;
        frame
            .ifd_mut()
            .add_tag(TiffCommonTag::RowsPerStrip, rows_per_strip as u32);
        frame.finalize()?;
        dng.load_base_tags(raw)?;
        dng.load_metadata(metadata)?;
        dng.root_ifd_mut().add_tag(
            ExifTag::Orientation,
            metadata
                .exif
                .orientation
                .unwrap_or(raw.orientation.to_u16()),
        );
        dng.exif_ifd_mut().remove_tag(ExifTag::MakerNotes);
        dng.close()?;
        buffer.flush()?;
    }
    file.sync_all()?;
    Ok(())
}

fn regular_file(path: &Path) -> Result<()> {
    ensure!(
        fs::symlink_metadata(path)?.file_type().is_file(),
        "Expected regular Nonlocal cache file"
    );
    Ok(())
}

/// Write packed sensor planes as little-endian float32, matching the Python
/// worker's `np.fromfile(..., dtype="<f4")` boundary. Extracted so the
/// diagnostic fixture exporter reuses the exact production bytes.
fn write_packed_input(path: &Path, values: &[f32]) -> Result<()> {
    let mut writer = BufWriter::new(File::create(path)?);
    for value in values {
        writer.write_all(&value.to_le_bytes())?;
    }
    writer.flush()?;
    drop(writer);
    Ok(())
}

/// Build the native-ONNX cache/request identity (protocol 2). Legacy
/// protocol-1 PyTorch-worker entries live under a different directory and a
/// different hash preimage, so they can never be accepted as native results.
fn native_onnx_request(
    config: &NativeConfig,
    model_sha256: &str,
    (packed_height, packed_width): (usize, usize),
    input_sha: &str,
    source_sha: &str,
    ort_build: &str,
) -> Value {
    json!({"protocol":2,"algorithm":ALGORITHM,"backend":BACKEND_GENERATION,
        "model_sha256":model_sha256,"source_checkpoint_sha256":SOURCE_CHECKPOINT_SHA,
        "input_sha256":input_sha,"source_sha256":source_sha,
        "shape":[4,packed_height,packed_width],"tile":TILE,"halo":HALO,
        "provider":config.provider_as_str(),
        "device_id":config.device_id_or_null(),
        "graph_optimization":false,"tf32":false,
        "ort_build":ort_build})
}

fn prediction(
    directory: &Path,
    request: &Value,
    request_sha: &str,
    count: usize,
) -> Result<(Vec<f32>, Value)> {
    let result_path = directory.join("result.json");
    let pixels_path = directory.join("prediction.f32");
    regular_file(&result_path)?;
    regular_file(&pixels_path)?;
    ensure!(
        fs::metadata(&result_path)?.len() < 1024 * 1024,
        "Oversized Nonlocal result manifest"
    );
    let result: Value = serde_json::from_slice(&fs::read(result_path)?)?;
    for key in [
        "protocol",
        "algorithm",
        "backend",
        "shape",
        "input_sha256",
        "model_sha256",
        "source_checkpoint_sha256",
        "provider",
        "device_id",
        "graph_optimization",
        "tf32",
        "ort_build",
    ] {
        ensure!(
            result[key] == request[key],
            "Nonlocal prediction {key} mismatch"
        );
    }
    ensure!(
        result["request_sha256"] == request_sha,
        "Nonlocal request checksum mismatch"
    );
    ensure!(
        fs::metadata(&pixels_path)?.len() == count as u64 * 4
            && result["prediction_sha256"] == hash_file(&pixels_path)?,
        "Nonlocal prediction checksum/size mismatch"
    );
    let bytes = fs::read(pixels_path)?;
    let values: Vec<f32> = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect();
    ensure!(
        values.iter().all(|v| v.is_finite()),
        "Nonfinite Nonlocal prediction"
    );
    Ok((values, result))
}

/// Build the direct-CoreML cache/request identity (protocol 3, namespace
/// `nonlocal-coreml-cache`). It can never collide with protocol-2 ONNX or
/// protocol-1 worker entries: backend generation, artifact hashes and
/// runtime all differ.
fn native_coreml_request(
    tree_sha256: &str,
    packed_height: usize,
    packed_width: usize,
    input_sha: &str,
    source_sha: &str,
) -> Value {
    json!({"protocol":3,"algorithm":ALGORITHM,"backend":COREML_BACKEND_GENERATION,
        "package_sha256":COREML_PACKAGE_SHA,"package_tree_sha256":tree_sha256,
        "source_checkpoint_sha256":SOURCE_CHECKPOINT_SHA,
        "input_sha256":input_sha,"source_sha256":source_sha,
        "shape":[4,packed_height,packed_width],"tile":TILE,"halo":HALO,
        "provider":"coreml","compute_units":nonlocal_coreml::COREML_COMPUTE_UNITS,
        "allow_low_precision_accumulation":false,
        "os":nonlocal_coreml::runtime_identity(),
        "runtime":nonlocal_coreml::COREML_RUNTIME})
}

/// Validate a cached direct-CoreML prediction against the fresh request.
/// Mirrors `prediction()`: every identity field must match, then checksum,
/// size and finiteness are enforced fail-closed.
fn prediction_coreml(
    directory: &Path,
    request: &Value,
    request_sha: &str,
    count: usize,
) -> Result<(Vec<f32>, Value)> {
    let result_path = directory.join("result.json");
    let pixels_path = directory.join("prediction.f32");
    regular_file(&result_path)?;
    regular_file(&pixels_path)?;
    ensure!(
        fs::metadata(&result_path)?.len() < 1024 * 1024,
        "Oversized Nonlocal result manifest"
    );
    let result: Value = serde_json::from_slice(&fs::read(result_path)?)?;
    for key in [
        "protocol",
        "algorithm",
        "backend",
        "shape",
        "input_sha256",
        "package_sha256",
        "package_tree_sha256",
        "source_checkpoint_sha256",
        "provider",
        "runtime",
        "compute_units",
        "allow_low_precision_accumulation",
        "os",
    ] {
        ensure!(
            result[key] == request[key],
            "Nonlocal prediction {key} mismatch"
        );
    }
    ensure!(
        result["request_sha256"] == request_sha,
        "Nonlocal request checksum mismatch"
    );
    ensure!(
        fs::metadata(&pixels_path)?.len() == count as u64 * 4
            && result["prediction_sha256"] == hash_file(&pixels_path)?,
        "Nonlocal prediction checksum/size mismatch"
    );
    let bytes = fs::read(pixels_path)?;
    let values: Vec<f32> = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect();
    ensure!(
        values.iter().all(|v| v.is_finite()),
        "Nonfinite Nonlocal prediction"
    );
    Ok((values, result))
}

/// Provenance fragment for a validated native ONNX cache hit. The
/// generation provider comes only from the hash-validated receipt (which
/// `prediction()` already required to equal the fresh request); the noise
/// profile is recomputed deterministically from the current hash-verified
/// packed input. No ONNX inference runs here, and the timing field is left
/// absent because it was never persisted.
fn cache_hit_provenance(
    request: &Value,
    receipt: &Value,
    packed: &[f32],
    height: usize,
    width: usize,
) -> Result<Value> {
    cache_hit_fragment(
        request,
        receipt,
        packed,
        height,
        width,
        &["cpu", "cuda"],
        &[
            "provider",
            "device_id",
            "graph_optimization",
            "tf32",
            "ort_build",
        ],
    )
}

/// Shared cache-hit fragment builder. Allowed providers and identity keys
/// are backend-specific; the noise profile is always recomputed from the
/// current hash-verified packed input and inference is never invoked.
fn cache_hit_fragment(
    request: &Value,
    receipt: &Value,
    packed: &[f32],
    height: usize,
    width: usize,
    allowed_providers: &[&str],
    identity_keys: &[&str],
) -> Result<Value> {
    let provider = receipt
        .get("provider")
        .and_then(|v| v.as_str())
        .with_context(|| "NONLOCAL_CACHE_INVALID: cached receipt missing provider")?;
    ensure!(
        allowed_providers.contains(&provider),
        "NONLOCAL_CACHE_INVALID: cached provider is not a supported native provider"
    );
    ensure!(
        receipt["backend"] == request["backend"]
            && identity_keys
                .iter()
                .all(|key| receipt[*key] == request[*key]),
        "NONLOCAL_CACHE_INVALID: cached receipt identity mismatch"
    );
    let profile = nonlocal_onnx::estimate_noise(packed, height, width)?;
    Ok(json!({
        "provider_actual": provider,
        "noise_profile": profile.to_json(),
    }))
}

/// Provenance fragment for a validated direct CoreML cache hit. Mirrors the
/// ONNX contract: provider identity from the validated receipt, noise
/// profile recomputed without model inference.
fn cache_hit_provenance_coreml(
    request: &Value,
    receipt: &Value,
    packed: &[f32],
    height: usize,
    width: usize,
) -> Result<Value> {
    cache_hit_fragment(
        request,
        receipt,
        packed,
        height,
        width,
        &["coreml"],
        &[
            "package_sha256",
            "package_tree_sha256",
            "runtime",
            "compute_units",
            "allow_low_precision_accumulation",
            "os",
        ],
    )
}

pub(crate) struct Output {
    pub directory: tempfile::TempDir,
    pub provenance: Value,
}
impl Output {
    pub fn path(&self) -> PathBuf {
        self.directory.path().join("result.dng")
    }
}

/// Truthful provenance for a strength/intensity-zero job: no bundle or
/// provider configuration was consulted and no inference ran, so no backend,
/// runtime, model/package or cache identity may be claimed.
fn skipped_provenance(source_sha: &str, packed: &Packed) -> Value {
    json!({"algorithm":ALGORITHM,
        "inference_executed":false,"reason":"intensity-zero",
        "source_sha256":source_sha,"packed_shape":[4,packed.height,packed.width],"output":"float32-bayer-dng",
        "normalization":"per-CFA black/white; signed noise estimation; unclipped highlights preserved"})
}

pub(crate) fn denoise(
    source: &Path,
    source_sha: &str,
    root: &Path,
    strength: f32,
    control: &DenoiseControl,
) -> Result<Output> {
    ensure!(
        strength.is_finite() && (0.0..=1.0).contains(&strength),
        "Invalid Nonlocal strength"
    );
    control.check().map_err(anyhow::Error::msg)?;
    control.report(0., "Decoding Bayer RAW");
    let bytes = fs::read(source)?;
    ensure!(
        hex::encode(Sha256::digest(&bytes)) == source_sha,
        "SOURCE_CHANGED: RAW source checksum mismatch"
    );
    let input = RawSource::new_from_slice(&bytes);
    let decoder = rawler::get_decoder(&input)?;
    let mut raw = decoder.raw_image(&input, &RawDecodeParams::default(), false)?;
    let metadata = decoder.raw_metadata(&input, &RawDecodeParams::default())?;
    drop(decoder);
    drop(input);
    drop(bytes);
    let packed = prepare(&mut raw)?;
    let root_path = root.canonicalize()?;
    let disks = sysinfo::Disks::new_with_refreshed_list();
    if let Some(disk) = disks
        .iter()
        .filter(|d| root_path.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
    {
        let needed = 20 * 1024_u64.pow(3) + packed.values.len() as u64 * 4 * 7;
        ensure!(
            disk.available_space() >= needed,
            "NONLOCAL_STORAGE: Need 20 GiB reserve plus RAW job working space"
        );
    }
    let models_dir = root.join("models");
    let provider = if strength > 0. {
        Some(configuration_with_models(Some(&models_dir))?.provider)
    } else {
        None
    };
    // Backend-specific cache namespaces: CoreML predictions live under
    // `nonlocal-coreml-cache` (protocol 3) and can never collide with
    // protocol-2 ONNX or protocol-1 worker entries.
    let cache = root.join(match provider {
        Some(nonlocal_onnx::Provider::Coreml) => "nonlocal-coreml-cache",
        _ => "nonlocal-onnx-cache",
    });
    fs::create_dir_all(&cache)?;
    ensure!(
        fs::symlink_metadata(&cache)?.file_type().is_dir(),
        "Nonlocal cache must be a real directory"
    );
    let directory = tempfile::Builder::new()
        .prefix("work-")
        .tempdir_in(&cache)?;
    let mut provenance = if strength > 0. {
        match provider {
            Some(nonlocal_onnx::Provider::Coreml) => {
                json!({"algorithm":ALGORITHM,"backend":COREML_BACKEND_GENERATION,
                    "runtime":nonlocal_coreml::COREML_RUNTIME,"package_sha256":COREML_PACKAGE_SHA,
                    "source_checkpoint_sha256":SOURCE_CHECKPOINT_SHA,
                    "compute_units":nonlocal_coreml::COREML_COMPUTE_UNITS,
                    "allow_low_precision_accumulation":false,
                    "os":nonlocal_coreml::runtime_identity(),
                    "cache_hit":false,
                    "source_sha256":source_sha,"packed_shape":[4,packed.height,packed.width],"output":"float32-bayer-dng",
                    "normalization":"per-CFA black/white; signed noise estimation; unclipped highlights preserved"})
            }
            _ => json!({"algorithm":ALGORITHM,"backend":BACKEND_GENERATION,
                "runtime":"onnxruntime",
                "source_checkpoint_sha256":SOURCE_CHECKPOINT_SHA,
                "cache_hit":false,
                "source_sha256":source_sha,"packed_shape":[4,packed.height,packed.width],"output":"float32-bayer-dng",
                "normalization":"per-CFA black/white; signed noise estimation; unclipped highlights preserved"}),
        }
    } else {
        skipped_provenance(source_sha, &packed)
    };
    if strength > 0. {
        let config = configuration_with_models(Some(&models_dir))?;
        if config.provider == nonlocal_onnx::Provider::Coreml {
            let contract = nonlocal_coreml::validate_bundle(&config.bundle)?;
            provenance["provider_requested"] = json!(config.provider_as_str());
            provenance["package_tree_sha256"] = json!(contract.tree_sha256);
            let input_path = directory.path().join("input.f32");
            write_packed_input(&input_path, &packed.values)?;
            let request = native_coreml_request(
                &contract.tree_sha256,
                packed.height,
                packed.width,
                &hash_file(&input_path)?,
                source_sha,
            );
            let request_bytes = serde_json::to_vec(&request)?;
            let request_sha = hex::encode(Sha256::digest(&request_bytes));
            let cached = cache.join(&request_sha);
            let (values, receipt) = if cached.exists() {
                ensure!(
                    fs::symlink_metadata(&cached)?.file_type().is_dir(),
                    "Nonlocal cache entry must be a real directory"
                );
                provenance["cache_hit"] = json!(true);
                let hit = prediction_coreml(&cached, &request, &request_sha, packed.values.len())
                    .context(
                    "NONLOCAL_CACHE_INVALID: Remove this corrupt cache entry before retrying",
                )?;
                let fragment = cache_hit_provenance_coreml(
                    &request,
                    &hit.1,
                    &packed.values,
                    packed.height,
                    packed.width,
                )
                .context(
                    "NONLOCAL_CACHE_INVALID: Remove this corrupt cache entry before retrying",
                )?;
                provenance["provider_actual"] = fragment["provider_actual"].clone();
                provenance["noise_profile"] = fragment["noise_profile"].clone();
                hit
            } else {
                fs::write(directory.path().join("request.json"), &request_bytes)?;
                control.check().map_err(anyhow::Error::msg)?;
                // One compiled MLModel per job, reused for all tiles. macOS only; other platforms fail closed in
                // configuration() before reaching here.
                #[cfg(target_os = "macos")]
                let outcome: Result<(Vec<f32>, Value)> = (|| {
                    use crate::nonlocal_onnx::TilePredictor as _;
                    let mut backend = nonlocal_coreml::open_backend(&config, &contract)?;
                    provenance["provider_actual"] = json!(backend.provider_name());
                    provenance["model_load_seconds"] = json!(backend.load_secs);
                    let result = nonlocal_onnx::denoise_packed(
                        &mut backend,
                        &packed.values,
                        packed.height,
                        packed.width,
                        control,
                    )?;
                    control.check().map_err(anyhow::Error::msg)?;
                    let prediction_path = directory.path().join("prediction.f32");
                    write_packed_input(&prediction_path, &result.prediction)?;
                    let receipt = json!({"protocol":3,"algorithm":ALGORITHM,"backend":COREML_BACKEND_GENERATION,
                        "shape":[4,packed.height,packed.width],
                        "input_sha256":request["input_sha256"],"package_sha256":COREML_PACKAGE_SHA,
                        "package_tree_sha256":request["package_tree_sha256"],
                        "source_checkpoint_sha256":SOURCE_CHECKPOINT_SHA,
                        "request_sha256":request_sha,"prediction_sha256":hash_file(&prediction_path)?,
                        "provider":"coreml","runtime":request["runtime"],"compute_units":request["compute_units"],
                        "allow_low_precision_accumulation":false,"os":request["os"]});
                    fs::write(
                        directory.path().join("result.json"),
                        serde_json::to_vec(&receipt)?,
                    )?;
                    let prediction = prediction_coreml(
                        directory.path(),
                        &request,
                        &request_sha,
                        packed.values.len(),
                    )?;
                    control.check().map_err(anyhow::Error::msg)?;
                    provenance["noise_profile"] = result.profile.to_json();
                    provenance["inference_seconds"] = json!(result.elapsed_secs);
                    let staging = tempfile::Builder::new()
                        .prefix("cache-")
                        .tempdir_in(&cache)?;
                    for name in ["result.json", "prediction.f32"] {
                        crate::storage_copy::copy_new(
                            &directory.path().join(name),
                            &staging.path().join(name),
                        )?;
                    }
                    fs::rename(staging.path(), &cached)?;
                    Ok(prediction)
                })();
                #[cfg(not(target_os = "macos"))]
                let outcome: Result<(Vec<f32>, Value)> = Err(anyhow::anyhow!(
                    "NONLOCAL_PROVIDER_UNSUPPORTED: CoreML inference is supported on macOS only"
                ));
                outcome?
            };
            provenance["receipt"] = receipt;
            provenance["cache_key"] = json!(request_sha);
            blend(&mut raw, &packed, &values, strength)?;
        } else {
            let contract = nonlocal_onnx::validate_bundle(&config.bundle)?;
            provenance["model_sha256"] = json!(contract.model_sha256);
            provenance["provider_requested"] = json!(config.provider_as_str());
            provenance["graph_optimization"] = json!(false);
            provenance["tf32"] = json!(false);
            provenance["ort_build"] = json!(nonlocal_onnx::ort_identity());
            let input_path = directory.path().join("input.f32");
            write_packed_input(&input_path, &packed.values)?;
            let request = native_onnx_request(
                &config,
                &contract.model_sha256,
                (packed.height, packed.width),
                &hash_file(&input_path)?,
                source_sha,
                &nonlocal_onnx::ort_identity(),
            );
            let request_bytes = serde_json::to_vec(&request)?;
            let request_sha = hex::encode(Sha256::digest(&request_bytes));
            let cached = cache.join(&request_sha);
            let (values, receipt) = if cached.exists() {
                ensure!(
                    fs::symlink_metadata(&cached)?.file_type().is_dir(),
                    "Nonlocal cache entry must be a real directory"
                );
                provenance["cache_hit"] = json!(true);
                let hit = prediction(&cached, &request, &request_sha, packed.values.len())
                    .context(
                        "NONLOCAL_CACHE_INVALID: Remove this corrupt cache entry before retrying",
                    )?;
                let fragment = cache_hit_provenance(
                    &request,
                    &hit.1,
                    &packed.values,
                    packed.height,
                    packed.width,
                )
                .context(
                    "NONLOCAL_CACHE_INVALID: Remove this corrupt cache entry before retrying",
                )?;
                provenance["provider_actual"] = fragment["provider_actual"].clone();
                provenance["noise_profile"] = fragment["noise_profile"].clone();
                hit
            } else {
                fs::write(directory.path().join("request.json"), &request_bytes)?;
                control.check().map_err(anyhow::Error::msg)?;
                // One ORT session per job, reused for all tiles.
                let mut backend = nonlocal_onnx::open_backend(&config, &contract)?;
                provenance["provider_actual"] = json!(backend.provider);
                let result = nonlocal_onnx::denoise_packed(
                    &mut backend,
                    &packed.values,
                    packed.height,
                    packed.width,
                    control,
                )?;
                control.check().map_err(anyhow::Error::msg)?;
                let prediction_path = directory.path().join("prediction.f32");
                write_packed_input(&prediction_path, &result.prediction)?;
                let receipt = json!({"protocol":2,"algorithm":ALGORITHM,"backend":BACKEND_GENERATION,
                    "shape":[4,packed.height,packed.width],
                    "input_sha256":request["input_sha256"],"model_sha256":request["model_sha256"],
                    "source_checkpoint_sha256":SOURCE_CHECKPOINT_SHA,
                    "request_sha256":request_sha,"prediction_sha256":hash_file(&prediction_path)?,
                    "provider":request["provider"],"device_id":request["device_id"],
                    "graph_optimization":false,"tf32":false,"ort_build":request["ort_build"]});
                fs::write(
                    directory.path().join("result.json"),
                    serde_json::to_vec(&receipt)?,
                )?;
                let prediction = prediction(
                    directory.path(),
                    &request,
                    &request_sha,
                    packed.values.len(),
                )?;
                control.check().map_err(anyhow::Error::msg)?;
                provenance["noise_profile"] = result.profile.to_json();
                provenance["inference_seconds"] = json!(result.elapsed_secs);
                let staging = tempfile::Builder::new()
                    .prefix("cache-")
                    .tempdir_in(&cache)?;
                for name in ["result.json", "prediction.f32"] {
                    crate::storage_copy::copy_new(
                        &directory.path().join(name),
                        &staging.path().join(name),
                    )?;
                }
                fs::rename(staging.path(), &cached)?;
                prediction
            };
            provenance["receipt"] = receipt;
            provenance["cache_key"] = json!(request_sha);
            blend(&mut raw, &packed, &values, strength)?;
        }
    }
    control.check().map_err(anyhow::Error::msg)?;
    control.report(0.95, "Writing Bayer DNG");
    write_dng(&directory.path().join("result.dng"), &raw, &metadata)?;
    control.check().map_err(anyhow::Error::msg)?;
    Ok(Output {
        directory,
        provenance,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nonlocal_onnx::ONNX_MODEL_SHA;
    use rawler::{
        CFA,
        decoders::Camera,
        exif::Exif,
        pixarray::PixU16,
        rawimage::{BlackLevel, CFAConfig, WhiteLevel},
    };
    fn fixture(pattern: &str, offset: usize) -> RawImage {
        let mut camera = Camera::new();
        camera.cfa = CFA::new(pattern);
        let photometric = RawPhotometricInterpretation::Cfa(CFAConfig::new_from_camera(&camera));
        let mut raw = RawImage::new(
            camera,
            PixU16::new_with(
                (0..24 * 24).map(|i| (i % 23 + 800) as u16).collect(),
                24,
                24,
            ),
            1,
            [2., 1., 1.5, 1.],
            photometric,
            Some(BlackLevel::new(&[100_u16, 200, 300, 400], 2, 2, 1)),
            Some(WhiteLevel::new(vec![4095])),
            false,
        );
        raw.active_area = Some(Rect::new(Point::new(offset, offset), Dim2::new(20, 20)));
        raw.crop_area = Some(Rect::new(
            Point::new(offset + 2, offset + 2),
            Dim2::new(16, 16),
        ));
        raw
    }
    #[test]
    fn bayer_phases_signed_normalization_and_strength() {
        for pattern in ["RGGB", "BGGR", "GRBG", "GBRG"] {
            for offset in [0, 1] {
                let mut raw = fixture(pattern, offset);
                let original = raw.data.as_f32().to_vec();
                let packed = prepare(&mut raw).unwrap();
                assert_eq!((packed.width, packed.height), (10, 10));
                assert_eq!(raw.crop_area.unwrap().p, Point::new(2, 2));
                let RawPhotometricInterpretation::Cfa(config) = &raw.photometric else {
                    panic!()
                };
                for (c, (dy, dx)) in packed.positions.iter().enumerate() {
                    assert_eq!(config.cfa.color_at(*dy, *dx), [0, 1, 2, 1][c]);
                }
                assert_eq!(packed.positions[0].0, packed.positions[1].0);
                for y in 0..20 {
                    for x in 0..20 {
                        assert_eq!(
                            raw.data.as_f32()[y * 20 + x],
                            original[(y + offset) * 24 + x + offset]
                        );
                    }
                }
                let before = raw.data.as_f32().to_vec();
                blend(&mut raw, &packed, &packed.values, 1.).unwrap();
                assert!(
                    raw.data
                        .as_f32()
                        .iter()
                        .zip(&before)
                        .all(|(a, b)| (a - b).abs() < 0.001)
                );
                let prediction = vec![0.; 400];
                blend(&mut raw, &packed, &prediction, 0.).unwrap();
                assert!(
                    raw.data
                        .as_f32()
                        .iter()
                        .zip(&before)
                        .all(|(a, b)| (a - b).abs() < 0.001)
                );
                blend(&mut raw, &packed, &prediction, 0.5).unwrap();
                for (c, (dy, dx)) in packed.positions.iter().enumerate() {
                    let index = dy * 20 + dx;
                    assert!(
                        (raw.data.as_f32()[index] - (before[index] + packed.black[c]) * 0.5).abs()
                            < 0.001
                    );
                }
                assert!(blend(&mut raw, &packed, &[f32::NAN; 400], 1.).is_err());
                assert!(blend(&mut raw, &packed, &[0.; 399], 1.).is_err());
            }
        }
        let mut raw = fixture("RGGB", 0);
        raw.data = RawImageData::Float(vec![0.; 24 * 24]);
        assert!(prepare(&mut raw).unwrap().values.iter().all(|v| *v < 0.));
    }
    #[test]
    fn float_bayer_dng_roundtrip_preserves_counts_and_metadata() {
        for pattern in ["RGGB", "BGGR", "GRBG", "GBRG"] {
            for offset in [0, 1] {
                let mut raw = fixture(pattern, offset);
                prepare(&mut raw).unwrap();
                let metadata = RawMetadata {
                    exif: Exif {
                        orientation: Some(6),
                        ..Default::default()
                    },
                    make: "Test".into(),
                    model: "Bayer".into(),
                    lens: None,
                    unique_image_id: None,
                    rating: None,
                };
                let root = tempfile::tempdir().unwrap();
                let output = root.path().join("test.dng");
                write_dng(&output, &raw, &metadata).unwrap();
                let bytes = fs::read(output).unwrap();
                let source = RawSource::new_from_slice(&bytes);
                let decoder = rawler::get_decoder(&source).unwrap();
                let reloaded = decoder
                    .raw_image(&source, &RawDecodeParams::default(), false)
                    .unwrap();
                assert_eq!(reloaded.data.as_f32(), raw.data.as_f32());
                assert_eq!(reloaded.photometric, raw.photometric);
                assert_eq!(reloaded.blacklevel, raw.blacklevel);
                assert_eq!(reloaded.whitelevel, raw.whitelevel);
                assert_eq!(reloaded.crop_area, raw.crop_area);
                assert_eq!(
                    decoder
                        .raw_metadata(&source, &RawDecodeParams::default())
                        .unwrap()
                        .exif
                        .orientation,
                    Some(6)
                );
            }
        }
    }
    #[test]
    fn prediction_cache_rejects_corruption_and_wrong_provenance() {
        let root = tempfile::tempdir().unwrap();
        let base = json!({"protocol":2,"algorithm":ALGORITHM,"backend":BACKEND_GENERATION,
            "shape":[4,8,8],"input_sha256":"input","model_sha256":ONNX_MODEL_SHA,
            "source_checkpoint_sha256":SOURCE_CHECKPOINT_SHA,"provider":"cpu","device_id":null,
            "graph_optimization":false,"tf32":false,"ort_build":"test"});
        let mut request = base.clone();
        let pixels = root.path().join("prediction.f32");
        fs::write(&pixels, vec![0_u8; 4 * 8 * 8 * 4]).unwrap();
        let mut receipt = base.clone();
        receipt["request_sha256"] = json!("request");
        receipt["prediction_sha256"] = json!(hash_file(&pixels).unwrap());
        fs::write(
            root.path().join("result.json"),
            serde_json::to_vec(&receipt).unwrap(),
        )
        .unwrap();
        assert!(prediction(root.path(), &request, "request", 256).is_ok());
        assert!(prediction(root.path(), &request, "wrong", 256).is_err());
        // A CUDA receipt must not satisfy a CPU request (and vice versa).
        request["provider"] = json!("cuda");
        assert!(prediction(root.path(), &request, "request", 256).is_err());
        request["provider"] = json!("cpu");
        fs::write(&pixels, vec![1_u8; 4 * 8 * 8 * 4]).unwrap();
        assert!(prediction(root.path(), &request, "request", 256).is_err());
        let bytes: Vec<_> = (0..256).flat_map(|_| f32::NAN.to_le_bytes()).collect();
        fs::write(&pixels, bytes).unwrap();
        receipt["prediction_sha256"] = json!(hash_file(&pixels).unwrap());
        fs::write(
            root.path().join("result.json"),
            serde_json::to_vec(&receipt).unwrap(),
        )
        .unwrap();
        assert!(prediction(root.path(), &request, "request", 256).is_err());
    }
    #[test]
    fn cache_hit_provenance_carries_required_identity() {
        // Deterministic 128x128 packed input with enough texture for the
        // blind noise fit (mirrors the nonlocal_onnx golden generator).
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
        let config = NativeConfig {
            bundle: PathBuf::from("/bundle"),
            provider: crate::nonlocal_onnx::Provider::Cpu,
            device_id: 0,
            mem_limit_mb: None,
        };
        let request = native_onnx_request(
            &config,
            ONNX_MODEL_SHA,
            (H, W),
            "input-sha",
            "source-sha",
            "test",
        );
        let request_sha = hex::encode(Sha256::digest(serde_json::to_vec(&request).unwrap()));
        let root = tempfile::tempdir().unwrap();
        let entry = root.path().join(&request_sha);
        fs::create_dir(&entry).unwrap();
        let values = vec![0.25f32; 4 * H * W];
        write_packed_input(&entry.join("prediction.f32"), &values).unwrap();
        let receipt = json!({"protocol":2,"algorithm":ALGORITHM,"backend":BACKEND_GENERATION,
            "shape":[4,H,W],"input_sha256":request["input_sha256"],
            "model_sha256":ONNX_MODEL_SHA,"source_checkpoint_sha256":SOURCE_CHECKPOINT_SHA,
            "request_sha256":request_sha,
            "prediction_sha256":hash_file(&entry.join("prediction.f32")).unwrap(),
            "provider":request["provider"],"device_id":request["device_id"],
            "graph_optimization":false,"tf32":false,"ort_build":request["ort_build"]});
        fs::write(
            entry.join("result.json"),
            serde_json::to_vec(&receipt).unwrap(),
        )
        .unwrap();
        let validated = prediction(&entry, &request, &request_sha, packed.len()).unwrap();
        let fragment = cache_hit_provenance(&request, &validated.1, &packed, H, W).unwrap();
        assert_eq!(fragment["provider_actual"], json!("cpu"));
        assert_eq!(
            fragment["noise_profile"]["method"],
            json!("stratified-haar-irls-v1")
        );
        assert_eq!(
            fragment["noise_profile"]["shot"].as_array().unwrap().len(),
            4
        );
        assert_eq!(
            fragment["noise_profile"]["read"].as_array().unwrap().len(),
            4
        );
        // Required top-level identity is satisfiable without inference timing.
        assert_eq!(request["backend"], json!(BACKEND_GENERATION));
        assert_eq!(request["model_sha256"], json!(ONNX_MODEL_SHA));
        assert_eq!(
            request["source_checkpoint_sha256"],
            json!(SOURCE_CHECKPOINT_SHA)
        );
        assert!(!fragment.get("inference_seconds").is_some());
    }
    #[test]
    fn model_hash_is_part_of_native_cache_identity() {
        // A different graph is arithmetically equivalent at best, never
        // bit-identical, so its predictions must not share a cache entry.
        let config = NativeConfig {
            bundle: PathBuf::from("/bundle"),
            provider: crate::nonlocal_onnx::Provider::Cuda,
            device_id: 0,
            mem_limit_mb: None,
        };
        let sha = |model: &str| {
            let request = native_onnx_request(&config, model, (8, 16), "input", "source", "ort");
            assert_eq!(request["model_sha256"], json!(model));
            hex::encode(Sha256::digest(serde_json::to_vec(&request).unwrap()))
        };
        assert_ne!(sha(nonlocal_onnx::ONNX_MODEL_SHA), sha("other-model-sha"));
    }
    #[test]
    fn coreml_cache_identity_is_isolated_from_onnx() {
        // Protocol, backend, artifact and runtime identities must differ so
        // no ONNX, CoreML or legacy worker prediction can collide.
        let config = NativeConfig {
            bundle: PathBuf::from("/bundle"),
            provider: crate::nonlocal_onnx::Provider::Cpu,
            device_id: 0,
            mem_limit_mb: None,
        };
        let onnx = native_onnx_request(
            &config,
            ONNX_MODEL_SHA,
            (8, 16),
            "input-sha",
            "source-sha",
            "test-ort",
        );
        let coreml = native_coreml_request("tree-sha", 8, 16, "input-sha", "source-sha");
        assert_eq!(onnx["protocol"], json!(2));
        assert_eq!(coreml["protocol"], json!(3));
        assert_eq!(onnx["backend"], json!(BACKEND_GENERATION));
        assert_eq!(coreml["backend"], json!(COREML_BACKEND_GENERATION));
        assert_ne!(onnx["backend"], coreml["backend"]);
        assert_eq!(coreml["provider"], json!("coreml"));
        assert_eq!(coreml["runtime"], json!("coreml"));
        assert_eq!(coreml["package_sha256"], json!(COREML_PACKAGE_SHA));
        assert_eq!(coreml["package_tree_sha256"], json!("tree-sha"));
        assert_eq!(
            coreml["source_checkpoint_sha256"],
            json!(SOURCE_CHECKPOINT_SHA)
        );
        assert_eq!(coreml["compute_units"], json!("all"));
        assert_eq!(coreml["allow_low_precision_accumulation"], json!(false));
        assert!(coreml["os"].as_str().unwrap().starts_with("coreml/"));
        assert_eq!(coreml["tile"], json!(320));
        assert_eq!(coreml["halo"], json!(40));
        // Request bytes (and therefore cache keys) differ across families.
        assert_ne!(
            hex::encode(Sha256::digest(serde_json::to_vec(&onnx).unwrap())),
            hex::encode(Sha256::digest(serde_json::to_vec(&coreml).unwrap()))
        );
    }
    #[test]
    fn coreml_cache_rejects_cross_family_and_corrupt_receipts() {
        let root = tempfile::tempdir().unwrap();
        let request = native_coreml_request("tree-sha", 8, 8, "input-sha", "source-sha");
        let request_sha = hex::encode(Sha256::digest(serde_json::to_vec(&request).unwrap()));
        let pixels = root.path().join("prediction.f32");
        fs::write(&pixels, vec![0_u8; 4 * 8 * 8 * 4]).unwrap();
        let mut receipt = request.clone();
        receipt["request_sha256"] = json!(&request_sha);
        receipt["prediction_sha256"] = json!(hash_file(&pixels).unwrap());
        fs::write(
            root.path().join("result.json"),
            serde_json::to_vec(&receipt).unwrap(),
        )
        .unwrap();
        assert!(prediction_coreml(root.path(), &request, &request_sha, 256).is_ok());
        assert_eq!(receipt["runtime"], json!("coreml"));
        // A receipt missing or misreporting runtime is rejected.
        let mut no_runtime = receipt.clone();
        no_runtime.as_object_mut().unwrap().remove("runtime");
        fs::write(
            root.path().join("result.json"),
            serde_json::to_vec(&no_runtime).unwrap(),
        )
        .unwrap();
        assert!(prediction_coreml(root.path(), &request, &request_sha, 256).is_err());
        let mut wrong_runtime = receipt.clone();
        wrong_runtime["runtime"] = json!("onnxruntime");
        fs::write(
            root.path().join("result.json"),
            serde_json::to_vec(&wrong_runtime).unwrap(),
        )
        .unwrap();
        assert!(prediction_coreml(root.path(), &request, &request_sha, 256).is_err());
        fs::write(
            root.path().join("result.json"),
            serde_json::to_vec(&receipt).unwrap(),
        )
        .unwrap();
        // An ONNX receipt must not satisfy a CoreML request.
        let mut onnx_receipt = receipt.clone();
        onnx_receipt["backend"] = json!(BACKEND_GENERATION);
        onnx_receipt["protocol"] = json!(2);
        fs::write(
            root.path().join("result.json"),
            serde_json::to_vec(&onnx_receipt).unwrap(),
        )
        .unwrap();
        assert!(prediction_coreml(root.path(), &request, &request_sha, 256).is_err());
        fs::write(
            root.path().join("result.json"),
            serde_json::to_vec(&receipt).unwrap(),
        )
        .unwrap();
        // Tree-hash drift invalidates the cache entry.
        let mut drifted = request.clone();
        drifted["package_tree_sha256"] = json!("other-tree");
        assert!(prediction_coreml(root.path(), &drifted, &request_sha, 256).is_err());
        // OS/build drift invalidates the cache entry.
        let mut os_drifted = request.clone();
        os_drifted["os"] = json!("coreml/macos-aarch64/99.0/99.0.0");
        assert!(prediction_coreml(root.path(), &os_drifted, &request_sha, 256).is_err());
        // Corrupt pixels fail the checksum.
        fs::write(&pixels, vec![1_u8; 4 * 8 * 8 * 4]).unwrap();
        assert!(prediction_coreml(root.path(), &request, &request_sha, 256).is_err());
    }
    #[test]
    fn coreml_cache_hit_provenance_needs_no_inference() {
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
        let request = native_coreml_request("tree-sha", H, W, "input-sha", "source-sha");
        let request_sha = hex::encode(Sha256::digest(serde_json::to_vec(&request).unwrap()));
        let root = tempfile::tempdir().unwrap();
        let entry = root.path().join(&request_sha);
        fs::create_dir(&entry).unwrap();
        write_packed_input(&entry.join("prediction.f32"), &vec![0.25f32; 4 * H * W]).unwrap();
        let mut receipt = request.clone();
        receipt["request_sha256"] = json!(&request_sha);
        receipt["prediction_sha256"] = json!(hash_file(&entry.join("prediction.f32")).unwrap());
        fs::write(
            entry.join("result.json"),
            serde_json::to_vec(&receipt).unwrap(),
        )
        .unwrap();
        let validated = prediction_coreml(&entry, &request, &request_sha, packed.len()).unwrap();
        let fragment = cache_hit_provenance_coreml(&request, &validated.1, &packed, H, W).unwrap();
        assert_eq!(fragment["provider_actual"], json!("coreml"));
        assert_eq!(
            fragment["noise_profile"]["method"],
            json!("stratified-haar-irls-v1")
        );
        assert!(!fragment.get("inference_seconds").is_some());
    }
    #[test]
    fn values_above_white_survive_the_prediction_blend() {
        let mut raw = fixture("RGGB", 0);
        raw.data = RawImageData::Float(vec![5000.; 24 * 24]);
        let packed = prepare(&mut raw).unwrap();
        blend(&mut raw, &packed, &vec![0.; packed.values.len()], 1.).unwrap();
        assert!(raw.data.as_f32().iter().all(|v| *v == 5000.));
    }
    #[test]
    fn zero_strength_provenance_claims_no_inference_identity() {
        // Pure builder: no bundle or provider configuration is consulted, so
        // a CoreML-selected host and an unconfigured host emit identical
        // zero-strength provenance that cannot claim a backend that never ran.
        let mut raw = fixture("RGGB", 0);
        let packed = prepare(&mut raw).unwrap();
        let value = skipped_provenance("source-sha", &packed);
        assert_eq!(value["algorithm"], json!(ALGORITHM));
        assert_eq!(value["inference_executed"], json!(false));
        assert_eq!(value["reason"], json!("intensity-zero"));
        assert_eq!(value["source_sha256"], json!("source-sha"));
        assert_eq!(
            value["packed_shape"],
            json!([4, packed.height, packed.width])
        );
        assert_eq!(value["output"], json!("float32-bayer-dng"));
        for key in [
            "backend",
            "runtime",
            "model_sha256",
            "package_sha256",
            "package_tree_sha256",
            "source_checkpoint_sha256",
            "compute_units",
            "os",
            "provider_requested",
            "provider_actual",
            "cache_hit",
            "cache_key",
            "receipt",
        ] {
            assert!(value.get(key).is_none(), "unexpected {key}: {value}");
        }
    }
    #[test]
    fn multistrip_dng_has_standard_scalar_strip_height() {
        use rawler::formats::tiff::{GenericTiffReader, reader::TiffReader};
        let mut raw = fixture("RGGB", 0);
        prepare(&mut raw).unwrap();
        raw.height = 600;
        raw.data = RawImageData::Float(
            (0..raw.width * raw.height)
                .map(|i| i as f32 * 0.125)
                .collect(),
        );
        raw.active_area = Some(Rect::new(
            Point::new(0, 0),
            Dim2::new(raw.width, raw.height),
        ));
        raw.crop_area = raw.active_area;
        let metadata = RawMetadata {
            exif: Exif::default(),
            make: "Test".into(),
            model: "Bayer".into(),
            lens: None,
            unique_image_id: None,
            rating: None,
        };
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("multi.dng");
        write_dng(&path, &raw, &metadata).unwrap();
        let bytes = fs::read(path).unwrap();
        let tiff = GenericTiffReader::new_with_buffer(&bytes, 0, 0, None).unwrap();
        let rows = tiff.get_entry(TiffCommonTag::RowsPerStrip).unwrap();
        assert_eq!(rows.count(), 1);
        let rows = rows.force_usize(0);
        assert!(rows > 0);
        let strips = tiff.get_entry(TiffCommonTag::StripOffsets).unwrap().count() as usize;
        assert_eq!(strips, raw.height.div_ceil(rows));
        let source = RawSource::new_from_slice(&bytes);
        let decoder = rawler::get_decoder(&source).unwrap();
        let reloaded = decoder
            .raw_image(&source, &RawDecodeParams::default(), false)
            .unwrap();
        assert_eq!(raw.data.as_f32(), reloaded.data.as_f32());
    }
    #[test]
    fn native_onnx_transport_matches_production_boundary() {
        // The diagnostic fixture exporter must reuse the exact production bytes
        // and protocol-2 request schema of the native ONNX path.
        let values: Vec<f32> = vec![0.5, -0.25, 1.0, f32::from_bits(0x3f800001)];
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("input.f32");
        write_packed_input(&path, &values).unwrap();
        let mut expected = Vec::new();
        for v in &values {
            expected.extend_from_slice(&v.to_le_bytes());
        }
        assert_eq!(fs::read(&path).unwrap(), expected);
        assert_eq!(fs::metadata(&path).unwrap().len(), values.len() as u64 * 4);
        let config = NativeConfig {
            bundle: PathBuf::from("/bundle"),
            provider: crate::nonlocal_onnx::Provider::Cpu,
            device_id: 0,
            mem_limit_mb: None,
        };
        let request = native_onnx_request(
            &config,
            ONNX_MODEL_SHA,
            (8, 16),
            "input-sha",
            "source-sha",
            "test",
        );
        assert_eq!(request["protocol"], json!(2));
        assert_eq!(request["backend"], json!(BACKEND_GENERATION));
        assert_eq!(request["model_sha256"], json!(ONNX_MODEL_SHA));
        assert_eq!(
            request["source_checkpoint_sha256"],
            json!(SOURCE_CHECKPOINT_SHA)
        );
        assert_eq!(request["shape"], json!([4, 8, 16]));
        assert_eq!(request["tile"], json!(320));
        assert_eq!(request["halo"], json!(40));
        assert_eq!(request["provider"], json!("cpu"));
        assert_eq!(request["device_id"], Value::Null);
        assert_eq!(request["graph_optimization"], json!(false));
        assert_eq!(request["tf32"], json!(false));
        // Request bytes must be valid JSON with stable key order for hashing.
        let bytes = serde_json::to_vec(&request).unwrap();
        let parsed: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed, request);
    }
    #[test]
    #[ignore = "Requires RAPIDRAW_TEST_RAW and RAPIDRAW_NONLOCAL_FIXTURE_DIR; exports native input.f32 + request.json for capture_reference.py"]
    fn capture_nonlocal_fixture_inputs() {
        use rawler::{decoders::RawDecodeParams, rawsource::RawSource};
        let source = PathBuf::from(
            std::env::var_os("RAPIDRAW_TEST_RAW")
                .expect("Set RAPIDRAW_TEST_RAW to an absolute photo path"),
        );
        let out_dir = PathBuf::from(
            std::env::var_os("RAPIDRAW_NONLOCAL_FIXTURE_DIR")
                .expect("Set RAPIDRAW_NONLOCAL_FIXTURE_DIR to an absolute fresh directory"),
        );
        assert!(source.is_absolute(), "RAPIDRAW_TEST_RAW must be absolute");
        assert!(
            out_dir.is_absolute(),
            "RAPIDRAW_NONLOCAL_FIXTURE_DIR must be absolute"
        );
        if out_dir.exists() {
            let count = fs::read_dir(&out_dir).unwrap().count();
            assert_eq!(
                count, 0,
                "Fixture directory must be new and empty; refusing to overwrite"
            );
        } else {
            fs::create_dir_all(&out_dir).unwrap();
        }
        let before = fs::read(&source).unwrap();
        let source_sha = hex::encode(Sha256::digest(&before));
        let input = RawSource::new_from_slice(&before);
        let decoder = rawler::get_decoder(&input).unwrap();
        let mut raw = decoder
            .raw_image(&input, &RawDecodeParams::default(), false)
            .unwrap();
        let sensor_shape = [raw.width, raw.height];
        let crop_before = raw.crop_area;
        let active_before = raw.active_area;
        let mut packed = prepare(&mut raw).unwrap();
        // Exact production transport.
        let input_path = out_dir.join("input.f32");
        write_packed_input(&input_path, &packed.values).unwrap();
        assert_eq!(
            fs::metadata(&input_path).unwrap().len(),
            packed.values.len() as u64 * 4
        );
        let input_sha = hash_file(&input_path).unwrap();
        let config = configuration_with_models(None)
            .expect("Set RAPIDRAW_NONLOCAL_BUNDLE (+ provider) to export the production request");
        let model_sha256 = nonlocal_onnx::validate_bundle(&config.bundle)
            .unwrap()
            .model_sha256;
        let request = native_onnx_request(
            &config,
            &model_sha256,
            (packed.height, packed.width),
            &input_sha,
            &source_sha,
            &nonlocal_onnx::ort_identity(),
        );
        let request_bytes = serde_json::to_vec(&request).unwrap();
        let request_sha = hex::encode(Sha256::digest(&request_bytes));
        fs::write(out_dir.join("request.json"), &request_bytes).unwrap();
        // Numerical cross-check: Python must read identical values.
        let n = packed.values.len();
        let mut le = Vec::with_capacity(n * 4);
        for v in &packed.values {
            le.extend_from_slice(&v.to_le_bytes());
        }
        assert_eq!(fs::read(&input_path).unwrap(), le);
        let metadata = json!({
            "source_sha256": source_sha,
            "input_sha256": input_sha,
            "request_sha256": request_sha,
            "packed_shape": [4, packed.height, packed.width],
            "sensor_shape": sensor_shape,
            "cfa_positions_yx": packed.positions,
            "black": packed.black,
            "white": packed.white,
            "crop_area": crop_before.map(|r| json!({"x": r.p.x, "y": r.p.y, "w": r.d.w, "h": r.d.h})),
            "active_area": active_before.map(|r| json!({"x": r.p.x, "y": r.p.y, "w": r.d.w, "h": r.d.h})),
            "tile": TILE, "halo": HALO,
            "algorithm": ALGORITHM, "backend": BACKEND_GENERATION,
            "model_sha256": model_sha256,
            "source_checkpoint_sha256": SOURCE_CHECKPOINT_SHA, "protocol": 2,
        });
        fs::write(
            out_dir.join("metadata.json"),
            serde_json::to_vec_pretty(&metadata).unwrap(),
        )
        .unwrap();
        // Source must remain untouched.
        assert_eq!(fs::read(&source).unwrap(), before);
        // Silence unused warning if Packed gains fields later.
        let _ = &mut packed.values;
        eprintln!(
            "Wrote native fixture: {} (packed {:?}, input {}, request {})",
            out_dir.display(),
            [4, packed.height, packed.width],
            input_sha,
            request_sha
        );
        eprintln!(
            "Next: validate with the native ONNX bundle (RAPIDRAW_NONLOCAL_BUNDLE) or feed {} to capture_reference.py for a fresh controlled reference",
            out_dir.display()
        );
    }
    #[test]
    #[ignore = "Requires RAPIDRAW_TEST_RAW and optional RAPIDRAW_TEST_DNG on a host with a real Bayer fixture"]
    fn real_raw_identity_uses_native_developer() {
        let path = PathBuf::from(std::env::var_os("RAPIDRAW_TEST_RAW").unwrap());
        let bytes = fs::read(&path).unwrap();
        let source = RawSource::new_from_slice(&bytes);
        let decoder = rawler::get_decoder(&source).unwrap();
        let mut raw = decoder
            .raw_image(&source, &RawDecodeParams::default(), false)
            .unwrap();
        let metadata = decoder
            .raw_metadata(&source, &RawDecodeParams::default())
            .unwrap();
        eprintln!(
            "original geometry {}x{} active {:?} crop {:?}, black {:?}, WB {:?}",
            raw.width, raw.height, raw.active_area, raw.crop_area, raw.blacklevel, raw.wb_coeffs
        );
        prepare(&mut raw).unwrap();
        let root = tempfile::tempdir().unwrap();
        let output = std::env::var_os("RAPIDRAW_TEST_DNG")
            .map(PathBuf::from)
            .unwrap_or(root.path().join("identity.dng"));
        write_dng(&output, &raw, &metadata).unwrap();
        let a = crate::raw_processing::develop_raw_image(&bytes, false, "auto".into(), None)
            .unwrap()
            .to_rgb32f();
        let b = crate::raw_processing::develop_raw_image(
            &fs::read(&output).unwrap(),
            false,
            "auto".into(),
            None,
        )
        .unwrap()
        .to_rgb32f();
        assert_eq!(a.dimensions(), b.dimensions());
        let mut sum = 0_f64;
        let mut max = 0_f32;
        for (a, b) in a.as_raw().iter().zip(b.as_raw()) {
            let d = (a - b).abs();
            sum += d as f64;
            max = max.max(d);
        }
        let mean = sum / a.as_raw().len() as f64;
        eprintln!(
            "Native DNG identity: dimensions {:?}, mean absolute difference {mean}, max {max}",
            a.dimensions()
        );
        assert!(
            mean < 0.00002 && max < 0.002,
            "DNG transport changed native rendered pixels"
        );
    }
}
