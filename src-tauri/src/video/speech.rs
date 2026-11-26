use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex, OnceLock, PoisonError};

use rustfft::FftPlanner;
use rustfft::num_complex::Complex32;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::video::audio::decode_mono;
use crate::video::proxy::{cache_file, fingerprint, read_json_cache, write_json_cache};

const ANALYSIS_VERSION: u32 = 1;
const SPEECH_DIR: &str = "speech";
const SAMPLE_RATE: usize = 16_000;
const WINDOW: usize = 512;
const HOP: usize = 160;
const LOW_HZ: f32 = 300.0;
const HIGH_HZ: f32 = 4_000.0;
const BANDS: usize = 12;
const FIRST_HIGH_BAND: usize = 5;
const FLOOR_SECONDS: f32 = 1.5;
const FLOOR_BIAS_DB: f32 = 3.0;
const ABSOLUTE_FLOOR_DB: f32 = -75.0;
const BAND_SNR_DB: f32 = 5.0;
const MIN_BANDS: usize = 3;
const MIN_HIGH_BANDS: usize = 1;
const MIN_PITCH_HZ: usize = 70;
const MAX_PITCH_HZ: usize = 400;
const VOICING: f32 = 0.6;
const VOICED_SHARE: f32 = 0.2;
const CONTEXT_SECONDS: f32 = 0.25;
const STEP_CLIP_DB: f32 = 6.0;
const MODULATION_DB: f32 = 0.7;
const HANGOVER_SECONDS: f32 = 0.3;
const MIN_SPEECH_SECONDS: f32 = 0.2;

pub type Segments = Arc<Vec<(f64, f64)>>;
type Analysis = Arc<OnceLock<Option<Segments>>>;

static ANALYSES: LazyLock<Mutex<HashMap<String, Analysis>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Serialize, Deserialize)]
struct SpeechAnalysis {
    version: u32,
    segments: Vec<(f64, f64)>,
}

fn frames_of(seconds: f32) -> usize {
    (seconds * SAMPLE_RATE as f32 / HOP as f32) as usize
}

fn box_filter(values: &[f32], radius: usize) -> Vec<f32> {
    let mut prefix = vec![0f64; values.len() + 1];
    for (index, value) in values.iter().enumerate() {
        prefix[index + 1] = prefix[index] + *value as f64;
    }
    (0..values.len())
        .map(|index| {
            let from = index.saturating_sub(radius);
            let to = (index + radius + 1).min(values.len());
            ((prefix[to] - prefix[from]) / (to - from) as f64) as f32
        })
        .collect()
}

fn sliding_min(values: &[f32], radius: usize) -> Vec<f32> {
    let mut window: VecDeque<usize> = VecDeque::new();
    let mut output = Vec::with_capacity(values.len());
    let mut next = 0;
    for index in 0..values.len() {
        while next < values.len() && next <= index + radius {
            while window
                .back()
                .is_some_and(|last| values[*last] >= values[next])
            {
                window.pop_back();
            }
            window.push_back(next);
            next += 1;
        }
        while window.front().is_some_and(|first| *first + radius < index) {
            window.pop_front();
        }
        output.push(values[window[0]]);
    }
    output
}

fn autocorrelation(power: &mut [Complex32], fft: &dyn rustfft::Fft<f32>) -> Vec<f32> {
    fft.process(power);
    power.iter().map(|value| value.re).collect()
}

struct Frames {
    bands: Vec<[f32; BANDS]>,
    voicing: Vec<f32>,
}

fn analyze_frames(samples: &[f32]) -> Frames {
    let mut planner = FftPlanner::<f32>::new();
    let forward = planner.plan_fft_forward(WINDOW);
    let inverse = planner.plan_fft_inverse(WINDOW);
    let hann: Vec<f32> = (0..WINDOW)
        .map(|n| 0.5 - 0.5 * (std::f32::consts::TAU * n as f32 / WINDOW as f32).cos())
        .collect();
    let scale = (hann.iter().sum::<f32>() / 2.0).powi(2);
    let bin_hz = SAMPLE_RATE as f32 / WINDOW as f32;
    let band_of: Vec<Option<usize>> = (0..=WINDOW / 2)
        .map(|bin| {
            let frequency = bin as f32 * bin_hz;
            (LOW_HZ..HIGH_HZ).contains(&frequency).then(|| {
                let position = (frequency / LOW_HZ).ln() / (HIGH_HZ / LOW_HZ).ln() * BANDS as f32;
                (position as usize).min(BANDS - 1)
            })
        })
        .collect();
    let mut window_power: Vec<Complex32> = hann
        .iter()
        .map(|value| Complex32::new(*value, 0.0))
        .collect();
    forward.process(&mut window_power);
    window_power
        .iter_mut()
        .for_each(|value| *value = Complex32::new(value.norm_sqr(), 0.0));
    let window_correlation = autocorrelation(&mut window_power, inverse.as_ref());
    let (shortest, longest) = (SAMPLE_RATE / MAX_PITCH_HZ, SAMPLE_RATE / MIN_PITCH_HZ);
    let count = samples.len() / HOP + 1;
    let mut buffer = vec![Complex32::default(); WINDOW];
    let mut frames = Frames {
        bands: Vec::with_capacity(count),
        voicing: Vec::with_capacity(count),
    };
    for frame in 0..count {
        let center = (frame * HOP) as isize - (WINDOW / 2) as isize;
        for (n, value) in buffer.iter_mut().enumerate() {
            let sample = usize::try_from(center + n as isize)
                .ok()
                .and_then(|index| samples.get(index))
                .copied()
                .unwrap_or(0.0);
            *value = Complex32::new(sample * hann[n], 0.0);
        }
        forward.process(&mut buffer);
        let mut bands = [0f32; BANDS];
        for (bin, value) in buffer.iter_mut().enumerate() {
            let mirrored = if bin <= WINDOW / 2 { bin } else { WINDOW - bin };
            let power = value.norm_sqr() / scale;
            let band = band_of[mirrored];
            if let (Some(band), true) = (band, bin <= WINDOW / 2) {
                bands[band] += power;
            }
            *value = Complex32::new(if band.is_some() { power } else { 0.0 }, 0.0);
        }
        let correlation = autocorrelation(&mut buffer, inverse.as_ref());
        let energy = correlation[0].max(1e-20);
        let voicing = (shortest..longest)
            .map(|lag| {
                correlation[lag]
                    / energy
                    / (window_correlation[lag] / window_correlation[0]).max(1e-3)
            })
            .fold(f32::MIN, f32::max);
        frames.bands.push(bands);
        frames.voicing.push(voicing);
    }
    frames
}

