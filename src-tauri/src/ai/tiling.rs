use crate::ai::models::gpu_inference;
use anyhow::Result;
use image::{DynamicImage, Rgb32FImage};
use ndarray::Array4;
use ort::session::Session;
use ort::value::Tensor;
use rayon::prelude::*;
use std::sync::Mutex;

#[derive(Clone, Copy)]
struct TileParams {
    cs: usize,
    margin: usize,
    overlap: usize,
}

const DENOISE_TILE: TileParams = TileParams {
    cs: 504,
    margin: 12,
    overlap: 64,
};

const UPSCALE_TILE: TileParams = TileParams {
    cs: 544,
    margin: 16,
    overlap: 16,
};

#[inline]
fn mirror_coord(c: i32, size: i32) -> i32 {
    if c < 0 {
        (-c).min(size - 1)
    } else if c >= size {
        (2 * size - 1 - c).max(0)
    } else {
        c
    }
}

fn extract_tile_mirror(img: &Rgb32FImage, x0: i32, y0: i32, cs: usize) -> Array4<f32> {
    let (w, h) = (img.width() as i32, img.height() as i32);
    let src = img.as_raw();
    let plane = cs * cs;
    let mut data = vec![0.0f32; 3 * plane];
    let (r, rest) = data.split_at_mut(plane);
    let (g, b) = rest.split_at_mut(plane);
    r.par_chunks_exact_mut(cs)
        .zip(g.par_chunks_exact_mut(cs))
        .zip(b.par_chunks_exact_mut(cs))
        .enumerate()
        .for_each(|(dy, ((r, g), b))| {
            let sy = mirror_coord(y0 + dy as i32, h) as usize;
            let row = &src[sy * w as usize * 3..(sy + 1) * w as usize * 3];
            for dx in 0..cs {
                let sx = mirror_coord(x0 + dx as i32, w) as usize * 3;
                r[dx] = row[sx];
                g[dx] = row[sx + 1];
                b[dx] = row[sx + 2];
            }
        });
    Array4::from_shape_vec((1, 3, cs, cs), data).expect("tile buffer matches its shape")
}

fn tile_origins(len: usize, params: TileParams) -> Vec<i32> {
    let valid = params.cs - 2 * params.margin;
    let step = (valid - params.overlap).max(1);
    let mut origins = Vec::new();
    let mut start = 0;
    loop {
        origins.push(start as i32 - params.margin as i32);
        if start + valid >= len {
            break;
        }
        start += step;
    }
    origins
}

fn tile_blend_weights(params: TileParams) -> Vec<f32> {
    let valid = params.cs - 2 * params.margin;
    let ramp = |d: usize| ((d as f32 + 0.5) / params.overlap.max(1) as f32).min(1.0);
    (0..valid)
        .map(|i| {
            let t = ramp(i).min(ramp(valid - 1 - i));
            t * t * (3.0 - 2.0 * t)
        })
        .collect()
}

