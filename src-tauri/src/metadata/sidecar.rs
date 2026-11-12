use crate::adjustments::lens_correction::has_lens_selection;
use crate::decode::as_shot::AsShot;
use crate::decode::baseline_exposure::BaselineOptions;
use crate::library::{file_ops, sidecars};
use crate::metadata::exif_cache::save_exif_to_rrcache;
use crate::metadata::exif_processing::{
    read_exif_data_from_bytes, read_rrexif_sidecar, truncate_large_exif,
};
use crate::render::adjustment_utils::{is_default_adjustments, is_effect_enabled, is_tool_active};
use crate::render::geometry::{Crop, is_geometry_identity, user_geometry_params};
use crate::render::options::RenderOptions;
use crate::render::uniforms::get_all_adjustments_from_json;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImageFlag {
    Pick,
    Reject,
}

fn deserialize_image_flag<'de, D>(deserializer: D) -> Result<Option<ImageFlag>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(serde_json::from_value(Value::deserialize(deserializer)?).unwrap_or(None))
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(default)]
pub struct ImageMetadata {
    pub version: u32,
    pub rating: u8,
    #[serde(
        default,
        deserialize_with = "deserialize_image_flag",
        skip_serializing_if = "Option::is_none"
    )]
    pub flag: Option<ImageFlag>,
    pub adjustments: Value,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exif: Option<std::collections::HashMap<String, String>>,
}

impl Default for ImageMetadata {
    fn default() -> Self {
        ImageMetadata {
            version: 1,
            rating: 0,
            flag: None,
            adjustments: Value::Null,
            tags: None,
            exif: None,
        }
    }
}

pub fn is_image_edited(
    adj: &serde_json::Value,
    is_raw: bool,
    tonemapper_override: Option<u32>,
) -> bool {
    if adj.is_null() || adj.as_object().is_none() {
        return false;
    }

    if let Some(patches) = adj.get("aiPatches").and_then(|v| v.as_array())
        && !patches.is_empty()
    {
        return true;
    }
    if let Some(masks) = adj.get("masks").and_then(|v| v.as_array())
        && !masks.is_empty()
    {
        return true;
    }
    if [
        ("noiseReduction", "aiDenoiseEnabled"),
        ("superResolution", "aiUpscaleEnabled"),
        ("negativeConversion", "negativeConversionEnabled"),
        ("lensBlur", "lensBlurEnabled"),
        ("relight", "relightEnabled"),
        ("fog", "fogEnabled"),
    ]
    .iter()
    .any(|(tool, enabled_key)| is_effect_enabled(adj, tool, enabled_key))
    {
        return true;
    }
    if is_tool_active(adj, "motionBlur") && adj["motionBlurAmount"].as_f64().unwrap_or(0.0) > 0.0 {
        return true;
    }

    if let Some(crop_val) = adj.get("crop")
        && !crop_val.is_null()
        && let Ok(crop) = serde_json::from_value::<Crop>(crop_val.clone())
        && (crop.x.abs() > 0.1 || crop.y.abs() > 0.1)
    {
        return true;
    }

    if adj
        .get("orientationSteps")
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
        != 0
    {
        return true;
    }
    if adj
        .get("rotation")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
        .abs()
        > 0.001
    {
        return true;
    }
    if adj
        .get("flipHorizontal")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return true;
    }
    if adj
        .get("flipVertical")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return true;
    }

    if has_lens_selection(adj) || !is_geometry_identity(&user_geometry_params(adj)) {
        return true;
    }

    let reference = AsShot::reference();
    let render = RenderOptions {
        tonemapper_override,
        non_raw_tonemapper_override: tonemapper_override,
        baseline: BaselineOptions::default(),
    };
    let current_adj = get_all_adjustments_from_json(adj, is_raw, reference, render);
    let default_adj =
        get_all_adjustments_from_json(&serde_json::json!({}), is_raw, reference, render);

    bytemuck::bytes_of(&current_adj) != bytemuck::bytes_of(&default_adj)
}

const SIDECAR_LOCK_STRIPES: usize = 64;

static SIDECAR_LOCKS: [Mutex<()>; SIDECAR_LOCK_STRIPES] =
    [const { Mutex::new(()) }; SIDECAR_LOCK_STRIPES];

