use super::maxflow::MaxFlow;
use super::raster::{Raster, Rect};
use rayon::prelude::*;

pub const NO_LABEL: u16 = u16::MAX;

const GRADIENT_EPSILON: f32 = 0.05;
const SMOOTHNESS_COST: f32 = 0.002;
const BORDER_MARGIN_FRACTION: f32 = 0.02;
const NO_NODE: u32 = u32::MAX;

pub struct SeamLayer {
    pub roi: Rect,
    pub color: Raster,
    pub valid: Vec<bool>,
}

impl SeamLayer {
    #[inline]
    fn is_valid(&self, x: usize, y: usize) -> bool {
        self.roi.contains(x, y) && self.valid[self.local_index(x, y)]
    }

    #[inline]
    fn local_index(&self, x: usize, y: usize) -> usize {
        (y - self.roi.y) * self.roi.width + x - self.roi.x
    }

    #[inline]
    fn color_at(&self, x: usize, y: usize) -> &[f32] {
        self.color.pixel(x - self.roi.x, y - self.roi.y)
    }

    fn gradient_at(&self, x: usize, y: usize) -> f32 {
        let lx = (x - self.roi.x) as isize;
        let ly = (y - self.roi.y) as isize;
        let lum = |dx: isize, dy: isize| {
            let px = (lx + dx).clamp(0, self.roi.width as isize - 1) as usize;
            let py = (ly + dy).clamp(0, self.roi.height as isize - 1) as usize;
            let p = self.color.pixel(px, py);
            0.25 * p[0] + 0.5 * p[1] + 0.25 * p[2]
        };
        let gx = lum(1, 0) - lum(-1, 0);
        let gy = lum(0, 1) - lum(0, -1);
        (gx * gx + gy * gy).sqrt()
    }
}

fn distance_to_border(layer: &SeamLayer, width: usize, height: usize) -> Vec<f32> {
    let (w, h) = (layer.roi.width, layer.roi.height);
    let (x0, y0) = (layer.roi.x as isize, layer.roi.y as isize);
    let mut dist: Vec<f32> = layer
        .valid
        .iter()
        .map(|&v| if v { f32::MAX } else { 0.0 })
        .collect();
    let at = |d: &Vec<f32>, x: isize, y: isize| -> f32 {
        if x < 0 || y < 0 || x >= w as isize || y >= h as isize {
            let (gx, gy) = (x0 + x, y0 + y);
            if gx < 0 || gy < 0 || gx >= width as isize || gy >= height as isize {
                f32::MAX
            } else {
                0.0
            }
        } else {
            d[y as usize * w + x as usize]
        }
    };
    for y in 0..h as isize {
        for x in 0..w as isize {
            let i = y as usize * w + x as usize;
            if dist[i] == 0.0 {
                continue;
            }
            let v = (at(&dist, x - 1, y) + 1.0)
                .min(at(&dist, x, y - 1) + 1.0)
                .min(at(&dist, x - 1, y - 1) + 1.4)
                .min(at(&dist, x + 1, y - 1) + 1.4);
            dist[i] = dist[i].min(v);
        }
    }
    for y in (0..h as isize).rev() {
        for x in (0..w as isize).rev() {
            let i = y as usize * w + x as usize;
            if dist[i] == 0.0 {
                continue;
            }
            let v = (at(&dist, x + 1, y) + 1.0)
                .min(at(&dist, x, y + 1) + 1.0)
                .min(at(&dist, x + 1, y + 1) + 1.4)
                .min(at(&dist, x - 1, y + 1) + 1.4);
            dist[i] = dist[i].min(v);
        }
    }
    dist
}

fn initial_labels(
    width: usize,
    height: usize,
    layers: &[SeamLayer],
    distances: &[Vec<f32>],
) -> Vec<u16> {
    let mut labels = vec![NO_LABEL; width * height];
    let mut best = vec![0.0f32; width * height];
    for (index, (layer, dist)) in layers.iter().zip(distances).enumerate() {
        for ly in 0..layer.roi.height {
            for lx in 0..layer.roi.width {
                let d = dist[ly * layer.roi.width + lx];
                if d <= 0.0 {
                    continue;
                }
                let gi = (layer.roi.y + ly) * width + layer.roi.x + lx;
                if d > best[gi] {
                    best[gi] = d;
                    labels[gi] = index as u16;
                }
            }
        }
    }
    labels
}

fn pair_region(
    layers: &[SeamLayer],
    a: usize,
    b: usize,
    width: usize,
    height: usize,
) -> Option<Rect> {
    let overlap = layers[a].roi.intersect(&layers[b].roi)?;
    Some(Rect {
        x: overlap.x.saturating_sub(1),
        y: overlap.y.saturating_sub(1),
        width: (overlap.right() + 1).min(width) - overlap.x.saturating_sub(1),
        height: (overlap.bottom() + 1).min(height) - overlap.y.saturating_sub(1),
    })
}

