use rayon::prelude::*;

#[derive(Clone, Debug, PartialEq)]
pub struct Plane {
    pub width: usize,
    pub height: usize,
    pub data: Vec<f32>,
}

impl Plane {
    pub fn new(width: usize, height: usize) -> Self {
        Self {
            width,
            height,
            data: vec![0.0; width * height],
        }
    }
    pub fn try_new(width: usize, height: usize) -> Result<Self, String> {
        let mut data: Vec<f32> = Vec::new();
        data.try_reserve_exact(width * height)
            .map_err(|_| "Not enough memory for the stitched image.".to_string())?;
        data.resize(width * height, 0.0);
        Ok(Self {
            width,
            height,
            data,
        })
    }
    pub fn filled(width: usize, height: usize, v: f32) -> Self {
        Self {
            width,
            height,
            data: vec![v; width * height],
        }
    }
    pub fn from_fn(
        width: usize,
        height: usize,
        f: impl Fn(usize, usize) -> f32 + Sync + Send,
    ) -> Self {
        let mut data = vec![0.0; width * height];
        data.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
            for (x, o) in row.iter_mut().enumerate() {
                *o = f(x, y);
            }
        });
        Self {
            width,
            height,
            data,
        }
    }
    #[inline]
    pub fn get(&self, x: usize, y: usize) -> f32 {
        self.data[y * self.width + x]
    }
    #[inline]
    pub fn get_clamped(&self, x: isize, y: isize) -> f32 {
        let x = x.clamp(0, self.width as isize - 1) as usize;
        let y = y.clamp(0, self.height as isize - 1) as usize;
        self.data[y * self.width + x]
    }
    pub fn set(&mut self, x: usize, y: usize, v: f32) {
        self.data[y * self.width + x] = v;
    }
    pub fn len(&self) -> usize {
        self.data.len()
    }
    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }
    pub fn zip_map(&self, other: &Plane, f: impl Fn(f32, f32) -> f32 + Sync + Send) -> Plane {
        Plane {
            width: self.width,
            height: self.height,
            data: self
                .data
                .par_iter()
                .zip(&other.data)
                .map(|(a, b)| f(*a, *b))
                .collect(),
        }
    }
}

#[inline]
pub fn sample_interleaved(data: &[f32], width: usize, height: usize, x: f32, y: f32) -> [f32; 3] {
    let fx = x - 0.5;
    let fy = y - 0.5;
    let x0 = fx.floor();
    let y0 = fy.floor();
    let (tx, ty) = (fx - x0, fy - y0);
    let (xi, yi) = (x0 as isize, y0 as isize);
    let at = |x: isize, y: isize| -> [f32; 3] {
        let x = x.clamp(0, width as isize - 1) as usize;
        let y = y.clamp(0, height as isize - 1) as usize;
        let i = (y * width + x) * 3;
        [data[i], data[i + 1], data[i + 2]]
    };
    let a = at(xi, yi);
    let b = at(xi + 1, yi);
    let c = at(xi, yi + 1);
    let d = at(xi + 1, yi + 1);
    [0, 1, 2].map(|i| {
        let top = a[i] + (b[i] - a[i]) * tx;
        let bot = c[i] + (d[i] - c[i]) * tx;
        top + (bot - top) * ty
    })
}

#[derive(Clone, Debug, PartialEq)]
pub struct Rgb32f {
    pub width: usize,
    pub height: usize,
    pub data: Vec<[f32; 3]>,
}

