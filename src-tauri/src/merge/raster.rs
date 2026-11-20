use crate::render::color_space::{luminance, srgb_transfer};
use rayon::prelude::*;

#[derive(Clone)]
pub struct Raster {
    pub width: usize,
    pub height: usize,
    pub channels: usize,
    pub data: Vec<f32>,
}

impl Raster {
    pub fn new(width: usize, height: usize, channels: usize) -> Self {
        Raster {
            width,
            height,
            channels,
            data: vec![0.0; width * height * channels],
        }
    }

    pub fn from_data(width: usize, height: usize, channels: usize, data: Vec<f32>) -> Self {
        assert_eq!(
            data.len(),
            width * height * channels,
            "raster data length must match its dimensions"
        );
        Raster {
            width,
            height,
            channels,
            data,
        }
    }

    #[inline]
    pub fn index(&self, x: usize, y: usize) -> usize {
        (y * self.width + x) * self.channels
    }

    #[inline]
    pub fn get(&self, x: usize, y: usize, c: usize) -> f32 {
        self.data[self.index(x, y) + c]
    }

    #[inline]
    pub fn get_clamped(&self, x: isize, y: isize, c: usize) -> f32 {
        let xc = x.clamp(0, self.width as isize - 1) as usize;
        let yc = y.clamp(0, self.height as isize - 1) as usize;
        self.data[(yc * self.width + xc) * self.channels + c]
    }

    #[inline]
    pub fn pixel(&self, x: usize, y: usize) -> &[f32] {
        let i = self.index(x, y);
        &self.data[i..i + self.channels]
    }

    #[inline]
    pub fn pixel_at(&self, index: usize) -> &[f32] {
        &self.data[index * self.channels..(index + 1) * self.channels]
    }

    pub fn bilinear(&self, x: f32, y: f32, out: &mut [f32]) {
        let x0f = x.floor();
        let y0f = y.floor();
        let fx = x - x0f;
        let fy = y - y0f;
        let x0 = x0f as isize;
        let y0 = y0f as isize;
        for (c, value) in out.iter_mut().enumerate().take(self.channels) {
            let p00 = self.get_clamped(x0, y0, c);
            let p10 = self.get_clamped(x0 + 1, y0, c);
            let p01 = self.get_clamped(x0, y0 + 1, c);
            let p11 = self.get_clamped(x0 + 1, y0 + 1, c);
            let top = p00 + (p10 - p00) * fx;
            let bottom = p01 + (p11 - p01) * fx;
            *value = top + (bottom - top) * fy;
        }
    }

    pub fn bicubic(&self, x: f32, y: f32, out: &mut [f32]) {
        let x0f = x.floor();
        let y0f = y.floor();
        let wx = cubic_weights(x - x0f);
        let wy = cubic_weights(y - y0f);
        let x0 = x0f as isize - 1;
        let y0 = y0f as isize - 1;
        let ch = self.channels;
        if x0 >= 0 && y0 >= 0 && x0 + 3 < self.width as isize && y0 + 3 < self.height as isize {
            let mut sum = [0.0f32; 4];
            for (j, wyj) in wy.iter().enumerate() {
                let row = self.index(x0 as usize, y0 as usize + j);
                let mut acc = [0.0f32; 4];
                for (i, wxi) in wx.iter().enumerate() {
                    let p = &self.data[row + i * ch..row + i * ch + ch];
                    for c in 0..ch.min(4) {
                        acc[c] += wxi * p[c];
                    }
                }
                for c in 0..ch.min(4) {
                    sum[c] += wyj * acc[c];
                }
            }
            out[..ch.min(4)].copy_from_slice(&sum[..ch.min(4)]);
            return;
        }
        for (c, value) in out.iter_mut().enumerate().take(ch) {
            let mut sum = 0.0;
            for (j, wyj) in wy.iter().enumerate() {
                let mut row = 0.0;
                for (i, wxi) in wx.iter().enumerate() {
                    row += wxi * self.get_clamped(x0 + i as isize, y0 + j as isize, c);
                }
                sum += wyj * row;
            }
            *value = sum;
        }
    }
}

