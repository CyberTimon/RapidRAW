use image::imageops::{self, FilterType};
use image::{GrayImage, ImageBuffer, Luma, RgbImage};
use rayon::prelude::*;

fn edt_1d(f: &mut [f32], v: &mut [usize], z: &mut [f32], d: &mut [f32]) {
    let n = f.len();
    if n == 0 {
        return;
    }
    let mut k = 0;
    v[0] = 0;
    z[0] = f32::NEG_INFINITY;
    z[1] = f32::INFINITY;
    for q in 1..n {
        let mut s = ((f[q] + (q * q) as f32) - (f[v[k]] + (v[k] * v[k]) as f32))
            / (2.0 * (q as f32 - v[k] as f32));
        while s <= z[k] {
            if k == 0 {
                break;
            }
            k -= 1;
            s = ((f[q] + (q * q) as f32) - (f[v[k]] + (v[k] * v[k]) as f32))
                / (2.0 * (q as f32 - v[k] as f32));
        }
        k += 1;
        v[k] = q;
        z[k] = s;
        z[k + 1] = f32::INFINITY;
    }
    k = 0;
    for (q, d_q) in d[..n].iter_mut().enumerate() {
        while z[k + 1] < q as f32 {
            k += 1;
        }
        let diff = q as f32 - v[k] as f32;
        *d_q = diff * diff + f[v[k]];
    }
    f.copy_from_slice(&d[..n]);
}

pub fn edt_2d(grid: &[bool], width: usize, height: usize) -> Vec<f32> {
    let area = width * height;
    let mut f = vec![0.0; area];
    for i in 0..area {
        f[i] = if grid[i] { 1e10 } else { 0.0 };
    }

    let max_dim = width.max(height);
    let mut v = vec![0; max_dim];
    let mut z = vec![0.0; max_dim + 1];
    let mut d = vec![0.0; max_dim];

    for y in 0..height {
        let start = y * width;
        let end = start + width;
        edt_1d(&mut f[start..end], &mut v, &mut z, &mut d);
    }

    let mut col = vec![0.0; height];
    for x in 0..width {
        for y in 0..height {
            col[y] = f[y * width + x];
        }
        edt_1d(&mut col, &mut v, &mut z, &mut d);
        for y in 0..height {
            f[y * width + x] = col[y];
        }
    }

    f.into_iter().map(|v| v.sqrt()).collect()
}

fn box_filter_horiz(src: &[f32], dest: &mut [f32], w: usize, r: usize) {
    dest.par_chunks_exact_mut(w)
        .zip(src.par_chunks_exact(w))
        .for_each(|(dest_row, src_row)| {
            let mut prefix = vec![0.0; w + 1];
            for x in 0..w {
                prefix[x + 1] = prefix[x] + src_row[x];
            }
            for (x, dest_val) in dest_row.iter_mut().enumerate() {
                let x_min = x.saturating_sub(r);
                let x_max = (x + r).min(w - 1);
                let count = (x_max - x_min + 1) as f32;
                *dest_val = (prefix[x_max + 1] - prefix[x_min]) / count;
            }
        });
}

fn transpose(src: &[f32], dest: &mut [f32], w: usize, h: usize) {
    dest.par_chunks_exact_mut(h)
        .enumerate()
        .for_each(|(x, dest_col)| {
            for y in 0..h {
                dest_col[y] = src[y * w + x];
            }
        });
}

fn box_filter_opt(
    src: &[f32],
    dest: &mut [f32],
    temp1: &mut [f32],
    temp2: &mut [f32],
    w: usize,
    h: usize,
    r: usize,
) {
    box_filter_horiz(src, temp1, w, r);
    transpose(temp1, temp2, w, h);
    box_filter_horiz(temp2, temp1, h, r);
    transpose(temp1, dest, h, w);
}

