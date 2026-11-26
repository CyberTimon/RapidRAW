use super::raster::{Raster, gaussian_blur};
use rayon::prelude::*;
use std::f32::consts::PI;

pub const DESCRIPTOR_LENGTH: usize = 128;

const SCALES_PER_OCTAVE: usize = 3;
const BASE_SIGMA: f32 = 1.6;
const ASSUMED_INPUT_BLUR: f32 = 0.5;
const CONTRAST_THRESHOLD: f32 = 0.03;
const ADAPTIVE_CONTRAST_STEPS: [f32; 3] = [1.0, 0.5, 0.25];
const ADAPTIVE_MIN_FEATURE_FRACTION: usize = 4;
const EDGE_RATIO: f32 = 10.0;
const IMAGE_BORDER: usize = 5;
const MAX_INTERPOLATION_STEPS: usize = 5;
const MIN_OCTAVE_DIMENSION: usize = 32;
const MAX_OCTAVES: usize = 6;

const ORIENTATION_BINS: usize = 36;
const ORIENTATION_SIGMA_FACTOR: f32 = 1.5;
const ORIENTATION_RADIUS_FACTOR: f32 = 3.0 * ORIENTATION_SIGMA_FACTOR;
const ORIENTATION_PEAK_RATIO: f32 = 0.8;

const DESCRIPTOR_WIDTH: usize = 4;
const DESCRIPTOR_BINS: usize = 8;
const DESCRIPTOR_SCALE_FACTOR: f32 = 3.0;
const DESCRIPTOR_MAGNITUDE_CLAMP: f32 = 0.2;

const DISTRIBUTION_GRID_CELLS: usize = 24;

#[derive(Debug, Clone, Copy)]
pub struct Keypoint {
    pub x: f32,
    pub y: f32,
    pub angle: f32,
    pub response: f32,
}

#[derive(Default)]
pub struct FeatureSet {
    pub keypoints: Vec<Keypoint>,
    pub descriptors: Vec<f32>,
}

impl FeatureSet {
    pub fn len(&self) -> usize {
        self.keypoints.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keypoints.is_empty()
    }

    pub fn descriptor(&self, index: usize) -> &[f32] {
        &self.descriptors[index * DESCRIPTOR_LENGTH..(index + 1) * DESCRIPTOR_LENGTH]
    }

    pub fn strongest(&self, count: usize) -> FeatureSet {
        let mut order: Vec<usize> = (0..self.len()).collect();
        order.sort_by(|&a, &b| {
            self.keypoints[b]
                .response
                .total_cmp(&self.keypoints[a].response)
        });
        order.truncate(count);
        let mut subset = FeatureSet::default();
        for i in order {
            subset.keypoints.push(self.keypoints[i]);
            subset.descriptors.extend_from_slice(self.descriptor(i));
        }
        subset
    }
}

struct ScaleSpace {
    gaussians: Vec<Vec<Raster>>,
    dogs: Vec<Vec<Raster>>,
}

struct Candidate {
    octave: usize,
    layer: usize,
    x: usize,
    y: usize,
}

pub fn detect_features(gray: &Raster, max_features: usize) -> FeatureSet {
    assert_eq!(
        gray.channels, 1,
        "feature detection expects a single channel"
    );
    let normalized = normalize_contrast(gray);
    let space = build_scale_space(&normalized);

    let mut keypoints = Vec::new();
    for factor in ADAPTIVE_CONTRAST_STEPS {
        keypoints = oriented_keypoints(&space, CONTRAST_THRESHOLD * factor);
        if keypoints.len() >= max_features / ADAPTIVE_MIN_FEATURE_FRACTION {
            break;
        }
    }

    keypoints = select_distributed(keypoints, gray.width, gray.height, max_features);

    let described: Vec<(Keypoint, [f32; DESCRIPTOR_LENGTH])> = keypoints
        .par_iter()
        .map(|(kp, octave, octave_sigma)| {
            let layer = layer_for_sigma(*octave_sigma);
            let image = &space.gaussians[*octave][layer];
            (*kp, compute_descriptor(image, kp, *octave, *octave_sigma))
        })
        .collect();

    let mut features = FeatureSet::default();
    for (kp, descriptor) in described {
        features.keypoints.push(kp);
        features.descriptors.extend_from_slice(&descriptor);
    }
    features
}

