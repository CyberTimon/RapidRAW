use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use walkdir::WalkDir;

use super::convert::convert;
use super::tables::{ProfileTable, bake_cube, decode_table};
use super::xmp::{CrsDoc, LookRef, parse_crs};
use crate::library::file_ops::write_file_atomic;
use crate::library::presets::{
    Preset, PresetFolder, PresetImportFailure, PresetItem, collect_top_level_preset_names,
    load_presets, save_presets, unique_name,
};
use crate::merge::focus::natural_key;

pub(super) const LUT_SIZE: usize = 33;
const BAKE_VERSION: u32 = 2;
const IMPORTED_FOLDER_PREFIX: &str = "xmp-group-";
const IMPORTED_PRESET_PREFIX: &str = "xmp-";

const GROUP_ORDER: &[&str] = &[
    "Adaptive: Portrait",
    "Adaptive: Sky",
    "Adaptive: Subject",
    "Adaptive: Landscape",
    "Adaptive: Blur Background",
    "Portraits: Deep Skin",
    "Portraits: Medium Skin",
    "Portraits: Light Skin",
    "Portraits: Black & White",
    "Portraits: Group",
    "Portraits: Edgy",
    "Auto+: Retro",
    "Seasons: Spring",
    "Seasons: Summer",
    "Seasons: Autumn",
    "Seasons: Winter",
    "Style: Cinematic",
    "Style: Cinematic II",
    "Style: Futuristic",
    "Style: Vintage",
    "Style: Black & White",
    "Style: Film-Inspired",
    "Subject: Food",
    "Subject: Concerts",
    "Subject: Landscape",
    "Subject: Lifestyle",
    "Subject: Travel",
    "Subject: Travel II",
    "Subject: Urban Architecture",
    "Video: Creative",
    "Color",
    "Creative",
    "B&W",
    "Portraits",
    "Curve",
    "Grain",
    "Optics",
    "Sharpening",
    "Vignetting",
    "Defaults",
];

fn default_settings_roots() -> Vec<PathBuf> {
    #[cfg_attr(
        not(any(target_os = "windows", target_os = "macos")),
        allow(unused_mut)
    )]
    let mut roots: Vec<PathBuf> = Vec::new();
    #[cfg(target_os = "windows")]
    {
        if let Some(program_data) = std::env::var_os("PROGRAMDATA") {
            roots.push(PathBuf::from(program_data).join("Adobe/CameraRaw/Settings"));
        }
        if let Some(app_data) = std::env::var_os("APPDATA") {
            roots.push(PathBuf::from(app_data).join("Adobe/CameraRaw/Settings"));
        }
    }
    #[cfg(target_os = "macos")]
    {
        roots.push(PathBuf::from(
            "/Library/Application Support/Adobe/CameraRaw/Settings",
        ));
        if let Some(home) = std::env::var_os("HOME") {
            roots.push(
                PathBuf::from(home).join("Library/Application Support/Adobe/CameraRaw/Settings"),
            );
        }
    }
    roots.into_iter().filter(|r| r.is_dir()).collect()
}

fn collect_xmp(root: &Path) -> Vec<PathBuf> {
    WalkDir::new(root)
        .into_iter()
        .filter_entry(|entry| {
            !(entry.file_type().is_dir()
                && entry.file_name() == "Camera"
                && entry
                    .path()
                    .parent()
                    .and_then(Path::file_name)
                    .is_some_and(|n| n == "Profiles"))
        })
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| {
            path.extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("xmp"))
        })
        .collect()
}

struct BakedLut {
    path: String,
    amount_range: (f64, f64),
}

pub struct ProfileIndex {
    by_uuid: HashMap<String, Arc<CrsDoc>>,
    by_name: HashMap<String, Arc<CrsDoc>>,
    lut_dir: Option<PathBuf>,
    baked: Mutex<HashMap<String, Option<BakedLut>>>,
}

impl ProfileIndex {
    pub fn new(lut_dir: Option<PathBuf>) -> Self {
        Self {
            by_uuid: HashMap::new(),
            by_name: HashMap::new(),
            lut_dir,
            baked: Mutex::new(HashMap::new()),
        }
    }

    fn add(&mut self, doc: CrsDoc) {
        let doc = Arc::new(doc);
        if let Some(uuid) = doc.uuid() {
            self.by_uuid.insert(uuid.to_uppercase(), doc.clone());
        }
        if let Some(name) = &doc.name {
            self.by_name.entry(name.to_lowercase()).or_insert(doc);
        }
    }