impl Rgb32f {
    pub fn new(width: usize, height: usize) -> Self {
        Self {
            width,
            height,
            data: vec![[0.0; 3]; width * height],
        }
    }
    pub fn try_new(width: usize, height: usize) -> Result<Self, String> {
        let mut data: Vec<[f32; 3]> = Vec::new();
        data.try_reserve_exact(width * height)
            .map_err(|_| "Not enough memory for the stitched image.".to_string())?;
        data.resize(width * height, [0.0; 3]);
        Ok(Self {
            width,
            height,
            data,
        })
    }
    pub fn from_fn(
        width: usize,
        height: usize,
        f: impl Fn(usize, usize) -> [f32; 3] + Sync + Send,
    ) -> Self {
        let mut data = vec![[0.0; 3]; width * height];
        data.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
            for (x, o) in row.iter_mut().enumerate() {
                *o = f(x, y);
            }
        });
        Self {
            width,
            height,
            data,
        }
    }
    #[inline]
    pub fn get(&self, x: usize, y: usize) -> [f32; 3] {
        self.data[y * self.width + x]
    }
    #[inline]
    pub fn sample_bilinear(&self, x: f32, y: f32) -> [f32; 3] {
        let fx = x - 0.5;
        let fy = y - 0.5;
        let x0 = fx.floor();
        let y0 = fy.floor();
        let (tx, ty) = (fx - x0, fy - y0);
        let (x0, y0) = (x0 as isize, y0 as isize);
        let a = self.get_clamped(x0, y0);
        let b = self.get_clamped(x0 + 1, y0);
        let c = self.get_clamped(x0, y0 + 1);
        let d = self.get_clamped(x0 + 1, y0 + 1);
        [0, 1, 2].map(|i| {
            let top = a[i] + (b[i] - a[i]) * tx;
            let bot = c[i] + (d[i] - c[i]) * tx;
            top + (bot - top) * ty
        })
    }
    #[inline]
    fn get_clamped(&self, x: isize, y: isize) -> [f32; 3] {
        let x = x.clamp(0, self.width as isize - 1) as usize;
        let y = y.clamp(0, self.height as isize - 1) as usize;
        self.data[y * self.width + x]
    }
    pub fn map(&self, f: impl Fn([f32; 3]) -> [f32; 3] + Sync + Send) -> Rgb32f {
        Rgb32f {
            width: self.width,
            height: self.height,
            data: self.data.par_iter().map(|&v| f(v)).collect(),
        }
    }
}

pub fn box_radii(sigma: f32) -> [usize; 3] {
    let n = 3.0f32;
    let w_ideal = (12.0 * sigma * sigma / n + 1.0).sqrt();
    let mut wl = w_ideal.floor() as i32;
    if wl % 2 == 0 {
        wl -= 1;
    }
    let wu = wl + 2;
    let m_ideal = (12.0 * sigma * sigma - n * (wl * wl) as f32 - 4.0 * n * wl as f32 - 3.0 * n)
        / (-4.0 * wl as f32 - 4.0);
    let m = m_ideal.round() as i32;
    std::array::from_fn(|i| (((if (i as i32) < m { wl } else { wu }) - 1) / 2).max(0) as usize)
}

fn box_row<T: Copy + Default + Send + Sync>(
    row: &mut [T],
    tmp: &mut Vec<T>,
    r: usize,
    madd: fn(T, T, f32) -> T,
) {
    let w = row.len();
    if r == 0 || w == 0 {
        return;
    }
    tmp.clear();
    tmp.extend_from_slice(row);
    let s = &tmp[..];
    let last = w - 1;
    let inv = 1.0 / (2 * r + 1) as f32;
    let mut acc = T::default();
    for i in 0..=2 * r {
        acc = madd(acc, s[i.saturating_sub(r).min(last)], 1.0);
    }
    for x in 0..w {
        row[x] = madd(T::default(), acc, inv);
        acc = madd(
            madd(acc, s[(x + r + 1).min(last)], 1.0),
            s[x.saturating_sub(r)],
            -1.0,
        );
    }
}

const BAND: usize = 32;

fn box_v<T: Copy + Default + Send + Sync>(
    src_w: usize,
    a: &[T],
    b: &mut [T],
    r: usize,
    madd: fn(T, T, f32) -> T,
) {
    let inv = 1.0 / (2 * r + 1) as f32;
    b.par_chunks_mut(src_w * BAND)
        .enumerate()
        .for_each(|(band, out)| {
            let y0 = band * BAND;
            let h = out.len() / src_w;
            let mut acc = vec![T::default(); src_w];
            for i in 0..=2 * r {
                let yy = (y0 + i).saturating_sub(r).min(a.len() / src_w - 1);
                let srow = &a[yy * src_w..(yy + 1) * src_w];
                for (acc, v) in acc.iter_mut().zip(srow) {
                    *acc = madd(*acc, *v, 1.0);
                }
            }
            for (k, orow) in out.chunks_mut(src_w).enumerate() {
                let y = y0 + k;
                for (o, acc) in orow.iter_mut().zip(&acc) {
                    *o = madd(T::default(), *acc, inv);
                }
                let _ = h;
                let add = (y + r + 1).min(a.len() / src_w - 1) * src_w;
                let sub = y.saturating_sub(r) * src_w;
                for (k, acc) in acc.iter_mut().enumerate() {
                    *acc = madd(madd(*acc, a[add + k], 1.0), a[sub + k], -1.0);
                }
            }
        });
}

fn madd_f32(a: f32, b: f32, w: f32) -> f32 {
    a + b * w
}

