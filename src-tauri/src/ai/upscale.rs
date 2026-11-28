use crate::ai::base_cache::{BaseCache, entry_key, source_string};
use crate::ai::denoise::DenoiseMethod;
use crate::app::state::{AppState, LoadedImage};
use crate::decode::formats::is_raw_file;
use crate::library::sidecars::parse_virtual_path;
use crate::render::adjustment_utils::is_effect_enabled;
use crate::render::color_space::working_luma;
use image::{DynamicImage, GenericImageView, Rgb32FImage};
use rayon::prelude::*;
use std::borrow::Cow;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::Manager;

pub const FACTOR: u32 = 2;
const MODEL_TAG: &str = "upscale-v4";
const GAMMA: f32 = 2.2;
const DETAIL_GAIN: f32 = 1.5;
const DETAIL_NOISE_FLOOR: f32 = 2.0;
const DETAIL_OVERSHOOT: f32 = 0.25;
const DETAIL_BAND: usize = 32;
const DETAIL_SAMPLE_STEP: usize = 8;
const PRESHARPEN: f32 = 0.35;
const PRESHARPEN_FLOOR: f32 = 0.002;

static CACHE: BaseCache = BaseCache::new(
    "ai_upscale",
    "rrup",
    b"RRUP0002",
    b"RRUP0001",
    "ai-upscale",
    "AI upscale",
);

type Session = Arc<Mutex<ort::session::Session>>;

pub fn initialize_cache_dir(cache_dir: &Path) {
    CACHE.initialize_dir(cache_dir);
}

pub fn set_disk_cache_limit_gb(limit_gb: u32) {
    CACHE.set_disk_limit_gb(limit_gb);
}

pub fn cache_epoch() -> u64 {
    CACHE.epoch()
}

pub fn is_enabled(adjustments: &serde_json::Value) -> bool {
    is_effect_enabled(adjustments, "superResolution", "aiUpscaleEnabled")
}

fn denoise_input(adjustments: &serde_json::Value) -> Option<DenoiseMethod> {
    crate::ai::denoise::is_enabled(adjustments)
        .then(|| DenoiseMethod::from_adjustments(adjustments))
}

fn key(path: &str, denoise: Option<DenoiseMethod>) -> String {
    let input = denoise.map_or("none", DenoiseMethod::tag);
    entry_key(&source_string(path), &format!("{MODEL_TAG}+{input}"))
}

pub fn scale_between(base: &DynamicImage, prepared: &DynamicImage) -> f32 {
    if base.width() == 0 {
        1.0
    } else {
        prepared.width() as f32 / base.width() as f32
    }
}

fn taps(o: usize, len: usize) -> (usize, usize) {
    let i = o / 2;
    let j = if o.is_multiple_of(2) {
        i.saturating_sub(1)
    } else {
        (i + 1).min(len - 1)
    };
    (i, j)
}

fn upsample_add(dst: &mut [f32], src: &[f32], width: usize, height: usize) {
    let out_w = width * FACTOR as usize;
    dst.par_chunks_exact_mut(out_w * 3)
        .enumerate()
        .for_each(|(oy, row)| {
            let (y0, y1) = taps(oy, height);
            let (r0, r1) = (&src[y0 * width * 3..], &src[y1 * width * 3..]);
            for ox in 0..out_w {
                let (x0, x1) = taps(ox, width);
                for c in 0..3 {
                    let near = 0.75 * r0[x0 * 3 + c] + 0.25 * r0[x1 * 3 + c];
                    let far = 0.75 * r1[x0 * 3 + c] + 0.25 * r1[x1 * 3 + c];
                    row[ox * 3 + c] += 0.75 * near + 0.25 * far;
                }
            }
        });
}

fn detail_amount(adjustments: &serde_json::Value) -> f32 {
    (adjustments["aiUpscaleDetail"].as_f64().unwrap_or(30.0) as f32 / 100.0).clamp(0.0, 1.0)
}

struct DetailField<'a> {
    source_luma: &'a [f32],
    width: usize,
    height: usize,
}

