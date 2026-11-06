//! 3D PCHIP (Piecewise Cubic Hermite Interpolating Polynomial) LUT.
//!
//! Bit-exact port of Python `spektrafilm.utils.fast_interp_lut`'s
//! `apply_lut_pchip_3d` path — the implementation backing
//! `use_enlarger_lut` / `use_scanner_lut`. Math follows the numba
//! kernel verbatim:
//!
//!   1. Per-axis monotone-cubic slopes (`fill_monotone_slopes_1d`).
//!   2. Per-cell min/max value bounds for the soft monotonicity clamp.
//!   3. Per-query interpolation: a tensor-product Hermite walk along
//!      x → y → z with the orthogonal slopes linearly mixed.
//!
//! Layout: `lut[i, j, k, c]` is stored row-major as
//! `flat[((i*size + j)*size + k)*3 + c]`. f64 throughout to match
//! Python's `np.float64` LUTs — this is the *parity-faithful* path,
//! not the fastest possible (a trilinear approximation would be faster
//! but would diverge from Python's output by sub-LSB amounts that the
//! parity tests would flag).

#[derive(Debug, Clone)]
pub struct PreparedPchip3d {
    pub size: usize,
    pub lut: Vec<f64>,
    pub slope_x: Vec<f64>,
    pub slope_y: Vec<f64>,
    pub slope_z: Vec<f64>,
    /// Per-cell min/max (`(size-1)^3 * 3`), used to clamp the
    /// interpolated value to the convex hull of the cell corners.
    /// This is the soft monotonicity guard Python applies and is the
    /// reason PCHIP cannot ring outside the local sample range.
    pub cell_min: Vec<f64>,
    pub cell_max: Vec<f64>,
}

#[inline]
fn idx4(size: usize, i: usize, j: usize, k: usize, c: usize) -> usize {
    ((i * size + j) * size + k) * 3 + c
}

#[inline]
fn idx4_cell(size_m1: usize, i: usize, j: usize, k: usize, c: usize) -> usize {
    ((i * size_m1 + j) * size_m1 + k) * 3 + c
}

/// Port of Python's `_fill_monotone_slopes_1d`. Fills `slopes` with
/// PCHIP-limited slopes for a uniformly-sampled 1D signal in
/// `values`. Used along each LUT axis for each output channel.
pub fn fill_monotone_slopes_1d(values: &[f64], slopes: &mut [f64]) {
    let size = values.len();
    if size == 1 {
        slopes[0] = 0.0;
        return;
    }
    let mut deltas = vec![0.0f64; size - 1];
    for i in 0..size - 1 {
        deltas[i] = values[i + 1] - values[i];
    }
    if size == 2 {
        slopes[0] = deltas[0];
        slopes[1] = deltas[0];
        return;
    }
    // Left endpoint: 3-pt one-sided slope with PCHIP limiter.
    let mut left = 0.5 * (3.0 * deltas[0] - deltas[1]);
    if left * deltas[0] <= 0.0 {
        left = 0.0;
    } else if deltas[0] * deltas[1] < 0.0 && left.abs() > (3.0 * deltas[0]).abs() {
        left = 3.0 * deltas[0];
    }
    slopes[0] = left;
    // Interior: harmonic mean when neighboring deltas agree in sign,
    // zero when they don't (monotonicity preservation).
    for i in 1..size - 1 {
        let dp = deltas[i - 1];
        let dn = deltas[i];
        if dp == 0.0 || dn == 0.0 || dp * dn <= 0.0 {
            slopes[i] = 0.0;
        } else {
            slopes[i] = 2.0 * dp * dn / (dp + dn);
        }
    }
    // Right endpoint mirrors the left case.
    let mut right = 0.5 * (3.0 * deltas[size - 2] - deltas[size - 3]);
    if right * deltas[size - 2] <= 0.0 {
        right = 0.0;
    } else if deltas[size - 2] * deltas[size - 3] < 0.0
        && right.abs() > (3.0 * deltas[size - 2]).abs()
    {
        right = 3.0 * deltas[size - 2];
    }
    slopes[size - 1] = right;
}

