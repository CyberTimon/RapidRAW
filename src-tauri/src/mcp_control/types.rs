use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: &str = "1.0.0";
pub const DEFAULT_PORT: u16 = 17355;
pub const MAX_PREVIEW_EDGE: u32 = 2048;
pub const DEFAULT_PREVIEW_EDGE: u32 = 1024;
pub const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
pub const BRIDGE_TIMEOUT_SECS: u64 = 30;
pub const AI_BRIDGE_TIMEOUT_SECS: u64 = 120;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalControlSettings {
    pub enabled: bool,
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_configured: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalControlPublicStatus {
    pub protocol_version: String,
    pub enabled: bool,
    pub listening: bool,
    pub port: u16,
    pub token_required: bool,
    pub connected: bool,
    pub client_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMirror {
    pub current_image_path: Option<String>,
    pub adjustments: Value,
    pub can_undo: bool,
    pub can_redo: bool,
    pub selected_paths: Vec<String>,
    pub current_folder: Option<String>,
}

impl Default for SessionMirror {
    fn default() -> Self {
        Self {
            current_image_path: None,
            adjustments: Value::Null,
            can_undo: false,
            can_redo: false,
            selected_paths: Vec::new(),
            current_folder: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeRequestPayload {
    pub request_id: String,
    pub action: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeResponsePayload {
    pub request_id: String,
    pub ok: bool,
    #[serde(default)]
    pub data: Value,
    #[serde(default)]
    pub error: Option<ApiErrorBody>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiErrorBody {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub details: Value,
}

impl ApiErrorBody {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: Value::Null,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResponse {
    pub width: u32,
    pub height: u32,
    pub mime_type: String,
    pub data_base64: String,
    pub source_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjustmentParameterInfo {
    pub key: String,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub description: Option<String>,
}
