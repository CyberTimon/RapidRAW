use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, OnceLock, PoisonError};

use serde::Serialize;
use tauri::ipc::Response;
use tauri::{AppHandle, Manager};

use crate::app::storage::mark_used;
use crate::library::sidecars::parse_virtual_path;
use crate::video::ffmpeg;
use crate::video::model::{
    Animated, AudioItem, Ease, Item, Keyframe, MediaKind, Motion, MotionKind, Sound,
    TICKS_PER_SECOND, Track, VideoProject, seconds,
};
use crate::video::proxy::{cache_file, fingerprint, write_cache_file};
use crate::video::retime::{self, Schedule};
use crate::video::{VideoState, blocking, hash_of, reverse, speech};

pub const SAMPLE_RATE: u32 = 48000;
pub const CHANNELS: usize = 2;
const BYTES_PER_SAMPLE: usize = 2;
const NESTED_AUDIO_DIR: &str = "nested-audio";
const RETIMED_AUDIO_DIR: &str = "retimed-audio";
const RETIMED_AUDIO_VERSION: u32 = 1;
const EASED_VOLUME_STEPS: i64 = 16;

static RETIMING: LazyLock<Mutex<HashMap<u64, Arc<OnceLock<bool>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct Timing {
    path: PathBuf,
    source_in: f64,
    schedule: Schedule,
    origin: f64,
    range: (f64, f64),
}

impl Timing {
    fn source_at(&self, time: f64) -> f64 {
        self.source_in + self.schedule.source_at(time - self.origin)
    }

    fn playable(&self) -> Option<(PathBuf, f64, f64)> {
        let schedule = &self.schedule;
        if schedule.varies() {
            let path = retimed_audio(&self.path, self.source_in, schedule, self.range)?;
            return Some((path, 0.0, 1.0));
        }
        Some((
            self.path.clone(),
            self.source_in + schedule.source_at(self.range.0),
            schedule.speed_at(0.0),
        ))
    }
}

pub struct AudioSource {
    id: String,
    start: f64,
    duration: f64,
    volume: Animated,
    fade_in: f64,
    fade_out: f64,
    crossfade_in: f64,
    crossfade_out: f64,
    gain: f64,
    pan: f64,
    sound: Sound,
    duck: Option<f64>,
    timing: Timing,
}

const BASS_HZ: f64 = 110.0;
const MID_HZ: f64 = 1000.0;
const TREBLE_HZ: f64 = 7000.0;
const DENOISE_LATENCY_SAMPLES: u32 = 1200;
const CUT_POLES: u32 = 2;
const MIN_COMPRESS_THRESHOLD_DB: f64 = -12.0;
const MAX_COMPRESS_THRESHOLD_DB: f64 = -30.0;
const MAX_COMPRESS_RATIO: f64 = 6.0;
const PREVIEW_WARMUP_SECONDS: f64 = 0.25;
const MIN_NOISE_REDUCTION_DB: f64 = 12.0;
const MAX_NOISE_REDUCTION_DB: f64 = 40.0;
const QUIET_NOISE_FLOOR_DB: f64 = -50.0;
const LOUD_NOISE_FLOOR_DB: f64 = -25.0;
const DUCK_GRID_SECONDS: f64 = 0.01;
const DUCK_LOOKAHEAD_SECONDS: f64 = 0.1;
const DUCK_ATTACK_SECONDS: f64 = 0.15;
const DUCK_RELEASE_SECONDS: f64 = 0.5;

#[derive(Clone, Copy)]
pub struct Window {
    pub start: f64,
    pub duration: f64,
}

fn has_audio(path: &std::path::Path) -> bool {
    ffmpeg::probe(path).is_ok_and(|info| info.has_audio)
}

fn audible_fade(duration: i64, motion: Option<Motion>) -> f64 {
    if motion.is_none_or(|motion| motion.kind == MotionKind::Fade) {
        seconds(duration)
    } else {
        0.0
    }
}

fn audible(track: &Track, soloing: bool) -> bool {
    !track.muted && track.volume > 0.0 && (!soloing || track.solo)
}

fn source_of(
    path: &str,
    kind: MediaKind,
    reversed: bool,
    source_in: i64,
) -> Option<(PathBuf, f64)> {
    if !(reversed && kind == MediaKind::Video) {
        return Some((parse_virtual_path(path).0, seconds(source_in)));
    }
    let app = crate::render::gpu::context::app_handle()?;
    let (path, duration) = reverse::audio_for(app, &parse_virtual_path(path).0)?;
    Some((path, duration - seconds(source_in)))
}

