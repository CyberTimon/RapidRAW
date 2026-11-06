//! Native CUDA backend.
//!
//! This is intentionally feature-gated. The resident CUDA path currently
//! covers the preview chain: front pass, highlight boost, camera diffusion,
//! camera lens blur, halation, DIR couplers, grain, density curves, enlarger
//! diffusion, print/scan spectral reductions, glare, output gamut compression,
//! scanner lens blur, unsharp, and one readback.

use std::sync::Arc;

use cudarc::driver::{
    CudaContext, CudaFunction, CudaModule, CudaSlice, CudaStream, LaunchConfig, PushKernelArg,
};
use cudarc::nvrtc::compile_ptx;
use spektrafilm_math::image::ImageBuf;
use spektrafilm_math::precision::Scalar;

use crate::{ComputeBackend, FilmChainParams, FrontPass, Lut3D, cpu_backend};

#[cfg(not(feature = "precision-f64"))]
fn scalars_to_f32(v: &[Scalar]) -> std::borrow::Cow<'_, [f32]> {
    std::borrow::Cow::Borrowed(v)
}

#[cfg(feature = "precision-f64")]
fn scalars_to_f32(v: &[Scalar]) -> std::borrow::Cow<'_, [f32]> {
    std::borrow::Cow::Owned(v.iter().map(|&s| s as f32).collect())
}

#[cfg(not(feature = "precision-f64"))]
fn f32_to_scalars(v: Vec<f32>) -> Vec<Scalar> {
    v
}

#[cfg(feature = "precision-f64")]
fn f32_to_scalars(v: Vec<f32>) -> Vec<Scalar> {
    v.into_iter().map(|x| x as f64).collect()
}

fn sanitize_spectral_inputs(
    channel_density: &[[f64; 3]],
    base_density: &[f64],
    n_wl: usize,
) -> (Vec<f32>, Vec<f32>) {
    let mut cd = Vec::with_capacity(n_wl * 3);
    let mut bd = Vec::with_capacity(n_wl);
    for wl in 0..n_wl {
        let r = channel_density[wl][0];
        let g = channel_density[wl][1];
        let b = channel_density[wl][2];
        let base = if wl < base_density.len() {
            base_density[wl]
        } else {
            f64::NAN
        };
        let row_has_nan = r.is_nan() || g.is_nan() || b.is_nan() || base.is_nan();
        cd.push(if r.is_nan() { 0.0 } else { r as f32 });
        cd.push(if g.is_nan() { 0.0 } else { g as f32 });
        cd.push(if b.is_nan() { 0.0 } else { b as f32 });
        bd.push(if row_has_nan { 1000.0 } else { base as f32 });
    }
    (cd, bd)
}

fn matrix_f32(m: &[[f64; 3]; 3]) -> Vec<f32> {
    m.iter()
        .flat_map(|r| r.iter().map(|&v| v as f32))
        .collect()
}

fn flatten_curves_f32(v: &[[f64; 3]]) -> Vec<f32> {
    v.iter()
        .flat_map(|r| r.iter().map(|&v| if v.is_nan() { 0.0 } else { v as f32 }))
        .collect()
}

fn is_uniform_grid(xs: &[f64]) -> bool {
    if xs.len() < 3 {
        return true;
    }
    let step = xs[1] - xs[0];
    let tol = step.abs().max(1.0) * 1e-6;
    xs.windows(2)
        .all(|w| ((w[1] - w[0]) - step).abs() <= tol)
}

const MAX_BLUR_RADIUS: u32 = 256;

fn fir_blur_radius(sigma: f32) -> u32 {
    ((3.0_f32 * sigma).ceil() as u32).min(MAX_BLUR_RADIUS)
}

fn gaussian_kernel_f32(sigma: f32) -> (u32, Vec<f32>) {
    let sigma = sigma.max(0.01);
    let radius = fir_blur_radius(sigma);
    let r_i32 = radius as i32;
    let two_sigma_sq = 2.0_f64 * sigma as f64 * sigma as f64;
    let mut kernel = Vec::with_capacity((radius * 2 + 1) as usize);
    for k in 0..(radius * 2 + 1) {
        let x = (k as i32 - r_i32) as f64;
        kernel.push((-x * x / two_sigma_sq).exp());
    }
    let sum: f64 = kernel.iter().sum();
    (
        radius,
        kernel.into_iter().map(|v| (v / sum) as f32).collect(),
    )
}

fn launch_2d(width: u32, height: u32) -> LaunchConfig {
    LaunchConfig {
        grid_dim: (width.div_ceil(16), height.div_ceil(16), 1),
        block_dim: (16, 16, 1),
        shared_mem_bytes: 0,
    }
}

const CUDA_SRC: &str = r#"
__device__ __forceinline__ float exp10_fast(float x) {
    return exp2f(x * 3.32192809488736234787f);
}

__device__ __forceinline__ float srgb_encode_fast(float x) {
    x = fminf(fmaxf(x, 0.0f), 1.0f);
    return x <= 0.0031308f ? 12.92f * x : 1.055f * powf(x, 0.4166666666666667f) - 0.055f;
}

__device__ float mitchell(float t) {
    float at = fabsf(t);
    const float b = 1.0f / 3.0f;
    const float c = 1.0f / 3.0f;
    if (at < 1.0f) {
        float t2 = at * at;
        float t3 = t2 * at;
        return ((12.0f - 9.0f * b - 6.0f * c) * t3
            + (-18.0f + 12.0f * b + 6.0f * c) * t2
            + (6.0f - 2.0f * b)) / 6.0f;
    }
    if (at < 2.0f) {
        float t2 = at * at;
        float t3 = t2 * at;
        return ((-b - 6.0f * c) * t3
            + (6.0f * b + 30.0f * c) * t2
            + (-12.0f * b - 48.0f * c) * at
            + (8.0f * b + 24.0f * c)) / 6.0f;
    }
    return 0.0f;
}

__device__ unsigned int reflect_index(int i, int n) {
    int idx = i;
    if (idx < 0) idx = -idx;
    int period = 2 * (n - 1);
    if (period > 0) {
        idx = idx % period;
        if (idx >= n) idx = period - idx;
    } else {
        idx = 0;
    }
    if (idx < 0) idx = 0;
    if (idx > n - 1) idx = n - 1;
    return (unsigned int)idx;
}

__device__ void sample_lut_bicubic(
    const float* __restrict__ tc_lut,
    unsigned int lut_size,
    float lut_x,
    float lut_y,
    float* out_r,
    float* out_g,
    float* out_b
) {
    int size_i = (int)lut_size;
    float max_xy = (float)(size_i - 1);
    float xf = fminf(fmaxf(lut_x, 0.0f), max_xy);
    float yf = fminf(fmaxf(lut_y, 0.0f), max_xy);
    int xi = (int)floorf(xf);
    int yi = (int)floorf(yf);
    if (xi >= size_i - 1) xi = size_i - 2;
    if (yi >= size_i - 1) yi = size_i - 2;
    float fx = xf - (float)xi;
    float fy = yf - (float)yi;

    float wx[4] = { mitchell(fx + 1.0f), mitchell(fx), mitchell(fx - 1.0f), mitchell(fx - 2.0f) };
    float wy[4] = { mitchell(fy + 1.0f), mitchell(fy), mitchell(fy - 1.0f), mitchell(fy - 2.0f) };

    float sr = 0.0f, sg = 0.0f, sb = 0.0f, ws = 0.0f;
    for (int dy = 0; dy < 4; dy++) {
        unsigned int sy = reflect_index(yi + dy - 1, size_i);
        for (int dx = 0; dx < 4; dx++) {
            unsigned int sx = reflect_index(xi + dx - 1, size_i);
            float w = wx[dx] * wy[dy];
            ws += w;
            unsigned int base = (sy * lut_size + sx) * 3u;
            sr += w * tc_lut[base];
            sg += w * tc_lut[base + 1u];
            sb += w * tc_lut[base + 2u];
        }
    }
    if (ws != 0.0f) {
        sr /= ws;
        sg /= ws;
        sb /= ws;
    }
    *out_r = sr;
    *out_g = sg;
    *out_b = sb;
}

extern "C" __global__ void hanatos_front_kernel(
    const float* __restrict__ rgb_in,
    unsigned int n_pixels,
    unsigned int lut_size,
    const float* __restrict__ matrix,
    const float* __restrict__ tc_lut,
    float* __restrict__ raw_out
) {
    unsigned int gid = blockIdx.x * blockDim.x + threadIdx.x;
    if (gid >= n_pixels) return;
    unsigned int base = gid * 3u;
    float r = rgb_in[base];
    float g = rgb_in[base + 1u];
    float b = rgb_in[base + 2u];
    float x = matrix[0] * r + matrix[1] * g + matrix[2] * b;
    float y = matrix[3] * r + matrix[4] * g + matrix[5] * b;
    float z = matrix[6] * r + matrix[7] * g + matrix[8] * b;
    float brightness = x + y + z;
    if (brightness <= 1e-10f) {
        raw_out[base] = 0.0f;
        raw_out[base + 1u] = 0.0f;
        raw_out[base + 2u] = 0.0f;
        return;
    }
    float xc = x / brightness;
    float yc = y / brightness;
    float omx = fmaxf(1.0f - xc, 1e-10f);
    float tx = fminf(fmaxf((1.0f - xc) * (1.0f - xc), 0.0f), 1.0f);
    float ty = fminf(fmaxf(yc / omx, 0.0f), 1.0f);
    float scale = (float)(lut_size - 1u);
    float lr, lg, lb;
    sample_lut_bicubic(tc_lut, lut_size, ty * scale, tx * scale, &lr, &lg, &lb);
    raw_out[base] = lr * brightness;
    raw_out[base + 1u] = lg * brightness;
    raw_out[base + 2u] = lb * brightness;
}

extern "C" __global__ void mallett_front_kernel(
    const float* __restrict__ rgb_in,
    unsigned int n_pixels,
    const float* __restrict__ matrix,
    float* __restrict__ raw_out
) {
    unsigned int gid = blockIdx.x * blockDim.x + threadIdx.x;
    if (gid >= n_pixels) return;
    unsigned int base = gid * 3u;
    float r = rgb_in[base];
    float g = rgb_in[base + 1u];
    float b = rgb_in[base + 2u];
    raw_out[base] = matrix[0] * r + matrix[1] * g + matrix[2] * b;
    raw_out[base + 1u] = matrix[3] * r + matrix[4] * g + matrix[5] * b;
    raw_out[base + 2u] = matrix[6] * r + matrix[7] * g + matrix[8] * b;
}

extern "C" __global__ void log10_inplace_kernel(
    float* __restrict__ data,
    unsigned int n_pixels
) {
    unsigned int gid = blockIdx.x * blockDim.x + threadIdx.x;
    if (gid >= n_pixels) return;
    unsigned int base = gid * 3u;
    data[base] = log10f(fmaxf(data[base], 1e-10f));
    data[base + 1u] = log10f(fmaxf(data[base + 1u], 1e-10f));
    data[base + 2u] = log10f(fmaxf(data[base + 2u], 1e-10f));
}

extern "C" __global__ void max_reduce_kernel(
    const float* __restrict__ input,
    unsigned int n_values,
    float* __restrict__ output
) {
    __shared__ float sdata[256];
    unsigned int tid = threadIdx.x;
    unsigned int idx = blockIdx.x * blockDim.x + tid;
    float v = -3.402823466e+38F;
    if (idx < n_values) v = input[idx];
    sdata[tid] = v;
    __syncthreads();

    for (unsigned int stride = blockDim.x / 2u; stride > 0u; stride >>= 1u) {
        if (tid < stride) {
            sdata[tid] = fmaxf(sdata[tid], sdata[tid + stride]);
        }
        __syncthreads();
    }
    if (tid == 0u) output[blockIdx.x] = sdata[0];
}

