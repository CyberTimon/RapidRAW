//! SIMD-vectorised whole-array transcendentals via Apple's vForce
//! (part of the Accelerate framework). vForce is what numpy reaches
//! for under the hood; calling it directly lets us match numpy's
//! per-element wall time for `10^x`, which would otherwise be 5–10×
//! slower as scalar `f64::powf` calls from Rust.
//!
//! `exp10` is implemented via `vvpow(y, exp, base, &n)` with a
//! reusable buffer of 10.0 in `base`. vvpow calls libm `pow` per
//! lane, so the result is bit-identical to `10.0f64.powf(x)` (we
//! verified empirically — substituting `exp(x · ln 10)` regressed
//! parity from "5 pixels out of 1.5M" to ~7 % off-by->2). The
//! `base` allocation per call (≤ chunk size, capped at 64 K f64s
//! = 512 KB) is negligible vs the vvpow throughput.
//!
//! On non-Apple targets the fallbacks loop over the slice scalar-style
//! so callers can use these unconditionally.

#[cfg(target_vendor = "apple")]
unsafe extern "C" {
    /// `y[i] = base[i] ^ exp[i]`. Note the order: exponent first, base
    /// second — Apple's vForce convention, not the math one.
    fn vvpow(y: *mut f64, exp: *const f64, base: *const f64, n: *const i32);
}

/// `out[i] = 10^x[i]` for i in 0..len, in place. Bit-identical to
/// libm `pow(10, x)`.
#[inline]
pub fn exp10_inplace(buf: &mut [f64]) {
    #[cfg(target_vendor = "apple")]
    {
        // Process in cache-friendly chunks. 64 K f64s is 512 KB —
        // fits in L2 on every Apple Silicon chip and lets the base
        // buffer stay tiny vs the working set.
        const CHUNK: usize = 1 << 16;
        let base = vec![10.0f64; CHUNK.min(buf.len()).max(1)];
        for slice in buf.chunks_mut(CHUNK) {
            let n = slice.len() as i32;
            unsafe { vvpow(slice.as_mut_ptr(), slice.as_ptr(), base.as_ptr(), &n) };
        }
    }
    #[cfg(not(target_vendor = "apple"))]
    {
        for v in buf.iter_mut() {
            *v = 10.0f64.powf(*v);
        }
    }
}