#[inline]
fn cubic_weights(t: f32) -> [f32; 4] {
    const A: f32 = -0.5;
    let t2 = t * t;
    let t3 = t2 * t;
    [
        A * (t3 - 2.0 * t2 + t),
        (A + 2.0) * t3 - (A + 3.0) * t2 + 1.0,
        -(A + 2.0) * t3 + (2.0 * A + 3.0) * t2 - A * t,
        -A * t3 + A * t2,
    ]
}

pub fn gaussian_kernel(sigma: f32) -> Vec<f32> {
    let sigma = sigma.max(1e-3);
    let radius = (sigma * 3.0).ceil().max(1.0) as usize;
    let denom = 2.0 * sigma * sigma;
    let mut kernel: Vec<f32> = (0..2 * radius + 1)
        .map(|i| {
            let d = i as f32 - radius as f32;
            (-d * d / denom).exp()
        })
        .collect();
    let sum: f32 = kernel.iter().sum();
    kernel.iter_mut().for_each(|v| *v /= sum);
    kernel
}

pub fn gaussian_blur(src: &Raster, sigma: f32) -> Raster {
    if sigma <= 0.01 {
        return src.clone();
    }
    convolve_separable(src, &gaussian_kernel(sigma))
}

fn convolve_row(input: &[f32], output: &mut [f32], width: usize, ch: usize, kernel: &[f32]) {
    let radius = kernel.len() / 2;
    output.iter_mut().for_each(|v| *v = 0.0);
    if width > 2 * radius {
        let start = radius * ch;
        let end = (width - radius) * ch;
        for (k, weight) in kernel.iter().enumerate() {
            let shifted = &input[k * ch..k * ch + (end - start)];
            for (o, i) in output[start..end].iter_mut().zip(shifted) {
                *o += weight * i;
            }
        }
    }
    for x in (0..width).filter(|&x| x < radius || x + radius >= width) {
        for c in 0..ch {
            let mut sum = 0.0;
            for (k, weight) in kernel.iter().enumerate() {
                let sx = (x as isize + k as isize - radius as isize).clamp(0, width as isize - 1);
                sum += weight * input[sx as usize * ch + c];
            }
            output[x * ch + c] = sum;
        }
    }
}

fn convolve_separable(src: &Raster, kernel: &[f32]) -> Raster {
    let radius = (kernel.len() / 2) as isize;
    let (w, h, ch) = (src.width, src.height, src.channels);
    let stride = w * ch;

    let mut horizontal = vec![0.0f32; src.data.len()];
    horizontal
        .par_chunks_mut(stride)
        .zip(src.data.par_chunks(stride))
        .for_each(|(out_row, in_row)| convolve_row(in_row, out_row, w, ch, kernel));

    let mut out = vec![0.0f32; src.data.len()];
    out.par_chunks_mut(stride)
        .enumerate()
        .for_each(|(y, out_row)| {
            for (k, weight) in kernel.iter().enumerate() {
                let sy = (y as isize + k as isize - radius).clamp(0, h as isize - 1) as usize;
                let in_row = &horizontal[sy * stride..(sy + 1) * stride];
                for (o, i) in out_row.iter_mut().zip(in_row.iter()) {
                    *o += weight * i;
                }
            }
        });

    Raster::from_data(w, h, ch, out)
}

const BINOMIAL: [f32; 5] = [1.0 / 16.0, 4.0 / 16.0, 6.0 / 16.0, 4.0 / 16.0, 1.0 / 16.0];

