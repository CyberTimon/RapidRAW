use crate::ai_base_cache::{BaseCache, CachedBase, HALF_CHUNK, entry_key, source_string};
use crate::app_state::{AppState, LoadedImage};
use half::f16;
use half::slice::HalfFloatSliceExt;
use image::{DynamicImage, GenericImageView, Rgb32FImage, imageops};
use rayon::prelude::*;
use std::borrow::Cow;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::Manager;

const MODEL_TAG: &str = "nind-v3";
const BM3D_TAG: &str = "bm3d-v1";
const BM3D_INTENSITY: f32 = 0.15;

static CACHE: BaseCache = BaseCache::new(
    "ai_denoise",
    "rrdn",
    b"RRDN0002",
    "ai-denoise",
    "AI denoise",
);

pub fn initialize_cache_dir(cache_dir: &Path) {
    CACHE.initialize_dir(cache_dir);
}

pub fn set_disk_cache_limit_gb(limit_gb: u32) {
    CACHE.set_disk_limit_gb(limit_gb);
}

pub fn is_enabled(adjustments: &serde_json::Value) -> bool {
    crate::image_processing::is_effect_enabled(adjustments, "noiseReduction", "aiDenoiseEnabled")
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum DenoiseMethod {
    Nind,
    Bm3d,
}

impl DenoiseMethod {
    const ALL: [Self; 2] = [Self::Nind, Self::Bm3d];

    pub fn from_adjustments(adjustments: &serde_json::Value) -> Self {
        match adjustments["aiDenoiseMethod"].as_str() {
            Some("bm3d") => Self::Bm3d,
            _ => Self::Nind,
        }
    }

    pub fn tag(self) -> &'static str {
        match self {
            Self::Nind => MODEL_TAG,
            Self::Bm3d => BM3D_TAG,
        }
    }
}

type Session = Arc<Mutex<ort::session::Session>>;

pub fn cache_epoch() -> u64 {
    CACHE.epoch()
}

pub fn full_strength(path: &str, method: DenoiseMethod) -> Option<Arc<CachedBase>> {
    let source = source_string(path);
    CACHE.load(&entry_key(&source, method.tag()), &source)
}

pub fn blend_strength(adjustments: &serde_json::Value) -> (f32, f32) {
    let amount =
        (adjustments["aiDenoiseAmount"].as_f64().unwrap_or(100.0) as f32 / 100.0).clamp(0.0, 1.0);
    let detail =
        (adjustments["aiDenoiseDetail"].as_f64().unwrap_or(0.0) as f32 / 100.0).clamp(0.0, 1.0);
    (amount, detail)
}

pub fn blend_into(out: &mut [f32], denoised: &[f16], (amount, detail): (f32, f32)) {
    let luma_keep = 1.0 - amount * (1.0 - detail);
    let chroma_keep = 1.0 - amount;

    out.par_chunks_mut(HALF_CHUNK)
        .zip(denoised.par_chunks(HALF_CHUNK))
        .for_each(|(chunk, dn_chunk)| {
            let mut dn_values = vec![0.0f32; dn_chunk.len()];
            dn_chunk.convert_to_f32_slice(&mut dn_values);
            for (px, dn) in chunk
                .as_chunks_mut::<3>()
                .0
                .iter_mut()
                .zip(dn_values.as_chunks::<3>().0)
            {
                let r = [px[0] - dn[0], px[1] - dn[1], px[2] - dn[2]];
                let r_luma = 0.2126 * r[0] + 0.7152 * r[1] + 0.0722 * r[2];
                for c in 0..3 {
                    px[c] = dn[c] + chroma_keep * (r[c] - r_luma) + luma_keep * r_luma;
                }
            }
        });
}

pub fn apply_ai_denoise<'a>(
    base: &'a DynamicImage,
    path: &str,
    adjustments: &serde_json::Value,
) -> Cow<'a, DynamicImage> {
    if !is_enabled(adjustments) {
        return Cow::Borrowed(base);
    }

    let strength = blend_strength(adjustments);
    if strength.0 <= 0.0 {
        return Cow::Borrowed(base);
    }

    let method = DenoiseMethod::from_adjustments(adjustments);
    let Some(entry) = full_strength(path, method) else {
        return Cow::Borrowed(base);
    };

    let (w, h) = base.dimensions();
    let resized: Option<Vec<f16>> = ((entry.width, entry.height) != (w, h)).then(|| {
        let resized = imageops::resize(&entry.to_rgb32f(), w, h, imageops::FilterType::Triangle);
        resized
            .as_raw()
            .par_iter()
            .map(|v| f16::from_f32(*v))
            .collect()
    });
    let denoised: &[f16] = resized.as_deref().unwrap_or(&entry.data);

    let mut out = base.to_rgb32f();
    blend_into(&mut out, denoised, strength);

    Cow::Owned(DynamicImage::ImageRgb32F(out))
}

