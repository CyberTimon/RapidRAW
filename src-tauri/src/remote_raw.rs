//! Remote sensor-space RAW denoise (before demosaic) and RealPLKSR
//! super-resolution, driven over the darktable wire protocol by
//! [`crate::remote_ai`].
//!
//! Preprocessing follows the deployed model packages' contracts:
//!
//! - `rawdenoise-nind/model_bayer.onnx` declares `bayer_v1` with
//!   `bayer_orientation: force_rggb`, `edge_pad: mirror_cropped`,
//!   `wb_norm: none` and `output_scale: match_gain` (all verified against
//!   the live worker's config.json). Input is a T×T planar 4-channel
//!   (R, G1, G2, B) pack at half sensor resolution with values
//!   `(raw - black[site]) / range[site]`; output is a 3-channel 2T×2T
//!   camRGB tile at full sensor resolution whose scale is normalised by a
//!   scalar mean-match against the input before re-mosaicing. The tile
//!   grid, mirror-padded edges, seam-ramp blending and gain math mirror
//!   darktable's proven `restore_raw_bayer.c`.
//!
//! - `upscale-realplksr/model_x2.onnx` / `model_x4.onnx` are fed
//!   gamma-encoded sRGB tiles (darktable's restore_rgb protocol), tiled
//!   with the upscale overlap and blended with the same seam ramps.
//!
//! Originals are never mutated: the denoiser writes into a fresh buffer
//! and only the derived image is returned.

use crate::remote_ai::RemoteModel;
use anyhow::{anyhow, bail, Result};
use image::Rgb32FImage;
use rawler::decoders::{Orientation, RawDecodeParams};
use rawler::rawimage::{RawImage, RawImageData, RawPhotometricInterpretation};
use rawler::rawsource::RawSource;

/// Tile overlap in packed (half-res) pixels — darktable OVERLAP_PACKED.
const PACKED_OVERLAP: usize = 32;
/// Tile overlap in image pixels for super-resolution — darktable OVERLAP_UPSCALE.
const UPSCALE_OVERLAP: usize = 16;

/// Per-CFA-position preprocessing constants derived from the raw metadata.
#[derive(Clone, Copy)]
struct BayerPrep {
    /// Row/col of the R site within the 2×2 pattern at the buffer origin.
    y0: usize,
    x0: usize,
    /// Per-pattern-position black levels, indexed `((r & 1) << 1) | (c & 1)`.
    black: [f32; 4],
    /// Per-position white-minus-black ranges (same indexing).
    range: [f32; 4],
    white: f32,
}

/// Mirror index into `[lo, hi)` — darktable `_mirror_in_range` (periodic).
fn mirror_in_range(i: isize, lo: isize, hi: isize) -> usize {
    let n = (hi - lo) as isize;
    debug_assert!(n > 0);
    let mut i = i - lo;
    if n <= 1 {
        return lo as usize;
    }
    if i < 0 {
        i = -i;
    }
    let period = 2 * (n - 1);
    let mut i = i % period;
    if i < 0 {
        i += period;
    }
    if i >= n {
        i = period - i;
    }
    (lo + i) as usize
}

/// Seam ramp: linear 0→1 across the `2 * sensor_O` wide seam starting at
/// `d = 0` — darktable `_seam_ramp`/`_seam_ax`/`_seam_ay`.
fn seam_weight(d: isize, sensor_o: isize) -> f32 {
    ((d as f32) + 0.5) / (2.0 * sensor_o as f32)
}

/// Horizontal seam weight for absolute coordinate `sc` against the tile's
/// `[px_base, px_end)` core — darktable `_seam_ax`.
fn seam_x(sc: isize, px_base: isize, px_end: isize, sensor_o: isize, has_left: bool, has_right: bool) -> f32 {
    if has_left && sc < px_base + sensor_o {
        seam_weight(sc - (px_base - sensor_o), sensor_o)
    } else if has_right && sc >= px_end - sensor_o {
        1.0 - seam_weight(sc - (px_end - sensor_o), sensor_o)
    } else {
        1.0
    }
}

impl BayerPrep {
    fn compute(raw: &RawImage, cfa: &rawler::cfa::CFA) -> Result<Self> {
        // force_rggb: extraction starts at the CFA's R origin (color 0).
        let (mut y0, mut x0) = (usize::MAX, usize::MAX);
        for r in 0..2 {
            for c in 0..2 {
                if cfa.color_at(r, c) == 0 {
                    y0 = r;
                    x0 = c;
                }
            }
        }
        if y0 == usize::MAX {
            bail!("CFA pattern '{}' has no red site", cfa.name);
        }
        let mut black = [0.0f32; 4];
        let levels = &raw.blacklevel.levels;
        let (bw, bh) = (raw.blacklevel.width.max(1), raw.blacklevel.height.max(1));
        for idx in 0..4 {
            let (r, c) = ((idx >> 1) & 1, idx & 1);
            black[idx] = levels[(r % bh) * bw + (c % bw)].as_f32();
        }
        let white = raw.whitelevel.0.first().copied().unwrap_or(u16::MAX as u32) as f32;
        let mut range = [1.0f32; 4];
        for i in 0..4 {
            range[i] = (white - black[i]).max(1.0);
        }
        Ok(Self { y0, x0, black, range, white })
    }

