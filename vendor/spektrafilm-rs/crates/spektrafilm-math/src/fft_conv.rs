//! FFT-based 2D convolution with numpy-`reflect` boundaries.
//!
//! Reproduces the boundary math the Python diffusion filter relies on:
//!
//! ```text
//! padded = np.pad(channel, r, mode='reflect')          # r = (k - 1) / 2
//! full   = fftconvolve(padded, psf, mode='same')        # central (h+2r)
//! out    = full[r : r+h]                                 # crop the pad back off
//! ```
//!
//! which is equivalent to taking indices `[2r, 2r+h)` of the full linear
//! convolution of the reflect-padded channel with the `k×k` PSF. The
//! result is the exact discrete convolution scipy computes (the only
//! divergence from scipy is FFT round-off, ~1e-12 relative in f64).
//!
//! The caller is expected to clamp the kernel radius so `r < min(h, w)`
//! (the diffusion filter caps it at `min(dim)/2 - 1`); single-bounce
//! reflect padding then always has enough samples to mirror.

use rustfft::{FftPlanner, num_complex::Complex};

/// Convolve one `h×w` f64 image channel (row-major) with an odd `k×k` PSF
/// (row-major), using numpy-`reflect` boundary handling. Returns `h×w`.
pub fn convolve2d_reflect(channel: &[f64], h: usize, w: usize, psf: &[f64], k: usize) -> Vec<f64> {
    assert_eq!(channel.len(), h * w, "channel size mismatch");
    assert_eq!(psf.len(), k * k, "psf size mismatch");
    assert!(k % 2 == 1, "kernel side must be odd");
    let r = (k - 1) / 2;
    assert!(
        r < h && r < w,
        "radius {r} too large for {h}x{w} (reflect needs r < dim)"
    );

    // FFT dimensions: at least the full linear-conv length `(h+2r)+(k-1) =
    // h+4r` (so there's no circular wraparound), rounded up to the next
    // "fast" 2·3·5·7·11-smooth size. The extra zero-padding doesn't change
    // the convolution result in `[0, h+4r)` — the window we extract — it
    // just keeps the transform off slow large-prime sizes (this is what
    // scipy.fftconvolve does, and it's a multiple-× speedup for awkward
    // `h+4r`).
    let fh = next_fast_len(h + 4 * r);
    let fw = next_fast_len(w + 4 * r);

    // Reflect-padded channel laid into the top-left (h+2r)×(w+2r) of an
    // fh×fw complex buffer; the rest stays zero for the linear convolution.
    let mut img = vec![Complex::new(0.0, 0.0); fh * fw];
    for pr in 0..(h + 2 * r) {
        let sr = reflect_src(pr, r, h);
        for pc in 0..(w + 2 * r) {
            let sc = reflect_src(pc, r, w);
            img[pr * fw + pc] = Complex::new(channel[sr * w + sc], 0.0);
        }
    }

    // PSF laid into the top-left k×k.
    let mut ker = vec![Complex::new(0.0, 0.0); fh * fw];
    for kr in 0..k {
        for kc in 0..k {
            ker[kr * fw + kc] = Complex::new(psf[kr * k + kc], 0.0);
        }
    }

    let mut planner = FftPlanner::<f64>::new();
    fft2d(&mut img, fh, fw, &mut planner, false);
    fft2d(&mut ker, fh, fw, &mut planner, false);

    for (a, b) in img.iter_mut().zip(ker.iter()) {
        *a *= *b;
    }

    fft2d(&mut img, fh, fw, &mut planner, true);
    // rustfft is unnormalised; divide the inverse by N.
    let norm = 1.0 / (fh * fw) as f64;

    // Extract the central window: `same` starts at r, the pad crop removes
    // another r, so the original-image region is full[2r .. 2r+h].
    let mut out = vec![0.0f64; h * w];
    for i in 0..h {
        let src_row = (i + 2 * r) * fw + 2 * r;
        for j in 0..w {
            out[i * w + j] = img[src_row + j].re * norm;
        }
    }
    out
}

/// Smallest integer `>= target` whose only prime factors are 2, 3, 5, 7,
/// 11 — a "fast" FFT length (matches scipy.fft.next_fast_len). Such sizes
/// are dense, so the search terminates quickly.
fn next_fast_len(target: usize) -> usize {
    if target <= 6 {
        return target.max(1);
    }
    let mut n = target;
    loop {
        let mut m = n;
        for p in [2usize, 3, 5, 7, 11] {
            while m % p == 0 {
                m /= p;
            }
        }
        if m == 1 {
            return n;
        }
        n += 1;
    }
}