struct DetailScratch {
    width: usize,
    blend: Vec<f32>,
    signal: Vec<f32>,
    residual: Vec<f32>,
    lo: Vec<f32>,
    hi: Vec<f32>,
    energy: Vec<f32>,
}

impl DetailScratch {
    fn new(width: usize, rows: usize) -> Self {
        let out_w = width * FACTOR as usize;
        let n = rows * out_w;
        Self {
            width: out_w,
            blend: vec![0.0; width],
            signal: vec![0.0; n],
            residual: vec![0.0; n],
            lo: vec![0.0; n],
            hi: vec![0.0; n],
            energy: vec![0.0; n],
        }
    }

    fn span(&self, slot: usize) -> std::ops::Range<usize> {
        slot * self.width..(slot + 1) * self.width
    }

    fn load(&mut self, slot: usize, (signal, residual): &(Vec<f32>, Vec<f32>)) {
        let span = self.span(slot);
        self.signal[span.clone()].copy_from_slice(signal);
        self.residual[span].copy_from_slice(residual);
        self.local_stats(slot);
    }

    fn local_stats(&mut self, slot: usize) {
        let span = self.span(slot);
        let (signal, residual) = (&self.signal[span.clone()], &self.residual[span.clone()]);
        let (lo, hi, energy) = (
            &mut self.lo[span.clone()],
            &mut self.hi[span.clone()],
            &mut self.energy[span],
        );
        let last = signal.len() - 1;
        for x in 0..signal.len() {
            let (l, r) = (x.saturating_sub(1), (x + 1).min(last));
            lo[x] = signal[l].min(signal[x]).min(signal[r]);
            hi[x] = signal[l].max(signal[x]).max(signal[r]);
            energy[x] =
                residual[l] * residual[l] + residual[x] * residual[x] + residual[r] * residual[r];
        }
    }
}

impl DetailField<'_> {
    fn out_width(&self) -> usize {
        self.width * FACTOR as usize
    }

    fn row(&self, oy: usize, pixels: &[f32], scratch: &mut DetailScratch, slot: usize) {
        let (y0, y1) = taps(oy, self.height);
        let near = &self.source_luma[y0 * self.width..][..self.width];
        let far = &self.source_luma[y1 * self.width..][..self.width];
        for ((b, n), f) in scratch.blend.iter_mut().zip(near).zip(far) {
            *b = 0.75 * n + 0.25 * f;
        }
        let span = scratch.span(slot);
        let blend = &scratch.blend;
        let last = self.width - 1;
        let [luma_r, luma_g, luma_b] = working_luma();
        for (x, (pair, (s, r))) in pixels
            .as_chunks::<6>()
            .0
            .iter()
            .zip(
                scratch.signal[span.clone()]
                    .as_chunks_mut::<2>()
                    .0
                    .iter_mut()
                    .zip(scratch.residual[span].as_chunks_mut::<2>().0.iter_mut()),
            )
            .enumerate()
        {
            let centre = 0.75 * blend[x];
            let up = [
                centre + 0.25 * blend[x.saturating_sub(1)],
                centre + 0.25 * blend[(x + 1).min(last)],
            ];
            for k in 0..2 {
                let luma =
                    luma_r * pair[k * 3] + luma_g * pair[k * 3 + 1] + luma_b * pair[k * 3 + 2];
                s[k] = luma.max(0.0).sqrt();
                r[k] = s[k] - up[k].max(0.0).sqrt();
            }
        }
    }

    fn row_owned(&self, oy: usize, pixels: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let mut scratch = DetailScratch::new(self.width, 1);
        self.row(oy, pixels, &mut scratch, 0);
        (scratch.signal, scratch.residual)
    }

    fn noise_sigma(&self, pixels: &[f32]) -> f32 {
        let stride = self.out_width() * 3;
        let rows = pixels.len() / stride;
        let mut samples: Vec<f32> = (0..rows.div_ceil(DETAIL_SAMPLE_STEP))
            .into_par_iter()
            .flat_map_iter(|i| {
                let oy = i * DETAIL_SAMPLE_STEP;
                self.row_owned(oy, &pixels[oy * stride..][..stride])
                    .1
                    .into_iter()
                    .step_by(DETAIL_SAMPLE_STEP)
                    .map(f32::abs)
            })
            .collect();
        if samples.is_empty() {
            return 0.0;
        }
        let mid = samples.len() / 2;
        1.4826 * *samples.select_nth_unstable_by(mid, f32::total_cmp).1
    }
}

