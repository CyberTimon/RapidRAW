//! Bit-exact ports of numpy's legacy `RandomState` distribution
//! algorithms. Used by the CPU "export-mode" grain path to produce the
//! same per-pixel noise as the Python reference (`scipy.stats.poisson.rvs`
//! / `scipy.stats.binom.rvs` end up calling numpy's `random_poisson` /
//! `random_binomial`).
//!
//! The MT19937 implementation is `rand_mt::Mt`, which produces identical
//! 32-bit output to numpy from the same scalar seed (verified against
//! `numpy.random.RandomState(0)` — the first five draws are
//! 2357136044, 2546248239, 3071714933, 3626093760, 2588848963 on both
//! implementations).
//!
//! Source for the distribution algorithms: NumPy's legacy
//! `numpy/random/src/mt19937/randomkit.c` (now `_mt19937.pyx`):
//!   * `rk_double`            — 53-bit double from two MT19937 outputs
//!   * `rk_poisson_mult`      — multiplication of uniforms (λ < 10)
//!   * `rk_poisson_ptrs`      — Hörmann's transformed rejection (λ ≥ 10)
//!   * `rk_binomial_inversion`— inverse CDF (n·p ≤ 30)
//!   * `rk_binomial_btpe`     — Kachitvichyanukul-Schmeiser BTPE (n·p > 30)

use rand::RngCore as _;
use rand_mt::Mt;

/// Numpy's `rk_double`: build a 53-bit double from two MT19937 outputs.
/// `(hi >> 5) * 2^26 + (lo >> 6)` then divide by 2^53.
#[inline]
pub fn rk_double(rng: &mut Mt) -> f64 {
    let a = (rng.next_u32() as u64) >> 5; // 27 bits
    let b = (rng.next_u32() as u64) >> 6; // 26 bits
    (a as f64 * 67108864.0 + b as f64) / 9007199254740992.0
}

/// Stateful sampler for numpy's `rk_gauss` — wraps an `Mt` with the
/// one-sample cache that the polar Box-Muller transform requires.
/// Two normal variates are generated per rejection-sampling pass; one
/// is returned now, the other is cached for the next call. Matches
/// `numpy.random.RandomState.standard_normal` bit-exactly when seeded
/// identically.
pub struct GaussRng {
    pub rng: Mt,
    has_gauss: bool,
    gauss: f64,
}

impl GaussRng {
    pub fn new(seed: u32) -> Self {
        Self {
            rng: Mt::new(seed),
            has_gauss: false,
            gauss: 0.0,
        }
    }

    pub fn from_mt(rng: Mt) -> Self {
        Self {
            rng,
            has_gauss: false,
            gauss: 0.0,
        }
    }

    /// Numpy's `rk_gauss`: polar Box-Muller with rejection sampling.
    /// Returns a single N(0,1) sample; caches the other for the next call.
    pub fn gauss(&mut self) -> f64 {
        if self.has_gauss {
            let v = self.gauss;
            self.has_gauss = false;
            self.gauss = 0.0;
            return v;
        }
        loop {
            let x1 = 2.0 * rk_double(&mut self.rng) - 1.0;
            let x2 = 2.0 * rk_double(&mut self.rng) - 1.0;
            let r2 = x1 * x1 + x2 * x2;
            if r2 < 1.0 && r2 != 0.0 {
                let f = (-2.0 * r2.ln() / r2).sqrt();
                self.gauss = f * x1;
                self.has_gauss = true;
                return f * x2;
            }
        }
    }
}

/// Numpy's Poisson sampler. Dispatches between two algorithms depending
/// on the rate. Matches `numpy.random.RandomState.poisson` bit-exactly.
#[inline]
pub fn rk_poisson(rng: &mut Mt, lam: f64) -> u64 {
    if lam >= 10.0 {
        rk_poisson_ptrs(rng, lam)
    } else if lam == 0.0 {
        0
    } else {
        rk_poisson_mult(rng, lam)
    }
}

/// Multiplication-of-uniforms variant for small λ.
fn rk_poisson_mult(rng: &mut Mt, lam: f64) -> u64 {
    let enlam = (-lam).exp();
    let mut x: u64 = 0;
    let mut prod = 1.0_f64;
    loop {
        let u = rk_double(rng);
        prod *= u;
        if prod > enlam {
            x += 1;
        } else {
            return x;
        }
    }
}