fn oriented_keypoints(space: &ScaleSpace, contrast_threshold: f32) -> Vec<(Keypoint, usize, f32)> {
    find_scale_space_extrema(space, contrast_threshold)
        .par_iter()
        .filter_map(|c| refine_extremum(space, c, contrast_threshold))
        .flat_map_iter(|(kp, octave, octave_sigma)| {
            assign_orientations(&space.gaussians[octave], &kp, octave, octave_sigma)
                .into_iter()
                .map(move |angle| (Keypoint { angle, ..kp }, octave, octave_sigma))
        })
        .collect()
}

fn normalize_contrast(gray: &Raster) -> Raster {
    let mut sorted: Vec<f32> = gray.data.iter().step_by(7).copied().collect();
    if sorted.is_empty() {
        return gray.clone();
    }
    sorted.sort_by(|a, b| a.total_cmp(b));
    let low = sorted[sorted.len() / 200];
    let high = sorted[sorted.len() - 1 - sorted.len() / 200];
    let span = high - low;
    if span < 1e-4 {
        return gray.clone();
    }
    let data = gray
        .data
        .par_iter()
        .map(|v| ((v - low) / span).clamp(-0.1, 1.1))
        .collect();
    Raster::from_data(gray.width, gray.height, 1, data)
}

fn build_scale_space(base_image: &Raster) -> ScaleSpace {
    let levels = SCALES_PER_OCTAVE + 3;
    let k = 2f32.powf(1.0 / SCALES_PER_OCTAVE as f32);
    let mut increments = vec![0.0f32; levels];
    for (i, inc) in increments.iter_mut().enumerate().skip(1) {
        let previous = BASE_SIGMA * k.powi(i as i32 - 1);
        let total = previous * k;
        *inc = (total * total - previous * previous).sqrt();
    }

    let min_dim = base_image.width.min(base_image.height);
    let mut octaves = 1;
    while octaves < MAX_OCTAVES && (min_dim >> octaves) >= MIN_OCTAVE_DIMENSION {
        octaves += 1;
    }

    let initial_sigma = (BASE_SIGMA * BASE_SIGMA - ASSUMED_INPUT_BLUR * ASSUMED_INPUT_BLUR).sqrt();
    let mut gaussians: Vec<Vec<Raster>> = Vec::with_capacity(octaves);
    for o in 0..octaves {
        let first = if o == 0 {
            gaussian_blur(base_image, initial_sigma)
        } else {
            decimate(&gaussians[o - 1][SCALES_PER_OCTAVE])
        };
        let mut octave = Vec::with_capacity(levels);
        octave.push(first);
        for inc in increments.iter().skip(1) {
            let next = gaussian_blur(octave.last().unwrap(), *inc);
            octave.push(next);
        }
        gaussians.push(octave);
    }

    let dogs = gaussians
        .iter()
        .map(|octave| {
            octave
                .windows(2)
                .map(|pair| {
                    let data = pair[1]
                        .data
                        .par_iter()
                        .zip(pair[0].data.par_iter())
                        .map(|(a, b)| a - b)
                        .collect();
                    Raster::from_data(pair[0].width, pair[0].height, 1, data)
                })
                .collect()
        })
        .collect();

    ScaleSpace { gaussians, dogs }
}

fn decimate(src: &Raster) -> Raster {
    let w = src.width / 2;
    let h = src.height / 2;
    let mut data = Vec::with_capacity(w * h);
    for y in 0..h {
        for x in 0..w {
            data.push(src.get(x * 2, y * 2, 0));
        }
    }
    Raster::from_data(w, h, 1, data)
}

