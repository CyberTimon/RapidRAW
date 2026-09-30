use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use crate::app_settings::{AppSettings, load_settings, save_settings};
use crate::app_state::AppState;

use super::server::ExternalControlServerHandle;
use super::types::*;

pub struct ExternalControlInner {
    pub settings_snapshot: ExternalControlSettings,
    pub token_hash: Option<String>,
    pub session: SessionMirror,
    pub pending: HashMap<String, oneshot::Sender<BridgeResponsePayload>>,
    pub client_count: AtomicU32,
    pub last_client_activity: Mutex<Option<Instant>>,
    pub server: Option<ExternalControlServerHandle>,
}

impl ExternalControlInner {
    pub fn new() -> Self {
        Self {
            settings_snapshot: ExternalControlSettings {
                enabled: false,
                port: DEFAULT_PORT,
                token_configured: Some(false),
            },
            token_hash: None,
            session: SessionMirror::default(),
            pending: HashMap::new(),
            client_count: AtomicU32::new(0),
            last_client_activity: Mutex::new(None),
            server: None,
        }
    }
}

pub type ExternalControlState = Arc<Mutex<ExternalControlInner>>;

pub fn new_external_control_state() -> ExternalControlState {
    Arc::new(Mutex::new(ExternalControlInner::new()))
}

pub fn external_control_state(app: &AppHandle) -> ExternalControlState {
    let state = app.state::<AppState>();
    Arc::clone(&state.external_control)
}

pub fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

fn settings_from_app(app: &AppHandle) -> AppSettings {
    load_settings(app.clone()).unwrap_or_default()
}

pub fn sync_settings_from_disk(app: &AppHandle, inner: &mut ExternalControlInner) {
    let s = settings_from_app(app);
    inner.settings_snapshot = ExternalControlSettings {
        enabled: s.external_control_enabled.unwrap_or(false),
        port: s.external_control_port.unwrap_or(DEFAULT_PORT),
        token_configured: Some(s.external_control_token_hash.is_some()),
    };
    inner.token_hash = s.external_control_token_hash.clone();
}