    pub fn find(&self, look: &LookRef) -> Option<&CrsDoc> {
        look.uuid
            .as_ref()
            .and_then(|u| self.by_uuid.get(&u.to_uppercase()))
            .or_else(|| {
                look.name
                    .as_ref()
                    .and_then(|n| self.by_name.get(&n.to_lowercase()))
            })
            .map(|d| d.as_ref())
    }

    pub fn lut_for(&self, profile: &CrsDoc) -> Option<(String, (f64, f64))> {
        self.lut_dir.as_ref()?;
        let digests: Vec<&str> = ["LookTable", "RGBTable"]
            .iter()
            .filter_map(|k| profile.get(k))
            .filter(|d| !d.is_empty())
            .collect();
        if digests.is_empty() {
            return None;
        }
        let rgb_strength = profile
            .get("RGBTableAmount")
            .and_then(|v| v.trim().parse::<f64>().ok())
            .filter(|v| v.is_finite())
            .map_or(1.0, |v| v.clamp(0.0, 1.0));
        let mut key = digests.join("+");
        if rgb_strength < 1.0 {
            key.push_str(&format!(" {}", (rgb_strength * 100.0).round()));
        }

        let mut baked = self.baked.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = baked.get(&key) {
            return entry.as_ref().map(|b| (b.path.clone(), b.amount_range));
        }

        let entry = self.bake_lut(profile, &digests, rgb_strength, &key);

        let result = entry.as_ref().map(|b| (b.path.clone(), b.amount_range));
        baked.insert(key, entry);
        result
    }

    fn bake_lut(
        &self,
        profile: &CrsDoc,
        digests: &[&str],
        rgb_strength: f64,
        key: &str,
    ) -> Option<BakedLut> {
        let lut_dir = self.lut_dir.as_ref()?;
        let tables: Vec<ProfileTable> = digests
            .iter()
            .filter_map(|d| profile.get(&format!("Table_{}", d)))
            .filter_map(|encoded| match decode_table(encoded) {
                Ok(mut t) => {
                    t.set_rgb_strength(rgb_strength);
                    Some(t)
                }
                Err(e) => {
                    log::warn!("Skipping Lightroom profile table: {}", e);
                    None
                }
            })
            .collect();
        if tables.is_empty() {
            return None;
        }
        let amount_range = tables
            .iter()
            .map(|t| t.amount_range())
            .fold((f64::MIN, f64::MAX), |acc, r| {
                (acc.0.max(r.0), acc.1.min(r.1))
            });

        let name = profile.name.as_deref().unwrap_or("Profile");
        let identity = format!("{} v{} n{}", key, BAKE_VERSION, LUT_SIZE);
        let path = lut_dir.join(format!("{}.cube", short_hash(&identity)));
        if !path.exists() {
            let refs: Vec<&ProfileTable> = tables.iter().collect();
            let cube = bake_cube(name, &refs, LUT_SIZE);
            fs::create_dir_all(lut_dir).ok()?;
            if let Err(e) = write_file_atomic(&path, cube.as_bytes()) {
                log::warn!("Failed to write baked profile LUT {:?}: {}", path, e);
                return None;
            }
        }
        Some(BakedLut {
            path: path.to_string_lossy().into_owned(),
            amount_range,
        })
    }
}

fn lut_dir(app_handle: &AppHandle) -> Option<PathBuf> {
    app_handle
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("presets").join("xmp-profiles"))
}

struct Scan {
    presets: Vec<(PathBuf, CrsDoc)>,
    profiles: ProfileIndex,
    failures: Vec<PresetImportFailure>,
}

fn scan(preset_roots: &[PathBuf], profile_roots: &[PathBuf], lut_dir: Option<PathBuf>) -> Scan {
    let mut profiles = ProfileIndex::new(lut_dir);
    let mut presets = Vec::new();
    let mut failures = Vec::new();
    let preset_set: HashSet<&PathBuf> = preset_roots.iter().collect();
    let mut seen = HashSet::new();

    for root in preset_roots.iter().chain(profile_roots) {
        for file in collect_xmp(root) {
            if !seen.insert(file.clone()) {
                continue;
            }
            let doc = match fs::read_to_string(&file)
                .map_err(|e| e.to_string())
                .and_then(|c| parse_crs(&c))
            {
                Ok(doc) => doc,
                Err(error) => {
                    if preset_set.contains(root) {
                        failures.push(PresetImportFailure {
                            file_name: file.to_string_lossy().into_owned(),
                            error,
                        });
                    }
                    continue;
                }
            };
            match doc.preset_type() {
                "Look" => profiles.add(doc),
                "Normal" if preset_set.contains(root) => presets.push((file, doc)),
                _ => {}
            }
        }
    }
    Scan {
        presets,
        profiles,
        failures,
    }
}