fn find_scale_space_extrema(space: &ScaleSpace, contrast_threshold: f32) -> Vec<Candidate> {
    let threshold = 0.5 * contrast_threshold / SCALES_PER_OCTAVE as f32;
    let mut jobs = Vec::new();
    for (o, dogs) in space.dogs.iter().enumerate() {
        for (layer, dog) in dogs.iter().enumerate().take(SCALES_PER_OCTAVE + 1).skip(1) {
            let height = dog.height;
            if height > 2 * IMAGE_BORDER {
                for y in IMAGE_BORDER..height - IMAGE_BORDER {
                    jobs.push((o, layer, y));
                }
            }
        }
    }

    jobs.par_iter()
        .flat_map_iter(|&(o, layer, y)| {
            let below = &space.dogs[o][layer - 1];
            let current = &space.dogs[o][layer];
            let above = &space.dogs[o][layer + 1];
            let w = current.width;
            let mut found = Vec::new();
            if w <= 2 * IMAGE_BORDER {
                return found.into_iter();
            }
            for x in IMAGE_BORDER..w - IMAGE_BORDER {
                let value = current.data[y * w + x];
                if value.abs() <= threshold {
                    continue;
                }
                if is_local_extremum(value, x, y, below, current, above) {
                    found.push(Candidate {
                        octave: o,
                        layer,
                        x,
                        y,
                    });
                }
            }
            found.into_iter()
        })
        .collect()
}

#[inline]
fn is_local_extremum(
    value: f32,
    x: usize,
    y: usize,
    below: &Raster,
    current: &Raster,
    above: &Raster,
) -> bool {
    let w = current.width;
    let is_max = value > 0.0;
    for plane in [below, current, above] {
        for dy in 0..3 {
            let row = (y + dy - 1) * w;
            for dx in 0..3 {
                let idx = row + x + dx - 1;
                if std::ptr::eq(plane, current) && dx == 1 && dy == 1 {
                    continue;
                }
                let other = plane.data[idx];
                if (is_max && other >= value) || (!is_max && other <= value) {
                    return false;
                }
            }
        }
    }
    true
}