fn sidecar_lock_stripe(sidecar_path: &Path) -> &'static Mutex<()> {
    let mut hasher = DefaultHasher::new();
    sidecar_path.hash(&mut hasher);
    &SIDECAR_LOCKS[hasher.finish() as usize % SIDECAR_LOCK_STRIPES]
}

pub fn lock_sidecar(sidecar_path: &Path) -> MutexGuard<'static, ()> {
    sidecar_lock_stripe(sidecar_path)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

fn heal_bloated_exif(meta: &mut ImageMetadata) -> bool {
    let mut healed = false;
    if let Some(ref mut exif_map) = meta.exif {
        for val in exif_map.values_mut() {
            if val.len() > 500 {
                *val = truncate_large_exif(val);
                healed = true;
            }
        }
    }
    healed
}

fn quarantine_sidecar(sidecar_path: &Path, error: &serde_json::Error) {
    let mut quarantined = sidecar_path.as_os_str().to_os_string();
    quarantined.push(format!(".corrupt-{}", Utc::now().format("%Y%m%d%H%M%S")));
    match fs::rename(sidecar_path, &quarantined) {
        Ok(()) => log::error!(
            "Unreadable sidecar {} ({}), moved to {}",
            sidecar_path.display(),
            error,
            Path::new(&quarantined).display()
        ),
        Err(e) => log::error!(
            "Unreadable sidecar {} ({}), could not move it aside: {}",
            sidecar_path.display(),
            error,
            e
        ),
    }
}

fn read_sidecar(sidecar_path: &Path) -> std::io::Result<(ImageMetadata, bool)> {
    let content = match fs::read_to_string(sidecar_path) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok((ImageMetadata::default(), false));
        }
        Err(e) => return Err(e),
    };

    match serde_json::from_str::<ImageMetadata>(&content) {
        Ok(mut meta) => {
            let healed = heal_bloated_exif(&mut meta);
            Ok((meta, healed))
        }
        Err(e) => {
            quarantine_sidecar(sidecar_path, &e);
            Ok((ImageMetadata::default(), false))
        }
    }
}

fn write_sidecar_json(sidecar_path: &Path, metadata: &ImageMetadata) -> std::io::Result<()> {
    let json = serde_json::to_string_pretty(metadata).map_err(std::io::Error::other)?;
    file_ops::write_file_atomic(sidecar_path, json.as_bytes())
}

pub fn load_sidecar(sidecar_path: &Path) -> ImageMetadata {
    let (meta, healed) = read_sidecar(sidecar_path).unwrap_or_else(|e| {
        log::warn!("Failed to read sidecar {}: {}", sidecar_path.display(), e);
        (ImageMetadata::default(), false)
    });

    if healed
        && let Ok(_guard) = sidecar_lock_stripe(sidecar_path).try_lock()
        && let Ok((current, true)) = read_sidecar(sidecar_path)
        && write_sidecar_json(sidecar_path, &current).is_ok()
    {
        log::info!(
            "Auto-healed bloated sidecar for: {}",
            sidecar_path.display()
        );
    }

    meta
}

pub fn fill_missing_exif(meta: &mut ImageMetadata, source_path: &Path) {
    if meta.exif.is_some() {
        return;
    }

    let exif = read_rrexif_sidecar(source_path).or_else(|| {
        let source_path_str = source_path.to_string_lossy();
        let extracted = if let Ok(mmap) = file_ops::read_file_mapped(source_path) {
            read_exif_data_from_bytes(&source_path_str, &mmap)
        } else {
            read_exif_data_from_bytes(&source_path_str, &fs::read(source_path).ok()?)
        };
        (!extracted.is_empty()).then_some(extracted)
    });

    meta.exif = exif;
}

pub static SIDECAR_LAYOUT_LOCK: Mutex<()> = Mutex::new(());

fn write_sidecar(
    sidecar_path: &Path,
    source_path: &Path,
    metadata: &ImageMetadata,
) -> std::io::Result<()> {
    if is_default_sidecar(sidecar_path, source_path, metadata) {
        let _layout = SIDECAR_LAYOUT_LOCK
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if !has_virtual_copy_sidecars(source_path) {
            return match fs::remove_file(sidecar_path) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
                _ => Ok(()),
            };
        }
    }

    write_sidecar_json(sidecar_path, metadata)
}

