use rayon::prelude::*;

pub struct HistogramData {
    red: Vec<f32>,
    green: Vec<f32>,
    blue: Vec<f32>,
    luma: Vec<f32>,
}

pub enum AnalyticsPixels {
    Owned(Vec<u8>),
    Mapped(crate::render::gpu::processor::PooledReadback),
}

impl std::ops::Deref for AnalyticsPixels {
    type Target = [u8];

    fn deref(&self) -> &[u8] {
        match self {
            AnalyticsPixels::Owned(data) => data,
            AnalyticsPixels::Mapped(view) => view,
        }
    }
}

pub struct AnalyticsFrame {
    pub data: AnalyticsPixels,
    pub width: u32,
    pub height: u32,
    pub row_stride: usize,
}

impl AnalyticsFrame {
    fn row(&self, y: usize) -> &[[u8; 4]] {
        let start = y * self.row_stride;
        self.data[start..start + self.width as usize * 4]
            .as_chunks::<4>()
            .0
    }
}

pub fn calculate_histogram(frame: &AnalyticsFrame) -> Result<HistogramData, String> {
    let width = frame.width as usize;
    let empty = || [[0u32; 256]; 4];

    let counts = (0..frame.height as usize)
        .into_par_iter()
        .with_min_len(16)
        .fold(empty, |mut acc, y| {
            let first = (y * width) & 1;
            for px in frame.row(y).iter().skip(first).step_by(2) {
                let r = px[0] as usize;
                let g = px[1] as usize;
                let b = px[2] as usize;

                acc[0][r] += 1;
                acc[1][g] += 1;
                acc[2][b] += 1;

                let luma = (r * 218 + g * 732 + b * 74) >> 10;
                acc[3][luma.min(255)] += 1;
            }
            acc
        })
        .reduce(empty, |mut a, b| {
            for (a_channel, b_channel) in a.iter_mut().zip(b.iter()) {
                for (a_bin, b_bin) in a_channel.iter_mut().zip(b_channel.iter()) {
                    *a_bin += b_bin;
                }
            }
            a
        });

    let [mut red, mut green, mut blue, mut luma] =
        counts.map(|channel| channel.map(|c| c as f32).to_vec());

    let smoothing_sigma = 2.0;
    apply_gaussian_smoothing(&mut red, smoothing_sigma);
    apply_gaussian_smoothing(&mut green, smoothing_sigma);
    apply_gaussian_smoothing(&mut blue, smoothing_sigma);
    apply_gaussian_smoothing(&mut luma, smoothing_sigma);

    normalize_histogram_range(&mut red, 0.99);
    normalize_histogram_range(&mut green, 0.99);
    normalize_histogram_range(&mut blue, 0.99);
    normalize_histogram_range(&mut luma, 0.99);

    Ok(HistogramData {
        red,
        green,
        blue,
        luma,
    })
}

fn apply_gaussian_smoothing(histogram: &mut [f32], sigma: f32) {
    if sigma <= 0.0 {
        return;
    }

    let kernel_radius = (sigma * 3.0).ceil() as usize;
    if kernel_radius == 0 || kernel_radius >= histogram.len() {
        return;
    }

    let kernel_size = 2 * kernel_radius + 1;
    let mut kernel = vec![0.0; kernel_size];
    let mut kernel_sum = 0.0;

    let two_sigma_sq = 2.0 * sigma * sigma;
    for (i, kernel_val) in kernel.iter_mut().enumerate() {
        let x = (i as i32 - kernel_radius as i32) as f32;
        let val = (-x * x / two_sigma_sq).exp();
        *kernel_val = val;
        kernel_sum += val;
    }

    if kernel_sum > 0.0 {
        for val in &mut kernel {
            *val /= kernel_sum;
        }
    }

    let original = histogram.to_owned();
    let len = histogram.len();

    for (i, hist_val) in histogram.iter_mut().enumerate() {
        let mut smoothed_val = 0.0;
        for (k, &kernel_val) in kernel.iter().enumerate() {
            let offset = k as i32 - kernel_radius as i32;
            let sample_index = i as i32 + offset;
            let clamped_index = sample_index.clamp(0, len as i32 - 1) as usize;
            smoothed_val += original[clamped_index] * kernel_val;
        }
        *hist_val = smoothed_val;
    }
}