fn refine_extremum(
    space: &ScaleSpace,
    candidate: &Candidate,
    contrast_threshold: f32,
) -> Option<(Keypoint, usize, f32)> {
    let o = candidate.octave;
    let dogs = &space.dogs[o];
    let (w, h) = (dogs[0].width as isize, dogs[0].height as isize);
    let border = IMAGE_BORDER as isize;
    let mut x = candidate.x as isize;
    let mut y = candidate.y as isize;
    let mut layer = candidate.layer as isize;
    let mut offset = [0.0f32; 3];
    let mut gradient = [0.0f32; 3];
    let mut converged = false;

    for _ in 0..MAX_INTERPOLATION_STEPS {
        let d = |l: isize, yy: isize, xx: isize| -> f32 {
            dogs[l as usize].data[(yy * w + xx) as usize]
        };
        let v = d(layer, y, x);
        gradient = [
            0.5 * (d(layer, y, x + 1) - d(layer, y, x - 1)),
            0.5 * (d(layer, y + 1, x) - d(layer, y - 1, x)),
            0.5 * (d(layer + 1, y, x) - d(layer - 1, y, x)),
        ];
        let dxx = d(layer, y, x + 1) + d(layer, y, x - 1) - 2.0 * v;
        let dyy = d(layer, y + 1, x) + d(layer, y - 1, x) - 2.0 * v;
        let dss = d(layer + 1, y, x) + d(layer - 1, y, x) - 2.0 * v;
        let dxy = 0.25
            * (d(layer, y + 1, x + 1) - d(layer, y + 1, x - 1) - d(layer, y - 1, x + 1)
                + d(layer, y - 1, x - 1));
        let dxs = 0.25
            * (d(layer + 1, y, x + 1) - d(layer + 1, y, x - 1) - d(layer - 1, y, x + 1)
                + d(layer - 1, y, x - 1));
        let dys = 0.25
            * (d(layer + 1, y + 1, x) - d(layer + 1, y - 1, x) - d(layer - 1, y + 1, x)
                + d(layer - 1, y - 1, x));

        let hessian = nalgebra::Matrix3::new(
            dxx as f64, dxy as f64, dxs as f64, dxy as f64, dyy as f64, dys as f64, dxs as f64,
            dys as f64, dss as f64,
        );
        let solution = hessian.lu().solve(&nalgebra::Vector3::new(
            -gradient[0] as f64,
            -gradient[1] as f64,
            -gradient[2] as f64,
        ))?;
        offset = [solution[0] as f32, solution[1] as f32, solution[2] as f32];

        if offset.iter().all(|v| v.abs() < 0.5) {
            converged = true;
            break;
        }
        if offset.iter().any(|v| v.abs() > (i32::MAX / 3) as f32) {
            return None;
        }
        x += offset[0].round() as isize;
        y += offset[1].round() as isize;
        layer += offset[2].round() as isize;
        if layer < 1
            || layer > SCALES_PER_OCTAVE as isize
            || x < border
            || x >= w - border
            || y < border
            || y >= h - border
        {
            return None;
        }
    }
    if !converged {
        return None;
    }

    let current = &dogs[layer as usize];
    let value = current.data[(y * w + x) as usize];
    let contrast =
        value + 0.5 * (gradient[0] * offset[0] + gradient[1] * offset[1] + gradient[2] * offset[2]);
    if contrast.abs() * (SCALES_PER_OCTAVE as f32) < contrast_threshold {
        return None;
    }

    let at = |yy: isize, xx: isize| current.data[(yy * w + xx) as usize];
    let dxx = at(y, x + 1) + at(y, x - 1) - 2.0 * value;
    let dyy = at(y + 1, x) + at(y - 1, x) - 2.0 * value;
    let dxy = 0.25 * (at(y + 1, x + 1) - at(y + 1, x - 1) - at(y - 1, x + 1) + at(y - 1, x - 1));
    let trace = dxx + dyy;
    let det = dxx * dyy - dxy * dxy;
    if det <= 0.0 || trace * trace * EDGE_RATIO >= (EDGE_RATIO + 1.0).powi(2) * det {
        return None;
    }

    let octave_scale = (1usize << o) as f32;
    let octave_sigma =
        BASE_SIGMA * 2f32.powf((layer as f32 + offset[2]) / SCALES_PER_OCTAVE as f32);
    Some((
        Keypoint {
            x: (x as f32 + offset[0]) * octave_scale,
            y: (y as f32 + offset[1]) * octave_scale,
            angle: 0.0,
            response: contrast.abs(),
        },
        o,
        octave_sigma,
    ))
}

fn layer_for_sigma(octave_sigma: f32) -> usize {
    let layer = ((octave_sigma / BASE_SIGMA).log2() * SCALES_PER_OCTAVE as f32).round();
    (layer.max(0.0) as usize).min(SCALES_PER_OCTAVE + 2)
}

#[inline]
fn gradient(image: &Raster, x: isize, y: isize) -> (f32, f32, f32) {
    let w = image.width as isize;
    let gx = image.data[(y * w + x + 1) as usize] - image.data[(y * w + x - 1) as usize];
    let gy = image.data[((y + 1) * w + x) as usize] - image.data[((y - 1) * w + x) as usize];
    (gx, gy, (gx * gx + gy * gy).sqrt())
}