pub fn sources(project: &VideoProject) -> Vec<AudioSource> {
    let mut sources = Vec::new();
    let soloing = project
        .video_tracks
        .iter()
        .chain(&project.audio_tracks)
        .any(|track| track.solo);
    for (track_index, track) in project.video_tracks.iter().enumerate() {
        if !audible(track, soloing) {
            continue;
        }
        let clips: Vec<_> = track
            .items
            .iter()
            .filter_map(|item| match item {
                Item::Clip(clip) => Some(clip),
                _ => None,
            })
            .collect();
        for (index, clip) in clips.iter().enumerate() {
            if clip.freeze || clip.muted || (clip.volume.value <= 0.0 && !clip.volume.is_animated())
            {
                continue;
            }
            let (source, source_in) = match project.media_path(&clip.media) {
                Some((path, MediaKind::Video)) => {
                    match source_of(path, MediaKind::Video, clip.reverse, clip.source_in) {
                        Some(source) => source,
                        None => continue,
                    }
                }
                Some((_, MediaKind::Sequence)) => match nested_audio(project, &clip.media) {
                    Some(path) => (path, seconds(clip.source_in)),
                    None => continue,
                },
                _ => continue,
            };
            if !has_audio(&source) {
                continue;
            }
            let overlap = |a: i64, b: i64| seconds((a - b).max(0));
            let (overlap_in, overlap_out) = if track_index == 0 {
                (
                    index.checked_sub(1).map_or(0.0, |previous| {
                        overlap(clips[previous].start + clips[previous].duration, clip.start)
                    }),
                    clips
                        .get(index + 1)
                        .map_or(0.0, |next| overlap(clip.start + clip.duration, next.start)),
                )
            } else {
                (0.0, 0.0)
            };
            sources.push(AudioSource {
                id: clip.id.clone(),
                start: seconds(clip.start),
                duration: seconds(clip.duration),
                volume: clip.volume.clone(),
                fade_in: audible_fade(clip.fade_in, clip.anim_in),
                fade_out: audible_fade(clip.fade_out, clip.anim_out),
                crossfade_in: overlap_in,
                crossfade_out: overlap_out,
                gain: track.volume,
                pan: track.pan,
                sound: clip.sound,
                duck: None,
                timing: Timing {
                    path: source,
                    source_in,
                    schedule: Schedule::new(clip.pace(), clip.duration, project.settings.fps),
                    origin: seconds(clip.start),
                    range: (0.0, seconds(clip.duration)),
                },
            });
        }
    }
    for track in project
        .audio_tracks
        .iter()
        .filter(|track| audible(track, soloing))
    {
        let mut items: Vec<&AudioItem> = track
            .items
            .iter()
            .filter_map(|item| match item {
                Item::Audio(audio) => Some(audio),
                _ => None,
            })
            .collect();
        items.sort_by_key(|audio| audio.start);
        let overlaps: Vec<f64> = items
            .windows(2)
            .map(|pair| crossfade_overlap(project, pair[0], pair[1]))
            .collect();
        for (index, audio) in items.iter().enumerate() {
            let Some((source, source_in)) = played(project, audio) else {
                continue;
            };
            if audio.muted
                || (audio.volume.value <= 0.0 && !audio.volume.is_animated())
                || !has_audio(&source)
            {
                continue;
            }
            let before = index
                .checked_sub(1)
                .map_or(0.0, |previous| overlaps[previous]);
            let after = overlaps.get(index).copied().unwrap_or(0.0);
            sources.push(AudioSource {
                id: audio.id.clone(),
                start: seconds(audio.start) - before,
                duration: seconds(audio.duration) + before + after,
                volume: shift_keys(&audio.volume, before),
                fade_in: if before > 0.0 {
                    0.0
                } else {
                    seconds(audio.fade_in)
                },
                fade_out: if after > 0.0 {
                    0.0
                } else {
                    seconds(audio.fade_out)
                },
                crossfade_in: before * 2.0,
                crossfade_out: after * 2.0,
                gain: track.volume,
                pan: track.pan,
                sound: audio.sound,
                duck: audio.duck.filter(|amount| *amount < 0.0),
                timing: Timing {
                    path: source,
                    source_in,
                    schedule: schedule_of(project, audio),
                    origin: seconds(audio.start),
                    range: (-before, seconds(audio.duration) + after),
                },
            });
        }
    }
    sources
}