fn normalize_histogram_range(histogram: &mut [f32], percentile_clip: f32) {
    if histogram.is_empty() {
        return;
    }

    let mut sorted_data = histogram.to_owned();
    sorted_data.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let clip_index = ((sorted_data.len() - 1) as f32 * percentile_clip).round() as usize;
    let max_val = sorted_data[clip_index.min(sorted_data.len() - 1)];

    if max_val > 1e-6 {
        let scale_factor = 1.0 / max_val;
        for value in histogram.iter_mut() {
            *value = (*value * scale_factor).min(1.0);
        }
    } else {
        for value in histogram.iter_mut() {
            *value = 0.0;
        }
    }
}

pub struct WaveformData {
    pub rgb: Vec<u8>,
    pub luma: Vec<u8>,
    pub parade: Vec<u8>,
    pub vectorscope: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

pub fn encode_analytics_packet(
    path: &str,
    histogram: Option<&HistogramData>,
    waveform: Option<&WaveformData>,
) -> Vec<u8> {
    let put_u32 = |out: &mut Vec<u8>, v: usize| out.extend_from_slice(&(v as u32).to_le_bytes());
    let wave_len = waveform.map_or(0, |w| {
        w.rgb.len() + w.luma.len() + w.parade.len() + w.vectorscope.len()
    });
    let mut out = Vec::with_capacity(path.len() + 4 * 256 * 4 + wave_len + 40);

    put_u32(&mut out, path.len());
    out.extend_from_slice(path.as_bytes());

    match histogram {
        Some(h) => {
            put_u32(&mut out, h.red.len());
            for channel in [&h.red, &h.green, &h.blue, &h.luma] {
                for v in channel.iter() {
                    out.extend_from_slice(&v.to_le_bytes());
                }
            }
        }
        None => put_u32(&mut out, 0),
    }

    match waveform {
        Some(w) => {
            put_u32(&mut out, w.width as usize);
            put_u32(&mut out, w.height as usize);
            for plane in [&w.rgb, &w.luma, &w.parade, &w.vectorscope] {
                put_u32(&mut out, plane.len());
                out.extend_from_slice(plane);
            }
        }
        None => {
            put_u32(&mut out, 0);
            put_u32(&mut out, 0);
        }
    }

    out
}

const WAVEFORM_W: usize = 256;

const WAVEFORM_H: usize = 256;

const WAVEFORM_MAX_BANDS: usize = 16;

struct WaveformBins {
    red: Vec<u32>,
    green: Vec<u32>,
    blue: Vec<u32>,
    luma: Vec<u32>,
    parade: Vec<u32>,
    vector: Vec<u32>,
}

impl WaveformBins {
    fn new(do_rgb: bool, do_luma: bool, do_parade: bool, do_vectorscope: bool) -> Self {
        let bins = |enabled: bool| {
            if enabled {
                vec![0u32; WAVEFORM_W * WAVEFORM_H]
            } else {
                vec![]
            }
        };
        Self {
            red: bins(do_rgb),
            green: bins(do_rgb),
            blue: bins(do_rgb),
            luma: bins(do_luma),
            parade: bins(do_parade),
            vector: bins(do_vectorscope),
        }
    }

