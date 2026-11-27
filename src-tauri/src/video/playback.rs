use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex};
use std::time::{Duration, Instant};

use image::{DynamicImage, ImageBuffer, Rgb, Rgb32FImage, RgbImage, RgbaImage};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody, JavaScriptChannelId, Response};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::app::settings::load_settings;
use crate::decode::avif::ContainerColor;
use crate::decode::image_loader::container_image_to_working;
use crate::export::encode::encode_image_to_bytes;
use crate::export::settings::ExportSettings;
use crate::platform::viewer_window;
use crate::render::gpu::compute::Slot;
use crate::render::gpu::context::GpuContext;
use crate::render::gpu::display::{self, display_content_key};
use crate::render::gpu::processor::RenderOutputPrecision;
use crate::video::commands::{FrameSize, encode_filmstrip, install_image};
use crate::video::compose::{Packing, pack};
use crate::video::engine::decode::PREEMPTED;
use crate::video::engine::{FrameSettings, canvas_for};
use crate::video::frames::wide_samples;
use crate::video::model::{Item, LookJson, VideoProject};
use crate::video::revisions::Revision;
use crate::video::{VideoState, blocking, crash_safe, reverse, scopes, timelapse};

const STOP_POLL: Duration = Duration::from_millis(10);
const PREFETCH_SECONDS: f64 = 1.0;
const SWITCH_SECONDS: f64 = 0.2;
const START_WAIT: Duration = Duration::from_secs(1);
const GPU_FRAME_WAIT: Duration = Duration::from_secs(1);
const ADAPT_WINDOW_SECONDS: f64 = 0.5;
const ADAPT_DROP_RATIO: f64 = 0.25;
const ADAPT_STEP: f64 = 0.75;
const RAISE_LOAD: f64 = 0.7;
const MAX_RAISE_WINDOWS: u32 = 8;
const SETTLE_WINDOWS: u32 = 8;
const MIN_PLAYBACK_SIDE: u32 = 640;

static PLAYBACK_LEVELS: LazyLock<Mutex<HashMap<String, i32>>> = LazyLock::new(Default::default);
const CRASHED: &str = "Video playback crashed";
const MAP_WAITS: usize = 1;
const SEQ_HEADER: &str = "playback-seq";
const CHANNEL_HEADER: &str = "playback-channel";
const REVISION_HEADER: &str = "playback-revision";
const MISSING_REVISION: &str = "Missing project revision";
const FRAME_JPEG_QUALITY: u8 = 95;
const NEEDS_GPU_RENDERER: &str = "Video editing needs the GPU renderer";

#[derive(Default)]
struct Updates {
    base: u64,
    timeline: Option<Timeline>,
    timeline_seq: u64,
    looks: HashMap<String, (u64, LookJson)>,
    changed: HashSet<String>,
    started: bool,
}

impl Updates {
    fn new(seq: u64) -> Self {
        Self {
            base: seq,
            timeline_seq: seq,
            ..Self::default()
        }
    }

    fn add(&mut self, update: PlaybackUpdate, revision: Option<Arc<Revision>>) {
        let seq = update.seq;
        if seq < self.base {
            return;
        }
        let timeline = update
            .timeline
            .zip(revision)
            .map(|(timeline, revision)| timeline.on(revision));
        if let Some(timeline) = timeline.filter(|_| seq > self.timeline_seq) {
            self.timeline = Some(timeline);
            self.timeline_seq = seq;
            self.looks.retain(|_, (at, _)| *at > seq);
        }
        for (id, look) in update.looks {
            if seq > self.timeline_seq && self.looks.get(&id).is_none_or(|(at, _)| seq > *at) {
                self.changed.insert(id.clone());
                self.looks.insert(id, (seq, look));
            }
        }
        self.started |= update.started;
    }

    fn take(&mut self) -> (Option<Timeline>, Vec<(String, LookJson)>) {
        let timeline = self.timeline.take();
        let changed = std::mem::take(&mut self.changed);
        let looks = self
            .looks
            .iter()
            .filter(|(id, _)| timeline.is_some() || changed.contains(*id))
            .map(|(id, (_, look))| (id.clone(), look.clone()))
            .collect();
        (timeline, looks)
    }
}