pub fn pyr_down(src: &Raster) -> Raster {
    let (sw, sh, ch) = (src.width, src.height, src.channels);
    let w = sw.div_ceil(2);
    let h = sh.div_ceil(2);

    let mut horizontal = vec![0.0f32; w * sh * ch];
    horizontal
        .par_chunks_mut(w * ch)
        .zip(src.data.par_chunks(sw * ch))
        .for_each(|(out_row, in_row)| {
            for x in 0..w {
                let cx = 2 * x;
                if cx >= 2 && cx + 2 < sw {
                    let base = (cx - 2) * ch;
                    for c in 0..ch {
                        out_row[x * ch + c] = BINOMIAL[0] * in_row[base + c]
                            + BINOMIAL[1] * in_row[base + ch + c]
                            + BINOMIAL[2] * in_row[base + 2 * ch + c]
                            + BINOMIAL[3] * in_row[base + 3 * ch + c]
                            + BINOMIAL[4] * in_row[base + 4 * ch + c];
                    }
                } else {
                    for c in 0..ch {
                        let mut sum = 0.0;
                        for (k, weight) in BINOMIAL.iter().enumerate() {
                            let sx = (cx as isize + k as isize - 2).clamp(0, sw as isize - 1);
                            sum += weight * in_row[sx as usize * ch + c];
                        }
                        out_row[x * ch + c] = sum;
                    }
                }
            }
        });

    let stride = w * ch;
    let mut out = vec![0.0f32; w * h * ch];
    out.par_chunks_mut(stride)
        .enumerate()
        .for_each(|(y, out_row)| {
            for (k, weight) in BINOMIAL.iter().enumerate() {
                let sy = (2 * y as isize + k as isize - 2).clamp(0, sh as isize - 1) as usize;
                let in_row = &horizontal[sy * stride..(sy + 1) * stride];
                for (o, i) in out_row.iter_mut().zip(in_row.iter()) {
                    *o += weight * i;
                }
            }
        });
    Raster::from_data(w, h, ch, out)
}

pub fn pyr_up(src: &Raster, width: usize, height: usize) -> Raster {
    let ch = src.channels;
    let sw = src.width as isize;
    let sh = src.height as isize;

    let mut horizontal = vec![0.0f32; width * src.height * ch];
    horizontal
        .par_chunks_mut(width * ch)
        .zip(src.data.par_chunks(src.width * ch))
        .for_each(|(row, input)| {
            let at = |xi: isize, c: usize| input[xi.clamp(0, sw - 1) as usize * ch + c];
            for x in 0..width {
                let i = (x / 2) as isize;
                if i >= 1 && i + 1 < sw {
                    let b = i as usize * ch;
                    if x % 2 == 0 {
                        for c in 0..ch {
                            row[x * ch + c] =
                                (input[b - ch + c] + 6.0 * input[b + c] + input[b + ch + c]) / 8.0;
                        }
                    } else {
                        for c in 0..ch {
                            row[x * ch + c] = (input[b + c] + input[b + ch + c]) / 2.0;
                        }
                    }
                } else {
                    for c in 0..ch {
                        row[x * ch + c] = if x % 2 == 0 {
                            (at(i - 1, c) + 6.0 * at(i, c) + at(i + 1, c)) / 8.0
                        } else {
                            (at(i, c) + at(i + 1, c)) / 2.0
                        };
                    }
                }
            }
        });

    let mut out = vec![0.0f32; width * height * ch];
    out.par_chunks_mut(width * ch)
        .enumerate()
        .for_each(|(y, row)| {
            let i = (y / 2) as isize;
            let line = |yi: isize| {
                let yc = yi.clamp(0, sh - 1) as usize;
                &horizontal[yc * width * ch..(yc + 1) * width * ch]
            };
            if y % 2 == 0 {
                let (a, b, c) = (line(i - 1), line(i), line(i + 1));
                for k in 0..width * ch {
                    row[k] = (a[k] + 6.0 * b[k] + c[k]) / 8.0;
                }
            } else {
                let (a, b) = (line(i), line(i + 1));
                for k in 0..width * ch {
                    row[k] = (a[k] + b[k]) / 2.0;
                }
            }
        });

    Raster::from_data(width, height, ch, out)
}

