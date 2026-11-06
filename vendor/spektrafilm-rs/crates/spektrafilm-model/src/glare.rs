// Viewing glare simulation.
// Adds a small fraction of randomized blurred illuminant to simulate surface reflections.

use rand::SeedableRng;
use rand::rngs::StdRng;
use rand_distr::{Distribution, LogNormal};
use spektrafilm_math::gaussian;
use spektrafilm_math::image::ImageBuf;
use spektrafilm_math::precision::{Scalar, from_f32, from_f64};

/// Generate the per-pixel glare_amount field (lognormal sampled, then blurred, then /100).
///
/// Port of Python `compute_random_glare_amount` (model/glare.py:19). The lognormal
/// parameters are inverted from linear-space mean and std:
///   σ = sqrt( ln(1 + (s²/m²)) )
///   μ = ln(m) - σ²/2
///
/// Spatial blur uses our 2D gaussian filter; the result is divided by 100 (CC-style fraction).
pub fn compute_random_glare_amount(
    width: u32,
    height: u32,
    percent: f32,
    roughness: f32,
    blur: f32,
    seed: u64,
) -> Vec<Scalar> {
    let n_pixels = (width as usize) * (height as usize);
    if percent <= 0.0 {
        return vec![Scalar::default(); n_pixels];
    }
    let m = percent as f64;
    let s = (roughness * percent) as f64;
    let sigma2 = (1.0 + (s * s) / (m * m)).ln();
    let sigma = sigma2.sqrt();
    let mu = m.ln() - sigma2 / 2.0;
    let dist = LogNormal::new(mu, sigma).unwrap_or_else(|_| LogNormal::new(0.0, 1.0).unwrap());
    let mut rng = StdRng::seed_from_u64(seed);

    let mut glare: Vec<Scalar> = (0..n_pixels)
        .map(|_| from_f64(dist.sample(&mut rng)))
        .collect();

    if blur > 0.0 {
        // 2D gaussian filter via our 3-channel image kernel; broadcast scalar field to RGB.
        let mut img = ImageBuf::from_data(
            width,
            height,
            glare.iter().flat_map(|&v| [v, v, v]).collect(),
        );
        img = gaussian::gaussian_blur(&img, blur);
        glare = img.extract_channel(0);
    }

    // Divide by 100 (CC-style fraction).
    let inv100 = from_f64(1.0 / 100.0);
    for v in &mut glare {
        *v *= inv100;
    }
    glare
}

/// Add glare in any 3-channel image space — XYZ or RGB.
///
/// `space_per_pixel_offset` is the per-color constant offset vector. For XYZ-space glare
/// this is `illuminant_xyz`. For RGB-space glare it's `M * illuminant_xyz` where M is the
/// CAT+matrix that would convert XYZ → output RGB. By linearity:
///   `M * (xyz + g * illu) = M*xyz + g * (M*illu)`
/// so applying glare in either space gives the same result.
///
/// `glare_amount` must be `width*height` Scalar values from `compute_random_glare_amount`.
pub fn add_glare_with_amount(
    image: &mut ImageBuf,
    glare_amount: &[Scalar],
    space_offset: [Scalar; 3],
) {
    debug_assert_eq!(glare_amount.len(), image.pixel_count());
    for (i, px) in image.pixels_mut().enumerate() {
        let g = glare_amount[i];
        px[0] += g * space_offset[0];
        px[1] += g * space_offset[1];
        px[2] += g * space_offset[2];
    }
}

/// Add viewing glare to an XYZ image.
///
/// Port of Python `add_glare`. Generates a random glare pattern
/// using lognormal distribution, blurs it, and adds it as
/// a fraction of the illuminant.
pub fn add_glare(
    xyz: &ImageBuf,
    illuminant_xyz: [f32; 3],
    percent: f32,
    roughness: f32,
    blur: f32,
) -> ImageBuf {
    if percent <= 0.0 {
        return xyz.clone();
    }

    let n_pixels = xyz.pixel_count();
    let amount = percent;
    let sigma = roughness * amount;

    // Generate random glare amount per pixel
    let mu = (amount as f64).ln() - 0.5 * (sigma as f64 / amount as f64).powi(2).ln_1p();
    let s = ((sigma as f64 / amount as f64).powi(2).ln_1p()).sqrt();
    let dist = LogNormal::new(mu, s).unwrap_or_else(|_| LogNormal::new(0.0, 1.0).unwrap());
    let mut rng = StdRng::seed_from_u64(42);

    let mut glare_map: Vec<Scalar> = (0..n_pixels)
        .map(|_| from_f64(dist.sample(&mut rng)))
        .collect();

    // Blur the glare map
    if blur > 0.0 {
        let mut glare_img = ImageBuf::from_data(
            xyz.width,
            xyz.height,
            glare_map.iter().flat_map(|&v| [v, v, v]).collect(),
        );
        glare_img = gaussian::gaussian_blur(&glare_img, blur);
        glare_map = glare_img.extract_channel(0);
    }

    // Apply: xyz += glare_amount * illuminant_xyz / 100
    let illum = [
        from_f32(illuminant_xyz[0]),
        from_f32(illuminant_xyz[1]),
        from_f32(illuminant_xyz[2]),
    ];
    let inv100 = from_f64(1.0 / 100.0);
    let mut result = xyz.clone();
    for (i, px) in result.pixels_mut().enumerate() {
        let g = glare_map[i] * inv100;
        px[0] += g * illum[0];
        px[1] += g * illum[1];
        px[2] += g * illum[2];
    }

    result
}
