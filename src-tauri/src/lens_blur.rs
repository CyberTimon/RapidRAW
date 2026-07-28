use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use image::{DynamicImage, GenericImageView, Rgb32FImage};
use rayon::prelude::*;
use std::borrow::Cow;

#[derive(Clone, Copy)]
struct BokehTap {
    x: i32,
    y: i32,
    ux: f32,
    uy: f32,
    weight: f32,
}

pub fn apply_lens_blur<'a>(
    image: Cow<'a, DynamicImage>,
    adjustments: &serde_json::Value,
) -> Cow<'a, DynamicImage> {
    let effects_visible = adjustments
        .get("sectionVisibility")
        .and_then(|v| v.get("effects"))
        .and_then(|s| s.as_bool())
        .unwrap_or(true);

    if !adjustments["lensBlurEnabled"].as_bool().unwrap_or(false) || !effects_visible {
        return image;
    }

    let depth_b64 = adjustments["lensBlurDepthMap"].as_str().unwrap_or("");
    if depth_b64.is_empty() {
        return image;
    }

    let amount = adjustments["lensBlurAmount"].as_f64().unwrap_or(50.0) as f32;
    if amount <= 0.0 {
        return image;
    }

    let b64_data = match depth_b64.find(',') {
        Some(idx) => &depth_b64[idx + 1..],
        None => depth_b64,
    };
    let decoded = match BASE64.decode(b64_data) {
        Ok(b) => b,
        Err(_) => return image,
    };
    let depth_map = match image::load_from_memory(&decoded) {
        Ok(img) => img.into_luma8(),
        Err(_) => return image,
    };
    if depth_map.width() < 2 || depth_map.height() < 2 {
        return image;
    }

    let (w, h) = image.dimensions();
    if w < 8 || h < 8 {
        return image;
    }

    let max_radius = (amount / 100.0) * (w.max(h) as f32) * 0.012;
    if max_radius < 0.35 {
        return image;
    }

    let shape = adjustments["lensBlurShape"].as_str().unwrap_or("circle");
    let min_depth = adjustments["lensBlurMinDepth"].as_f64().unwrap_or(20.0) as f32 / 100.0;
    let max_depth = adjustments["lensBlurMaxDepth"].as_f64().unwrap_or(100.0) as f32 / 100.0;
    let min_fade = adjustments["lensBlurMinFade"].as_f64().unwrap_or(15.0) as f32 / 100.0;
    let max_fade = adjustments["lensBlurMaxFade"].as_f64().unwrap_or(15.0) as f32 / 100.0;
    let diffusion =
        (adjustments["lensBlurDiffusion"].as_f64().unwrap_or(0.0) as f32 / 100.0).clamp(0.0, 1.0);

    let start = std::time::Instant::now();
    let src = image.as_ref().to_rgb32f();

    let coc = build_coc_field(
        &src, &depth_map, min_depth, max_depth, min_fade, max_fade, max_radius,
    );

    let blurred_px = coc.par_iter().filter(|c| c.abs() > 0.4).count();
    if blurred_px * 400 < coc.len() && diffusion <= 0.0 {
        return image;
    }

    let out = render_depth_of_field(&src, &coc, max_radius, shape, diffusion);

    log::info!(
        "lens blur ({}x{}, r_max {:.1}px, diffusion {:.2}) took {:.2?}",
        w,
        h,
        max_radius,
        diffusion,
        start.elapsed()
    );

    Cow::Owned(DynamicImage::ImageRgb32F(out))
}

#[inline(always)]
fn dof_smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0).max(1e-6)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[inline(always)]
fn dof_soft_pow(x: f32) -> f32 {
    x * (0.8 + 0.2 * x)
}

#[inline(always)]
fn dof_med3(a: f32, b: f32, c: f32) -> f32 {
    a.min(b).max(a.max(b).min(c))
}

#[inline(always)]
fn dof_to_energy(v: f32) -> f32 {
    let x = v.max(0.0);
    let e = x * x;
    e - (e - 12.0).max(0.0) * 0.85
}

#[inline(always)]
fn depth_to_signed_coc(
    d: f32,
    min_depth: f32,
    max_depth: f32,
    min_fade: f32,
    max_fade: f32,
    max_radius: f32,
) -> f32 {
    let far = 1.0 - dof_smoothstep(min_depth - min_fade.max(1e-4), min_depth, d);
    let near = dof_smoothstep(max_depth, max_depth + max_fade.max(1e-4), d);
    (dof_soft_pow(far) - dof_soft_pow(near)) * max_radius
}