pub fn downsample_box(src: &Raster) -> Raster {
    let w = (src.width / 2).max(1);
    let h = (src.height / 2).max(1);
    let ch = src.channels;
    let mut out = Raster::new(w, h, ch);
    out.data
        .par_chunks_mut(w * ch)
        .enumerate()
        .for_each(|(y, row)| {
            let y0 = (y * 2).min(src.height - 1);
            let y1 = (y * 2 + 1).min(src.height - 1);
            for x in 0..w {
                let x0 = (x * 2).min(src.width - 1);
                let x1 = (x * 2 + 1).min(src.width - 1);
                for c in 0..ch {
                    row[x * ch + c] = 0.25
                        * (src.get(x0, y0, c)
                            + src.get(x1, y0, c)
                            + src.get(x0, y1, c)
                            + src.get(x1, y1, c));
                }
            }
        });
    out
}

pub fn push_pull_fill(image: &mut Raster, valid: &[f32], max_levels: usize) {
    assert_eq!(
        valid.len(),
        image.width * image.height,
        "validity mask must match the image size"
    );
    let ch = image.channels;
    let mut weighted = Raster::new(image.width, image.height, ch + 1);
    weighted
        .data
        .par_chunks_mut(ch + 1)
        .zip(image.data.par_chunks(ch))
        .zip(valid.par_iter())
        .for_each(|((dst, src), &v)| {
            for c in 0..ch {
                dst[c] = src[c] * v;
            }
            dst[ch] = v;
        });

    let mut levels = vec![weighted];
    while levels.len() <= max_levels
        && (levels.last().unwrap().width > 1 || levels.last().unwrap().height > 1)
    {
        let next = pyr_down(levels.last().unwrap());
        levels.push(next);
    }

    for level in (0..levels.len() - 1).rev() {
        let (w, h) = (levels[level].width, levels[level].height);
        let coarse = pyr_up(&levels[level + 1], w, h);
        let fine = &mut levels[level];
        fine.data
            .par_chunks_mut(ch + 1)
            .zip(coarse.data.par_chunks(ch + 1))
            .for_each(|(f, c)| {
                let missing = (1.0 - f[ch]).clamp(0.0, 1.0);
                if missing > 0.0 && c[ch] > 1e-8 {
                    let scale = missing / c[ch];
                    for k in 0..ch {
                        f[k] += c[k] * scale;
                    }
                    f[ch] += missing;
                }
            });
    }

    let filled = &levels[0];
    image
        .data
        .par_chunks_mut(ch)
        .zip(filled.data.par_chunks(ch + 1))
        .zip(valid.par_iter())
        .for_each(|((dst, src), &v)| {
            if v < 1.0 && src[ch] > 1e-8 {
                for c in 0..ch {
                    dst[c] = src[c] / src[ch];
                }
            }
        });
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: usize,
    pub y: usize,
    pub width: usize,
    pub height: usize,
}

impl Rect {
    pub fn right(&self) -> usize {
        self.x + self.width
    }

    pub fn bottom(&self) -> usize {
        self.y + self.height
    }

    pub fn intersect(&self, other: &Rect) -> Option<Rect> {
        let x0 = self.x.max(other.x);
        let y0 = self.y.max(other.y);
        let x1 = self.right().min(other.right());
        let y1 = self.bottom().min(other.bottom());
        (x1 > x0 && y1 > y0).then(|| Rect {
            x: x0,
            y: y0,
            width: x1 - x0,
            height: y1 - y0,
        })
    }

    pub fn contains(&self, x: usize, y: usize) -> bool {
        x >= self.x && y >= self.y && x < self.right() && y < self.bottom()
    }

    pub fn full(width: usize, height: usize) -> Rect {
        Rect {
            x: 0,
            y: 0,
            width,
            height,
        }
    }