fn restore_low_frequencies(denoised: &mut Rgb32FImage, source: &Rgb32FImage) {
    const FACTOR: usize = 64;
    let (w, h) = (source.width() as usize, source.height() as usize);
    let (sw, sh) = (w.div_ceil(FACTOR), h.div_ceil(FACTOR));
    if sw < 2 || sh < 2 {
        return;
    }

    let src = source.as_raw();
    let dn = denoised.as_raw();
    let planes: Vec<Vec<f32>> = (0..3)
        .map(|c| {
            let mut plane = vec![0.0f32; sw * sh];
            plane
                .par_chunks_exact_mut(sw)
                .enumerate()
                .for_each(|(sy, row)| {
                    let y_range = sy * FACTOR..((sy + 1) * FACTOR).min(h);
                    for (sx, out) in row.iter_mut().enumerate() {
                        let x_range = sx * FACTOR..((sx + 1) * FACTOR).min(w);
                        let mut acc = 0.0f32;
                        for y in y_range.clone() {
                            for x in x_range.clone() {
                                let i = (y * w + x) * 3 + c;
                                acc += src[i] - dn[i];
                            }
                        }
                        *out = acc / (y_range.len() * x_range.len()) as f32;
                    }
                });
            for _ in 0..3 {
                box_filter(&mut plane, sw, sh, 1, 3);
            }
            plane
        })
        .collect();

    denoised
        .par_chunks_exact_mut(w * 3)
        .enumerate()
        .for_each(|(y, row)| {
            let v = (y as f32 + 0.5) / h as f32;
            for x in 0..w {
                let tap = BilinearTap::new((x as f32 + 0.5) / w as f32, v, sw, sh);
                for (c, plane) in planes.iter().enumerate() {
                    row[x * 3 + c] += tap.sample(plane);
                }
            }
        });
}

fn run_denoiser(
    base: &DynamicImage,
    session: Option<&Session>,
    on_progress: &(dyn Fn(f32) + Sync),
) -> Result<Rgb32FImage, String> {
    let source = base.to_rgb32f();
    let mut output = match session {
        Some(session) => crate::ai_processing::run_ai_denoise(&source, session, on_progress)
            .map_err(|e| e.to_string())?
            .into_rgb32f(),
        None => crate::bm3d::denoise(&source, BM3D_INTENSITY, on_progress),
    };

    output
        .par_iter_mut()
        .zip(source.as_raw().par_iter())
        .for_each(|(dn, &src)| *dn += src - src.clamp(0.0, 1.0));

    restore_low_frequencies(&mut output, &source);
    Ok(output)
}

async fn load_session(
    app_handle: tauri::AppHandle,
    method: DenoiseMethod,
) -> Result<Option<Session>, String> {
    if method != DenoiseMethod::Nind {
        return Ok(None);
    }
    let state = app_handle.state::<AppState>();
    crate::ai_processing::get_or_init_denoise_model(
        &app_handle,
        &state.ai_state,
        &state.ai_init_lock,
    )
    .await
    .map(Some)
    .map_err(|e| e.to_string())
}

pub fn ensure_generated(
    app_handle: &tauri::AppHandle,
    loaded_image: &LoadedImage,
    adjustments: &serde_json::Value,
) {
    if !is_enabled(adjustments) {
        return;
    }

    let source = source_string(&loaded_image.path);
    let method = DenoiseMethod::from_adjustments(adjustments);
    let Some(job) = CACHE.job(
        entry_key(&source, method.tag()),
        &loaded_image.image,
        source,
    ) else {
        return;
    };
    let session = load_session(app_handle.clone(), method);
    CACHE.spawn(
        app_handle,
        loaded_image,
        job,
        true,
        session,
        |session, base, progress| run_denoiser(base, session.as_ref(), progress),
    );
}