extern "C" __global__ void highlight_boost_kernel(
    float* __restrict__ data,
    unsigned int n_values,
    const float* __restrict__ max_raw_ptr,
    float boost_ev,
    float boost_range,
    float protect_ev
) {
    unsigned int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n_values) return;
    const float midgray = 0.184f;
    float max_raw = max_raw_ptr[0];
    if (max_raw == 0.0f) {
        data[idx] = 0.0f;
        return;
    }
    float raw_x0 = fminf(fmaxf(midgray * exp2f(protect_ev), 0.0f), max_raw);
    if (raw_x0 == max_raw) return;
    float a = powf(28.0f, 1.0f - boost_range);
    float x0 = raw_x0 / max_raw;
    float span = 1.0f - x0;
    float denom = expf(a * span) - a * span - 1.0f;
    if (denom <= 0.0f) return;
    float k = (exp2f(boost_ev) - 1.0f) / denom;
    float inv_max_raw = 1.0f / max_raw;
    float boost_scale = k * max_raw;
    float xv = data[idx];
    if (xv > raw_x0) {
        float dx = (xv - raw_x0) * inv_max_raw;
        data[idx] = xv + boost_scale * (expf(a * dx) - a * dx - 1.0f);
    }
}

extern "C" __global__ void log_to_linear_scaled_kernel(
    float* __restrict__ data,
    unsigned int n_pixels,
    float scale
) {
    unsigned int gid = blockIdx.x * blockDim.x + threadIdx.x;
    if (gid >= n_pixels) return;
    unsigned int base = gid * 3u;
    data[base] = exp10_fast(data[base]) * scale;
    data[base + 1u] = exp10_fast(data[base + 1u]) * scale;
    data[base + 2u] = exp10_fast(data[base + 2u]) * scale;
}

extern "C" __global__ void linear_to_log10_outer_kernel(
    float* __restrict__ data,
    unsigned int n_pixels
) {
    unsigned int gid = blockIdx.x * blockDim.x + threadIdx.x;
    if (gid >= n_pixels) return;
    unsigned int base = gid * 3u;
    data[base] = log10f(fmaxf(data[base], 0.0f) + 1e-10f);
    data[base + 1u] = log10f(fmaxf(data[base + 1u], 0.0f) + 1e-10f);
    data[base + 2u] = log10f(fmaxf(data[base + 2u], 0.0f) + 1e-10f);
}

__device__ float interp_density_channel(
    float xq,
    float gamma_inv,
    unsigned int channel,
    unsigned int k,
    unsigned int uniform_grid,
    const float* __restrict__ log_exposure,
    const float* __restrict__ density_curves
) {
    if (k == 0u) return 0.0f;
    float xa0 = log_exposure[0] * gamma_inv;
    float xa_last = log_exposure[k - 1u] * gamma_inv;
    if (xq <= xa0) return density_curves[channel];
    if (xq >= xa_last) return density_curves[(k - 1u) * 3u + channel];
    if (uniform_grid != 0u) {
        float step = (xa_last - xa0) / (float)(k - 1u);
        float t = (xq - xa0) / step;
        unsigned int i = (unsigned int)floorf(t);
        float frac = t - (float)i;
        float y0 = density_curves[i * 3u + channel];
        float y1 = density_curves[(i + 1u) * 3u + channel];
        return y0 + frac * (y1 - y0);
    }
    unsigned int lo = 0u;
    unsigned int hi = k;
    while (lo + 1u < hi) {
        unsigned int mid = (lo + hi) / 2u;
        float xa_mid = log_exposure[mid] * gamma_inv;
        if (xa_mid <= xq) lo = mid; else hi = mid;
    }
    float xa_lo = log_exposure[lo] * gamma_inv;
    float xa_hi = log_exposure[lo + 1u] * gamma_inv;
    float dx = xa_hi - xa_lo;
    float frac = dx != 0.0f ? (xq - xa_lo) / dx : 0.0f;
    float y0 = density_curves[lo * 3u + channel];
    float y1 = density_curves[(lo + 1u) * 3u + channel];
    return y0 + frac * (y1 - y0);
}

extern "C" __global__ void density_curve_interp_kernel(
    const float* __restrict__ log_raw,
    unsigned int n_pixels,
    unsigned int k,
    unsigned int uniform_grid,
    float gamma_inv,
    const float* __restrict__ log_exposure,
    const float* __restrict__ density_curves,
    float* __restrict__ output
) {
    unsigned int gid = blockIdx.x * blockDim.x + threadIdx.x;
    if (gid >= n_pixels) return;
    unsigned int base = gid * 3u;
    output[base] = interp_density_channel(log_raw[base], gamma_inv, 0u, k, uniform_grid, log_exposure, density_curves);
    output[base + 1u] = interp_density_channel(log_raw[base + 1u], gamma_inv, 1u, k, uniform_grid, log_exposure, density_curves);
    output[base + 2u] = interp_density_channel(log_raw[base + 2u], gamma_inv, 2u, k, uniform_grid, log_exposure, density_curves);
}

extern "C" __global__ void scan_spectral_kernel(
    const float* __restrict__ density_cmy,
    unsigned int n_pixels,
    unsigned int n_wavelengths,
    float normalization,
    const float* __restrict__ xyz_to_rgb,
    float bw_m,
    float bw_q,
    unsigned int bw_enable,
    unsigned int skip_clamp,
    const float* __restrict__ channel_density,
    const float* __restrict__ base_density,
    const float* __restrict__ illuminant,
    const float* __restrict__ cmf_x,
    const float* __restrict__ cmf_y,
    const float* __restrict__ cmf_z,
    float* __restrict__ output_rgb
) {
    unsigned int gid = blockIdx.x * blockDim.x + threadIdx.x;
    if (gid >= n_pixels) return;

    unsigned int base = gid * 3u;
    float cmy_r = density_cmy[base];
    float cmy_g = density_cmy[base + 1u];
    float cmy_b = density_cmy[base + 2u];

    float xyz_x = 0.0f;
    float xyz_y = 0.0f;
    float xyz_z = 0.0f;

    for (unsigned int wl = 0u; wl < n_wavelengths; wl++) {
        unsigned int cd_base = wl * 3u;
        float d = cmy_r * channel_density[cd_base]
                + cmy_g * channel_density[cd_base + 1u]
                + cmy_b * channel_density[cd_base + 2u]
                + base_density[wl];
        float light = exp10_fast(-d) * illuminant[wl];
        xyz_x += light * cmf_x[wl];
        xyz_y += light * cmf_y[wl];
        xyz_z += light * cmf_z[wl];
    }

    xyz_x /= normalization;
    xyz_y /= normalization;
    xyz_z /= normalization;

    if (bw_enable != 0u) {
        float scale = fminf(fmaxf(bw_m * xyz_y + bw_q, 0.0f), 1.0f) / (xyz_y + 1e-10f);
        xyz_x *= scale;
        xyz_y *= scale;
        xyz_z *= scale;
    }

    output_rgb[base] =
        xyz_to_rgb[0] * xyz_x + xyz_to_rgb[1] * xyz_y + xyz_to_rgb[2] * xyz_z;
    output_rgb[base + 1u] =
        xyz_to_rgb[3] * xyz_x + xyz_to_rgb[4] * xyz_y + xyz_to_rgb[5] * xyz_z;
    output_rgb[base + 2u] =
        xyz_to_rgb[6] * xyz_x + xyz_to_rgb[7] * xyz_y + xyz_to_rgb[8] * xyz_z;

    if (skip_clamp == 0u) {
        output_rgb[base] = fminf(fmaxf(output_rgb[base], 0.0f), 1.0f);
        output_rgb[base + 1u] = fminf(fmaxf(output_rgb[base + 1u], 0.0f), 1.0f);
        output_rgb[base + 2u] = fminf(fmaxf(output_rgb[base + 2u], 0.0f), 1.0f);
    }
}

extern "C" __global__ void post_scan_kernel(
    float* __restrict__ rgb,
    unsigned int n_pixels,
    unsigned int output_cctf_encoding
) {
    unsigned int gid = blockIdx.x * blockDim.x + threadIdx.x;
    if (gid >= n_pixels) return;
    unsigned int base = gid * 3u;
    if (output_cctf_encoding != 0u) {
        rgb[base] = srgb_encode_fast(rgb[base]);
        rgb[base + 1u] = srgb_encode_fast(rgb[base + 1u]);
        rgb[base + 2u] = srgb_encode_fast(rgb[base + 2u]);
    } else {
        rgb[base] = fminf(fmaxf(rgb[base], 0.0f), 1.0f);
        rgb[base + 1u] = fminf(fmaxf(rgb[base + 1u], 0.0f), 1.0f);
        rgb[base + 2u] = fminf(fmaxf(rgb[base + 2u], 0.0f), 1.0f);
    }
}

extern "C" __global__ void print_spectral_kernel(
    const float* __restrict__ density_cmy,
    unsigned int n_pixels,
    unsigned int n_wavelengths,
    float normalization_factor,
    float preflash_r,
    float preflash_g,
    float preflash_b,
    const float* __restrict__ channel_density,
    const float* __restrict__ base_density,
    const float* __restrict__ illuminant,
    const float* __restrict__ sensitivity,
    float* __restrict__ output
) {
    unsigned int gid = blockIdx.x * blockDim.x + threadIdx.x;
    if (gid >= n_pixels) return;

    unsigned int base = gid * 3u;
    float cmy_r = density_cmy[base];
    float cmy_g = density_cmy[base + 1u];
    float cmy_b = density_cmy[base + 2u];

    float raw_r = 0.0f;
    float raw_g = 0.0f;
    float raw_b = 0.0f;

    for (unsigned int wl = 0u; wl < n_wavelengths; wl++) {
        unsigned int cd_base = wl * 3u;
        float d = cmy_r * channel_density[cd_base]
                + cmy_g * channel_density[cd_base + 1u]
                + cmy_b * channel_density[cd_base + 2u]
                + base_density[wl];
        float light = exp10_fast(-d) * illuminant[wl];
        raw_r += light * sensitivity[cd_base];
        raw_g += light * sensitivity[cd_base + 1u];
        raw_b += light * sensitivity[cd_base + 2u];
    }

    raw_r = raw_r * normalization_factor + preflash_r;
    raw_g = raw_g * normalization_factor + preflash_g;
    raw_b = raw_b * normalization_factor + preflash_b;

    output[base] = log10f(fmaxf(raw_r, 0.0f) + 1e-10f);
    output[base + 1u] = log10f(fmaxf(raw_g, 0.0f) + 1e-10f);
    output[base + 2u] = log10f(fmaxf(raw_b, 0.0f) + 1e-10f);
}

extern "C" __global__ void gaussian_blur_h_kernel(
    const float* __restrict__ input,
    unsigned int width,
    unsigned int height,
    unsigned int radius,
    const float* __restrict__ kernel,
    float* __restrict__ output
) {
    unsigned int x = blockIdx.x * blockDim.x + threadIdx.x;
    unsigned int y = blockIdx.y * blockDim.y + threadIdx.y;
    if (x >= width || y >= height) return;
    float sr = 0.0f, sg = 0.0f, sb = 0.0f;
    int w_i = (int)width;
    unsigned int ksize = radius * 2u + 1u;
    for (unsigned int k = 0u; k < ksize; k++) {
        int sx_i = (int)x + (int)k - (int)radius;
        if (sx_i < 0) sx_i = 0;
        if (sx_i >= w_i) sx_i = w_i - 1;
        unsigned int base = (y * width + (unsigned int)sx_i) * 3u;
        float kw = kernel[k];
        sr += kw * input[base];
        sg += kw * input[base + 1u];
        sb += kw * input[base + 2u];
    }
    unsigned int out = (y * width + x) * 3u;
    output[out] = sr;
    output[out + 1u] = sg;
    output[out + 2u] = sb;
}