#[allow(clippy::too_many_arguments)]
fn build_coc_field(
    src: &Rgb32FImage,
    depth: &image::GrayImage,
    min_depth: f32,
    max_depth: f32,
    min_fade: f32,
    max_fade: f32,
    max_radius: f32,
) -> Vec<f32> {
    let w = src.width() as usize;
    let h = src.height() as usize;
    let raw = src.as_raw();

    let mut luma_full = vec![0.0f32; w * h];
    luma_full
        .par_chunks_exact_mut(w)
        .enumerate()
        .for_each(|(y, row)| {
            let base = y * w * 3;
            for (x, out) in row.iter_mut().enumerate() {
                let i = base + x * 3;
                *out = (0.2126 * raw[i] + 0.7152 * raw[i + 1] + 0.0722 * raw[i + 2])
                    .max(0.0)
                    .sqrt();
            }
        });
    dof_box_filter(&mut luma_full, w, h, 1, 2);

    let scale = (1024.0 / w.max(h) as f32).min(1.0);
    let gw = ((w as f32 * scale).round() as usize).clamp(4, w);
    let gh = ((h as f32 * scale).round() as usize).clamp(4, h);

    let x_ratio = w as f32 / gw as f32;
    let y_ratio = h as f32 / gh as f32;

    let mut guide = vec![0.0f32; gw * gh];
    guide
        .par_chunks_exact_mut(gw)
        .enumerate()
        .for_each(|(gy, row)| {
            let sy0 = (gy as f32 * y_ratio).floor() as usize;
            let sy1 = ((((gy + 1) as f32) * y_ratio).ceil() as usize)
                .min(h)
                .max(sy0 + 1);
            for (gx, out) in row.iter_mut().enumerate() {
                let sx0 = (gx as f32 * x_ratio).floor() as usize;
                let sx1 = ((((gx + 1) as f32) * x_ratio).ceil() as usize)
                    .min(w)
                    .max(sx0 + 1);
                let mut acc = 0.0f32;
                let mut cnt = 0.0f32;
                for sy in sy0..sy1 {
                    let row_off = sy * w;
                    for sx in sx0..sx1 {
                        acc += luma_full[row_off + sx];
                        cnt += 1.0;
                    }
                }
                *out = acc / cnt.max(1.0);
            }
        });

    let depth_small = dof_depth_to_f32(depth, gw, gh);
    let radius = ((gw.max(gh) as f32) * 0.015).round().max(2.0) as usize;
    let packed = build_guided_model(&guide, &depth_small, gw, gh, radius);

    let mut coc = vec![0.0f32; w * h];
    let gx_scale = gw as f32 / w as f32;
    let gy_scale = gh as f32 / h as f32;

    coc.par_chunks_exact_mut(w)
        .enumerate()
        .for_each(|(y, row)| {
            let fy = ((y as f32 + 0.5) * gy_scale - 0.5).clamp(0.0, (gh - 1) as f32);
            let gy0 = fy.floor() as usize;
            let gy1 = (gy0 + 1).min(gh - 1);
            let wy = fy - gy0 as f32;
            let r0 = gy0 * gw;
            let r1 = gy1 * gw;
            let lrow = y * w;

            for (x, out) in row.iter_mut().enumerate() {
                let fx = ((x as f32 + 0.5) * gx_scale - 0.5).clamp(0.0, (gw - 1) as f32);
                let gx0 = fx.floor() as usize;
                let gx1 = (gx0 + 1).min(gw - 1);
                let wx = fx - gx0 as f32;

                let i00 = (r0 + gx0) * 4;
                let i10 = (r0 + gx1) * 4;
                let i01 = (r1 + gx0) * 4;
                let i11 = (r1 + gx1) * 4;

                let mut m = [0.0f32; 4];
                for (c, mc) in m.iter_mut().enumerate() {
                    let top = packed[i00 + c] + (packed[i10 + c] - packed[i00 + c]) * wx;
                    let bot = packed[i01 + c] + (packed[i11 + c] - packed[i01 + c]) * wx;
                    *mc = top + (bot - top) * wy;
                }

                let luma = luma_full[lrow + x];
                let d = (m[0] * luma + m[1]).clamp(m[2], m[3]).clamp(0.0, 1.0);
                *out = depth_to_signed_coc(d, min_depth, max_depth, min_fade, max_fade, max_radius);
            }
        });

    dof_despeckle(&mut coc, w, h);
    coc
}

