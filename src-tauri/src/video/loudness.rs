use crate::video::audio::{CHANNELS, MixGraph, SAMPLE_RATE};

const OFFSET_DB: f64 = -0.691;
const ABSOLUTE_GATE_LUFS: f64 = -70.0;
const RELATIVE_GATE_LU: f64 = -10.0;
const STEP_FRAMES: usize = SAMPLE_RATE as usize / 10;
const STEPS_PER_BLOCK: usize = 4;
const SAMPLE_BYTES: usize = 4;
const FRAME_BYTES: usize = CHANNELS * SAMPLE_BYTES;
const CHUNK_FRAMES: usize = SAMPLE_RATE as usize;
const CHUNK_BYTES: usize = CHUNK_FRAMES * FRAME_BYTES;
const MAX_GAIN_DB: f64 = 24.0;
const LIMITER_OVERSAMPLING: u32 = 4;
const OVERSAMPLED_CEILING_DB: f64 = -1.5;

const K_WEIGHTING: [Biquad; 2] = [
    Biquad::new(
        [1.53512485958697, -2.69169618940638, 1.19839281085285],
        [-1.69065929318241, 0.73248077421585],
    ),
    Biquad::new([1.0, -2.0, 1.0], [-1.99004745483398, 0.99007225036621]),
];

#[derive(Clone, Copy)]
struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
    state: [f64; 2],
}

impl Biquad {
    const fn new(b: [f64; 3], a: [f64; 2]) -> Self {
        Self {
            b,
            a,
            state: [0.0; 2],
        }
    }

    fn process(&mut self, input: f64) -> f64 {
        let output = self.b[0] * input + self.state[0];
        self.state[0] = self.b[1] * input - self.a[0] * output + self.state[1];
        self.state[1] = self.b[2] * input - self.a[1] * output;
        output
    }
}

struct Meter {
    filters: [[Biquad; 2]; CHANNELS],
    energy: f64,
    frames: usize,
    steps: Vec<f64>,
}

impl Meter {
    fn new() -> Self {
        Self {
            filters: [K_WEIGHTING; CHANNELS],
            energy: 0.0,
            frames: 0,
            steps: Vec::new(),
        }
    }

    fn add(&mut self, bytes: &[u8]) {
        for frame in bytes.as_chunks::<FRAME_BYTES>().0 {
            for (sample, filters) in frame
                .as_chunks::<SAMPLE_BYTES>()
                .0
                .iter()
                .zip(&mut self.filters)
            {
                let weighted = filters
                    .iter_mut()
                    .fold(f32::from_le_bytes(*sample) as f64, |value, filter| {
                        filter.process(value)
                    });
                self.energy += weighted * weighted;
            }
            self.frames += 1;
            if self.frames == STEP_FRAMES {
                self.steps.push(self.energy);
                self.energy = 0.0;
                self.frames = 0;
            }
        }
    }

    fn integrated(&self) -> Option<f64> {
        let blocks: Vec<f64> = self
            .steps
            .windows(STEPS_PER_BLOCK)
            .map(|steps| steps.iter().sum::<f64>() / (STEPS_PER_BLOCK * STEP_FRAMES) as f64)
            .collect();
        let gated_mean = |gate: f64| {
            let gated: Vec<f64> = blocks
                .iter()
                .copied()
                .filter(|energy| loudness(*energy) > gate)
                .collect();
            (!gated.is_empty()).then(|| gated.iter().sum::<f64>() / gated.len() as f64)
        };
        let relative_gate = loudness(gated_mean(ABSOLUTE_GATE_LUFS)?) + RELATIVE_GATE_LU;
        gated_mean(relative_gate.max(ABSOLUTE_GATE_LUFS)).map(loudness)
    }
}

fn loudness(energy: f64) -> f64 {
    OFFSET_DB + 10.0 * energy.log10()
}

fn stream(
    mix: &MixGraph,
    duration: f64,
    mut consume: impl FnMut(&[u8], f64) -> Result<(), String>,
) -> Result<(), String> {
    let mut audio = mix.open_libav("flt", SAMPLE_RATE, "stereo", Some(CHUNK_FRAMES as u32))?;
    let total = (duration * SAMPLE_RATE as f64).round() as usize * FRAME_BYTES;
    let mut bytes = Vec::with_capacity(CHUNK_BYTES);
    let mut done = 0;
    while done < total {
        bytes.clear();
        audio.read_interleaved(&mut bytes, CHUNK_BYTES.min(total - done))?;
        done += bytes.len();
        consume(&bytes, done as f64 / total as f64)?;
    }
    Ok(())
}

pub fn normalization_gain(
    mix: &MixGraph,
    duration: f64,
    target: f64,
    mut progress: impl FnMut(f64) -> Result<(), String>,
) -> Result<Option<f64>, String> {
    let mut meter = Meter::new();
    stream(mix, duration, |bytes, done| {
        meter.add(bytes);
        progress(done)
    })?;
    let Some(measured) = meter.integrated() else {
        return Ok(None);
    };
    let gain = (target - measured).min(MAX_GAIN_DB);
    log::info!(
        "Export loudness {:.2} LUFS, normalising by {:+.2} dB to {:.1} LUFS",
        measured,
        gain,
        target
    );
    Ok(Some(10f64.powf(gain / 20.0)))
}

pub fn limiter() -> String {
    format!(
        "aresample={},alimiter=limit={:.6}:level=0:latency=1,aresample={}",
        SAMPLE_RATE * LIMITER_OVERSAMPLING,
        10f64.powf(OVERSAMPLED_CEILING_DB / 20.0),
        SAMPLE_RATE
    )
}