fn run_tiled(
    img: &Rgb32FImage,
    session: &Mutex<Session>,
    params: TileParams,
    scale: u32,
    on_progress: &dyn Fn(f32),
) -> Result<Rgb32FImage> {
    let s = scale as usize;
    let (width, height) = (img.width() as usize, img.height() as usize);
    let (out_w, out_h) = (width * s, height * s);
    let valid = params.cs - 2 * params.margin;
    let weights = tile_blend_weights(TileParams {
        cs: params.cs * s,
        margin: params.margin * s,
        overlap: params.overlap * s,
    });
    let xs = tile_origins(width, params);
    let ys = tile_origins(height, params);
    let total = xs.len() * ys.len();

    let mut accumulator = vec![0.0f32; out_w * out_h * 3];
    let mut weight_sum = vec![0.0f32; out_w * out_h];
    let origins: Vec<(i32, i32)> = ys
        .iter()
        .flat_map(|&y| xs.iter().map(move |&x| (y, x)))
        .collect();

    std::thread::scope(|scope| -> Result<()> {
        let (sender, receiver) = std::sync::mpsc::sync_channel::<Result<Array4<f32>>>(1);
        let origins_ref = &origins;
        scope.spawn(move || {
            for &(y0, x0) in origins_ref {
                let tile = (|| -> Result<Array4<f32>> {
                    let crop = extract_tile_mirror(img, x0, y0, params.cs);
                    let t_input = Tensor::from_array(crop)?;
                    let mut sess = session.lock().unwrap();
                    let outputs = gpu_inference(sess.run(ort::inputs![t_input]))?;
                    outputs[0]
                        .try_extract_array::<f32>()?
                        .as_standard_layout()
                        .into_owned()
                        .into_dimensionality::<ndarray::Ix4>()
                        .map_err(|e| anyhow::anyhow!("Unexpected output shape: {}", e))
                })();
                let failed = tile.is_err();
                if sender.send(tile).is_err() || failed {
                    break;
                }
            }
        });

        for (i, (&(y0, x0), tile)) in origins.iter().zip(receiver).enumerate() {
            on_progress(i as f32 / total as f32);
            let tile = tile?;
            let (tile_h, tile_w) = (tile.dim().2, tile.dim().3);
            if tile_h < params.cs * s || tile_w < params.cs * s {
                return Err(anyhow::anyhow!(
                    "Unexpected output tile size {:?} for a {} px input",
                    tile.dim(),
                    params.cs
                ));
            }
            let data = tile
                .as_slice()
                .ok_or_else(|| anyhow::anyhow!("Output tile is not contiguous"))?;
            let plane = tile_h * tile_w;

            let (ox, oy, om) = (x0 * scale as i32, y0 * scale as i32, params.margin * s);
            let top = oy + om as i32;
            let first = top.max(0) as usize;
            let last = (top + (valid * s) as i32).clamp(0, out_h as i32) as usize;
            if first >= last {
                continue;
            }
            accumulator[first * out_w * 3..last * out_w * 3]
                .par_chunks_exact_mut(out_w * 3)
                .zip(weight_sum[first * out_w..last * out_w].par_chunks_exact_mut(out_w))
                .enumerate()
                .for_each(|(row, (acc, wsum))| {
                    let ty = (first + row) as i32 - top;
                    let ty = ty as usize;
                    let line = (om + ty) * tile_w + om;
                    for tx in 0..valid * s {
                        let gx = ox + (om + tx) as i32;
                        if gx < 0 || gx >= out_w as i32 {
                            continue;
                        }
                        let w = weights[ty] * weights[tx];
                        let gx = gx as usize;
                        for c in 0..3 {
                            let v = data[c * plane + line + tx].clamp(0.0, 1.0);
                            acc[gx * 3 + c] += v * w;
                        }
                        wsum[gx] += w;
                    }
                });
        }
        Ok(())
    })?;

    accumulator
        .par_chunks_exact_mut(3)
        .zip(weight_sum.par_iter())
        .for_each(|(px, &w)| {
            let inv = if w > 0.0 { 1.0 / w } else { 0.0 };
            for v in px {
                *v = (*v * inv).clamp(0.0, 1.0);
            }
        });
    Rgb32FImage::from_raw(out_w as u32, out_h as u32, accumulator)
        .ok_or_else(|| anyhow::anyhow!("Tiled output does not match its dimensions"))
}

pub fn run_ai_denoise(
    rgb_img: &Rgb32FImage,
    session: &Mutex<Session>,
    on_progress: &dyn Fn(f32),
) -> Result<DynamicImage> {
    let out = run_tiled(rgb_img, session, DENOISE_TILE, 1, on_progress)?;
    Ok(DynamicImage::ImageRgb32F(out))
}

pub fn run_ai_upscale(
    rgb_img: &Rgb32FImage,
    session: &Mutex<Session>,
    scale: u32,
    on_progress: &dyn Fn(f32),
) -> Result<Rgb32FImage> {
    run_tiled(rgb_img, session, UPSCALE_TILE, scale, on_progress)
}