fn build_guided_model(guide: &[f32], p: &[f32], w: usize, h: usize, radius: usize) -> Vec<f32> {
    let n = w * h;
    let eps = 4.0e-3f32;

    let mut mean_i = guide.to_vec();
    dof_box_filter(&mut mean_i, w, h, 1, radius);
    let mut mean_p = p.to_vec();
    dof_box_filter(&mut mean_p, w, h, 1, radius);

    let mut corr_ii: Vec<f32> = guide.iter().map(|v| v * v).collect();
    dof_box_filter(&mut corr_ii, w, h, 1, radius);
    let mut corr_ip: Vec<f32> = guide.iter().zip(p.iter()).map(|(a, b)| a * b).collect();
    dof_box_filter(&mut corr_ip, w, h, 1, radius);
    let mut corr_pp: Vec<f32> = p.iter().map(|v| v * v).collect();
    dof_box_filter(&mut corr_pp, w, h, 1, radius);

    let mut gx = vec![0.0f32; n];
    let mut gy = vec![0.0f32; n];
    gx.par_chunks_exact_mut(w)
        .zip(gy.par_chunks_exact_mut(w))
        .enumerate()
        .for_each(|(y, (rx, ry))| {
            let yc = y * w;
            let yu = y.saturating_sub(1) * w;
            let yd = (y + 1).min(h - 1) * w;
            for x in 0..w {
                let xl = x.saturating_sub(1);
                let xr = (x + 1).min(w - 1);
                rx[x] = (guide[yc + xr] - guide[yc + xl]) * 0.5;
                ry[x] = (guide[yd + x] - guide[yu + x]) * 0.5;
            }
        });
    dof_box_filter(&mut gx, w, h, 1, radius);
    dof_box_filter(&mut gy, w, h, 1, radius);

    let span = (2 * radius + 1) as f32;
    let span2 = span * span;

    let mut a = vec![0.0f32; n];
    let mut b = vec![0.0f32; n];
    let mut lo = vec![0.0f32; n];
    let mut hi = vec![0.0f32; n];

    for i in 0..n {
        let var = (corr_ii[i] - mean_i[i] * mean_i[i]).max(0.0);
        let cov = corr_ip[i] - mean_i[i] * mean_p[i];

        let structure = (gx[i] * gx[i] + gy[i] * gy[i]) * span2;
        let conf = structure / (structure + 1.4 * var + 1.0e-5);

        a[i] = conf * cov / (var + eps);
        b[i] = mean_p[i] - a[i] * mean_i[i];

        let sd = (corr_pp[i] - mean_p[i] * mean_p[i]).max(0.0).sqrt();
        let band = 1.1 * sd + 0.004;
        lo[i] = mean_p[i] - band;
        hi[i] = mean_p[i] + band;
    }

    dof_box_filter(&mut a, w, h, 1, radius);
    dof_box_filter(&mut b, w, h, 1, radius);

    let mut packed = vec![0.0f32; n * 4];
    packed
        .par_chunks_exact_mut(4)
        .enumerate()
        .for_each(|(i, px)| {
            px[0] = a[i];
            px[1] = b[i];
            px[2] = lo[i];
            px[3] = hi[i];
        });
    packed
}

fn dof_despeckle(buf: &mut [f32], w: usize, h: usize) {
    if w < 3 || h < 3 {
        return;
    }

    let mut tmp = vec![0.0f32; w * h];
    tmp.par_chunks_exact_mut(w)
        .enumerate()
        .for_each(|(y, row)| {
            let base = y * w;
            row[0] = buf[base];
            for x in 1..w - 1 {
                row[x] = dof_med3(buf[base + x - 1], buf[base + x], buf[base + x + 1]);
            }
            row[w - 1] = buf[base + w - 1];
        });

    buf.par_chunks_exact_mut(w)
        .enumerate()
        .for_each(|(y, row)| {
            if y == 0 || y == h - 1 {
                row.copy_from_slice(&tmp[y * w..y * w + w]);
                return;
            }
            let up = (y - 1) * w;
            let cc = y * w;
            let dn = (y + 1) * w;
            for x in 0..w {
                row[x] = dof_med3(tmp[up + x], tmp[cc + x], tmp[dn + x]);
            }
        });
}

#[inline(always)]
fn dof_tent(c: f32, radii: &[f32; 5], k: usize) -> f32 {
    if c <= radii[k] {
        if k == 0 {
            1.0
        } else {
            ((c - radii[k - 1]) / (radii[k] - radii[k - 1]).max(1e-5)).clamp(0.0, 1.0)
        }
    } else if k == 4 {
        1.0
    } else {
        1.0 - ((c - radii[k]) / (radii[k + 1] - radii[k]).max(1e-5)).clamp(0.0, 1.0)
    }
}