fn bounds(window: Option<Window>) -> (f64, f64) {
    window.map_or((0.0, f64::INFINITY), |window| {
        (window.start, window.start + window.duration)
    })
}

fn overlaps(source: &AudioSource, (from, to): (f64, f64)) -> bool {
    source.start + source.duration > from && source.start < to
}

fn dialogue(sources: &[AudioSource], (start, end): (f64, f64)) -> Vec<(f64, f64)> {
    let cell = |time: f64| (time.max(0.0) / DUCK_GRID_SECONDS).round() as usize;
    let last = sources
        .iter()
        .map(|source| source.start + source.duration)
        .fold(0.0, f64::max);
    let mut active = vec![false; cell(last) + 1];
    let reach = cell(DUCK_LOOKAHEAD_SECONDS + DUCK_RELEASE_SECONDS) + 1;
    let until = end + DUCK_LOOKAHEAD_SECONDS + DUCK_RELEASE_SECONDS;
    let mut waiting: Vec<&AudioSource> = sources
        .iter()
        .filter(|source| source.duck.is_none())
        .collect();
    let mut first = cell(start - DUCK_RELEASE_SECONDS).min(active.len());
    loop {
        let earliest = first.saturating_sub(reach);
        let (near, far): (Vec<_>, Vec<_>) = waiting
            .into_iter()
            .partition(|source| overlaps(source, (earliest as f64 * DUCK_GRID_SECONDS, until)));
        waiting = far;
        for source in near {
            let Some(segments) = speech::segments(&source.timing.path).filter(|s| !s.is_empty())
            else {
                continue;
            };
            let (from, to) = (cell(source.start), cell(source.start + source.duration));
            for (index, speaking) in active.iter_mut().enumerate().take(to).skip(from) {
                let at = source.timing.source_at(index as f64 * DUCK_GRID_SECONDS);
                let next = segments.partition_point(|(start, _)| *start <= at);
                *speaking |= next > 0 && at < segments[next - 1].1;
            }
        }
        match active[earliest..first]
            .iter()
            .position(|speaking| *speaking)
        {
            Some(offset) => first = earliest + offset,
            None => break,
        }
    }
    let mut spans: Vec<(f64, f64)> = Vec::new();
    for (index, _) in active.iter().enumerate().filter(|(_, active)| **active) {
        let (start, end) = (
            index as f64 * DUCK_GRID_SECONDS,
            (index + 1) as f64 * DUCK_GRID_SECONDS,
        );
        match spans.last_mut() {
            Some(last) if last.1 >= start - DUCK_GRID_SECONDS / 2.0 => last.1 = end,
            _ => spans.push((start, end)),
        }
    }
    spans
}

fn duck_curve(sources: &[AudioSource], window: Option<Window>) -> Vec<(f64, f64)> {
    let range = bounds(window);
    if !sources
        .iter()
        .any(|source| source.duck.is_some() && overlaps(source, range))
    {
        return Vec::new();
    }
    let mut points = Vec::new();
    let (mut time, mut depth) = (0.0, 0.0);
    for (start, end) in dialogue(sources, range) {
        let start = (start - DUCK_LOOKAHEAD_SECONDS).max(time);
        if depth > 0.0 {
            let silent = time + depth * DUCK_RELEASE_SECONDS;
            if silent <= start {
                points.push((silent, 0.0));
                depth = 0.0;
            } else {
                depth -= (start - time) / DUCK_RELEASE_SECONDS;
            }
        }
        points.push((start, depth));
        let full = start + (1.0 - depth) * DUCK_ATTACK_SECONDS;
        if full <= end {
            points.push((full, 1.0));
            depth = 1.0;
        } else {
            depth += (end - start) / DUCK_ATTACK_SECONDS;
        }
        points.push((end, depth));
        time = end;
    }
    if depth > 0.0 {
        points.push((time + depth * DUCK_RELEASE_SECONDS, 0.0));
    }
    points
}

fn depth_at(curve: &[(f64, f64)], time: f64) -> f64 {
    let next = curve.partition_point(|(at, _)| *at <= time);
    match (
        next.checked_sub(1).map(|index| curve[index]),
        curve.get(next).copied(),
    ) {
        (Some((x0, y0)), Some((x1, y1))) if x1 > x0 => y0 + (time - x0) * (y1 - y0) / (x1 - x0),
        (Some((_, y0)), _) => y0,
        _ => 0.0,
    }
}