pub fn shared_profile_index(app_handle: &AppHandle) -> Arc<ProfileIndex> {
    static INDEX: OnceLock<Arc<ProfileIndex>> = OnceLock::new();
    INDEX
        .get_or_init(|| {
            Arc::new(scan(&[], &default_settings_roots(), lut_dir(app_handle)).profiles)
        })
        .clone()
}

fn group_rank(name: &str) -> (usize, String) {
    let pos = GROUP_ORDER
        .iter()
        .position(|g| g.eq_ignore_ascii_case(name))
        .unwrap_or(GROUP_ORDER.len());
    (pos, name.to_lowercase())
}

fn short_hash(text: &str) -> String {
    blake3::hash(text.as_bytes()).to_hex()[..16].to_string()
}

fn slug(name: &str) -> String {
    let s: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    s.split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct XmpImportResult {
    pub presets: Vec<PresetItem>,
    pub imported: usize,
    pub groups: usize,
    pub missing_profiles: Vec<String>,
    pub failures: Vec<PresetImportFailure>,
}

fn build_folders(scan: &Scan) -> (Vec<PresetFolder>, usize, Vec<String>) {
    struct Entry<'a> {
        doc: &'a CrsDoc,
        file: &'a Path,
    }
    let mut groups: HashMap<String, Vec<Entry>> = HashMap::new();
    for (file, doc) in &scan.presets {
        let group = doc
            .group
            .clone()
            .filter(|g| !g.trim().is_empty())
            .or_else(|| {
                file.parent()
                    .and_then(|p| p.file_name())
                    .map(|n| n.to_string_lossy().into_owned())
            })
            .unwrap_or_else(|| "Lightroom".to_string());
        groups.entry(group).or_default().push(Entry { doc, file });
    }

    let mut names: Vec<String> = groups.keys().cloned().collect();
    names.sort_by_key(|n| group_rank(n));

    let mut used_ids = HashSet::new();
    let mut used_folder_ids = HashSet::new();
    let mut missing = HashSet::new();
    let mut count = 0;
    let mut folders = Vec::new();
    for group in names {
        let mut entries = groups.remove(&group).unwrap_or_default();
        entries.sort_by_cached_key(|e| {
            natural_key(
                e.doc
                    .sort_name
                    .as_deref()
                    .or(e.doc.name.as_deref())
                    .unwrap_or(&e.file.to_string_lossy()),
            )
        });

        let mut children = Vec::new();
        for entry in entries {
            let conversion = convert(entry.doc, Some(&scan.profiles));
            if let Some(name) = conversion.missing_profile {
                missing.insert(name);
            }
            let mut preset = conversion.preset;
            preset.name = entry
                .doc
                .display_name()
                .map(str::to_string)
                .or_else(|| {
                    entry
                        .file
                        .file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                })
                .unwrap_or(preset.name);
            let base_id = entry
                .doc
                .uuid()
                .map(|u| format!("{}{}", IMPORTED_PRESET_PREFIX, u.to_lowercase()))
                .unwrap_or_else(|| preset.id.clone());
            let mut id = base_id.clone();
            let mut n = 1;
            while !used_ids.insert(id.clone()) {
                n += 1;
                id = format!("{}-{}", base_id, n);
            }
            preset.id = id;
            children.push(preset);
            count += 1;
        }

        let slugged = slug(&group);
        let mut folder_id = if slugged.is_empty() {
            format!("{}{}", IMPORTED_FOLDER_PREFIX, short_hash(&group))
        } else {
            format!("{}{}", IMPORTED_FOLDER_PREFIX, slugged)
        };
        if !used_folder_ids.insert(folder_id.clone()) {
            folder_id = format!("{}-{}", folder_id, short_hash(&group));
            used_folder_ids.insert(folder_id.clone());
        }
        folders.push(PresetFolder {
            id: folder_id,
            name: group,
            children,
        });
    }
    let mut missing: Vec<String> = missing.into_iter().collect();
    missing.sort();
    (folders, count, missing)
}