fn render_depth_of_field(
    src: &Rgb32FImage,
    coc: &[f32],
    max_radius: f32,
    shape: &str,
    diffusion: f32,
) -> Rgb32FImage {
    let w = src.width() as usize;
    let h = src.height() as usize;
    let n = w * h;
    let raw = src.as_raw();

    let mut ds = (max_radius / 18.0).ceil().max(1.0) as usize;
    while ds < 6 {
        let rw = max_radius / ds as f32;
        let taps = (std::f32::consts::PI * rw * rw).min(128.0) as f64;
        if (n as f64 / (ds * ds) as f64) * taps <= 7.0e8 {
            break;
        }
        ds += 1;
    }
    let ww = (w / ds).max(4);
    let wh = (h / ds).max(4);

    let (base, coc_small) = dof_downsample_fused(raw, coc, w, h, ww, wh);

    let mut radii = [0.0f32; 5];
    for (k, r) in radii.iter_mut().enumerate() {
        *r = max_radius * (k as f32 / 4.0).powf(1.7);
    }

    let (far_rgb, far_a) = dof_composite_stack(
        &base, &coc_small, ww, wh, &radii, ds, shape, diffusion, false,
    );
    let (near_rgb, near_a) = dof_composite_stack(
        &base, &coc_small, ww, wh, &radii, ds, shape, diffusion, true,
    );

    let diffusion_on = diffusion > 1.0e-3;
    let bloom = if diffusion_on {
        let mut bl = vec![0.0f32; ww * wh * 4];
        bl.par_chunks_exact_mut(4).enumerate().for_each(|(i, px)| {
            px[0] = base[i * 3];
            px[1] = base[i * 3 + 1];
            px[2] = base[i * 3 + 2];
            px[3] = 1.0 - dof_tent(coc_small[i].abs(), &radii, 0);
        });
        let cap = (ww.min(wh) / 2).max(2);
        let br1 = (((max_radius / ds as f32) * 0.8).max(6.0) as usize).min(cap);
        let br2 = ((br1 * 2) / 3).max(3).min(cap);
        dof_box_filter(&mut bl, ww, wh, 4, br1);
        dof_box_filter(&mut bl, ww, wh, 4, br2);
        bl.par_chunks_exact_mut(4).for_each(|px| {
            px[0] = px[0].max(0.0).sqrt();
            px[1] = px[1].max(0.0).sqrt();
            px[2] = px[2].max(0.0).sqrt();
            px[3] = px[3].clamp(0.0, 1.0);
        });
        bl
    } else {
        Vec::new()
    };

    let mut far_lin = vec![0.0f32; ww * wh * 4];
    far_lin
        .par_chunks_exact_mut(4)
        .enumerate()
        .for_each(|(i, px)| {
            let a = far_a[i].clamp(0.0, 1.0);
            if a > 1.0e-4 {
                let inv_a = 1.0 / a;
                for c in 0..3 {
                    px[c] = (far_rgb[i * 3 + c] * inv_a).max(0.0).sqrt();
                }
            } else {
                for c in 0..3 {
                    px[c] = base[i * 3 + c].max(0.0).sqrt();
                }
            }
            px[3] = dof_tent(coc_small[i].abs(), &radii, 0);
        });

    let mut near_lin = vec![0.0f32; ww * wh * 4];
    near_lin
        .par_chunks_exact_mut(4)
        .enumerate()
        .for_each(|(i, px)| {
            let a = near_a[i].clamp(0.0, 1.0);
            if a > 1.0e-4 {
                let inv_a = 1.0 / a;
                for c in 0..3 {
                    px[c] = (near_rgb[i * 3 + c] * inv_a).max(0.0).sqrt() * a;
                }
            }
            px[3] = a;
        });

    let mut out = vec![0.0f32; n * 3];
    let sx = ww as f32 / w as f32;
    let sy = wh as f32 / h as f32;
    let veil = 0.75 * diffusion;

    out.par_chunks_exact_mut(w * 3)
        .enumerate()
        .for_each(|(y, row)| {
            let fy = ((y as f32 + 0.5) * sy - 0.5).clamp(0.0, (wh - 1) as f32);
            let y0 = fy.floor() as usize;
            let y1 = (y0 + 1).min(wh - 1);
            let wy = fy - y0 as f32;
            let r0 = y0 * ww;
            let r1 = y1 * ww;
            let coc_row = y * w;
            let src_row = coc_row * 3;

            for x in 0..w {
                let fx = ((x as f32 + 0.5) * sx - 0.5).clamp(0.0, (ww - 1) as f32);
                let x0 = fx.floor() as usize;
                let x1 = (x0 + 1).min(ww - 1);
                let wx = fx - x0 as f32;

                let i00 = (r0 + x0) * 4;
                let i10 = (r0 + x1) * 4;
                let i01 = (r1 + x0) * 4;
                let i11 = (r1 + x1) * 4;

                let mut fs = [0.0f32; 4];
                let mut ns = [0.0f32; 4];
                for c in 0..4 {
                    let ft = far_lin[i00 + c] + (far_lin[i10 + c] - far_lin[i00 + c]) * wx;
                    let fb = far_lin[i01 + c] + (far_lin[i11 + c] - far_lin[i01 + c]) * wx;
                    fs[c] = ft + (fb - ft) * wy;

                    let nt = near_lin[i00 + c] + (near_lin[i10 + c] - near_lin[i00 + c]) * wx;
                    let nb = near_lin[i01 + c] + (near_lin[i11 + c] - near_lin[i01 + c]) * wx;
                    ns[c] = nt + (nb - nt) * wy;
                }

                let fa = dof_tent(coc[coc_row + x].abs(), &radii, 0).min(fs[3]);
                let na = ns[3].clamp(0.0, 1.0);
                let inv_na = 1.0 - na;

                if diffusion_on {
                    let j00 = (r0 + x0) * 4;
                    let j10 = (r0 + x1) * 4;
                    let j01 = (r1 + x0) * 4;
                    let j11 = (r1 + x1) * 4;

                    let mut bv = [0.0f32; 3];
                    let mut b_mask = 0.0f32;

                    for c in 0..4 {
                        let bt = bloom[j00 + c] + (bloom[j10 + c] - bloom[j00 + c]) * wx;
                        let bb = bloom[j01 + c] + (bloom[j11 + c] - bloom[j01 + c]) * wx;
                        let val = bt + (bb - bt) * wy;
                        if c < 3 {
                            bv[c] = val;
                        } else {
                            b_mask = val;
                        }
                    }

                    let final_mask = dof_smoothstep(0.0, 1.0, b_mask.clamp(0.0, 1.0));

                    let local_veil = veil * final_mask;
                    let local_keep = 1.0 - (0.55 * diffusion * final_mask);

                    for c in 0..3 {
                        let sharp = raw[src_row + x * 3 + c];
                        let mid = sharp * fa + fs[c] * (1.0 - fa);
                        let base_px = ns[c] + mid * inv_na;

                        row[x * 3 + c] = (base_px * local_keep + bv[c] * local_veil).max(0.0);
                    }
                } else {
                    for c in 0..3 {
                        let sharp = raw[src_row + x * 3 + c];
                        let mid = sharp * fa + fs[c] * (1.0 - fa);
                        row[x * 3 + c] = (ns[c] + mid * inv_na).max(0.0);
                    }
                }
            }
        });

    Rgb32FImage::from_raw(w as u32, h as u32, out).expect("dof buffer size mismatch")
}

