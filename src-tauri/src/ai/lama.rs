use anyhow::Result;
use image::imageops::{self, FilterType};
use image::{DynamicImage, GenericImageView, GrayImage, RgbaImage};
use ndarray::Array;
use ort::session::Session;
use ort::value::Tensor;
use rayon::prelude::*;
use std::sync::Mutex;

const LAMA_PIXEL_BUDGET: f32 = 768.0 * 768.0;

const LAMA_PATCH_RADIUS: i32 = 3;

const LAMA_PATCH_MATCH_ITERS: u32 = 6;

fn dilate_mask(mask: &[bool], w: usize, h: usize, r: usize) -> Vec<bool> {
    let mut horiz = vec![false; w * h];
    horiz.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let src = &mask[y * w..(y + 1) * w];
        let mut prefix = vec![0u32; w + 1];
        for x in 0..w {
            prefix[x + 1] = prefix[x] + src[x] as u32;
        }
        for (x, out) in row.iter_mut().enumerate() {
            *out = prefix[(x + r + 1).min(w)] > prefix[x.saturating_sub(r)];
        }
    });
    let mut dilated = vec![false; w * h];
    dilated.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let y0 = y.saturating_sub(r);
        let y1 = (y + r).min(h - 1);
        for (x, out) in row.iter_mut().enumerate() {
            *out = (y0..=y1).any(|yy| horiz[yy * w + x]);
        }
    });
    dilated
}

fn catmull_rom_sample(img: &[[f32; 3]], w: usize, h: usize, x: f32, y: f32) -> [f32; 3] {
    let weights = |t: f32| {
        let t2 = t * t;
        let t3 = t2 * t;
        [
            -0.5 * t3 + t2 - 0.5 * t,
            1.5 * t3 - 2.5 * t2 + 1.0,
            -1.5 * t3 + 2.0 * t2 + 0.5 * t,
            0.5 * t3 - 0.5 * t2,
        ]
    };
    let (fx, fy) = (x.floor(), y.floor());
    let wx = weights(x - fx);
    let wy = weights(y - fy);
    let mut acc = [0.0f32; 3];
    for (j, wyj) in wy.iter().enumerate() {
        let sy = (fy as i32 + j as i32 - 1).clamp(0, h as i32 - 1) as usize;
        for (i, wxi) in wx.iter().enumerate() {
            let sx = (fx as i32 + i as i32 - 1).clamp(0, w as i32 - 1) as usize;
            let p = img[sy * w + sx];
            let wgt = wyj * wxi;
            acc[0] += p[0] * wgt;
            acc[1] += p[1] * wgt;
            acc[2] += p[2] * wgt;
        }
    }
    acc
}

fn splitmix64(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9E3779B97F4A7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^ (z >> 31)
}

fn patch_distance(
    target: &[[f32; 3]],
    source: &[[f32; 3]],
    w: usize,
    h: usize,
    t: (i32, i32),
    s: (i32, i32),
    limit: f32,
) -> f32 {
    let mut d = 0.0f32;
    for dy in -LAMA_PATCH_RADIUS..=LAMA_PATCH_RADIUS {
        let ty = (t.1 + dy).clamp(0, h as i32 - 1) as usize;
        let srow = (s.1 + dy) as usize * w;
        for dx in -LAMA_PATCH_RADIUS..=LAMA_PATCH_RADIUS {
            let tx = (t.0 + dx).clamp(0, w as i32 - 1) as usize;
            let a = target[ty * w + tx];
            let b = source[srow + (s.0 + dx) as usize];
            let (e0, e1, e2) = (a[0] - b[0], a[1] - b[1], a[2] - b[2]);
            d += e0 * e0 + e1 * e1 + e2 * e2;
        }
        if d >= limit {
            return d;
        }
    }
    d
}

