use rustfft::FftPlanner;
use rustfft::num_complex::Complex32;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::library::sidecars::parse_virtual_path;
use crate::video::audio::decode_mono;
use crate::video::blocking;
use crate::video::proxy::{cache_file, fingerprint, read_json_cache, write_json_cache};

const ANALYSIS_VERSION: u32 = 2;
const BEATS_DIR: &str = "beats";
const SAMPLE_RATE: usize = 22_050;
const WINDOW: usize = 1024;
const HOP: usize = 256;
const MIN_FREQUENCY: f32 = 30.0;
const MAX_FREQUENCY: f32 = 8_000.0;
const MEL_BANDS: usize = 64;
const DYNAMIC_RANGE_DB: f32 = 80.0;
const BASS_MAX_FREQUENCY: f32 = 150.0;
const OFFBEAT_MARGIN: f32 = 1.2;
const DETREND_SECONDS: f32 = 0.5;
const MIN_BPM: f32 = 60.0;
const MAX_BPM: f32 = 200.0;
const PREFERRED_BPM: f32 = 120.0;
const TEMPO_SPREAD_OCTAVES: f32 = 1.0;
const METER_WEIGHTS: [(f32, f32); 4] = [(1.0, 1.0), (0.5, 0.5), (2.0, 0.5), (4.0, 0.25)];
const REFINE_FRAMES: usize = 2;
const TIGHTNESS: f32 = 100.0;
const BEATS_PER_BAR: usize = 4;
const MIN_SECONDS: f32 = 2.0;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BeatAnalysis {
    version: u32,
    pub tempo: f32,
    pub beats: Vec<f64>,
    pub downbeats: Vec<f64>,
}

fn mel(frequency: f32) -> f32 {
    2595.0 * (1.0 + frequency / 700.0).log10()
}

fn mel_filters() -> Vec<Vec<(usize, f32)>> {
    let bin_hz = SAMPLE_RATE as f32 / WINDOW as f32;
    let (low, high) = (mel(MIN_FREQUENCY), mel(MAX_FREQUENCY));
    let edges: Vec<f32> = (0..MEL_BANDS + 2)
        .map(|index| {
            let value = low + (high - low) * index as f32 / (MEL_BANDS + 1) as f32;
            700.0 * (10f32.powf(value / 2595.0) - 1.0) / bin_hz
        })
        .collect();
    (0..MEL_BANDS)
        .map(|band| {
            let (left, middle, right) = (edges[band], edges[band + 1], edges[band + 2]);
            (left.floor() as usize..=right.ceil() as usize)
                .filter_map(|bin| {
                    let position = bin as f32;
                    let weight = if position <= middle {
                        (position - left) / (middle - left).max(1e-6)
                    } else {
                        (right - position) / (right - middle).max(1e-6)
                    };
                    (weight > 0.0 && bin <= WINDOW / 2).then_some((bin, weight))
                })
                .collect()
        })
        .collect()
}

struct Onsets {
    full: Vec<f32>,
    bass: Vec<f32>,
}

fn onset_envelope(samples: &[f32]) -> Onsets {
    let filters = mel_filters();
    let hann: Vec<f32> = (0..WINDOW)
        .map(|n| 0.5 - 0.5 * (std::f32::consts::TAU * n as f32 / WINDOW as f32).cos())
        .collect();
    let fft = FftPlanner::<f32>::new().plan_fft_forward(WINDOW);
    let frames = samples.len() / HOP + 1;
    let mut buffer = vec![Complex32::default(); WINDOW];
    let mut spectrogram = Vec::with_capacity(frames * MEL_BANDS);
    let bass_bins = (BASS_MAX_FREQUENCY * WINDOW as f32 / SAMPLE_RATE as f32).ceil() as usize;
    let mut bass = Vec::with_capacity(frames);
    for frame in 0..frames {
        let center = (frame * HOP) as isize;
        for (n, value) in buffer.iter_mut().enumerate() {
            let index = center + n as isize - (WINDOW / 2) as isize;
            let sample = usize::try_from(index)
                .ok()
                .and_then(|index| samples.get(index))
                .copied()
                .unwrap_or(0.0);
            *value = Complex32::new(sample * hann[n], 0.0);
        }
        fft.process(&mut buffer);
        bass.push(
            buffer[1..bass_bins]
                .iter()
                .map(Complex32::norm_sqr)
                .sum::<f32>(),
        );
        spectrogram.extend(filters.iter().map(|filter| {
            let energy: f32 = filter
                .iter()
                .map(|(bin, weight)| weight * buffer[*bin].norm_sqr())
                .sum();
            10.0 * energy.max(1e-10).log10()
        }));
    }
    let floor = spectrogram.iter().copied().fold(f32::MIN, f32::max) - DYNAMIC_RANGE_DB;
    spectrogram
        .iter_mut()
        .for_each(|value| *value = value.max(floor));
    Onsets {
        full: normalize(&flux(&spectrogram, frames)),
        bass: normalize(&rise(&bass)),
    }
}

