use super::camera::{
    BundleOptions, Camera, Lens, Orientation, PairObservation, bundle_adjust,
    estimate_focal_from_homographies, focal_from_35mm, initialize_rotations, pair_errors,
    pair_residual, straighten,
};
use super::features::FeatureSet;
use super::homography::{Correspondence, estimate_homography, fit_homography};
use super::matching::{candidate_pairs, match_features};
use super::photometric::{Photometric, estimate_photometric};
use super::raster::Raster;
use nalgebra::Vector2;
use rayon::prelude::*;

const MIN_RANSAC_THRESHOLD: f64 = 3.0;
const RANSAC_THRESHOLD_FRACTION: f64 = 0.006;
const MIN_PAIR_INLIERS: usize = 16;
const VERIFICATION_ALPHA: f64 = 8.0;
const VERIFICATION_BETA: f64 = 0.3;
const MAX_POINTS_PER_PAIR: usize = 200;
const HUBER_DETECTION_PIXELS: f64 = 1.5;
const PAIR_ERROR_DETECTION_PIXELS: f64 = 6.0;
const PAIR_ERROR_MEDIAN_FACTOR: f64 = 5.0;
const MAX_PRUNING_ROUNDS: usize = 3;
const POINT_OUTLIER_FACTOR: f64 = 4.0;
const MIN_DISTORTION_POINTS: usize = 24;
const DEFAULT_FOCAL_FACTOR: f64 = 0.9;

pub struct AlignmentImage<'a> {
    pub features: &'a FeatureSet,
    pub detection_scale: f64,
    pub width: f64,
    pub height: f64,
    pub focal_35mm: Option<f64>,
    pub photometric_level: &'a Raster,
}

pub struct Alignment {
    pub included: Vec<usize>,
    pub cameras: Vec<Camera>,
    pub lens: Lens,
    pub orientation: Orientation,
    pub photometric: Photometric,
}

struct VerifiedPair {
    a: usize,
    b: usize,
    points: Vec<Correspondence>,
    confidence: f64,
}

fn to_centered(image: &AlignmentImage, x: f32, y: f32) -> Vector2<f64> {
    Vector2::new(
        (x as f64 + 0.5) * image.detection_scale - 0.5 * image.width,
        (y as f64 + 0.5) * image.detection_scale - 0.5 * image.height,
    )
}

fn verify_pair(images: &[AlignmentImage], a: usize, b: usize) -> Option<VerifiedPair> {
    let (fa, fb) = (images[a].features, images[b].features);
    let matches = match_features(fa, fb);
    if matches.len() < MIN_PAIR_INLIERS {
        return None;
    }
    let correspondences: Vec<Correspondence> = matches
        .iter()
        .map(|&(i, j)| {
            let (ka, kb) = (fa.keypoints[i], fb.keypoints[j]);
            (
                Vector2::new(ka.x as f64, ka.y as f64),
                Vector2::new(kb.x as f64, kb.y as f64),
            )
        })
        .collect();
    let diagonal = |image: &AlignmentImage| image.width.hypot(image.height) / image.detection_scale;
    let threshold =
        (RANSAC_THRESHOLD_FRACTION * 0.5 * (diagonal(&images[a]) + diagonal(&images[b])))
            .max(MIN_RANSAC_THRESHOLD);
    let seed = ((a as u64) << 32) ^ (b as u64) ^ 0x5EED;
    let inlier_indices = estimate_homography(&correspondences, threshold, seed)?;
    let inliers = inlier_indices.len();
    let required = VERIFICATION_ALPHA + VERIFICATION_BETA * matches.len() as f64;
    if inliers < MIN_PAIR_INLIERS || (inliers as f64) <= required {
        return None;
    }
    let points: Vec<Correspondence> = inlier_indices
        .iter()
        .map(|&k| {
            let (i, j) = matches[k];
            let (ka, kb) = (fa.keypoints[i], fb.keypoints[j]);
            (
                to_centered(&images[a], ka.x, ka.y),
                to_centered(&images[b], kb.x, kb.y),
            )
        })
        .collect();
    Some(VerifiedPair {
        a,
        b,
        points,
        confidence: inliers as f64 / required,
    })
}

