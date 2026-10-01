use super::{Result, WorkspacePaths, flag, required, validation};
use crate::app_state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
};
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct Snapshot {
    pub label: String,
    pub adjustments: Value,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct Session {
    pub id: String,
    pub source_path: String,
    pub source_sha256: String,
    pub working_path: String,
    pub dimensions: (u32, u32),
    pub is_raw: bool,
    pub revision: u64,
    pub history: Vec<Snapshot>,
    pub cursor: usize,
}

impl Session {
    pub fn current(&self) -> &Snapshot {
        &self.history[self.cursor]
    }
    pub fn info(&self, adjustments: bool) -> Value {
        let mut value = json!({"session_id":self.id,"revision":self.revision,"source_path":self.source_path,"source_sha256":self.source_sha256,"working_path":self.working_path,"dimensions":{"width":self.dimensions.0,"height":self.dimensions.1},"is_raw":self.is_raw,"history_length":self.history.len(),"history_cursor":self.cursor,"metadata":self.current().metadata});
        if adjustments {
            value["adjustments"] = self.current().adjustments.clone();
        }
        value
    }
    /// Validate persisted data before any history snapshot can become active.
    pub(super) fn validate_restored(&self, directory: &Path) -> Result<()> {
        if uuid::Uuid::parse_str(&self.id).is_err()
            || directory.file_name().and_then(|s| s.to_str()) != Some(self.id.as_str())
        {
            return Err("INVALID_SESSION: Session identity must match its UUID directory".into());
        }
        if self.history.is_empty() || self.history.len() > 32 || self.cursor >= self.history.len() {
            return Err(format!("INVALID_SESSION: Invalid history for {}", self.id));
        }
        if self.dimensions.0 == 0 || self.dimensions.1 == 0 {
            return Err("INVALID_SESSION: Source dimensions must be nonzero".into());
        }
        if self.source_sha256.len() != 64
            || !self.source_sha256.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(
                "INVALID_SESSION: Source SHA-256 must contain 64 hexadecimal characters".into(),
            );
        }
        if !Path::new(&self.source_path).is_absolute()
            || !Path::new(&self.working_path).is_absolute()
        {
            return Err("INVALID_SESSION: Source and working paths must be absolute".into());
        }
        if fs::symlink_metadata(directory)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("INVALID_SESSION: Session directory cannot be a symlink".into());
        }
        let file_type = fs::symlink_metadata(&self.working_path)
            .map_err(|e| e.to_string())?
            .file_type();
        if file_type.is_symlink() || !file_type.is_file() {
            return Err(
                "INVALID_SESSION: Working source must be a regular file, not a symlink".into(),
            );
        }
        let own_directory = directory.canonicalize().map_err(|e| e.to_string())?;
        let working = Path::new(&self.working_path)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if working.parent() != Some(own_directory.as_path()) {
            return Err(
                "INVALID_SESSION: Working source must be directly inside its own UUID directory"
                    .into(),
            );
        }
        if Path::new(&self.source_path) == working {
            return Err(
                "INVALID_SESSION: Original source cannot be the session working copy".into(),
            );
        }
        for (index, snapshot) in self.history.iter().enumerate() {
            validation::validate_adjustments(&snapshot.adjustments, self.dimensions)
                .map_err(|e| format!("INVALID_SESSION: History entry {index}: {e}"))?;
            validate_metadata(&snapshot.metadata)
                .map_err(|e| format!("INVALID_SESSION: History entry {index}: {e}"))?;
        }
        Ok(())
    }
    pub fn check_revision(&self, params: &Value) -> Result<()> {
        if let Some(value) = params.get("expected_revision")
            && value.as_u64() != Some(self.revision)
        {
            return Err(format!(
                "REVISION_CONFLICT: Expected revision {value}, current revision is {}. Read the session and retry.",
                self.revision
            ));
        }
        Ok(())
    }
}