fn merge_with_existing(current: &mut Vec<PresetItem>, folders: &mut [PresetFolder]) {
    let replaced: HashSet<String> = folders.iter().map(|f| f.id.clone()).collect();
    let mut user_added: HashMap<String, Vec<Preset>> = HashMap::new();
    current.retain(|item| match item {
        PresetItem::Folder(f) if replaced.contains(&f.id) => {
            let kept: Vec<Preset> = f
                .children
                .iter()
                .filter(|p| !p.id.starts_with(IMPORTED_PRESET_PREFIX))
                .cloned()
                .collect();
            if !kept.is_empty() {
                user_added.insert(f.id.clone(), kept);
            }
            false
        }
        _ => true,
    });

    let mut fresh: HashMap<String, Preset> = HashMap::new();
    for folder in folders.iter() {
        for p in &folder.children {
            fresh.insert(p.id.clone(), p.clone());
        }
    }
    let mut moved: HashSet<String> = HashSet::new();
    let mut refresh = |p: &mut Preset| {
        if let Some(new) = fresh.get(&p.id) {
            let name = std::mem::take(&mut p.name);
            *p = new.clone();
            p.name = name;
            moved.insert(p.id.clone());
        }
    };
    for item in current.iter_mut() {
        match item {
            PresetItem::Preset(p) => refresh(p),
            PresetItem::Folder(f) => f.children.iter_mut().for_each(&mut refresh),
        }
    }

    for folder in folders.iter_mut() {
        folder.children.retain(|p| !moved.contains(&p.id));
        if let Some(kept) = user_added.remove(&folder.id) {
            folder.children.extend(kept);
        }
    }
}

fn import(
    roots: Option<Vec<String>>,
    app_handle: &AppHandle,
) -> Result<Option<XmpImportResult>, String> {
    let defaults = default_settings_roots();
    let preset_roots: Vec<PathBuf> = match roots {
        Some(r) if !r.is_empty() => r.into_iter().map(PathBuf::from).collect(),
        _ => defaults.clone(),
    };
    let scan = scan(&preset_roots, &defaults, lut_dir(app_handle));
    if scan.presets.is_empty() {
        return Ok(None);
    }
    let (folders, imported, missing_profiles) = build_folders(&scan);

    let mut current = load_presets(app_handle.clone())?;
    let mut folders = folders;
    merge_with_existing(&mut current, &mut folders);
    let mut taken = collect_top_level_preset_names(&current);

    let groups = folders.len();
    for mut folder in folders {
        folder.name = unique_name(&folder.name, &taken);
        taken.insert(folder.name.clone());
        current.push(PresetItem::Folder(folder));
    }

    save_presets(current.clone(), app_handle.clone())?;

    Ok(Some(XmpImportResult {
        presets: current,
        imported,
        groups,
        missing_profiles,
        failures: scan.failures,
    }))
}

#[tauri::command]
pub async fn import_xmp_presets(
    root_paths: Option<Vec<String>>,
    app_handle: AppHandle,
) -> Result<Option<XmpImportResult>, String> {
    tauri::async_runtime::spawn_blocking(move || import(root_paths, &app_handle))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preset(id: &str, name: &str, exposure: f64) -> Preset {
        Preset {
            id: id.into(),
            name: name.into(),
            adjustments: serde_json::json!({ "exposure": exposure }),
            include_masks: None,
            include_crop_transform: None,
            preset_type: None,
        }
    }

    #[test]
    fn reimport_keeps_user_changes() {
        let mut current = vec![
            PresetItem::Folder(PresetFolder {
                id: "xmp-group-color".into(),
                name: "Color".into(),
                children: vec![preset("xmp-a", "A", 1.0), preset("mine", "Mine", 5.0)],
            }),
            PresetItem::Preset(preset("xmp-b", "Moved B", 1.0)),
        ];
        let mut folders = vec![PresetFolder {
            id: "xmp-group-color".into(),
            name: "Color".into(),
            children: vec![preset("xmp-a", "A", 2.0), preset("xmp-b", "B", 2.0)],
        }];
        merge_with_existing(&mut current, &mut folders);
        assert_eq!(
            current.len(),
            1,
            "the imported folder is replaced, not kept beside the new one"
        );
        let ids: Vec<&str> = folders[0].children.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["xmp-a", "mine"]);
        assert_eq!(folders[0].children[0].adjustments["exposure"], 2.0);
        let PresetItem::Preset(moved) = &current[0] else {
            panic!("moved preset lost")
        };
        assert_eq!(moved.name, "Moved B");
        assert_eq!(moved.adjustments["exposure"], 2.0);
    }

    #[test]
    fn groups_follow_lightroom_order() {
        let mut v = vec![
            "Zebra",
            "Adaptive: Landscape",
            "Adaptive: Portrait",
            "Color",
        ];
        v.sort_by_key(|n| group_rank(n));
        assert_eq!(
            v,
            [
                "Adaptive: Portrait",
                "Adaptive: Landscape",
                "Color",
                "Zebra"
            ]
        );
    }
}