    pub fn scaled_inward(&self, from: (usize, usize), to: (usize, usize)) -> Rect {
        if *self == Rect::full(from.0, from.1) {
            return Rect::full(to.0, to.1);
        }
        let sx = to.0 as f64 / from.0 as f64;
        let sy = to.1 as f64 / from.1 as f64;
        let x0 = ((self.x as f64 + 0.5) * sx).ceil() as usize;
        let y0 = ((self.y as f64 + 0.5) * sy).ceil() as usize;
        let x1 = ((self.right() as f64 - 0.5) * sx).floor() as usize;
        let y1 = ((self.bottom() as f64 - 0.5) * sy).floor() as usize;
        let x0 = x0.min(to.0 - 1);
        let y0 = y0.min(to.1 - 1);
        Rect {
            x: x0,
            y: y0,
            width: x1.min(to.0).saturating_sub(x0).max(1),
            height: y1.min(to.1).saturating_sub(y0).max(1),
        }
    }
}

fn area_taps(source: usize, target: usize) -> Vec<(usize, Vec<f32>)> {
    let ratio = source as f64 / target as f64;
    (0..target)
        .map(|i| {
            let start = i as f64 * ratio;
            let end = (i + 1) as f64 * ratio;
            let first = start.floor() as usize;
            let last = (end.ceil() as usize).min(source);
            let weights: Vec<f32> = (first..last)
                .map(|s| ((end.min(s as f64 + 1.0) - start.max(s as f64)) / ratio) as f32)
                .collect();
            (first, weights)
        })
        .collect()
}

pub fn resize_area(src: &Raster, width: usize, height: usize) -> Raster {
    if src.width == width && src.height == height {
        return src.clone();
    }
    assert!(
        width <= src.width && height <= src.height,
        "area resampling only reduces"
    );
    let ch = src.channels;
    let columns = area_taps(src.width, width);
    let rows = area_taps(src.height, height);
    let mut horizontal = vec![0.0f32; width * src.height * ch];
    horizontal
        .par_chunks_mut(width * ch)
        .zip(src.data.par_chunks(src.width * ch))
        .for_each(|(out_row, in_row)| {
            for (x, (first, weights)) in columns.iter().enumerate() {
                for (k, w) in weights.iter().enumerate() {
                    let s = (first + k) * ch;
                    for c in 0..ch {
                        out_row[x * ch + c] += w * in_row[s + c];
                    }
                }
            }
        });
    let mut out = vec![0.0f32; width * height * ch];
    out.par_chunks_mut(width * ch)
        .zip(rows.par_iter())
        .for_each(|(out_row, (first, weights))| {
            for (k, w) in weights.iter().enumerate() {
                let in_row = &horizontal[(first + k) * width * ch..(first + k + 1) * width * ch];
                for (o, i) in out_row.iter_mut().zip(in_row) {
                    *o += w * i;
                }
            }
        });
    Raster::from_data(width, height, ch, out)
}

pub fn fit_size(width: usize, height: usize, max_dimension: usize) -> (usize, usize) {
    let long = width.max(height);
    if long <= max_dimension {
        return (width, height);
    }
    let scale = max_dimension as f64 / long as f64;
    (
        ((width as f64 * scale).round() as usize).max(1),
        ((height as f64 * scale).round() as usize).max(1),
    )
}

pub fn map_pixels(src: &Raster, channels: usize, f: impl Fn(&[f32], &mut [f32]) + Sync) -> Raster {
    let mut out = Raster::new(src.width, src.height, channels);
    out.data
        .par_chunks_mut(channels)
        .zip(src.data.par_chunks(src.channels))
        .for_each(|(o, i)| f(i, o));
    out
}