fn soft_limit(value: f32, lo: f32, hi: f32, knee: f32) -> f32 {
    if knee <= 1e-6 {
        value.clamp(lo, hi)
    } else if value > hi {
        hi + knee * (1.0 - (-(value - hi) / knee).exp())
    } else if value < lo {
        lo - knee * (1.0 - (-(lo - value) / knee).exp())
    } else {
        value
    }
}

fn sqrt_luma_row(pixels: &[f32], out: &mut [f32]) {
    let [luma_r, luma_g, luma_b] = working_luma();
    for (q, p) in out.iter_mut().zip(pixels.as_chunks::<3>().0) {
        *q = ((luma_r * p[0] + luma_g * p[1] + luma_b * p[2]).max(0.0) + PRESHARPEN_FLOOR).sqrt();
    }
}

fn binomial_blur(rows: [&[f32]; 5], v: &mut [f32], out: &mut [f32]) {
    let w = out.len();
    for x in 0..w {
        v[x + 2] = (rows[0][x] + rows[4][x] + 4.0 * (rows[1][x] + rows[3][x]) + 6.0 * rows[2][x])
            * (1.0 / 16.0);
    }
    (v[0], v[1]) = (v[2], v[2]);
    (v[w + 2], v[w + 3]) = (v[w + 1], v[w + 1]);
    for x in 0..w {
        out[x] = (v[x] + v[x + 4] + 4.0 * (v[x + 1] + v[x + 3]) + 6.0 * v[x + 2]) * (1.0 / 16.0);
    }
}

fn presharpen_threshold(base: &Rgb32FImage) -> Option<f32> {
    let (w, h) = (base.width() as usize, base.height() as usize);
    let raw = base.as_raw();
    let mut samples: Vec<f32> = (0..h)
        .into_par_iter()
        .step_by(16)
        .flat_map_iter(|y| {
            let rows: [Vec<f32>; 5] = std::array::from_fn(|k| {
                let row = (y + k).saturating_sub(2).min(h - 1);
                let mut q = vec![0.0; w];
                sqrt_luma_row(&raw[row * w * 3..][..w * 3], &mut q);
                q
            });
            let (mut v, mut blur) = (vec![0.0; w + 4], vec![0.0; w]);
            binomial_blur(rows.each_ref().map(Vec::as_slice), &mut v, &mut blur);
            (0..w)
                .step_by(5)
                .map(|x| (rows[2][x] - blur[x]).abs())
                .collect::<Vec<_>>()
        })
        .collect();
    if samples.is_empty() {
        return None;
    }
    let mid = samples.len() / 2;
    let noise = *samples.select_nth_unstable_by(mid, f32::total_cmp).1 * 1.4826;
    Some((1.5 * noise).powi(2).max(1e-12))
}