pub fn gaussian_plane(img: &Plane, sigma: f32) -> Plane {
    if sigma <= 0.3 || img.is_empty() {
        return img.clone();
    }
    let radii = box_radii(sigma);
    let (w, h) = (img.width, img.height);
    let mut a = img.clone();
    a.data.par_chunks_mut(w).for_each(|row| {
        let mut tmp = Vec::with_capacity(w);
        for r in radii {
            box_row(row, &mut tmp, r, madd_f32);
        }
    });
    let mut b = Plane::new(w, h);
    for r in radii {
        if r == 0 {
            continue;
        }
        box_v(w, &a.data, &mut b.data, r, madd_f32);
        std::mem::swap(&mut a, &mut b);
    }
    a
}

pub fn half_plane(img: &Plane) -> Plane {
    let w = img.width.div_ceil(2).max(1);
    let h = img.height.div_ceil(2).max(1);
    let mut out = Plane::new(w, h);
    out.data.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        for (x, o) in row.iter_mut().enumerate() {
            let sx = (2 * x) as isize;
            let sy = (2 * y) as isize;
            *o = 0.25 * img.get_clamped(sx, sy)
                + 0.25 * img.get_clamped(sx + 1, sy)
                + 0.25 * img.get_clamped(sx, sy + 1)
                + 0.25 * img.get_clamped(sx + 1, sy + 1);
        }
    });
    out
}

pub const BOX_SUPPORT: f32 = 0.5;

pub fn weights(src: usize, dst: usize) -> Vec<(usize, Vec<f32>)> {
    let scale = src as f32 / dst as f32;
    let fscale = scale.max(1.0);
    let support = BOX_SUPPORT * fscale;
    (0..dst)
        .map(|i| {
            let center = (i as f32 + 0.5) * scale;
            let lo = ((center - support).floor() as isize).max(0) as usize;
            let hi = ((center + support).ceil() as usize).min(src);
            let mut w: Vec<f32> = (lo..hi)
                .map(|j| {
                    let x = ((j as f32 + 0.5 - center) / fscale).abs();
                    if x <= BOX_SUPPORT { 1.0 } else { 0.0 }
                })
                .collect();
            let sum: f32 = w.iter().sum();
            if sum.abs() > 1e-8 {
                w.iter_mut().for_each(|v| *v /= sum);
            } else if !w.is_empty() {
                let n = w.len() as f32;
                w.iter_mut().for_each(|v| *v = 1.0 / n);
            }
            (lo, w)
        })
        .collect()
}

pub fn resize_box(img: &Rgb32f, w: usize, h: usize) -> Rgb32f {
    let (w, h) = (w.max(1), h.max(1));
    if img.width == w && img.height == h {
        return img.clone();
    }
    let wx = weights(img.width, w);
    let mut tmp = Rgb32f::new(w, img.height);
    tmp.data.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let src = &img.data[y * img.width..(y + 1) * img.width];
        for (x, o) in row.iter_mut().enumerate() {
            let (lo, ws) = &wx[x];
            let mut acc = [0.0f32; 3];
            for (k, wt) in ws.iter().enumerate() {
                let s = src[lo + k];
                for c in 0..3 {
                    acc[c] += s[c] * *wt;
                }
            }
            *o = acc;
        }
    });
    let wy = weights(img.height, h);
    let mut out = Rgb32f::new(w, h);
    out.data.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let (lo, ws) = &wy[y];
        for (k, wt) in ws.iter().enumerate() {
            let srow = &tmp.data[(lo + k) * w..(lo + k) * w + w];
            for (o, s) in row.iter_mut().zip(srow) {
                for c in 0..3 {
                    o[c] += s[c] * *wt;
                }
            }
        }
    });
    out
}

pub fn fit_rgb(img: &Rgb32f, max_w: usize, max_h: usize) -> Rgb32f {
    let s = (max_w as f64 / img.width as f64)
        .min(max_h as f64 / img.height as f64)
        .min(1.0);
    let w = ((img.width as f64 * s).round() as usize).max(1);
    let h = ((img.height as f64 * s).round() as usize).max(1);
    resize_box(img, w, h)
}

pub fn long_edge_size(width: usize, height: usize, max_edge: usize) -> (usize, usize) {
    if width == 0 || height == 0 || width.max(height) <= max_edge || max_edge == 0 {
        return (width, height);
    }
    if width >= height {
        let w = max_edge;
        let h = ((w as f64) * height as f64 / width as f64).round().max(1.0) as usize;
        (w, h)
    } else {
        let h = max_edge;
        let w = ((h as f64) * width as f64 / height as f64).round().max(1.0) as usize;
        (w, h)
    }
}

pub fn fit_long_edge(img: &Rgb32f, max_edge: usize) -> Rgb32f {
    let (w, h) = long_edge_size(img.width, img.height, max_edge);
    if w == img.width && h == img.height {
        return img.clone();
    }
    resize_box(img, w, h)
}