fn assign_orientations(
    octave_images: &[Raster],
    kp: &Keypoint,
    octave: usize,
    octave_sigma: f32,
) -> Vec<f32> {
    let image = &octave_images[layer_for_sigma(octave_sigma)];
    let scale = (1usize << octave) as f32;
    let cx = (kp.x / scale).round() as isize;
    let cy = (kp.y / scale).round() as isize;
    let radius = (ORIENTATION_RADIUS_FACTOR * octave_sigma).round() as isize;
    let weight_factor = -1.0 / (2.0 * (ORIENTATION_SIGMA_FACTOR * octave_sigma).powi(2));
    let (w, h) = (image.width as isize, image.height as isize);

    let mut histogram = [0.0f32; ORIENTATION_BINS];
    for dy in -radius..=radius {
        let y = cy + dy;
        if y <= 0 || y >= h - 1 {
            continue;
        }
        for dx in -radius..=radius {
            let x = cx + dx;
            if x <= 0 || x >= w - 1 {
                continue;
            }
            let (gx, gy, magnitude) = gradient(image, x, y);
            let weight = ((dx * dx + dy * dy) as f32 * weight_factor).exp();
            let angle = gy.atan2(gx);
            let bin = ((angle + PI) / (2.0 * PI) * ORIENTATION_BINS as f32).round() as isize;
            histogram[bin.rem_euclid(ORIENTATION_BINS as isize) as usize] += weight * magnitude;
        }
    }

    let n = ORIENTATION_BINS;
    let mut smoothed = [0.0f32; ORIENTATION_BINS];
    for i in 0..n {
        smoothed[i] = (histogram[(i + n - 2) % n] + histogram[(i + 2) % n]) / 16.0
            + (histogram[(i + n - 1) % n] + histogram[(i + 1) % n]) * 4.0 / 16.0
            + histogram[i] * 6.0 / 16.0;
    }

    let max_value = smoothed.iter().cloned().fold(0.0f32, f32::max);
    if max_value <= 0.0 {
        return vec![];
    }
    let mut angles = Vec::new();
    for i in 0..n {
        let left = smoothed[(i + n - 1) % n];
        let right = smoothed[(i + 1) % n];
        let value = smoothed[i];
        if value > left && value > right && value >= ORIENTATION_PEAK_RATIO * max_value {
            let interp = 0.5 * (left - right) / (left - 2.0 * value + right);
            let bin = (i as f32 + interp).rem_euclid(n as f32);
            angles.push(bin / n as f32 * 2.0 * PI - PI);
        }
    }
    angles
}