fn largest_component(n: usize, pairs: &[(usize, usize)]) -> Vec<usize> {
    let mut component = vec![usize::MAX; n];
    let mut best: Vec<usize> = Vec::new();
    for start in 0..n {
        if component[start] != usize::MAX {
            continue;
        }
        let mut members = vec![start];
        component[start] = start;
        let mut k = 0;
        while k < members.len() {
            let i = members[k];
            for &(a, b) in pairs {
                let other = if a == i {
                    b
                } else if b == i {
                    a
                } else {
                    continue;
                };
                if component[other] == usize::MAX {
                    component[other] = start;
                    members.push(other);
                }
            }
            k += 1;
        }
        if members.len() > best.len() {
            best = members;
        }
    }
    best.sort_unstable();
    best
}

fn subsample(points: &[Correspondence]) -> Vec<Correspondence> {
    if points.len() <= MAX_POINTS_PER_PAIR {
        return points.to_vec();
    }
    let step = points.len() as f64 / MAX_POINTS_PER_PAIR as f64;
    (0..MAX_POINTS_PER_PAIR)
        .map(|k| points[(k as f64 * step) as usize])
        .collect()
}

fn build_observations(pairs: &[VerifiedPair], index_of: &[Option<usize>]) -> Vec<PairObservation> {
    pairs
        .iter()
        .filter_map(|pair| {
            let a = index_of[pair.a]?;
            let b = index_of[pair.b]?;
            let all: Vec<usize> = (0..pair.points.len()).collect();
            let homography = fit_homography(&pair.points, &all)?;
            Some(PairObservation {
                a,
                b,
                points: subsample(&pair.points),
                homography,
                confidence: pair.confidence,
            })
        })
        .collect()
}

fn initial_focals(images: &[&AlignmentImage], observations: &[PairObservation]) -> Vec<f64> {
    let estimated = estimate_focal_from_homographies(observations);
    images
        .iter()
        .map(|image| {
            image
                .focal_35mm
                .map(|f| focal_from_35mm(f, image.width, image.height))
                .or(estimated)
                .unwrap_or(DEFAULT_FOCAL_FACTOR * image.width.max(image.height))
        })
        .collect()
}

fn uses_single_lens(images: &[&AlignmentImage]) -> bool {
    let first = images[0];
    let same_size = images
        .iter()
        .all(|i| i.width == first.width && i.height == first.height);
    let focals: Vec<f64> = images.iter().filter_map(|i| i.focal_35mm).collect();
    let same_focal = focals.is_empty()
        || (focals.len() == images.len()
            && focals
                .iter()
                .all(|f| (f - focals[0]).abs() <= 0.01 * focals[0]));
    same_size && same_focal
}

fn optimize(
    cameras: &mut [Camera],
    lens: &mut Lens,
    observations: &mut Vec<PairObservation>,
    reference: usize,
    options: &BundleOptions,
    pruning_threshold: f64,
) {
    bundle_adjust(cameras, lens, observations, reference, options);
    for _ in 0..MAX_PRUNING_ROUNDS {
        let errors = pair_errors(cameras, lens, observations);
        let mut sorted = errors.clone();
        sorted.sort_by(|a, b| a.total_cmp(b));
        let median = sorted[sorted.len() / 2];
        let threshold = pruning_threshold.max(PAIR_ERROR_MEDIAN_FACTOR * median);
        let keep: Vec<bool> = errors.iter().map(|&e| e <= threshold).collect();
        if keep.iter().all(|&k| k) {
            break;
        }
        let candidate: Vec<(usize, usize)> = observations
            .iter()
            .zip(keep.iter())
            .filter(|(_, k)| **k)
            .map(|(o, _)| (o.a, o.b))
            .collect();
        if largest_component(cameras.len(), &candidate).len() < cameras.len() {
            break;
        }
        let mut k = keep.iter();
        observations.retain(|_| *k.next().unwrap());
        bundle_adjust(cameras, lens, observations, reference, options);
    }
}