fn presharpen(image: &mut Rgb32FImage, threshold: f32) {
    let (w, h) = (image.width() as usize, image.height() as usize);
    let mut q = vec![0.0f32; w * h];
    q.par_chunks_mut(w)
        .zip(image.as_raw().par_chunks(w * 3))
        .for_each(|(q, pixels)| sqrt_luma_row(pixels, q));
    let row_at = |y: isize| {
        let y = y.clamp(0, h as isize - 1) as usize;
        &q[y * w..(y + 1) * w]
    };
    let strength = 4.5 * PRESHARPEN;
    let taper = 0.3 / threshold.sqrt();

    image.par_chunks_mut(w * 3).enumerate().for_each_init(
        || {
            (
                vec![0.0f32; w + 4],
                vec![0.0f32; w],
                vec![0.0f32; w + 2],
                vec![0.0f32; w + 2],
            )
        },
        |(v, blur, lo, hi), (y, row)| {
            binomial_blur(
                std::array::from_fn(|k| row_at(y as isize + k as isize - 2)),
                v,
                blur,
            );
            let r: [&[f32]; 3] = std::array::from_fn(|k| row_at(y as isize + k as isize - 1));
            for x in 0..w {
                lo[x + 1] = r[0][x].min(r[1][x]).min(r[2][x]);
                hi[x + 1] = r[0][x].max(r[1][x]).max(r[2][x]);
            }
            (lo[0], hi[0], lo[w + 1], hi[w + 1]) = (lo[1], hi[1], lo[w], hi[w]);
            let center = r[1];
            for (x, p) in row.as_chunks_mut::<3>().0.iter_mut().enumerate() {
                let qc = center[x];
                let d = qc - blur[x];
                let d = d * d * d / (d * d + threshold);
                let d = d / (1.0 + d.abs() * taper);
                let min = lo[x].min(lo[x + 1]).min(lo[x + 2]);
                let max = hi[x].max(hi[x + 1]).max(hi[x + 2]);
                let delta = strength * d;
                let range = max - min;
                let up_room = max - qc + range * 0.15 + 0.004;
                let down_room = qc - min + range * 0.05 + 0.002;
                let up = delta.max(0.0);
                let down = (-delta).max(0.0) * 0.7;
                let qn = qc + up * up_room / (up_room + up) - down * down_room / (down_room + down);
                let l = qc * qc - PRESHARPEN_FLOOR;
                let ln = (qn * qn - PRESHARPEN_FLOOR).max(0.0);
                if l > 1e-6 {
                    let peak = p[0].max(p[1]).max(p[2]);
                    let mut ratio = ln / l;
                    if ratio > 1.0 && peak * ratio > 1.0 {
                        ratio = (1.0 / peak).max(1.0);
                    }
                    p.iter_mut().for_each(|c| *c *= ratio);
                } else {
                    p.iter_mut().for_each(|c| *c = (*c + ln - l).max(0.0));
                }
            }
        },
    );
}

fn model_input<'a>(
    image: Cow<'a, DynamicImage>,
    base: &DynamicImage,
    path: &str,
) -> Cow<'a, Rgb32FImage> {
    let threshold = is_raw_file(parse_virtual_path(path).0)
        .then(|| match base.as_rgb32f() {
            Some(base) => presharpen_threshold(base),
            None => presharpen_threshold(&base.to_rgb32f()),
        })
        .flatten();
    match image {
        Cow::Borrowed(DynamicImage::ImageRgb32F(image)) if threshold.is_none() => {
            Cow::Borrowed(image)
        }
        image => {
            let mut image = match image {
                Cow::Borrowed(image) => image.to_rgb32f(),
                Cow::Owned(image) => image.into_rgb32f(),
            };
            if let Some(threshold) = threshold {
                presharpen(&mut image, threshold);
            }
            Cow::Owned(image)
        }
    }
}