/// Precompute axis slopes + per-cell bounds for a `size^3 × 3` LUT.
/// Mirrors Python `prepare_lut_pchip_3d`.
pub fn prepare_pchip_3d(lut: Vec<f64>, size: usize) -> PreparedPchip3d {
    assert_eq!(lut.len(), size * size * size * 3, "lut length mismatch");
    let total = size * size * size * 3;
    let mut slope_x = vec![0.0f64; total];
    let mut slope_y = vec![0.0f64; total];
    let mut slope_z = vec![0.0f64; total];

    let mut line = vec![0.0f64; size];
    let mut slopes = vec![0.0f64; size];

    // Slope along x (axis 0): for each (j, k, c) sweep i.
    for j in 0..size {
        for k in 0..size {
            for c in 0..3 {
                for i in 0..size {
                    line[i] = lut[idx4(size, i, j, k, c)];
                }
                fill_monotone_slopes_1d(&line, &mut slopes);
                for i in 0..size {
                    slope_x[idx4(size, i, j, k, c)] = slopes[i];
                }
            }
        }
    }
    // Slope along y (axis 1).
    for i in 0..size {
        for k in 0..size {
            for c in 0..3 {
                for j in 0..size {
                    line[j] = lut[idx4(size, i, j, k, c)];
                }
                fill_monotone_slopes_1d(&line, &mut slopes);
                for j in 0..size {
                    slope_y[idx4(size, i, j, k, c)] = slopes[j];
                }
            }
        }
    }
    // Slope along z (axis 2).
    for i in 0..size {
        for j in 0..size {
            for c in 0..3 {
                for k in 0..size {
                    line[k] = lut[idx4(size, i, j, k, c)];
                }
                fill_monotone_slopes_1d(&line, &mut slopes);
                for k in 0..size {
                    slope_z[idx4(size, i, j, k, c)] = slopes[k];
                }
            }
        }
    }

    // Per-cell min/max across the 8 corner values per channel.
    let size_m1 = size.saturating_sub(1).max(1);
    let cell_total = size_m1 * size_m1 * size_m1 * 3;
    let mut cell_min = vec![0.0f64; cell_total];
    let mut cell_max = vec![0.0f64; cell_total];
    if size >= 2 {
        for i in 0..size_m1 {
            for j in 0..size_m1 {
                for k in 0..size_m1 {
                    for c in 0..3 {
                        let mut mn = lut[idx4(size, i, j, k, c)];
                        let mut mx = mn;
                        for di in 0..2 {
                            for dj in 0..2 {
                                for dk in 0..2 {
                                    let v = lut[idx4(size, i + di, j + dj, k + dk, c)];
                                    if v < mn {
                                        mn = v;
                                    } else if v > mx {
                                        mx = v;
                                    }
                                }
                            }
                        }
                        cell_min[idx4_cell(size_m1, i, j, k, c)] = mn;
                        cell_max[idx4_cell(size_m1, i, j, k, c)] = mx;
                    }
                }
            }
        }
    }

    PreparedPchip3d {
        size,
        lut,
        slope_x,
        slope_y,
        slope_z,
        cell_min,
        cell_max,
    }
}

#[inline]
fn hermite(y0: f64, y1: f64, m0: f64, m1: f64, t: f64) -> f64 {
    let t2 = t * t;
    let t3 = t2 * t;
    let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
    let h10 = t3 - 2.0 * t2 + t;
    let h01 = -2.0 * t3 + 3.0 * t2;
    let h11 = t3 - t2;
    h00 * y0 + h10 * m0 + h01 * y1 + h11 * m1
}

#[inline]
fn linear_mix(v0: f64, v1: f64, t: f64) -> f64 {
    v0 + t * (v1 - v0)
}

#[inline]
fn bilinear_mix(v00: f64, v10: f64, v01: f64, v11: f64, tx: f64, ty: f64) -> f64 {
    let vx0 = linear_mix(v00, v10, tx);
    let vx1 = linear_mix(v01, v11, tx);
    linear_mix(vx0, vx1, ty)
}

/// `coord` is the input value in [0, size-1]; returns (base_index,
/// fractional). Matches Python `cubic_coordinate_base_fraction`.
#[inline]
fn cubic_base_fraction(coord: f64, size: usize) -> (usize, f64) {
    let c = if coord <= 0.0 {
        0.0
    } else {
        let upper = (size - 1) as f64;
        if coord >= upper { upper } else { coord }
    };
    if c >= (size - 1) as f64 {
        return (size - 2, 1.0);
    }
    let base = c.floor() as usize;
    (base, c - base as f64)
}