type Piece = (f64, f64, f64, f64);

fn duck_expression(pieces: &[Piece], scale: f64, time: &str) -> String {
    if let [(x0, y0, x1, y1)] = *pieces {
        if y0 == y1 {
            return format!("{:.9}", (scale * y0).exp());
        }
        let slope = scale * (y1 - y0) / (x1 - x0);
        return format!("exp({:.9}+{:.9}*({}-{:.6}))", scale * y0, slope, time, x0);
    }
    let (left, right) = pieces.split_at(pieces.len() / 2);
    format!(
        "if(lt({},{:.6}),{},{})",
        time,
        right[0].0,
        duck_expression(left, scale, "ld(0)"),
        duck_expression(right, scale, "ld(0)")
    )
}

fn duck_filter(curve: &[(f64, f64)], amount: f64, from: f64, to: f64) -> Option<String> {
    let mut pieces: Vec<Piece> = Vec::new();
    let mut previous = (f64::NEG_INFINITY, 0.0);
    for &(x, y) in curve.iter().chain([&(f64::INFINITY, 0.0)]) {
        if x > previous.0 && x > from && previous.0 < to {
            pieces.push((previous.0, previous.1, x, y));
        }
        previous = (x, y);
    }
    if pieces.iter().all(|piece| piece.1 == 0.0 && piece.3 == 0.0) {
        return None;
    }
    let time = format!("st(0,n/{}+{:.9})", SAMPLE_RATE, from);
    let gain = duck_expression(&pieces, amount * std::f64::consts::LN_10 / 20.0, &time);
    Some(format!("aeval=exprs='val(ch)*({})':c=same", gain))
}

fn played(project: &VideoProject, audio: &AudioItem) -> Option<(PathBuf, f64)> {
    let (path, kind) = project.media_path(&audio.media)?;
    source_of(path, kind, audio.reverse, audio.source_in)
}

fn schedule_of(project: &VideoProject, audio: &AudioItem) -> Schedule {
    Schedule::new(audio.pace(), audio.duration, project.settings.fps)
}

fn crossfade_overlap(project: &VideoProject, from: &AudioItem, to: &AudioItem) -> f64 {
    let frame = TICKS_PER_SECOND as f64 / project.fps();
    if to.crossfade <= 0 || ((from.start + from.duration - to.start) as f64).abs() > frame / 2.0 {
        return 0.0;
    }
    let tail = played(project, from)
        .and_then(|(path, start)| {
            let info = ffmpeg::probe(&path).ok()?;
            let schedule = schedule_of(project, from);
            let end = seconds(from.duration);
            Some((info.duration - start - schedule.source_at(end)) / schedule.speed_at(end))
        })
        .unwrap_or(0.0);
    let head = played(project, to).map_or(0.0, |(_, start)| {
        start / schedule_of(project, to).speed_at(0.0)
    });
    (seconds(to.crossfade) / 2.0).min(tail).min(head).max(0.0)
}

fn retimed_audio(
    source: &Path,
    source_in: f64,
    schedule: &Schedule,
    (from, to): (f64, f64),
) -> Option<PathBuf> {
    let app = crate::render::gpu::context::app_handle()?;
    let sample = |seconds: f64| (seconds * SAMPLE_RATE as f64).round() as i64;
    let key = hash_of((
        RETIMED_AUDIO_VERSION,
        fingerprint(source).ok()?,
        sample(source_in),
        sample(from),
        sample(to),
        schedule,
    ));
    let path = cache_file(app, RETIMED_AUDIO_DIR, &format!("{:016x}", key), "wav").ok()?;
    let slot = Arc::clone(
        RETIMING
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(key)
            .or_default(),
    );
    let ready = *slot.get_or_init(|| {
        path.is_file() || write_retimed(&path, source, source_in, schedule, (from, to)).is_some()
    });
    let mut retiming = RETIMING.lock().unwrap_or_else(PoisonError::into_inner);
    if retiming
        .get(&key)
        .is_some_and(|current| Arc::ptr_eq(current, &slot))
    {
        retiming.remove(&key);
    }
    ready.then(|| {
        mark_used(&path);
        path
    })
}