pub fn fast_guided_filter(
    guide_hr: &GrayImage,
    mask_lr: &GrayImage,
    r: usize,
    eps: f32,
) -> GrayImage {
    let (hr_w, hr_h) = guide_hr.dimensions();
    let (lr_w, lr_h) = mask_lr.dimensions();

    let w = lr_w as usize;
    let h = lr_h as usize;
    let area = w * h;

    let guide_lr = if (lr_w, lr_h) == (hr_w, hr_h) {
        std::borrow::Cow::Borrowed(guide_hr)
    } else {
        std::borrow::Cow::Owned(imageops::resize(guide_hr, lr_w, lr_h, FilterType::Triangle))
    };

    let mut i_lr = vec![0.0; area];
    let mut p_lr = vec![0.0; area];
    let mut ip_lr = vec![0.0; area];
    let mut ii_lr = vec![0.0; area];

    let guide_lr_raw = guide_lr.as_raw();
    let mask_lr_raw = mask_lr.as_raw();

    i_lr.par_iter_mut()
        .zip(p_lr.par_iter_mut())
        .zip(ip_lr.par_iter_mut())
        .zip(ii_lr.par_iter_mut())
        .zip(guide_lr_raw.par_iter())
        .zip(mask_lr_raw.par_iter())
        .for_each(|(((((i_out, p_out), ip_out), ii_out), &g_val), &m_val)| {
            let i_val = g_val as f32 / 255.0;
            let p_val = m_val as f32 / 255.0;
            *i_out = i_val;
            *p_out = p_val;
            *ip_out = i_val * p_val;
            *ii_out = i_val * i_val;
        });

    drop(guide_lr);

    let mut temp1 = vec![0.0; area];
    let mut temp2 = vec![0.0; area];

    let box_filter = |src: Vec<f32>, temp1: &mut [f32], temp2: &mut [f32]| {
        let mut mean = vec![0.0; area];
        box_filter_opt(&src, &mut mean, temp1, temp2, w, h, r);
        mean
    };
    let mean_i = box_filter(i_lr, &mut temp1, &mut temp2);
    let mean_p = box_filter(p_lr, &mut temp1, &mut temp2);
    let mut a = box_filter(ip_lr, &mut temp1, &mut temp2);
    let mut b = box_filter(ii_lr, &mut temp1, &mut temp2);

    a.par_iter_mut()
        .zip(b.par_iter_mut())
        .zip(mean_i.par_iter())
        .zip(mean_p.par_iter())
        .for_each(|(((a_out, b_out), &m_i), &m_p)| {
            let (m_ip, m_ii) = (*a_out, *b_out);
            let cov_ip = m_ip - m_i * m_p;
            let var_i = m_ii - m_i * m_i;
            let a_val = cov_ip / (var_i + eps);
            *a_out = a_val;
            *b_out = m_p - a_val * m_i;
        });

    let (mut mean_a, mut mean_b) = (mean_i, mean_p);
    box_filter_opt(&a, &mut mean_a, &mut temp1, &mut temp2, w, h, r);
    box_filter_opt(&b, &mut mean_b, &mut temp1, &mut temp2, w, h, r);
    drop((a, b, temp1, temp2));

    let mean_a_img = ImageBuffer::<Luma<f32>, Vec<f32>>::from_raw(lr_w, lr_h, mean_a).unwrap();
    let mean_b_img = ImageBuffer::<Luma<f32>, Vec<f32>>::from_raw(lr_w, lr_h, mean_b).unwrap();

    let upscale = |img: ImageBuffer<Luma<f32>, Vec<f32>>| {
        if (lr_w, lr_h) == (hr_w, hr_h) {
            img.into_raw()
        } else {
            imageops::resize(&img, hr_w, hr_h, FilterType::Triangle).into_raw()
        }
    };
    let mean_a_hr_raw = upscale(mean_a_img);
    let mean_b_hr_raw = upscale(mean_b_img);
    let guide_hr_raw = guide_hr.as_raw();

    let mut final_mask_raw = vec![0u8; (hr_w * hr_h) as usize];

    final_mask_raw
        .par_iter_mut()
        .zip(mean_a_hr_raw.par_iter())
        .zip(mean_b_hr_raw.par_iter())
        .zip(guide_hr_raw.par_iter())
        .for_each(|(((out, &a_val), &b_val), &i_val)| {
            let i_v = i_val as f32 / 255.0;
            let q = a_val * i_v + b_val;
            *out = (q.clamp(0.0, 1.0) * 255.0).round() as u8;
        });

    GrayImage::from_raw(hr_w, hr_h, final_mask_raw).unwrap()
}

fn bilinear_sample(i: usize, scale: f32, n: usize) -> (usize, usize, f32) {
    let f = ((i as f32 + 0.5) * scale - 0.5).max(0.0);
    let i0 = (f.floor() as usize).min(n - 1);
    let i1 = (i0 + 1).min(n - 1);
    (i0, i1, (f - i0 as f32).clamp(0.0, 1.0))
}