pub(super) struct Bridge {
    pub handle: tauri::AppHandle,
    pub paths: WorkspacePaths,
    pub sessions: BTreeMap<String, Session>,
    pub active: Option<String>,
    pub jobs: super::jobs::Jobs,
}

impl Bridge {
    pub fn new(handle: tauri::AppHandle, paths: WorkspacePaths) -> Result<Self> {
        let mut sessions = BTreeMap::new();
        for entry in fs::read_dir(paths.root.join("sessions")).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                continue;
            }
            let manifest = entry.path().join("session.json");
            if fs::symlink_metadata(&manifest).is_ok() {
                let session = restore_session(&entry.path())?;
                sessions.insert(session.id.clone(), session);
            }
        }
        let jobs = super::jobs::Jobs::load(&paths.root)?;
        Ok(Self {
            handle,
            paths,
            jobs,
            sessions,
            active: None,
        })
    }
    pub fn session(&self, params: &Value) -> Result<&Session> {
        let id = required(params, "session_id")?;
        self.sessions
            .get(id)
            .ok_or_else(|| format!("SESSION_NOT_FOUND: {id}"))
    }
    pub fn persist(&self, session: &Session) -> Result<()> {
        let path = self
            .paths
            .root
            .join("sessions")
            .join(&session.id)
            .join("session.json");
        atomic_write(&path, &session_manifest_bytes(session, true)?, true)
    }
    pub fn commit(
        &mut self,
        id: &str,
        mut adjustments: Value,
        metadata: Value,
        label: &str,
    ) -> Result<Value> {
        let mut session = self
            .sessions
            .get(id)
            .cloned()
            .ok_or("SESSION_NOT_FOUND: Unknown session")?;
        crate::marigold_depth::sync_orientation(&mut adjustments);
        validation::validate_adjustments(&adjustments, session.dimensions)
            .map_err(|e| format!("INVALID_ADJUSTMENTS: {e}"))?;
        validate_metadata(&metadata)?;
        session.history.truncate(session.cursor + 1);
        session.history.push(Snapshot {
            label: label.into(),
            adjustments,
            metadata,
        });
        if session.history.len() > 32 {
            session.history.remove(0);
        }
        session.cursor = session.history.len() - 1;
        session.revision += 1;
        self.persist(&session)?;
        let result = session.info(false);
        self.sessions.insert(id.into(), session);
        Ok(result)
    }
    pub async fn activate(&mut self, id: &str) -> Result<()> {
        let session = self
            .sessions
            .get(id)
            .ok_or("SESSION_NOT_FOUND: Unknown session")?;
        let state = self.handle.state::<AppState>();
        if self.active.as_deref() == Some(id) {
            let mut original = state.original_image.lock().map_err(|e| e.to_string())?;
            if let Some(loaded) = original
                .as_mut()
                .filter(|loaded| loaded.path == session.working_path)
            {
                // A float TIFF derived from RAW retains its linear RAW domain.
                // The filename's raster extension cannot carry this distinction.
                loaded.is_raw = session.is_raw;
                return Ok(());
            }
        }
        self.active = None;
        crate::image_loader::load_image(
            session.working_path.clone(),
            state.clone(),
            self.handle.clone(),
        )
        .await?;
        if let Some(loaded) = state
            .original_image
            .lock()
            .map_err(|e| e.to_string())?
            .as_mut()
        {
            loaded.is_raw = session.is_raw;
        }
        // GUI loading already resets image caches; AI embeddings are path keyed.
        *state.focus_stack_result.lock().unwrap() = None;
        self.active = Some(id.into());
        Ok(())
    }
    pub async fn open(&mut self, params: &Value) -> Result<Value> {
        let source = Path::new(required(params, "path")?)
            .canonicalize()
            .map_err(|e| format!("SOURCE_NOT_FOUND: {e}"))?;
        if !source.is_file() {
            return Err("INVALID_ARGUMENT: path must be an image file".into());
        }
        if !crate::formats::is_supported_image_file(&source) {
            return Err("UNSUPPORTED_FORMAT: Source extension is not supported".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let directory = self.paths.root.join("sessions").join(&id);
        fs::create_dir(&directory).map_err(|e| e.to_string())?;
        let extension = source
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("image");
        let working = directory.join(format!("source.{extension}"));
        crate::storage_copy::copy_new(&source, &working).map_err(|e| e.to_string())?;
        let source_sha256 = crate::ai_enhance::digest(&working).map_err(|e| e.to_string())?;
        let mut metadata = json!({"version":1,"rating":0,"tags":null,"exif":null,"adjustments":validation::default_adjustments()});
        let sidecar = PathBuf::from(format!("{}.rrdata", source.display()));
        if flag(params, "inherit_sidecar", true)? && sidecar.is_file() {
            metadata = serde_json::from_slice(&fs::read(sidecar).map_err(|e| e.to_string())?)
                .map_err(|e| format!("INVALID_SIDECAR: {e}"))?;
            if !metadata.is_object() {
                return Err("INVALID_SIDECAR: Expected metadata object".into());
            }
        }
        if metadata
            .get("adjustments")
            .is_some_and(|v| !v.is_null() && !v.is_object())
        {
            return Err("INVALID_SIDECAR: adjustments must be an object or null".into());
        }
        for (key, default) in [
            ("version", json!(1)),
            ("rating", json!(0)),
            ("tags", Value::Null),
            ("exif", Value::Null),
        ] {
            if metadata.get(key).is_none() {
                metadata[key] = default;
            }
        }
        validate_metadata(&metadata).map_err(|e| format!("INVALID_SIDECAR: {e}"))?;
        let state = self.handle.state::<AppState>();
        self.active = None;
        let loaded = crate::image_loader::load_image(
            working.to_string_lossy().into_owned(),
            state.clone(),
            self.handle.clone(),
        )
        .await?;
        let mut adjustments = validation::default_adjustments();
        if metadata["adjustments"].is_object() {
            validation::merge_patch(&mut adjustments, &metadata["adjustments"])?;
        }
        validation::validate_adjustments(&adjustments, (loaded.width, loaded.height))?;
        metadata["adjustments"] = Value::Null;
        if !metadata["exif"].is_object() {
            metadata["exif"] = serde_json::to_value(loaded.exif).map_err(|e| e.to_string())?;
        }
        let mut session = Session {
            id: id.clone(),
            source_path: source.to_string_lossy().into_owned(),
            source_sha256,
            working_path: working.to_string_lossy().into_owned(),
            dimensions: (loaded.width, loaded.height),
            is_raw: loaded.is_raw,
            revision: 0,
            history: vec![Snapshot {
                label: "Opened source".into(),
                adjustments: adjustments.clone(),
                metadata,
            }],
            cursor: 0,
        };
        // Make external LUT dependencies part of the isolated session before saving.
        self.materialize_lut(&session, &mut adjustments)?;
        session.history[0].adjustments = adjustments;
        validate_metadata(&session.current().metadata)?;
        self.persist(&session)?;
        let info = session.info(true);
        self.sessions.insert(id.clone(), session);
        self.active = Some(id);
        Ok(info)
    }
    pub fn output_path(&self, path: &str, category: &str) -> Result<PathBuf> {
        resolve_output_path(&self.paths.root, path, category)
    }

    pub fn save_sidecar(&self, id: &str) -> Result<Value> {
        let session = self
            .sessions
            .get(id)
            .ok_or("SESSION_NOT_FOUND: Unknown session")?;
        let mut envelope = session.current().metadata.clone();
        envelope["adjustments"] = session.current().adjustments.clone();
        let path = PathBuf::from(format!("{}.rrdata", session.working_path));
        atomic_write(
            &path,
            &serde_json::to_vec_pretty(&envelope).map_err(|e| e.to_string())?,
            true,
        )?;
        Ok(json!({"session_id":id,"revision":session.revision,"path":path,"source_unchanged":true}))
    }
    pub async fn derived(
        &mut self,
        parent: &Session,
        image: image::DynamicImage,
        label: &str,
    ) -> Result<Value> {
        let path =
            self.output_path(&format!("derived-{}.tiff", uuid::Uuid::new_v4()), "exports")?;
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb32F(image.to_rgb32f())
            .write_to(&mut bytes, image::ImageFormat::Tiff)
            .map_err(|e| e.to_string())?;
        atomic_write(&path, &bytes.into_inner(), false)?;
        let result = self
            .open(&json!({"path":path,"inherit_sidecar":false}))
            .await?;
        let id = result["session_id"].as_str().unwrap().to_string();
        let mut session = self.sessions[&id].clone();
        session.history[0].label = label.into();
        session.history[0].metadata = parent.current().metadata.clone();
        self.persist(&session)?;
        let result = session.info(true);
        self.sessions.insert(id, session);
        Ok(result)
    }
}

fn resolve_output_path(root: &Path, path: &str, category: &str) -> Result<PathBuf> {
    if !["exports", "recipes"].contains(&category) {
        return Err("INVALID_PATH: Unknown output category".into());
    }
    let category_root = root.join(category);
    let canonical_category = category_root
        .canonicalize()
        .map_err(|e| format!("INVALID_PATH: {e}"))?;
    if canonical_category != category_root {
        return Err("INVALID_PATH: Output category cannot be a symlink".into());
    }
    let given = Path::new(path);
    if given
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err("INVALID_PATH: Parent traversal is not allowed".into());
    }
    let target = if given.is_absolute() {
        given.to_path_buf()
    } else {
        category_root.join(given)
    };
    if !target.starts_with(&category_root) {
        return Err(format!(
            "INVALID_PATH: Output must be inside {}",
            category_root.display()
        ));
    }
    let parent = target
        .parent()
        .ok_or("INVALID_PATH: Output has no parent")?;
    let mut ancestor = parent;
    while !ancestor.exists() {
        ancestor = ancestor
            .parent()
            .ok_or("INVALID_PATH: No existing parent")?;
    }
    if !ancestor
        .canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(&canonical_category)
    {
        return Err("INVALID_PATH: Symlink escapes output directory".into());
    }
    if fs::symlink_metadata(&target).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("INVALID_PATH: Output cannot be a symlink".into());
    }
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let canonical_parent = parent.canonicalize().map_err(|e| e.to_string())?;
    if !canonical_parent.starts_with(&canonical_category) {
        return Err("INVALID_PATH: Symlink escapes output directory".into());
    }
    Ok(canonical_parent.join(target.file_name().ok_or("INVALID_PATH: Missing filename")?))
}