struct Live {
    updates: Mutex<Updates>,
    started: Condvar,
}

pub struct Playback {
    stop: Arc<AtomicBool>,
    live: Arc<Live>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ViewRequest {
    target_resolution: Option<u32>,
    content_path: String,
    #[serde(default)]
    title_keys: HashMap<String, String>,
    #[serde(default)]
    use_proxies: bool,
    #[serde(default)]
    look_overrides: HashMap<String, LookJson>,
    #[serde(default)]
    scope_path: Option<String>,
    #[serde(default)]
    adaptive: bool,
}

#[derive(Default)]
struct DropWindow {
    start: f64,
    frames: u32,
    drops: u32,
    busy: Vec<f64>,
    excused: bool,
}

impl DropWindow {
    fn typical_busy(&mut self) -> Option<f64> {
        let middle = self.busy.len() / 2;
        (!self.busy.is_empty()).then(|| *self.busy.select_nth_unstable_by(middle, f64::total_cmp).1)
    }
}

struct PlaybackSize {
    key: String,
    requested: u32,
    level: i32,
    adaptive: bool,
    budget: f64,
    window: DropWindow,
    clean: u32,
    patience: u32,
    probation: u32,
}

impl PlaybackSize {
    fn new(project: &VideoProject, view: &ViewRequest) -> Self {
        let (width, height) = canvas_for(project, view.target_resolution);
        let requested = width.max(height);
        let key = format!("{}@{}x{}", view.content_path, width, height);
        let level = PLAYBACK_LEVELS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&key)
            .copied()
            .filter(|_| view.adaptive)
            .unwrap_or(0);
        Self {
            key,
            requested,
            level,
            adaptive: view.adaptive,
            budget: 1.0 / project.fps(),
            window: DropWindow {
                excused: true,
                ..DropWindow::default()
            },
            clean: 0,
            patience: 1,
            probation: 0,
        }
    }

    fn side_at(&self, level: i32) -> u32 {
        ((self.requested as f64 * ADAPT_STEP.powi(level)).round() as u32)
            .max(MIN_PLAYBACK_SIDE)
            .min(self.requested)
    }

    fn side(&self) -> u32 {
        self.side_at(self.level)
    }

    fn roomiest(&self, busy: f64) -> Option<i32> {
        let side = self.side() as f64;
        (0..self.level).find(|level| {
            busy * (self.side_at(*level) as f64 / side).powi(2) < RAISE_LOAD * self.budget
        })
    }

    fn canvas(&self, project: &VideoProject) -> (u32, u32) {
        canvas_for(project, Some(self.side()))
    }

    fn excuse(&mut self, due: f64) {
        self.window = DropWindow {
            start: due,
            excused: true,
            ..DropWindow::default()
        };
    }

    fn adapted(&mut self, due: f64, busy: Option<f64>) -> bool {
        if !self.adaptive {
            return false;
        }
        self.window.frames += 1;
        match busy {
            Some(busy) => self.window.busy.push(busy),
            None => self.window.drops += 1,
        }
        if due - self.window.start < ADAPT_WINDOW_SECONDS {
            return false;
        }
        let mut window = std::mem::replace(
            &mut self.window,
            DropWindow {
                start: due,
                ..DropWindow::default()
            },
        );
        if window.excused {
            return false;
        }
        let typical = window.typical_busy();
        let overloaded = window.drops > 0 && typical.is_some_and(|busy| busy > self.budget);
        if overloaded || window.drops as f64 > ADAPT_DROP_RATIO * window.frames as f64 {
            self.clean = 0;
            if self.side() <= MIN_PLAYBACK_SIDE {
                return false;
            }
            if std::mem::take(&mut self.probation) > 0 {
                self.patience = (self.patience * 2).min(MAX_RAISE_WINDOWS);
            }
            self.level += 1;
        } else {
            if self.probation > 0 {
                self.probation -= 1;
                if self.probation == 0 {
                    self.patience = 1;
                }
            }
            let target = typical
                .filter(|_| window.drops == 0)
                .and_then(|busy| self.roomiest(busy));
            let Some(target) = target else {
                self.clean = 0;
                return false;
            };
            self.clean += 1;
            if self.clean < self.patience {
                return false;
            }
            self.clean = 0;
            self.probation = SETTLE_WINDOWS;
            self.level = target;
        }
        self.excuse(due);
        PLAYBACK_LEVELS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(self.key.clone(), self.level);
        true
    }
}