fn flux(spectrogram: &[f32], frames: usize) -> Vec<f32> {
    (0..frames)
        .map(|frame| {
            if frame == 0 {
                return 0.0;
            }
            (0..MEL_BANDS)
                .map(|band| {
                    (spectrogram[frame * MEL_BANDS + band]
                        - spectrogram[(frame - 1) * MEL_BANDS + band])
                        .max(0.0)
                })
                .sum::<f32>()
                / MEL_BANDS as f32
        })
        .collect()
}

fn rise(energy: &[f32]) -> Vec<f32> {
    std::iter::once(0.0)
        .chain(energy.windows(2).map(|pair| (pair[1] - pair[0]).max(0.0)))
        .collect()
}

fn normalize(envelope: &[f32]) -> Vec<f32> {
    let radius = (DETREND_SECONDS * SAMPLE_RATE as f32 / HOP as f32) as usize;
    let mut prefix = vec![0f32; envelope.len() + 1];
    for (index, value) in envelope.iter().enumerate() {
        prefix[index + 1] = prefix[index] + value;
    }
    let detrended: Vec<f32> = (0..envelope.len())
        .map(|index| {
            let (from, to) = (
                index.saturating_sub(radius),
                (index + radius + 1).min(envelope.len()),
            );
            (envelope[index] - (prefix[to] - prefix[from]) / (to - from) as f32).max(0.0)
        })
        .collect();
    let mean = detrended.iter().sum::<f32>() / detrended.len().max(1) as f32;
    let deviation = (detrended
        .iter()
        .map(|value| (value - mean) * (value - mean))
        .sum::<f32>()
        / detrended.len().max(1) as f32)
        .sqrt()
        .max(1e-6);
    detrended.iter().map(|value| value / deviation).collect()
}

fn on_beat_phase(beats: Vec<usize>, bass: &[f32], period: f32) -> Vec<usize> {
    let half = (period / 2.0).round() as usize;
    let strength = |offset: usize| -> f32 {
        beats
            .iter()
            .filter_map(|frame| {
                let at = frame + offset;
                (at + 1 < bass.len()).then(|| {
                    bass[at.saturating_sub(1)..=at + 1]
                        .iter()
                        .copied()
                        .fold(0.0, f32::max)
                })
            })
            .sum()
    };
    if strength(half) <= strength(0) * OFFBEAT_MARGIN {
        return beats;
    }
    let last = beats.last().map(|frame| frame + half);
    beats
        .iter()
        .filter_map(|frame| frame.checked_sub(half))
        .chain(last.filter(|frame| *frame < bass.len()))
        .collect()
}

fn frames_per_second() -> f32 {
    SAMPLE_RATE as f32 / HOP as f32
}

fn tempo_period(envelope: &[f32]) -> Option<f32> {
    let rate = frames_per_second();
    let shortest = (60.0 / MAX_BPM * rate).floor() as usize;
    let longest = ((60.0 / MIN_BPM * rate).ceil() as usize).min(envelope.len() / 2);
    if longest <= shortest + 2 {
        return None;
    }
    let reach = (longest * 4).min(envelope.len() - 1);
    let correlation: Vec<f32> = (0..=reach)
        .map(|lag| {
            envelope[lag..]
                .iter()
                .zip(envelope)
                .map(|(a, b)| a * b)
                .sum::<f32>()
                / (envelope.len() - lag) as f32
        })
        .collect();
    let at = |lag: f32| {
        let low = lag.floor() as usize;
        let t = lag - low as f32;
        match (correlation.get(low), correlation.get(low + 1)) {
            (Some(a), Some(b)) => a * (1.0 - t) + b * t,
            _ => 0.0,
        }
    };
    let score = |lag: usize| {
        let lag = lag as f32;
        let metrical: f32 = METER_WEIGHTS
            .iter()
            .map(|(multiple, weight)| weight * at(lag * multiple))
            .sum();
        let bpm = 60.0 * rate / lag;
        let octaves = (bpm / PREFERRED_BPM).log2() / TEMPO_SPREAD_OCTAVES;
        metrical * (-0.5 * octaves * octaves).exp()
    };
    let scores: Vec<f32> = (shortest..=longest).map(score).collect();
    let best = scores
        .iter()
        .enumerate()
        .skip(1)
        .take(scores.len().saturating_sub(2))
        .max_by(|a, b| a.1.total_cmp(b.1))?
        .0;
    Some((shortest + best) as f32 + vertex(&scores[best - 1..=best + 1]))
}