#[allow(clippy::too_many_arguments)]
fn dof_composite_stack(
    base: &[f32],
    coc: &[f32],
    ww: usize,
    wh: usize,
    radii: &[f32; 5],
    ds: usize,
    shape: &str,
    diffusion: f32,
    near_side: bool,
) -> (Vec<f32>, Vec<f32>) {
    let np = ww * wh;
    let mut acc_rgb = vec![0.0f32; np * 3];
    let mut acc_a = vec![0.0f32; np];

    let order: Vec<usize> = if near_side {
        (1..5).collect()
    } else {
        (1..5).rev().collect()
    };

    for k in order {
        let mut layer = vec![0.0f32; np * 4];
        let row_bounds: Vec<(usize, usize)> = layer
            .par_chunks_exact_mut(ww * 4)
            .enumerate()
            .map(|(y, row)| {
                let mut min_x = usize::MAX;
                let mut max_x = 0usize;
                for x in 0..ww {
                    let c = coc[y * ww + x];
                    if (near_side && c >= 0.0) || (!near_side && c <= 0.0) {
                        continue;
                    }
                    let wgt = dof_tent(c.abs(), radii, k);
                    if wgt <= 1.0e-4 {
                        continue;
                    }
                    let si = (y * ww + x) * 3;
                    let di = x * 4;
                    row[di] = base[si] * wgt;
                    row[di + 1] = base[si + 1] * wgt;
                    row[di + 2] = base[si + 2] * wgt;
                    row[di + 3] = wgt;
                    min_x = min_x.min(x);
                    max_x = max_x.max(x);
                }
                (min_x, max_x)
            })
            .collect();

        if row_bounds.iter().all(|&(mn, _)| mn == usize::MAX) {
            continue;
        }

        let r_work = (radii[k] / ds as f32) * (1.0 + 0.3 * diffusion);
        let (blurred, spans) = if r_work >= 0.6 {
            let (taps, ext) = build_bokeh_kernel(r_work, shape, diffusion);
            let spans = dof_dilate_spans(&row_bounds, ww, wh, ext);
            let b = blur_layer_bokeh(&layer, ww, wh, &taps, &spans, ext, r_work, diffusion);
            (b, spans)
        } else {
            let spans = dof_dilate_spans(&row_bounds, ww, wh, 0);
            (layer, spans)
        };

        acc_rgb
            .par_chunks_exact_mut(ww * 3)
            .zip(acc_a.par_chunks_exact_mut(ww))
            .enumerate()
            .for_each(|(y, (rgb_row, a_row))| {
                let (xs, xe) = spans[y];
                if xs == usize::MAX {
                    return;
                }
                for x in xs..=xe {
                    let si = (y * ww + x) * 4;
                    let sa = blurred[si + 3];
                    if sa <= 1.0e-5 {
                        continue;
                    }
                    let inv = 1.0 - sa.min(1.0);
                    for c in 0..3 {
                        rgb_row[x * 3 + c] = blurred[si + c] + rgb_row[x * 3 + c] * inv;
                    }
                    a_row[x] = (sa + a_row[x] * inv).min(1.0);
                }
            });
    }

    (acc_rgb, acc_a)
}