/// numpy-`reflect` source index for a padded coordinate. `p` is the
/// padded coordinate in `0..n+2r`; the centre `[r, r+n)` maps to `[0, n)`,
/// the borders mirror across the edge samples without repeating them.
#[inline]
fn reflect_src(p: usize, r: usize, n: usize) -> usize {
    let s = p as isize - r as isize;
    if s < 0 {
        (-s) as usize
    } else if s >= n as isize {
        (2 * (n as isize - 1) - s) as usize
    } else {
        s as usize
    }
}

/// In-place 2D FFT on a row-major `h×w` complex buffer. Both passes run as
/// contiguous, rayon-parallel row transforms: the row pass directly, the
/// column pass on a transposed copy (so it too is contiguous), then
/// transposed back. Per-thread FFT scratch via `for_each_init`.
fn fft2d(
    buf: &mut [Complex<f64>],
    h: usize,
    w: usize,
    planner: &mut FftPlanner<f64>,
    inverse: bool,
) {
    use rayon::prelude::*;
    let mut plan = |n: usize| {
        if inverse {
            planner.plan_fft_inverse(n)
        } else {
            planner.plan_fft_forward(n)
        }
    };

    // Row pass (length w), parallel over the h contiguous rows.
    let row_fft = plan(w);
    let row_scratch = row_fft.get_inplace_scratch_len();
    buf.par_chunks_mut(w).for_each_init(
        || vec![Complex::new(0.0, 0.0); row_scratch],
        |scratch, row| row_fft.process_with_scratch(row, scratch),
    );

    // Column pass: transpose so columns become contiguous rows, transform,
    // transpose back. Transposes are parallel over destination rows.
    let mut t = vec![Complex::new(0.0, 0.0); h * w];
    transpose(buf, &mut t, h, w);
    let col_fft = plan(h);
    let col_scratch = col_fft.get_inplace_scratch_len();
    t.par_chunks_mut(h).for_each_init(
        || vec![Complex::new(0.0, 0.0); col_scratch],
        |scratch, row| col_fft.process_with_scratch(row, scratch),
    );
    transpose(&t, buf, w, h);
}

/// Transpose a row-major `rows×cols` complex matrix into `dst` (`cols×rows`),
/// parallel over destination rows.
fn transpose(src: &[Complex<f64>], dst: &mut [Complex<f64>], rows: usize, cols: usize) {
    use rayon::prelude::*;
    dst.par_chunks_mut(rows)
        .enumerate()
        .for_each(|(c, out_row)| {
            for (r, slot) in out_row.iter_mut().enumerate() {
                *slot = src[r * cols + c];
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Direct (brute-force) reflect convolution: the exact discrete sum the
    /// FFT path computes — `out[i,j] = Σ psf[ki,kj]·channel[reflect(2r+i-ki),
    /// reflect(2r+j-kj)]`.
    fn brute(channel: &[f64], h: usize, w: usize, psf: &[f64], k: usize) -> Vec<f64> {
        let r = (k - 1) / 2;
        let mut out = vec![0.0; h * w];
        for i in 0..h {
            for j in 0..w {
                let mut acc = 0.0;
                for ki in 0..k {
                    let sr = reflect_src(2 * r + i - ki, r, h);
                    for kj in 0..k {
                        let sc = reflect_src(2 * r + j - kj, r, w);
                        acc += psf[ki * k + kj] * channel[sr * w + sc];
                    }
                }
                out[i * w + j] = acc;
            }
        }
        out
    }

    #[test]
    fn fft_matches_direct_reflect_conv() {
        // Asymmetric kernel catches convolution-vs-correlation flip errors.
        let (h, w, k) = (7usize, 9usize, 5usize);
        let channel: Vec<f64> = (0..h * w).map(|i| ((i * 37 % 13) as f64) - 6.0).collect();
        let psf: Vec<f64> = (0..k * k).map(|i| (i as f64 + 1.0) * 0.013).collect();

        let got = convolve2d_reflect(&channel, h, w, &psf, k);
        let want = brute(&channel, h, w, &psf, k);

        let max_abs = got
            .iter()
            .zip(&want)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f64, f64::max);
        assert!(
            max_abs < 1e-10,
            "FFT conv diverged from direct: {max_abs:e}"
        );
    }

    #[test]
    fn unit_kernel_is_identity() {
        let (h, w) = (6usize, 5usize);
        let channel: Vec<f64> = (0..h * w).map(|i| i as f64).collect();
        // 3x3 kernel with a single 1.0 at the centre → identity.
        let mut psf = vec![0.0; 9];
        psf[4] = 1.0;
        let got = convolve2d_reflect(&channel, h, w, &psf, 3);
        let max_abs = got
            .iter()
            .zip(&channel)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f64, f64::max);
        assert!(
            max_abs < 1e-10,
            "identity kernel changed the image: {max_abs:e}"
        );
    }
}
