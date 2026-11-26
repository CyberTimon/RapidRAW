use std::f32::consts::TAU;
use std::hash::{Hash, Hasher};

use crate::video::audio::{CHANNELS, SAMPLE_RATE};
use crate::video::model::{FrameRate, Pace, ramp_offsets};

const WINDOW: usize = SAMPLE_RATE as usize / 24;
const HOP: usize = WINDOW / 2;
const SEARCH: isize = (HOP / 2) as isize;
const COARSE: usize = 4;
const LANES: usize = 16;

pub const MARGIN_SECONDS: f64 = 2.0 * WINDOW as f64 / SAMPLE_RATE as f64;

pub struct Schedule {
    offsets: Vec<f64>,
    frame: f64,
    speed: f64,
}

impl Hash for Schedule {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.offsets
            .iter()
            .chain([&self.frame, &self.speed])
            .for_each(|value| value.to_bits().hash(state));
    }
}

impl Schedule {
    pub fn new(pace: Pace, duration: i64, fps: FrameRate) -> Self {
        match pace {
            Pace::Constant(speed) => Self {
                offsets: Vec::new(),
                frame: 1.0,
                speed,
            },
            Pace::Ramp(keys) => Self {
                offsets: ramp_offsets(duration, keys, fps),
                frame: 1.0 / fps.value(),
                speed: 1.0,
            },
        }
    }

    pub fn varies(&self) -> bool {
        self.offsets.len() > 1
    }

    fn frame_speed(&self, index: usize) -> f64 {
        let index = index.min(self.offsets.len() - 2);
        (self.offsets[index + 1] - self.offsets[index]) / self.frame
    }

    pub fn speed_at(&self, local: f64) -> f64 {
        if !self.varies() {
            return self.speed;
        }
        self.frame_speed((local / self.frame).max(0.0) as usize)
    }

    pub fn source_at(&self, local: f64) -> f64 {
        if !self.varies() {
            return local * self.speed;
        }
        let last = self.offsets.len() - 1;
        let position = local / self.frame;
        if position <= 0.0 {
            return position * self.frame * self.frame_speed(0);
        }
        let index = position as usize;
        if index >= last {
            return self.offsets[last]
                + (local - last as f64 * self.frame) * self.frame_speed(last);
        }
        let fraction = position - index as f64;
        self.offsets[index] + fraction * (self.offsets[index + 1] - self.offsets[index])
    }
}

fn similarities(mono: &[f32], first: usize, count: usize, natural: usize, step: usize) -> Vec<f32> {
    let gather = |from: usize, length: usize| -> Vec<f32> {
        mono[from..]
            .iter()
            .step_by(step)
            .take(length)
            .copied()
            .collect()
    };
    let reference = gather(natural, HOP.div_ceil(step));
    let padded = count.next_multiple_of(LANES);
    let mut candidates = gather(first, count + reference.len() - 1);
    candidates.resize(padded + reference.len() - 1, 0.0);
    let mut scores = Vec::with_capacity(padded);
    for block in (0..count).step_by(LANES) {
        let (mut dot, mut energy) = ([0.0f32; LANES], [0.0f32; LANES]);
        for (offset, &target) in reference.iter().enumerate() {
            let values = &candidates[block + offset..][..LANES];
            for ((sum, power), value) in dot.iter_mut().zip(&mut energy).zip(values) {
                *sum += value * target;
                *power += value * value;
            }
        }
        scores.extend(
            dot.iter()
                .zip(energy)
                .map(|(dot, energy)| dot / energy.max(1e-9).sqrt()),
        );
    }
    scores.truncate(count);
    scores
}

fn best_start(mono: &[f32], natural: isize, target: isize) -> isize {
    let last = mono.len() as isize - WINDOW as isize;
    if last < 0 || natural < 0 || natural > last {
        return target;
    }
    let low = (target - SEARCH).clamp(0, last);
    let high = (target + SEARCH).clamp(0, last);
    if low >= high {
        return low;
    }
    let pick = |favored: isize, from: isize, to: isize, step: usize| {
        let count = (to - from) as usize / step + 1;
        let scores = similarities(mono, from as usize, count, natural as usize, step);
        (from..=to)
            .step_by(step)
            .zip(scores.iter().copied())
            .fold(
                (favored, scores[(favored - from) as usize / step]),
                |best, next| if next.1 > best.1 { next } else { best },
            )
            .0
    };
    let favored = target.clamp(low, high);
    let coarse = pick(
        favored,
        low + (favored - low).rem_euclid(COARSE as isize),
        high,
        COARSE,
    );
    pick(
        coarse,
        (coarse - COARSE as isize).max(low),
        (coarse + COARSE as isize).min(high),
        1,
    )
}

pub fn stretch(source: &[f32], length: usize, position: impl Fn(f64) -> f64) -> Vec<f32> {
    let frames = source.len() / CHANNELS;
    let mono: Vec<f32> = source
        .as_chunks::<CHANNELS>()
        .0
        .iter()
        .map(|frame| frame.iter().sum())
        .collect();
    let window: Vec<f32> = (0..WINDOW)
        .map(|index| 0.5 - 0.5 * (TAU * index as f32 / WINDOW as f32).cos())
        .collect();
    let rate = SAMPLE_RATE as f64;
    let mut output = vec![0.0f32; length * CHANNELS];
    let mut previous: Option<isize> = None;
    let mut origin = -(HOP as isize);
    while origin < length as isize {
        let center = (origin + HOP as isize) as f64 / rate;
        let target = (position(center) * rate).round() as isize - HOP as isize;
        let start = previous.map_or(target, |previous| {
            best_start(&mono, previous + HOP as isize, target)
        });
        for (index, weight) in window.iter().enumerate() {
            let (out, read) = (origin + index as isize, start + index as isize);
            if out < 0 || out >= length as isize || read < 0 || read >= frames as isize {
                continue;
            }
            for channel in 0..CHANNELS {
                output[out as usize * CHANNELS + channel] +=
                    weight * source[read as usize * CHANNELS + channel];
            }
        }
        previous = Some(start);
        origin += HOP as isize;
    }
    output
}