fn dof_dilate_spans(
    row_bounds: &[(usize, usize)],
    ww: usize,
    wh: usize,
    ext: usize,
) -> Vec<(usize, usize)> {
    let pad = ext + 1;
    let mut spans = vec![(usize::MAX, 0usize); wh];
    for (y, span) in spans.iter_mut().enumerate() {
        let y0 = y.saturating_sub(pad);
        let y1 = (y + pad).min(wh - 1);
        let mut mn = usize::MAX;
        let mut mx = 0usize;
        for &(a, b) in &row_bounds[y0..=y1] {
            if a == usize::MAX {
                continue;
            }
            mn = mn.min(a);
            mx = mx.max(b);
        }
        if mn != usize::MAX {
            *span = (mn.saturating_sub(pad), (mx + pad).min(ww - 1));
        }
    }
    spans
}

#[inline(always)]
fn dof_polygon_scale(theta: f32, blades: u32) -> f32 {
    let seg = std::f32::consts::TAU / blades as f32;
    let half = seg * 0.5;
    let a = theta.rem_euclid(seg) - half;
    half.cos() / a.cos().max(1e-4)
}

#[inline(always)]
fn dof_aperture_intensity(rr: f32, shape: &str, diffusion: f32) -> f32 {
    let crisp = if shape == "ring" {
        0.22 + 3.2 * dof_smoothstep(0.60, 0.93, rr)
    } else {
        1.0 + 0.12 * dof_smoothstep(0.55, 1.0, rr)
    };
    if diffusion <= 1.0e-3 {
        return crisp;
    }
    let soft = (-2.6 * rr * rr).exp() + 0.05;
    crisp * (1.0 - diffusion) + soft * diffusion
}

fn build_bokeh_kernel(radius: f32, shape: &str, diffusion: f32) -> (Vec<BokehTap>, usize) {
    let r = radius.max(0.6);
    let blades: u32 = match shape {
        "hexagon" => 6,
        "octagon" => 8,
        _ => 0,
    };

    let mut taps: Vec<BokehTap> = Vec::new();
    let mut sum = 0.0f32;

    if r <= 3.5 {
        let ri = r.ceil() as i32;
        for y in -ri..=ri {
            for x in -ri..=ri {
                let d = ((x * x + y * y) as f32).sqrt();
                let cov = (r + 0.5 - d).clamp(0.0, 1.0);
                if cov <= 0.0 {
                    continue;
                }
                let wgt = cov * dof_aperture_intensity((d / r).min(1.0), shape, diffusion);
                sum += wgt;
                taps.push(BokehTap {
                    x,
                    y,
                    ux: x as f32 / r,
                    uy: y as f32 / r,
                    weight: wgt,
                });
            }
        }
    } else {
        let area = std::f32::consts::PI * r * r;
        let n = (area.ceil() as usize).clamp(24, 128);
        let golden = 2.399_963_2f32;

        for i in 0..n {
            let t = (i as f32 + 0.5) / n as f32;
            let rr = t.sqrt();
            let ang = i as f32 * golden;
            let (s, c) = ang.sin_cos();
            let (mut ux, mut uy) = (rr * c, rr * s);

            let mut jw = 1.0f32;
            if blades > 0 {
                let poly = dof_polygon_scale(ang, blades);
                let shaped = 1.0 + (poly - 1.0) * (1.0 - diffusion * 0.6);
                ux *= shaped;
                uy *= shaped;
                jw = shaped * shaped;
            }

            let wgt = jw * dof_aperture_intensity(rr, shape, diffusion);
            sum += wgt;
            taps.push(BokehTap {
                x: (ux * r).round() as i32,
                y: (uy * r).round() as i32,
                ux,
                uy,
                weight: wgt,
            });
        }
    }

    if sum > 0.0 {
        let inv = 1.0 / sum;
        for t in taps.iter_mut() {
            t.weight *= inv;
        }
    }

    let ext = taps
        .iter()
        .map(|t| t.x.unsigned_abs().max(t.y.unsigned_abs()) as usize)
        .max()
        .unwrap_or(0);

    (taps, ext)
}