    fn merge(mut self, other: Self) -> Self {
        for (a, b) in [
            (&mut self.red, &other.red),
            (&mut self.green, &other.green),
            (&mut self.blue, &other.blue),
            (&mut self.luma, &other.luma),
            (&mut self.parade, &other.parade),
            (&mut self.vector, &other.vector),
        ] {
            for (a_bin, b_bin) in a.iter_mut().zip(b.iter()) {
                *a_bin += b_bin;
            }
        }
        self
    }
}

pub fn calculate_waveform(
    frame: &AnalyticsFrame,
    active_channel: Option<&str>,
) -> Result<WaveformData, String> {
    const W: usize = WAVEFORM_W;
    const H: usize = WAVEFORM_H;

    let (orig_w, orig_h) = (frame.width, frame.height);
    if orig_w == 0 || orig_h == 0 {
        return Err("Image has zero dimensions.".to_string());
    }

    let do_rgb = active_channel.is_none() || active_channel == Some("rgb");
    let do_luma =
        active_channel.is_none() || active_channel == Some("luma") || active_channel == Some("rgb");
    let do_parade = active_channel.is_none() || active_channel == Some("parade");
    let do_vectorscope = active_channel.is_none() || active_channel == Some("vectorscope");

    let x_scale = W as f32 / orig_w as f32;
    let mut x_buckets = vec![0usize; orig_w as usize];

    let mut x_buckets_parade_r = vec![0usize; orig_w as usize];
    let mut x_buckets_parade_g = vec![0usize; orig_w as usize];
    let mut x_buckets_parade_b = vec![0usize; orig_w as usize];

    for x in 0..(orig_w as usize) {
        x_buckets[x] = ((x as f32 * x_scale) as usize).min(W - 1);
        if do_parade {
            let relative_x = x as f32 / orig_w as f32;
            x_buckets_parade_r[x] = (relative_x * 82.0) as usize % 82;
            x_buckets_parade_g[x] = 87 + (relative_x * 82.0) as usize % 82;
            x_buckets_parade_b[x] = 174 + (relative_x * 82.0) as usize % 82;
        }
    }

    let process_pixel =
        |bins: &mut WaveformBins, r: u8, g: u8, b: u8, out_x: usize, orig_x: usize| {
            if do_rgb {
                bins.red[(255 - r as usize) * W + out_x] += 1;
                bins.green[(255 - g as usize) * W + out_x] += 1;
                bins.blue[(255 - b as usize) * W + out_x] += 1;
            }
            if do_luma {
                let l = ((r as u32 * 218 + g as u32 * 732 + b as u32 * 74) >> 10).min(255) as usize;
                bins.luma[(255 - l) * W + out_x] += 1;
            }
            if do_parade {
                bins.parade[(255 - r as usize) * W + x_buckets_parade_r[orig_x]] += 1;
                bins.parade[(255 - g as usize) * W + x_buckets_parade_g[orig_x]] += 1;
                bins.parade[(255 - b as usize) * W + x_buckets_parade_b[orig_x]] += 1;
            }
            if do_vectorscope {
                let r_f = r as f32;
                let g_f = g as f32;
                let b_f = b as f32;

                let mut cb = (-0.1146 * r_f - 0.3854 * g_f + 0.5 * b_f) * 0.836;
                let mut cr = (0.5 * r_f - 0.4542 * g_f - 0.0458 * b_f) * 0.836;

                let dist_sq = cb * cb + cr * cr;
                if dist_sq > 16129.0 {
                    let scale = 127.0 / dist_sq.sqrt();
                    cb *= scale;
                    cr *= scale;
                }

                let vx = (cb + 128.0).clamp(0.0, 255.0) as usize;
                let vy = (128.0 - cr).clamp(0.0, 255.0) as usize;
                bins.vector[vy * W + vx] += 1;
            }
        };

    let height = orig_h as usize;
    let bands = rayon::current_num_threads()
        .clamp(1, WAVEFORM_MAX_BANDS)
        .min(height);
    let rows_per_band = height.div_ceil(bands);
    let bins = (0..bands)
        .into_par_iter()
        .map(|band| {
            let mut bins = WaveformBins::new(do_rgb, do_luma, do_parade, do_vectorscope);
            for y in band * rows_per_band..((band + 1) * rows_per_band).min(height) {
                for (x, px) in frame.row(y).iter().enumerate() {
                    process_pixel(&mut bins, px[0], px[1], px[2], x_buckets[x], x);
                }
            }
            bins
        })
        .reduce_with(WaveformBins::merge)
        .unwrap_or_else(|| WaveformBins::new(do_rgb, do_luma, do_parade, do_vectorscope));
    let WaveformBins {
        red: red_bins,
        green: green_bins,
        blue: blue_bins,
        luma: luma_bins,
        parade: parade_bins,
        vector: vector_bins,
    } = bins;
    let build_lut = |bins: &[u32], do_calc: bool| {
        let max_val = if do_calc {
            bins.iter().copied().max().unwrap_or(0)
        } else {
            0
        };
        let scale = 255.0 / (1.0 + max_val as f32).ln();
        let log_value = move |v: u32| {
            if v == 0 {
                0
            } else {
                ((1.0 + v as f32).ln() * scale) as u8
            }
        };
        let lut: Vec<u8> = (0..=max_val.min(1023)).map(log_value).collect();
        move |v: u32| lut.get(v as usize).copied().unwrap_or_else(|| log_value(v))
    };

    let lut_r = build_lut(&red_bins, do_rgb);
    let lut_g = build_lut(&green_bins, do_rgb);
    let lut_b = build_lut(&blue_bins, do_rgb);
    let lut_l = build_lut(&luma_bins, do_luma);
    let lut_p = build_lut(&parade_bins, do_parade);
    let lut_v = build_lut(&vector_bins, do_vectorscope);

    let pixel_count = W * H;
    let byte_count = pixel_count * 4;

    let mut rgba_rgb = if do_rgb {
        vec![0u8; byte_count]
    } else {
        vec![]
    };
    let mut rgba_luma = if do_luma {
        vec![0u8; byte_count]
    } else {
        vec![]
    };
    let mut rgba_parade = if do_parade {
        vec![0u8; byte_count]
    } else {
        vec![]
    };
    let mut rgba_vector = if do_vectorscope {
        vec![0u8; byte_count]
    } else {
        vec![]
    };

    for i in 0..pixel_count {
        let x = i % W;
        let y = i / W;
        let off = i * 4;

        if do_rgb {
            let r = lut_r(red_bins[i]);
            let g = lut_g(green_bins[i]);
            let b = lut_b(blue_bins[i]);
            if r > 0 || g > 0 || b > 0 {
                rgba_rgb[off] = r;
                rgba_rgb[off + 1] = g;
                rgba_rgb[off + 2] = b;
                rgba_rgb[off + 3] = r.max(g).max(b);
            }
        }

        if do_luma && luma_bins[i] > 0 {
            let l = lut_l(luma_bins[i]);
            rgba_luma[off] = 255;
            rgba_luma[off + 1] = 255;
            rgba_luma[off + 2] = 255;
            rgba_luma[off + 3] = l;
        }

        if do_parade && parade_bins[i] > 0 {
            let bright = lut_p(parade_bins[i]);
            if x < 82 {
                rgba_parade[off] = 255;
                rgba_parade[off + 3] = bright;
            } else if (87..169).contains(&x) {
                rgba_parade[off + 1] = 255;
                rgba_parade[off + 3] = bright;
            } else if x >= 174 {
                rgba_parade[off + 2] = 255;
                rgba_parade[off + 3] = bright;
            }
        }

        if do_vectorscope {
            let val = vector_bins[i];

            let dx = x as f32 - 128.0;
            let dy = 128.0 - y as f32;
            let min_d = dx.abs().min(dy.abs());
            let dist = (dx * dx + dy * dy).sqrt();

            if val > 0 {
                let bright = lut_v(val);

                let y_mid = 128.0;
                rgba_vector[off] = (y_mid + 1.402 * (dy / 0.836)).clamp(0.0, 255.0) as u8;
                rgba_vector[off + 1] = (y_mid - 0.344136 * (dx / 0.836) - 0.714136 * (dy / 0.836))
                    .clamp(0.0, 255.0) as u8;
                rgba_vector[off + 2] = (y_mid + 1.772 * (dx / 0.836)).clamp(0.0, 255.0) as u8;
                rgba_vector[off + 3] = bright;
            } else if min_d <= 1.0 {
                let alpha = (40.0 - min_d * 30.0).clamp(0.0, 255.0) as u8;
                rgba_vector[off] = 255;
                rgba_vector[off + 1] = 255;
                rgba_vector[off + 2] = 255;
                rgba_vector[off + 3] = alpha;
            } else if (dist - 127.0).abs() < 0.8 || (dist - 64.0).abs() < 0.8 {
                rgba_vector[off] = 255;
                rgba_vector[off + 1] = 255;
                rgba_vector[off + 2] = 255;
                rgba_vector[off + 3] = 15;
            } else if dx < 0.0 && dy > 0.0 && (dy + 1.53 * dx).abs() < 1.0 {
                rgba_vector[off] = 255;
                rgba_vector[off + 1] = 200;
                rgba_vector[off + 2] = 150;
                rgba_vector[off + 3] = 120;
            }
        }
    }

    Ok(WaveformData {
        rgb: rgba_rgb,
        luma: rgba_luma,
        parade: rgba_parade,
        vectorscope: rgba_vector,
        width: W as u32,
        height: H as u32,
    })
}