fn compute_descriptor(
    image: &Raster,
    kp: &Keypoint,
    octave: usize,
    octave_sigma: f32,
) -> [f32; DESCRIPTOR_LENGTH] {
    let d = DESCRIPTOR_WIDTH as isize;
    let n = DESCRIPTOR_BINS;
    let scale = (1usize << octave) as f32;
    let cx = kp.x / scale;
    let cy = kp.y / scale;
    let (cos_t, sin_t) = (kp.angle.cos(), kp.angle.sin());
    let hist_width = DESCRIPTOR_SCALE_FACTOR * octave_sigma;
    let radius = (hist_width * std::f32::consts::SQRT_2 * (d as f32 + 1.0) * 0.5)
        .round()
        .min(((image.width.pow(2) + image.height.pow(2)) as f32).sqrt()) as isize;
    let exp_scale = -1.0 / (d as f32 * d as f32 * 0.5);
    let bins_per_rad = n as f32 / (2.0 * PI);
    let (w, h) = (image.width as isize, image.height as isize);
    let ix = cx.round() as isize;
    let iy = cy.round() as isize;

    let hist_dim = (d + 2) as usize;
    let mut hist = vec![0.0f32; hist_dim * hist_dim * (n + 2)];

    for i in -radius..=radius {
        for j in -radius..=radius {
            let c_rot = (j as f32 * cos_t + i as f32 * sin_t) / hist_width;
            let r_rot = (-j as f32 * sin_t + i as f32 * cos_t) / hist_width;
            let rbin = r_rot + d as f32 / 2.0 - 0.5;
            let cbin = c_rot + d as f32 / 2.0 - 0.5;
            if rbin <= -1.0 || rbin >= d as f32 || cbin <= -1.0 || cbin >= d as f32 {
                continue;
            }
            let y = iy + i;
            let x = ix + j;
            if y <= 0 || y >= h - 1 || x <= 0 || x >= w - 1 {
                continue;
            }
            let (gx, gy, magnitude) = gradient(image, x, y);
            let weight = ((c_rot * c_rot + r_rot * r_rot) * exp_scale).exp();
            let mut obin = (gy.atan2(gx) - kp.angle) * bins_per_rad;
            obin = obin.rem_euclid(n as f32);

            let r0 = rbin.floor();
            let c0 = cbin.floor();
            let o0 = obin.floor();
            let (dr, dc, dob) = (rbin - r0, cbin - c0, obin - o0);
            let (r0, c0, o0) = (r0 as isize, c0 as isize, o0 as usize % n);
            let v = magnitude * weight;

            for (ri, wr) in [(0, 1.0 - dr), (1, dr)] {
                for (ci, wc) in [(0, 1.0 - dc), (1, dc)] {
                    for (oi, wo) in [(0, 1.0 - dob), (1, dob)] {
                        let rr = (r0 + 1 + ri) as usize;
                        let cc = (c0 + 1 + ci) as usize;
                        let oo = (o0 + oi) % n;
                        hist[(rr * hist_dim + cc) * (n + 2) + oo] += v * wr * wc * wo;
                    }
                }
            }
        }
    }

    let mut descriptor = [0.0f32; DESCRIPTOR_LENGTH];
    for r in 0..DESCRIPTOR_WIDTH {
        for c in 0..DESCRIPTOR_WIDTH {
            for o in 0..n {
                descriptor[(r * DESCRIPTOR_WIDTH + c) * n + o] =
                    hist[((r + 1) * hist_dim + c + 1) * (n + 2) + o];
            }
        }
    }

    let norm = descriptor.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 1e-12 {
        let clamp = DESCRIPTOR_MAGNITUDE_CLAMP * norm;
        descriptor.iter_mut().for_each(|v| *v = v.min(clamp));
    }
    let l1: f32 = descriptor.iter().sum();
    if l1 > 1e-12 {
        descriptor.iter_mut().for_each(|v| *v = (*v / l1).sqrt());
    }
    descriptor
}

fn select_distributed<T>(
    mut keypoints: Vec<(Keypoint, usize, T)>,
    width: usize,
    height: usize,
    max_features: usize,
) -> Vec<(Keypoint, usize, T)> {
    if keypoints.len() <= max_features {
        return keypoints;
    }
    keypoints.sort_by(|a, b| b.0.response.total_cmp(&a.0.response));

    let long_side = width.max(height) as f32;
    let cell_size = long_side / DISTRIBUTION_GRID_CELLS as f32;
    let cols = (width as f32 / cell_size).ceil().max(1.0) as usize;
    let rows = (height as f32 / cell_size).ceil().max(1.0) as usize;
    let per_cell = max_features.div_ceil(cols * rows).max(1);

    let mut counts = vec![0usize; cols * rows];
    let mut selected = Vec::with_capacity(max_features);
    let mut deferred = Vec::new();
    for entry in keypoints {
        let cx = ((entry.0.x / cell_size) as usize).min(cols - 1);
        let cy = ((entry.0.y / cell_size) as usize).min(rows - 1);
        let cell = cy * cols + cx;
        if counts[cell] < per_cell && selected.len() < max_features {
            counts[cell] += 1;
            selected.push(entry);
        } else {
            deferred.push(entry);
        }
    }
    let remaining = max_features.saturating_sub(selected.len());
    selected.extend(deferred.into_iter().take(remaining));
    selected
}