extern "C" __global__ void gaussian_blur_v_kernel(
    const float* __restrict__ input,
    unsigned int width,
    unsigned int height,
    unsigned int radius,
    const float* __restrict__ kernel,
    float* __restrict__ output
) {
    unsigned int x = blockIdx.x * blockDim.x + threadIdx.x;
    unsigned int y = blockIdx.y * blockDim.y + threadIdx.y;
    if (x >= width || y >= height) return;
    float sr = 0.0f, sg = 0.0f, sb = 0.0f;
    int h_i = (int)height;
    unsigned int ksize = radius * 2u + 1u;
    for (unsigned int k = 0u; k < ksize; k++) {
        int sy_i = (int)y + (int)k - (int)radius;
        if (sy_i < 0) sy_i = 0;
        if (sy_i >= h_i) sy_i = h_i - 1;
        unsigned int base = ((unsigned int)sy_i * width + x) * 3u;
        float kw = kernel[k];
        sr += kw * input[base];
        sg += kw * input[base + 1u];
        sb += kw * input[base + 2u];
    }
    unsigned int out = (y * width + x) * 3u;
    output[out] = sr;
    output[out + 1u] = sg;
    output[out + 2u] = sb;
}

extern "C" __global__ void downsample_area_kernel(
    const float* __restrict__ input,
    unsigned int in_w,
    unsigned int in_h,
    unsigned int out_w,
    unsigned int out_h,
    unsigned int factor,
    float* __restrict__ output
) {
    unsigned int sx = blockIdx.x * blockDim.x + threadIdx.x;
    unsigned int sy = blockIdx.y * blockDim.y + threadIdx.y;
    if (sx >= out_w || sy >= out_h) return;
    unsigned int x0 = sx * factor;
    unsigned int y0 = sy * factor;
    unsigned int x1 = min(x0 + factor, in_w);
    unsigned int y1 = min(y0 + factor, in_h);
    float r = 0.0f, g = 0.0f, b = 0.0f, cnt = 0.0f;
    for (unsigned int yy = y0; yy < y1; yy++) {
        for (unsigned int xx = x0; xx < x1; xx++) {
            unsigned int i = (yy * in_w + xx) * 3u;
            r += input[i];
            g += input[i + 1u];
            b += input[i + 2u];
            cnt += 1.0f;
        }
    }
    float inv = 1.0f / fmaxf(cnt, 1.0f);
    unsigned int o = (sy * out_w + sx) * 3u;
    output[o] = r * inv;
    output[o + 1u] = g * inv;
    output[o + 2u] = b * inv;
}

extern "C" __global__ void upsample_bilinear_kernel(
    const float* __restrict__ input,
    unsigned int in_w,
    unsigned int in_h,
    unsigned int out_w,
    unsigned int out_h,
    float inv_factor,
    float* __restrict__ output
) {
    unsigned int x = blockIdx.x * blockDim.x + threadIdx.x;
    unsigned int y = blockIdx.y * blockDim.y + threadIdx.y;
    if (x >= out_w || y >= out_h) return;
    float max_x = (float)(in_w - 1u);
    float max_y = (float)(in_h - 1u);
    float fx = fminf(fmaxf(((float)x + 0.5f) * inv_factor - 0.5f, 0.0f), max_x);
    float fy = fminf(fmaxf(((float)y + 0.5f) * inv_factor - 0.5f, 0.0f), max_y);
    unsigned int x0 = (unsigned int)floorf(fx);
    unsigned int y0 = (unsigned int)floorf(fy);
    unsigned int x1 = min(x0 + 1u, in_w - 1u);
    unsigned int y1 = min(y0 + 1u, in_h - 1u);
    float wx = fx - floorf(fx);
    float wy = fy - floorf(fy);
    unsigned int o = (y * out_w + x) * 3u;
    for (unsigned int c = 0u; c < 3u; c++) {
        float top = input[(y0 * in_w + x0) * 3u + c] * (1.0f - wx)
                  + input[(y0 * in_w + x1) * 3u + c] * wx;
        float bot = input[(y1 * in_w + x0) * 3u + c] * (1.0f - wx)
                  + input[(y1 * in_w + x1) * 3u + c] * wx;
        output[o + c] = top * (1.0f - wy) + bot * wy;
    }
}

extern "C" __global__ void scatter_mix_kernel(
    const float* __restrict__ core,
    const float* __restrict__ tail,
    unsigned int n_pixels,
    float scatter_amount,
    float tail_r,
    float tail_g,
    float tail_b,
    float* __restrict__ result
) {
    unsigned int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n_pixels) return;
    unsigned int base = idx * 3u;
    float tw[3] = {tail_r, tail_g, tail_b};
    for (int c = 0; c < 3; c++) {
        float scattered = (1.0f - tw[c]) * core[base + c] + tw[c] * tail[base + c];
        result[base + c] = (1.0f - scatter_amount) * result[base + c] + scatter_amount * scattered;
    }
}

extern "C" __global__ void add_scaled_kernel(
    const float* __restrict__ src,
    unsigned int n_pixels,
    float scale,
    unsigned int clear_first,
    float* __restrict__ dst
) {
    unsigned int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n_pixels) return;
    unsigned int base = idx * 3u;
    if (clear_first != 0u) {
        dst[base] = scale * src[base];
        dst[base + 1u] = scale * src[base + 1u];
        dst[base + 2u] = scale * src[base + 2u];
    } else {
        dst[base] += scale * src[base];
        dst[base + 1u] += scale * src[base + 1u];
        dst[base + 2u] += scale * src[base + 2u];
    }
}

extern "C" __global__ void add_scaled_per_channel_kernel(
    const float* __restrict__ src,
    unsigned int n_pixels,
    float scale_r,
    float scale_g,
    float scale_b,
    float* __restrict__ dst
) {
    unsigned int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n_pixels) return;
    unsigned int base = idx * 3u;
    dst[base] += scale_r * src[base];
    dst[base + 1u] += scale_g * src[base + 1u];
    dst[base + 2u] += scale_b * src[base + 2u];
}

extern "C" __global__ void halation_renorm_kernel(
    unsigned int n_pixels,
    float inv_r,
    float inv_g,
    float inv_b,
    float* __restrict__ img
) {
    unsigned int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n_pixels) return;
    unsigned int base = idx * 3u;
    img[base] *= inv_r;
    img[base + 1u] *= inv_g;
    img[base + 2u] *= inv_b;
}

__device__ unsigned int pcg_hash(unsigned int state) {
    unsigned int s = state * 747796405u + 2891336453u;
    unsigned int word = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (word >> 22u) ^ word;
}

__device__ unsigned int splitmix32_hash(unsigned int x) {
    unsigned int z = x;
    z = (z ^ (z >> 16u)) * 0x85ebca6bu;
    z = (z ^ (z >> 13u)) * 0xc2b2ae35u;
    return z ^ (z >> 16u);
}

__device__ float unit_f32(unsigned int x) {
    return (float)x * (1.0f / 4294967296.0f);
}

__device__ unsigned int next_u32(unsigned int* state) {
    unsigned int s = pcg_hash(*state);
    *state = s;
    return s;
}

__device__ float standard_normal(unsigned int* state) {
    float u1 = unit_f32(next_u32(state));
    float u2 = unit_f32(next_u32(state));
    float r = sqrtf(-2.0f * logf(fmaxf(u1, 1e-7f)));
    return r * cosf(6.28318530717958647f * u2);
}

extern "C" __global__ void glare_gen_kernel(
    unsigned int n_pixels,
    unsigned int base_seed,
    float mu,
    float sigma,
    float* __restrict__ glare
) {
    unsigned int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n_pixels) return;
    unsigned int rng = splitmix32_hash(base_seed) ^ splitmix32_hash(idx);
    rng = pcg_hash(rng);
    float u1 = unit_f32(rng);
    rng = pcg_hash(rng);
    float u2 = unit_f32(rng);
    float z = sqrtf(-2.0f * logf(fmaxf(u1, 1e-7f))) * cosf(6.28318530717958647f * u2);
    float value = expf(mu + sigma * z) * 0.01f;
    unsigned int base = idx * 3u;
    glare[base] = value;
    glare[base + 1u] = value;
    glare[base + 2u] = value;
}

extern "C" __global__ void glare_apply_kernel(
    const float* __restrict__ glare,
    unsigned int n_pixels,
    float off_r,
    float off_g,
    float off_b,
    float* __restrict__ img
) {
    unsigned int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n_pixels) return;
    unsigned int base = idx * 3u;
    float g = glare[base];
    img[base] += g * off_r;
    img[base + 1u] += g * off_g;
    img[base + 2u] += g * off_b;
}

extern "C" __global__ void unsharp_combine_kernel(
    const float* __restrict__ original,
    const float* __restrict__ blurred,
    unsigned int n_pixels,
    float amount,
    float* __restrict__ output
) {
    unsigned int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n_pixels) return;
    unsigned int base = idx * 3u;
    float k1 = 1.0f + amount;
    output[base] = k1 * original[base] - amount * blurred[base];
    output[base + 1u] = k1 * original[base + 1u] - amount * blurred[base + 1u];
    output[base + 2u] = k1 * original[base + 2u] - amount * blurred[base + 2u];
}

extern "C" __global__ void grain_kernel(
    unsigned int n_pixels,
    unsigned int base_seed,
    unsigned int n_sub_layers,
    unsigned int monochrome,
    float dmin_r,
    float dmin_g,
    float dmin_b,
    float dmax_r,
    float dmax_g,
    float dmax_b,
    float npp_r,
    float npp_g,
    float npp_b,
    float gu_r,
    float gu_g,
    float gu_b,
    float* __restrict__ density
) {
    unsigned int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n_pixels) return;
    unsigned int base = idx * 3u;
    float dmin[3] = {dmin_r, dmin_g, dmin_b};
    float dmax[3] = {dmax_r, dmax_g, dmax_b};
    float npp[3] = {npp_r, npp_g, npp_b};
    float gu[3] = {gu_r, gu_g, gu_b};
    float n_sl_f = (float)n_sub_layers;
    for (unsigned int ch = 0u; ch < 3u; ch++) {
        float od_particle = dmax[ch] / npp[ch];
        float d_in = density[base + ch] + dmin[ch];
        float p = fminf(fmaxf(d_in / dmax[ch], 1e-6f), 1.0f - 1e-6f);
        float saturation = 1.0f - p * gu[ch] * (1.0f - 1e-6f);
        float lambda = npp[ch] / saturation;
        float sum = 0.0f;
        for (unsigned int sl = 0u; sl < n_sub_layers; sl++) {
            unsigned int seed_ch = monochrome != 0u ? 0u : ch;
            unsigned int layer_seed = seed_ch + sl * 10u + base_seed;
            unsigned int rng = splitmix32_hash(layer_seed) ^ splitmix32_hash(idx);
            float z1 = standard_normal(&rng);
            float n_seeds = fmaxf(0.0f, roundf(lambda + sqrtf(lambda) * z1));
            float mean = n_seeds * p;
            float variance = n_seeds * p * (1.0f - p);
            float developed = mean;
            if (variance > 0.0f) {
                developed = fminf(fmaxf(roundf(mean + sqrtf(variance) * standard_normal(&rng)), 0.0f), n_seeds);
            }
            sum += developed * od_particle * saturation;
        }
        density[base + ch] = sum / n_sl_f - dmin[ch];
    }
}

