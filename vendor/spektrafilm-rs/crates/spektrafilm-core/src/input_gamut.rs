//! Input gamut compression — faithful port of upstream
//! `spektrafilm/utils/gamut_compression.py` (input side).
//!
//! The compression is baked into the tc_lut once at build time via
//! remap-resample: `new_lut[xy] = old_lut[compress(xy)]`. The per-pixel
//! runtime path (RGB → CIE xy → tc → bilinear LUT sample) therefore stays
//! compression-agnostic. Only the production `"xy"` algorithm (ACES-RGC-style
//! radial compression toward the visible spectral locus) is ported; the
//! inspection-only `"oklch"` input variant is not.

use spektrafilm_math::spectral::{self, CMF_X_F64, CMF_Y_F64, CMF_Z_F64, TcLut};

use crate::gamut_compression::reinhard_knee;

/// CIE 1931 2° visible spectral locus as a closed xy polygon, sampled at 5 nm
/// from 380 to 700 nm (65 vertices + the first repeated). Mirrors upstream
/// `spectral_locus_xy()`; the CMFs are the same colour-science values.
fn spectral_locus_xy() -> Vec<[f64; 2]> {
    // Wavelengths 380..=700 step 5 → indices 0..65 of the 380..780 grid.
    const N: usize = 65;
    let mut poly = Vec::with_capacity(N + 1);
    for i in 0..N {
        let (x, y, z) = (CMF_X_F64[i], CMF_Y_F64[i], CMF_Z_F64[i]);
        let total = (x + y + z).max(1e-12);
        poly.push([x / total, y / total]);
    }
    poly.push(poly[0]);
    poly
}

/// Distance from `origin` along unit `direction` to the first intersection
/// with the closed polygon, via parametric segment intersection. Returns
/// `f64::INFINITY` for rays that miss (should not happen for an interior
/// origin and the visible locus). Mirrors upstream `_ray_polygon_distance`.
fn ray_polygon_distance(origin: [f64; 2], direction: [f64; 2], polygon: &[[f64; 2]]) -> f64 {
    let mut t_min = f64::INFINITY;
    let (dx, dy) = (direction[0], direction[1]);
    for seg in polygon.windows(2) {
        let (a, b) = (seg[0], seg[1]);
        let (ex, ey) = (b[0] - a[0], b[1] - a[1]);
        let denom = dx * ey - dy * ex;
        if denom.abs() <= 1e-12 {
            continue;
        }
        let (ox, oy) = (origin[0] - a[0], origin[1] - a[1]);
        // origin + t·direction = a + s·edge
        let t = (-ox * ey + oy * ex) / denom;
        let s = (-ox * dy + oy * dx) / denom;
        if t > 1e-9 && (0.0..=1.0).contains(&s) && t < t_min {
            t_min = t;
        }
    }
    t_min
}

/// ACES-RGC-style radial compression of a single CIE xy toward the spectral
/// locus, around `white_xy`. Hue (dominant wavelength) is preserved by
/// construction. Mirrors upstream `compress_xy_radial`.
fn compress_xy_radial(
    xy: [f64; 2],
    white_xy: [f64; 2],
    knee: (f64, f64, f64),
    locus: &[[f64; 2]],
) -> [f64; 2] {
    let delta = [xy[0] - white_xy[0], xy[1] - white_xy[1]];
    let dist = (delta[0] * delta[0] + delta[1] * delta[1]).sqrt();
    if dist < 1e-9 {
        return xy;
    }
    let safe_dist = dist.max(1e-12);
    let direction = [delta[0] / safe_dist, delta[1] / safe_dist];
    let boundary = ray_polygon_distance(white_xy, direction, locus);
    let d_norm = dist / boundary.max(1e-12);
    let (t, l, p) = knee;
    let d_compressed = reinhard_knee(d_norm, t, l, p);
    let scaled = d_compressed * boundary;
    [
        white_xy[0] + direction[0] * scaled,
        white_xy[1] + direction[1] * scaled,
    ]
}

/// Configured input gamut compressor. `build` resolves the algorithm string;
/// `is_active` reports whether a non-identity remap will be applied.
pub struct InputGamutCompress {
    active: bool,
    knee: (f64, f64, f64),
    locus: Vec<[f64; 2]>,
}

