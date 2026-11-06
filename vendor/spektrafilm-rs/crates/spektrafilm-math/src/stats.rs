/// Fast statistical distributions for grain simulation.
///
/// Port of Python `fast_stats.py`.
use rand::Rng;
use rand_distr::{Distribution, Normal, Poisson};

/// Sample from Poisson distribution with given lambda.
/// Uses Knuth's algorithm for small lambda, normal approximation for large.
#[inline]
pub fn sample_poisson(rng: &mut impl Rng, lambda: f64) -> u32 {
    if lambda <= 0.0 {
        return 0;
    }
    if lambda > 30.0 {
        // Normal approximation: Poisson(λ) ≈ N(λ, λ)
        let normal = Normal::new(lambda, lambda.sqrt()).unwrap();
        return normal.sample(rng).round().max(0.0) as u32;
    }
    let poisson = Poisson::new(lambda).unwrap();
    poisson.sample(rng) as u32
}

/// Sample from Binomial(n, p) distribution.
/// For large n, uses normal approximation.
#[inline]
pub fn sample_binomial(rng: &mut impl Rng, n: u32, p: f64) -> u32 {
    if n == 0 || p <= 0.0 {
        return 0;
    }
    if p >= 1.0 {
        return n;
    }

    let nf = n as f64;
    let mean = nf * p;
    let variance = nf * p * (1.0 - p);

    if variance > 9.0 {
        // Normal approximation
        let normal = Normal::new(mean, variance.sqrt()).unwrap();
        let v = normal.sample(rng).round();
        return v.clamp(0.0, nf) as u32;
    }

    // Direct sampling for small n
    let mut count = 0u32;
    for _ in 0..n {
        if rng.random::<f64>() < p {
            count += 1;
        }
    }
    count
}

/// Sample from LogNormal distribution with given mean and sigma of the log.
#[inline]
pub fn sample_lognormal(rng: &mut impl Rng, mu: f64, sigma: f64) -> f64 {
    let normal = Normal::new(mu, sigma).unwrap();
    normal.sample(rng).exp()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use rand::rngs::StdRng;

    #[test]
    fn test_poisson_mean() {
        let mut rng = StdRng::seed_from_u64(42);
        let lambda = 10.0;
        let n = 10000;
        let sum: f64 = (0..n)
            .map(|_| sample_poisson(&mut rng, lambda) as f64)
            .sum();
        let mean = sum / n as f64;
        assert!(
            (mean - lambda).abs() < 0.5,
            "Poisson mean {mean} far from {lambda}"
        );
    }

    #[test]
    fn test_binomial_mean() {
        let mut rng = StdRng::seed_from_u64(42);
        let n_trials = 100u32;
        let p = 0.3;
        let n_samples = 10000;
        let sum: f64 = (0..n_samples)
            .map(|_| sample_binomial(&mut rng, n_trials, p) as f64)
            .sum();
        let mean = sum / n_samples as f64;
        let expected = n_trials as f64 * p;
        assert!(
            (mean - expected).abs() < 1.0,
            "Binomial mean {mean} far from {expected}"
        );
    }

    #[test]
    fn test_poisson_zero() {
        let mut rng = StdRng::seed_from_u64(42);
        assert_eq!(sample_poisson(&mut rng, 0.0), 0);
    }
}