extern "C" __global__ void dir_matmul_kernel(
    const float* __restrict__ density,
    unsigned int n_pixels,
    unsigned int positive,
    float dmax_r,
    float dmax_g,
    float dmax_b,
    const float* __restrict__ matrix,
    float* __restrict__ correction
) {
    unsigned int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n_pixels) return;
    unsigned int base = idx * 3u;
    float s0 = density[base];
    float s1 = density[base + 1u];
    float s2 = density[base + 2u];
    if (positive != 0u) {
        s0 = dmax_r - s0;
        s1 = dmax_g - s1;
        s2 = dmax_b - s2;
    }
    correction[base] = s0 * matrix[0] + s1 * matrix[3] + s2 * matrix[6];
    correction[base + 1u] = s0 * matrix[1] + s1 * matrix[4] + s2 * matrix[7];
    correction[base + 2u] = s0 * matrix[2] + s1 * matrix[5] + s2 * matrix[8];
}

__device__ float clampf_g(float x, float lo, float hi) { return fminf(fmaxf(x, lo), hi); }
__device__ float dot3_g(float3 a, float3 b) { return a.x*b.x + a.y*b.y + a.z*b.z; }
__device__ float3 mv3_g(float3 r0, float3 r1, float3 r2, float3 v) {
    return make_float3(dot3_g(r0, v), dot3_g(r1, v), dot3_g(r2, v));
}
__device__ float sign_g(float x) { return (x > 0.0f) - (x < 0.0f); }
__device__ float cbrt_signed_g(float x) { return sign_g(x) * powf(fabsf(x), 1.0f / 3.0f); }
__device__ float len2_g(float x, float y) { return sqrtf(x*x + y*y); }
__device__ float radians_g(float d) { return d * 0.01745329251994329577f; }
__device__ float degrees_g(float r) { return r * 57.295779513082320876f; }

__device__ float reinhard_knee_g(float d, float threshold, float limit, float power) {
    if (d <= threshold) return d;
    float scale = limit - threshold;
    float x = (d - threshold) / scale;
    float y = x / powf(1.0f + powf(x, power), 1.0f / power);
    return threshold + scale * y;
}

__device__ float3 xyz_to_oklab_g(float3 xyz) {
    float3 lms = mv3_g(
        make_float3(0.8189330101f, 0.3618667424f, -0.1288597137f),
        make_float3(0.0329845436f, 0.9293118715f, 0.0361456387f),
        make_float3(0.0482003018f, 0.2643662691f, 0.633851707f),
        xyz);
    float3 lms_ = make_float3(cbrt_signed_g(lms.x), cbrt_signed_g(lms.y), cbrt_signed_g(lms.z));
    return mv3_g(
        make_float3(0.2104542553f, 0.793617785f, -0.0040720468f),
        make_float3(1.9779984951f, -2.428592205f, 0.4505937099f),
        make_float3(0.0259040371f, 0.7827717662f, -0.808675766f),
        lms_);
}

__device__ float3 oklab_to_xyz_g(float3 lab) {
    float3 lms_ = mv3_g(
        make_float3(1.0f, 0.3963377922f, 0.2158037581f),
        make_float3(1.0f, -0.1055613423f, -0.0638541748f),
        make_float3(1.0f, -0.0894841821f, -1.2914855379f),
        lab);
    float3 lms = make_float3(lms_.x*lms_.x*lms_.x, lms_.y*lms_.y*lms_.y, lms_.z*lms_.z*lms_.z);
    return mv3_g(
        make_float3(1.2270138511f, -0.5577999807f, 0.2812561490f),
        make_float3(-0.0405801784f, 1.1122568696f, -0.0716766787f),
        make_float3(-0.0763812845f, -0.4214819784f, 1.5861632204f),
        lms);
}

__device__ float oklab_l_to_lr_g(float l) {
    const float k1 = 0.206f;
    const float k2 = 0.03f;
    const float k3 = (1.0f + 0.206f) / (1.0f + 0.03f);
    float t = k3 * l - k1;
    return 0.5f * (t + sqrtf(t * t + 4.0f * k2 * k3 * l));
}

__device__ float atan2_deg_g(float y, float x) {
    if (y == 0.0f && x == 0.0f) return 0.0f;
    float d = degrees_g(atan2f(y, x));
    return d < 0.0f ? d + 360.0f : d;
}

__device__ float3 cam16_padc_forward_g(float3 rgb) {
    const float fl = 0.6839903846f;
    float3 flr = make_float3(
        powf(fl * fabsf(rgb.x) / 100.0f, 0.42f),
        powf(fl * fabsf(rgb.y) / 100.0f, 0.42f),
        powf(fl * fabsf(rgb.z) / 100.0f, 0.42f));
    return make_float3(
        400.0f * sign_g(rgb.x) * flr.x / (27.13f + flr.x) + 0.1f,
        400.0f * sign_g(rgb.y) * flr.y / (27.13f + flr.y) + 0.1f,
        400.0f * sign_g(rgb.z) * flr.z / (27.13f + flr.z) + 0.1f);
}

__device__ float3 cam16_padc_inverse_g(float3 rgb) {
    const float fl = 0.6839903846f;
    float3 d = make_float3(rgb.x - 0.1f, rgb.y - 0.1f, rgb.z - 0.1f);
    float bx = (27.13f * fabsf(d.x)) / (400.0f - fabsf(d.x));
    float by = (27.13f * fabsf(d.y)) / (400.0f - fabsf(d.y));
    float bz = (27.13f * fabsf(d.z)) / (400.0f - fabsf(d.z));
    return make_float3(
        sign_g(d.x) * 100.0f / fl * powf(bx, 1.0f / 0.42f),
        sign_g(d.y) * 100.0f / fl * powf(by, 1.0f / 0.42f),
        sign_g(d.z) * 100.0f / fl * powf(bz, 1.0f / 0.42f));
}

__device__ float3 xyz_to_cam16ucs_g(float3 xyz) {
    float3 rgb = mv3_g(
        make_float3(0.401288f, 0.650173f, -0.051461f),
        make_float3(-0.250268f, 1.204414f, 0.045854f),
        make_float3(-0.002079f, 0.048952f, 0.953127f),
        make_float3(xyz.x * 100.0f, xyz.y * 100.0f, xyz.z * 100.0f));
    float3 d_rgb = make_float3(rgb.x * 1.0228770275f, rgb.y * 0.9852074783f, rgb.z * 0.9285450587f);
    float3 p = cam16_padc_forward_g(d_rgb);
    float a = p.x - 12.0f * p.y / 11.0f + p.z / 11.0f;
    float b = (p.x + p.y - 2.0f * p.z) / 9.0f;
    float h = atan2_deg_g(b, a);
    float e_t = 0.25f * (cosf(2.0f + radians_g(h)) + 3.8f);
    float a_resp = (2.0f * p.x + p.y + p.z / 20.0f - 0.305f) * 1.0003040046f;
    float jj = 100.0f * powf(a_resp / 37.1690753022f, 0.69f * 1.9272135955f);
    float denom = p.x + p.y + 21.0f * p.z / 20.0f;
    float t = denom != 0.0f ? 3846.1538461538f * 1.0003040046f * (e_t * sqrtf(a*a + b*b)) / denom : 0.0f;
    float cc = powf(t, 0.9f) * sqrtf(jj / 100.0f) * powf(1.64f - powf(0.29f, 0.2f), 0.73f);
    float m = cc * powf(0.6839903846f, 0.25f);
    float jp = (1.0f + 100.0f * 0.007f) * jj / (1.0f + 0.007f * jj);
    float mp = (1.0f / 0.0228f) * logf(1.0f + 0.0228f * m);
    float hr = radians_g(h);
    return make_float3(jp, mp * cosf(hr), mp * sinf(hr));
}

__device__ float3 cam16ucs_to_xyz_g(float3 jab) {
    float jp = jab.x;
    float mp = len2_g(jab.y, jab.z);
    float h = atan2_deg_g(jab.z, jab.y);
    float jj = jp / ((1.0f + 100.0f * 0.007f) - 0.007f * jp);
    float m = (expf(0.0228f * mp) - 1.0f) / 0.0228f;
    float cc = m / powf(0.6839903846f, 0.25f);
    float j_prime = fmaxf(jj, 1.1920929e-7f);
    float t = powf(cc / (sqrtf(j_prime / 100.0f) * powf(1.64f - powf(0.29f, 0.2f), 0.73f)), 1.0f / 0.9f);
    float e_t = 0.25f * (cosf(2.0f + radians_g(h)) + 3.8f);
    float a_resp = 37.1690753022f * powf(jj / 100.0f, 1.0f / (0.69f * 1.9272135955f));
    float p1 = t != 0.0f ? 3846.1538461538f * 1.0003040046f * e_t / t : 0.0f;
    float p2 = a_resp / 1.0003040046f + 0.305f;
    float hr = radians_g(h);
    float sh = sinf(hr);
    float ch = cosf(hr);
    float nn = p2 * (2.0f + 21.0f / 20.0f) * (460.0f / 1403.0f);
    float a = 0.0f, b = 0.0f;
    if (fabsf(sh) >= fabsf(ch)) {
        float p4 = sh != 0.0f ? p1 / sh : 0.0f;
        b = nn / (p4 + (2.0f + 21.0f / 20.0f) * (220.0f / 1403.0f) * (ch / sh) - (27.0f / 1403.0f) + (21.0f / 20.0f) * (6300.0f / 1403.0f));
        a = b * (ch / sh);
    } else {
        float p5 = ch != 0.0f ? p1 / ch : 0.0f;
        a = nn / (p5 + (2.0f + 21.0f / 20.0f) * (220.0f / 1403.0f) - ((27.0f / 1403.0f) - (21.0f / 20.0f) * (6300.0f / 1403.0f)) * (sh / ch));
        b = a * (sh / ch);
    }
    if (t == 0.0f) { a = 0.0f; b = 0.0f; }
    float ra = (460.0f * p2 + 451.0f * a + 288.0f * b) / 1403.0f;
    float ga = (460.0f * p2 - 891.0f * a - 261.0f * b) / 1403.0f;
    float ba = (460.0f * p2 - 220.0f * a - 6300.0f * b) / 1403.0f;
    float3 inv = cam16_padc_inverse_g(make_float3(ra, ga, ba));
    float3 rgb = make_float3(inv.x / 1.0228770275f, inv.y / 0.9852074783f, inv.z / 0.9285450587f);
    return make_float3(
        dot3_g(make_float3(1.8620678551f, -1.0112546305f, 0.1491867754f), rgb) / 100.0f,
        dot3_g(make_float3(0.3875265432f, 0.6214474419f, -0.0089739852f), rgb) / 100.0f,
        dot3_g(make_float3(-0.0158414988f, -0.0341229380f, 1.0499644369f), rgb) / 100.0f);
}

__device__ float cmax_lookup_g(float l_in, float h, const float* cmax, unsigned int n_l_u, unsigned int n_h_u, float l_min, float l_max) {
    int n_l = (int)n_l_u;
    int n_h = (int)n_h_u;
    float l = clampf_g(l_in, l_min, l_max);
    float h_step = 6.28318530717958647f / (float)n_h;
    float h_idx = (h + 3.141592653589793f) / h_step;
    float h_floor = floorf(h_idx);
    int h_lo = ((int)h_floor % n_h + n_h) % n_h;
    int h_hi = (h_lo + 1) % n_h;
    float h_frac = h_idx - h_floor;
    float l_idx = (l - l_min) / (l_max - l_min) * (float)(n_l - 1);
    int l_lo = min(max((int)floorf(l_idx), 0), n_l - 2);
    int l_hi = l_lo + 1;
    float l_frac = l_idx - (float)l_lo;
    float v00 = cmax[l_lo * n_h + h_lo];
    float v01 = cmax[l_lo * n_h + h_hi];
    float v10 = cmax[l_hi * n_h + h_lo];
    float v11 = cmax[l_hi * n_h + h_hi];
    return v00 * (1.0f - l_frac) * (1.0f - h_frac)
        + v01 * (1.0f - l_frac) * h_frac
        + v10 * l_frac * (1.0f - h_frac)
        + v11 * l_frac * h_frac;
}