/// Hörmann 1993 PTRS algorithm for λ ≥ 10. Verbatim port of numpy.
fn rk_poisson_ptrs(rng: &mut Mt, lam: f64) -> u64 {
    let slam = lam.sqrt();
    let loglam = lam.ln();
    let b = 0.931 + 2.53 * slam;
    let a = -0.059 + 0.02483 * b;
    let invalpha = 1.1239 + 1.1328 / (b - 3.4);
    let vr = 0.9277 - 3.6224 / (b - 2.0);
    loop {
        let u = rk_double(rng) - 0.5;
        let v = rk_double(rng);
        let us = 0.5 - u.abs();
        // numpy casts via `(long)floor(...)` — for positive doubles the
        // result is the floor toward zero; for negative it rounds toward
        // -∞ then truncates. We mirror exactly by computing the floor as
        // f64 and casting through i64 (numpy's `long` is 64-bit on macOS).
        let k_f = ((2.0 * a / us + b) * u + lam + 0.43).floor();
        let k = k_f as i64;
        if us >= 0.07 && v <= vr {
            return k as u64;
        }
        if k < 0 || (us < 0.013 && v > us) {
            continue;
        }
        let lhs = v.ln() + invalpha.ln() - (a / (us * us) + b).ln();
        // numpy uses `loggam(k+1) = ln Γ(k+1) = ln(k!)`. libm provides
        // `lgamma_r` returning (value, sign) — for positive args the
        // sign is always +1, so just take the value.
        let kp1 = (k as f64) + 1.0;
        let rhs = -lam + (k as f64) * loglam - lgamma(kp1);
        if lhs <= rhs {
            return k as u64;
        }
    }
}

/// Numpy's binomial sampler. Dispatches by both `p` and `n*p`. Returns
/// the same draw as `numpy.random.RandomState.binomial`.
#[inline]
pub fn rk_binomial(rng: &mut Mt, n: u64, p: f64) -> u64 {
    if p <= 0.5 {
        if (p * n as f64) <= 30.0 {
            rk_binomial_inversion(rng, n, p)
        } else {
            rk_binomial_btpe(rng, n, p)
        }
    } else {
        let q = 1.0 - p;
        if (q * n as f64) <= 30.0 {
            n - rk_binomial_inversion(rng, n, q)
        } else {
            n - rk_binomial_btpe(rng, n, q)
        }
    }
}

/// Inverse-CDF inversion sampler for small variance.
fn rk_binomial_inversion(rng: &mut Mt, n: u64, p: f64) -> u64 {
    let q = 1.0 - p;
    let qn = ((n as f64) * q.ln()).exp();
    let np = (n as f64) * p;
    let bound = (n as f64).min(np + 10.0 * (np * q + 1.0).sqrt()) as u64;
    let mut x: u64 = 0;
    let mut px = qn;
    let mut u = rk_double(rng);
    while u > px {
        x += 1;
        if x > bound {
            x = 0;
            px = qn;
            u = rk_double(rng);
        } else {
            u -= px;
            px = (((n - x + 1) as f64) * p * px) / ((x as f64) * q);
        }
    }
    x
}