    #[inline]
    fn site(&self, r: usize, c: usize) -> usize {
        ((r & 1) << 1) | (c & 1)
    }

    /// Model-space value from an ADC sample at `(r, c)`:
    /// `(raw - black[site]) / range[site]` (the deployed package declares
    /// `wb_norm: none`, so no white-balance multiplier is applied).
    #[inline]
    fn normalize(&self, val: f32, r: usize, c: usize) -> f32 {
        let s = self.site(r, c);
        (val - self.black[s]) / self.range[s]
    }

    /// Inverse of [`Self::normalize`] for a model output value at `(r, c)`.
    #[inline]
    fn denormalize(&self, model_val: f32, r: usize, c: usize) -> f32 {
        let s = self.site(r, c);
        model_val * self.range[s] + self.black[s]
    }
}

/// Pack a T×T 4-channel tile (R, G1, G2, B) from the CFA at half resolution,
/// mirror-padding reads within `[mir_lo, mir_hi)` bounds — darktable
/// `_pack_bayer_tile` with force_rggb + mirror_cropped.
fn pack_tile(
    cfa: &[f32],
    width: usize,
    prep: &BayerPrep,
    sr0_origin: isize,
    sc0_origin: isize,
    mir: (isize, isize, isize, isize),
    t: usize,
) -> Vec<f32> {
    let (mir_y_lo, mir_y_hi, mir_x_lo, mir_x_hi) = mir;
    let plane = t * t;
    let mut tile = vec![0.0f32; 4 * plane];
    for dy in 0..t {
        let sr0 = sr0_origin + 2 * dy as isize;
        for dx in 0..t {
            let sc0 = sc0_origin + 2 * dx as isize;
            for k in 0..4usize {
                let dr = (k >> 1) & 1;
                let dc = k & 1;
                let r = mirror_in_range(sr0 + dr as isize, mir_y_lo, mir_y_hi);
                let c = mirror_in_range(sc0 + dc as isize, mir_x_lo, mir_x_hi);
                tile[k * plane + dy * t + dx] = prep.normalize(cfa[r * width + c], r, c);
            }
        }
    }
    tile
}

/// Scalar match_gain: rescale the 3-channel model output so its mean equals
/// the 4-channel input mean — darktable `_bayer_gain_match` (negative and
/// inverted-sign gains are allowed; near-zero output mean falls back to 1).
fn gain_match(tile_in: &[f32], tile_out: &mut [f32]) {
    let in_mean = tile_in.iter().sum::<f32>() / tile_in.len() as f64 as f32;
    let out_mean = tile_out.iter().sum::<f32>() / tile_out.len() as f64 as f32;
    let thr = 1e-6 * in_mean.abs();
    let gain = if out_mean.abs() > thr { in_mean / out_mean } else { 1.0 };
    if gain != 1.0 {
        for v in tile_out.iter_mut() {
            *v *= gain;
        }
    }
}

/// Decode the embedded CFA sensor buffer (single-channel, ADC units) from a
/// raw file, plus its metadata orientation.
pub(crate) fn decode_raw_cfa(file_bytes: &[u8]) -> Result<(RawImage, Vec<f32>, Orientation)> {
    let source = RawSource::new_from_slice(file_bytes);
    let decoder = rawler::get_decoder(&source)?;
    let raw_image = decoder.raw_image(&source, &RawDecodeParams::default(), false)?;
    let orientation = decoder
        .raw_metadata(&source, &RawDecodeParams::default())?
        .exif
        .orientation
        .map(Orientation::from_u16)
        .unwrap_or(Orientation::Normal);
    if !matches!(raw_image.photometric, RawPhotometricInterpretation::Cfa(_)) {
        bail!("not a CFA raw file");
    }
    let cfa_buf = match &raw_image.data {
        RawImageData::Integer(v) => v.iter().map(|&x| x as f32).collect(),
        RawImageData::Float(v) => v.clone(),
    };
    Ok((raw_image, cfa_buf, orientation))
}