pub fn has_cached_entry(path: &str, method: DenoiseMethod) -> bool {
    let source = source_string(path);
    CACHE.has_entry(&entry_key(&source, method.tag()), &source)
}

pub fn is_generating(path: &str) -> bool {
    let source = source_string(path);
    DenoiseMethod::ALL
        .iter()
        .any(|&method| CACHE.is_pending(&entry_key(&source, method.tag())))
}

pub fn generate_for_base(
    app_handle: &tauri::AppHandle,
    path: &str,
    base: &DynamicImage,
    method: DenoiseMethod,
) -> Result<bool, String> {
    let key = entry_key(&source_string(path), method.tag());
    CACHE.generate_blocking(
        app_handle,
        path,
        base,
        key,
        load_session(app_handle.clone(), method),
        |session, base, progress| run_denoiser(base, session.as_ref(), progress),
    )
}

#[tauri::command]
pub fn clear_ai_denoise_cache() -> Result<(), String> {
    CACHE.clear()
}

struct BilinearTap {
    i00: usize,
    i10: usize,
    i01: usize,
    i11: usize,
    wx: f32,
    wy: f32,
}

impl BilinearTap {
    #[inline(always)]
    fn new(u: f32, v: f32, w: usize, h: usize) -> Self {
        let fx = (u * w as f32 - 0.5).clamp(0.0, (w - 1) as f32);
        let fy = (v * h as f32 - 0.5).clamp(0.0, (h - 1) as f32);
        let (x0, y0) = (fx.floor() as usize, fy.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
        Self {
            i00: y0 * w + x0,
            i10: y0 * w + x1,
            i01: y1 * w + x0,
            i11: y1 * w + x1,
            wx: fx - x0 as f32,
            wy: fy - y0 as f32,
        }
    }

    #[inline(always)]
    fn sample(&self, buf: &[f32]) -> f32 {
        let top = buf[self.i00] + (buf[self.i10] - buf[self.i00]) * self.wx;
        let bot = buf[self.i01] + (buf[self.i11] - buf[self.i01]) * self.wx;
        top + (bot - top) * self.wy
    }
}

fn box_filter(buf: &mut [f32], w: usize, h: usize, ch: usize, radius: usize) {
    if radius == 0 || w < 2 || h < 2 {
        return;
    }
    let r = radius as isize;
    let inv = 1.0 / (2 * radius + 1) as f32;
    let wi = w as isize;
    let hi = h as isize;
    let stride = w * ch;

    buf.par_chunks_exact_mut(stride).for_each(|row| {
        let src = row.to_vec();
        let mut sums = vec![0.0f32; ch];
        for i in -r..=r {
            let ix = i.clamp(0, wi - 1) as usize;
            for (c, s) in sums.iter_mut().enumerate() {
                *s += src[ix * ch + c];
            }
        }
        for x in 0..w {
            for (c, s) in sums.iter().enumerate() {
                row[x * ch + c] = *s * inv;
            }
            let add = ((x as isize + r + 1).clamp(0, wi - 1)) as usize;
            let sub = ((x as isize - r).clamp(0, wi - 1)) as usize;
            for (c, s) in sums.iter_mut().enumerate() {
                *s += src[add * ch + c] - src[sub * ch + c];
            }
        }
    });

    let src = buf.to_vec();
    let threads = rayon::current_num_threads().max(1);
    let block_rows = h.div_ceil(threads).max(1);

    buf.par_chunks_mut(block_rows * stride)
        .enumerate()
        .for_each(|(bi, block)| {
            let y_start = bi * block_rows;
            let rows_here = block.len() / stride;
            let mut sums = vec![0.0f32; stride];

            for i in -r..=r {
                let iy = (y_start as isize + i).clamp(0, hi - 1) as usize * stride;
                for (j, s) in sums.iter_mut().enumerate() {
                    *s += src[iy + j];
                }
            }

            for yy in 0..rows_here {
                let y = y_start + yy;
                let base = yy * stride;
                for (j, s) in sums.iter().enumerate() {
                    block[base + j] = *s * inv;
                }
                let add = ((y as isize + r + 1).clamp(0, hi - 1)) as usize * stride;
                let sub = ((y as isize - r).clamp(0, hi - 1)) as usize * stride;
                for (j, s) in sums.iter_mut().enumerate() {
                    *s += src[add + j] - src[sub + j];
                }
            }
        });
}