fn write_retimed(
    path: &Path,
    source: &Path,
    source_in: f64,
    schedule: &Schedule,
    (from, to): (f64, f64),
) -> Option<()> {
    let start = (source_in + schedule.source_at(from) - retime::MARGIN_SECONDS).max(0.0);
    let end = source_in + schedule.source_at(to) + retime::MARGIN_SECONDS;
    let length = ((to - from) * SAMPLE_RATE as f64).round() as usize;
    let bytes: Vec<u8> = {
        let samples: Vec<f32> = s16_to_f32(
            &decode_s16(source, SAMPLE_RATE, CHANNELS, Some((start, end - start)))
                .inspect_err(|e| log::warn!("Could not decode the audio of a speed ramp: {}", e))
                .ok()?,
        )
        .collect();
        retime::stretch(&samples, length, |local| {
            source_in + schedule.source_at(from + local) - start
        })
    }
    .iter()
    .flat_map(|value| ((value.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes())
    .collect();
    write_cache_file(path, &wav(&bytes))
        .inspect_err(|e| log::warn!("Could not save the audio of a speed ramp: {}", e))
        .ok()
}

fn shift_keys(volume: &Animated, by: f64) -> Animated {
    let offset = (by * TICKS_PER_SECOND as f64).round() as i64;
    Animated {
        value: volume.value,
        keys: volume
            .keys
            .iter()
            .map(|key| Keyframe {
                time: key.time + offset,
                ..*key
            })
            .collect(),
    }
}

fn volume_expression(volume: &Animated, local: &str) -> String {
    if !volume.is_animated() {
        return format!("{:.5}", volume.value);
    }
    let keys = &volume.keys;
    let at = |index: usize| seconds(keys[index].time);
    let ramp = |from: (f64, f64), to: (f64, f64)| {
        format!(
            "{:.5}+({:.5})*clip(({}-{:.6})/{:.6},0,1)",
            from.1,
            to.1 - from.1,
            local,
            from.0,
            (to.0 - from.0).max(1e-6)
        )
    };
    let mut expression = format!("{:.5}", keys[keys.len() - 1].value);
    for index in (0..keys.len() - 1).rev() {
        let (from, to) = (&keys[index], &keys[index + 1]);
        let segment = match from.ease {
            Ease::Hold => format!("{:.5}", from.value),
            Ease::Linear if from.handle_out.is_none() && to.handle_in.is_none() => {
                ramp((at(index), from.value), (at(index + 1), to.value))
            }
            _ => {
                let point = |step: i64| {
                    let time = from.time + (to.time - from.time) * step / EASED_VOLUME_STEPS;
                    (seconds(time), volume.at(time))
                };
                (1..EASED_VOLUME_STEPS).rev().fold(
                    ramp(point(EASED_VOLUME_STEPS - 1), point(EASED_VOLUME_STEPS)),
                    |inner, step| {
                        format!(
                            "if(lt({},{:.6}),{},{})",
                            local,
                            point(step).0,
                            ramp(point(step - 1), point(step)),
                            inner
                        )
                    },
                )
            }
        };
        expression = format!(
            "if(lt({},{:.6}),{},{})",
            local,
            at(index + 1),
            segment,
            expression
        );
    }
    format!(
        "if(lt({},{:.6}),{:.5},{})",
        local,
        at(0),
        keys[0].value,
        expression
    )
}

fn input_for(
    source: &AudioSource,
    window: Option<Window>,
    curve: &[(f64, f64)],
) -> Option<(f64, PathBuf, String)> {
    let (window_start, window_end) = bounds(window);
    if !overlaps(source, (window_start, window_end)) {
        return None;
    }
    let (path, source_in, speed) = source.timing.playable()?;
    let end = source.start + source.duration;
    let local_start = (window_start - source.start).max(0.0);
    let take = end.min(window_end) - source.start.max(window_start);
    let seek = source_in + local_start * speed;
    let local = format!("(t+{:.6})", local_start);
    let mut gain = volume_expression(&source.volume, local.as_str());
    if source.fade_in > 0.0 {
        gain = format!(
            "{}*clip({}/{:.6},0,1)",
            gain,
            local,
            source.fade_in.min(source.duration)
        );
    }
    if source.fade_out > 0.0 {
        gain = format!(
            "{}*clip(({:.6}-{})/{:.6},0,1)",
            gain,
            source.duration,
            local,
            source.fade_out.min(source.duration)
        );
    }
    if source.crossfade_in > 0.0 {
        gain = format!(
            "{}*sin(PI/2*clip({}/{:.6},0,1))",
            gain,
            local,
            source.crossfade_in.min(source.duration)
        );
    }
    if source.crossfade_out > 0.0 {
        gain = format!(
            "{}*sin(PI/2*clip(({:.6}-{})/{:.6},0,1))",
            gain,
            source.duration,
            local,
            source.crossfade_out.min(source.duration)
        );
    }
    let sound = source.sound;
    let denoise = sound.denoise.clamp(0.0, 1.0);
    let latency = if denoise > 0.0 {
        DENOISE_LATENCY_SAMPLES as f64 / SAMPLE_RATE as f64
    } else {
        0.0
    };
    let mut filters = vec![
        format!("atrim=duration={:.6}", (take + latency) * speed),
        "asetpts=PTS-STARTPTS".to_string(),
    ];
    filters.extend(ffmpeg::atempo_filters(speed));
    filters.push(format!(
        "aformat=sample_rates={}:channel_layouts=stereo",
        SAMPLE_RATE
    ));
    filters.extend(sound_filters(&sound));
    if denoise > 0.0 {
        let start = DENOISE_LATENCY_SAMPLES as u64;
        let end = start + (take * SAMPLE_RATE as f64).round() as u64;
        filters.push(format!("apad=whole_len={}", end));
        filters.push(format!(
            "afftdn=nr={:.1}:nf={:.1}",
            MIN_NOISE_REDUCTION_DB + (MAX_NOISE_REDUCTION_DB - MIN_NOISE_REDUCTION_DB) * denoise,
            QUIET_NOISE_FLOOR_DB + (LOUD_NOISE_FLOOR_DB - QUIET_NOISE_FLOOR_DB) * denoise
        ));
        filters.push(format!(
            "atrim=start_sample={}:end_sample={},asetpts=PTS-STARTPTS",
            start, end
        ));
    }
    if sound.compress > 0.0 {
        let amount = sound.compress.clamp(0.0, 1.0);
        let threshold = MIN_COMPRESS_THRESHOLD_DB
            + (MAX_COMPRESS_THRESHOLD_DB - MIN_COMPRESS_THRESHOLD_DB) * amount;
        let ratio = 1.0 + (MAX_COMPRESS_RATIO - 1.0) * amount;
        let makeup = -threshold * (1.0 - 1.0 / ratio) * 0.5;
        filters.push(format!(
            "acompressor=threshold={:.5}:ratio={:.2}:attack=10:release=200:makeup={:.4}",
            10f64.powf(threshold / 20.0),
            ratio,
            10f64.powf(makeup / 20.0)
        ));
    }
    let from = source.start + local_start;
    filters.extend(
        source
            .duck
            .and_then(|amount| duck_filter(curve, amount, from, from + take)),
    );
    filters.push(format!(
        "volume=eval=frame:volume='({})*{:.5}'",
        gain, source.gain
    ));
    let delay = ((source.start - window_start).max(0.0) * 1000.0).round() as u64;
    filters.push(format!("adelay={}:all=1", delay));
    if source.pan != 0.0 {
        let pan = source.pan.clamp(-1.0, 1.0);
        filters.push(format!(
            "pan=stereo|c0={:.4}*c0|c1={:.4}*c1",
            (1.0 - pan).min(1.0),
            (1.0 + pan).min(1.0)
        ));
    }
    Some((seek, path, filters.join(",")))
}

pub struct MixGraph {
    pub inputs: Vec<(f64, PathBuf)>,
    pub filters: Vec<String>,
    master: f64,
    limit: bool,
}

impl MixGraph {
    pub fn new(project: &VideoProject, window: Option<Window>) -> Self {
        let mut inputs = Vec::new();
        let mut chains = Vec::new();
        let sources = sources(project);
        let curve = duck_curve(&sources, window);
        for source in sources {
            if let Some((seek, path, chain)) = input_for(&source, window, &curve) {
                inputs.push((seek, path));
                chains.push(chain);
            }
        }
        Self {
            inputs,
            filters: chains,
            master: project.master_volume.max(0.0),
            limit: false,
        }
    }

    pub fn normalized(self, gain: f64) -> Self {
        Self {
            master: self.master * gain,
            limit: true,
            ..self
        }
    }

    pub fn is_empty(&self) -> bool {
        self.inputs.is_empty()
    }

    fn mix(&self) -> String {
        let labels: String = (0..self.filters.len())
            .map(|index| format!("[a{}]", index))
            .collect();
        let master = if self.master == 1.0 {
            String::new()
        } else {
            format!(",volume={:.5}", self.master)
        };
        let limiter = if self.limit {
            format!(",{}", crate::video::loudness::limiter())
        } else {
            String::new()
        };
        format!(
            "{}amix=inputs={}:normalize=0:dropout_transition=0{}{},apad",
            labels,
            self.filters.len(),
            master,
            limiter
        )
    }

    pub fn open_libav(
        &self,
        sample_format: &str,
        sample_rate: u32,
        channel_layout: &str,
        frame_size: Option<u32>,
    ) -> Result<crate::video::libav::audio::AudioMix, String> {
        let inputs: Vec<crate::video::libav::audio::AudioInput> = self
            .inputs
            .iter()
            .map(|(seek, path)| crate::video::libav::audio::AudioInput { path, seek: *seek })
            .collect();
        let mut graph: Vec<String> = self
            .inputs
            .iter()
            .zip(&self.filters)
            .enumerate()
            .map(|(index, ((seek, _), chain))| {
                format!(
                    "[in{}]atrim=start={:.6},asetpts=PTS-STARTPTS,{}[a{}]",
                    index, seek, chain, index
                )
            })
            .collect();
        let resample = if sample_rate == SAMPLE_RATE {
            String::new()
        } else {
            format!(",aresample={}", sample_rate)
        };
        graph.push(format!(
            "{}{},aformat=sample_fmts={}:sample_rates={}:channel_layouts={}[out]",
            self.mix(),
            resample,
            sample_format,
            sample_rate,
            channel_layout
        ));
        crate::video::libav::audio::AudioMix::open(&inputs, &graph.join(";"), frame_size)
    }
}

fn decode_s16(
    path: &Path,
    sample_rate: u32,
    channels: usize,
    span: Option<(f64, f64)>,
) -> Result<Vec<u8>, String> {
    let (seek, trim) = span.map_or((0.0, String::new()), |(start, duration)| {
        (
            start,
            format!(
                "atrim=start={:.6}:duration={:.6},asetpts=PTS-STARTPTS,",
                start, duration
            ),
        )
    });
    crate::video::libav::audio::AudioMix::open(
        &[crate::video::libav::audio::AudioInput { path, seek }],
        &format!(
            "[in0]{}aresample={},aformat=sample_fmts=s16:channel_layouts={}[out]",
            trim,
            sample_rate,
            if channels == 1 { "mono" } else { "stereo" }
        ),
        None,
    )?
    .read_all()
}

pub fn decode_mono(path: &Path, sample_rate: u32) -> Result<Vec<f32>, String> {
    Ok(s16_to_f32(&decode_s16(path, sample_rate, 1, None)?).collect())
}

pub fn reversed_wav(path: &Path) -> Result<Vec<u8>, String> {
    let mut samples = decode_s16(path, SAMPLE_RATE, CHANNELS, None)?;
    samples
        .as_chunks_mut::<{ CHANNELS * BYTES_PER_SAMPLE }>()
        .0
        .reverse();
    Ok(wav(&samples))
}

pub fn s16_to_f32(bytes: &[u8]) -> impl Iterator<Item = f32> + '_ {
    bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| i16::from_le_bytes(*pair) as f32 / 32768.0)
}