pub(super) fn validate_metadata(metadata: &Value) -> Result<()> {
    let map = metadata
        .as_object()
        .ok_or("INVALID_METADATA: Expected an object")?;
    if map.get("version").is_some_and(|v| v.as_u64().is_none()) {
        return Err("INVALID_METADATA: version must be a nonnegative integer".into());
    }
    if map
        .get("rating")
        .is_some_and(|v| v.as_u64().is_none_or(|n| n > 5))
    {
        return Err("INVALID_METADATA: rating must be an integer from 0 to 5".into());
    }
    if let Some(tags) = map.get("tags").filter(|v| !v.is_null())
        && tags.as_array().is_none_or(|a| {
            a.len() > 1000 || a.iter().any(|v| v.as_str().is_none_or(|s| s.len() > 256))
        })
    {
        return Err(
            "INVALID_METADATA: tags must contain at most 1000 strings of at most 256 bytes".into(),
        );
    }
    if let Some(exif) = map.get("exif").filter(|v| !v.is_null())
        && exif.as_object().is_none_or(|m| {
            m.values()
                .any(|v| v.as_str().is_none_or(|s| s.len() > 4096))
        })
    {
        return Err("INVALID_METADATA: EXIF must map keys to strings of at most 4096 bytes".into());
    }
    Ok(())
}