fn lama_patch_match(
    target: &[[f32; 3]],
    source: &[[f32; 3]],
    w: usize,
    h: usize,
    is_target: &[bool],
    is_source: &[bool],
) -> Option<Vec<Option<(i32, i32)>>> {
    let sources: Vec<(i32, i32)> = (0..w * h)
        .filter(|&i| is_source[i])
        .map(|i| ((i % w) as i32, (i / w) as i32))
        .collect();
    let targets: Vec<usize> = (0..w * h).filter(|&i| is_target[i]).collect();
    if sources.is_empty() || targets.is_empty() {
        return None;
    }

    let valid = |p: (i32, i32)| {
        p.0 >= 0
            && p.1 >= 0
            && (p.0 as usize) < w
            && (p.1 as usize) < h
            && is_source[p.1 as usize * w + p.0 as usize]
    };
    let random_source = |seed: u64| sources[(seed % sources.len() as u64) as usize];

    let mut nnf = vec![(0i32, 0i32); w * h];
    let mut cost = vec![f32::MAX; w * h];
    let init: Vec<((i32, i32), f32)> = targets
        .par_iter()
        .map(|&i| {
            let t = ((i % w) as i32, (i / w) as i32);
            let s = random_source(splitmix64(i as u64));
            (s, patch_distance(target, source, w, h, t, s, f32::MAX))
        })
        .collect();
    for (&i, (s, c)) in targets.iter().zip(init) {
        nnf[i] = s;
        cost[i] = c;
    }

    for iter in 0..LAMA_PATCH_MATCH_ITERS {
        let jump = 1i32 << (LAMA_PATCH_MATCH_ITERS - 1 - iter).min(3);
        let updates: Vec<((i32, i32), f32)> = targets
            .par_iter()
            .map(|&i| {
                let t = ((i % w) as i32, (i / w) as i32);
                let mut best = nnf[i];
                let mut best_cost = cost[i];
                let consider = |c: (i32, i32), best: &mut (i32, i32), best_cost: &mut f32| {
                    if valid(c) && c != *best {
                        let d = patch_distance(target, source, w, h, t, c, *best_cost);
                        if d < *best_cost {
                            *best = c;
                            *best_cost = d;
                        }
                    }
                };

                for (dx, dy) in [(-jump, 0), (jump, 0), (0, -jump), (0, jump)] {
                    let (nx, ny) = (t.0 + dx, t.1 + dy);
                    if nx >= 0 && ny >= 0 && (nx as usize) < w && (ny as usize) < h {
                        let n = ny as usize * w + nx as usize;
                        if is_target[n] {
                            consider((nnf[n].0 - dx, nnf[n].1 - dy), &mut best, &mut best_cost);
                        }
                    }
                }

                let mut seed = splitmix64(i as u64 ^ ((iter as u64 + 1) << 40));
                let mut radius = w.max(h) as i32;
                while radius >= 1 {
                    seed = splitmix64(seed);
                    let span = (2 * radius + 1) as u64;
                    let c = (
                        best.0 + (seed % span) as i32 - radius,
                        best.1 + ((seed >> 32) % span) as i32 - radius,
                    );
                    consider(c, &mut best, &mut best_cost);
                    radius /= 2;
                }
                consider(random_source(splitmix64(seed)), &mut best, &mut best_cost);

                (best, best_cost)
            })
            .collect();
        for (&i, (s, c)) in targets.iter().zip(updates) {
            nnf[i] = s;
            cost[i] = c;
        }
    }

    Some((0..w * h).map(|i| is_target[i].then_some(nnf[i])).collect())
}