extern "C" __global__ void gamut_compress_kernel(
    float* __restrict__ img,
    unsigned int n_pixels,
    unsigned int mode,
    unsigned int n_l,
    unsigned int n_h,
    float knee_t,
    float knee_l,
    float knee_p,
    float light_t,
    float light_l,
    float light_p,
    unsigned int light_enable,
    float l_white,
    float l_min,
    float l_max,
    const float* __restrict__ cmax
) {
    unsigned int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n_pixels) return;
    unsigned int base = idx * 3u;
    float3 rgb = make_float3(img[base], img[base + 1u], img[base + 2u]);
    float3 out;
    if (mode == 0u) {
        float ach = fmaxf(rgb.x, fmaxf(rgb.y, rgb.z));
        if (ach <= 1e-12f) {
            out = rgb;
        } else {
            float3 d = make_float3((ach - rgb.x) / ach, (ach - rgb.y) / ach, (ach - rgb.z) / ach);
            float3 dc = make_float3(
                reinhard_knee_g(d.x, knee_t, knee_l, knee_p),
                reinhard_knee_g(d.y, knee_t, knee_l, knee_p),
                reinhard_knee_g(d.z, knee_t, knee_l, knee_p));
            out = make_float3(ach * (1.0f - dc.x), ach * (1.0f - dc.y), ach * (1.0f - dc.z));
        }
    } else {
        float3 xyz = mv3_g(
            make_float3(0.4124f, 0.3576f, 0.1805f),
            make_float3(0.2126f, 0.7152f, 0.0722f),
            make_float3(0.0193f, 0.1192f, 0.9505f),
            rgb);
        float3 lab = mode == 3u ? xyz_to_cam16ucs_g(xyz) : xyz_to_oklab_g(xyz);
        float l = lab.x;
        if (light_enable != 0u) {
            l = reinhard_knee_g(l / l_white, light_t, light_l, light_p) * l_white;
        }
        float c = len2_g(lab.y, lab.z);
        float h = c > 0.0f ? atan2f(lab.z, lab.y) : 0.0f;
        float lookup_l = mode == 2u ? oklab_l_to_lr_g(l) : l;
        float safe = fmaxf(cmax_lookup_g(lookup_l, h, cmax, n_l, n_h, l_min, l_max), 1e-9f);
        float d_comp = reinhard_knee_g(c / safe, knee_t, knee_l, knee_p);
        float c_new = d_comp * safe;
        float3 lab_new = make_float3(l, c_new * cosf(h), c_new * sinf(h));
        float3 xyz_new = mode == 3u ? cam16ucs_to_xyz_g(lab_new) : oklab_to_xyz_g(lab_new);
        out = mv3_g(
            make_float3(3.2406f, -1.5372f, -0.4986f),
            make_float3(-0.9689f, 1.8758f, 0.0415f),
            make_float3(0.0557f, -0.204f, 1.057f),
            xyz_new);
    }
    img[base] = out.x;
    img[base + 1u] = out.y;
    img[base + 2u] = out.z;
}

"#;

pub struct CudaBackend {
    stream: Arc<CudaStream>,
    _module: Arc<CudaModule>,
    hanatos_kernel: CudaFunction,
    mallett_kernel: CudaFunction,
    log10_kernel: CudaFunction,
    max_reduce_kernel: CudaFunction,
    highlight_boost_kernel: CudaFunction,
    log_to_linear_scaled_kernel: CudaFunction,
    linear_to_log10_outer_kernel: CudaFunction,
    density_kernel: CudaFunction,
    scan_kernel: CudaFunction,
    print_kernel: CudaFunction,
    blur_h_kernel: CudaFunction,
    blur_v_kernel: CudaFunction,
    downsample_kernel: CudaFunction,
    upsample_kernel: CudaFunction,
    scatter_mix_kernel: CudaFunction,
    add_scaled_kernel: CudaFunction,
    add_scaled_pc_kernel: CudaFunction,
    halation_renorm_kernel: CudaFunction,
    glare_gen_kernel: CudaFunction,
    glare_apply_kernel: CudaFunction,
    unsharp_kernel: CudaFunction,
    grain_kernel: CudaFunction,
    dir_matmul_kernel: CudaFunction,
    gamut_kernel: CudaFunction,
    post_scan_kernel: CudaFunction,
    device_name: String,
}

impl CudaBackend {
    pub fn new() -> Option<Self> {
        let ordinal = std::env::var("SPEKTRAFILM_CUDA_DEVICE")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(0);

        let ctx = CudaContext::new(ordinal).ok()?;
        let stream = ctx.default_stream();
        let ptx = compile_ptx(CUDA_SRC).ok()?;
        let module = ctx.load_module(ptx).ok()?;
        let hanatos_kernel = module.load_function("hanatos_front_kernel").ok()?;
        let mallett_kernel = module.load_function("mallett_front_kernel").ok()?;
        let log10_kernel = module.load_function("log10_inplace_kernel").ok()?;
        let max_reduce_kernel = module.load_function("max_reduce_kernel").ok()?;
        let highlight_boost_kernel = module.load_function("highlight_boost_kernel").ok()?;
        let log_to_linear_scaled_kernel =
            module.load_function("log_to_linear_scaled_kernel").ok()?;
        let linear_to_log10_outer_kernel =
            module.load_function("linear_to_log10_outer_kernel").ok()?;
        let density_kernel = module.load_function("density_curve_interp_kernel").ok()?;
        let scan_kernel = module.load_function("scan_spectral_kernel").ok()?;
        let print_kernel = module.load_function("print_spectral_kernel").ok()?;
        let blur_h_kernel = module.load_function("gaussian_blur_h_kernel").ok()?;
        let blur_v_kernel = module.load_function("gaussian_blur_v_kernel").ok()?;
        let downsample_kernel = module.load_function("downsample_area_kernel").ok()?;
        let upsample_kernel = module.load_function("upsample_bilinear_kernel").ok()?;
        let scatter_mix_kernel = module.load_function("scatter_mix_kernel").ok()?;
        let add_scaled_kernel = module.load_function("add_scaled_kernel").ok()?;
        let add_scaled_pc_kernel = module.load_function("add_scaled_per_channel_kernel").ok()?;
        let halation_renorm_kernel = module.load_function("halation_renorm_kernel").ok()?;
        let glare_gen_kernel = module.load_function("glare_gen_kernel").ok()?;
        let glare_apply_kernel = module.load_function("glare_apply_kernel").ok()?;
        let unsharp_kernel = module.load_function("unsharp_combine_kernel").ok()?;
        let grain_kernel = module.load_function("grain_kernel").ok()?;
        let dir_matmul_kernel = module.load_function("dir_matmul_kernel").ok()?;
        let gamut_kernel = module.load_function("gamut_compress_kernel").ok()?;
        let post_scan_kernel = module.load_function("post_scan_kernel").ok()?;
        let device_name = ctx
            .name()
            .map(|name| format!("CUDA ({name})"))
            .unwrap_or_else(|_| format!("CUDA (device {ordinal})"));

        Some(Self {
            stream,
            _module: module,
            hanatos_kernel,
            mallett_kernel,
            log10_kernel,
            max_reduce_kernel,
            highlight_boost_kernel,
            log_to_linear_scaled_kernel,
            linear_to_log10_outer_kernel,
            density_kernel,
            scan_kernel,
            print_kernel,
            blur_h_kernel,
            blur_v_kernel,
            downsample_kernel,
            upsample_kernel,
            scatter_mix_kernel,
            add_scaled_kernel,
            add_scaled_pc_kernel,
            halation_renorm_kernel,
            glare_gen_kernel,
            glare_apply_kernel,
            unsharp_kernel,
            grain_kernel,
            dir_matmul_kernel,
            gamut_kernel,
            post_scan_kernel,
            device_name,
        })
    }

    fn alloc_f32(
        &self,
        len: usize,
    ) -> Result<CudaSlice<f32>, Box<dyn std::error::Error + Send + Sync>> {
        // The caller must only use this for buffers fully overwritten before
        // read. This avoids a full-device memset for large scratch images.
        Ok(unsafe { self.stream.alloc::<f32>(len)? })
    }

    fn blur_device(
        &self,
        src: &CudaSlice<f32>,
        mid: &mut CudaSlice<f32>,
        dst: &mut CudaSlice<f32>,
        width: u32,
        height: u32,
        sigma: f32,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let (radius, kernel) = gaussian_kernel_f32(sigma);
        let kernel_dev = self.stream.clone_htod(&kernel)?;
        {
            let mut launch = self.stream.launch_builder(&self.blur_h_kernel);
            launch
                .arg(src)
                .arg(&width)
                .arg(&height)
                .arg(&radius)
                .arg(&kernel_dev)
                .arg(&mut *mid);
            unsafe { launch.launch(launch_2d(width, height)) }?;
        }
        {
            let mut launch = self.stream.launch_builder(&self.blur_v_kernel);
            launch
                .arg(mid)
                .arg(&width)
                .arg(&height)
                .arg(&radius)
                .arg(&kernel_dev)
                .arg(dst);
            unsafe { launch.launch(launch_2d(width, height)) }?;
        }
        Ok(())
    }

    fn add_scaled(
        &self,
        src: &CudaSlice<f32>,
        n_pixels: u32,
        scale: f32,
        clear_first: bool,
        dst: &mut CudaSlice<f32>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let clear = if clear_first { 1u32 } else { 0u32 };
        let mut launch = self.stream.launch_builder(&self.add_scaled_kernel);
        launch
            .arg(src)
            .arg(&n_pixels)
            .arg(&scale)
            .arg(&clear)
            .arg(dst);
        unsafe { launch.launch(LaunchConfig::for_num_elems(n_pixels)) }?;
        Ok(())
    }

    fn add_scaled_per_channel(
        &self,
        src: &CudaSlice<f32>,
        n_pixels: u32,
        scale: [f32; 3],
        dst: &mut CudaSlice<f32>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut launch = self.stream.launch_builder(&self.add_scaled_pc_kernel);
        launch
            .arg(src)
            .arg(&n_pixels)
            .arg(&scale[0])
            .arg(&scale[1])
            .arg(&scale[2])
            .arg(dst);
        unsafe { launch.launch(LaunchConfig::for_num_elems(n_pixels)) }?;
        Ok(())
    }

    fn launch_max_reduce(
        &self,
        src: &CudaSlice<f32>,
        n_values: u32,
        dst: &mut CudaSlice<f32>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let blocks = n_values.div_ceil(256);
        let mut launch = self.stream.launch_builder(&self.max_reduce_kernel);
        launch.arg(src).arg(&n_values).arg(dst);
        unsafe {
            launch.launch(LaunchConfig {
                grid_dim: (blocks, 1, 1),
                block_dim: (256, 1, 1),
                shared_mem_bytes: 0,
            })
        }?;
        Ok(())
    }

    fn reduce_max_device(
        &self,
        src: &CudaSlice<f32>,
        n_values: u32,
    ) -> Result<CudaSlice<f32>, Box<dyn std::error::Error + Send + Sync>> {
        let mut blocks = n_values.div_ceil(256).max(1);
        let mut current = self.alloc_f32(blocks as usize)?;
        self.launch_max_reduce(src, n_values, &mut current)?;
        while blocks > 1 {
            let next_blocks = blocks.div_ceil(256).max(1);
            let mut next = self.alloc_f32(next_blocks as usize)?;
            self.launch_max_reduce(&current, blocks, &mut next)?;
            current = next;
            blocks = next_blocks;
        }
        Ok(current)
    }