#[allow(clippy::too_many_arguments)]
fn blur_layer_bokeh(
    layer: &[f32],
    ww: usize,
    wh: usize,
    taps: &[BokehTap],
    spans: &[(usize, usize)],
    ext: usize,
    radius: f32,
    diffusion: f32,
) -> Vec<f32> {
    let mut out = vec![0.0f32; ww * wh * 4];
    let inv_ww = 1.0 / ww as f32;
    let inv_wh = 1.0 / wh as f32;
    let cat_eye = 0.38f32 * (1.0 - 0.7 * diffusion);
    let use_cat = cat_eye > 0.02;

    out.par_chunks_exact_mut(ww * 4)
        .enumerate()
        .for_each(|(y, row)| {
            let (xs, xe) = spans[y];
            if xs == usize::MAX {
                return;
            }
            let ny_img = (y as f32 + 0.5) * inv_wh * 2.0 - 1.0;
            let ccy = cat_eye * ny_img;
            let y_safe = y >= ext && y + ext < wh;

            for x in xs..=xe {
                let nx_img = (x as f32 + 0.5) * inv_ww * 2.0 - 1.0;
                let ccx = cat_eye * nx_img;

                let mut acc = [0.0f32; 4];
                let mut wsum = 0.0f32;

                if y_safe && x >= ext && x + ext < ww {
                    let center = (y * ww + x) as i32;
                    for t in taps {
                        let mut wgt = t.weight;
                        if use_cat {
                            let ox = t.ux - ccx;
                            let oy = t.uy - ccy;
                            let d2 = ox * ox + oy * oy;
                            if d2 >= 1.0 {
                                continue;
                            }
                            if d2 > 0.82 {
                                wgt *= 1.0 - (d2 - 0.82) / 0.18;
                            }
                        }

                        let si = ((center + t.y * ww as i32 + t.x) as usize) * 4;
                        unsafe {
                            acc[0] += layer.get_unchecked(si) * wgt;
                            acc[1] += layer.get_unchecked(si + 1) * wgt;
                            acc[2] += layer.get_unchecked(si + 2) * wgt;
                            acc[3] += layer.get_unchecked(si + 3) * wgt;
                        }
                        wsum += wgt;
                    }
                } else {
                    for t in taps {
                        let sx = x as i32 + t.x;
                        let sy = y as i32 + t.y;
                        if sx < 0 || sy < 0 || sx >= ww as i32 || sy >= wh as i32 {
                            continue;
                        }
                        let mut wgt = t.weight;
                        if use_cat {
                            let ox = t.ux - ccx;
                            let oy = t.uy - ccy;
                            let d2 = ox * ox + oy * oy;
                            if d2 >= 1.0 {
                                continue;
                            }
                            if d2 > 0.82 {
                                wgt *= 1.0 - (d2 - 0.82) / 0.18;
                            }
                        }

                        let si = (sy as usize * ww + sx as usize) * 4;
                        acc[0] += layer[si] * wgt;
                        acc[1] += layer[si + 1] * wgt;
                        acc[2] += layer[si + 2] * wgt;
                        acc[3] += layer[si + 3] * wgt;
                        wsum += wgt;
                    }
                }

                if wsum > 1.0e-8 {
                    let inv = 1.0 / wsum;
                    let di = x * 4;
                    row[di] = acc[0] * inv;
                    row[di + 1] = acc[1] * inv;
                    row[di + 2] = acc[2] * inv;
                    row[di + 3] = acc[3] * inv;
                }
            }
        });

    if radius > 7.0 {
        dof_box_filter(&mut out, ww, wh, 4, 1);
    }
    out
}

