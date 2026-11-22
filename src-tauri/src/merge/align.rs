use crate::merge::features::{FeatureSet, detect_features};
use crate::merge::homography::{Correspondence, estimate_homography, fit_homography};
use crate::merge::matching::match_features;
use crate::merge::raster::Raster;
use nalgebra::{Matrix3, Vector2, Vector3};
use rayon::prelude::*;

const MAX_FEATURES: usize = 4000;
const INLIER_THRESHOLD: f64 = 2.0;
const MIN_INLIERS: usize = 24;
const MIN_INLIER_RATIO: f64 = 0.15;
const MAX_CORNER_SHIFT: f64 = 0.2;
const RANSAC_SEED: u64 = 0x5eed_a11c;

pub struct AlignmentFeatures {
    features: FeatureSet,
    scale: f64,
    width: f64,
    height: f64,
}

impl AlignmentFeatures {
    pub fn detect(gray: &Raster, full_width: usize, full_height: usize) -> Self {
        assert_eq!(gray.channels, 1, "alignment features need a gray image");
        AlignmentFeatures {
            features: detect_features(gray, MAX_FEATURES),
            scale: full_width as f64 / gray.width as f64,
            width: full_width as f64,
            height: full_height as f64,
        }
    }

    fn full_resolution(&self, index: usize) -> Vector2<f64> {
        let kp = self.features.keypoints[index];
        Vector2::new(
            (kp.x as f64 + 0.5) * self.scale - 0.5,
            (kp.y as f64 + 0.5) * self.scale - 0.5,
        )
    }
}

pub fn apply(h: &Matrix3<f64>, x: f64, y: f64) -> Option<(f64, f64)> {
    let p = h * Vector3::new(x, y, 1.0);
    (p.z.abs() > 1e-12).then(|| (p.x / p.z, p.y / p.z))
}

fn is_plausible(h: &Matrix3<f64>, width: f64, height: f64) -> bool {
    let diagonal = (width * width + height * height).sqrt();
    [(0.0, 0.0), (width, 0.0), (0.0, height), (width, height)]
        .iter()
        .all(|&(x, y)| {
            apply(h, x, y).is_some_and(|(u, v)| {
                ((u - x).powi(2) + (v - y).powi(2)).sqrt() < MAX_CORNER_SHIFT * diagonal
            })
        })
}

pub fn estimate_transform(
    reference: &AlignmentFeatures,
    moving: &AlignmentFeatures,
) -> Option<Matrix3<f64>> {
    let matches = match_features(&reference.features, &moving.features);
    if matches.len() < MIN_INLIERS {
        return None;
    }
    let correspondences: Vec<Correspondence> = matches
        .iter()
        .map(|&(a, b)| (reference.full_resolution(a), moving.full_resolution(b)))
        .collect();
    let threshold = INLIER_THRESHOLD * reference.scale.max(1.0);
    let inliers = estimate_homography(&correspondences, threshold, RANSAC_SEED)?;
    if inliers.len() < MIN_INLIERS
        || (inliers.len() as f64) < MIN_INLIER_RATIO * correspondences.len() as f64
    {
        return None;
    }
    let h = fit_homography(&correspondences, &inliers)?;
    is_plausible(&h, reference.width, reference.height).then_some(h)
}

pub fn max_displacement(h: &Matrix3<f64>, width: f64, height: f64) -> f64 {
    [(0.0, 0.0), (width, 0.0), (0.0, height), (width, height)]
        .iter()
        .map(|&(x, y)| {
            apply(h, x, y).map_or(f64::INFINITY, |(u, v)| {
                ((u - x).powi(2) + (v - y).powi(2)).sqrt()
            })
        })
        .fold(0.0, f64::max)
}

pub fn downscaled(h: &Matrix3<f64>, factor: f64) -> Matrix3<f64> {
    let offset = 0.5 * factor - 0.5;
    let to_full = Matrix3::new(factor, 0.0, offset, 0.0, factor, offset, 0.0, 0.0, 1.0);
    let from_full = to_full.try_inverse().expect("scaling matrix is invertible");
    from_full * h * to_full
}

pub fn warp(
    source: &Raster,
    h: &Matrix3<f64>,
    width: usize,
    height: usize,
    bicubic: bool,
) -> (Raster, Vec<f32>) {
    warp_with(source, width, height, bicubic, |x, y| apply(h, x, y))
}

pub fn warp_with(
    source: &Raster,
    width: usize,
    height: usize,
    bicubic: bool,
    map: impl Fn(f64, f64) -> Option<(f64, f64)> + Sync,
) -> (Raster, Vec<f32>) {
    let ch = source.channels;
    let mut out = Raster::new(width, height, ch);
    let mut valid = vec![0.0f32; width * height];
    let (sw, sh) = (source.width as f64, source.height as f64);
    out.data
        .par_chunks_mut(width * ch)
        .zip(valid.par_chunks_mut(width))
        .enumerate()
        .for_each(|(y, (row, valid_row))| {
            let mut sample = [0.0f32; 4];
            for x in 0..width {
                let Some((u, v)) = map(x as f64, y as f64) else {
                    continue;
                };
                if bicubic {
                    source.bicubic(u as f32, v as f32, &mut sample[..ch]);
                } else {
                    source.bilinear(u as f32, v as f32, &mut sample[..ch]);
                }
                row[x * ch..x * ch + ch].copy_from_slice(&sample[..ch]);
                let edge = (u + 0.5).min(v + 0.5).min(sw - 0.5 - u).min(sh - 0.5 - v);
                valid_row[x] = (edge as f32).clamp(0.0, 1.0);
            }
        });
    (out, valid)
}