fn vertex(values: &[f32]) -> f32 {
    let (left, middle, right) = (values[0], values[1], values[2]);
    let curvature = left - 2.0 * middle + right;
    if curvature.abs() > 1e-9 {
        (0.5 * (left - right) / curvature).clamp(-0.5, 0.5)
    } else {
        0.0
    }
}

fn refined(envelope: &[f32], frame: usize) -> f64 {
    let from = frame.saturating_sub(REFINE_FRAMES).max(1);
    let to = (frame + REFINE_FRAMES).min(envelope.len().saturating_sub(2));
    match (from..=to).max_by(|a, b| envelope[*a].total_cmp(&envelope[*b])) {
        Some(peak) => peak as f64 + vertex(&envelope[peak - 1..=peak + 1]) as f64,
        None => frame as f64,
    }
}

fn track_beats(envelope: &[f32], period: f32) -> Vec<usize> {
    let count = envelope.len();
    let mut score = vec![0f32; count];
    let mut previous = vec![usize::MAX; count];
    let (shortest, longest) = (
        (period * 0.5).round() as usize,
        (period * 2.0).round() as usize,
    );
    for frame in 0..count {
        let mut best = 0.0f32;
        let mut best_from = usize::MAX;
        for distance in shortest.max(1)..=longest {
            let Some(from) = frame.checked_sub(distance) else {
                break;
            };
            let gap = (distance as f32 / period).ln();
            let candidate = score[from] - TIGHTNESS * gap * gap;
            if best_from == usize::MAX || candidate > best {
                best = candidate;
                best_from = from;
            }
        }
        score[frame] = envelope[frame] + best.max(0.0);
        previous[frame] = if best > 0.0 { best_from } else { usize::MAX };
    }
    let tail = (period.ceil() as usize).min(count);
    let Some(mut frame) = (count - tail..count).max_by(|a, b| score[*a].total_cmp(&score[*b]))
    else {
        return Vec::new();
    };
    let mut beats = vec![frame];
    while previous[frame] != usize::MAX {
        frame = previous[frame];
        beats.push(frame);
    }
    beats.reverse();
    beats
}

fn analyze(samples: &[f32]) -> BeatAnalysis {
    if samples.len() < (MIN_SECONDS * SAMPLE_RATE as f32) as usize {
        return BeatAnalysis {
            version: ANALYSIS_VERSION,
            ..Default::default()
        };
    }
    let onsets = onset_envelope(samples);
    let envelope = &onsets.full;
    let Some(period) = tempo_period(envelope) else {
        return BeatAnalysis {
            version: ANALYSIS_VERSION,
            ..Default::default()
        };
    };
    let frames = on_beat_phase(track_beats(envelope, period), &onsets.bass, period);
    let phase = (0..BEATS_PER_BAR)
        .max_by(|a, b| {
            let strength = |phase: usize| -> f32 {
                frames
                    .iter()
                    .skip(phase)
                    .step_by(BEATS_PER_BAR)
                    .map(|frame| envelope[*frame])
                    .sum::<f32>()
            };
            strength(*a).total_cmp(&strength(*b))
        })
        .unwrap_or(0);
    let to_seconds = |frame: &usize| refined(envelope, *frame) / frames_per_second() as f64;
    BeatAnalysis {
        version: ANALYSIS_VERSION,
        tempo: 60.0 * frames_per_second() / period,
        beats: frames.iter().map(to_seconds).collect(),
        downbeats: frames
            .iter()
            .skip(phase)
            .step_by(BEATS_PER_BAR)
            .map(to_seconds)
            .collect(),
    }
}

#[tauri::command]
pub async fn video_beats(path: String, app_handle: AppHandle) -> Result<BeatAnalysis, String> {
    blocking(move || {
        let source = parse_virtual_path(&path).0;
        let cached = cache_file(&app_handle, BEATS_DIR, &fingerprint(&source)?, "json")?;
        if let Some(analysis) = read_json_cache::<BeatAnalysis>(&cached)
            .filter(|analysis| analysis.version == ANALYSIS_VERSION)
        {
            return Ok(analysis);
        }
        let analysis = analyze(&decode_mono(&source, SAMPLE_RATE as u32)?);
        let _ = write_json_cache(&cached, &analysis);
        Ok(analysis)
    })
    .await?
}