fn silence(duration: f64) -> Vec<u8> {
    vec![0; (duration * SAMPLE_RATE as f64).round() as usize * CHANNELS * BYTES_PER_SAMPLE]
}

fn sound_filters(sound: &Sound) -> Vec<String> {
    let mut filters = Vec::new();
    if sound.low_cut > 0.0 {
        filters.push(format!(
            "highpass=f={:.1}:poles={}",
            sound.low_cut, CUT_POLES
        ));
    }
    if sound.high_cut > 0.0 {
        filters.push(format!(
            "lowpass=f={:.1}:poles={}",
            sound.high_cut, CUT_POLES
        ));
    }
    let eq = sound.eq.unwrap_or_default();
    if eq.low != 0.0 {
        filters.push(format!("bass=g={:.2}:f={}:w=0.6", eq.low, BASS_HZ));
    }
    if eq.mid != 0.0 {
        filters.push(format!("equalizer=f={}:t=q:w=0.8:g={:.2}", MID_HZ, eq.mid));
    }
    if eq.high != 0.0 {
        filters.push(format!("treble=g={:.2}:f={}:w=0.6", eq.high, TREBLE_HZ));
    }
    filters
}

fn wav(samples: &[u8]) -> Vec<u8> {
    let rate = SAMPLE_RATE * (CHANNELS * BYTES_PER_SAMPLE) as u32;
    let mut bytes = Vec::with_capacity(samples.len() + 44);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + samples.len() as u32).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&(CHANNELS as u16).to_le_bytes());
    bytes.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    bytes.extend_from_slice(&rate.to_le_bytes());
    bytes.extend_from_slice(&((CHANNELS * BYTES_PER_SAMPLE) as u16).to_le_bytes());
    bytes.extend_from_slice(&((BYTES_PER_SAMPLE * 8) as u16).to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&(samples.len() as u32).to_le_bytes());
    bytes.extend_from_slice(samples);
    bytes
}