#[tauri::command]
pub async fn external_control_get_public_status(
    app: AppHandle,
) -> Result<ExternalControlPublicStatus, String> {
    let ec = external_control_state(&app);
    let inner = ec.lock().map_err(|e| e.to_string())?;
    let listening = inner.server.is_some();
    let clients = inner.client_count.load(Ordering::Relaxed);
    Ok(ExternalControlPublicStatus {
        protocol_version: PROTOCOL_VERSION.to_string(),
        enabled: inner.settings_snapshot.enabled,
        listening,
        port: inner.settings_snapshot.port,
        token_required: inner.token_hash.is_some(),
        connected: clients > 0,
        client_count: clients,
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalControlUpdateInput {
    pub enabled: Option<bool>,
    pub port: Option<u16>,
}

#[tauri::command]
pub async fn external_control_update_settings(
    input: ExternalControlUpdateInput,
    app: AppHandle,
) -> Result<ExternalControlPublicStatus, String> {
    let mut settings = settings_from_app(&app);
    if let Some(enabled) = input.enabled {
        settings.external_control_enabled = Some(enabled);
    }
    if let Some(port) = input.port {
        if port == 0 {
            return Err("Port must be greater than zero".into());
        }
        settings.external_control_port = Some(port);
    }
    save_settings(settings, app.clone()).map_err(|e| e.to_string())?;
    restart_external_control_server(app.clone()).await?;
    external_control_get_public_status(app).await
}

#[tauri::command]
pub async fn external_control_generate_token(app: AppHandle) -> Result<String, String> {
    let bytes: [u8; 32] = rand::random();
    let token = hex::encode(bytes);
    let hash = hash_token(&token);

    let mut settings = settings_from_app(&app);
    settings.external_control_token_hash = Some(hash.clone());
    save_settings(settings, app.clone()).map_err(|e| e.to_string())?;

    {
        let ec = external_control_state(&app);
        let mut inner = ec.lock().map_err(|e| e.to_string())?;
        inner.token_hash = Some(hash);
    }

    restart_external_control_server(app).await?;
    Ok(token)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushSessionInput {
    pub session: SessionMirror,
}

#[tauri::command]
pub fn external_control_push_session(
    input: PushSessionInput,
    app: AppHandle,
) -> Result<(), String> {
    let ec = external_control_state(&app);
    let mut inner = ec.lock().map_err(|e| e.to_string())?;
    inner.session = input.session;
    Ok(())
}

#[tauri::command]
pub fn external_control_fulfill_request(
    response: BridgeResponsePayload,
    app: AppHandle,
) -> Result<(), String> {
    let ec = external_control_state(&app);
    let mut inner = ec.lock().map_err(|e| e.to_string())?;
    if let Some(tx) = inner.pending.remove(&response.request_id) {
        let _ = tx.send(response);
    }
    Ok(())
}

pub async fn restart_external_control_server(app: AppHandle) -> Result<(), String> {
    let ec = external_control_state(&app);
    let (enabled, port, token_hash, old) = {
        let mut inner = ec.lock().map_err(|e| e.to_string())?;
        sync_settings_from_disk(&app, &mut inner);
        let old = inner.server.take();
        (
            inner.settings_snapshot.enabled,
            inner.settings_snapshot.port,
            inner.token_hash.clone(),
            old,
        )
    };

    if let Some(handle) = old {
        handle.shutdown().await;
    }

    if enabled {
        let handle =
            ExternalControlServerHandle::start(app.clone(), ec.clone(), port, token_hash).await?;
        let mut inner = ec.lock().map_err(|e| e.to_string())?;
        inner.server = Some(handle);
    }

    Ok(())
}

pub async fn dispatch_bridge_action(
    app: &AppHandle,
    action: &str,
    params: Value,
) -> Result<Value, ApiErrorBody> {
    dispatch_bridge_action_timed(app, action, params, BRIDGE_TIMEOUT_SECS).await
}

pub async fn dispatch_bridge_action_timed(
    app: &AppHandle,
    action: &str,
    params: Value,
    timeout_secs: u64,
) -> Result<Value, ApiErrorBody> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();

    {
        let ec = external_control_state(app);
        let mut inner = ec
            .lock()
            .map_err(|e| ApiErrorBody::new("internal_error", format!("Lock poisoned: {e}")))?;
        inner.pending.insert(request_id.clone(), tx);
    }

    let payload = BridgeRequestPayload {
        request_id: request_id.clone(),
        action: action.to_string(),
        params,
    };

    if let Err(e) = app.emit("external-control-command", payload) {
        let ec = external_control_state(app);
        if let Ok(mut inner) = ec.lock() {
            inner.pending.remove(&request_id);
        }
        return Err(ApiErrorBody::new(
            "frontend_unavailable",
            format!("Failed to notify UI: {e}"),
        ));
    }

    match tokio::time::timeout(Duration::from_secs(timeout_secs), rx).await {
        Ok(Ok(resp)) if resp.ok => Ok(resp.data),
        Ok(Ok(resp)) => Err(resp
            .error
            .unwrap_or_else(|| ApiErrorBody::new("bridge_error", "Unknown bridge error"))),
        Ok(Err(_)) => Err(ApiErrorBody::new(
            "bridge_cancelled",
            "Bridge response channel closed",
        )),
        Err(_) => {
            let ec = external_control_state(app);
            if let Ok(mut inner) = ec.lock() {
                inner.pending.remove(&request_id);
            }
            Err(ApiErrorBody::new(
                "bridge_timeout",
                "Timed out waiting for RapidRAW UI to handle the request. Ensure the app window is running.",
            ))
        }
    }
}

pub fn verify_bearer(
    token: Option<&str>,
    expected_hash: &Option<String>,
) -> Result<(), ApiErrorBody> {
    let Some(expected) = expected_hash else {
        return Ok(());
    };
    let Some(provided) = token else {
        return Err(ApiErrorBody::new(
            "unauthorized",
            "Missing Authorization: Bearer token",
        ));
    };
    let provided_hash = hash_token(provided);
    if provided_hash != *expected {
        return Err(ApiErrorBody::new("unauthorized", "Invalid bearer token"));
    }
    Ok(())
}

pub fn adjustment_schema() -> Value {
    json!({
        "source": "RapidRAW adjustments.ts / app_settings::all_available_adjustments",
        "topLevelScalars": [
            "exposure", "brightness", "contrast", "highlights", "shadows", "whites", "blacks",
            "temperature", "tint", "saturation", "vibrance", "hue", "clarity", "structure", "dehaze",
            "sharpness", "sharpnessThreshold", "lumaNoiseReduction", "colorNoiseReduction",
            "vignetteAmount", "vignetteFeather", "vignetteMidpoint", "vignetteRoundness",
            "rotation", "flipHorizontal", "flipVertical"
        ],
        "nestedObjects": ["hsl", "colorGrading", "colorCalibration", "curves", "pointCurves", "parametricCurve", "crop", "masks"],
        "uiRanges": {
            "exposure": { "min": -5, "max": 5 },
            "brightness": { "min": -5, "max": 5 },
            "contrast": { "min": -100, "max": 100 },
            "highlights": { "min": -100, "max": 100 },
            "shadows": { "min": -100, "max": 100 },
            "whites": { "min": -100, "max": 100 },
            "blacks": { "min": -100, "max": 100 },
            "temperature": { "min": -100, "max": 100 },
            "tint": { "min": -100, "max": 100 },
            "saturation": { "min": -100, "max": 100 },
            "vibrance": { "min": -100, "max": 100 },
            "clarity": { "min": -100, "max": 100 },
            "dehaze": { "min": -100, "max": 100 },
            "structure": { "min": -100, "max": 100 }
        }
    })
}