fn speech_frames(samples: &[f32]) -> Vec<bool> {
    let frames = analyze_frames(samples);
    let count = frames.bands.len();
    let decibels: Vec<[f32; BANDS]> = frames
        .bands
        .iter()
        .map(|bands| bands.map(|power| 10.0 * (power + 1e-12).log10()))
        .collect();
    let mut active = vec![0usize; count];
    let mut high = vec![0usize; count];
    for band in 0..BANDS {
        let series: Vec<f32> = decibels.iter().map(|values| values[band]).collect();
        let floor = sliding_min(&box_filter(&series, 1), frames_of(FLOOR_SECONDS));
        for frame in 0..count {
            let floor = (floor[frame] + FLOOR_BIAS_DB).max(ABSOLUTE_FLOOR_DB);
            if series[frame] - floor > BAND_SNR_DB {
                active[frame] += 1;
                if band >= FIRST_HIGH_BAND {
                    high[frame] += 1;
                }
            }
        }
    }
    let level: Vec<f32> = frames
        .bands
        .iter()
        .map(|bands| 10.0 * (bands.iter().sum::<f32>() + 1e-12).log10())
        .collect();
    let smooth = box_filter(&level, 1);
    let steps: Vec<f32> = (0..count)
        .map(|frame| {
            (smooth[frame] - smooth[frame.saturating_sub(1)])
                .abs()
                .min(STEP_CLIP_DB)
        })
        .collect();
    let context = frames_of(CONTEXT_SECONDS);
    let modulation = box_filter(&steps, context);
    let loud: Vec<bool> = (0..count)
        .map(|frame| active[frame] >= MIN_BANDS && high[frame] >= MIN_HIGH_BANDS)
        .collect();
    let voiced: Vec<f32> = (0..count)
        .map(|frame| f32::from(u8::from(loud[frame] && frames.voicing[frame] > VOICING)))
        .collect();
    let share = box_filter(&voiced, context);
    (0..count)
        .map(|frame| {
            loud[frame] && share[frame] >= VOICED_SHARE && modulation[frame] >= MODULATION_DB
        })
        .collect()
}

fn segments_of(speech: &[bool]) -> Vec<(f64, f64)> {
    let hangover = frames_of(HANGOVER_SECONDS);
    let shortest = frames_of(MIN_SPEECH_SECONDS);
    let seconds = |frame: usize| (frame * HOP) as f64 / SAMPLE_RATE as f64;
    let mut segments = Vec::new();
    let mut open: Option<(usize, usize)> = None;
    for (frame, is_speech) in speech.iter().enumerate() {
        open = match (open, is_speech) {
            (None, true) => Some((frame, frame)),
            (Some((start, _)), true) => Some((start, frame)),
            (Some((start, end)), false) if frame - end > hangover => {
                segments.push((start, end + 1));
                None
            }
            (current, _) => current,
        };
    }
    segments.extend(open.map(|(start, end)| (start, end + 1)));
    segments
        .into_iter()
        .filter(|(start, end)| end - start >= shortest)
        .map(|(start, end)| (seconds(start), seconds(end)))
        .collect()
}

pub fn segments(path: &Path) -> Option<Segments> {
    let app = crate::render::gpu::context::app_handle()?;
    let key = fingerprint(path).ok()?;
    let slot = Arc::clone(
        ANALYSES
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(key.clone())
            .or_default(),
    );
    slot.get_or_init(|| analyze(app, path, &key)).clone()
}

fn analyze(app: &AppHandle, path: &Path, key: &str) -> Option<Segments> {
    let cached = cache_file(app, SPEECH_DIR, key, "json").ok()?;
    if let Some(analysis) = read_json_cache::<SpeechAnalysis>(&cached)
        .filter(|analysis| analysis.version == ANALYSIS_VERSION)
    {
        return Some(Arc::new(analysis.segments));
    }
    let samples = decode_mono(path, SAMPLE_RATE as u32)
        .inspect_err(|e| {
            log::warn!(
                "Could not analyze the speech in '{}': {}",
                path.display(),
                e
            )
        })
        .ok()?;
    let analysis = SpeechAnalysis {
        version: ANALYSIS_VERSION,
        segments: segments_of(&speech_frames(&samples)),
    };
    if let Err(e) = write_json_cache(&cached, &analysis) {
        log::warn!(
            "Could not save the speech analysis of '{}': {}",
            path.display(),
            e
        );
    }
    Some(Arc::new(analysis.segments))
}