fn enhance_detail(out: &mut Rgb32FImage, source: &Rgb32FImage, amount: f32) {
    let [luma_r, luma_g, luma_b] = working_luma();
    let source_luma: Vec<f32> = source
        .as_raw()
        .par_chunks_exact(3)
        .map(|p| luma_r * p[0] + luma_g * p[1] + luma_b * p[2])
        .collect();
    let field = DetailField {
        source_luma: &source_luma,
        width: source.width() as usize,
        height: source.height() as usize,
    };
    let out_w = field.out_width();
    let stride = out_w * 3;
    let band_len = DETAIL_BAND * stride;

    let pixels = out.as_raw();
    let noise_energy = 9.0 * DETAIL_NOISE_FLOOR * field.noise_sigma(pixels).powi(2);
    let edges: Vec<[(Vec<f32>, Vec<f32>); 2]> = pixels
        .par_chunks(band_len)
        .enumerate()
        .map(|(band, chunk)| {
            let last = chunk.len() / stride - 1;
            [0, last]
                .map(|i| field.row_owned(band * DETAIL_BAND + i, &chunk[i * stride..][..stride]))
        })
        .collect();

    let strength = DETAIL_GAIN * amount;
    out.par_chunks_mut(band_len).enumerate().for_each_init(
        || DetailScratch::new(field.width, 3),
        |scratch, (band, chunk)| {
            let first = band * DETAIL_BAND;
            let rows = chunk.len() / stride;
            scratch.load(
                0,
                if band > 0 {
                    &edges[band - 1][1]
                } else {
                    &edges[band][0]
                },
            );
            field.row(first, &chunk[..stride], scratch, 1);
            scratch.local_stats(1);
            for i in 0..rows {
                let next = (i + 2) % 3;
                if i + 1 < rows {
                    field.row(
                        first + i + 1,
                        &chunk[(i + 1) * stride..][..stride],
                        scratch,
                        next,
                    );
                    scratch.local_stats(next);
                } else {
                    scratch.load(next, edges.get(band + 1).map_or(&edges[band][1], |e| &e[0]));
                }
                let [a, b, c] = [i % 3, (i + 1) % 3, next].map(|slot| slot * out_w);
                let row = &mut chunk[i * stride..][..stride];
                for (x, px) in row.as_chunks_mut::<3>().0.iter_mut().enumerate() {
                    let s = scratch.signal[b + x];
                    let local_energy =
                        scratch.energy[a + x] + scratch.energy[b + x] + scratch.energy[c + x];
                    if s <= 1e-4 || local_energy <= noise_energy {
                        continue;
                    }
                    let weight = 1.0 - noise_energy / local_energy;
                    let lo = scratch.lo[a + x]
                        .min(scratch.lo[b + x])
                        .min(scratch.lo[c + x]);
                    let hi = scratch.hi[a + x]
                        .max(scratch.hi[b + x])
                        .max(scratch.hi[c + x]);
                    let target = s + strength * weight * scratch.residual[b + x];
                    let limited = soft_limit(target, lo, hi, DETAIL_OVERSHOOT * (hi - lo));
                    let gain = (limited.max(0.0) / s).powi(2);
                    px.iter_mut().for_each(|v| *v *= gain);
                }
            }
        },
    );
}

fn inputs(adjustments: &serde_json::Value) -> Vec<Option<DenoiseMethod>> {
    match denoise_input(adjustments) {
        Some(method) => vec![Some(method), None],
        None => vec![None],
    }
}

pub fn apply_ai_upscale<'a>(
    base: &DynamicImage,
    image: Cow<'a, DynamicImage>,
    path: &str,
    adjustments: &serde_json::Value,
) -> Cow<'a, DynamicImage> {
    if !is_enabled(adjustments) {
        return image;
    }
    let (w, h) = base.dimensions();
    if image.dimensions() != (w, h) {
        return image;
    }
    let source = source_string(path);
    let load = |input| {
        CACHE
            .load(&key(path, input), &source)
            .filter(|entry| (entry.width, entry.height) == (w * FACTOR, h * FACTOR))
    };

    let strength = crate::ai::denoise::blend_strength(adjustments);
    let upscaled = match denoise_input(adjustments).filter(|_| strength.0 > 0.0) {
        None => load(None).map(|entry| entry.to_rgb32f()),
        Some(method) => load(Some(method)).and_then(|denoised| {
            if strength.0 >= 1.0 && strength.1 <= 0.0 {
                return Some(denoised.to_rgb32f());
            }
            let mut out = load(None)?.to_rgb32f();
            crate::ai::denoise::blend_into(&mut out, &denoised.data, strength);
            Some(out)
        }),
    };
    let Some(mut out) = upscaled else {
        return image;
    };
    let amount = detail_amount(adjustments);
    if amount > 0.0 {
        enhance_detail(&mut out, &model_input(image, base, path), amount);
    }
    Cow::Owned(DynamicImage::ImageRgb32F(out))
}

fn input_for(
    base: &DynamicImage,
    path: &str,
    denoise: Option<DenoiseMethod>,
) -> Result<Rgb32FImage, String> {
    let input = match denoise {
        None => Cow::Borrowed(base),
        Some(method) => crate::ai::denoise::full_strength(path, method)
            .filter(|entry| (entry.width, entry.height) == base.dimensions())
            .map(|entry| Cow::Owned(DynamicImage::ImageRgb32F(entry.to_rgb32f())))
            .ok_or_else(|| "AI denoise result is not available".to_string())?,
    };
    Ok(model_input(input, base, path).into_owned())
}

