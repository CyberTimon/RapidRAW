use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use image::GenericImageView;
use image::imageops::FilterType;
use mozjpeg_rs::{Encoder, Preset};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;
use tower_http::limit::RequestBodyLimitLayer;

use crate::ai_connector;
use crate::app_settings::load_settings;
use crate::app_state::AppState;
use crate::export_processing::{
    ExportAdjustmentsMode, ExportSettings, TiffBitDepth, export_images_impl,
};
use crate::file_management;
use crate::image_processing::ImageMetadata;

use super::bridge::{
    ExternalControlState, adjustment_schema, dispatch_bridge_action, dispatch_bridge_action_timed,
    external_control_state, verify_bearer,
};
use super::paths::{validate_library_path, validate_output_path, validate_preset_file_path};
use super::types::*;

#[derive(Clone)]
struct AppCtx {
    app: AppHandle,
    ec: ExternalControlState,
    token_hash: Option<String>,
    active_requests: Arc<AtomicU32>,
}

pub struct ExternalControlServerHandle {
    shutdown_tx: Option<oneshot::Sender<()>>,
    join: tokio::task::JoinHandle<()>,
}

impl ExternalControlServerHandle {
    pub async fn start(
        app: AppHandle,
        ec: ExternalControlState,
        port: u16,
        token_hash: Option<String>,
    ) -> Result<Self, String> {
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let (shutdown_tx, shutdown_rx) = oneshot::channel();

        let ctx = AppCtx {
            app: app.clone(),
            ec: ec.clone(),
            token_hash: token_hash.clone(),
            active_requests: Arc::new(AtomicU32::new(0)),
        };

        let router = build_router(ctx);

        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .map_err(|e| format!("Failed to bind 127.0.0.1:{port}: {e}"))?;

        log::info!("External control API listening on http://127.0.0.1:{port}/v1");

        let join = tokio::spawn(async move {
            let server = axum::serve(listener, router).with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            });
            if let Err(e) = server.await {
                log::error!("External control server error: {e}");
            }
        });

        Ok(Self {
            shutdown_tx: Some(shutdown_tx),
            join,
        })
    }

    pub async fn shutdown(mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        let _ = self.join.await;
    }
}

fn build_router(ctx: AppCtx) -> Router {
    Router::new()
        .route("/v1/status", get(status_handler))
        .route("/v1/adjustments/schema", get(adjustments_schema_handler))
        .route("/v1/current-image", get(current_image_handler))
        .route("/v1/adjustments", get(get_adjustments_handler))
        .route("/v1/adjustments/set", post(set_adjustment_handler))
        .route("/v1/adjustments/adjust", post(adjust_parameter_handler))
        .route("/v1/adjustments/reset", post(reset_adjustments_handler))
        .route("/v1/undo", post(undo_handler))
        .route("/v1/redo", post(redo_handler))
        .route("/v1/selection", get(selection_handler))
        .route("/v1/preview", get(preview_handler))
        .route("/v1/images", get(list_images_handler))
        .route("/v1/images/open", post(open_image_handler))
        .route("/v1/images/next", post(next_image_handler))
        .route("/v1/images/previous", post(previous_image_handler))
        .route("/v1/images/metadata", get(metadata_handler))
        .route("/v1/presets", get(list_presets_handler))
        .route("/v1/presets/apply", post(apply_preset_handler))
        .route("/v1/presets/save", post(save_preset_handler))
        .route("/v1/presets/import", post(import_presets_handler))
        .route("/v1/presets/community", get(list_community_presets_handler))
        .route(
            "/v1/presets/community/import",
            post(import_community_preset_handler),
        )
        .route("/v1/rating", post(rate_handler))
        .route("/v1/color-label", post(color_label_handler))
        .route("/v1/adjustments/copy", post(copy_adjustments_handler))
        .route("/v1/adjustments/paste", post(paste_adjustments_handler))
        .route(
            "/v1/adjustments/apply-to",
            post(apply_adjustments_to_handler),
        )
        .route("/v1/export", post(export_handler))
        .route("/v1/export/batch", post(export_batch_handler))
        .route("/v1/masks/ai", post(masks_ai_handler))
        .route("/v1/masks/adjust", post(masks_adjust_handler))
        .route("/v1/ai/erase", post(ai_erase_handler))
        .route("/v1/ai/status", get(ai_status_handler))
        .route("/v1/ai/denoise", post(ai_denoise_handler))
        .layer(RequestBodyLimitLayer::new(MAX_BODY_BYTES))
        .with_state(ctx)
}