pub struct Timeline {
    revision: Arc<Revision>,
    end_time: f64,
    loop_start: Option<f64>,
    view: ViewRequest,
}

impl Timeline {
    fn project(&self) -> &VideoProject {
        &self.revision.project
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimelineRequest {
    end_time: f64,
    #[serde(default)]
    loop_start: Option<f64>,
    view: ViewRequest,
}

impl TimelineRequest {
    fn on(self, revision: Arc<Revision>) -> Timeline {
        Timeline {
            revision,
            end_time: self.end_time,
            loop_start: self.loop_start,
            view: self.view,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaybackRequest {
    start_time: f64,
    #[serde(flatten)]
    timeline: TimelineRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaybackUpdate {
    seq: u64,
    #[serde(default)]
    looks: HashMap<String, LookJson>,
    #[serde(default)]
    timeline: Option<TimelineRequest>,
    #[serde(default)]
    started: bool,
}

struct Timing {
    end: u64,
    loop_start: Option<u64>,
    cuts: Vec<u64>,
}

impl Timing {
    fn of(timeline: &Timeline) -> Self {
        let project = timeline.project();
        let end = project.frame_range(0.0, timeline.end_time).1;
        let mut cuts: Vec<u64> = project
            .video_tracks
            .iter()
            .flat_map(|track| &track.items)
            .filter_map(|item| match item {
                Item::Clip(clip) => Some(project.frame_of(clip.start)),
                _ => None,
            })
            .collect();
        cuts.sort_unstable();
        cuts.dedup();
        Self {
            end,
            loop_start: timeline
                .loop_start
                .map(|time| project.frame_at(time))
                .filter(|frame| *frame < end),
            cuts,
        }
    }

    fn upcoming(&self, frame: u64, count: u64) -> Vec<u64> {
        let mut at = frame;
        let mut found = Vec::new();
        for _ in 0..count {
            at += 1;
            if at >= self.end {
                let Some(start) = self.loop_start else {
                    break;
                };
                at = start;
            } else if self.cuts.binary_search(&at).is_err() {
                continue;
            }
            if !found.contains(&at) {
                found.push(at);
            }
        }
        found
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameRequest {
    revision: u64,
    time: f64,
    view: ViewRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StripRequest {
    revision: u64,
    count: u32,
    view: ViewRequest,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum PlaybackEvent<'a> {
    #[serde(rename_all = "camelCase")]
    Clip {
        item_id: &'a str,
        time: f64,
    },
    Started {
        time: f64,
    },
    Looped {
        time: f64,
    },
    Ended {
        time: f64,
    },
    Error {
        message: String,
    },
}

fn send_event(channel: &Channel, event: PlaybackEvent) {
    if let Ok(json) = serde_json::to_string(&event) {
        let _ = channel.send(InvokeResponseBody::Json(json));
    }
}

fn wait_until(started: Instant, due: f64, stop: &AtomicBool) -> bool {
    loop {
        if stop.load(Ordering::Relaxed) {
            return false;
        }
        let remaining = due - started.elapsed().as_secs_f64();
        if remaining <= 0.0 {
            return true;
        }
        std::thread::sleep(Duration::from_secs_f64(remaining).min(STOP_POLL));
    }
}

fn frame_settings(project: &VideoProject, view: &ViewRequest) -> FrameSettings {
    FrameSettings {
        canvas: canvas_for(project, view.target_resolution),
        output_space: None,
        headroom: None,
        precision: RenderOutputPrecision::EightBit,
        hwaccel: true,
        preview: true,
        use_proxies: view.use_proxies,
        title_keys: view.title_keys.clone(),
        look_overrides: view.look_overrides.clone(),
    }
}

fn preview_settings(
    app_handle: &AppHandle,
    context: &GpuContext,
    project: &VideoProject,
    view: &ViewRequest,
) -> Result<FrameSettings, String> {
    if !load_settings(app_handle.clone())
        .unwrap_or_default()
        .wgpu_renderer_enabled()
    {
        return Err(NEEDS_GPU_RENDERER.to_string());
    }
    let mut settings = frame_settings(project, view);
    follow_displays(&mut settings, context);
    Ok(settings)
}

fn follow_displays(settings: &mut FrameSettings, context: &GpuContext) {
    let (space, headroom) = display::frame_output(context);
    settings.output_space = Some(space);
    settings.headroom = Some(headroom);
    settings.precision = if headroom.is_hdr() {
        RenderOutputPrecision::Float
    } else {
        RenderOutputPrecision::EightBit
    };
}

fn present(
    app_handle: &AppHandle,
    context: &GpuContext,
    slot: &Slot,
    content_path: &str,
    viewer_epoch: u64,
) {
    let size = [slot.size.0 as f32, slot.size.1 as f32];
    if let Some(display) = context
        .display
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_mut()
    {
        display.show_owned_texture(
            &context.device,
            &context.queue,
            &slot.view,
            size,
            display_content_key(content_path),
        );
    }
    viewer_window::show_video_frame(app_handle, context, &slot.view, size, viewer_epoch);
}

fn frame_ready(app_handle: &AppHandle, content_path: &str) {
    let _ = app_handle.emit(
        "wgpu-frame-ready",
        serde_json::json!({ "path": content_path }),
    );
}

fn editor_item_at(project: &VideoProject, ticks: i64) -> Option<&str> {
    project
        .video_tracks
        .iter()
        .rev()
        .filter(|track| !track.hidden)
        .flat_map(|track| track.items.iter())
        .find_map(|item| match item {
            Item::Clip(clip) if ticks >= clip.start && ticks < clip.start + clip.duration => {
                Some(clip.id.as_str())
            }
            _ => None,
        })
}

fn play(
    app_handle: AppHandle,
    request: Vec<u8>,
    revision: Arc<Revision>,
    live: Arc<Live>,
    stop: Arc<AtomicBool>,
    channel: Channel,
) {
    let _busy = crate::video::busy();
    let viewer_epoch = viewer_window::video_epoch();
    let request = serde_json::from_slice::<PlaybackRequest>(&request).map_err(|e| e.to_string());
    let video = app_handle.state::<VideoState>();
    let result = crash_safe(CRASHED, || {
        let lease = {
            let _starting = Starting {
                video: &video,
                stop: &stop,
            };
            video.player(&app_handle, &stop)
        };
        let Some(mut engine) = lease? else {
            return Ok(());
        };
        let PlaybackRequest {
            start_time,
            timeline,
        } = request?;
        let mut timeline = timeline.on(revision);
        let mut output_revision = display::frame_output_revision();
        let mut frame_seconds = 1.0 / timeline.project().fps();
        let mut timing = Timing::of(&timeline);
        let mut settings = preview_settings(
            &app_handle,
            engine.context(),
            timeline.project(),
            &timeline.view,
        )?;
        let mut size = PlaybackSize::new(timeline.project(), &timeline.view);
        settings.canvas = size.canvas(timeline.project());
        let mut switch: Option<(u64, (u32, u32), bool)> = None;
        let mut prepared: (Vec<u64>, (u32, u32)) = (Vec::new(), settings.canvas);
        let mut clock: Option<Instant> = None;
        let mut frame = timeline.project().frame_at(start_time);
        let mut segment = (frame, 0.0);
        let mut looped = false;
        let mut shown_item: Option<String> = None;
        let mut scoped: Option<Instant> = None;
        let mut in_flight: Option<wgpu::SubmissionIndex> = None;
        loop {
            if stop.load(Ordering::Relaxed) {
                return Ok(());
            }
            let (update, looks) = live
                .updates
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
            if let Some(mut next) = update {
                next.view.content_path = std::mem::take(&mut timeline.view.content_path);
                let due = segment.1 + (frame - segment.0) as f64 * frame_seconds;
                let time = frame as f64 * frame_seconds;
                settings.title_keys = next.view.title_keys.clone();
                settings.look_overrides = next.view.look_overrides.clone();
                timeline = next;
                frame_seconds = 1.0 / timeline.project().fps();
                frame = timeline.project().frame_at(time);
                segment = (frame, due);
                timing = Timing::of(&timeline);
                let resized = PlaybackSize::new(timeline.project(), &timeline.view);
                if resized.key != size.key || resized.budget != size.budget {
                    size = resized;
                    switch = None;
                    settings.canvas = size.canvas(timeline.project());
                }
                size.excuse(due);
                prepared = (Vec::new(), (0, 0));
            }
            settings.look_overrides.extend(looks);
            if frame >= timing.end {
                let Some(loop_start) = timing.loop_start else {
                    break;
                };
                segment = (
                    loop_start,
                    segment.1 + timing.end.saturating_sub(segment.0) as f64 * frame_seconds,
                );
                frame = loop_start;
                looped = true;
                if let Some((_, _, waiting)) = switch.as_mut() {
                    *waiting = false;
                }
            }
            if let Some((at, canvas, false)) = switch
                && frame >= at
            {
                settings.canvas = canvas;
                switch = None;
            }
            let project = timeline.project();
            let due = segment.1 + (frame - segment.0) as f64 * frame_seconds;
            if clock.is_some_and(|clock| clock.elapsed().as_secs_f64() > due + frame_seconds)
                && frame + 1 < timing.end
            {
                if size.adapted(due, None) {
                    switch = Some(switch_at(
                        &timing,
                        frame,
                        frame_seconds,
                        size.canvas(project),
                    ));
                }
                frame += 1;
                continue;
            }
            let mut wanted =
                timing.upcoming(frame, (PREFETCH_SECONDS / frame_seconds).ceil() as u64);
            if let Some((at, _, _)) = switch
                && !wanted.contains(&at)
            {
                wanted.push(at);
            }
            let canvas = switch.map_or(settings.canvas, |(_, canvas, _)| canvas);
            prepared.0.retain(|at| wanted.contains(at));
            if clock.is_some()
                && (prepared.1 != canvas || wanted.iter().any(|at| !prepared.0.contains(at)))
            {
                let warm = FrameSettings {
                    canvas,
                    ..settings.clone()
                };
                match engine.prepare(project, &wanted, &warm, &video.titles) {
                    Ok(false) => {}
                    Ok(true) => prepared = (wanted, canvas),
                    Err(error) => {
                        log::warn!("Video prefetch failed: {}", error);
                        prepared = (wanted, canvas);
                    }
                }
            }
            let revision = display::frame_output_revision();
            let output_changed = revision != output_revision;
            if output_changed {
                output_revision = revision;
                follow_displays(&mut settings, engine.context());
            }
            let started = Instant::now();
            let loads = engine.media_loads();
            let slot = engine.render(project, frame, &settings, &video.titles)?;
            if engine.media_loads() != loads || looped || clock.is_none() || output_changed {
                size.excuse(due);
            }
            let waiting = Instant::now();
            if let Some(clock) = clock
                && !wait_until(clock, due, &stop)
            {
                return Ok(());
            }
            let idle = waiting.elapsed();
            present(
                &app_handle,
                engine.context(),
                &slot,
                &timeline.view.content_path,
                viewer_epoch,
            );
            let context = engine.context();
            let submitted = context.queue.submit([]);
            if let Some(previous) = in_flight.replace(submitted) {
                let _ = context.device.poll(wgpu::PollType::Wait {
                    submission_index: Some(previous),
                    timeout: Some(GPU_FRAME_WAIT),
                });
            }
            let busy = started.elapsed().saturating_sub(idle).as_secs_f64();
            let time = frame as f64 * frame_seconds;
            if clock.is_none() {
                frame_ready(&app_handle, &timeline.view.content_path);
                send_event(&channel, PlaybackEvent::Started { time });
                wait_for_start(&live, &stop);
                clock = Some(Instant::now());
            } else if std::mem::take(&mut looped) {
                send_event(&channel, PlaybackEvent::Looped { time });
            }
            if let Some(path) = &timeline.view.scope_path
                && scoped.is_none_or(|at| at.elapsed() >= scopes::PLAYBACK_INTERVAL)
            {
                scoped = Some(Instant::now());
                scopes::send(&app_handle, engine.context(), &slot, &settings, path, true);
            }
            let ticks = project.settings.fps.ticks_of(frame as i64);
            if let Some(item) = editor_item_at(project, ticks)
                && shown_item.as_deref() != Some(item)
            {
                shown_item = Some(item.to_string());
                send_event(
                    &channel,
                    PlaybackEvent::Clip {
                        item_id: item,
                        time,
                    },
                );
            }
            if size.adapted(due, Some(busy)) {
                switch = Some(switch_at(
                    &timing,
                    frame,
                    frame_seconds,
                    size.canvas(project),
                ));
            }
            frame += 1;
        }
        let finished = match clock {
            Some(clock) => wait_until(
                clock,
                segment.1 + timing.end.saturating_sub(segment.0) as f64 * frame_seconds,
                &stop,
            ),
            None => !stop.load(Ordering::Relaxed),
        };
        if finished {
            send_event(
                &channel,
                PlaybackEvent::Ended {
                    time: timing.end as f64 * frame_seconds,
                },
            );
        }
        Ok(())
    });
    if let Err(message) = result
        && !stop.load(Ordering::Relaxed)
    {
        log::error!("Video playback failed: {}", message);
        send_event(&channel, PlaybackEvent::Error { message });
        end(&video, &stop);
    }
}

fn wait_for_start(live: &Live, stop: &AtomicBool) {
    let updates = live.updates.lock().unwrap_or_else(|e| e.into_inner());
    let _ = live
        .started
        .wait_timeout_while(updates, START_WAIT, |updates| {
            !updates.started && !stop.load(Ordering::Relaxed)
        });
}

fn switch_at(
    timing: &Timing,
    frame: u64,
    frame_seconds: f64,
    canvas: (u32, u32),
) -> (u64, (u32, u32), bool) {
    let lead = (SWITCH_SECONDS / frame_seconds).ceil() as u64;
    let at = timing
        .upcoming(frame, lead)
        .first()
        .copied()
        .unwrap_or(frame + lead);
    (at, canvas, at <= frame)
}

fn playback(video: &VideoState) -> std::sync::MutexGuard<'_, Option<Playback>> {
    video.playback.lock().unwrap_or_else(|e| e.into_inner())
}

fn halt(playback: Playback) {
    playback.stop.store(true, Ordering::SeqCst);
    let _updates = playback
        .live
        .updates
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    playback.live.started.notify_all();
}

pub fn stop(video: &VideoState) {
    if let Some(playback) = playback(video).take() {
        halt(playback);
    }
}

struct Starting<'a> {
    video: &'a VideoState,
    stop: &'a Arc<AtomicBool>,
}

impl Drop for Starting<'_> {
    fn drop(&mut self) {
        let current = playback(self.video);
        if current
            .as_ref()
            .is_none_or(|playback| Arc::ptr_eq(&playback.stop, self.stop))
        {
            self.video.play_pending.store(false, Ordering::SeqCst);
        }
    }
}

fn end(video: &VideoState, stop: &Arc<AtomicBool>) {
    let mut current = playback(video);
    if current
        .as_ref()
        .is_some_and(|playback| Arc::ptr_eq(&playback.stop, stop))
        && let Some(playback) = current.take()
    {
        halt(playback);
    }
}

pub fn is_playing(video: &VideoState) -> bool {
    playback(video).is_some()
}

fn header_revision(
    request: &tauri::ipc::Request<'_>,
    video: &VideoState,
) -> Result<Option<Arc<Revision>>, String> {
    request
        .headers()
        .get(REVISION_HEADER)
        .map(|value| {
            let id = value
                .to_str()
                .ok()
                .and_then(|id| id.parse().ok())
                .ok_or(MISSING_REVISION)?;
            video.revisions.get(id)
        })
        .transpose()
}

#[tauri::command]
pub fn video_play(
    request: tauri::ipc::Request<'_>,
    webview: tauri::Webview,
    app_handle: AppHandle,
    video: State<'_, VideoState>,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected a raw playback request".to_string());
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
    };
    let seq = header(SEQ_HEADER)
        .and_then(|seq| seq.parse().ok())
        .ok_or("Missing playback sequence")?;
    let channel = header(CHANNEL_HEADER)
        .and_then(|id| id.parse::<JavaScriptChannelId>().ok())
        .ok_or("Missing playback channel")?
        .channel_on(webview);
    let revision = header_revision(&request, &video)?.ok_or(MISSING_REVISION)?;
    let bytes = bytes.clone();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let live = Arc::new(Live {
        updates: Mutex::new(Updates::new(seq)),
        started: Condvar::new(),
    });
    {
        let mut current = playback(&video);
        video.play_pending.store(true, Ordering::SeqCst);
        if let Some(previous) = current.replace(Playback {
            stop: Arc::clone(&stop_flag),
            live: Arc::clone(&live),
        }) {
            halt(previous);
        }
    }
    std::thread::spawn(move || play(app_handle, bytes, revision, live, stop_flag, channel));
    Ok(())
}

#[tauri::command]
pub fn video_stop(video: State<'_, VideoState>) {
    stop(&video);
}

#[tauri::command]
pub fn video_release(video: State<'_, VideoState>, state: State<'_, crate::app::state::AppState>) {
    stop(&video);
    video.release();
    if let Some(context) = crate::render::gpu::context::current_gpu_context(&state)
        && let Some(display) = context
            .display
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
    {
        display.drop_pending_frame();
    }
}

#[tauri::command]
pub async fn video_update_playback(
    request: tauri::ipc::Request<'_>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected a raw playback update".to_string());
    };
    let video = app_handle.state::<VideoState>();
    let revision = header_revision(&request, &video)?;
    let bytes = bytes.clone();
    let update: PlaybackUpdate = blocking(move || serde_json::from_slice(&bytes))
        .await?
        .map_err(|e| e.to_string())?;
    if update.timeline.is_some() && revision.is_none() {
        return Err(MISSING_REVISION.to_string());
    }
    if let Some(playback) = playback(&video).as_ref() {
        playback
            .live
            .updates
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .add(update, revision);
        playback.live.started.notify_all();
    }
    Ok(())
}

#[tauri::command]
pub async fn video_render_frame(
    request: FrameRequest,
    app_handle: AppHandle,
) -> Result<(), String> {
    let viewer_epoch = viewer_window::video_epoch();
    blocking(move || {
        let video = app_handle.state::<VideoState>();
        let revision = video.revisions.get(request.revision)?;
        let Some(mut engine) = video.preview(&app_handle)? else {
            return Ok(());
        };
        let project = &revision.project;
        let settings = preview_settings(&app_handle, engine.context(), project, &request.view)?;
        let frame = project.frame_at(request.time);
        let slot = match engine.render(project, frame, &settings, &video.titles) {
            Err(error) if error == PREEMPTED => return Ok(()),
            rendered => rendered?,
        };
        present(
            &app_handle,
            engine.context(),
            &slot,
            &request.view.content_path,
            viewer_epoch,
        );
        frame_ready(&app_handle, &request.view.content_path);
        if let Some(path) = &request.view.scope_path {
            scopes::send(&app_handle, engine.context(), &slot, &settings, path, false);
        }
        Ok(())
    })
    .await?
}

#[tauri::command]
pub async fn video_prepare(request: FrameRequest, app_handle: AppHandle) -> Result<(), String> {
    blocking(move || {
        let video = app_handle.state::<VideoState>();
        let revision = video.revisions.get(request.revision)?;
        let Some(mut engine) = video.preview(&app_handle)? else {
            return Ok(());
        };
        let project = &revision.project;
        let mut settings = preview_settings(&app_handle, engine.context(), project, &request.view)?;
        settings.canvas = PlaybackSize::new(project, &request.view).canvas(project);
        engine
            .prepare(
                project,
                &[project.frame_at(request.time)],
                &settings,
                &video.titles,
            )
            .map(|_| ())
    })
    .await?
}

fn render_still(
    app_handle: &AppHandle,
    request: &FrameRequest,
    maps: Option<&AtomicBool>,
) -> Result<((u32, u32), Vec<u8>), String> {
    let video = app_handle.state::<VideoState>();
    let revision = video.revisions.get(request.revision)?;
    let project = &revision.project;
    let cancel = AtomicBool::new(false);
    timelapse::ensure(app_handle, project, &cancel)?;
    reverse::ensure(app_handle, project, &cancel)?;
    let mut waits = 0;
    loop {
        let mut engine = video.batch(app_handle)?;
        let mut settings = frame_settings(project, &request.view);
        settings.preview = false;
        settings.output_space = None;
        settings.headroom = None;
        settings.precision = RenderOutputPrecision::Float;
        let slot = engine.render(
            project,
            project.frame_at(request.time),
            &settings,
            &video.titles,
        )?;
        let missing = engine.take_missing_maps();
        match maps {
            Some(cancel) if !missing.is_empty() && waits < MAP_WAITS => {
                drop(engine);
                waits += 1;
                crate::video::ai_maps::wait(app_handle, &missing, cancel, &|_| {})?;
            }
            _ => return Ok((slot.size, pack(engine.context(), &slot, Packing::Rgb48)?)),
        }
    }
}

#[tauri::command]
pub async fn video_export_frame(
    request: FrameRequest,
    path: String,
    app_handle: AppHandle,
) -> Result<(), String> {
    let handle = app_handle.clone();
    let output = PathBuf::from(&path);
    blocking(move || {
        let extension = output
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_lowercase();
        if !matches!(extension.as_str(), "jpg" | "jpeg" | "png" | "tif" | "tiff") {
            return Err(format!("Unsupported frame format: .{}", extension));
        }
        let export_settings: ExportSettings = serde_json::from_value(serde_json::json!({
            "jpegQuality": FRAME_JPEG_QUALITY,
            "keepMetadata": false,
            "stripGps": false,
        }))
        .map_err(|e| e.to_string())?;
        let ((width, height), packed) =
            render_still(&handle, &request, Some(&AtomicBool::new(false)))?;
        let samples = packed
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect();
        let image = ImageBuffer::<Rgb<u16>, Vec<u16>>::from_raw(width, height, samples)
            .ok_or("Frame size mismatch")?;
        let bytes = encode_image_to_bytes(
            &DynamicImage::ImageRgb16(image),
            &extension,
            &export_settings,
            None,
        )?;
        crate::library::file_ops::write_file_atomic(&output, &bytes)
            .map_err(|e| format!("Failed to write '{}': {}", output.display(), e))
    })
    .await??;
    let _ = app_handle.emit("video-frame-exported", &path);
    Ok(())
}

#[tauri::command]
pub async fn video_install_frame(
    request: FrameRequest,
    app_handle: AppHandle,
) -> Result<FrameSize, String> {
    let load_epoch = super::commands::current_load_epoch(&app_handle);
    let handle = app_handle.clone();
    let path = request.view.content_path.clone();
    let time = request.time;
    let image = blocking(move || {
        let ((width, height), packed) = render_still(&handle, &request, None)?;
        let rgb = Rgb32FImage::from_raw(width, height, wide_samples(&packed))
            .ok_or("Frame size mismatch")?;
        Ok::<_, String>(Arc::new(container_image_to_working(
            rgb,
            ContainerColor::Cicp {
                primaries: zenavif::ColorPrimaries::BT709,
                transfer: None,
            },
        )))
    })
    .await??;
    install_image(&app_handle, &path, image, time, false, false, load_epoch).await
}

#[tauri::command]
pub async fn video_sequence_filmstrip(
    request: StripRequest,
    app_handle: AppHandle,
) -> Result<Response, String> {
    blocking(move || {
        let video = app_handle.state::<VideoState>();
        let revision = video.revisions.get(request.revision)?;
        let mut engine = video.batch(&app_handle)?;
        let project = &revision.project;
        let settings = frame_settings(project, &request.view);
        let count = request.count.clamp(1, 64);
        let frames = project.frame_count().max(1);
        let (width, height) = settings.canvas;
        let mut sprite = RgbImage::new(width * count, height);
        for tile in 0..count {
            let frame = ((tile as f64 + 0.5) * frames as f64 / count as f64) as u64;
            let slot = engine.render(project, frame.min(frames - 1), &settings, &video.titles)?;
            let pixels = pack(engine.context(), &slot, Packing::Rgba8)?;
            let image = RgbaImage::from_raw(slot.size.0, slot.size.1, pixels)
                .ok_or("Frame size mismatch")?;
            image::imageops::replace(
                &mut sprite,
                &DynamicImage::ImageRgba8(image).to_rgb8(),
                (tile * width) as i64,
                0,
            );
        }
        encode_filmstrip(&sprite).map(Response::new)
    })
    .await?
}