/// Interpolate one point. Inputs `r`, `g`, `b` are LUT-axis coordinates
/// in `[0, size-1]`. Returns the 3-channel output. Mirrors Python
/// `_pchip_interp_lut_at_3d_prepared`.
#[inline]
pub fn pchip_interp(prepared: &PreparedPchip3d, r: f64, g: f64, b: f64) -> [f64; 3] {
    let size = prepared.size;
    let (i, tr) = cubic_base_fraction(r, size);
    let (j, tg) = cubic_base_fraction(g, size);
    let (k, tb) = cubic_base_fraction(b, size);

    let lut = &prepared.lut;
    let sx = &prepared.slope_x;
    let sy = &prepared.slope_y;
    let sz = &prepared.slope_z;
    let size_m1 = size - 1;

    let mut out = [0.0f64; 3];
    for c in 0..3 {
        // Hermite along x at the 4 (y, z) corner positions of the cell.
        let v000 = hermite(
            lut[idx4(size, i, j, k, c)],
            lut[idx4(size, i + 1, j, k, c)],
            sx[idx4(size, i, j, k, c)],
            sx[idx4(size, i + 1, j, k, c)],
            tr,
        );
        let v010 = hermite(
            lut[idx4(size, i, j + 1, k, c)],
            lut[idx4(size, i + 1, j + 1, k, c)],
            sx[idx4(size, i, j + 1, k, c)],
            sx[idx4(size, i + 1, j + 1, k, c)],
            tr,
        );
        let v001 = hermite(
            lut[idx4(size, i, j, k + 1, c)],
            lut[idx4(size, i + 1, j, k + 1, c)],
            sx[idx4(size, i, j, k + 1, c)],
            sx[idx4(size, i + 1, j, k + 1, c)],
            tr,
        );
        let v011 = hermite(
            lut[idx4(size, i, j + 1, k + 1, c)],
            lut[idx4(size, i + 1, j + 1, k + 1, c)],
            sx[idx4(size, i, j + 1, k + 1, c)],
            sx[idx4(size, i + 1, j + 1, k + 1, c)],
            tr,
        );

        // Mix orthogonal-axis slopes linearly along x.
        let sy00 = linear_mix(
            sy[idx4(size, i, j, k, c)],
            sy[idx4(size, i + 1, j, k, c)],
            tr,
        );
        let sy10 = linear_mix(
            sy[idx4(size, i, j + 1, k, c)],
            sy[idx4(size, i + 1, j + 1, k, c)],
            tr,
        );
        let sy01 = linear_mix(
            sy[idx4(size, i, j, k + 1, c)],
            sy[idx4(size, i + 1, j, k + 1, c)],
            tr,
        );
        let sy11 = linear_mix(
            sy[idx4(size, i, j + 1, k + 1, c)],
            sy[idx4(size, i + 1, j + 1, k + 1, c)],
            tr,
        );

        // Hermite along y at the 2 z positions.
        let vz0 = hermite(v000, v010, sy00, sy10, tg);
        let vz1 = hermite(v001, v011, sy01, sy11, tg);

        // Bilinear mix of slope_z to the (tr, tg) point at both z corners.
        let sz0 = bilinear_mix(
            sz[idx4(size, i, j, k, c)],
            sz[idx4(size, i + 1, j, k, c)],
            sz[idx4(size, i, j + 1, k, c)],
            sz[idx4(size, i + 1, j + 1, k, c)],
            tr,
            tg,
        );
        let sz1 = bilinear_mix(
            sz[idx4(size, i, j, k + 1, c)],
            sz[idx4(size, i + 1, j, k + 1, c)],
            sz[idx4(size, i, j + 1, k + 1, c)],
            sz[idx4(size, i + 1, j + 1, k + 1, c)],
            tr,
            tg,
        );

        // Final Hermite along z, then clamp to the cell convex hull.
        let interp = hermite(vz0, vz1, sz0, sz1, tb);
        let mn = prepared.cell_min[idx4_cell(size_m1, i, j, k, c)];
        let mx = prepared.cell_max[idx4_cell(size_m1, i, j, k, c)];
        out[c] = interp.clamp(mn, mx);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_lut_returns_input() {
        // Build a 4³ LUT whose value at (i,j,k) is the normalised cell coord.
        let size = 4;
        let mut data = vec![0.0f64; size * size * size * 3];
        for i in 0..size {
            for j in 0..size {
                for k in 0..size {
                    let base = idx4(size, i, j, k, 0);
                    data[base] = i as f64 / (size - 1) as f64;
                    data[base + 1] = j as f64 / (size - 1) as f64;
                    data[base + 2] = k as f64 / (size - 1) as f64;
                }
            }
        }
        let prep = prepare_pchip_3d(data, size);
        // Sample a few exact-grid points: PCHIP must reproduce them.
        for &(r, g, b) in &[(0.0, 0.0, 0.0), (3.0, 3.0, 3.0), (1.0, 2.0, 0.0)] {
            let out = pchip_interp(&prep, r, g, b);
            let expect_r = r / 3.0;
            let expect_g = g / 3.0;
            let expect_b = b / 3.0;
            assert!((out[0] - expect_r).abs() < 1e-12, "r mismatch: {out:?}");
            assert!((out[1] - expect_g).abs() < 1e-12, "g mismatch: {out:?}");
            assert!((out[2] - expect_b).abs() < 1e-12, "b mismatch: {out:?}");
        }
    }
}