fn nested_audio(project: &VideoProject, id: &str) -> Option<PathBuf> {
    let nested = project.sequence_audio(id)?;
    let mut sequences: Vec<_> = nested.sequences.iter().collect();
    sequences.sort_by_key(|(key, _)| key.as_str());
    let app = crate::render::gpu::context::app_handle()?;
    let key = hash_of(format!(
        "{:?}{:?}{:?}{:?}{}",
        nested.media,
        nested.video_tracks,
        nested.audio_tracks,
        sequences,
        reverse::pending_audio(app, &nested)
    ));
    let path = cache_file(app, NESTED_AUDIO_DIR, &format!("{:016x}", key), "wav").ok()?;
    if path.is_file() {
        mark_used(&path);
        return Some(path);
    }
    if MixGraph::new(&nested, None).is_empty() {
        return None;
    }
    let duration = seconds(nested.end_ticks());
    let samples = render_chunk(
        &nested,
        Window {
            start: 0.0,
            duration,
        },
    )
    .inspect_err(|e| log::warn!("Could not mix a nested sequence: {}", e))
    .ok()?;
    write_cache_file(&path, &wav(&samples))
        .inspect_err(|e| log::warn!("Could not save a nested sequence mix: {}", e))
        .ok()?;
    Some(path)
}