fn dof_box_filter(buf: &mut [f32], w: usize, h: usize, ch: usize, radius: usize) {
    if radius == 0 || w < 2 || h < 2 {
        return;
    }
    let r = radius as isize;
    let inv = 1.0 / (2 * radius + 1) as f32;
    let wi = w as isize;
    let hi = h as isize;
    let stride = w * ch;

    buf.par_chunks_exact_mut(stride).for_each(|row| {
        let src = row.to_vec();
        let mut sums = vec![0.0f32; ch];
        for i in -r..=r {
            let ix = i.clamp(0, wi - 1) as usize;
            for (c, s) in sums.iter_mut().enumerate() {
                *s += src[ix * ch + c];
            }
        }
        for x in 0..w {
            for (c, s) in sums.iter().enumerate() {
                row[x * ch + c] = *s * inv;
            }
            let add = ((x as isize + r + 1).clamp(0, wi - 1)) as usize;
            let sub = ((x as isize - r).clamp(0, wi - 1)) as usize;
            for (c, s) in sums.iter_mut().enumerate() {
                *s += src[add * ch + c] - src[sub * ch + c];
            }
        }
    });

    let src = buf.to_vec();
    let threads = rayon::current_num_threads().max(1);
    let block_rows = h.div_ceil(threads).max(1);

    buf.par_chunks_mut(block_rows * stride)
        .enumerate()
        .for_each(|(bi, block)| {
            let y_start = bi * block_rows;
            let rows_here = block.len() / stride;
            let mut sums = vec![0.0f32; stride];

            for i in -r..=r {
                let iy = (y_start as isize + i).clamp(0, hi - 1) as usize * stride;
                for (j, s) in sums.iter_mut().enumerate() {
                    *s += src[iy + j];
                }
            }

            for yy in 0..rows_here {
                let y = y_start + yy;
                let base = yy * stride;
                for (j, s) in sums.iter().enumerate() {
                    block[base + j] = *s * inv;
                }
                let add = ((y as isize + r + 1).clamp(0, hi - 1)) as usize * stride;
                let sub = ((y as isize - r).clamp(0, hi - 1)) as usize * stride;
                for (j, s) in sums.iter_mut().enumerate() {
                    *s += src[add + j] - src[sub + j];
                }
            }
        });
}

fn dof_downsample_fused(
    src: &[f32],
    coc: &[f32],
    sw: usize,
    sh: usize,
    dw: usize,
    dh: usize,
) -> (Vec<f32>, Vec<f32>) {
    let mut base = vec![0.0f32; dw * dh * 3];
    let mut coc_small = vec![0.0f32; dw * dh];
    let x_ratio = sw as f32 / dw as f32;
    let y_ratio = sh as f32 / dh as f32;

    base.par_chunks_exact_mut(dw * 3)
        .zip(coc_small.par_chunks_exact_mut(dw))
        .enumerate()
        .for_each(|(dy, (brow, crow))| {
            let sy0 = (dy as f32 * y_ratio).floor() as usize;
            let sy1 = ((((dy + 1) as f32) * y_ratio).ceil() as usize)
                .min(sh)
                .max(sy0 + 1);
            for dx in 0..dw {
                let sx0 = (dx as f32 * x_ratio).floor() as usize;
                let sx1 = ((((dx + 1) as f32) * x_ratio).ceil() as usize)
                    .min(sw)
                    .max(sx0 + 1);

                let mut r = 0.0f32;
                let mut g = 0.0f32;
                let mut b = 0.0f32;
                let mut cv = 0.0f32;
                let mut cnt = 0.0f32;

                for sy in sy0..sy1 {
                    let row = sy * sw;
                    for sx in sx0..sx1 {
                        let i = (row + sx) * 3;
                        r += dof_to_energy(src[i]);
                        g += dof_to_energy(src[i + 1]);
                        b += dof_to_energy(src[i + 2]);
                        cv += coc[row + sx];
                        cnt += 1.0;
                    }
                }

                let inv = 1.0 / cnt.max(1.0);
                brow[dx * 3] = r * inv;
                brow[dx * 3 + 1] = g * inv;
                brow[dx * 3 + 2] = b * inv;
                crow[dx] = cv * inv;
            }
        });

    (base, coc_small)
}

fn dof_depth_to_f32(depth: &image::GrayImage, dw: usize, dh: usize) -> Vec<f32> {
    let sw = depth.width() as usize;
    let sh = depth.height() as usize;
    let raw = depth.as_raw();
    let mut out = vec![0.0f32; dw * dh];

    out.par_chunks_exact_mut(dw)
        .enumerate()
        .for_each(|(y, row)| {
            let fy = (((y as f32 + 0.5) / dh as f32) * sh as f32 - 0.5).clamp(0.0, (sh - 1) as f32);
            let y0 = fy.floor() as usize;
            let y1 = (y0 + 1).min(sh - 1);
            let wy = fy - y0 as f32;

            for (x, out_px) in row.iter_mut().enumerate() {
                let fx =
                    (((x as f32 + 0.5) / dw as f32) * sw as f32 - 0.5).clamp(0.0, (sw - 1) as f32);
                let x0 = fx.floor() as usize;
                let x1 = (x0 + 1).min(sw - 1);
                let wx = fx - x0 as f32;

                let p00 = raw[y0 * sw + x0] as f32;
                let p10 = raw[y0 * sw + x1] as f32;
                let p01 = raw[y1 * sw + x0] as f32;
                let p11 = raw[y1 * sw + x1] as f32;
                let top = p00 + (p10 - p00) * wx;
                let bot = p01 + (p11 - p01) * wx;
                *out_px = (top + (bot - top) * wy) / 255.0;
            }
        });
    out
}