fn run_upscaler(
    input: &Rgb32FImage,
    session: &Session,
    on_progress: &(dyn Fn(f32) + Sync),
) -> Result<Rgb32FImage, String> {
    let (w, h) = input.dimensions();
    let mut encoded = input.clone();
    encoded
        .par_iter_mut()
        .for_each(|v| *v = v.clamp(0.0, 1.0).powf(1.0 / GAMMA));

    let mut output = crate::ai::tiling::run_ai_upscale(&encoded, session, FACTOR, on_progress)
        .map_err(|e| e.to_string())?;
    drop(encoded);
    if output.dimensions() != (w * FACTOR, h * FACTOR) {
        return Err(format!(
            "Upscale model returned {}x{} for a {}x{} input",
            output.width(),
            output.height(),
            w,
            h
        ));
    }
    output.par_iter_mut().for_each(|v| *v = v.powf(GAMMA));

    let excess: Vec<f32> = input
        .as_raw()
        .par_iter()
        .map(|&v| v - v.clamp(0.0, 1.0))
        .collect();
    upsample_add(&mut output, &excess, w as usize, h as usize);
    Ok(output)
}

async fn load_session(app_handle: tauri::AppHandle) -> Result<Session, String> {
    let state = app_handle.state::<AppState>();
    crate::ai::models::get_or_init_upscale_model(&app_handle, &state.ai_state, &state.ai_init_lock)
        .await
        .map_err(|e| e.to_string())
}

fn waiting_for_denoise(path: &str, denoise: Option<DenoiseMethod>) -> bool {
    denoise.is_some_and(|method| {
        crate::ai::denoise::is_generating(path)
            || crate::ai::denoise::full_strength(path, method).is_none()
    })
}

pub fn ensure_generated(
    app_handle: &tauri::AppHandle,
    loaded_image: &LoadedImage,
    adjustments: &serde_json::Value,
) {
    if !is_enabled(adjustments) {
        return;
    }
    let path = loaded_image.path.clone();
    for input in inputs(adjustments) {
        if waiting_for_denoise(&path, input) {
            continue;
        }
        let key = key(&path, input);
        if CACHE.is_pending(&key) {
            return;
        }
        let Some(job) = CACHE.job(key, &loaded_image.image, source_string(&path)) else {
            continue;
        };
        let path = path.clone();
        CACHE.spawn(
            app_handle,
            loaded_image,
            job,
            false,
            load_session(app_handle.clone()),
            move |session, base, progress| {
                run_upscaler(&input_for(base, &path, input)?, &session, progress)
            },
        );
        return;
    }
}

pub fn has_cached_entry(path: &str, adjustments: &serde_json::Value) -> bool {
    let source = source_string(path);
    inputs(adjustments)
        .into_iter()
        .all(|input| CACHE.has_entry(&key(path, input), &source))
}

pub fn is_generating(path: &str) -> bool {
    [None, Some(DenoiseMethod::Nind), Some(DenoiseMethod::Bm3d)]
        .into_iter()
        .any(|input| CACHE.is_pending(&key(path, input)))
}

pub fn generate_for_base(
    app_handle: &tauri::AppHandle,
    path: &str,
    base: &DynamicImage,
    adjustments: &serde_json::Value,
) -> Result<bool, String> {
    for input in inputs(adjustments) {
        if waiting_for_denoise(path, input) {
            return if crate::ai::denoise::is_generating(path) {
                Ok(false)
            } else {
                Err("AI denoise result is not available".to_string())
            };
        }
        let generated = CACHE.generate_blocking(
            app_handle,
            path,
            base,
            key(path, input),
            load_session(app_handle.clone()),
            |session, base, progress| {
                run_upscaler(&input_for(base, path, input)?, &session, progress)
            },
        )?;
        if !generated {
            return Ok(false);
        }
    }
    Ok(true)
}

#[tauri::command]
pub fn clear_ai_upscale_cache() -> Result<(), String> {
    CACHE.clear()
}