/// Embedded images (AI mask bitmaps) repeat in every history snapshot. The
/// manifest stores each distinct image once in a hash-keyed table and refers to
/// it from the snapshots; restore expands them again, so the engine and the
/// MCP surface still see the original adjustments.
const BLOB_MIN_LEN: usize = 4096;
const BLOB_PREFIX: &str = "blob:sha256:";

fn externalize_blobs(value: &mut Value, blobs: &mut BTreeMap<String, String>) {
    match value {
        Value::String(text) if text.len() >= BLOB_MIN_LEN && text.starts_with("data:image/") => {
            use sha2::{Digest, Sha256};
            let key: String = Sha256::digest(text.as_bytes())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            let reference = format!("{BLOB_PREFIX}{key}");
            let original = std::mem::replace(text, reference);
            blobs.entry(key).or_insert(original);
        }
        Value::Array(items) => items.iter_mut().for_each(|v| externalize_blobs(v, blobs)),
        Value::Object(map) => map.values_mut().for_each(|v| externalize_blobs(v, blobs)),
        _ => {}
    }
}

fn internalize_blobs(value: &mut Value, blobs: &BTreeMap<String, String>) -> Result<()> {
    match value {
        Value::String(text) if text.starts_with(BLOB_PREFIX) => {
            let key = &text[BLOB_PREFIX.len()..];
            let original = blobs.get(key).ok_or_else(|| {
                format!("INVALID_SESSION: Session manifest is missing embedded image {key}")
            })?;
            *text = original.clone();
        }
        Value::Array(items) => {
            for item in items {
                internalize_blobs(item, blobs)?;
            }
        }
        Value::Object(map) => {
            for item in map.values_mut() {
                internalize_blobs(item, blobs)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Serialize a session manifest, storing repeated embedded images once.
pub(super) fn session_manifest_bytes(session: &Session, pretty: bool) -> Result<Vec<u8>> {
    let mut value = serde_json::to_value(session).map_err(|e| e.to_string())?;
    let mut blobs = BTreeMap::new();
    externalize_blobs(&mut value, &mut blobs);
    if !blobs.is_empty() {
        value["blobs"] = serde_json::to_value(blobs).map_err(|e| e.to_string())?;
    }
    if pretty {
        serde_json::to_vec_pretty(&value)
    } else {
        serde_json::to_vec(&value)
    }
    .map_err(|e| e.to_string())
}

/// Parse a manifest written with or without the shared image table.
pub(super) fn session_from_manifest_bytes(bytes: &[u8]) -> std::result::Result<Session, String> {
    let mut value: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if let Some(table) = value.as_object_mut().and_then(|map| map.remove("blobs")) {
        let blobs: BTreeMap<String, String> =
            serde_json::from_value(table).map_err(|e| format!("invalid image table: {e}"))?;
        internalize_blobs(&mut value, &blobs)?;
    }
    serde_json::from_value(value).map_err(|e| e.to_string())
}

pub(super) fn restore_session(directory: &Path) -> Result<Session> {
    let manifest = directory.join("session.json");
    let file_type = fs::symlink_metadata(&manifest)
        .map_err(|e| e.to_string())?
        .file_type();
    if file_type.is_symlink() || !file_type.is_file() {
        return Err(
            "INVALID_SESSION: Session manifest must be a regular file, not a symlink".into(),
        );
    }
    let session = session_from_manifest_bytes(&fs::read(&manifest).map_err(|e| e.to_string())?)
        .map_err(|e| format!("INVALID_SESSION: {}: {e}", manifest.display()))?;
    session.validate_restored(directory)?;
    Ok(session)
}

pub(super) fn atomic_write(path: &Path, bytes: &[u8], overwrite: bool) -> Result<()> {
    if path.exists() && !overwrite {
        return Err(format!("OUTPUT_EXISTS: {}", path.display()));
    }
    let parent = path.parent().ok_or("INVALID_PATH: Missing parent")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temp.write_all(bytes).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    if overwrite {
        temp.persist(path).map_err(|e| e.to_string())?;
    } else {
        temp.persist_noclobber(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> Session {
        Session {
            id: uuid::Uuid::new_v4().to_string(),
            source_path: "/photos/original.cr3".into(),
            source_sha256: "a".repeat(64),
            working_path: "/workspace/sessions/source.cr3".into(),
            dimensions: (100, 80),
            is_raw: true,
            revision: 8,
            history: vec![
                Snapshot {
                    label: "Original".into(),
                    adjustments: json!({"exposure": 0.0}),
                    metadata: json!({"rating": 0, "tags": ["original"]}),
                },
                Snapshot {
                    label: "Edited".into(),
                    adjustments: json!({"exposure": 0.5}),
                    metadata: json!({"rating": 4, "tags": ["edited"]}),
                },
            ],
            cursor: 1,
        }
    }

    fn persisted_fixture(root: &Path) -> (Session, PathBuf) {
        let mut fixture = session();
        let directory = root.join(&fixture.id);
        fs::create_dir(&directory).unwrap();
        let source = directory.join("source.cr3");
        fs::write(&source, b"isolated source").unwrap();
        fixture.working_path = source.to_string_lossy().into_owned();
        for snapshot in &mut fixture.history {
            snapshot.adjustments = validation::default_adjustments();
        }
        atomic_write(
            &directory.join("session.json"),
            &serde_json::to_vec(&fixture).unwrap(),
            false,
        )
        .unwrap();
        (fixture, directory)
    }

    #[test]
    fn manifest_stores_repeated_embedded_images_once_and_restores_them() {
        let bitmap = format!("data:image/png;base64,{}", "A".repeat(BLOB_MIN_LEN));
        let other = format!("data:image/png;base64,{}", "B".repeat(BLOB_MIN_LEN));
        let mut before = session();
        for (index, snapshot) in before.history.iter_mut().enumerate() {
            snapshot.adjustments = json!({"masks":[{"subMasks":[
                {"parameters":{"maskDataBase64": bitmap}},
                {"parameters":{"maskDataBase64": if index == 0 { &bitmap } else { &other }}}
            ]}], "note": "short data:image/ text stays inline"});
        }
        let bytes = session_manifest_bytes(&before, false).unwrap();
        let text = String::from_utf8(bytes.clone()).unwrap();
        assert_eq!(text.matches(&bitmap).count(), 1);
        assert_eq!(text.matches(&other).count(), 1);
        assert!(text.contains("blob:sha256:"));
        let after = session_from_manifest_bytes(&bytes).unwrap();
        for (a, b) in before.history.iter().zip(&after.history) {
            assert_eq!(a.adjustments, b.adjustments);
        }
    }

    #[test]
    fn manifest_without_image_table_still_restores_and_missing_images_are_rejected() {
        let before = session();
        let legacy = serde_json::to_vec(&before).unwrap();
        assert_eq!(
            session_from_manifest_bytes(&legacy).unwrap().history.len(),
            2
        );
        let mut value = serde_json::to_value(&before).unwrap();
        value["history"][0]["adjustments"] =
            json!({"x": format!("{BLOB_PREFIX}{}", "0".repeat(64))});
        value["blobs"] = json!({});
        let error = session_from_manifest_bytes(&serde_json::to_vec(&value).unwrap()).unwrap_err();
        assert!(error.contains("missing embedded image"));
    }

    #[test]
    fn restore_checks_all_history_including_inactive_snapshots() {
        let root = tempfile::tempdir().unwrap();
        let (mut fixture, directory) = persisted_fixture(root.path());
        assert!(restore_session(&directory).is_ok());
        fixture.history[0].adjustments["unknownControl"] = json!(1);
        assert!(
            fixture
                .validate_restored(&directory)
                .unwrap_err()
                .contains("History entry 0")
        );
        fixture.history[0].adjustments = validation::default_adjustments();
        fixture.history[0].metadata["rating"] = json!(9);
        assert!(
            fixture
                .validate_restored(&directory)
                .unwrap_err()
                .contains("History entry 0")
        );
    }

    #[test]
    fn restore_rejects_wrong_identity_cursor_and_cross_session_sources() {
        let root = tempfile::tempdir().unwrap();
        let (fixture, directory) = persisted_fixture(root.path());
        let mut invalid = fixture.clone();
        invalid.id = uuid::Uuid::new_v4().to_string();
        assert!(invalid.validate_restored(&directory).is_err());
        invalid = fixture.clone();
        invalid.cursor = invalid.history.len();
        assert!(invalid.validate_restored(&directory).is_err());
        invalid = fixture.clone();
        invalid.history.clear();
        assert!(invalid.validate_restored(&directory).is_err());
        let (other, _) = persisted_fixture(root.path());
        invalid = fixture.clone();
        invalid.working_path = other.working_path;
        assert!(
            invalid
                .validate_restored(&directory)
                .unwrap_err()
                .contains("own UUID directory")
        );
        invalid = fixture;
        invalid.source_sha256 = "bad".into();
        assert!(invalid.validate_restored(&directory).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn restore_rejects_symlinked_manifest_and_source() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let (fixture, directory) = persisted_fixture(root.path());
        let manifest = directory.join("session.json");
        let moved = root.path().join("external-manifest.json");
        fs::rename(&manifest, &moved).unwrap();
        symlink(&moved, &manifest).unwrap();
        assert!(
            restore_session(&directory)
                .unwrap_err()
                .contains("manifest")
        );
        fs::remove_file(&manifest).unwrap();
        fs::rename(&moved, &manifest).unwrap();
        let source = Path::new(&fixture.working_path);
        let external = root.path().join("external.cr3");
        fs::rename(source, &external).unwrap();
        symlink(&external, source).unwrap();
        assert!(restore_session(&directory).unwrap_err().contains("symlink"));
        assert_eq!(fs::read(&external).unwrap(), b"isolated source");
    }

    #[test]
    fn metadata_validation_preserves_unknown_upstream_fields() {
        let metadata = json!({"version":1,"rating":3,"tags":["bird"],"exif":{"Artist":"Photographer"},"futureUpstreamField":{"keep":true}});
        assert!(validate_metadata(&metadata).is_ok());
        assert_eq!(metadata["futureUpstreamField"]["keep"], true);
        for bad in [
            json!({"rating":-1}),
            json!({"tags":[1]}),
            json!({"exif":{"Artist":false}}),
            Value::Null,
        ] {
            assert!(validate_metadata(&bad).is_err());
        }
    }

    #[test]
    fn output_paths_are_category_scoped_and_reject_parent_traversal() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        fs::create_dir(root.join("exports")).unwrap();
        fs::create_dir(root.join("recipes")).unwrap();
        assert_eq!(
            resolve_output_path(&root, "nested/photo.jpg", "exports").unwrap(),
            root.join("exports/nested/photo.jpg")
        );
        assert!(resolve_output_path(&root, "../source.cr3", "exports").is_err());
        assert!(
            resolve_output_path(
                &root,
                root.join("recipes/x.json").to_str().unwrap(),
                "exports"
            )
            .is_err()
        );
        assert!(resolve_output_path(&root, "x", "sessions").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn output_symlinks_are_rejected_before_creating_directories_elsewhere() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        fs::create_dir(root.join("exports")).unwrap();
        fs::create_dir(root.join("sessions")).unwrap();
        symlink(root.join("sessions"), root.join("exports/escape")).unwrap();
        assert!(resolve_output_path(&root, "escape/created/file.jpg", "exports").is_err());
        assert!(!root.join("sessions/created").exists());
        let source = root.join("original.cr3");
        fs::write(&source, b"original").unwrap();
        symlink(&source, root.join("exports/link.jpg")).unwrap();
        assert!(resolve_output_path(&root, "link.jpg", "exports").is_err());
        assert_eq!(fs::read(source).unwrap(), b"original");
    }

    #[test]
    fn revision_guard_rejects_stale_fractional_and_negative_values() {
        let session = session();
        assert!(session.check_revision(&json!({})).is_ok());
        assert!(
            session
                .check_revision(&json!({"expected_revision": 8}))
                .is_ok()
        );
        for value in [
            json!(7),
            json!(9),
            json!(-1),
            json!(8.5),
            json!("8"),
            Value::Null,
        ] {
            let error = session
                .check_revision(&json!({"expected_revision": value}))
                .unwrap_err();
            assert!(error.starts_with("REVISION_CONFLICT:"));
        }
        assert_eq!(session.revision, 8);
        assert_eq!(session.cursor, 1);
    }

    #[test]
    fn persistence_roundtrip_retains_history_metadata_and_source_identity() {
        let before = session();
        let after: Session = serde_json::from_slice(&serde_json::to_vec(&before).unwrap()).unwrap();
        assert_eq!(after.source_path, before.source_path);
        assert_eq!(after.source_sha256, before.source_sha256);
        assert_eq!(after.working_path, before.working_path);
        assert_eq!(after.dimensions, (100, 80));
        assert_eq!(after.revision, 8);
        assert_eq!(after.cursor, 1);
        assert_eq!(after.current().metadata["rating"], 4);
        assert_eq!(after.history[0].metadata["tags"], json!(["original"]));
        assert_eq!(after.current().adjustments["exposure"], 0.5);
    }

    #[test]
    fn session_info_discloses_requested_state_without_mutation() {
        let session = session();
        let compact = session.info(false);
        let full = session.info(true);
        assert!(compact.get("adjustments").is_none());
        assert_eq!(full["adjustments"]["exposure"], 0.5);
        assert_eq!(compact["metadata"]["rating"], 4);
        assert_eq!(compact["dimensions"], json!({"width":100,"height":80}));
        assert_eq!(compact["history_cursor"], 1);
        assert_eq!(session.history.len(), 2);
    }

    #[test]
    fn atomic_write_refuses_existing_output_and_only_explicitly_replaces() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("recipe.json");
        atomic_write(&path, b"original", false).unwrap();
        assert!(
            atomic_write(&path, b"replacement", false)
                .unwrap_err()
                .starts_with("OUTPUT_EXISTS:")
        );
        assert_eq!(fs::read(&path).unwrap(), b"original");
        atomic_write(&path, b"replacement", true).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
        assert_eq!(
            fs::read_dir(directory.path()).unwrap().count(),
            1,
            "temporary files must not remain after completion"
        );
    }

    #[test]
    fn atomic_write_failure_preserves_existing_directory_and_other_files() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("already-directory");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("keep"), b"keep").unwrap();
        assert!(atomic_write(&destination, b"replacement", true).is_err());
        assert_eq!(fs::read(destination.join("keep")).unwrap(), b"keep");
        assert_eq!(
            fs::read_dir(directory.path()).unwrap().count(),
            1,
            "failed persistence must clean the temporary file"
        );
    }

    #[cfg(unix)]
    #[test]
    fn atomic_overwrite_replaces_symlink_without_mutating_its_target() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("original.cr3");
        let link = directory.path().join("output");
        fs::write(&original, b"unaltered source bytes").unwrap();
        symlink(&original, &link).unwrap();
        assert!(atomic_write(&link, b"first", false).is_err());
        atomic_write(&link, b"rendered output", true).unwrap();
        assert_eq!(fs::read(&original).unwrap(), b"unaltered source bytes");
        assert_eq!(fs::read(&link).unwrap(), b"rendered output");
        assert!(
            !fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }
}
