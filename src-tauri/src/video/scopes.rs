use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::app::settings::load_settings;
use crate::app::state::{AnalyticsConfig, AppState};
use crate::render::gpu::compute::{self, PerDevice, Slot};
use crate::render::gpu::context::GpuContext;
use crate::render::gpu::processor::{
    AnalyticsReadback, ReadbackPool, analytics_readback_sender, copy_to_readback,
};
use crate::video::compose::{self, Placement};
use crate::video::engine::FrameSettings;

const SCOPE_LONGEST: u32 = 1024;
const HALF_FLOAT_BYTES: u32 = 8;
pub const PLAYBACK_INTERVAL: Duration = Duration::from_millis(200);

static POOL: Mutex<PerDevice<ReadbackPool>> = Mutex::new(PerDevice::new());

fn pool(context: &GpuContext) -> ReadbackPool {
    Arc::clone(
        POOL.lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_or_insert_with(context, ReadbackPool::default),
    )
}

pub fn send(
    app_handle: &AppHandle,
    context: &GpuContext,
    frame: &Slot,
    settings: &FrameSettings,
    path: &str,
    playing: bool,
) {
    let Some(sender) = app_handle
        .state::<AppState>()
        .analytics_worker_tx
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
    else {
        return;
    };
    let app_settings = load_settings(app_handle.clone()).unwrap_or_default();
    let space = settings.output_space.unwrap_or_default();
    let headroom = settings.headroom.unwrap_or_default();
    let scale = (SCOPE_LONGEST as f32 / frame.size.0.max(frame.size.1) as f32).min(1.0);
    let size = (
        ((frame.size.0 as f32 * scale).round() as u32).max(1),
        ((frame.size.1 as f32 * scale).round() as u32).max(1),
    );
    let pool = pool(context);
    let copied = compute::encode(context, |enc| {
        let clear = compose::fill(enc, size, [0.0; 4]);
        let small = compose::composite(enc, &clear, frame, &Placement::fit(size, frame.size));
        copy_to_readback(
            enc.device,
            &pool,
            &mut enc.encoder,
            &small.texture,
            (0, 0),
            size,
            HALF_FLOAT_BYTES,
        )
    });
    let (buffer, row_stride) = match copied {
        Ok(copied) => copied,
        Err(e) => {
            log::warn!("Video scopes skipped: {}", e);
            return;
        }
    };
    let _ = analytics_readback_sender().send(AnalyticsReadback {
        device: Arc::clone(&context.device),
        buffer,
        pool,
        submission: context.queue.submit([]),
        analytics: AnalyticsConfig {
            path: path.to_string(),
            compute_waveform: app_settings.is_waveform_visible.unwrap_or(false),
            active_waveform_channel: app_settings.active_waveform_channel.filter(|_| playing),
            sender,
            space,
        },
        width: size.0,
        height: size.1,
        row_stride,
        half_float: true,
        peak: if headroom.is_hdr() {
            space.curve().encode(headroom.ratio())
        } else {
            1.0
        },
    });
}