    fn run_highlight_boost_device(
        &self,
        img: &mut CudaSlice<f32>,
        n_pixels: u32,
        hp: &crate::HighlightBoostGpuParams,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let n_values = n_pixels * 3;
        let max_raw = self.reduce_max_device(img, n_values)?;
        let mut launch = self.stream.launch_builder(&self.highlight_boost_kernel);
        launch
            .arg(img)
            .arg(&n_values)
            .arg(&max_raw)
            .arg(&hp.boost_ev)
            .arg(&hp.boost_range)
            .arg(&hp.protect_ev);
        unsafe { launch.launch(LaunchConfig::for_num_elems(n_values)) }?;
        Ok(())
    }

    fn log_to_linear_scaled_device(
        &self,
        img: &mut CudaSlice<f32>,
        n_pixels: u32,
        scale: f32,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut launch = self.stream.launch_builder(&self.log_to_linear_scaled_kernel);
        launch.arg(img).arg(&n_pixels).arg(&scale);
        unsafe { launch.launch(LaunchConfig::for_num_elems(n_pixels)) }?;
        Ok(())
    }

    fn linear_to_log10_outer_device(
        &self,
        img: &mut CudaSlice<f32>,
        n_pixels: u32,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut launch = self.stream.launch_builder(&self.linear_to_log10_outer_kernel);
        launch.arg(img).arg(&n_pixels);
        unsafe { launch.launch(LaunchConfig::for_num_elems(n_pixels)) }?;
        Ok(())
    }

    fn run_diffusion_device(
        &self,
        img: &mut CudaSlice<f32>,
        width: u32,
        height: u32,
        plan: &crate::DiffusionGpuPlan,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let n_full = width * height;
        let n_small = plan.small_w * plan.small_h;
        let mut small_in = self.alloc_f32(n_small as usize * 3)?;
        let mut small_mid = self.alloc_f32(n_small as usize * 3)?;
        let mut small_out = self.alloc_f32(n_small as usize * 3)?;
        let mut small_acc = self.stream.alloc_zeros::<f32>(n_small as usize * 3)?;
        let mut upsampled = self.alloc_f32(n_full as usize * 3)?;

        {
            let mut launch = self.stream.launch_builder(&self.downsample_kernel);
            launch
                .arg(&mut *img)
                .arg(&width)
                .arg(&height)
                .arg(&plan.small_w)
                .arg(&plan.small_h)
                .arg(&plan.d)
                .arg(&mut small_in);
            unsafe { launch.launch(launch_2d(plan.small_w, plan.small_h)) }?;
        }

        for (&sigma, &coeff) in plan.sigmas.iter().zip(plan.coeffs.iter()) {
            self.blur_device(
                &small_in,
                &mut small_mid,
                &mut small_out,
                plan.small_w,
                plan.small_h,
                sigma,
            )?;
            self.add_scaled_per_channel(&small_out, n_small, coeff, &mut small_acc)?;
        }

        {
            let inv_factor = 1.0f32 / plan.d as f32;
            let mut launch = self.stream.launch_builder(&self.upsample_kernel);
            launch
                .arg(&small_acc)
                .arg(&plan.small_w)
                .arg(&plan.small_h)
                .arg(&width)
                .arg(&height)
                .arg(&inv_factor)
                .arg(&mut upsampled);
            unsafe { launch.launch(launch_2d(width, height)) }?;
        }

        let mut mixed = self.alloc_f32(n_full as usize * 3)?;
        self.add_scaled(img, n_full, 1.0 - plan.p_s, true, &mut mixed)?;
        self.add_scaled(&upsampled, n_full, plan.p_s, false, &mut mixed)?;
        std::mem::swap(img, &mut mixed);
        Ok(())
    }

    fn run_halation_device(
        &self,
        img: &mut CudaSlice<f32>,
        scratch: &mut CudaSlice<f32>,
        width: u32,
        height: u32,
        hp: &crate::HalationGpuParams,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let n_pixels = width * height;
        let mut core = self.alloc_f32(n_pixels as usize * 3)?;
        let mut tail = self.alloc_f32(n_pixels as usize * 3)?;
        let mut acc = self.alloc_f32(n_pixels as usize * 3)?;

        self.blur_device(img, scratch, &mut core, width, height, hp.scatter_core_px)?;
        self.blur_device(img, scratch, &mut tail, width, height, hp.scatter_tail_px)?;
        {
            let [tr, tg, tb] = hp.scatter_tail_weight;
            let mut launch = self.stream.launch_builder(&self.scatter_mix_kernel);
            launch
                .arg(&core)
                .arg(&tail)
                .arg(&n_pixels)
                .arg(&hp.scatter_amount)
                .arg(&tr)
                .arg(&tg)
                .arg(&tb)
                .arg(&mut *img);
            unsafe { launch.launch(LaunchConfig::for_num_elems(n_pixels)) }?;
        }

        let n = hp.halation_n_bounces as usize;
        if n > 0 {
            let mut decay: Vec<f32> = (0..n)
                .map(|k| hp.halation_bounce_decay.powi(k as i32))
                .collect();
            let sum: f32 = decay.iter().sum();
            if sum > 0.0 {
                for d in &mut decay {
                    *d /= sum;
                }
            }
            for (k, wk) in decay.into_iter().enumerate() {
                let sigma = hp.halation_first_sigma_px * ((k as f32) + 1.0).sqrt();
                self.blur_device(img, scratch, &mut core, width, height, sigma)?;
                self.add_scaled(&core, n_pixels, wk, k == 0, &mut acc)?;
            }
            {
                let [sr, sg, sb] = hp.halation_a_tot;
                let mut launch = self.stream.launch_builder(&self.add_scaled_pc_kernel);
                launch
                    .arg(&acc)
                    .arg(&n_pixels)
                    .arg(&sr)
                    .arg(&sg)
                    .arg(&sb)
                    .arg(&mut *img);
                unsafe { launch.launch(LaunchConfig::for_num_elems(n_pixels)) }?;
            }
            if hp.halation_renormalize {
                let inv_r = 1.0f32 / (1.0 + hp.halation_a_tot[0]);
                let inv_g = 1.0f32 / (1.0 + hp.halation_a_tot[1]);
                let inv_b = 1.0f32 / (1.0 + hp.halation_a_tot[2]);
                let mut launch = self.stream.launch_builder(&self.halation_renorm_kernel);
                launch
                    .arg(&n_pixels)
                    .arg(&inv_r)
                    .arg(&inv_g)
                    .arg(&inv_b)
                    .arg(&mut *img);
                unsafe { launch.launch(LaunchConfig::for_num_elems(n_pixels)) }?;
            }
        }
        Ok(())
    }

    fn run_grain_device(
        &self,
        density: &mut CudaSlice<f32>,
        scratch: &mut CudaSlice<f32>,
        width: u32,
        height: u32,
        gp: &crate::GrainGpuParams,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let n_pixels = width * height;
        let mono = if gp.monochrome { 1u32 } else { 0u32 };
        {
            let mut launch = self.stream.launch_builder(&self.grain_kernel);
            launch
                .arg(&n_pixels)
                .arg(&gp.base_seed)
                .arg(&gp.n_sub_layers)
                .arg(&mono)
                .arg(&gp.density_min[0])
                .arg(&gp.density_min[1])
                .arg(&gp.density_min[2])
                .arg(&gp.density_max[0])
                .arg(&gp.density_max[1])
                .arg(&gp.density_max[2])
                .arg(&gp.n_particles_per_pixel[0])
                .arg(&gp.n_particles_per_pixel[1])
                .arg(&gp.n_particles_per_pixel[2])
                .arg(&gp.grain_uniformity[0])
                .arg(&gp.grain_uniformity[1])
                .arg(&gp.grain_uniformity[2])
                .arg(&mut *density);
            unsafe { launch.launch(LaunchConfig::for_num_elems(n_pixels)) }?;
        }
        if gp.grain_blur > 0.4 {
            let mut out = self.alloc_f32(n_pixels as usize * 3)?;
            self.blur_device(density, scratch, &mut out, width, height, gp.grain_blur)?;
            std::mem::swap(density, &mut out);
        }
        Ok(())
    }

    fn run_glare_device(
        &self,
        img: &mut CudaSlice<f32>,
        scratch: &mut CudaSlice<f32>,
        width: u32,
        height: u32,
        gp: &crate::GlareGpuParams,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let n_pixels = width * height;
        let mut glare = self.alloc_f32(n_pixels as usize * 3)?;
        {
            let mut launch = self.stream.launch_builder(&self.glare_gen_kernel);
            launch
                .arg(&n_pixels)
                .arg(&gp.base_seed)
                .arg(&gp.mu)
                .arg(&gp.sigma)
                .arg(&mut glare);
            unsafe { launch.launch(LaunchConfig::for_num_elems(n_pixels)) }?;
        }
        if gp.blur_px > 0.0 {
            let mut blurred = self.alloc_f32(n_pixels as usize * 3)?;
            self.blur_device(&glare, scratch, &mut blurred, width, height, gp.blur_px)?;
            glare = blurred;
        }
        {
            let [or, og, ob] = gp.rgb_offset;
            let mut launch = self.stream.launch_builder(&self.glare_apply_kernel);
            launch
                .arg(&glare)
                .arg(&n_pixels)
                .arg(&or)
                .arg(&og)
                .arg(&ob)
                .arg(img);
            unsafe { launch.launch(LaunchConfig::for_num_elems(n_pixels)) }?;
        }
        Ok(())
    }

    fn run_unsharp_device(
        &self,
        img: &mut CudaSlice<f32>,
        scratch: &mut CudaSlice<f32>,
        width: u32,
        height: u32,
        up: &crate::UnsharpGpuParams,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let n_pixels = width * height;
        let mut original = self.alloc_f32(n_pixels as usize * 3)?;
        self.add_scaled(img, n_pixels, 1.0, true, &mut original)?;
        let mut blurred = self.alloc_f32(n_pixels as usize * 3)?;
        self.blur_device(&original, scratch, &mut blurred, width, height, up.sigma_px)?;
        {
            let mut launch = self.stream.launch_builder(&self.unsharp_kernel);
            launch
                .arg(&original)
                .arg(&blurred)
                .arg(&n_pixels)
                .arg(&up.amount)
                .arg(img);
            unsafe { launch.launch(LaunchConfig::for_num_elems(n_pixels)) }?;
        }
        Ok(())
    }