async fn auth_middleware(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
) -> Result<(), ApiErrorBody> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ").map(str::trim));
    verify_bearer(token, &ctx.token_hash)?;
    Ok(())
}

fn api_error(status: StatusCode, err: ApiErrorBody) -> Response {
    (
        status,
        Json(json!({
            "ok": false,
            "error": err,
        })),
    )
        .into_response()
}

fn api_ok(data: Value) -> Response {
    Json(json!({ "ok": true, "data": data })).into_response()
}

async fn with_auth<F>(ctx: &AppCtx, headers: &HeaderMap, f: F) -> Response
where
    F: std::future::Future<Output = Result<Value, ApiErrorBody>>,
{
    if let Err(e) = auth_middleware(State(ctx.clone()), headers.clone()).await {
        return api_error(StatusCode::UNAUTHORIZED, e);
    }

    ctx.active_requests.fetch_add(1, Ordering::Relaxed);
    {
        let ec = external_control_state(&ctx.app);
        if let Ok(inner) = ec.lock() {
            inner.client_count.fetch_add(1, Ordering::Relaxed);
        }
    }

    let result = f.await;

    {
        let ec = external_control_state(&ctx.app);
        if let Ok(inner) = ec.lock() {
            inner.client_count.fetch_sub(1, Ordering::Relaxed);
        }
    }
    ctx.active_requests.fetch_sub(1, Ordering::Relaxed);

    match result {
        Ok(v) => api_ok(v),
        Err(e) => {
            let status = match e.code.as_str() {
                "unauthorized" => StatusCode::UNAUTHORIZED,
                "path_forbidden" | "invalid_path" => StatusCode::FORBIDDEN,
                "path_not_found" | "not_found" => StatusCode::NOT_FOUND,
                "bridge_timeout" | "frontend_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
                _ => StatusCode::BAD_REQUEST,
            };
            api_error(status, e)
        }
    }
}

async fn status_handler(State(ctx): State<AppCtx>, headers: HeaderMap) -> Response {
    with_auth(&ctx, &headers, async {
        let ec = external_control_state(&ctx.app);
        let inner = ec
            .lock()
            .map_err(|e| ApiErrorBody::new("internal_error", format!("Lock error: {e}")))?;
        Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "enabled": inner.settings_snapshot.enabled,
            "port": inner.settings_snapshot.port,
            "session": inner.session,
        }))
    })
    .await
}

async fn adjustments_schema_handler(State(ctx): State<AppCtx>, headers: HeaderMap) -> Response {
    with_auth(&ctx, &headers, async { Ok(adjustment_schema()) }).await
}

async fn current_image_handler(State(ctx): State<AppCtx>, headers: HeaderMap) -> Response {
    with_auth(&ctx, &headers, async {
        let ec = external_control_state(&ctx.app);
        let inner = ec
            .lock()
            .map_err(|e| ApiErrorBody::new("internal_error", format!("Lock error: {e}")))?;
        Ok(json!({
            "path": inner.session.current_image_path,
            "ready": inner.session.current_image_path.is_some(),
        }))
    })
    .await
}

