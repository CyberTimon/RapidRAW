use crate::merge::focus_stacking::gaussian_kernel;
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
}