pub fn update_sidecar(
    sidecar_path: &Path,
    source_path: &Path,
    update: impl FnOnce(&mut ImageMetadata),
) -> std::io::Result<ImageMetadata> {
    let _guard = lock_sidecar(sidecar_path);
    let (mut metadata, _) = read_sidecar(sidecar_path)?;
    update(&mut metadata);
    if crate::integrations::immich::is_placeholder(source_path)
        && let Some(parent) = sidecar_path.parent()
    {
        fs::create_dir_all(parent)?;
    }
    write_sidecar(sidecar_path, source_path, &metadata)?;
    Ok(metadata)
}

fn has_virtual_copy_sidecars(source_path: &Path) -> bool {
    let (Some(parent), Some(file_name)) = (source_path.parent(), source_path.file_name()) else {
        return true;
    };
    let file_name = file_name.to_string_lossy();

    let Ok(entries) = fs::read_dir(parent) else {
        return true;
    };
    entries.filter_map(Result::ok).any(|entry| {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        matches!(
            sidecars::parse_sidecar_name(&name),
            Some((source, Some(_))) if source == file_name
        )
    })
}

fn is_default_sidecar(sidecar_path: &Path, source_path: &Path, metadata: &ImageMetadata) -> bool {
    if sidecar_path != get_primary_sidecar_path(source_path) {
        return false;
    }
    if metadata.rating != 0
        || metadata.flag.is_some()
        || metadata.tags.as_ref().is_some_and(|tags| !tags.is_empty())
        || !is_default_adjustments(&metadata.adjustments)
    {
        return false;
    }

    let Some(sidecar_exif) = &metadata.exif else {
        return true;
    };

    if file_ops::is_cloud_placeholder(source_path) {
        return false;
    }
    let source_path_str = source_path.to_string_lossy();
    let file_exif = if let Ok(mmap) = file_ops::read_file_mapped(source_path) {
        read_exif_data_from_bytes(&source_path_str, &mmap)
    } else if let Ok(bytes) = fs::read(source_path) {
        read_exif_data_from_bytes(&source_path_str, &bytes)
    } else {
        return false;
    };

    !file_exif.is_empty() && &file_exif == sidecar_exif
}

pub fn get_primary_sidecar_path(image_path: &Path) -> PathBuf {
    let mut filename = image_path.file_name().unwrap_or_default().to_os_string();
    filename.push(".rrdata");
    image_path.with_file_name(filename)
}

pub fn load_primary_metadata(image_path: &Path) -> ImageMetadata {
    let primary = get_primary_sidecar_path(image_path);
    load_sidecar(&primary)
}

pub fn update_primary_metadata(
    image_path: &Path,
    create: bool,
    update: impl FnOnce(&mut ImageMetadata),
) -> std::io::Result<bool> {
    let primary = get_primary_sidecar_path(image_path);
    let _guard = lock_sidecar(&primary);
    if !create && !primary.exists() {
        return Ok(false);
    }
    let (mut metadata, _) = read_sidecar(&primary)?;
    update(&mut metadata);
    write_sidecar_json(&primary, &metadata)?;
    Ok(true)
}

pub fn read_exif_data(path: &str, file_bytes: &[u8]) -> HashMap<String, String> {
    let source_path = Path::new(path);

    if let Some(cached_exif) = read_rrexif_sidecar(source_path) {
        return cached_exif;
    }

    let exif_map = read_exif_data_from_bytes(path, file_bytes);
    if !exif_map.is_empty()
        && let Ok(false) = update_primary_metadata(source_path, false, |metadata| {
            metadata.exif = Some(exif_map.clone());
        })
    {
        save_exif_to_rrcache(source_path, exif_map.clone());
    }

    exif_map
}

pub fn persist_exif_if_missing(source_path: &Path, source_path_str: &str, file_bytes: &[u8]) {
    if read_rrexif_sidecar(source_path).is_some() {
        return;
    }

    let exif_map = read_exif_data_from_bytes(source_path_str, file_bytes);
    if exif_map.is_empty() {
        return;
    }

    if let Ok(false) = update_primary_metadata(source_path, false, |metadata| {
        metadata.exif.get_or_insert_with(|| exif_map.clone());
    }) {
        save_exif_to_rrcache(source_path, exif_map);
    }
}