pub fn render_chunk(project: &VideoProject, window: Window) -> Result<Vec<u8>, String> {
    let warmup = window.start.min(PREVIEW_WARMUP_SECONDS);
    let skip = silence(warmup).len();
    let mix = MixGraph::new(
        project,
        Some(Window {
            start: window.start - warmup,
            duration: window.duration + warmup,
        }),
    );
    let length = silence(window.duration + warmup).len();
    if mix.is_empty() {
        return Ok(silence(window.duration));
    }
    let mut bytes = Vec::with_capacity(length);
    mix.open_libav("s16", SAMPLE_RATE, "stereo", None)?
        .read_interleaved(&mut bytes, length)?;
    Ok(bytes.split_off(skip))
}

#[derive(Serialize)]
pub struct DuckCurve {
    id: String,
    points: Vec<(f64, f64)>,
}

#[tauri::command]
pub async fn video_duck_curves(
    revision: u64,
    app_handle: AppHandle,
) -> Result<Vec<DuckCurve>, String> {
    blocking(move || {
        let revision = app_handle.state::<VideoState>().revisions.get(revision)?;
        let sources = sources(&revision.project);
        let curve = duck_curve(&sources, None);
        Ok(sources
            .iter()
            .filter(|source| source.duck.is_some())
            .map(|source| {
                let (from, to) = (source.start, source.start + source.duration);
                let inside = curve.iter().filter(|(at, _)| *at > from && *at < to);
                DuckCurve {
                    id: source.id.clone(),
                    points: std::iter::once((from, depth_at(&curve, from)))
                        .chain(inside.copied())
                        .chain([(to, depth_at(&curve, to))])
                        .collect(),
                }
            })
            .collect())
    })
    .await?
}

#[tauri::command]
pub async fn video_audio_chunk(
    revision: u64,
    start: f64,
    duration: f64,
    solo: Option<String>,
    app_handle: AppHandle,
) -> Result<Response, String> {
    blocking(move || {
        let revision = app_handle.state::<VideoState>().revisions.get(revision)?;
        let window = Window {
            start: start.max(0.0),
            duration: duration.clamp(0.05, 30.0),
        };
        let rendered = match solo {
            Some(id) => render_chunk(&revision.project.solo_audio(&id), window),
            None => render_chunk(&revision.project, window),
        };
        let bytes = rendered.unwrap_or_else(|e| {
            log::warn!("Could not mix the timeline audio: {}", e);
            silence(window.duration)
        });
        Ok(Response::new(bytes))
    })
    .await?
}