/// BTPE (Binomial Transformed P-rejection Even) algorithm for n·p > 30.
/// Verbatim port of numpy's `rk_binomial_btpe` (which is in turn the
/// canonical Kachitvichyanukul-Schmeiser 1988 paper). Heavy lifting —
/// preserved literal `goto`-style control flow as loops + labels.
#[allow(clippy::many_single_char_names)]
fn rk_binomial_btpe(rng: &mut Mt, n: u64, p: f64) -> u64 {
    let r = p.min(1.0 - p);
    let q = 1.0 - r;
    let nf = n as f64;
    let fm = nf * r + r;
    let m = fm.floor() as i64;
    let p1 = (2.195 * (nf * r * q).sqrt() - 4.6 * q).floor() + 0.5;
    let xm = m as f64 + 0.5;
    let xl = xm - p1;
    let xr = xm + p1;
    let c = 0.134 + 20.5 / (15.3 + m as f64);
    let a1 = (fm - xl) / (fm - xl * r);
    let laml = a1 * (1.0 + a1 / 2.0);
    let a2 = (xr - fm) / (xr * q);
    let lamr = a2 * (1.0 + a2 / 2.0);
    let p2 = p1 * (1.0 + 2.0 * c);
    let p3 = p2 + c / laml;
    let p4 = p3 + c / lamr;
    let nrq = nf * r * q;

    let y: i64;
    'outer: loop {
        let u = rk_double(rng) * p4;
        let mut v = rk_double(rng);

        // Step 10 / 20 / 30 / 40: candidate y, possibly updating v.
        let cand;
        if u <= p1 {
            cand = (xm - p1 * v + u).floor() as i64;
            // Skip 20-50 — straight to Step 60.
            y = cand;
            break 'outer;
        } else if u <= p2 {
            let x = xl + (u - p1) / c;
            v = v * c + 1.0 - ((m as f64) - x + 0.5).abs() / p1;
            if v > 1.0 {
                continue 'outer;
            }
            cand = x.floor() as i64;
        } else if u <= p3 {
            cand = (xl + v.ln() / laml).floor() as i64;
            if cand < 0 {
                continue 'outer;
            }
            v *= (u - p2) * laml;
        } else {
            cand = (xr - v.ln() / lamr).floor() as i64;
            if cand > n as i64 {
                continue 'outer;
            }
            v *= (u - p3) * lamr;
        }

        // Step 50: squeeze test, then full acceptance check.
        let k = (cand - m).unsigned_abs() as i64;
        if k <= 20 || k as f64 >= nrq / 2.0 - 1.0 {
            // Full test path (Step 51).
            let s = r / q;
            let a_step51 = s * (nf + 1.0);
            let mut f = 1.0_f64;
            if m < cand {
                for i in (m + 1)..=cand {
                    f *= a_step51 / (i as f64) - s;
                }
            } else if m > cand {
                for i in (cand + 1)..=m {
                    f /= a_step51 / (i as f64) - s;
                }
            }
            if v > f {
                continue 'outer;
            }
        } else {
            // Step 52: squeeze test using Stirling's approximation.
            let kf = k as f64;
            let rho =
                (kf / nrq) * ((kf * (kf / 3.0 + 0.625) + 0.166_666_666_666_666_66) / nrq + 0.5);
            let t = -kf * kf / (2.0 * nrq);
            let a_log = v.ln();
            if a_log < t - rho {
                y = cand;
                break 'outer;
            }
            if a_log > t + rho {
                continue 'outer;
            }
            // Final Stirling-bounded acceptance.
            let x1 = (cand + 1) as f64;
            let f1 = (m + 1) as f64;
            let z = (n as i64 - m + 1) as f64;
            let w = (n as i64 - cand + 1) as f64;
            let x2 = x1 * x1;
            let f2 = f1 * f1;
            let z2 = z * z;
            let w2 = w * w;
            let bound = xm * (f1 / x1).ln()
                + (nf - m as f64 + 0.5) * (z / w).ln()
                + ((cand - m) as f64) * (w * r / (x1 * q)).ln()
                + (13680.0 - (462.0 - (132.0 - (99.0 - 140.0 / f2) / f2) / f2) / f2)
                    / f1
                    / 166320.0
                + (13680.0 - (462.0 - (132.0 - (99.0 - 140.0 / z2) / z2) / z2) / z2) / z / 166320.0
                + (13680.0 - (462.0 - (132.0 - (99.0 - 140.0 / x2) / x2) / x2) / x2)
                    / x1
                    / 166320.0
                + (13680.0 - (462.0 - (132.0 - (99.0 - 140.0 / w2) / w2) / w2) / w2) / w / 166320.0;
            if a_log > bound {
                continue 'outer;
            }
        }
        y = cand;
        break 'outer;
    }

    let y_pos = if p > 0.5 { n as i64 - y } else { y };
    y_pos as u64
}

/// `ln Γ(x)` via libm. Returns the unsigned magnitude — numpy's
/// `loggam` is only called on positive arguments where the sign is +1.
#[inline]
fn lgamma(x: f64) -> f64 {
    libm::lgamma(x)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand_mt::Mt;

    /// Reference values from `numpy.random.RandomState(0)`. Verified by
    /// running `np.random.seed(0); np.random.randint(0, 2**32, dtype=np.uint32)`
    /// five times.
    #[test]
    fn mt19937_matches_numpy_seed_0() {
        let mut g = Mt::new(0u32);
        let expected = [2357136044, 2546248239, 3071714933, 3626093760, 2588848963];
        for &e in &expected {
            assert_eq!(g.next_u32(), e);
        }
    }

    /// Reference: `np.random.RandomState(0).poisson(5, size=10)`
    ///   →  [9 5 6 5 5 8 4 5 4 3]
    #[test]
    fn poisson_lam5_matches_numpy_seed_0() {
        let mut g = Mt::new(0u32);
        let got: Vec<u64> = (0..10).map(|_| rk_poisson(&mut g, 5.0)).collect();
        assert_eq!(got, vec![9, 5, 6, 5, 5, 8, 4, 5, 4, 3]);
    }

    /// Reference: `np.random.RandomState(0).binomial(20, 0.3, size=10)`
    ///   →  [6 7 6 6 6 7 6 9 10 5]
    #[test]
    fn binomial_n20_p03_matches_numpy_seed_0() {
        let mut g = Mt::new(0u32);
        let got: Vec<u64> = (0..10).map(|_| rk_binomial(&mut g, 20, 0.3)).collect();
        assert_eq!(got, vec![6, 7, 6, 6, 6, 7, 6, 9, 10, 5]);
    }
}