pub fn color_guided_coefficients(
    guide_lr: &RgbImage,
    mask_lr: &GrayImage,
    r: usize,
    eps: f32,
) -> [Vec<f32>; 4] {
    let (lr_w, lr_h) = mask_lr.dimensions();
    let (w, h) = (lr_w as usize, lr_h as usize);
    let area = w * h;

    let guide: [Vec<f32>; 3] =
        std::array::from_fn(|c| guide_lr.pixels().map(|p| p[c] as f32 / 255.0).collect());
    let p: Vec<f32> = mask_lr.as_raw().iter().map(|&v| v as f32 / 255.0).collect();

    let mut temp1 = vec![0.0; area];
    let mut temp2 = vec![0.0; area];
    let mut box_filter = |src: &[f32]| {
        let mut mean = vec![0.0; area];
        box_filter_opt(src, &mut mean, &mut temp1, &mut temp2, w, h, r);
        mean
    };
    let product = |a: &[f32], b: &[f32]| -> Vec<f32> {
        a.par_iter().zip(b.par_iter()).map(|(x, y)| x * y).collect()
    };

    let mean_i = guide.each_ref().map(|c| box_filter(c));
    let mean_p = box_filter(&p);
    let mean_ip: [Vec<f32>; 3] = std::array::from_fn(|c| box_filter(&product(&guide[c], &p)));
    let mean_ii = [(0, 0), (0, 1), (0, 2), (1, 1), (1, 2), (2, 2)]
        .map(|(i, j)| box_filter(&product(&guide[i], &guide[j])));
    drop((guide, p));

    let coefficients: Vec<[f32; 4]> = (0..area)
        .into_par_iter()
        .map(|k| {
            let m = [mean_i[0][k], mean_i[1][k], mean_i[2][k]];
            let cov = [0, 1, 2].map(|c| mean_ip[c][k] - m[c] * mean_p[k]);
            let s00 = mean_ii[0][k] - m[0] * m[0] + eps;
            let s01 = mean_ii[1][k] - m[0] * m[1];
            let s02 = mean_ii[2][k] - m[0] * m[2];
            let s11 = mean_ii[3][k] - m[1] * m[1] + eps;
            let s12 = mean_ii[4][k] - m[1] * m[2];
            let s22 = mean_ii[5][k] - m[2] * m[2] + eps;
            let c00 = s11 * s22 - s12 * s12;
            let c01 = s02 * s12 - s01 * s22;
            let c02 = s01 * s12 - s02 * s11;
            let c11 = s00 * s22 - s02 * s02;
            let c12 = s01 * s02 - s00 * s12;
            let c22 = s00 * s11 - s01 * s01;
            let det = s00 * c00 + s01 * c01 + s02 * c02;
            let a0 = (c00 * cov[0] + c01 * cov[1] + c02 * cov[2]) / det;
            let a1 = (c01 * cov[0] + c11 * cov[1] + c12 * cov[2]) / det;
            let a2 = (c02 * cov[0] + c12 * cov[1] + c22 * cov[2]) / det;
            [a0, a1, a2, mean_p[k] - a0 * m[0] - a1 * m[1] - a2 * m[2]]
        })
        .collect();
    drop((mean_i, mean_p, mean_ip, mean_ii));

    std::array::from_fn(|i| box_filter(&coefficients.iter().map(|c| c[i]).collect::<Vec<f32>>()))
}

pub fn fast_color_guided_filter(
    guide_hr: &RgbImage,
    mask_lr: &GrayImage,
    r: usize,
    eps: f32,
) -> GrayImage {
    let (hr_w, hr_h) = guide_hr.dimensions();
    let (lr_w, lr_h) = mask_lr.dimensions();
    let (w, h) = (lr_w as usize, lr_h as usize);

    let guide_lr = imageops::resize(guide_hr, lr_w, lr_h, FilterType::Triangle);
    let mean_coefficients = color_guided_coefficients(&guide_lr, mask_lr, r, eps);
    drop(guide_lr);

    let (hr_w, hr_h) = (hr_w as usize, hr_h as usize);
    let x_samples: Vec<(usize, usize, f32)> = (0..hr_w)
        .map(|x| bilinear_sample(x, w as f32 / hr_w as f32, w))
        .collect();
    let mut final_mask_raw = vec![0u8; hr_w * hr_h];

    final_mask_raw
        .par_chunks_exact_mut(hr_w)
        .zip(guide_hr.as_raw().par_chunks_exact(hr_w * 3))
        .enumerate()
        .for_each(|(y, (out_row, guide_row))| {
            let (y0, y1, ty) = bilinear_sample(y, h as f32 / hr_h as f32, h);
            for (x, (out, pixel)) in out_row
                .iter_mut()
                .zip(guide_row.as_chunks::<3>().0)
                .enumerate()
            {
                let (x0, x1, tx) = x_samples[x];
                let sample = |values: &[f32]| {
                    let top = values[y0 * w + x0] * (1.0 - tx) + values[y0 * w + x1] * tx;
                    let bottom = values[y1 * w + x0] * (1.0 - tx) + values[y1 * w + x1] * tx;
                    top * (1.0 - ty) + bottom * ty
                };
                let q = (0..3)
                    .map(|c| sample(&mean_coefficients[c]) * pixel[c] as f32 / 255.0)
                    .sum::<f32>()
                    + sample(&mean_coefficients[3]);
                *out = (q.clamp(0.0, 1.0) * 255.0).round() as u8;
            }
        });

    GrayImage::from_raw(hr_w as u32, hr_h as u32, final_mask_raw).unwrap()
}