fn prune_outlier_points(
    cameras: &[Camera],
    lens: &Lens,
    observations: &mut [PairObservation],
    threshold: f64,
) -> bool {
    let mut removed = false;
    for observation in observations.iter_mut() {
        let (a, b) = (&cameras[observation.a], &cameras[observation.b]);
        let before = observation.points.len();
        let kept: Vec<Correspondence> = observation
            .points
            .iter()
            .filter(|c| pair_residual(a, b, lens, c).norm() <= threshold)
            .copied()
            .collect();
        if kept.len() >= MIN_PAIR_INLIERS / 2 && kept.len() < before {
            observation.points = kept;
            removed = true;
        }
    }
    removed
}

pub fn align_images(
    images: &[AlignmentImage],
    progress: &dyn Fn(String),
) -> Result<Alignment, String> {
    progress("Finding image matches...".to_string());
    let features: Vec<&FeatureSet> = images.iter().map(|i| i.features).collect();
    let candidates = candidate_pairs(&features);
    let verified: Vec<VerifiedPair> = candidates
        .par_iter()
        .filter_map(|&(a, b)| verify_pair(images, a, b))
        .collect();
    if verified.is_empty() {
        return Err(
            "No suitable matches found between any pair of images. Cannot create a panorama."
                .to_string(),
        );
    }

    let links: Vec<(usize, usize)> = verified.iter().map(|p| (p.a, p.b)).collect();
    let included = largest_component(images.len(), &links);
    if included.len() < 2 {
        return Err("Could not find a connected sequence of at least two images.".to_string());
    }
    let mut index_of = vec![None; images.len()];
    for (k, &i) in included.iter().enumerate() {
        index_of[i] = Some(k);
    }
    let selected: Vec<&AlignmentImage> = included.iter().map(|&i| &images[i]).collect();
    let mut observations = build_observations(&verified, &index_of);

    progress("Estimating camera alignment...".to_string());
    let focals = initial_focals(&selected, &observations);
    let mut cameras: Vec<Camera> = selected
        .iter()
        .zip(focals.iter())
        .map(|(image, &focal)| Camera {
            rotation: nalgebra::Matrix3::identity(),
            focal,
            width: image.width,
            height: image.height,
        })
        .collect();
    let reference = initialize_rotations(&mut cameras, &observations);

    progress("Optimizing camera alignment...".to_string());
    let mean_scale =
        selected.iter().map(|i| i.detection_scale).sum::<f64>() / selected.len() as f64;
    let single_lens = uses_single_lens(&selected);
    let mut lens = Lens::default();
    let mut options = BundleOptions {
        shared_focal: single_lens,
        estimate_distortion: false,
        huber_threshold: HUBER_DETECTION_PIXELS * mean_scale,
    };
    let pruning_threshold = PAIR_ERROR_DETECTION_PIXELS * mean_scale;
    optimize(
        &mut cameras,
        &mut lens,
        &mut observations,
        reference,
        &options,
        pruning_threshold,
    );

    let total_points: usize = observations.iter().map(|o| o.points.len()).sum();
    if single_lens && total_points >= MIN_DISTORTION_POINTS {
        progress("Estimating lens distortion...".to_string());
        options.estimate_distortion = true;
        optimize(
            &mut cameras,
            &mut lens,
            &mut observations,
            reference,
            &options,
            pruning_threshold,
        );
    }

    if prune_outlier_points(
        &cameras,
        &lens,
        &mut observations,
        POINT_OUTLIER_FACTOR * options.huber_threshold,
    ) {
        bundle_adjust(&mut cameras, &mut lens, &observations, reference, &options);
    }

    let orientation = straighten(&mut cameras);

    progress("Compensating exposure and vignetting...".to_string());
    let levels: Vec<&Raster> = selected.iter().map(|i| i.photometric_level).collect();
    let pair_indices: Vec<(usize, usize)> = observations.iter().map(|o| (o.a, o.b)).collect();
    let photometric = estimate_photometric(&cameras, &lens, &levels, &pair_indices);

    Ok(Alignment {
        included,
        cameras,
        lens,
        orientation,
        photometric,
    })
}