/// Sensor-space Bayer denoise over the remote worker. `cfa` is the decoded
/// ADC-domain buffer (`width * height`), `raw_image` supplies the metadata.
/// On success returns the denoised CFA in the same domain and units; the
/// input buffers are left untouched.
pub fn denoise_bayer_remote(
    raw_image: &RawImage,
    cfa: &[f32],
    endpoint: &str,
    strength: f32,
    cancelled: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(f32),
) -> Result<Vec<f32>> {
    let cfa_meta = match &raw_image.photometric {
        RawPhotometricInterpretation::Cfa(cfg) => &cfg.cfa,
        _ => bail!("not a CFA raw"),
    };
    let (width, height) = (raw_image.width, raw_image.height);
    if width == 0 || height == 0 || cfa.len() < width * height {
        bail!("raw buffer size mismatch");
    }
    if !(cfa_meta.width == 2 && cfa_meta.height == 2) {
        bail!(
            "sensor RAW denoise supports 2×2 Bayer CFA; '{}' ({}×{}) needs RGB denoise",
            cfa_meta.name,
            cfa_meta.width,
            cfa_meta.height
        );
    }
    let prep = BayerPrep::compute(raw_image, cfa_meta)?;
    let alpha = strength.clamp(0.0, 1.0);
    let inv_alpha = 1.0 - alpha;

    let mut model = RemoteModel::connect_load(
        endpoint,
        crate::remote_ai::MODEL_RAW_DENOISE,
        crate::remote_ai::MODEL_RAW_DENOISE_FILE,
    )
    .map_err(|e| anyhow!("remote RAW denoise worker unavailable: {e}"))?;
    let input = model
        .inputs
        .first()
        .ok_or_else(|| anyhow!("worker reported no inputs"))?;
    if input.shape.len() != 4
        || input.shape[0] != 1
        || input.shape[1] != 4
        || input.shape[2] != input.shape[3]
        || input.shape[2] < 4 * PACKED_OVERLAP as i64
    {
        bail!("unexpected RAW denoise model input shape {:?}", input.shape);
    }
    let t = input.shape[2] as usize;
    let expected_out = [1i64, 3, 2 * t as i64, 2 * t as i64];
    if model.outputs.first().map(|o| o.shape.as_slice()) != Some(&expected_out[..]) {
        bail!(
            "unexpected RAW denoise model output shape {:?}, expected {expected_out:?}",
            model.outputs.first().map(|o| &o.shape)
        );
    }
    let o = PACKED_OVERLAP as isize;
    let sensor_o = 2 * o;

    let (vis_y_lo, vis_x_lo, vis_end_y, vis_end_x) = match &raw_image.active_area {
        Some(aa) => (
            aa.p.y as isize,
            aa.p.x as isize,
            (aa.p.y + aa.d.h) as isize,
            (aa.p.x + aa.d.w) as isize,
        ),
        None => (0, 0, height as isize, width as isize),
    };
    let (y0, x0) = (prep.y0 as isize, prep.x0 as isize);
    // Working region in packed units, CFA-aligned to the R origin.
    let hh = (vis_end_y - y0).div_euclid(2);
    let wh = (vis_end_x - x0).div_euclid(2);
    if hh <= 0 || wh <= 0 {
        return Ok(cfa.to_vec());
    }
    // mirror_cropped: reflections live inside the R-origin-shifted visible
    // rectangle, kept even so they stay CFA-aligned.
    let (mut mir_y_lo, mut mir_y_hi) = (vis_y_lo + y0, vis_end_y);
    let (mut mir_x_lo, mut mir_x_hi) = (vis_x_lo + x0, vis_end_x);
    if (mir_y_hi - mir_y_lo) & 1 == 1 {
        mir_y_hi -= 1;
    }
    if (mir_x_hi - mir_x_lo) & 1 == 1 {
        mir_x_hi -= 1;
    }
    mir_y_lo = mir_y_lo.clamp(0, height as isize);
    mir_y_hi = mir_y_hi.clamp(0, height as isize);
    mir_x_lo = mir_x_lo.clamp(0, width as isize);
    mir_x_hi = mir_x_hi.clamp(0, width as isize);
    if mir_y_hi - mir_y_lo < 2 || mir_x_hi - mir_x_lo < 2 {
        bail!("visible area too small for CFA-aligned mirror padding");
    }

    let step = (t - 2 * PACKED_OVERLAP) as isize;
    let cols = (wh + step - 1) / step;
    let rows = (hh + step - 1) / step;
    let total_tiles = (cols * rows) as f32;

    // Output starts as a copy: margins outside the working region keep the
    // original sensor values.
    let mut out_cfa = cfa.to_vec();

    for ty in 0..rows {
        for tx in 0..cols {
            if cancelled() {
                bail!("cancelled");
            }
            let py_base = ty * step;
            let px_base = tx * step;
            let py_end = (py_base + step).min(hh);
            let px_end = (px_base + step).min(wh);
            let has_top = ty > 0;
            let has_bot = ty < rows - 1;
            let has_left = tx > 0;
            let has_right = tx < cols - 1;

            let sr0_origin = y0 + 2 * (py_base - o);
            let sc0_origin = x0 + 2 * (px_base - o);
            let tile_in = pack_tile(cfa, width, &prep, sr0_origin, sc0_origin,
                                    (mir_y_lo, mir_y_hi, mir_x_lo, mir_x_hi), t);
            let resp = model
                .run(&tile_in, &[1, 4, t as i64, t as i64], 4)
                .map_err(|e| anyhow!("remote inference failed: {e}"))?;
            if resp.shape != [1, 3, (2 * t) as i64, (2 * t) as i64] || resp.data.len() != 12 * t * t {
                bail!("unexpected denoise output shape {:?}", resp.shape);
            }
            let mut tile_out = resp.data;
            gain_match(&tile_in, &mut tile_out);
            let out_plane = 2 * t * 2 * t;

            // Write-back with seam-ramp blending. Every covered pixel's
            // contributions sum to weight exactly 1 (including the
            // original-blend term), so tiles may accumulate in place.
            let sensor_py_base = y0 + 2 * py_base;
            let sensor_py_end = y0 + 2 * py_end;
            let sensor_px_base = x0 + 2 * px_base;
            let sensor_px_end = x0 + 2 * px_end;
            let ext_y0 = if has_top { sensor_py_base - sensor_o } else { sensor_py_base }.max(0);
            let ext_y1 = (if has_bot { sensor_py_end + sensor_o } else { sensor_py_end })
                .min(height as isize)
                .min(y0 + 2 * hh);
            let ext_x0 = if has_left { sensor_px_base - sensor_o } else { sensor_px_base }.max(0);
            let ext_x1 = (if has_right { sensor_px_end + sensor_o } else { sensor_px_end })
                .min(width as isize)
                .min(x0 + 2 * wh);

            for sr in ext_y0..ext_y1 {
                let my = 2 * o + (sr - sensor_py_base);
                let ay = seam_x(sr, sensor_py_base, sensor_py_end, sensor_o, has_top, has_bot);
                let out_row = sr as usize * width;
                let mo_row = (my as usize) * 2 * t;
                for sc in ext_x0..ext_x1 {
                    let mx = 2 * o + (sc - sensor_px_base);
                    let ax = seam_x(sc, sensor_px_base, sensor_px_end, sensor_o, has_left, has_right);
                    let w = ax * ay;
                    let ch = cfa_meta.color_at(sr as usize, sc as usize).min(2);
                    let model_val = tile_out[ch * out_plane + mo_row + mx as usize];
                    let raw_val = prep.denormalize(model_val, sr as usize, sc as usize)
                        .clamp(0.0, prep.white);
                    let orig = cfa[sr as usize * width + sc as usize];
                    let p = out_row + sc as usize;
                    if w >= 1.0 {
                        out_cfa[p] = alpha * raw_val + inv_alpha * orig;
                    } else if w > 0.0 {
                        // Shared pixel: out holds `orig` plus prior tiles'
                        // deltas; add this tile's delta toward the target
                        // alpha*raw + (1-alpha)*orig.
                        out_cfa[p] += alpha * w * (raw_val - orig);
                    }
                }
            }
            progress(((ty * cols + tx + 1) as f32) / total_tiles);
        }
    }
    Ok(out_cfa)
}