pub fn run_lama_inpainting(
    image: &DynamicImage,
    mask: &GrayImage,
    lama_session: &Mutex<Session>,
) -> Result<(RgbaImage, u32, u32)> {
    let (w, h) = image.dimensions();

    let (mut min_x, mut min_y) = (w, h);
    let (mut max_x, mut max_y) = (0u32, 0u32);
    let mut has_mask = false;

    for (x, y, p) in mask.enumerate_pixels() {
        if p[0] > 0 {
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
            has_mask = true;
        }
    }

    if !has_mask {
        return Ok((image.to_rgba8(), 0, 0));
    }

    let mask_w = max_x - min_x + 1;
    let mask_h = max_y - min_y + 1;

    let pad_x = 128.max((mask_w as f32 * 1.5) as u32);
    let pad_y = 128.max((mask_h as f32 * 1.5) as u32);

    let x0 = min_x.saturating_sub(pad_x);
    let y0 = min_y.saturating_sub(pad_y);
    let x1 = (max_x + pad_x).min(w.saturating_sub(1));
    let y1 = (max_y + pad_y).min(h.saturating_sub(1));

    let crop_w = x1 - x0 + 1;
    let crop_h = y1 - y0 + 1;

    let cropped_img = image.crop_imm(x0, y0, crop_w, crop_h).to_rgba8();
    let cropped_mask = imageops::crop_imm(mask, x0, y0, crop_w, crop_h).to_image();

    let scale = (LAMA_PIXEL_BUDGET / (crop_w as f32 * crop_h as f32))
        .sqrt()
        .min(1.0);
    let fw = ((crop_w as f32 * scale).round() as u32).max(1);
    let fh = ((crop_h as f32 * scale).round() as u32).max(1);
    let needs_downscale = fw != crop_w || fh != crop_h;

    let (inf_img, inf_mask) = if needs_downscale {
        (
            imageops::resize(&cropped_img, fw, fh, FilterType::Lanczos3),
            imageops::resize(&cropped_mask, fw, fh, FilterType::Triangle),
        )
    } else {
        (cropped_img.clone(), cropped_mask.clone())
    };

    let align = 32u32;
    let tensor_w = fw.div_ceil(align) * align;
    let tensor_h = fh.div_ceil(align) * align;

    let mut img_tensor = Array::<f32, _>::zeros((1, 3, tensor_h as usize, tensor_w as usize));
    let mut msk_tensor = Array::<f32, _>::zeros((1, 1, tensor_h as usize, tensor_w as usize));

    for y in 0..tensor_h {
        for x in 0..tensor_w {
            let p = inf_img.get_pixel(x.min(fw - 1), y.min(fh - 1));
            let m = inf_mask.get_pixel(x.min(fw - 1), y.min(fh - 1))[0];
            let (y, x) = (y as usize, x as usize);

            img_tensor[[0, 0, y, x]] = p[0] as f32 / 255.0;
            img_tensor[[0, 1, y, x]] = p[1] as f32 / 255.0;
            img_tensor[[0, 2, y, x]] = p[2] as f32 / 255.0;
            msk_tensor[[0, 0, y, x]] = if m > 0 { 1.0 } else { 0.0 };
        }
    }

    let t_img = Tensor::from_array(img_tensor.into_dyn().as_standard_layout().into_owned())?;
    let t_msk = Tensor::from_array(msk_tensor.into_dyn().as_standard_layout().into_owned())?;

    let output_tensor = {
        let mut session = lama_session.lock().unwrap();
        let outputs = session.run(ort::inputs!["image" => t_img, "mask" => t_msk])?;
        outputs[0].try_extract_array::<f32>()?.to_owned()
    };

    let (iw, ih) = (fw as usize, fh as usize);
    let target: Vec<[f32; 3]> = (0..iw * ih)
        .map(|i| {
            let (x, y) = (i % iw, i / iw);
            [0, 1, 2].map(|c| (output_tensor[[0, c, y, x]] / 255.0).clamp(0.0, 1.0))
        })
        .collect();
    let source: Vec<[f32; 3]> = inf_img
        .pixels()
        .map(|p| {
            [
                p[0] as f32 / 255.0,
                p[1] as f32 / 255.0,
                p[2] as f32 / 255.0,
            ]
        })
        .collect();

    let nnf = if needs_downscale {
        let hole: Vec<bool> = inf_mask.pixels().map(|p| p[0] > 0).collect();
        let is_target = dilate_mask(&hole, iw, ih, 1);
        let blocked = dilate_mask(&hole, iw, ih, LAMA_PATCH_RADIUS as usize + 2);
        let r = LAMA_PATCH_RADIUS;
        let is_source: Vec<bool> = (0..iw * ih)
            .map(|i| {
                let (x, y) = ((i % iw) as i32, (i / iw) as i32);
                !blocked[i] && x >= r && y >= r && x < iw as i32 - r && y < ih as i32 - r
            })
            .collect();
        lama_patch_match(&target, &source, iw, ih, &is_target, &is_source)
    } else {
        None
    };

    let sx = fw as f32 / crop_w as f32;
    let sy = fh as f32 / crop_h as f32;
    let mut final_crop = cropped_img.clone();

    final_crop
        .par_chunks_mut(crop_w as usize * 4)
        .enumerate()
        .for_each(|(y, row)| {
            for x in 0..crop_w as usize {
                let m = cropped_mask.get_pixel(x as u32, y as u32)[0];
                if m == 0 {
                    continue;
                }
                let u = (x as f32 + 0.5) * sx - 0.5;
                let v = (y as f32 + 0.5) * sy - 0.5;
                let mut value = catmull_rom_sample(&target, iw, ih, u, v);

                if let Some(nnf) = &nnf {
                    let (u0, v0) = (u.floor(), v.floor());
                    let (fu, fv) = (u - u0, v - v0);
                    let mut groups = [((0i32, 0i32), 0.0f32, [0.0f32; 3]); 4];
                    let mut group_count = 0;
                    for (cu, cv, wgt) in [
                        (u0, v0, (1.0 - fu) * (1.0 - fv)),
                        (u0 + 1.0, v0, fu * (1.0 - fv)),
                        (u0, v0 + 1.0, (1.0 - fu) * fv),
                        (u0 + 1.0, v0 + 1.0, fu * fv),
                    ] {
                        let cu = (cu as i32).clamp(0, iw as i32 - 1);
                        let cv = (cv as i32).clamp(0, ih as i32 - 1);
                        let Some((su, sv)) = nnf[cv as usize * iw + cu as usize] else {
                            continue;
                        };
                        let qx = x as i32 + ((su - cu) as f32 / sx).round() as i32;
                        let qy = y as i32 + ((sv - cv) as f32 / sy).round() as i32;
                        if qx < 0 || qy < 0 || qx >= crop_w as i32 || qy >= crop_h as i32 {
                            continue;
                        }
                        if cropped_mask.get_pixel(qx as u32, qy as u32)[0] > 0 {
                            continue;
                        }
                        let o = cropped_img.get_pixel(qx as u32, qy as u32);
                        let low = catmull_rom_sample(
                            &source,
                            iw,
                            ih,
                            (qx as f32 + 0.5) * sx - 0.5,
                            (qy as f32 + 0.5) * sy - 0.5,
                        );
                        let detail = [0, 1, 2].map(|c| o[c] as f32 / 255.0 - low[c]);
                        let shift = (qx - x as i32, qy - y as i32);
                        match groups[..group_count].iter_mut().find(|g| g.0 == shift) {
                            Some(g) => g.1 += wgt,
                            None => {
                                groups[group_count] = (shift, wgt, detail);
                                group_count += 1;
                            }
                        }
                    }
                    let norm = groups[..group_count]
                        .iter()
                        .map(|g| g.1 * g.1)
                        .sum::<f32>()
                        .sqrt();
                    if norm > 0.0 {
                        for (_, wgt, detail) in &groups[..group_count] {
                            for c in 0..3 {
                                value[c] += wgt * detail[c] / norm;
                            }
                        }
                    }
                }

                let alpha = m as f32 / 255.0;
                let px = &mut row[x * 4..x * 4 + 3];
                for c in 0..3 {
                    px[c] = (value[c].clamp(0.0, 1.0) * 255.0 * alpha
                        + px[c] as f32 * (1.0 - alpha))
                        .round() as u8;
                }
            }
        });

    Ok((final_crop, x0, y0))
}
