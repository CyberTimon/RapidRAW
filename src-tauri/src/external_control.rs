//! External control server.
//!
//! Lets a hardware controller (e.g. a Logitech MX Creative Console plugin) drive the
//! editor live. The server listens on the loopback interface only and speaks
//! newline-delimited JSON in both directions:
//!
//! * client → RapidRAW: every line is forwarded verbatim to the frontend as the
//!   `external-control-command` Tauri event. The frontend owns the adjustment state,
//!   so it is the frontend that interprets `set` / `adjust` / `action` / ... messages.
//! * RapidRAW → client: the frontend publishes state snapshots through the
//!   `external_control_publish` command; they are broadcast to every connected
//!   client. A fresh client immediately receives a `hello` line and the most recent
//!   `state` snapshot (if any).
//!
//! The message vocabulary is documented in `docs/EXTERNAL_CONTROL_API.md`.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, EventTarget, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;

pub const PROTOCOL_VERSION: u32 = 1;
pub const DEFAULT_PORT: u16 = 47820;
pub const COMMAND_EVENT: &str = "external-control-command";
pub const CLIENTS_EVENT: &str = "external-control-clients";
/// Label of the editor window, as created in `lib.rs`.
const MAIN_WINDOW_LABEL: &str = "main";

/// Upper bound on a single incoming line. Anything larger is dropped and the
/// connection closed; a controller never needs more than a few hundred bytes.
const MAX_LINE_BYTES: usize = 64 * 1024;

pub struct ExternalControlState {
    /// Lines to be written to every connected client.
    tx: broadcast::Sender<String>,
    /// Most recent `state` snapshot published by the frontend, replayed to new clients.
    last_state: Mutex<Option<String>>,
    clients: AtomicUsize,
    port: Mutex<Option<u16>>,
    /// Monotonic id stamped on every forwarded command so the webview can drop
    /// a duplicate delivery (Tauri fans `emit` out per event target).
    seq: AtomicU64,
}

impl ExternalControlState {
    pub fn new() -> Self {
        let (tx, _rx) = broadcast::channel(256);
        Self {
            tx,
            last_state: Mutex::new(None),
            clients: AtomicUsize::new(0),
            port: Mutex::new(None),
            seq: AtomicU64::new(0),
        }
    }

    fn broadcast(&self, line: String) {
        // Errors only mean "no receivers", which is fine.
        let _ = self.tx.send(line);
    }
}

impl Default for ExternalControlState {
    fn default() -> Self {
        Self::new()
    }
}

fn hello_line(app_handle: &AppHandle) -> String {
    let version = app_handle.package_info().version.to_string();
    json!({
        "type": "hello",
        "app": "RapidRAW",
        "version": version,
        "protocol": PROTOCOL_VERSION,
    })
    .to_string()
}

/// Binds the loopback listener and starts accepting clients. Never panics; a port
/// clash is logged and the app keeps running without external control.
pub fn start(app_handle: AppHandle, port: u16) {
    tauri::async_runtime::spawn(async move {
        let addr = format!("127.0.0.1:{}", port);
        let listener = match TcpListener::bind(&addr).await {
            Ok(l) => l,
            Err(e) => {
                log::warn!("External control: could not bind {}: {}", addr, e);
                return;
            }
        };
        {
            let state = app_handle.state::<ExternalControlState>();
            *state.port.lock().unwrap() = Some(port);
        }
        log::info!("External control: listening on {}", addr);

        loop {
            match listener.accept().await {
                Ok((stream, peer)) => {
                    // Belt and braces: the bind is loopback-only, but never serve a
                    // non-loopback peer even if that changes.
                    if !peer.ip().is_loopback() {
                        log::warn!("External control: rejected non-loopback peer {}", peer);
                        continue;
                    }
                    let app = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        handle_client(app, stream).await;
                    });
                }
                Err(e) => {
                    log::warn!("External control: accept failed: {}", e);
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
        }
    });
}

fn emit_client_count(app_handle: &AppHandle, count: usize) {
    let _ = app_handle.emit(CLIENTS_EVENT, count);
}