#[inline]
fn mirror_coord(c: isize, size: usize) -> usize {
    let n = size as isize;
    if n <= 1 {
        return 0;
    }
    let period = 2 * (n - 1);
    let mut c = c % period;
    if c < 0 {
        c += period;
    }
    if c >= n {
        c = period - c;
    }
    c as usize
}

/// RealPLKSR super-resolution over the remote worker. Input and output are
/// RapidRAW's display-encoded RGB (the encoding the editor shows and the
/// sRGB tag implies); inference runs on planar NCHW tiles per the model
/// metadata, blended with seam ramps. Returns the ×`scale` image.
pub fn upscale_remote(
    img: &Rgb32FImage,
    endpoint: &str,
    want_x4: bool,
    cancelled: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(f32),
) -> Result<Rgb32FImage> {
    let (w, h) = (img.width() as usize, img.height() as usize);
    if w == 0 || h == 0 {
        bail!("empty image");
    }
    let mut model = RemoteModel::connect_load(
        endpoint,
        crate::remote_ai::MODEL_UPSCALE,
        if want_x4 {
            crate::remote_ai::MODEL_UPSCALE_X4_FILE
        } else {
            crate::remote_ai::MODEL_UPSCALE_X2_FILE
        },
    )
    .map_err(|e| anyhow!("remote upscale worker unavailable: {e}"))?;
    let meta = model.inputs.first().ok_or_else(|| anyhow!("worker reported no inputs"))?;
    if meta.shape.len() != 4
        || meta.shape[1] != 3
        || meta.shape[2] != meta.shape[3]
        || meta.shape[2] < 4 * UPSCALE_OVERLAP as i64
    {
        bail!("unexpected upscale input shape {:?}", meta.shape);
    }
    let t = meta.shape[2] as usize;
    let o = UPSCALE_OVERLAP as isize;
    let plane = t * t;

    // Display-encoded working copy (planar per channel).
    let mut src = vec![0.0f32; 3 * w * h];
    for (i, px) in img.pixels().enumerate() {
        src[i] = px[0].clamp(0.0, 1.0);
        src[w * h + i] = px[1].clamp(0.0, 1.0);
        src[2 * w * h + i] = px[2].clamp(0.0, 1.0);
    }

    let step = t - 2 * UPSCALE_OVERLAP;
    let cols = w.div_ceil(step);
    let rows = h.div_ceil(step);
    let total_tiles = (cols * rows) as f32;
    let scale = if want_x4 { 4usize } else { 2 };
    let (ow, oh) = (w * scale, h * scale);
    let mut out = vec![0.0f32; 3 * ow * oh];

    for ty in 0..rows {
        for tx in 0..cols {
            if cancelled() {
                bail!("cancelled");
            }
            let px_base = tx * step;
            let py_base = ty * step;
            let px_end = (px_base + step).min(w);
            let py_end = (py_base + step).min(h);
            let has_left = tx > 0;
            let has_top = ty > 0;
            let has_right = tx < cols - 1;
            let has_bot = ty < rows - 1;

            let mut tile = vec![0.0f32; 3 * plane];
            let bx = px_base as isize - o;
            let by = py_base as isize - o;
            for c in 0..3 {
                let plane_src = &src[c * w * h..(c + 1) * w * h];
                let plane_dst = &mut tile[c * plane..(c + 1) * plane];
                for dy in 0..t {
                    let sy = mirror_coord(by + dy as isize, h);
                    for dx in 0..t {
                        let sx = mirror_coord(bx + dx as isize, w);
                        plane_dst[dy * t + dx] = plane_src[sy * w + sx];
                    }
                }
            }

            let resp = model
                .run(&tile, &[1, 3, t as i64, t as i64], 4)
                .map_err(|e| anyhow!("remote inference failed: {e}"))?;
            let tw = t * scale;
            let out_plane = tw * tw;
            if resp.shape != [1, 3, tw as i64, tw as i64] || resp.data.len() != 3 * out_plane {
                bail!("unexpected upscale output shape {:?}", resp.shape);
            }

            // Blend the core ± seam region into the output canvas. The tile
            // spans core ± O input pixels = ± O*scale output pixels, which
            // bounds the seam half-width and keeps tile indices in range.
            let seam = (UPSCALE_OVERLAP * scale) as isize;
            let opx_base = px_base as isize * scale as isize;
            let opx_end = px_end as isize * scale as isize;
            let opy_base = py_base as isize * scale as isize;
            let opy_end = py_end as isize * scale as isize;
            let ext_x0 = if has_left { opx_base - seam } else { opx_base }.max(0);
            let ext_x1 = (if has_right { opx_end + seam } else { opx_end }).min(ow as isize);
            let ext_y0 = if has_top { opy_base - seam } else { opy_base }.max(0);
            let ext_y1 = (if has_bot { opy_end + seam } else { opy_end }).min(oh as isize);

            for or in ext_y0..ext_y1 {
                let ay = seam_x(or, opy_base, opy_end, seam, has_top, has_bot);
                let my = (o * scale as isize + (or - opy_base)) as usize;
                for oc in ext_x0..ext_x1 {
                    let ax = seam_x(oc, opx_base, opx_end, seam, has_left, has_right);
                    let wgt = ax * ay;
                    let mx = (o * scale as isize + (oc - opx_base)) as usize;
                    let dst = (or as usize * ow + oc as usize) as isize;
                    if wgt >= 1.0 {
                        for c in 0..3isize {
                            out[(c * (ow * oh) as isize + dst) as usize] =
                                resp.data[c as usize * out_plane + my * tw + mx];
                        }
                    } else if wgt > 0.0 {
                        for c in 0..3isize {
                            out[(c * (ow * oh) as isize + dst) as usize] +=
                                wgt * resp.data[c as usize * out_plane + my * tw + mx];
                        }
                    }
                }
            }
            progress(((ty * cols + tx + 1) as f32) / total_tiles);
        }
    }

    let mut result = Rgb32FImage::new(ow as u32, oh as u32);
    for (i, px) in result.pixels_mut().enumerate() {
        px[0] = out[i];
        px[1] = out[ow * oh + i];
        px[2] = out[2 * ow * oh + i];
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rawler::decoders::{BlackLevel, WhiteLevel};
    use crate::remote_ai::parse_endpoint;
    use image::GenericImageView;

    /// Minimal CFA RawImage for preprocessing tests (no decode involved).
    fn raw_with_cfa(pattern: &str, black: [u32; 4], white: u32) -> RawImage {
        let cfa = rawler::CFA::new(pattern);
        RawImage {
            camera: Default::default(),
            make: String::new(),
            model: String::new(),
            clean_make: String::new(),
            clean_model: String::new(),
            width: 0,
            height: 0,
            cpp: 1,
            bps: 16,
            wb_coeffs: [1.0; 4],
            whitelevel: WhiteLevel(vec![white; 4]),
            blacklevel: BlackLevel::new(&black, 2, 2, 1),
            xyz_to_cam: [[0.0; 3]; 4],
            photometric: RawPhotometricInterpretation::Cfa(rawler::rawimage::CFAConfig::new(
                &cfa,
                &rawler::cfa::PlaneColor::new(pattern),
            )),
            active_area: None,
            crop_area: None,
            blackareas: Vec::new(),
            orientation: Orientation::Normal,
            data: RawImageData::Integer(Vec::new()),
            color_matrix: std::collections::HashMap::new(),
            dng_tags: std::collections::HashMap::new(),
        }
    }

    fn prep_rggb() -> BayerPrep {
        let raw = raw_with_cfa("RGGB", [64, 64, 64, 64], 1023);
        let cfa = rawler::CFA::new("RGGB");
        BayerPrep::compute(&raw, &cfa).unwrap()
    }

    #[test]
    fn prep_resolves_origin_levels_and_ranges() {
        let p = prep_rggb();
        assert_eq!((p.y0, p.x0), (0, 0));
        assert!(p.black.iter().all(|&b| b == 64.0));
        assert!(p.range.iter().all(|&r| r == 959.0));
        let raw = raw_with_cfa("GRBG", [10, 20, 30, 40], 1000);
        let grbg = rawler::CFA::new("GRBG");
        let p = BayerPrep::compute(&raw, &grbg).unwrap();
        // R at (0,1): black[site (0,1)] = 20
        assert_eq!((p.y0, p.x0), (0, 1));
        assert_eq!(p.black[p.site(0, 1)], 20.0);
        assert_eq!(p.black[p.site(1, 0)], 30.0);
    }

    #[test]
    fn normalize_denormalize_round_trips() {
        let p = prep_rggb();
        for site_r in 0..2 {
            for site_c in 0..2 {
                let v = 123.0f32;
                let n = p.normalize(v, site_r, site_c);
                assert!((p.denormalize(n, site_r, site_c) - v).abs() < 1e-3);
            }
        }
    }

    #[test]
    fn mirror_in_range_reflects_periodically() {
        // Range [10, 14): indices map 10,11,12,13,12,11,10,11...
        assert_eq!(mirror_in_range(10, 10, 14), 10);
        assert_eq!(mirror_in_range(13, 10, 14), 13);
        assert_eq!(mirror_in_range(14, 10, 14), 12);
        assert_eq!(mirror_in_range(15, 10, 14), 11);
        assert_eq!(mirror_in_range(16, 10, 14), 10);
        assert_eq!(mirror_in_range(9, 10, 14), 11);
        assert_eq!(mirror_in_range(8, 10, 14), 12);
        assert_eq!(mirror_in_range(7, 10, 14), 13);
        // Single-wide range collapses.
        assert_eq!(mirror_in_range(-100, 5, 6), 5);
    }

    #[test]
    fn seam_weights_of_neighbors_sum_to_one() {
        let o = 4isize;
        let sensor_o = 2 * o;
        // Two horizontal neighbors: left tile core [0, 10), right [10, 20).
        let px_base = 10isize;
        let px_end = 20isize;
        // Extents: left writes [0, 18), right writes [2, 20). Only the
        // writing tiles participate in the sum-to-one check.
        for sc in 0..px_end {
            let left = if sc < px_end + sensor_o - px_base {
                seam_x(sc, 0, px_base, sensor_o, false, true)
            } else {
                0.0
            };
            let right = if sc >= px_base - sensor_o {
                seam_x(sc, px_base, px_end, sensor_o, true, false)
            } else {
                0.0
            };
            assert!((left + right - 1.0).abs() < 1e-6, "sc={sc} {left}+{right}");
        }
    }

    #[test]
    fn tile_grid_weights_sum_exactly_to_one() {
        let step = 8isize;
        let o = 2isize;
        let sensor_o = 2 * o;
        for (wh, hh) in [(14isize, 13isize), (9, 9), (10, 11), (24, 24)] {
            let (width, height) = (wh as usize, hh as usize);
            let mut acc = vec![0.0f32; width * height];
            let cols = (wh + step - 1) / step;
            let rows = (hh + step - 1) / step;
            for ty in 0..rows {
                for tx in 0..cols {
                    let px_base = tx * step;
                    let py_base = ty * step;
                    let px_end = (px_base + step).min(wh);
                    let py_end = (py_base + step).min(hh);
                    let (has_left, has_right) = (tx > 0, tx < cols - 1);
                    let (has_top, has_bot) = (ty > 0, ty < rows - 1);
                    let ext_x0 = if has_left { px_base - sensor_o } else { px_base }.max(0);
                    let ext_x1 = (if has_right { px_end + sensor_o } else { px_end }).min(wh);
                    let ext_y0 = if has_top { py_base - sensor_o } else { py_base }.max(0);
                    let ext_y1 = (if has_bot { py_end + sensor_o } else { py_end }).min(hh);
                    for sr in ext_y0..ext_y1 {
                        for sc in ext_x0..ext_x1 {
                            let w = seam_x(sc, px_base, px_end, sensor_o, has_left, has_right)
                                * seam_x(sr, py_base, py_end, sensor_o, has_top, has_bot);
                            let p = sr as usize * width + sc as usize;
                            acc[p] += w;
                        }
                    }
                }
            }
            for (i, a) in acc.iter().enumerate() {
                assert!((a - 1.0).abs() < 1e-6, "pixel {i} weight {a}");
            }
        }
    }

    #[test]
    fn pack_tile_extracts_rggb_quads_with_mirror() {
        let p = prep_rggb();
        // 6×6 sensor, values = row*10 + col, all sites ~ equal black/white.
        let w = 6usize;
        let cfa: Vec<f32> = (0..36).map(|i| i as f32 + 100.0).collect();
        // Tile origin at sensor (0,0), full cover, mirror within [0,6).
        let tile = pack_tile(&cfa, w, &p, 0, 0, (0, 6, 0, 6), 4);
        let plane = 16;
        // k=0 (R) at (0,0): raw 100 → normalized (100-64)/959
        assert!((tile[0] - (100.0 - 64.0) / 959.0).abs() < 1e-6);
        // k=0, dx=1 → sensor (0,2): raw 102 (packed half-res steps by 2)
        assert!((tile[1] - (102.0 - 64.0) / 959.0).abs() < 1e-6);
        // k=1 (G1) at the block's (0,1) site: sensor (0,1), raw 101
        assert!((tile[plane] - (101.0 - 64.0) / 959.0).abs() < 1e-6);
        // k=2 (G2) at the block's (1,0) site: sensor (1,0), raw 106
        assert!((tile[2 * plane] - (106.0 - 64.0) / 959.0).abs() < 1e-6);
        // k=3 (B) at (1,1): raw 107
        assert!((tile[3 * plane] - (107.0 - 64.0) / 959.0).abs() < 1e-6);
        // Mirror-padded read: dy=3, dx=3 with B's (1,1) offset → sensor (7,7)
        // reflected to (3,3) = 121
        assert!((tile[3 * plane + 15] - (121.0 - 64.0) / 959.0).abs() < 1e-6);
    }

    #[test]
    fn pack_tile_forces_rggb_origin_for_grbg() {
        let raw = raw_with_cfa("GRBG", [0, 0, 0, 0], 1000);
        let cfa_meta = rawler::CFA::new("GRBG");
        let p = BayerPrep::compute(&raw, &cfa_meta).unwrap();
        // Sensor 4×4: site color index at (r,c).
        let w = 4usize;
        let cfa: Vec<f32> = (0..16).map(|i| i as f32).collect();
        // Origin (0,1): sr0 shifts by y0=0, sc0=1.
        let tile = pack_tile(&cfa, w, &p, p.y0 as isize, p.x0 as isize, (0, 4, 0, 4), 2);
        let plane = 4;
        // R site = sensor (0,1) = value 1 → channel 0.
        assert!((tile[0] - 1.0 / 1000.0).abs() < 1e-6);
        // G1 = sensor (0,2) = 2 → channel 1.
        assert!((tile[plane] - 2.0 / 1000.0).abs() < 1e-6);
        // G2 = sensor (1,1) = 5 → channel 2.
        assert!((tile[2 * plane] - 5.0 / 1000.0).abs() < 1e-6);
        // B = sensor (1,2) = 6 → channel 3.
        assert!((tile[3 * plane] - 6.0 / 1000.0).abs() < 1e-6);
    }

    #[test]
    fn gain_match_rescales_to_input_mean() {
        let input = vec![1.0f32; 400]; // 4×10×10, mean 1
        let mut output = vec![1000.0f32; 300]; // 3×10×10, mean 1000
        gain_match(&input, &mut output);
        let mean: f32 = output.iter().sum::<f32>() / 300.0;
        assert!((mean - 1.0).abs() < 1e-4);
        // Degenerate near-zero output falls back to identity.
        let mut output = vec![1e-9f32; 300];
        gain_match(&input, &mut output);
        assert!(output.iter().all(|&v| v == 1e-9));
    }

    #[test]
    fn mirror_coord_reflects() {
        assert_eq!(mirror_coord(-1, 4), 1);
        assert_eq!(mirror_coord(4, 4), 2);
        assert_eq!(mirror_coord(5, 4), 1);
        assert_eq!(mirror_coord(0, 1), 0);
        assert_eq!(mirror_coord(9, 1), 0);
    }

    #[test]
    fn endpoint_guard_blocks_non_loopback() {
        assert!(parse_endpoint("127.0.0.1:8794").is_ok());
        assert!(parse_endpoint("10.0.0.1:8794").is_err());
    }

    // --- live smoke: real worker, real functions, no simulation.
    // cargo test --lib live_worker_ -- --ignored --nocapture
    // Needs the loopback worker on 127.0.0.1:8794 and a Bayer sample at
    // $RAPIDRAW_SMOKE_RAW for the RAW test.

    fn not_cancelled() -> bool {
        false
    }

    #[test]
    #[ignore]
    fn live_worker_upscale_smoke() {
        if crate::remote_ai::parse_endpoint(crate::remote_ai::DEFAULT_ENDPOINT).is_err() {
            panic!("bad default endpoint");
        }
        // Synthetic but real image data through the real remote function.
        let (w, h) = (257usize, 131usize); // deliberately not tile-aligned
        let mut img = Rgb32FImage::new(w as u32, h as u32);
        for (x, y, px) in img.enumerate_pixels_mut() {
            let r = x as f32 / w as f32;
            let g = y as f32 / h as f32;
            px[0] = r;
            px[1] = g;
            px[2] = 0.5 * (r + g);
        }
        let mut pct = 0.0f32;
        let out = upscale_remote(&img, crate::remote_ai::DEFAULT_ENDPOINT, false, &not_cancelled, &mut |f| {
            pct = f;
        })
        .expect("remote upscale against live worker");
        assert!((pct - 1.0).abs() < 1e-6, "progress should reach 100%, got {pct}");
        assert_eq!((out.width(), out.height()), ((2 * w) as u32, (2 * h) as u32));
        assert!(out.pixels().all(|p| p[0].is_finite() && p[1].is_finite() && p[2].is_finite()));
        let center = out.get_pixel(w as u32, h as u32);
        assert!(center[0] > 0.0 && center[0] < 1.0, "center pixel sane: {center:?}");
    }

    #[test]
    #[ignore]
    fn live_worker_raw_denoise_smoke() {
        let raw_path = std::env::var("RAPIDRAW_SMOKE_RAW")
            .expect("set RAPIDRAW_SMOKE_RAW to a Bayer camera sample");
        let bytes = std::fs::read(&raw_path).expect("read sample raw");
        let (raw_image, cfa, orientation) =
            decode_raw_cfa(&bytes).expect("decode camera sample");
        let mut pct = 0.0f32;
        let denoised = denoise_bayer_remote(
            &raw_image,
            &cfa,
            crate::remote_ai::DEFAULT_ENDPOINT,
            1.0,
            &not_cancelled,
            &mut |f| pct = f,
        )
        .expect("remote sensor denoise against live worker");
        assert_eq!(denoised.len(), cfa.len());
        assert!((pct - 1.0).abs() < 1e-6);
        assert!(denoised.iter().all(|v| v.is_finite() && *v >= 0.0));

        // Develop before/after through the standard pipeline and write
        // visible TIFF outputs for inspection (std::env::temp_dir()).
        let develop = |data: rawler::RawImageData| {
            let mut raw = raw_image.clone();
            raw.data = data;
            let mut img = crate::image_processing::apply_orientation(
                crate::raw_processing::develop_decoded_raw(
                    raw,
                    &bytes,
                    false,
                    "auto".to_string(),
                    None,
                )
                .expect("develop"),
                orientation,
            );
            // Same display-encoding step denoise_image applies to RAW
            // before the sRGB-tagged save.
            crate::image_processing::apply_cpu_default_raw_processing(&mut img);
            img
        };
        let before = develop(rawler::RawImageData::Float(cfa));
        let after = develop(rawler::RawImageData::Float(denoised));
        let out_dir = std::env::temp_dir();
        for (name, img) in [
            ("rapidraw-smoke-before.tiff", &before),
            ("rapidraw-smoke-after.tiff", &after),
        ] {
            let path = out_dir.join(name);
            let payload = crate::export_processing::encode_image_to_bytes(
                img,
                "tiff",
                100,
                crate::export_processing::TiffBitDepth::Sixteen,
            )
            .expect("encode smoke output");
            std::fs::write(&path, payload).expect("write smoke output");
            println!("smoke output: {}", path.display());
        }
        assert!(after.pixels().count() > 0);
        assert!(after.to_rgb32f().pixels().all(|p| p[0].is_finite()));
    }
}