    fn run_gamut_device(
        &self,
        img: &mut CudaSlice<f32>,
        n_pixels: u32,
        gp: &crate::GamutGpuParams<'_>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let cmax_f32: Vec<f32> = if gp.cmax.is_empty() {
            vec![0.0]
        } else {
            gp.cmax.iter().map(|&v| v as f32).collect()
        };
        let cmax_dev = self.stream.clone_htod(&cmax_f32)?;
        let light = gp.lightness.unwrap_or([0.0, 1.0, 1.0]);
        let light_enable = if gp.lightness.is_some() { 1u32 } else { 0u32 };
        let mut launch = self.stream.launch_builder(&self.gamut_kernel);
        launch
            .arg(img)
            .arg(&n_pixels)
            .arg(&gp.mode)
            .arg(&gp.n_l)
            .arg(&gp.n_h)
            .arg(&gp.knee[0])
            .arg(&gp.knee[1])
            .arg(&gp.knee[2])
            .arg(&light[0])
            .arg(&light[1])
            .arg(&light[2])
            .arg(&light_enable)
            .arg(&gp.l_white)
            .arg(&gp.l_min)
            .arg(&gp.l_max)
            .arg(&cmax_dev);
        unsafe { launch.launch(LaunchConfig::for_num_elems(n_pixels)) }?;
        Ok(())
    }

    fn run_post_scan_device(
        &self,
        img: &mut CudaSlice<f32>,
        n_pixels: u32,
        output_cctf_encoding: bool,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let encode = if output_cctf_encoding { 1u32 } else { 0u32 };
        let mut launch = self.stream.launch_builder(&self.post_scan_kernel);
        launch.arg(img).arg(&n_pixels).arg(&encode);
        unsafe { launch.launch(LaunchConfig::for_num_elems(n_pixels)) }?;
        Ok(())
    }

    fn run_dir_device(
        &self,
        density: &mut CudaSlice<f32>,
        log_raw: &mut CudaSlice<f32>,
        width: u32,
        height: u32,
        dp: &crate::DirCouplersGpuParams<'_>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let n_pixels = width * height;
        let mut scratch = self.alloc_f32(n_pixels as usize * 3)?;
        let matrix: Vec<f32> = dp
            .couplers_matrix_scaled
            .iter()
            .flat_map(|r| r.iter().copied())
            .collect();
        let matrix_dev = self.stream.clone_htod(&matrix)?;
        let mut correction = self.alloc_f32(n_pixels as usize * 3)?;
        {
            let positive = if dp.is_positive { 1u32 } else { 0u32 };
            let mut launch = self.stream.launch_builder(&self.dir_matmul_kernel);
            launch
            .arg(&mut *density)
                .arg(&n_pixels)
                .arg(&positive)
                .arg(&dp.density_max[0])
                .arg(&dp.density_max[1])
                .arg(&dp.density_max[2])
                .arg(&matrix_dev)
                .arg(&mut correction);
            unsafe { launch.launch(LaunchConfig::for_num_elems(n_pixels)) }?;
        }

        let mut gaussian = self.alloc_f32(n_pixels as usize * 3)?;
        self.blur_device(
            &correction,
            &mut scratch,
            &mut gaussian,
            width,
            height,
            dp.diffusion_size_px,
        )?;
        let mut tail = self.alloc_f32(n_pixels as usize * 3)?;
        self.blur_device(
            &correction,
            &mut scratch,
            &mut tail,
            width,
            height,
            dp.diffusion_tail_px,
        )?;
        let mut mix = self.alloc_f32(n_pixels as usize * 3)?;
        let w = dp.diffusion_tail_weight;
        self.add_scaled(&gaussian, n_pixels, 1.0 - w, true, &mut mix)?;
        self.add_scaled(&tail, n_pixels, w, false, &mut mix)?;
        self.add_scaled(&mix, n_pixels, -1.0, false, log_raw)?;

        let log_exp_f32: Vec<f32> = dp.log_exposure.iter().map(|&v| v as f32).collect();
        let curves_f32 = flatten_curves_f32(dp.density_curves_0);
        let log_exp_dev = self.stream.clone_htod(&log_exp_f32)?;
        let curves_dev = self.stream.clone_htod(&curves_f32)?;
        let k = dp.log_exposure.len() as u32;
        let uniform = if is_uniform_grid(dp.log_exposure) {
            1u32
        } else {
            0u32
        };
        let gamma_inv = (1.0 / dp.gamma_factor) as f32;
        let mut launch = self.stream.launch_builder(&self.density_kernel);
        launch
            .arg(log_raw)
            .arg(&n_pixels)
            .arg(&k)
            .arg(&uniform)
            .arg(&gamma_inv)
            .arg(&log_exp_dev)
            .arg(&curves_dev)
            .arg(density);
        unsafe { launch.launch(LaunchConfig::for_num_elems(n_pixels)) }?;
        Ok(())
    }

    fn run_scan_spectral(
        &self,
        density_cmy: &ImageBuf,
        channel_density: &[[f64; 3]],
        base_density: &[f64],
        illuminant: &[f64],
        normalization: f64,
        cat: &[[f64; 3]; 3],
        xyz_to_rgb: &[[f64; 3]; 3],
    ) -> Result<Vec<f32>, Box<dyn std::error::Error + Send + Sync>> {
        let n_wl = channel_density.len();
        let n_pixels = density_cmy.pixel_count() as u32;

        let mut combined = [[0.0f64; 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                combined[i][j] = xyz_to_rgb[i][0] * cat[0][j]
                    + xyz_to_rgb[i][1] * cat[1][j]
                    + xyz_to_rgb[i][2] * cat[2][j];
            }
        }
        let matrix = matrix_f32(&combined);

        let (mut cd_flat, mut bd) = sanitize_spectral_inputs(channel_density, base_density, n_wl);
        bd.resize(n_wl, 0.0);
        cd_flat.resize(n_wl * 3, 0.0);
        let illu_f32: Vec<f32> = illuminant.iter().map(|&v| v as f32).collect();
        let input_f32 = scalars_to_f32(&density_cmy.data);

        let input_dev = self.stream.clone_htod(input_f32.as_ref())?;
        let matrix_dev = self.stream.clone_htod(&matrix)?;
        let cd_dev = self.stream.clone_htod(&cd_flat)?;
        let bd_dev = self.stream.clone_htod(&bd)?;
        let illu_dev = self.stream.clone_htod(&illu_f32)?;
        let cmf_x_dev = self.stream.clone_htod(&spektrafilm_math::spectral::CMF_X)?;
        let cmf_y_dev = self.stream.clone_htod(&spektrafilm_math::spectral::CMF_Y)?;
        let cmf_z_dev = self.stream.clone_htod(&spektrafilm_math::spectral::CMF_Z)?;
        let mut out_dev = self.alloc_f32(n_pixels as usize * 3)?;

        let n_wl_u32 = n_wl as u32;
        let normalization_f32 = normalization as f32;
        let bw_m = 1.0f32;
        let bw_q = 0.0f32;
        let bw_enable = 0u32;
        let skip_clamp = 1u32;
        let mut launch = self.stream.launch_builder(&self.scan_kernel);
        launch
            .arg(&input_dev)
            .arg(&n_pixels)
            .arg(&n_wl_u32)
            .arg(&normalization_f32)
            .arg(&matrix_dev)
            .arg(&bw_m)
            .arg(&bw_q)
            .arg(&bw_enable)
            .arg(&skip_clamp)
            .arg(&cd_dev)
            .arg(&bd_dev)
            .arg(&illu_dev)
            .arg(&cmf_x_dev)
            .arg(&cmf_y_dev)
            .arg(&cmf_z_dev)
            .arg(&mut out_dev);
        unsafe { launch.launch(LaunchConfig::for_num_elems(n_pixels)) }?;

        Ok(self.stream.clone_dtoh(&out_dev)?)
    }

    fn run_print_spectral(
        &self,
        density_cmy: &ImageBuf,
        channel_density: &[[f64; 3]],
        base_density: &[f64],
        illuminant: &[f64],
        sensitivity: &[[f64; 3]],
        normalization_factor: f64,
        preflash: [f64; 3],
    ) -> Result<Vec<f32>, Box<dyn std::error::Error + Send + Sync>> {
        let n_wl = channel_density.len();
        let n_pixels = density_cmy.pixel_count() as u32;

        let (mut cd_flat, mut bd) = sanitize_spectral_inputs(channel_density, base_density, n_wl);
        bd.resize(n_wl, 0.0);
        cd_flat.resize(n_wl * 3, 0.0);
        let illu_f32: Vec<f32> = illuminant.iter().map(|&v| v as f32).collect();
        let sens_flat: Vec<f32> = sensitivity
            .iter()
            .flat_map(|r| r.iter().map(|&v| if v.is_nan() { 0.0 } else { v as f32 }))
            .collect();
        let input_f32 = scalars_to_f32(&density_cmy.data);

        let input_dev = self.stream.clone_htod(input_f32.as_ref())?;
        let cd_dev = self.stream.clone_htod(&cd_flat)?;
        let bd_dev = self.stream.clone_htod(&bd)?;
        let illu_dev = self.stream.clone_htod(&illu_f32)?;
        let sens_dev = self.stream.clone_htod(&sens_flat)?;
        let mut out_dev = self.alloc_f32(n_pixels as usize * 3)?;

        let n_wl_u32 = n_wl as u32;
        let normalization_factor_f32 = normalization_factor as f32;
        let preflash_r = preflash[0] as f32;
        let preflash_g = preflash[1] as f32;
        let preflash_b = preflash[2] as f32;
        let mut launch = self.stream.launch_builder(&self.print_kernel);
        launch
            .arg(&input_dev)
            .arg(&n_pixels)
            .arg(&n_wl_u32)
            .arg(&normalization_factor_f32)
            .arg(&preflash_r)
            .arg(&preflash_g)
            .arg(&preflash_b)
            .arg(&cd_dev)
            .arg(&bd_dev)
            .arg(&illu_dev)
            .arg(&sens_dev)
            .arg(&mut out_dev);
        unsafe { launch.launch(LaunchConfig::for_num_elems(n_pixels)) }?;

        Ok(self.stream.clone_dtoh(&out_dev)?)
    }

    fn run_film_chain_resident(
        &self,
        p: &FilmChainParams<'_>,
    ) -> Result<Option<ImageBuf>, Box<dyn std::error::Error + Send + Sync>> {
        let image = p.image;
        let n_pixels = image.pixel_count() as u32;
        let input_f32 = scalars_to_f32(&image.data);
        let mut buf_a = self.stream.clone_htod(input_f32.as_ref())?;
        let mut buf_b = self.alloc_f32(n_pixels as usize * 3)?;

        match &p.front {
            FrontPass::Hanatos2025 {
                tc_lut,
                rgb_to_adapted_xyz,
            } => {
                let matrix = matrix_f32(rgb_to_adapted_xyz);
                let tc_lut_f32: Vec<f32> = tc_lut.data.iter().map(|&v| v as f32).collect();
                let matrix_dev = self.stream.clone_htod(&matrix)?;
                let tc_lut_dev = self.stream.clone_htod(&tc_lut_f32)?;
                let lut_size = tc_lut.size as u32;
                let mut launch = self.stream.launch_builder(&self.hanatos_kernel);
                launch
                    .arg(&buf_a)
                    .arg(&n_pixels)
                    .arg(&lut_size)
                    .arg(&matrix_dev)
                    .arg(&tc_lut_dev)
                    .arg(&mut buf_b);
                unsafe { launch.launch(LaunchConfig::for_num_elems(n_pixels)) }?;
            }
            FrontPass::Mallett2019 { matrix } => {
                let matrix = matrix_f32(matrix);
                let matrix_dev = self.stream.clone_htod(&matrix)?;
                let mut launch = self.stream.launch_builder(&self.mallett_kernel);
                launch
                    .arg(&buf_a)
                    .arg(&n_pixels)
                    .arg(&matrix_dev)
                    .arg(&mut buf_b);
                unsafe { launch.launch(LaunchConfig::for_num_elems(n_pixels)) }?;
            }
        }

        if let Some(hp) = p.highlight_boost.as_ref() {
            self.run_highlight_boost_device(&mut buf_b, n_pixels, hp)?;
        }

        if let Some(dp) = p.diffusion.as_ref() {
            self.run_diffusion_device(&mut buf_b, image.width, image.height, dp)?;
        }

        if let Some(sigma) = p.camera_lens_blur_px {
            if sigma > 0.0 {
                let mut blurred = self.alloc_f32(n_pixels as usize * 3)?;
                self.blur_device(
                    &buf_b,
                    &mut buf_a,
                    &mut blurred,
                    image.width,
                    image.height,
                    sigma,
                )?;
                buf_b = blurred;
            }
        }

        if let Some(hp) = p.halation.as_ref() {
            self.run_halation_device(&mut buf_b, &mut buf_a, image.width, image.height, hp)?;
        }

        {
            let mut launch = self.stream.launch_builder(&self.log10_kernel);
            launch.arg(&mut buf_b).arg(&n_pixels);
            unsafe { launch.launch(LaunchConfig::for_num_elems(n_pixels)) }?;
        }

        let film_log_exp_f32: Vec<f32> =
            p.film_log_exposure.iter().map(|&v| v as f32).collect();
        let film_curves_f32 = flatten_curves_f32(p.film_density_curves_normalized);
        let film_log_exp_dev = self.stream.clone_htod(&film_log_exp_f32)?;
        let film_curves_dev = self.stream.clone_htod(&film_curves_f32)?;
        let film_k = p.film_log_exposure.len() as u32;
        let film_uniform = if is_uniform_grid(p.film_log_exposure) {
            1u32
        } else {
            0u32
        };
        let film_gamma_inv = (1.0 / p.film_gamma) as f32;
        {
            let mut launch = self.stream.launch_builder(&self.density_kernel);
            launch
                .arg(&buf_b)
                .arg(&n_pixels)
                .arg(&film_k)
                .arg(&film_uniform)
                .arg(&film_gamma_inv)
                .arg(&film_log_exp_dev)
                .arg(&film_curves_dev)
                .arg(&mut buf_a);
            unsafe { launch.launch(LaunchConfig::for_num_elems(n_pixels)) }?;
        }

        if let Some(dp) = p.dir_couplers.as_ref() {
            self.run_dir_device(&mut buf_a, &mut buf_b, image.width, image.height, dp)?;
        }

        if let Some(gp) = p.grain.as_ref() {
            self.run_grain_device(&mut buf_a, &mut buf_b, image.width, image.height, gp)?;
        }

        let scan_cd_src;
        let scan_bd_src;
        if !p.scan_film {
            let (mut film_cd, mut film_bd) = sanitize_spectral_inputs(
                p.film_channel_density,
                p.film_base_density,
                p.film_channel_density.len(),
            );
            film_bd.resize(p.film_channel_density.len(), 0.0);
            film_cd.resize(p.film_channel_density.len() * 3, 0.0);
            let print_illu_f32: Vec<f32> =
                p.print_illuminant.iter().map(|&v| v as f32).collect();
            let print_sens_f32 = flatten_curves_f32(p.print_sensitivity);
            let film_cd_dev = self.stream.clone_htod(&film_cd)?;
            let film_bd_dev = self.stream.clone_htod(&film_bd)?;
            let print_illu_dev = self.stream.clone_htod(&print_illu_f32)?;
            let print_sens_dev = self.stream.clone_htod(&print_sens_f32)?;
            let print_n_wl = p.film_channel_density.len() as u32;
            let has_enlarger_diffusion = p.enlarger_diffusion.is_some();
            let print_exposure_scale = p.print_exposure_scale as f32;
            let print_norm = if has_enlarger_diffusion && print_exposure_scale != 0.0 {
                (p.print_normalization_factor / p.print_exposure_scale) as f32
            } else {
                p.print_normalization_factor as f32
            };
            let preflash_r = p.preflash[0] as f32;
            let preflash_g = p.preflash[1] as f32;
            let preflash_b = p.preflash[2] as f32;
            {
                let mut launch = self.stream.launch_builder(&self.print_kernel);
                launch
                    .arg(&buf_a)
                    .arg(&n_pixels)
                    .arg(&print_n_wl)
                    .arg(&print_norm)
                    .arg(&preflash_r)
                    .arg(&preflash_g)
                    .arg(&preflash_b)
                    .arg(&film_cd_dev)
                    .arg(&film_bd_dev)
                    .arg(&print_illu_dev)
                    .arg(&print_sens_dev)
                    .arg(&mut buf_b);
                unsafe { launch.launch(LaunchConfig::for_num_elems(n_pixels)) }?;
            }

            if let Some(dp) = p.enlarger_diffusion.as_ref() {
                self.log_to_linear_scaled_device(&mut buf_b, n_pixels, print_exposure_scale)?;
                self.run_diffusion_device(&mut buf_b, image.width, image.height, dp)?;
                self.linear_to_log10_outer_device(&mut buf_b, n_pixels)?;
            }

            let print_log_exp_f32: Vec<f32> =
                p.print_log_exposure.iter().map(|&v| v as f32).collect();
            let print_curves_f32 = flatten_curves_f32(p.print_density_curves);
            let print_log_exp_dev = self.stream.clone_htod(&print_log_exp_f32)?;
            let print_curves_dev = self.stream.clone_htod(&print_curves_f32)?;
            let print_k = p.print_log_exposure.len() as u32;
            let print_uniform = if is_uniform_grid(p.print_log_exposure) {
                1u32
            } else {
                0u32
            };
            let print_gamma_inv = (1.0 / p.print_gamma) as f32;
            {
                let mut launch = self.stream.launch_builder(&self.density_kernel);
                launch
                    .arg(&buf_b)
                    .arg(&n_pixels)
                    .arg(&print_k)
                    .arg(&print_uniform)
                    .arg(&print_gamma_inv)
                    .arg(&print_log_exp_dev)
                    .arg(&print_curves_dev)
                    .arg(&mut buf_a);
                unsafe { launch.launch(LaunchConfig::for_num_elems(n_pixels)) }?;
            }
            scan_cd_src = p.print_channel_density;
            scan_bd_src = p.print_base_density;
        } else {
            scan_cd_src = p.film_channel_density;
            scan_bd_src = p.film_base_density;
        }

        let (mut scan_cd, mut scan_bd) =
            sanitize_spectral_inputs(scan_cd_src, scan_bd_src, scan_cd_src.len());
        scan_bd.resize(scan_cd_src.len(), 0.0);
        scan_cd.resize(scan_cd_src.len() * 3, 0.0);
        let view_illu_f32: Vec<f32> = p.viewing_illuminant.iter().map(|&v| v as f32).collect();
        let scan_matrix = matrix_f32(p.scan_xyz_to_rgb);
        let scan_cd_dev = self.stream.clone_htod(&scan_cd)?;
        let scan_bd_dev = self.stream.clone_htod(&scan_bd)?;
        let view_illu_dev = self.stream.clone_htod(&view_illu_f32)?;
        let scan_matrix_dev = self.stream.clone_htod(&scan_matrix)?;
        let cmf_x_dev = self.stream.clone_htod(&spektrafilm_math::spectral::CMF_X)?;
        let cmf_y_dev = self.stream.clone_htod(&spektrafilm_math::spectral::CMF_Y)?;
        let cmf_z_dev = self.stream.clone_htod(&spektrafilm_math::spectral::CMF_Z)?;
        let scan_n_wl = scan_cd_src.len() as u32;
        let scan_norm = p.scan_normalization as f32;
        let (bw_m, bw_q, bw_enable) = match p.bw_xyz_remap {
            Some((m, q)) => (m as f32, q as f32, 1u32),
            None => (1.0f32, 0.0f32, 0u32),
        };
        let skip_clamp = 0u32;
        {
            let mut launch = self.stream.launch_builder(&self.scan_kernel);
            launch
                .arg(&buf_a)
                .arg(&n_pixels)
                .arg(&scan_n_wl)
                .arg(&scan_norm)
                .arg(&scan_matrix_dev)
                .arg(&bw_m)
                .arg(&bw_q)
                .arg(&bw_enable)
                .arg(&skip_clamp)
                .arg(&scan_cd_dev)
                .arg(&scan_bd_dev)
                .arg(&view_illu_dev)
                .arg(&cmf_x_dev)
                .arg(&cmf_y_dev)
                .arg(&cmf_z_dev)
                .arg(&mut buf_b);
            unsafe { launch.launch(LaunchConfig::for_num_elems(n_pixels)) }?;
        }

        if let Some(gp) = p.glare.as_ref() {
            self.run_glare_device(&mut buf_b, &mut buf_a, image.width, image.height, gp)?;
        }

        if let Some(gp) = p.gamut.as_ref() {
            self.run_gamut_device(&mut buf_b, n_pixels, gp)?;
        }

        if let Some(sigma) = p.scanner_lens_blur_px {
            if sigma > 0.0 {
                let mut blurred = self.alloc_f32(n_pixels as usize * 3)?;
                self.blur_device(
                    &buf_b,
                    &mut buf_a,
                    &mut blurred,
                    image.width,
                    image.height,
                    sigma,
                )?;
                buf_b = blurred;
            }
        }

        if let Some(up) = p.unsharp.as_ref() {
            self.run_unsharp_device(&mut buf_b, &mut buf_a, image.width, image.height, up)?;
        }

        self.run_post_scan_device(&mut buf_b, n_pixels, p.output_cctf_encoding)?;

        let out = self.stream.clone_dtoh(&buf_b)?;
        Ok(Some(ImageBuf::from_data(
            image.width,
            image.height,
            f32_to_scalars(out),
        )))
    }
}