async fn handle_client(app_handle: AppHandle, stream: TcpStream) {
    let _ = stream.set_nodelay(true);
    let (read_half, mut write_half) = stream.into_split();

    let state = app_handle.state::<ExternalControlState>();
    let mut rx = state.tx.subscribe();
    let count = state.clients.fetch_add(1, Ordering::SeqCst) + 1;
    log::info!("External control: client connected ({} total)", count);
    emit_client_count(&app_handle, count);

    // Greeting + replay of the latest snapshot.
    let mut greeting = hello_line(&app_handle);
    greeting.push('\n');
    if let Some(snapshot) = state.last_state.lock().unwrap().clone() {
        greeting.push_str(&snapshot);
        greeting.push('\n');
    }
    if write_half.write_all(greeting.as_bytes()).await.is_err() {
        finish_client(&app_handle);
        return;
    }

    // Writer task: forwards broadcast lines to this socket.
    let writer = tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(mut line) => {
                    line.push('\n');
                    if write_half.write_all(line.as_bytes()).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    log::debug!("External control: client lagged, dropped {} messages", n);
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // Reader loop: each line becomes a frontend event.
    let mut reader = BufReader::new(read_half);
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line).await;
        match read {
            Ok(0) => break,
            Ok(n) if n > MAX_LINE_BYTES => {
                log::warn!("External control: oversized message, closing client");
                break;
            }
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(trimmed) {
                    Ok(msg) => {
                        // `ping` is answered here so a client can probe liveness
                        // even before the webview is up.
                        if msg.get("type").and_then(Value::as_str) == Some("ping") {
                            let mut pong = json!({ "type": "pong" });
                            if let Some(r) = msg.get("ref") {
                                pong["ref"] = r.clone();
                            }
                            state.broadcast(pong.to_string());
                            continue;
                        }
                        let mut msg = msg;
                        if let Some(obj) = msg.as_object_mut() {
                            let seq = state.seq.fetch_add(1, Ordering::SeqCst) + 1;
                            obj.insert("_seq".to_string(), json!(seq));
                        }
                        // Target the main webview window explicitly: a plain `emit`
                        // goes to every event target and a global JS `listen` can
                        // then see the same command twice.
                        let target = EventTarget::webview_window(MAIN_WINDOW_LABEL);
                        if let Err(e) = app_handle.emit_to(target, COMMAND_EVENT, msg) {
                            log::warn!("External control: failed to emit command: {}", e);
                        }
                    }
                    Err(e) => {
                        state.broadcast(
                            json!({
                                "type": "error",
                                "message": format!("invalid JSON: {}", e),
                            })
                            .to_string(),
                        );
                    }
                }
            }
            Err(e) => {
                log::debug!("External control: read error: {}", e);
                break;
            }
        }
    }

    writer.abort();
    finish_client(&app_handle);
}

fn finish_client(app_handle: &AppHandle) {
    let state = app_handle.state::<ExternalControlState>();
    let count = state.clients.fetch_sub(1, Ordering::SeqCst).saturating_sub(1);
    log::info!("External control: client disconnected ({} total)", count);
    emit_client_count(app_handle, count);
}

/// Called by the frontend to push a message to every connected controller.
/// `state` messages are also cached for replay to late-joining clients.
#[tauri::command]
pub fn external_control_publish(
    message: Value,
    state: tauri::State<ExternalControlState>,
) -> Result<(), String> {
    let line = message.to_string();
    if message.get("type").and_then(Value::as_str) == Some("state") {
        *state.last_state.lock().unwrap() = Some(line.clone());
    }
    state.broadcast(line);
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalControlStatus {
    pub listening: bool,
    pub port: Option<u16>,
    pub clients: usize,
    pub protocol: u32,
}

#[tauri::command]
pub fn external_control_status(state: tauri::State<ExternalControlState>) -> ExternalControlStatus {
    let port = *state.port.lock().unwrap();
    ExternalControlStatus {
        listening: port.is_some(),
        port,
        clients: state.clients.load(Ordering::SeqCst),
        protocol: PROTOCOL_VERSION,
    }
}