fn refine_pair(
    labels: &[u16],
    width: usize,
    height: usize,
    layers: &[SeamLayer],
    distances: &[Vec<f32>],
    (a, b): (usize, usize),
    region: Rect,
) -> Vec<(usize, u16)> {
    let (la, lb) = (&layers[a], &layers[b]);
    let (label_a, label_b) = (a as u16, b as u16);
    let margin = BORDER_MARGIN_FRACTION * ((width * height) as f32).sqrt();

    let mut node_of = vec![NO_NODE; region.width * region.height];
    let mut pixels = Vec::new();
    let mut difference = Vec::new();
    let mut gradient = Vec::new();
    for y in region.y..region.bottom() {
        for x in region.x..region.right() {
            let label = labels[y * width + x];
            if (label != label_a && label != label_b)
                || !la.is_valid(x, y)
                || !lb.is_valid(x, y)
                || distances[a][la.local_index(x, y)] < margin
                || distances[b][lb.local_index(x, y)] < margin
            {
                continue;
            }
            let ca = la.color_at(x, y);
            let cb = lb.color_at(x, y);
            let d = (ca[0] - cb[0]).abs() + (ca[1] - cb[1]).abs() + (ca[2] - cb[2]).abs();
            node_of[(y - region.y) * region.width + x - region.x] = pixels.len() as u32;
            pixels.push((x, y));
            difference.push(d);
            gradient.push(la.gradient_at(x, y) + lb.gradient_at(x, y));
        }
    }
    if pixels.is_empty() {
        return Vec::new();
    }

    let mut graph = MaxFlow::new(pixels.len(), pixels.len() * 2);
    let node_at = |x: isize, y: isize| -> Option<u32> {
        if x < region.x as isize
            || y < region.y as isize
            || x >= region.right() as isize
            || y >= region.bottom() as isize
        {
            return None;
        }
        let n = node_of[(y as usize - region.y) * region.width + x as usize - region.x];
        (n != NO_NODE).then_some(n)
    };

    let mut constrained = (false, false);
    for (n, &(x, y)) in pixels.iter().enumerate() {
        for (dx, dy) in [(1isize, 0isize), (0, 1), (-1, 0), (0, -1)] {
            let nx = x as isize + dx;
            let ny = y as isize + dy;
            if nx < 0 || ny < 0 || nx >= width as isize || ny >= height as isize {
                continue;
            }
            if let Some(m) = node_at(nx, ny) {
                if dx + dy > 0 {
                    let m = m as usize;
                    let cost = (difference[n] + difference[m])
                        / (gradient[n] + gradient[m] + GRADIENT_EPSILON)
                        + SMOOTHNESS_COST;
                    graph.add_edge(n, m, cost as f64, cost as f64);
                }
                continue;
            }
            let neighbor_label = labels[ny as usize * width + nx as usize];
            let cost =
                (2.0 * difference[n]) / (2.0 * gradient[n] + GRADIENT_EPSILON) + SMOOTHNESS_COST;
            if neighbor_label == label_a {
                graph.add_terminal_weights(n, cost as f64, 0.0);
                constrained.0 = true;
            } else if neighbor_label == label_b {
                graph.add_terminal_weights(n, 0.0, cost as f64);
                constrained.1 = true;
            }
        }
    }
    if !constrained.0 && !constrained.1 {
        return Vec::new();
    }

    graph.solve();
    pixels
        .iter()
        .enumerate()
        .filter_map(|(n, &(x, y))| {
            graph
                .is_source_side(n)
                .map(|source| (y * width + x, if source { label_a } else { label_b }))
        })
        .collect()
}

fn expanded(rect: &Rect, margin: usize) -> Rect {
    Rect {
        x: rect.x.saturating_sub(margin),
        y: rect.y.saturating_sub(margin),
        width: rect.width + 2 * margin,
        height: rect.height + 2 * margin,
    }
}

pub fn find_seams(width: usize, height: usize, layers: &[SeamLayer]) -> Vec<u16> {
    let distances: Vec<Vec<f32>> = layers
        .par_iter()
        .map(|layer| distance_to_border(layer, width, height))
        .collect();
    let mut labels = initial_labels(width, height, layers, &distances);
    let mut pending: Vec<((usize, usize), Rect)> = (0..layers.len())
        .flat_map(|a| (a + 1..layers.len()).map(move |b| (a, b)))
        .filter_map(|(a, b)| pair_region(layers, a, b, width, height).map(|r| ((a, b), r)))
        .collect();

    while !pending.is_empty() {
        let mut batch: Vec<((usize, usize), Rect)> = Vec::new();
        let mut deferred = Vec::new();
        for (pair, region) in pending {
            let guard = expanded(&region, 2);
            if batch
                .iter()
                .any(|(_, other)| expanded(other, 2).intersect(&guard).is_some())
            {
                deferred.push((pair, region));
            } else {
                batch.push((pair, region));
            }
        }
        let updates: Vec<Vec<(usize, u16)>> = batch
            .par_iter()
            .map(|&(pair, region)| {
                refine_pair(&labels, width, height, layers, &distances, pair, region)
            })
            .collect();
        for (index, label) in updates.into_iter().flatten() {
            labels[index] = label;
        }
        pending = deferred;
    }
    labels
}