impl ComputeBackend for CudaBackend {
    fn colorspace_convert(&self, img: &ImageBuf, matrix: &[[f32; 3]; 3]) -> ImageBuf {
        cpu_backend::CpuBackend.colorspace_convert(img, matrix)
    }

    fn cctf_encode_srgb(&self, img: &ImageBuf) -> ImageBuf {
        cpu_backend::CpuBackend.cctf_encode_srgb(img)
    }

    fn cctf_decode_srgb(&self, img: &ImageBuf) -> ImageBuf {
        cpu_backend::CpuBackend.cctf_decode_srgb(img)
    }

    fn gaussian_blur(&self, img: &ImageBuf, sigma: f32) -> ImageBuf {
        cpu_backend::CpuBackend.gaussian_blur(img, sigma)
    }

    fn table_lookup(&self, img: &ImageBuf, table_x: &[f32], table_y: &[[f32; 3]]) -> ImageBuf {
        cpu_backend::CpuBackend.table_lookup(img, table_x, table_y)
    }

    fn lut3d_interp(&self, img: &ImageBuf, lut: &Lut3D) -> ImageBuf {
        cpu_backend::CpuBackend.lut3d_interp(img, lut)
    }

    fn scan_spectral(
        &self,
        density_cmy: &ImageBuf,
        channel_density: &[[f64; 3]],
        base_density: &[f64],
        illuminant: &[f64],
        normalization: f64,
        cat: &[[f64; 3]; 3],
        xyz_to_rgb: &[[f64; 3]; 3],
    ) -> ImageBuf {
        match self.run_scan_spectral(
            density_cmy,
            channel_density,
            base_density,
            illuminant,
            normalization,
            cat,
            xyz_to_rgb,
        ) {
            Ok(result) => {
                ImageBuf::from_data(density_cmy.width, density_cmy.height, f32_to_scalars(result))
            }
            Err(e) => {
                tracing::warn!(error = %e, "CUDA scan_spectral failed; falling back to CPU");
                cpu_backend::scan_spectral_cpu(
                    density_cmy,
                    channel_density,
                    base_density,
                    illuminant,
                    normalization,
                    cat,
                    xyz_to_rgb,
                )
            }
        }
    }

    fn print_spectral(
        &self,
        density_cmy: &ImageBuf,
        channel_density: &[[f64; 3]],
        base_density: &[f64],
        illuminant: &[f64],
        sensitivity: &[[f64; 3]],
        normalization_factor: f64,
        preflash: [f64; 3],
    ) -> ImageBuf {
        match self.run_print_spectral(
            density_cmy,
            channel_density,
            base_density,
            illuminant,
            sensitivity,
            normalization_factor,
            preflash,
        ) {
            Ok(result) => {
                ImageBuf::from_data(density_cmy.width, density_cmy.height, f32_to_scalars(result))
            }
            Err(e) => {
                tracing::warn!(error = %e, "CUDA print_spectral failed; falling back to CPU");
                cpu_backend::print_spectral_cpu(
                    density_cmy,
                    channel_density,
                    base_density,
                    illuminant,
                    sensitivity,
                    normalization_factor,
                    preflash,
                )
            }
        }
    }

    fn try_run_film_chain(&self, params: &FilmChainParams<'_>) -> Option<ImageBuf> {
        match self.run_film_chain_resident(params) {
            Ok(out) => out,
            Err(e) => {
                tracing::warn!(error = %e, "CUDA resident film chain failed; falling back");
                None
            }
        }
    }

    fn resident_chain_applies_post_scan(&self) -> bool {
        true
    }

    fn is_gpu(&self) -> bool {
        true
    }

    fn name(&self) -> &str {
        &self.device_name
    }
}