async fn get_adjustments_handler(State(ctx): State<AppCtx>, headers: HeaderMap) -> Response {
    with_auth(&ctx, &headers, async {
        dispatch_bridge_action(&ctx.app, "get_adjustments", json!({})).await
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetAdjustmentBody {
    key: String,
    value: Value,
}

async fn set_adjustment_handler(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Json(body): Json<SetAdjustmentBody>,
) -> Response {
    with_auth(&ctx, &headers, async {
        dispatch_bridge_action(
            &ctx.app,
            "set_adjustment",
            json!({ "key": body.key, "value": body.value }),
        )
        .await
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdjustParameterBody {
    key: String,
    delta: f64,
}

async fn adjust_parameter_handler(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Json(body): Json<AdjustParameterBody>,
) -> Response {
    with_auth(&ctx, &headers, async {
        dispatch_bridge_action(
            &ctx.app,
            "adjust_parameter",
            json!({ "key": body.key, "delta": body.delta }),
        )
        .await
    })
    .await
}

async fn reset_adjustments_handler(State(ctx): State<AppCtx>, headers: HeaderMap) -> Response {
    with_auth(&ctx, &headers, async {
        dispatch_bridge_action(&ctx.app, "reset_adjustments", json!({})).await
    })
    .await
}

async fn undo_handler(State(ctx): State<AppCtx>, headers: HeaderMap) -> Response {
    with_auth(&ctx, &headers, async {
        dispatch_bridge_action(&ctx.app, "undo", json!({})).await
    })
    .await
}

async fn redo_handler(State(ctx): State<AppCtx>, headers: HeaderMap) -> Response {
    with_auth(&ctx, &headers, async {
        dispatch_bridge_action(&ctx.app, "redo", json!({})).await
    })
    .await
}

async fn selection_handler(State(ctx): State<AppCtx>, headers: HeaderMap) -> Response {
    with_auth(&ctx, &headers, async {
        let ec = external_control_state(&ctx.app);
        let inner = ec
            .lock()
            .map_err(|e| ApiErrorBody::new("internal_error", format!("Lock error: {e}")))?;
        Ok(json!({
            "selectedPaths": inner.session.selected_paths,
            "currentFolder": inner.session.current_folder,
        }))
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewQuery {
    max_edge: Option<u32>,
    path: Option<String>,
}

async fn preview_handler(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Query(q): Query<PreviewQuery>,
) -> Response {
    with_auth(&ctx, &headers, async {
        let max_edge = q
            .max_edge
            .unwrap_or(DEFAULT_PREVIEW_EDGE)
            .min(MAX_PREVIEW_EDGE);
        let settings = load_settings(ctx.app.clone()).unwrap_or_default();

        let (path, adjustments) = if let Some(p) = q.path {
            let canonical = validate_library_path(&p, &settings)?;
            let meta: ImageMetadata = file_management::load_metadata(
                canonical.to_string_lossy().to_string(),
                ctx.app.clone(),
            )
            .map_err(|e| ApiErrorBody::new("metadata_error", e))?;
            (canonical.to_string_lossy().to_string(), meta.adjustments)
        } else {
            let ec = external_control_state(&ctx.app);
            let inner = ec
                .lock()
                .map_err(|e| ApiErrorBody::new("internal_error", format!("Lock error: {e}")))?;
            let Some(path) = inner.session.current_image_path.clone() else {
                return Err(ApiErrorBody::new(
                    "no_image",
                    "No image open. Use POST /v1/images/open or pass ?path=",
                ));
            };
            (path, inner.session.adjustments.clone())
        };

        let preview = render_preview_jpeg(&ctx.app, &path, adjustments, max_edge).await?;
        Ok(serde_json::to_value(preview).unwrap())
    })
    .await
}

async fn render_preview_jpeg(
    app: &AppHandle,
    path: &str,
    adjustments: Value,
    max_edge: u32,
) -> Result<PreviewResponse, ApiErrorBody> {
    let path = path.to_string();
    let bytes = crate::generate_preview_bytes_for_path(path.clone(), adjustments, app.clone())
        .await
        .map_err(|e| ApiErrorBody::new("preview_failed", e))?;

    let img = image::load_from_memory(&bytes)
        .map_err(|e| ApiErrorBody::new("preview_failed", format!("Decode preview failed: {e}")))?;

    let (w, h) = img.dimensions();
    let (nw, nh) = scale_dims(w, h, max_edge);
    let resized = if nw != w || nh != h {
        img.resize(nw, nh, FilterType::Triangle)
    } else {
        img
    };

    let rgb = resized.to_rgb8();
    let jpeg = encode_jpeg(&rgb.into_raw(), nw, nh)
        .map_err(|e| ApiErrorBody::new("preview_failed", format!("JPEG encode failed: {e}")))?;

    if jpeg.len() > 4 * 1024 * 1024 {
        return Err(ApiErrorBody::new(
            "preview_too_large",
            "Preview exceeds 4MiB after encoding; reduce maxEdge",
        ));
    }

    Ok(PreviewResponse {
        width: nw,
        height: nh,
        mime_type: "image/jpeg".to_string(),
        data_base64: base64::engine::general_purpose::STANDARD.encode(jpeg),
        source_path: Some(path),
    })
}

fn scale_dims(w: u32, h: u32, max_edge: u32) -> (u32, u32) {
    let max_side = w.max(h);
    if max_side <= max_edge {
        return (w, h);
    }
    let scale = max_edge as f32 / max_side as f32;
    (
        ((w as f32) * scale).round().max(1.0) as u32,
        ((h as f32) * scale).round().max(1.0) as u32,
    )
}

fn encode_jpeg(pixels: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    Encoder::new(Preset::BaselineFastest)
        .quality(85)
        .encode_rgb(pixels, width, height)
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListImagesQuery {
    folder: String,
    recursive: Option<bool>,
}

async fn list_images_handler(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Query(q): Query<ListImagesQuery>,
) -> Response {
    with_auth(&ctx, &headers, async {
        let settings = load_settings(ctx.app.clone()).unwrap_or_default();
        let folder = validate_library_path(&q.folder, &settings)?;
        let list = if q.recursive.unwrap_or(false) {
            file_management::list_images_recursive(
                folder.to_string_lossy().to_string(),
                ctx.app.clone(),
            )
        } else {
            file_management::list_images_in_dir(
                folder.to_string_lossy().to_string(),
                ctx.app.clone(),
            )
        }
        .map_err(|e| ApiErrorBody::new("list_failed", e))?;
        Ok(json!({ "images": list }))
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenImageBody {
    path: String,
}

async fn open_image_handler(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Json(body): Json<OpenImageBody>,
) -> Response {
    with_auth(&ctx, &headers, async {
        let settings = load_settings(ctx.app.clone()).unwrap_or_default();
        validate_library_path(&body.path, &settings)?;
        dispatch_bridge_action(&ctx.app, "open_image", json!({ "path": body.path })).await
    })
    .await
}

async fn next_image_handler(State(ctx): State<AppCtx>, headers: HeaderMap) -> Response {
    with_auth(&ctx, &headers, async {
        dispatch_bridge_action(&ctx.app, "next_image", json!({})).await
    })
    .await
}

async fn previous_image_handler(State(ctx): State<AppCtx>, headers: HeaderMap) -> Response {
    with_auth(&ctx, &headers, async {
        dispatch_bridge_action(&ctx.app, "previous_image", json!({})).await
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetadataQuery {
    path: String,
}

async fn metadata_handler(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Query(q): Query<MetadataQuery>,
) -> Response {
    with_auth(&ctx, &headers, async {
        let settings = load_settings(ctx.app.clone()).unwrap_or_default();
        validate_library_path(&q.path, &settings)?;
        let meta: ImageMetadata = file_management::load_metadata(q.path, ctx.app.clone())
            .map_err(|e| ApiErrorBody::new("metadata_error", e))?;
        Ok(serde_json::to_value(meta).unwrap())
    })
    .await
}

async fn list_presets_handler(State(ctx): State<AppCtx>, headers: HeaderMap) -> Response {
    with_auth(&ctx, &headers, async {
        dispatch_bridge_action(&ctx.app, "list_presets", json!({})).await
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyPresetBody {
    name: String,
}

async fn apply_preset_handler(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Json(body): Json<ApplyPresetBody>,
) -> Response {
    with_auth(&ctx, &headers, async {
        dispatch_bridge_action(&ctx.app, "apply_preset", json!({ "name": body.name })).await
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavePresetBody {
    name: String,
}

async fn save_preset_handler(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Json(body): Json<SavePresetBody>,
) -> Response {
    with_auth(&ctx, &headers, async {
        dispatch_bridge_action(&ctx.app, "save_preset", json!({ "name": body.name })).await
    })
    .await
}

const MAX_PRESET_DOWNLOAD_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportPresetsBody {
    /// Absolute local preset file paths (.rrpreset / .xmp / .lrtemplate / .json).
    #[serde(default)]
    paths: Vec<String>,
    /// HTTPS URL to a preset file to download and import.
    #[serde(default)]
    url: Option<String>,
}

async fn import_presets_handler(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Json(body): Json<ImportPresetsBody>,
) -> Response {
    with_auth(&ctx, &headers, async {
        let mut paths: Vec<String> = Vec::new();
        let mut temp_files: Vec<tempfile::NamedTempFile> = Vec::new();

        if let Some(url) = body.url.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            let tmp = download_preset_url(url).await?;
            paths.push(tmp.path().to_string_lossy().to_string());
            temp_files.push(tmp);
        }

        for p in &body.paths {
            let canonical = validate_preset_file_path(p)?;
            paths.push(canonical.to_string_lossy().to_string());
        }

        if paths.is_empty() {
            return Err(ApiErrorBody::new(
                "invalid_request",
                "Provide at least one of: paths[] (local files) or url (https download)",
            ));
        }

        let result = file_management::handle_import_presets_from_files(paths.clone(), ctx.app.clone())
            .map_err(|e| ApiErrorBody::new("import_failed", e))?;

        // Keep temps alive until import completes.
        drop(temp_files);

        let names: Vec<String> = result
            .presets
            .iter()
            .filter_map(|item| match item {
                file_management::PresetItem::Preset(p) => Some(p.name.clone()),
                file_management::PresetItem::Folder(f) => Some(format!("[folder] {}", f.name)),
            })
            .collect();

        Ok(json!({
            "importedFrom": paths,
            "failureCount": result.failures.len(),
            "failures": result.failures,
            "presetNames": names,
        }))
    })
    .await
}

async fn download_preset_url(url: &str) -> Result<tempfile::NamedTempFile, ApiErrorBody> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|e| ApiErrorBody::new("invalid_url", format!("Invalid URL: {e}")))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(ApiErrorBody::new(
            "invalid_url",
            "Only http(s) URLs are allowed for preset download",
        ));
    }
    if let Some(host) = parsed.host_str() {
        let h = host.to_ascii_lowercase();
        if h == "localhost"
            || h == "127.0.0.1"
            || h == "0.0.0.0"
            || h == "::1"
            || h.ends_with(".local")
            || h.starts_with("10.")
            || h.starts_with("192.168.")
            || h.starts_with("169.254.")
        {
            return Err(ApiErrorBody::new(
                "url_forbidden",
                "Refusing to download presets from private/local hosts",
            ));
        }
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent("RapidRAW-ExternalControl/1.0")
        .build()
        .map_err(|e| ApiErrorBody::new("download_failed", e.to_string()))?;

    let response = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| ApiErrorBody::new("download_failed", format!("Download failed: {e}")))?;

    if !response.status().is_success() {
        return Err(ApiErrorBody::new(
            "download_failed",
            format!("HTTP {}", response.status()),
        ));
    }

    if let Some(len) = response.content_length() {
        if len > MAX_PRESET_DOWNLOAD_BYTES {
            return Err(ApiErrorBody::new(
                "download_too_large",
                format!("Preset download exceeds {MAX_PRESET_DOWNLOAD_BYTES} bytes"),
            ));
        }
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| ApiErrorBody::new("download_failed", e.to_string()))?;
    if bytes.len() as u64 > MAX_PRESET_DOWNLOAD_BYTES {
        return Err(ApiErrorBody::new(
            "download_too_large",
            format!("Preset download exceeds {MAX_PRESET_DOWNLOAD_BYTES} bytes"),
        ));
    }

    let suffix = if url.to_ascii_lowercase().contains(".xmp") {
        ".xmp"
    } else if url.to_ascii_lowercase().contains(".lrtemplate") {
        ".lrtemplate"
    } else if url.to_ascii_lowercase().contains(".json") {
        ".json"
    } else {
        ".rrpreset"
    };

    let mut tmp = tempfile::Builder::new()
        .prefix("rapidraw-preset-")
        .suffix(suffix)
        .tempfile()
        .map_err(|e| ApiErrorBody::new("download_failed", e.to_string()))?;
    use std::io::Write;
    tmp.write_all(&bytes)
        .map_err(|e| ApiErrorBody::new("download_failed", e.to_string()))?;
    tmp.flush()
        .map_err(|e| ApiErrorBody::new("download_failed", e.to_string()))?;
    Ok(tmp)
}

async fn list_community_presets_handler(State(ctx): State<AppCtx>, headers: HeaderMap) -> Response {
    with_auth(&ctx, &headers, async {
        let presets = crate::fetch_community_presets_impl()
            .await
            .map_err(|e| ApiErrorBody::new("community_fetch_failed", e))?;
        let summary: Vec<Value> = presets
            .into_iter()
            .map(|p| {
                json!({
                    "name": p.name,
                    "creator": p.creator,
                    "includeMasks": p.include_masks,
                    "includeCropTransform": p.include_crop_transform,
                })
            })
            .collect();
        Ok(json!({ "presets": summary }))
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportCommunityPresetBody {
    name: String,
}

async fn import_community_preset_handler(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Json(body): Json<ImportCommunityPresetBody>,
) -> Response {
    with_auth(&ctx, &headers, async {
        let name = body.name.trim();
        if name.is_empty() {
            return Err(ApiErrorBody::new("invalid_request", "name is required"));
        }
        let presets = crate::fetch_community_presets_impl()
            .await
            .map_err(|e| ApiErrorBody::new("community_fetch_failed", e))?;
        let preset = presets
            .into_iter()
            .find(|p| p.name.eq_ignore_ascii_case(name))
            .ok_or_else(|| {
                ApiErrorBody::new(
                    "not_found",
                    format!(
                        "Community preset '{name}' not found. Call GET /v1/presets/community first."
                    ),
                )
            })?;

        file_management::save_community_preset(
            preset.name.clone(),
            preset.adjustments,
            ctx.app.clone(),
            preset.include_masks,
            preset.include_crop_transform,
            Some("style".to_string()),
        )
        .map_err(|e| ApiErrorBody::new("import_failed", e))?;

        Ok(json!({
            "name": preset.name,
            "creator": preset.creator,
            "imported": true,
        }))
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RateBody {
    path: Option<String>,
    rating: i8,
}

async fn rate_handler(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Json(body): Json<RateBody>,
) -> Response {
    with_auth(&ctx, &headers, async {
        let settings = load_settings(ctx.app.clone()).unwrap_or_default();
        let paths: Vec<String> = if let Some(p) = body.path {
            validate_library_path(&p, &settings)?;
            vec![p]
        } else {
            let ec = external_control_state(&ctx.app);
            let inner = ec
                .lock()
                .map_err(|e| ApiErrorBody::new("internal_error", format!("Lock error: {e}")))?;
            if inner.session.selected_paths.is_empty() {
                return Err(ApiErrorBody::new(
                    "no_selection",
                    "Provide path or select images in the library",
                ));
            }
            inner.session.selected_paths.clone()
        };
        if body.rating < 0 || body.rating > 5 {
            return Err(ApiErrorBody::new(
                "invalid_rating",
                "Rating must be between 0 and 5",
            ));
        }
        file_management::set_rating_for_paths(paths, body.rating as u8, ctx.app.clone())
            .map_err(|e| ApiErrorBody::new("rating_failed", e))?;
        Ok(json!({ "rating": body.rating }))
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ColorLabelBody {
    path: Option<String>,
    label: String,
}

async fn color_label_handler(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Json(body): Json<ColorLabelBody>,
) -> Response {
    with_auth(&ctx, &headers, async {
        let settings = load_settings(ctx.app.clone()).unwrap_or_default();
        let paths: Vec<String> = if let Some(p) = body.path {
            validate_library_path(&p, &settings)?;
            vec![p]
        } else {
            let ec = external_control_state(&ctx.app);
            let inner = ec
                .lock()
                .map_err(|e| ApiErrorBody::new("internal_error", format!("Lock error: {e}")))?;
            inner.session.selected_paths.clone()
        };
        let label_raw = body.label.clone();
        let label = if label_raw.is_empty() {
            None
        } else {
            Some(label_raw.clone())
        };
        file_management::set_color_label_for_paths(paths, label, ctx.app.clone())
            .map_err(|e| ApiErrorBody::new("color_label_failed", e))?;
        Ok(json!({ "label": label_raw }))
    })
    .await
}

async fn copy_adjustments_handler(State(ctx): State<AppCtx>, headers: HeaderMap) -> Response {
    with_auth(&ctx, &headers, async {
        dispatch_bridge_action(&ctx.app, "copy_adjustments", json!({})).await
    })
    .await
}

async fn paste_adjustments_handler(State(ctx): State<AppCtx>, headers: HeaderMap) -> Response {
    with_auth(&ctx, &headers, async {
        dispatch_bridge_action(&ctx.app, "paste_adjustments", json!({})).await
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyAdjustmentsToBody {
    paths: Vec<String>,
}

async fn apply_adjustments_to_handler(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Json(body): Json<ApplyAdjustmentsToBody>,
) -> Response {
    with_auth(&ctx, &headers, async {
        let settings = load_settings(ctx.app.clone()).unwrap_or_default();
        for path in &body.paths {
            validate_library_path(path, &settings)?;
        }
        dispatch_bridge_action(
            &ctx.app,
            "apply_adjustments_to_images",
            json!({ "paths": body.paths }),
        )
        .await
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportBody {
    path: Option<String>,
    output_path: String,
    format: Option<String>,
    quality: Option<u8>,
}

async fn export_handler(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Json(body): Json<ExportBody>,
) -> Response {
    with_auth(&ctx, &headers, async {
        export_one_or_many(
            &ctx,
            body.path.map(|p| vec![p]),
            body.output_path,
            body.format,
            body.quality,
            false,
        )
        .await
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportBatchBody {
    paths: Vec<String>,
    output_folder: String,
    format: Option<String>,
    quality: Option<u8>,
}

async fn export_batch_handler(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Json(body): Json<ExportBatchBody>,
) -> Response {
    with_auth(&ctx, &headers, async {
        export_one_or_many(
            &ctx,
            Some(body.paths),
            body.output_folder,
            body.format,
            body.quality,
            true,
        )
        .await
    })
    .await
}

async fn export_one_or_many(
    ctx: &AppCtx,
    paths: Option<Vec<String>>,
    output: String,
    format: Option<String>,
    quality: Option<u8>,
    batch_folder: bool,
) -> Result<Value, ApiErrorBody> {
    let settings = load_settings(ctx.app.clone()).unwrap_or_default();

    let paths = if let Some(mut p) = paths {
        for path in &p {
            validate_library_path(path, &settings)?;
        }
        p
    } else {
        let ec = external_control_state(&ctx.app);
        let inner = ec
            .lock()
            .map_err(|e| ApiErrorBody::new("internal_error", format!("Lock error: {e}")))?;
        let Some(path) = inner.session.current_image_path.clone() else {
            return Err(ApiErrorBody::new("no_image", "No image to export"));
        };
        vec![path]
    };

    if batch_folder {
        validate_library_path(&output, &settings)?;
    } else {
        validate_output_path(&output, &settings)?;
    }

    let export_settings = ExportSettings {
        jpeg_quality: quality.unwrap_or(92),
        tiff_bit_depth: TiffBitDepth::Eight,
        resize: None,
        border: None,
        pad: None,
        keep_metadata: true,
        preserve_timestamps: true,
        strip_gps: false,
        filename_template: None,
        watermark: None,
        export_masks: false,
        preserve_folders: !batch_folder,
        destination_type: None,
        subfolder: None,
    };

    let state = ctx.app.state::<AppState>();
    export_images_impl(
        paths.clone(),
        output.clone(),
        !batch_folder,
        settings.root_folders.clone(),
        export_settings,
        format.unwrap_or_else(|| "jpeg".to_string()),
        ExportAdjustmentsMode::UseSidecars {
            active_path: None,
            active_adjustments: None,
        },
        state,
        ctx.app.clone(),
        None,
    )
    .await
    .map_err(|e| ApiErrorBody::new("export_failed", e))?;

    Ok(json!({
        "paths": paths,
        "output": output,
    }))
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiMaskBox {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MasksAiBody {
    #[serde(rename = "type")]
    mask_type: String,
    #[serde(default)]
    r#box: Option<AiMaskBox>,
}

async fn masks_ai_handler(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Json(body): Json<MasksAiBody>,
) -> Response {
    with_auth(&ctx, &headers, async {
        let mask_type = body.mask_type.to_lowercase();
        match mask_type.as_str() {
            "sky" | "foreground" | "subject" | "depth" => {}
            _ => {
                return Err(ApiErrorBody::new(
                    "invalid_type",
                    "type must be sky|foreground|subject|depth",
                ));
            }
        }
        if mask_type == "subject" && body.r#box.is_none() {
            return Err(ApiErrorBody::new(
                "box_required",
                "subject mask requires box: {x,y,w,h} normalized 0-1",
            ));
        }
        let params = json!({
            "type": mask_type,
            "box": body.r#box,
        });
        dispatch_bridge_action_timed(&ctx.app, "generate_ai_mask", params, AI_BRIDGE_TIMEOUT_SECS)
            .await
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MasksAdjustBody {
    mask_id: Option<String>,
    adjustments: Value,
}

async fn masks_adjust_handler(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Json(body): Json<MasksAdjustBody>,
) -> Response {
    with_auth(&ctx, &headers, async {
        if !body.adjustments.is_object() {
            return Err(ApiErrorBody::new(
                "invalid_adjustments",
                "adjustments must be an object of key/value pairs",
            ));
        }
        dispatch_bridge_action(
            &ctx.app,
            "adjust_mask",
            json!({
                "maskId": body.mask_id,
                "adjustments": body.adjustments,
            }),
        )
        .await
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiEraseBody {
    mode: String,
    prompt: Option<String>,
    mask_id: Option<String>,
}

async fn ai_erase_handler(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Json(body): Json<AiEraseBody>,
) -> Response {
    with_auth(&ctx, &headers, async {
        let mode = body.mode.to_lowercase();
        if mode != "quick" && mode != "generative" {
            return Err(ApiErrorBody::new(
                "invalid_mode",
                "mode must be quick|generative",
            ));
        }
        dispatch_bridge_action_timed(
            &ctx.app,
            "ai_erase",
            json!({
                "mode": mode,
                "prompt": body.prompt,
                "maskId": body.mask_id,
            }),
            AI_BRIDGE_TIMEOUT_SECS,
        )
        .await
    })
    .await
}

async fn ai_status_handler(State(ctx): State<AppCtx>, headers: HeaderMap) -> Response {
    with_auth(&ctx, &headers, async {
        let settings = load_settings(ctx.app.clone()).unwrap_or_default();
        let models_dir = ctx.app.path().app_data_dir().ok().map(|d| d.join("models"));
        let present = |name: &str| {
            models_dir
                .as_ref()
                .map(|d| d.join(name).is_file())
                .unwrap_or(false)
        };

        let connector_connected = if let Some(address) = &settings.ai_connector_address {
            ai_connector::check_status(address).await.unwrap_or(false)
        } else {
            false
        };

        let provider = settings
            .ai_provider
            .clone()
            .unwrap_or_else(|| "cpu".to_string());
        let cloud = provider == "cloud";
        let sky = present("skyseg_u2net.onnx") || present("skyseg-u2net.onnx");
        let foreground = present("u2net.onnx");
        let subject =
            present("sam_vit_b_01ec64_encoder.onnx") && present("sam_vit_b_01ec64_decoder.onnx");
        let depth = present("depth_anything_v2_vits.onnx");
        let lama = present("lama_fp16.onnx");
        let denoise = present("nind_denoise_utnet_684.onnx");

        Ok(json!({
            "provider": provider,
            "connectorAddress": settings.ai_connector_address,
            "connectorConnected": connector_connected,
            "cloudAvailable": cloud,
            "models": {
                "sky": sky,
                "foreground": foreground,
                "subject": subject,
                "depth": depth,
                "lama": lama,
                "denoise": denoise,
            },
            "quickEraseReady": lama,
            "generativeReady": cloud || connector_connected,
            "cpuOnnxReady": sky || foreground || subject || depth || lama || denoise,
        }))
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiDenoiseBody {
    method: Option<String>,
    intensity: Option<f64>,
    path: Option<String>,
}

async fn ai_denoise_handler(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Json(body): Json<AiDenoiseBody>,
) -> Response {
    with_auth(&ctx, &headers, async {
        dispatch_bridge_action_timed(
            &ctx.app,
            "ai_denoise",
            json!({
                "method": body.method.unwrap_or_else(|| "ai".to_string()),
                "intensity": body.intensity.unwrap_or(50.0),
                "path": body.path,
            }),
            AI_BRIDGE_TIMEOUT_SECS,
        )
        .await
    })
    .await
}