impl InputGamutCompress {
    /// Resolve from the param algorithm string. `"off"` → inactive (identity);
    /// `"xy"` → active radial compression. Any other value errors. The knee is
    /// validated as in upstream `InputGamutCompressSpec.__post_init__`.
    pub fn build(algorithm: &str, knee: [f32; 3]) -> Result<Self, String> {
        let active = match algorithm {
            "off" => false,
            "xy" => true,
            other => return Err(format!("unknown input gamut algorithm: {other}")),
        };
        let [t, l, p] = knee;
        if !(0.0..1.0).contains(&t) {
            return Err(format!("knee threshold must be in [0, 1), got {t}"));
        }
        if l <= 0.0 {
            return Err(format!("knee limit must be > 0, got {l}"));
        }
        if p <= 0.0 {
            return Err(format!("knee power must be > 0, got {p}"));
        }
        Ok(Self {
            active,
            knee: (knee[0] as f64, knee[1] as f64, knee[2] as f64),
            locus: if active {
                spectral_locus_xy()
            } else {
                Vec::new()
            },
        })
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    /// Bake the compression into a freshly resampled copy of `lut`. For each
    /// LUT cell we decode its tc index to CIE xy, compress, re-encode to tc,
    /// and bilinearly sample the original LUT there (clamp-to-edge boundary,
    /// matching `scipy.ndimage.map_coordinates(order=1, mode="nearest")`).
    /// `ref_xy` is the film reference illuminant chromaticity — the
    /// compression's achromatic axis. Returns `lut` unchanged when inactive.
    pub fn remap(&self, lut: &TcLut, ref_xy: [f64; 2]) -> TcLut {
        if !self.active {
            return lut.clone();
        }
        let size = lut.size;
        let ch = lut.channels;
        let inv = 1.0 / (size as f64 - 1.0);
        let mut data = vec![0.0f64; size * size * ch];
        for i in 0..size {
            for j in 0..size {
                // Step 1: tc cell → CIE xy.
                let (x, y) = spectral::tc_to_xy(i as f64 * inv, j as f64 * inv);
                // Step 2: compress.
                let cxy = compress_xy_radial([x, y], ref_xy, self.knee, &self.locus);
                // Step 3: compressed xy → tc.
                let (tx, ty) = spectral::xy_to_tc(cxy[0], cxy[1]);
                // Step 4: bilinear sample original LUT at (tx, ty) grid coords.
                let sample =
                    bilinear_sample(lut, tx * (size as f64 - 1.0), ty * (size as f64 - 1.0));
                let base = (i * size + j) * ch;
                data[base..base + ch].copy_from_slice(&sample[..ch]);
            }
        }
        TcLut {
            size,
            channels: ch,
            data,
        }
    }
}

/// Bilinear sample of all channels at fractional grid coordinate `(ci, cj)`,
/// clamping fetch indices to the edge (scipy `mode="nearest"`).
fn bilinear_sample(lut: &TcLut, ci: f64, cj: f64) -> [f64; 3] {
    let size = lut.size;
    let ch = lut.channels;
    let max_idx = size as isize - 1;
    let clamp = |v: isize| v.clamp(0, max_idx) as usize;

    let bi = ci.floor();
    let bj = cj.floor();
    let fi = ci - bi;
    let fj = cj - bj;
    let (i0, i1) = (clamp(bi as isize), clamp(bi as isize + 1));
    let (j0, j1) = (clamp(bj as isize), clamp(bj as isize + 1));

    let cell = |i: usize, j: usize, c: usize| lut.data[(i * size + j) * ch + c];
    let mut out = [0.0f64; 3];
    for (c, slot) in out.iter_mut().enumerate().take(ch) {
        let v00 = cell(i0, j0, c);
        let v01 = cell(i0, j1, c);
        let v10 = cell(i1, j0, c);
        let v11 = cell(i1, j1, c);
        *slot = v00 * (1.0 - fi) * (1.0 - fj)
            + v01 * (1.0 - fi) * fj
            + v10 * fi * (1.0 - fj)
            + v11 * fi * fj;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic synthetic LUT, mirrored bit-for-bit in the Python
    /// reference (`tmp/igc_ref.py`): cell (i, j, c) = `((i² + 3j + 7c) % 97) / 97`.
    fn synthetic_lut(size: usize) -> TcLut {
        let mut data = vec![0.0f64; size * size * 3];
        for i in 0..size {
            for j in 0..size {
                for c in 0..3 {
                    let v = ((i * i + j * 3 + c * 7) % 97) as f64 / 97.0;
                    data[(i * size + j) * 3 + c] = v;
                }
            }
        }
        TcLut {
            size,
            channels: 3,
            data,
        }
    }

    /// The baked tc_lut remap matches the upstream remap-resample
    /// (`remap_tc_lut_for_compression` with the `"xy"` algorithm) against the
    /// CIE 1931 2° locus, sampled with scipy `map_coordinates(order=1,
    /// mode="nearest")`.
    #[test]
    fn remap_matches_python_reference() {
        let spec = InputGamutCompress::build("xy", [0.0, 1.0, 6.0]).unwrap();
        let lut = synthetic_lut(64);
        let out = spec.remap(&lut, [0.3127, 0.3290]);

        // (i, j) → [r, g, b] from the Python reference.
        let cells = [
            (0usize, 0usize, [0.4137658005, 0.1877218965, 0.2598868450]),
            (10, 20, [0.7521338372, 0.8242987857, 0.8964637341]),
            (32, 32, [0.5463917966, 0.6185567450, 0.6907215587]),
            (50, 5, [0.5807479510, 0.0691153288, 0.1412802772]),
            (63, 63, [0.6891891640, 0.7613541125, 0.8335190609]),
            (5, 60, [0.0995187055, 0.1716836540, 0.2438486024]),
        ];
        for (i, j, expected) in cells {
            let base = (i * 64 + j) * 3;
            for c in 0..3 {
                assert!(
                    (out.data[base + c] - expected[c]).abs() < 1e-7,
                    "cell ({i},{j}) ch {c}: got {}, expected {}",
                    out.data[base + c],
                    expected[c],
                );
            }
        }

        let checksum: f64 = out.data.iter().sum();
        assert!(
            (checksum - 5846.5426164588).abs() < 1e-6,
            "checksum {checksum}",
        );
    }

    /// An inactive ("off") compressor returns the LUT unchanged.
    #[test]
    fn off_is_identity() {
        let spec = InputGamutCompress::build("off", [0.0, 1.0, 6.0]).unwrap();
        assert!(!spec.is_active());
        let lut = synthetic_lut(16);
        let out = spec.remap(&lut, [0.3127, 0.3290]);
        assert_eq!(out.data, lut.data);
    }
}