pub fn max_filter(src: &Raster, radius: usize) -> Raster {
    assert_eq!(src.channels, 1, "max filter expects a single channel");
    if radius == 0 {
        return src.clone();
    }
    let (w, h) = (src.width, src.height);
    let mut horizontal = vec![0.0f32; w * h];
    horizontal
        .par_chunks_mut(w)
        .zip(src.data.par_chunks(w))
        .for_each(|(out, row)| {
            for (x, value) in out.iter_mut().enumerate() {
                let lo = x.saturating_sub(radius);
                let hi = (x + radius + 1).min(w);
                *value = row[lo..hi]
                    .iter()
                    .copied()
                    .fold(f32::NEG_INFINITY, f32::max);
            }
        });
    let mut out = vec![0.0f32; w * h];
    out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let lo = y.saturating_sub(radius);
        let hi = (y + radius + 1).min(h);
        for (x, value) in row.iter_mut().enumerate() {
            *value = (lo..hi)
                .map(|yy| horizontal[yy * w + x])
                .fold(f32::NEG_INFINITY, f32::max);
        }
    });
    Raster::from_data(w, h, 1, out)
}

pub fn largest_rectangle(
    data: &[bool],
    width: usize,
    height: usize,
) -> Option<(usize, usize, usize, usize)> {
    let mut heights = vec![0usize; width];
    let mut best: Option<(usize, usize, usize, usize)> = None;
    let mut best_area = 0;
    let mut stack: Vec<usize> = Vec::with_capacity(width + 1);
    for y in 0..height {
        for (h, &valid) in heights.iter_mut().zip(&data[y * width..(y + 1) * width]) {
            *h = if valid { *h + 1 } else { 0 };
        }
        stack.clear();
        for x in 0..=width {
            let current = if x < width { heights[x] } else { 0 };
            while let Some(&top) = stack.last() {
                if heights[top] < current {
                    break;
                }
                stack.pop();
                let h = heights[top];
                let left = stack.last().map_or(0, |&s| s + 1);
                let area = h * (x - left);
                if area > best_area {
                    best_area = area;
                    best = Some((left, y + 1 - h, x - left, h));
                }
            }
            stack.push(x);
        }
    }
    best
}

pub fn crop_rects(
    valid: &[&[f32]],
    preview: (usize, usize),
    full: (usize, usize),
    auto_crop: bool,
) -> (Rect, Rect) {
    let rect = if auto_crop {
        coverage_rect(valid, preview.0, preview.1)
    } else {
        Rect::full(preview.0, preview.1)
    };
    (rect, rect.scaled_inward(preview, full))
}

fn coverage_rect(valid: &[&[f32]], width: usize, height: usize) -> Rect {
    let mask: Vec<bool> = (0..width * height)
        .into_par_iter()
        .map(|i| valid.iter().all(|v| v[i] >= 1.0))
        .collect();
    largest_rectangle(&mask, width, height)
        .map(|(x, y, w, h)| Rect {
            x,
            y,
            width: w,
            height: h,
        })
        .unwrap_or_else(|| Rect::full(width, height))
}

pub fn crop(image: &Raster, rect: &Rect) -> Raster {
    if *rect == Rect::full(image.width, image.height) {
        return image.clone();
    }
    let ch = image.channels;
    let mut out = Raster::new(rect.width, rect.height, ch);
    out.data
        .par_chunks_mut(rect.width * ch)
        .enumerate()
        .for_each(|(y, row)| {
            let start = image.index(rect.x, rect.y + y);
            row.copy_from_slice(&image.data[start..start + rect.width * ch]);
        });
    out
}

pub fn srgb_encoded(image: &Raster) -> Raster {
    let transfer = srgb_transfer();
    map_pixels(image, image.channels, |p, o| {
        for (o, v) in o.iter_mut().zip(p) {
            *o = transfer.encode(v.max(0.0));
        }
    })
}

pub fn srgb_decoded(mut image: Raster) -> Raster {
    let transfer = srgb_transfer();
    image
        .data
        .par_iter_mut()
        .for_each(|v| *v = transfer.decode(v.max(0.0)));
    image
}

pub fn encoded_luminance(image: &Raster) -> Raster {
    let transfer = srgb_transfer();
    map_pixels(image, 1, |p, o| {
        o[0] = transfer.encode(luminance(p).max(0.0))
    })
}
